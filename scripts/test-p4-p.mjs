#!/usr/bin/env node
/**
 * P4-P — permanent suggestion-client regression runner.
 *
 *   node scripts/test-p4-p.mjs
 *
 * The public entry point has no arguments. It supervises two direct workers,
 * binds both to the committed edit.js/edit.css, and keeps its invented DOM,
 * HTTP, browser, and package-install state below guarded mode-0700 roots.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const SELF = fileURLToPath(import.meta.url);
const EDIT_JS = join(ROOT, "templates", "base", "edit.js");
const EDIT_CSS = join(ROOT, "templates", "base", "edit.css");
const COMMENTS_JS = join(ROOT, "templates", "base", "comments.js");
const COMMENTS_CSS = join(ROOT, "templates", "base", "comments.css");

const PLAYWRIGHT = "playwright@1.55.0";
const WORKER_DEADLINE_MS = 180_000;
const INSTALL_DEADLINE_MS = 900_000;
const PROBE_DEADLINE_MS = 20_000;
const HANG_DEADLINE_MS = 2_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 65_536;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

const DOC_ID = "4b7d2a";
const AID = "a31b7c9d2";
const OTHER_AID = "a44f0e1b7";
const BASE_TEXT = "The cache key covers every declared input.";
const BASE_HASH = createHash("sha256").update(BASE_TEXT, "utf8").digest("hex");
const NEXT_TEXT = "The cache key covers **every** declared input.";
const ACCEPTED_TEXT = "The cache key covers each declared input.";
const ACCEPTED_HASH = createHash("sha256").update(ACCEPTED_TEXT, "utf8").digest("hex");
const OLD_PENDING_TEXT = "An old pending overlay.";
const NEW_PENDING_TEXT = "A fresh pending overlay.";
const SUB = "u_fixture_reader_31";

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`FAIL unhandled rejection: ${reason && reason.stack ? reason.stack : String(reason)}\n`);
  process.exitCode = 1;
});

function guardedRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(root, 0o700);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  return root;
}

function signalNumber(signal) {
  return SIGNALS[signal] ?? (signal === "SIGKILL" ? 9 : 0);
}

function groupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

function childEnv(overrides) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(?:auth|cookie|credential|key|password|secret|token)|^(?:aws|github|netlify)_/i.test(name)) {
      env[name] = value;
    }
  }
  return { ...env, ...overrides };
}

function runChild(args, { deadline, cwd = ROOT, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], {
      cwd,
      env: childEnv(env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outBytes = 0;
    let errBytes = 0;
    const keep = (target, used, chunk) => {
      const remaining = Math.max(0, OUTPUT_LIMIT - used);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      return used + chunk.byteLength;
    };
    child.stdout.on("data", (chunk) => { outBytes = keep(stdout, outBytes, chunk); });
    child.stderr.on("data", (chunk) => { errBytes = keep(stderr, errBytes, chunk); });

    let timedOut = false;
    let killer = null;
    let giveUp = null;
    let settled = false;
    const send = (signal) => {
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      send("SIGTERM");
      killer = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
      giveUp = setTimeout(() => {
        if (settled) return;
        settled = true;
        for (const [name, handler] of forwarded) process.off(name, handler);
        resolve({
          pid: child.pid,
          code: 125,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: `${Buffer.concat(stderr).toString("utf8")}child outlived TERM and KILL\n`,
          truncated: outBytes > OUTPUT_LIMIT || errBytes > OUTPUT_LIMIT,
        });
      }, KILL_GRACE_MS * 2);
    }, deadline);
    const forwarded = Object.keys(SIGNALS).map((signal) => {
      const handler = () => send(signal);
      process.on(signal, handler);
      return [signal, handler];
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killer !== null) clearTimeout(killer);
      if (giveUp !== null) clearTimeout(giveUp);
      for (const [name, handler] of forwarded) process.off(name, handler);
      resolve({
        pid: child.pid,
        code: timedOut ? 124 : (code ?? 128 + signalNumber(signal)),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: outBytes > OUTPUT_LIMIT || errBytes > OUTPUT_LIMIT,
      });
    });
  });
}

async function waitReady(root) {
  const marker = join(root, "ready");
  const until = Date.now() + PROBE_DEADLINE_MS;
  while (Date.now() < until) {
    if (existsSync(marker)) {
      const raw = readFileSync(marker, "utf8").trim();
      if (/^[1-9][0-9]*$/.test(raw)) return Number(raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("probe did not become ready");
}

function requireSuccess(label, result) {
  if (result.code === 0 && result.stdout === "" && result.stderr === "" &&
      !result.truncated && groupGone(result.pid)) return;
  throw new Error(`${label} failed (${result.code})\n${result.stdout}${result.stderr}`);
}

async function proveSupervision(root) {
  for (const [signal, number] of Object.entries(SIGNALS)) {
    const probe = join(root, `probe-${signal.toLowerCase()}`);
    const resultPromise = runChild(["--probe-signal"], {
      deadline: WORKER_DEADLINE_MS,
      cwd: probe,
    });
    const pid = await waitReady(probe);
    process.kill(-pid, signal);
    const result = await resultPromise;
    assert.equal(result.code, 128 + number, signal);
    assert.equal(groupGone(result.pid), true, `${signal} group reaped`);
  }
  const hang = join(root, "probe-hang");
  const result = await runChild(["--probe-hang"], { deadline: HANG_DEADLINE_MS, cwd: hang });
  assert.equal(result.code, 124);
  assert.equal(groupGone(result.pid), true, "deadline group reaped");

  const forward = join(root, "probe-forward");
  const forwarded = await runChild(["--probe-forward"], { deadline: PROBE_DEADLINE_MS, cwd: forward });
  assert.equal(forwarded.code, 0);
  assert.equal(forwarded.stdout, "forwarded:143\n");
  assert.equal(forwarded.stderr, "");
  assert.equal(groupGone(forwarded.pid), true, "forwarding group reaped");
}

function probeSignal() {
  for (const [signal, number] of Object.entries(SIGNALS)) {
    process.on(signal, () => process.exit(128 + number));
  }
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`, { mode: 0o600 });
  setInterval(() => {}, 1_000);
}

function probeHang() {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

async function probeForward() {
  const resultPromise = runChild(["--probe-signal"], {
    deadline: PROBE_DEADLINE_MS,
    cwd: process.cwd(),
  });
  await waitReady(process.cwd());
  process.kill(process.pid, "SIGTERM");
  const result = await resultPromise;
  process.stdout.write(`forwarded:${result.code}\n`);
}

async function installPlaywright(root) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "p4p-fixture", private: true, version: "0.0.0", type: "module",
  })}\n`, { mode: 0o600 });
  const npm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const installed = await runChild(["--run-node", npm, "install", "--no-save", "--no-audit", "--no-fund", "--silent", PLAYWRIGHT], {
    deadline: INSTALL_DEADLINE_MS, cwd: root,
    env: {
      HOME: root,
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_ignore_scripts: "true",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      npm_config_yes: "true",
    },
  });
  requireSuccess("Playwright package install", installed);
  const cli = join(root, "node_modules", "playwright", "cli.js");
  const browser = await runChild(["--run-node", cli, "install", "chromium"], {
    deadline: INSTALL_DEADLINE_MS, cwd: root,
    env: {
      HOME: root,
      npm_config_userconfig: join(root, "npmrc"),
      PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"),
    },
  });
  requireSuccess("Chromium install", browser);
}

function runNode() {
  const [entry, ...args] = process.argv.slice(3);
  const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd(), stdio: "ignore" });
  child.once("error", () => process.exit(125));
  child.once("close", (code, signal) => process.exit(code ?? 128 + signalNumber(signal)));
}

const actor = Object.freeze({ sub: SUB, name: "Invented Reader", email: "reader@example.invalid" });

function commentThread() {
  return {
    v: 1,
    id: "t_m8x2k1_4f7a9c31",
    docId: DOC_ID,
    kind: "comment",
    status: "open",
    section: "architecture",
    anchor: { block: AID, exact: BASE_TEXT, prefix: "", suffix: "", start: 0 },
    title: null,
    docVersion: "7aaca51",
    createdAt: "2026-09-03T16:18:25.123Z",
    author: { ...actor },
    resolvedAt: null,
    resolvedBy: null,
    comments: [{
      id: "c_m8x2k1_4f7a9c31",
      body: "Could we name the invalidation case?",
      author: { ...actor },
      createdAt: "2026-09-03T16:18:25.123Z",
      editedAt: null,
    }],
  };
}

function suggestion(id, text = NEXT_TEXT, overrides = {}) {
  return {
    v: 1,
    id,
    docId: DOC_ID,
    aid: AID,
    section: "architecture",
    text,
    note: "Invented review note.",
    by: { ...actor },
    at: "2026-09-03T16:19:25.123Z",
    baseHash: BASE_HASH,
    baseText: BASE_TEXT,
    docVersion: "7aaca51",
    state: "open",
    ...overrides,
  };
}

function suggestions(count) {
  return Array.from({ length: count }, (_, index) => suggestion(
    `s_${index.toString(36).padStart(4, "0")}_deadbeef`,
  ));
}

function session(overrides = {}) {
  return {
    sub: SUB,
    email: actor.email,
    name: actor.name,
    canComment: true,
    canEdit: true,
    doc: DOC_ID,
    role: "editor",
    shared: true,
    canSuggest: true,
    canAccept: true,
    canShare: false,
    canSeeMembers: false,
    ...overrides,
  };
}

function fixtureHtml(tag = "p") {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="doc-id" content="${DOC_ID}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/comments.css"><link rel="stylesheet" href="/edit.css">
<title>Invented suggestion fixture</title></head><body>
<div class="head-top"><h1>Invented suggestion fixture</h1></div>
<script type="application/json" id="doc-history" data-head="7aaca51">{}</script>
<main><section id="architecture"><p class="sec-label">Architecture</p>
<${tag} data-editable data-aid="${AID}" data-md="${BASE_TEXT}">${BASE_TEXT}</${tag}>
<p data-editable data-aid="${OTHER_AID}">An unrelated invented block.</p>
</section></main>
<script src="/edit.js"></script><script src="/comments.js"></script></body></html>`;
}

function initScript() {
  return `(() => {
    const published = [];
    const anchor = Object.freeze({
      BLOCK: Object.freeze(["p", "li", "blockquote", "h2", "h3", "pre", "td", "th", "dd", "dt", "figcaption"]),
      norm(value) { return typeof value === "string" ? value.replace(/\\s+/g, " ").trim() : ""; },
      scanBlocks() { return []; }
    });
    window.__published = published;
    window.__editStates = [];
    window.__overlays = [];
    document.addEventListener("doc:edit-state", event => window.__editStates.push(event.detail.aid));
    document.addEventListener("doc:overlay", event => window.__overlays.push([...event.detail.aids]));
    window.doc = {
      anchor, edit: null, comments: null, rail: null, panel: null,
      realtime: Object.freeze({ publish: Object.freeze(event => { published.push(structuredClone(event)); return Promise.resolve(true); }) }),
      presence: null, share: null
    };
  })();`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  response.end(text);
}

function serve() {
  const state = {
    suggestions: [], threads: [], requests: [], pending: {}, malformed: false, suggestionReads: 0,
    actionGate: null, actionMode: "normal", createMode: "normal",
    pendingGate: null, pendingReads: 0, suggestionReadMode: "normal", suggestionGate: null,
  };
  const assets = new Map([
    ["/edit.js", [readFileSync(EDIT_JS), "text/javascript; charset=utf-8"]],
    ["/comments.js", [readFileSync(COMMENTS_JS), "text/javascript; charset=utf-8"]],
    ["/edit.css", [readFileSync(EDIT_CSS), "text/css; charset=utf-8"]],
    ["/comments.css", [readFileSync(COMMENTS_CSS), "text/css; charset=utf-8"]],
  ]);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/invalid-tag") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(fixtureHtml(url.pathname === "/invalid-tag" ? "div" : "p"));
      return;
    }
    if (assets.has(url.pathname)) {
      const [body, type] = assets.get(url.pathname);
      response.writeHead(200, { "Content-Type": type });
      response.end(body);
      return;
    }
    if (url.pathname === "/api/pending" && request.method === "GET") {
      state.pendingReads += 1;
      const pending = structuredClone(state.pending);
      const gate = state.pendingGate;
      if (gate !== null) await gate;
      json(response, 200, pending);
      return;
    }
    if (url.pathname === "/api/threads" && request.method === "GET") {
      json(response, 200, { threads: structuredClone(state.threads), nextCursor: null });
      return;
    }
    if (url.pathname === "/api/suggestions" && request.method === "GET") {
      state.suggestionReads += 1;
      const gate = state.suggestionGate;
      const model = structuredClone(state.suggestions);
      if (gate !== null) await gate;
      if (state.suggestionReadMode === "terminal-401") {
        json(response, 401, { error: { code: "unauthenticated", message: "Authentication required" } });
      } else if (state.suggestionReadMode === "terminal-403") {
        json(response, 403, { error: { code: "forbidden", message: "Suggestion access denied" } });
      } else if (state.suggestionReadMode === "oversized") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.write("[");
        for (let index = 0; index < 65; index += 1) response.write(" ".repeat(1024 * 1024));
        response.end("]");
      } else if (state.malformed) {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end("{");
      } else json(response, 200, model);
      return;
    }
    const raw = await readBody(request);
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    state.requests.push({ method: request.method, path: url.pathname, body });
    if (url.pathname === "/api/suggestions" && request.method === "POST") {
      if (state.createMode === "malformed-conflict") {
        json(response, 409, {
          error: { code: "conflict", message: "The block changed since this document was built" },
          current: { hash: "not-a-hash", text: null },
        });
        return;
      }
      const made = suggestion("s_m8x2k2_4f7a9c32", body.text, {
        note: body.note, baseHash: body.baseHash, baseText: body.baseText,
        at: "2026-09-03T16:20:25.123Z",
      });
      state.suggestions.push(made);
      const { state: ignored, ...stored } = made;
      json(response, 201, stored);
      return;
    }
    if (url.pathname === "/api/suggestion" && request.method === "POST") {
      if (state.actionGate !== null) await state.actionGate;
      if (state.actionMode === "malformed-conflict") {
        json(response, 409, {
          error: { code: "conflict", message: "The block changed since this document was built" },
          current: { hash: "not-a-hash", text: null },
        });
        return;
      }
      if (state.actionMode === "conflict-null") {
        json(response, 409, {
          error: { code: "conflict", message: "The block changed since this document was built" },
          current: { hash: BASE_HASH, text: null },
        });
        return;
      }
      if (state.actionMode === "conflict-text") {
        json(response, 409, {
          error: { code: "conflict", message: "The block changed since this document was built" },
          current: { hash: ACCEPTED_HASH, text: ACCEPTED_TEXT },
        });
        return;
      }
      if (state.actionMode === "404") { json(response, 404, {}); return; }
      if (state.actionMode === "401") {
        json(response, 401, { error: { code: "unauthenticated", message: "Authentication required" } });
        return;
      }
      if (state.actionMode === "403") {
        json(response, 403, { error: { code: "forbidden", message: "Suggestion access denied" } });
        return;
      }
      if (state.actionMode === "500") { json(response, 500, {}); return; }
      if (body.action === "accept") {
        const found = state.suggestions.find((entry) => entry.id === body.sugId);
        state.suggestions = state.suggestions.filter((entry) => entry.id !== body.sugId);
        json(response, 200, {
          receipt: {
            v: 1, aid: found.aid, text: found.text, by: found.by,
            at: "2026-09-03T17:08:03.884Z", baseHash: found.baseHash, pr: null,
            via: "suggestion", sugId: found.id, acceptedBy: { ...actor },
            acceptedAt: "2026-09-03T17:08:03.884Z",
          },
          pr: null,
        });
      } else {
        state.suggestions = state.suggestions.filter((entry) => entry.id !== body.sugId);
        json(response, 200, { ok: true });
      }
      return;
    }
    if (url.pathname === "/api/edit" && request.method === "POST") {
      json(response, 200, {
        receipt: { aid: body.aid, text: body.text, by: { ...actor },
          at: "2026-09-03T17:08:03.884Z", pr: null, via: "edit" },
      });
      return;
    }
    response.writeHead(404); response.end();
  });
  return { server, state };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function loadChromium() {
  const root = process.env.P4P_PLAYWRIGHT_ROOT;
  assert.ok(root && existsSync(root));
  const imported = await import(pathToFileURL(join(root, "node_modules", "playwright", "index.js")));
  return (imported.chromium === undefined ? imported.default : imported).chromium;
}

async function withBrowser(run) {
  const chromium = await loadChromium();
  const browser = await chromium.launch({ headless: true });
  try { await run(browser); } finally { await browser.close(); }
}

async function openFixture(browser, host, currentSession, model, configure = null) {
  host.state.suggestions = model;
  host.state.threads = [];
  host.state.requests = [];
  host.state.pending = {};
  host.state.malformed = false;
  host.state.suggestionReads = 0;
  host.state.actionGate = null;
  host.state.actionMode = "normal";
  host.state.createMode = "normal";
  host.state.pendingGate = null;
  host.state.pendingReads = 0;
  host.state.suggestionReadMode = "normal";
  host.state.suggestionGate = null;
  if (configure !== null) configure(host.state);
  const context = await browser.newContext();
  await context.addInitScript({ content: initScript() });
  const page = await context.newPage();
  await page.goto(host.base, { waitUntil: "load" });
  await revealSession(page, currentSession);
  return { context, page };
}

async function revealSession(page, detail) {
  await page.evaluate((value) => {
    const frozen = Object.freeze({ ...value });
    document.dispatchEvent(new CustomEvent("session", { detail: frozen }));
  }, detail);
}

async function waitReadyUi(page) {
  await page.locator(".doc-suggest-button").first().waitFor();
  await page.waitForFunction(() => document.querySelector("[data-suggest]") !== null);
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runtimeMatrix() {
  const host = serve();
  host.base = await listen(host.server);
  try {
    await withBrowser(async (browser) => {
      const first = suggestion("s_m8x2k1_4f7a9c31");
      const { context, page } = await openFixture(browser, host, session(), [first], (state) => {
        state.threads = [commentThread()];
      });
      try {
        await waitReadyUi(page);
        assert.equal(await page.locator(`.doc-edit-controls`).count(), 2);
        const controls = page.locator(`.doc-edit-controls`).first();
        assert.deepEqual(await controls.locator("button").allTextContents(), ["Suggest", "Edit"]);
        assert.equal(await page.locator(`[data-aid="${AID}"]`).getAttribute("data-suggest"), "1");
        assert.equal(await page.locator(".doc-suggest-chip").first().textContent(), "1 suggestion");
        assert.deepEqual(await page.evaluate(() => ({
          edit: Object.keys(window.doc.edit),
          rail: Object.keys(window.doc.rail),
          panel: Object.keys(window.doc.panel),
          frozen: Object.isFrozen(window.doc.edit) && Object.isFrozen(window.doc.rail) &&
            Object.isFrozen(window.doc.panel),
        })), {
          edit: ["overlaysReady"], rail: ["add", "remove", "place"],
          panel: ["register", "refresh", "open"], frozen: true,
        });

        await page.locator("#doc-comments-toggle").click();
        await page.getByText("Could we name the invalidation case?", { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => {
          const group = document.querySelector("#doc-comments-list .doc-comments-group");
          const extension = document.querySelector("#doc-comments-list .doc-panel-extension");
          return group !== null && extension !== null &&
            (group.compareDocumentPosition(extension) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        }), true, "real comment content precedes the suggestion extension");
        await page.locator("#doc-comments-close").click();

        const reads = host.state.suggestionReads;
        host.state.malformed = true;
        await page.evaluate(([aid, hash]) => {
          document.dispatchEvent(new CustomEvent("doc:event", {
            detail: Object.freeze({ source: "server", t: "edit.saved", aid, hash }),
          }));
        }, [AID, BASE_HASH]);
        await waitUntil(() => host.state.suggestionReads > reads, "edit.saved reconciliation");
        assert.ok(host.state.suggestionReads > reads, "edit.saved starts a suggestion reconciliation");
        assert.equal(await page.locator(".doc-suggest-chip").first().textContent(), "1 suggestion");
        host.state.malformed = false;

        const ignoredReads = host.state.suggestionReads;
        await page.evaluate(([aid, hash]) => {
          for (const detail of [
            Object.freeze({ source: "client", t: "edit.saved", aid, hash }),
            Object.freeze({ t: "edit.saved", source: "server", aid, hash }),
            Object.freeze({ source: "server", t: "thread.changed", aid, hash }),
          ]) document.dispatchEvent(new CustomEvent("doc:event", { detail }));
        }, [AID, BASE_HASH]);
        await page.waitForTimeout(50);
        assert.equal(host.state.suggestionReads, ignoredReads);

        await controls.getByRole("button", { name: "Suggest", exact: true }).click();
        await page.locator(".doc-suggest-draft").waitFor();
        assert.deepEqual(await page.evaluate(() => ({ published: window.__published, states: window.__editStates })), {
          published: [], states: [],
        });
        const draft = page.locator(".doc-suggest-draft");
        const text = draft.locator("textarea").first();
        assert.equal(await text.inputValue(), BASE_TEXT);
        await text.fill(NEXT_TEXT);
        await text.press("Control+Enter");
        await page.waitForFunction(() => document.querySelectorAll(".doc-suggest-card").length >= 2);
        const create = host.state.requests.find((entry) => entry.path === "/api/suggestions");
        assert.deepEqual(Object.keys(create.body), ["docId", "aid", "text", "note", "baseHash", "baseText"]);
        assert.deepEqual(create.body, {
          docId: DOC_ID, aid: AID, text: NEXT_TEXT, note: "",
          baseHash: BASE_HASH, baseText: BASE_TEXT,
        });
        assert.deepEqual(await page.evaluate(() => window.__published), []);

        await controls.getByRole("button", { name: "Edit", exact: true }).click();
        await page.locator(`[data-aid="${AID}"][contenteditable]`).waitFor();
        assert.deepEqual(await page.evaluate(() => window.__editStates), [AID]);
        await page.locator(`[data-aid="${AID}"]`).fill(ACCEPTED_TEXT);
        await page.locator(`[data-aid="${AID}"]`).press("Control+Enter");
        await page.waitForFunction(() => window.__editStates.at(-1) === null);
        const direct = host.state.requests.find((entry) => entry.path === "/api/edit");
        assert.deepEqual(Object.keys(direct.body), ["docId", "aid", "text", "baseHash"]);
        assert.equal(direct.body.baseHash, BASE_HASH);
        assert.equal(direct.body.text, ACCEPTED_TEXT);
      } finally { await context.close(); }

      const coalesced = await openFixture(browser, host, session(), [first]);
      try {
        await waitReadyUi(coalesced.page);
        let releaseSuggestions;
        host.state.suggestionGate = new Promise((resolve) => { releaseSuggestions = resolve; });
        const reads = host.state.suggestionReads;
        await coalesced.page.evaluate(([aid, hash]) => {
          const detail = Object.freeze({ source: "server", t: "edit.saved", aid, hash });
          for (let index = 0; index < 3; index += 1) {
            document.dispatchEvent(new CustomEvent("doc:event", { detail }));
          }
        }, [AID, BASE_HASH]);
        await waitUntil(() => host.state.suggestionReads === reads + 1, "single active suggestion read");
        releaseSuggestions();
        await waitUntil(() => host.state.suggestionReads === reads + 2, "one trailing suggestion read");
        await coalesced.page.waitForTimeout(50);
        assert.equal(host.state.suggestionReads, reads + 2);
      } finally { await coalesced.context.close(); }

      const maximumList = await openFixture(browser, host, session(), suggestions(10_000));
      try {
        await waitReadyUi(maximumList.page);
        assert.equal(await maximumList.page.locator("[data-suggest]").first().getAttribute("data-suggest"), "10000");
      } finally { await maximumList.context.close(); }

      for (const [label, model, configure] of [
        ["over-limit", suggestions(10_001), null],
        ["duplicate", [first, { ...first }], null],
        ["reordered", [suggestion("s_m8x2k3_4f7a9c33"), first], null],
        ["oversized", [], (state) => { state.suggestionReadMode = "oversized"; }],
      ]) {
        const invalidList = await openFixture(browser, host, session(), model, configure);
        try {
          await invalidList.page.getByText("Suggestions could not be loaded.", { exact: true })
            .waitFor({ state: "attached" });
          assert.equal(await invalidList.page.locator("[data-suggest]").count(), 0, label);
        } finally { await invalidList.context.close(); }
      }

      const commenter = await openFixture(browser, host, session({
        role: "commenter", canEdit: false, canAccept: false,
      }), [first]);
      try {
        await waitReadyUi(commenter.page);
        assert.equal(await commenter.page.locator(".doc-suggest-button").count(), 2);
        assert.equal(await commenter.page.locator(".doc-edit-button").count(), 0);
        await commenter.page.locator("#doc-comments-toggle").click();
        await commenter.page.locator(".doc-suggest-card").waitFor();
        assert.equal(await commenter.page.locator(".doc-suggest-accept").count(), 0);
        assert.equal(await commenter.page.locator(".doc-suggest-reject").count(), 0);
      } finally { await commenter.context.close(); }

      const privateSubject = "u_private_subject_77";
      const unnamedAuthor = suggestion("s_m8x2k2_4f7a9c32", NEXT_TEXT, {
        by: { sub: privateSubject, name: "", email: "private@example.invalid" },
      });
      const authorPrivacy = await openFixture(browser, host, session(), [unnamedAuthor]);
      try {
        await waitReadyUi(authorPrivacy.page);
        await authorPrivacy.page.locator("#doc-comments-toggle").click();
        const panel = authorPrivacy.page.locator("#doc-comments-list");
        await panel.locator(".doc-suggest-card").waitFor();
        assert.equal((await panel.locator(".doc-suggest-meta").textContent()).startsWith("Reader · "), true);
        assert.equal((await panel.textContent()).includes(privateSubject), false);
        assert.equal((await panel.ariaSnapshot()).includes(privateSubject), false);
      } finally { await authorPrivacy.context.close(); }

      const invalidSessionContext = await browser.newContext();
      await invalidSessionContext.addInitScript({ content: initScript() });
      const invalidSessionPage = await invalidSessionContext.newPage();
      await invalidSessionPage.goto(host.base, { waitUntil: "load" });
      /* A session body carrying one field beyond the frozen shape. This used to
         forge a non-enumerable property onto the `roles` array; ACN-006 removed
         that field, and the same property -- the validator accepts the exact key
         set and nothing adjacent to it -- is now asserted against the body
         itself. */
      await invalidSessionPage.evaluate((value) => {
        const detail = Object.freeze({ ...value, forged: "member" });
        document.dispatchEvent(new CustomEvent("session", { detail }));
      }, session());
      await invalidSessionPage.evaluate(() => window.doc.edit.overlaysReady);
      assert.equal(await invalidSessionPage.locator(".doc-edit-controls").count(), 0);
      await invalidSessionContext.close();

      const invalidTagContext = await browser.newContext();
      await invalidTagContext.addInitScript({ content: initScript() });
      const invalidTagPage = await invalidTagContext.newPage();
      await invalidTagPage.goto(`${host.base}/invalid-tag`, { waitUntil: "load" });
      assert.equal(await invalidTagPage.evaluate(() => window.doc.edit), null);
      await invalidTagContext.close();

      const superseded = suggestion("s_m8x2k4_4f7a9c34", ACCEPTED_TEXT, {
        at: "2026-09-03T16:20:25.123Z", state: "superseded",
      });
      const draftCase = await openFixture(browser, host, session(), [first, superseded]);
      try {
        await waitReadyUi(draftCase.page);
        await draftCase.page.locator(".doc-suggest-button").first().click();
        await draftCase.page.locator(".doc-suggest-draft").waitFor();
        await draftCase.page.getByRole("button", { name: "Re-propose", exact: true }).click();
        assert.equal(await draftCase.page.locator(".doc-suggest-draft").count(), 1);
        assert.equal(await draftCase.page.locator(".doc-suggest-draft-title").textContent(), "New suggestion");

        host.state.createMode = "malformed-conflict";
        await draftCase.page.locator(".doc-suggest-textarea").fill(ACCEPTED_TEXT);
        await draftCase.page.getByRole("button", { name: "Save", exact: true }).click();
        await draftCase.page.getByText("The suggestion was not saved.", { exact: true }).waitFor();
        assert.equal(await draftCase.page.locator(".doc-suggest-retry").count(), 0);
      } finally { await draftCase.context.close(); }

      const firstAction = suggestion("s_m8x2k1_4f7a9c31");
      const secondAction = suggestion("s_m8x2k3_4f7a9c33", ACCEPTED_TEXT, {
        at: "2026-09-03T16:20:25.123Z",
      });
      const actionCase = await openFixture(browser, host, session(), [firstAction, secondAction]);
      try {
        await waitReadyUi(actionCase.page);
        await actionCase.page.locator("#doc-comments-toggle").click();
        let releaseAction;
        host.state.actionGate = new Promise((resolve) => { releaseAction = resolve; });
        const cards = actionCase.page.locator(".doc-suggest-card");
        await cards.nth(0).getByRole("button", { name: "Withdraw", exact: true }).click();
        await waitUntil(() => host.state.requests.some((entry) =>
          entry.path === "/api/suggestion" && entry.body.sugId === firstAction.id), "held action");
        assert.equal(await cards.nth(0).locator("button").evaluateAll((buttons) =>
          buttons.filter((button) => button.disabled).length > 0), true);
        assert.equal(await cards.nth(1).locator("button").evaluateAll((buttons) =>
          buttons.some((button) => button.disabled)), false);
        releaseAction();
        host.state.actionGate = null;
        await actionCase.page.waitForFunction(() => document.querySelectorAll(".doc-suggest-card").length === 1);
        await actionCase.page.waitForFunction((id) => {
          const active = document.activeElement;
          const card = active === null ? null : active.closest(".doc-suggest-card");
          return card !== null && card.getAttribute("data-suggestion-id") === id;
        }, secondAction.id);
      } finally { await actionCase.context.close(); }

      const malformedAction = await openFixture(browser, host, session(), [firstAction]);
      try {
        await waitReadyUi(malformedAction.page);
        host.state.actionMode = "malformed-conflict";
        await malformedAction.page.locator("#doc-comments-toggle").click();
        await malformedAction.page.getByRole("button", { name: "Accept", exact: true }).click();
        await malformedAction.page.getByText("The suggestion change was not saved.", { exact: true }).waitFor();
        assert.equal(await malformedAction.page.locator(".doc-suggest-state").textContent(), "Open");
      } finally { await malformedAction.context.close(); }

      const rejectCase = await openFixture(browser, host, session(), [firstAction]);
      try {
        await waitReadyUi(rejectCase.page);
        await rejectCase.page.locator("#doc-comments-toggle").click();
        await rejectCase.page.getByRole("button", { name: "Reject", exact: true }).click();
        const reason = rejectCase.page.locator(".doc-suggest-reason");
        await rejectCase.page.getByRole("button", { name: "Reject suggestion", exact: true }).click();
        await rejectCase.page.getByText("Enter a reason before rejecting.", { exact: true }).waitFor();
        await reason.fill("An invented reason.");
        await rejectCase.page.getByRole("button", { name: "Reject suggestion", exact: true }).click();
        await rejectCase.page.waitForFunction(() => document.querySelectorAll(".doc-suggest-card").length === 0);
        const request = host.state.requests.find((entry) =>
          entry.path === "/api/suggestion" && entry.body.action === "reject");
        assert.deepEqual(request.body, {
          docId: DOC_ID, aid: AID, sugId: firstAction.id,
          action: "reject", reason: "An invented reason.",
        });
      } finally { await rejectCase.context.close(); }

      for (const [mode, message, removed] of [
        ["404", "This suggestion is no longer available.", true],
        ["500", "The suggestion change was not saved.", false],
      ]) {
        const failureCase = await openFixture(browser, host, session(), [firstAction]);
        try {
          await waitReadyUi(failureCase.page);
          host.state.actionMode = mode;
          await failureCase.page.locator("#doc-comments-toggle").click();
          await failureCase.page.getByRole("button", { name: "Withdraw", exact: true }).click();
          await failureCase.page.getByText(message, { exact: true }).waitFor();
          assert.equal(await failureCase.page.locator(".doc-suggest-card").count(), removed ? 0 : 1);
        } finally { await failureCase.context.close(); }
      }

      const terminalCase = await openFixture(browser, host, session(), [firstAction]);
      try {
        await waitReadyUi(terminalCase.page);
        host.state.actionMode = "403";
        await terminalCase.page.locator("#doc-comments-toggle").click();
        await terminalCase.page.getByRole("button", { name: "Withdraw", exact: true }).click();
        await terminalCase.page.waitForFunction(() =>
          document.querySelectorAll(".doc-suggest-button,.doc-suggest-card,[data-suggest]").length === 0);
        assert.equal(await terminalCase.page.locator(".doc-edit-button").count(), 2);
      } finally { await terminalCase.context.close(); }

      const pendingRace = await openFixture(browser, host, session(), [firstAction]);
      try {
        await waitReadyUi(pendingRace.page);
        let releasePending;
        host.state.pending = {
          [AID]: {
            text: OLD_PENDING_TEXT, by: { ...actor }, at: "2026-09-03T17:08:03.884Z",
            pr: null, via: "edit",
          },
        };
        host.state.pendingGate = new Promise((resolve) => { releasePending = resolve; });
        const reads = host.state.pendingReads;
        await pendingRace.page.evaluate(([aid, hash]) => {
          document.dispatchEvent(new CustomEvent("doc:event", {
            detail: Object.freeze({ source: "server", t: "edit.saved", aid, hash }),
          }));
        }, [AID, BASE_HASH]);
        await waitUntil(() => host.state.pendingReads > reads, "held pending read");
        await pendingRace.page.evaluate((aid) => {
          window.__pendingTexts = [];
          const block = document.querySelector(`[data-aid="${aid}"]`);
          new MutationObserver(() => window.__pendingTexts.push(block.getAttribute("data-md")))
            .observe(block, { attributes: true, attributeFilter: ["data-md"] });
          window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        }, AID);
        host.state.pending = {
          [AID]: {
            text: NEW_PENDING_TEXT, by: { ...actor }, at: "2026-09-03T17:08:04.884Z",
            pr: null, via: "edit",
          },
        };
        await pendingRace.page.evaluate(() => {
          window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        });
        releasePending();
        await waitUntil(() => host.state.pendingReads > reads + 1, "fresh BFCache pending read");
        await pendingRace.page.waitForFunction(({ aid, text }) =>
          document.querySelector(`[data-aid="${aid}"]`).getAttribute("data-md") === text,
        { aid: AID, text: NEW_PENDING_TEXT });
        assert.equal(await pendingRace.page.evaluate((text) => window.__pendingTexts.includes(text), OLD_PENDING_TEXT), false);
      } finally { await pendingRace.context.close(); }

      const acceptCase = await openFixture(browser, host, session(), [suggestion(
        "s_m8x2k3_4f7a9c33", ACCEPTED_TEXT,
      )]);
      try {
        await waitReadyUi(acceptCase.page);
        await acceptCase.page.locator("#doc-comments-toggle").click();
        const accept = acceptCase.page.getByRole("button", { name: "Accept", exact: true });
        await accept.waitFor();
        await accept.click();
        await acceptCase.page.waitForFunction(({ aid, text }) =>
          document.querySelector(`[data-aid="${aid}"]`).getAttribute("data-md") === text,
        { aid: AID, text: ACCEPTED_TEXT });
        const action = host.state.requests.find((entry) => entry.path === "/api/suggestion");
        assert.deepEqual(action.body, {
          docId: DOC_ID, aid: AID, sugId: "s_m8x2k3_4f7a9c33", action: "accept", reason: "",
        });
        assert.equal(await acceptCase.page.locator(`[data-aid="${AID}"]`).textContent(), ACCEPTED_TEXT);
        assert.deepEqual(await acceptCase.page.evaluate(() => window.__overlays.at(-1)), [AID]);
      } finally { await acceptCase.context.close(); }
    });
  } finally {
    await new Promise((resolve) => host.server.close(resolve));
  }
}

async function browserMatrix() {
  const source = readFileSync(EDIT_JS, "utf8");
  const css = readFileSync(EDIT_CSS, "utf8");
  for (const required of [
    "/api/pending", "/api/suggestions", "/api/suggestion", "edit.saved",
    "baseHash", "baseText", "doc:overlay", 'register("suggestion"',
  ]) assert.ok(source.includes(required), required);
  for (const denied of [
    "setInterval", "localStorage", "sessionStorage", "diffWords", "window.doc.suggestions",
  ]) assert.equal(source.includes(denied), false, denied);
  for (const required of [
    ".doc-suggest-button", ".doc-suggest-draft", ".doc-suggest-chip",
    ".doc-suggest-card", "[data-suggest]", "prefers-reduced-motion",
    "forced-colors", "@media print",
  ]) assert.ok(css.includes(required), required);

  const host = serve();
  host.base = await listen(host.server);
  try {
    await withBrowser(async (browser) => {
      const context = await browser.newContext({ viewport: { width: 320, height: 720 }, deviceScaleFactor: 2 });
      await context.addInitScript({ content: initScript() });
      const page = await context.newPage();
      host.state.suggestions = [suggestion("s_m8x2k1_4f7a9c31", `${NEXT_TEXT}\n${"wrap ".repeat(90)}`)];
      await page.goto(host.base, { waitUntil: "load" });
      await revealSession(page, session());
      await waitReadyUi(page);
      await page.locator("#doc-comments-toggle").click();
      await page.locator(".doc-suggest-card").waitFor();
      const geometry = await page.evaluate(() => {
        const card = document.querySelector(".doc-suggest-card");
        const focus = document.querySelector(".doc-suggest-card button, .doc-suggest-button");
        focus.focus({ focusVisible: true });
        const style = getComputedStyle(focus);
        return {
          body: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          cardWidth: card.getBoundingClientRect().width,
          outline: parseFloat(style.outlineWidth),
        };
      });
      assert.ok(geometry.cardWidth > 0);
      assert.ok(geometry.body <= geometry.viewport, JSON.stringify(geometry));
      assert.ok(geometry.outline >= 2, JSON.stringify(geometry));

      await page.emulateMedia({ media: "print" });
      assert.equal(await page.locator(".doc-suggest-button").first().isVisible(), false);
      await page.emulateMedia({ media: "screen", reducedMotion: "reduce", forcedColors: "active" });
      const forced = await page.locator(".doc-suggest-button").first().evaluate((node) => {
        const style = getComputedStyle(node);
        return { duration: style.transitionDuration, border: parseFloat(style.borderTopWidth) };
      });
      assert.match(forced.duration, /^(?:0s|0ms)(?:, (?:0s|0ms))*$/);
      assert.ok(forced.border >= 1);
      await context.close();

      const artifact = join(process.env.P4P_WORK_ROOT, "fixture.html");
      writeFileSync(artifact, fixtureHtml(), { mode: 0o600 });
      const fileContext = await browser.newContext();
      await fileContext.addInitScript({ content: initScript() });
      const filePage = await fileContext.newPage();
      let apiRequests = 0;
      filePage.on("request", (request) => {
        if (request.url().includes("/api/")) apiRequests += 1;
      });
      await filePage.goto(pathToFileURL(artifact).href);
      assert.equal(await filePage.locator(".doc-suggest-button").count(), 0);
      assert.equal(apiRequests, 0);
      await fileContext.close();
    });
  } finally {
    await new Promise((resolve) => host.server.close(resolve));
  }
}

async function worker(run) {
  await run();
}

async function supervise() {
  const supervisorRoot = guardedRoot("p4p-supervisor-");
  const installRoot = guardedRoot("p4p-playwright-");
  const runtimeRoot = guardedRoot("p4p-runtime-");
  const browserRoot = guardedRoot("p4p-browser-");
  const roots = [supervisorRoot, installRoot, runtimeRoot, browserRoot];
  let completed = false;
  try {
    for (const name of ["probe-sighup", "probe-sigint", "probe-sigterm", "probe-hang", "probe-forward"])
      mkdirGuarded(join(supervisorRoot, name));
    await proveSupervision(supervisorRoot);
    process.stdout.write("PASS  P4-P supervisor signals and deadline\n");
    await installPlaywright(installRoot);

    const shared = {
      P4P_PLAYWRIGHT_ROOT: installRoot,
      PLAYWRIGHT_BROWSERS_PATH: join(installRoot, "browsers"),
    };
    const runtime = await runChild(["--runtime"], {
      deadline: WORKER_DEADLINE_MS,
      cwd: ROOT,
      env: { ...shared, HOME: runtimeRoot, P4P_WORK_ROOT: runtimeRoot, TMPDIR: runtimeRoot },
    });
    requireSuccess("runtime worker", runtime);
    process.stdout.write("PASS  P4-P base, list, draft, action, overlay, and claim matrix\n");

    const browser = await runChild(["--browser"], {
      deadline: WORKER_DEADLINE_MS,
      cwd: ROOT,
      env: { ...shared, HOME: browserRoot, P4P_WORK_ROOT: browserRoot, TMPDIR: browserRoot },
    });
    requireSuccess("browser worker", browser);
    process.stdout.write("PASS  P4-P rendered suggestion and direct-edit integration\n");
    completed = true;
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
  assert.equal(completed, true);
  for (const root of roots) assert.equal(existsSync(root), false, root);
  process.stdout.write("PASS  P4-P fixture cleaned\n");
}

function mkdirGuarded(path) {
  // Probe cwd values must exist before spawn and inherit the guarded parent.
  const parent = dirname(path);
  assert.equal(statSync(parent).mode & 0o077, 0);
  mkdirSync(path, { mode: 0o700 });
  assert.equal(statSync(path).mode & 0o777, 0o700);
}

const mode = process.argv[2];
if (mode === "--probe-signal") probeSignal();
else if (mode === "--probe-hang") probeHang();
else if (mode === "--probe-forward") worker(probeForward);
else if (mode === "--run-node") runNode();
else if (mode === "--runtime") worker(runtimeMatrix);
else if (mode === "--browser") worker(browserMatrix);
else if (mode === undefined) worker(supervise);
else {
  process.stderr.write("This runner accepts no public arguments.\n");
  process.exitCode = 2;
}
