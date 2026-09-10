#!/usr/bin/env node
/**
 * P4-L — the permanent share-panel write-controls regression runner.
 *
 *   node scripts/test-p4-l.mjs contract
 *
 * One entry point, one public argument, two lines of output. Nothing here
 * reads a credential, a remote provider, a real account or a private fixture:
 * both matrices drive the integrated production `templates/base/share.js` --
 * P3-I's read path and P4-L's writes -- inside an invented loopback document
 * with a programmable `fetch` queue and a scaled clock, so every route, body,
 * header, status, deadline and generation is exact rather than timed.
 *
 * The process shape is part of the contract. Each matrix runs as a direct
 * child in its own mode-0700 temporary root with a deadline, a capped capture,
 * TERM escalated to KILL, forwarded HUP/INT/TERM, a reaped child and a proof
 * that its process group is gone. A worker that exits zero while narrating to
 * stdout or stderr fails the run, and the roots must be gone before either
 * PASS line is printed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardedTempRoot,
  installSignalCleanup,
  removeTempRoots,
  sweepStaleTempRoots,
} from "./lib/temp-roots.mjs";

const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const ROOT = dirname(HERE);
const SHARE_JS = join(ROOT, "templates", "base", "share.js");
const SHARE_CSS = join(ROOT, "templates", "base", "share.css");

const PLAYWRIGHT = "playwright@1.55.0";
const WORKER_DEADLINE_MS = 120_000;
const INSTALL_DEADLINE_MS = 900_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 65_536;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/* Invented fixtures. Every address is an example.com placeholder. */
const DOC = "4b7d2a";
const OWNER_EMAIL = "owner@example.com";
const EDITOR_EMAIL = "ada@example.com";
const VIEWER_EMAIL = "blake@example.com";
const INVITE_EMAIL = "cleo@example.com";
const NEW_EMAIL = "dara@example.com";

const TRANSFER_WARNING = "Transfer ownership to this person? You will become an editor."
  + " If setup stops during transfer, the new owner may need to invite you again.";

function session(role, extra = {}) {
  const owner = role === "owner";
  return {
    sub: owner ? "owner-1" : "member-1",
    email: owner ? OWNER_EMAIL : EDITOR_EMAIL,
    name: "",
    canComment: true,
    canEdit: true,
    doc: DOC,
    role,
    shared: true,
    canSuggest: true,
    canAccept: role !== "viewer",
    canShare: owner,
    canSeeMembers: role === "owner" || role === "editor",
    ...extra,
  };
}

function roster(extra = {}) {
  return {
    doc: DOC,
    orgDefault: "commenter",
    members: [
      { sub: "owner-1", email: OWNER_EMAIL, name: "", role: "owner" },
      { sub: "member-1", email: EDITOR_EMAIL, name: "Ada Sample", role: "editor" },
      { sub: "member-2", email: VIEWER_EMAIL, name: "", role: "viewer" },
    ],
    invitations: [
      { email: INVITE_EMAIL, role: "commenter", expiresAt: "2030-01-05T00:00:00.000Z" },
    ],
    ...extra,
  };
}

/* ------------------------------------------------------------ supervisor */

class Capture {
  constructor() {
    this.parts = [];
    this.size = 0;
  }

  push(chunk) {
    if (this.size >= OUTPUT_LIMIT) return;
    const text = chunk.toString("utf8");
    this.parts.push(text.slice(0, OUTPUT_LIMIT - this.size));
    this.size += text.length;
  }

  toString() {
    return this.parts.join("");
  }
}

function runChild(args, { deadline, cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const out = new Capture();
    const err = new Capture();
    let expired = false;
    let killTimer = null;

    const stop = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        try {
          child.kill(signal);
        } catch (ignored) { /* already gone */ }
      }
    };

    const timer = setTimeout(() => {
      expired = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS);
    }, deadline);

    const forwarded = [];
    for (const name of Object.keys(SIGNALS)) {
      const handler = () => stop(name);
      forwarded.push([name, handler]);
      process.on(name, handler);
    }

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => err.push(Buffer.from(`spawn failed: ${error.message}\n`)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      for (const [name, handler] of forwarded) process.removeListener(name, handler);
      let orphaned = false;
      try {
        process.kill(-child.pid, 0);
        orphaned = true;
      } catch (error) {
        orphaned = false;
      }
      resolve({
        code: expired ? 124 : code !== null ? code : 128 + (SIGNALS[signal] || 0),
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        orphaned,
      });
    });
  });
}

function fail(label, result) {
  process.stderr.write(`FAIL  ${label}\n`);
  if (result !== undefined) {
    process.stderr.write(`      exit ${result.code}${result.signal ? ` (${result.signal})` : ""}\n`);
    if (result.stdout !== "") process.stderr.write(`      stdout: ${result.stdout.slice(0, 4000)}\n`);
    if (result.stderr !== "") process.stderr.write(`      stderr: ${result.stderr.slice(0, 4000)}\n`);
  }
  throw new Error(label);
}

async function installPlaywright(root) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "p4l-fixture", private: true, version: "0.0.0", type: "module",
  })}\n`, { mode: 0o600 });
  const npm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const install = await runChild([npm, "install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--silent", PLAYWRIGHT], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { npm_config_yes: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  if (install.code !== 0) fail(`P4-L could not install ${PLAYWRIGHT}`, install);
  const browsers = await runChild([join(root, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
  });
  if (browsers.code !== 0) fail("P4-L could not install the pinned browser", browsers);
}

async function supervise() {
  sweepStaleTempRoots(["p4l-install-", "p4l-p3i-", "p4l-write-"]);
  const install = guardedTempRoot("p4l-install-");
  const roots = [install];
  const uninstallSignalCleanup = installSignalCleanup(roots, { exitAfterCleanup: false });
  try {
    await installPlaywright(install);
    for (const [flag, prefix, line] of [
      ["--p3i", "p4l-p3i-", "PASS  P3-I offline, role, lazy-fetch, inert-render, refresh, and revoke contract"],
      ["--p4l", "p4l-write-", "PASS  P4-L owner controls, session reconciliation, close, privacy, and CSS contract"],
    ]) {
      const root = guardedTempRoot(prefix);
      roots.push(root);
      const result = await runChild([SELF, flag], {
        deadline: WORKER_DEADLINE_MS,
        cwd: root,
        env: {
          TMPDIR: root,
          P4L_ROOT: root,
          P4L_INSTALL: install,
          PLAYWRIGHT_BROWSERS_PATH: join(install, "browsers"),
        },
      });
      if (result.code !== 0) fail(`P4-L worker ${flag}`, result);
      if (result.orphaned) fail(`P4-L worker ${flag} left its process group behind`, result);
      if (result.stdout !== "") fail(`P4-L worker ${flag} wrote to stdout`, result);
      if (result.stderr !== "") fail(`P4-L worker ${flag} wrote to stderr`, result);
      process.stdout.write(`${line}\n`);
    }
  } finally {
    uninstallSignalCleanup();
    removeTempRoots(roots);
  }
  const left = roots.filter((root) => existsSync(root));
  if (left.length !== 0) fail(`P4-L left fixture state behind: ${left.join(", ")}`);
}

/* ---------------------------------------------------------------- worker */

/* The page's whole outside world: a recording `fetch` queue, a scaled clock so
   the 15s/5s/2s deadlines are reachable inside a bounded run, and poisoned
   modal, storage and console sinks. */
const INIT_SCRIPT = `(() => {
  const state = {
    calls: [], queue: [], holds: [], modals: 0, stored: 0, logged: 0, bodyReads: 0,
  };
  window.__p4l = state;
  const encoder = new TextEncoder();

  function makeResponse(spec) {
    const headers = new Map();
    if (typeof spec.contentType === "string") headers.set("content-type", spec.contentType);
    if (typeof spec.contentLength === "string") headers.set("content-length", spec.contentLength);
    const response = {
      status: spec.status,
      redirected: spec.redirected === true,
      headers: {
        get(name) {
          const value = headers.get(String(name).toLowerCase());
          return value === undefined ? null : value;
        },
      },
    };
    if (spec.poison === true) {
      const trap = () => { state.bodyReads += 1; throw new Error("poisoned body"); };
      Object.defineProperty(response, "body", { get: trap });
      response.json = trap;
      response.text = trap;
      response.arrayBuffer = trap;
      return response;
    }
    const text = typeof spec.text === "string"
      ? spec.text
      : (spec.json === undefined ? null : JSON.stringify(spec.json));
    if (text === null) {
      response.body = null;
      response.json = () => Promise.reject(new Error("no body"));
      return response;
    }
    const bytes = encoder.encode(text);
    response.body = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
    response.json = () => Promise.resolve(JSON.parse(text));
    return response;
  }

  window.fetch = (input, init) => {
    const options = init || {};
    let parsed = null;
    if (typeof options.body === "string") {
      try { parsed = JSON.parse(options.body); } catch (error) { parsed = options.body; }
    }
    const record = {
      url: String(input),
      method: options.method === undefined ? "GET" : options.method,
      mode: options.mode === undefined ? null : options.mode,
      credentials: options.credentials === undefined ? null : options.credentials,
      cache: options.cache === undefined ? null : options.cache,
      redirect: options.redirect === undefined ? null : options.redirect,
      headers: options.headers === undefined ? null : Object.assign({}, options.headers),
      body: parsed,
      keys: parsed !== null && typeof parsed === "object" ? Object.keys(parsed) : null,
      hasSignal: Boolean(options.signal),
      aborted: false,
    };
    state.calls.push(record);
    const spec = state.queue.shift();
    if (spec === undefined) return Promise.reject(new TypeError("unqueued request"));
    if (spec.kind === "reject") return Promise.reject(new TypeError("network"));
    if (spec.kind === "hold") {
      return new Promise((resolve, reject) => {
        const hold = { resolve: (later) => resolve(makeResponse(later)), reject };
        state.holds.push(hold);
        if (options.signal) {
          options.signal.addEventListener("abort", () => {
            record.aborted = true;
            const at = state.holds.indexOf(hold);
            if (at !== -1) state.holds.splice(at, 1);
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }
      });
    }
    return Promise.resolve(makeResponse(spec));
  };

  state.release = (spec) => {
    const hold = state.holds.shift();
    if (hold === undefined) throw new Error("no held request");
    hold.resolve(spec);
  };

  const realTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...rest) =>
    realTimeout(fn, typeof ms === "number" && ms >= 1000 ? ms / 50 : ms, ...rest);

  for (const name of ["alert", "confirm", "prompt"]) {
    window[name] = () => { state.modals += 1; return undefined; };
  }
  for (const storage of [window.localStorage, window.sessionStorage]) {
    const real = storage.setItem.bind(storage);
    storage.setItem = (...args) => { state.stored += 1; return real(...args); };
  }
  for (const name of ["log", "warn", "error", "info", "debug"]) {
    console[name] = () => { state.logged += 1; };
  }
})()`;

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="doc-id" content="${DOC}">
<title>Access fixture</title>
<link rel="stylesheet" href="/share.css">
<style>body{margin:0;font-family:system-ui,sans-serif}
.head-top{display:flex;justify-content:flex-end;gap:.5rem;padding:.5rem}</style>
</head><body><header><div class="head-top"><span>doc</span></div></header>
<main><p>Fixture document.</p></main></body></html>`;

function serveFixture(css) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const path = request.url.split("?")[0];
      if (path === "/share.css") {
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        response.end(css);
        return;
      }
      if (path === "/" || path === "/index.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(PAGE_HTML);
        return;
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function loadPlaywright() {
  const install = process.env.P4L_INSTALL;
  assert.ok(typeof install === "string" && install !== "", "P4L_INSTALL is required");
  const module = await import(pathToFileURL(join(install, "node_modules", "playwright", "index.mjs")).href);
  return module.chromium;
}

/* One page per scenario: a private context, the stubs installed before any
   script runs, the production module injected, and no shared state at all. */
async function open(browser, origin, source, { queue = [], detail = null } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: source });
  if (queue.length !== 0) await push(page, queue);
  if (detail !== null) await dispatch(page, detail);
  return { context, page };
}

function push(page, specs) {
  return page.evaluate((list) => { window.__p4l.queue.push(...list); }, specs);
}

function dispatch(page, detail) {
  return page.evaluate((value) => {
    document.dispatchEvent(new CustomEvent("session", { detail: value }));
  }, detail);
}

function calls(page) {
  return page.evaluate(() => window.__p4l.calls.map((call) => ({ ...call })));
}

function probe(page) {
  return page.evaluate(() => {
    const panel = document.querySelector("#doc-share-panel");
    const button = document.querySelector("#doc-share-button");
    const collect = (selector) => Array.from(document.querySelectorAll(selector));
    const attributeText = [];
    if (panel !== null) {
      for (const node of panel.querySelectorAll("*")) {
        for (const attribute of node.attributes) attributeText.push(`${attribute.name}=${attribute.value}`);
      }
    }
    return {
      hasButton: button !== null,
      hasPanel: panel !== null,
      hidden: panel === null ? null : panel.hidden,
      busy: panel === null ? null : panel.getAttribute("aria-busy"),
      status: panel === null ? null : panel.querySelector(".share-status").textContent,
      defaultText: panel === null ? null : panel.querySelector(".share-default").textContent,
      members: collect("#doc-share-panel .share-members li").map((li) => li.textContent),
      invitations: collect("#doc-share-panel .share-invitations li").map((li) => li.textContent),
      ops: collect("#doc-share-panel .share-op").length,
      disabled: collect("#doc-share-panel .share-op").filter((node) => node.disabled).length,
      rowControls: collect("#doc-share-panel .share-row-controls").length,
      hasInvite: panel !== null && panel.querySelector(".share-invite") !== null,
      hasDefaultControl: panel !== null && panel.querySelector(".share-default-control") !== null,
      confirmations: collect("#doc-share-panel .share-transfer-confirm").length,
      confirmText: (() => {
        const node = document.querySelector("#doc-share-panel .share-transfer-confirm p");
        return node === null ? null : node.textContent;
      })(),
      activeClass: document.activeElement === null ? null : document.activeElement.className,
      closeDisabled: panel === null ? null : panel.querySelector(".share-close").disabled,
      attributeText: attributeText.join("\n"),
      modals: window.__p4l.modals,
      stored: window.__p4l.stored,
      logged: window.__p4l.logged,
      bodyReads: window.__p4l.bodyReads,
      cookie: document.cookie,
      globals: ["session", "roster", "share", "__share"].filter((key) => key in window).join(","),
      dataSession: document.documentElement.getAttribute("data-session"),
    };
  });
}

function waitCalls(page, count) {
  return page.waitForFunction((n) => window.__p4l.calls.length >= n, count, { timeout: 10_000 });
}

function waitStatus(page, text) {
  return page.waitForFunction((expected) => {
    const node = document.querySelector("#doc-share-panel .share-status");
    return node !== null && node.textContent === expected;
  }, text, { timeout: 10_000 });
}

function waitHold(page) {
  return page.waitForFunction(() => window.__p4l.holds.length > 0, undefined, { timeout: 10_000 });
}

const json200 = (body) => ({ status: 200, contentType: "application/json", json: body });
const status = (code, extra = {}) => ({ status: code, poison: true, ...extra });
const HOLD = { kind: "hold" };

/* The value is written straight onto the control so the client's own byte and
   grammar checks are what reject it, not the DOM `maxlength` cap a forged
   page would not have. */
function setInvite(page, value) {
  return page.evaluate((text) => {
    const input = document.querySelector("#doc-share-panel .share-invite-email");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

function click(page, selector) {
  return page.click(selector, { timeout: 10_000 });
}

async function scenario(browser, origin, source, options, body) {
  const { context, page } = await open(browser, origin, source, options);
  try {
    await body(page);
  } finally {
    await context.close();
  }
}

function activeId(page) {
  return page.evaluate(() => (document.activeElement === null ? null : document.activeElement.id));
}

function assertReadTransport(call, origin) {
  assert.equal(call.url, `${origin}/api/access?doc=${DOC}`);
  assert.equal(call.method, "GET");
  assert.equal(call.mode, "same-origin");
  assert.equal(call.credentials, "same-origin");
  assert.equal(call.cache, "no-store");
  assert.equal(call.redirect, "error");
  assert.deepEqual(call.headers, { Accept: "application/json" });
  assert.equal(call.hasSignal, true);
  assert.equal(call.body, null);
}

function assertWriteTransport(call, origin, method, path, body) {
  assert.equal(call.url, `${origin}${path}`);
  assert.equal(call.method, method);
  assert.equal(call.mode, null, "a mutation sets no request mode");
  assert.equal(call.credentials, "same-origin");
  assert.equal(call.cache, "no-store");
  assert.equal(call.redirect, "error");
  assert.deepEqual(call.headers, { "Content-Type": "application/json", "Accept": "application/json" });
  assert.equal(call.hasSignal, true);
  assert.deepEqual(call.body, body);
  assert.deepEqual(call.keys, Object.keys(body), "the body carries exactly the P4-J variant keys");
}

/* -------------------------------------------------- P3-I preserved matrix */

async function p3iMatrix() {
  const source = readFileSync(SHARE_JS, "utf8");
  const css = readFileSync(SHARE_CSS, "utf8");
  const { server, origin } = await serveFixture(css);
  const chromium = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    /* A `file:` document never mounts the feature at all. */
    const root = process.env.P4L_ROOT;
    const filePath = join(root, "fixture.html");
    writeFileSync(filePath, PAGE_HTML.replace('<link rel="stylesheet" href="/share.css">', ""), { mode: 0o600 });
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(INIT_SCRIPT);
      await page.goto(`file://${filePath}`);
      await page.addScriptTag({ content: source });
      await dispatch(page, session("owner"));
      const state = await probe(page);
      assert.equal(state.hasButton, false, "file: must create no Share button");
      assert.deepEqual(await calls(page), []);
      await context.close();
    }

    /* No session event, and every rejected session shape, stay inert. */
    await scenario(browser, origin, source, {}, async (page) => {
      assert.equal((await probe(page)).hasButton, false);
    });
    const rejected = [
      null,
      "owner",
      session("owner", { doc: "zzzz" }),
      session("owner", { shared: false }),
      session("owner", { canSeeMembers: false }),
      session("owner", { canShare: false }),
      session("editor", { canShare: true }),
      session("commenter", { canShare: false, canSeeMembers: false }),
      session("viewer", { canShare: false, canSeeMembers: false }),
    ];
    for (const detail of rejected) {
      await scenario(browser, origin, source, { detail }, async (page) => {
        assert.equal((await probe(page)).hasButton, false, `rejected session mounted: ${JSON.stringify(detail)}`);
        assert.deepEqual(await calls(page), []);
      });
    }

    /* A document without the masthead host mounts nothing. */
    {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.addInitScript(INIT_SCRIPT);
      await page.goto(`${origin}/`);
      await page.evaluate(() => document.querySelector(".head-top").remove());
      await page.addScriptTag({ content: source });
      await dispatch(page, session("owner"));
      assert.equal((await probe(page)).hasButton, false);
      await context.close();
    }

    /* Lazy read: nothing until open, exactly one per closed-to-open edge. */
    await scenario(browser, origin, source, {
      detail: session("editor"),
      queue: [json200(roster()), json200(roster())],
    }, async (page) => {
      assert.equal((await probe(page)).hasButton, true);
      assert.deepEqual(await calls(page), []);
      await click(page, "#doc-share-button");
      await waitCalls(page, 1);
      const [first] = await calls(page);
      assertReadTransport(first, origin);
      const rendered = await probe(page);
      assert.equal(rendered.members.length, 3);
      assert.ok(rendered.members[1].includes("Ada Sample"));
      assert.ok(rendered.members[1].includes(EDITOR_EMAIL));
      assert.ok(rendered.members[1].includes("Editor"));
      assert.equal(rendered.invitations.length, 1);
      assert.ok(rendered.invitations[0].includes("Pending until 2030-01-05"));
      assert.equal(rendered.defaultText, "Organization default: Commenter");
      assert.equal(rendered.status, "");
      /* An editor gets exactly the read-only roster. */
      assert.equal(rendered.ops, 0);
      assert.equal(rendered.rowControls, 0);
      assert.equal(rendered.hasInvite, false);
      assert.equal(rendered.hasDefaultControl, false);

      await click(page, "#doc-share-button");
      assert.equal((await probe(page)).hidden, true);
      assert.equal(await activeId(page), "doc-share-button");
      await click(page, "#doc-share-button");
      await waitCalls(page, 2);
      assert.equal((await calls(page)).length, 2);
    });

    /* A roster that fails validation renders no prefix at all. */
    for (const invalid of [
      roster({ doc: "0f0f0f" }),
      roster({ orgDefault: "editor" }),
      roster({ members: [] }),
      roster({ members: [{ sub: "owner-1", email: OWNER_EMAIL, name: "Owner", role: "owner" }] }),
      roster({ invitations: [{ email: INVITE_EMAIL, role: "owner", expiresAt: "2030-01-05T00:00:00.000Z" }] }),
    ]) {
      await scenario(browser, origin, source, {
        detail: session("editor"),
        queue: [json200(invalid)],
      }, async (page) => {
        await click(page, "#doc-share-button");
        await waitStatus(page, "Access list could not be refreshed.");
        const state = await probe(page);
        assert.deepEqual(state.members, []);
        assert.deepEqual(state.invitations, []);
      });
    }

    /* Read failures that are not an authorization answer keep the surface. */
    for (const spec of [
      { status: 500, poison: true },
      { kind: "reject" },
      json200({ doc: DOC }),
      { status: 200, contentType: "text/html", json: roster() },
    ]) {
      await scenario(browser, origin, source, {
        detail: session("editor"),
        queue: [spec],
      }, async (page) => {
        await click(page, "#doc-share-button");
        await waitStatus(page, "Access list could not be refreshed.");
        assert.equal((await probe(page)).hasButton, true);
      });
    }

    /* An authorization answer removes the complete feature. */
    for (const code of [401, 403]) {
      await scenario(browser, origin, source, {
        detail: session("editor"),
        queue: [status(code)],
      }, async (page) => {
        await click(page, "#doc-share-button");
        await page.waitForFunction(() => document.querySelector("#doc-share-button") === null, undefined, { timeout: 10_000 });
        const state = await probe(page);
        assert.equal(state.hasButton, false);
        assert.equal(state.hasPanel, false);
      });
    }

    /* Every close path, and the focus return each one owes. */
    for (const close of ["escape", "outside", "button"]) {
      await scenario(browser, origin, source, {
        detail: session("editor"),
        queue: [json200(roster())],
      }, async (page) => {
        await click(page, "#doc-share-button");
        await waitCalls(page, 1);
        if (close === "escape") await page.keyboard.press("Escape");
        if (close === "outside") await page.mouse.click(5, 400);
        if (close === "button") await click(page, "#doc-share-panel .share-close");
        await page.waitForFunction(() => document.querySelector("#doc-share-panel").hidden === true, undefined, { timeout: 10_000 });
        if (close === "outside") {
          /* A pointer press outside the panel focuses whatever it landed on
             after the close handler has run, so the invariant that survives it
             is that focus never stays inside the hidden panel. */
          const trapped = await page.evaluate(() =>
            document.querySelector("#doc-share-panel").contains(document.activeElement));
          assert.equal(trapped, false);
        } else {
          assert.equal(await activeId(page), "doc-share-button");
        }
      });
    }

    /* A read that arrives after its generation was closed renders nothing. */
    await scenario(browser, origin, source, {
      detail: session("editor"),
      queue: [HOLD],
    }, async (page) => {
      await click(page, "#doc-share-button");
      await waitCalls(page, 1);
      await waitHold(page);
      await click(page, "#doc-share-button");
      const [call] = await calls(page);
      assert.equal(call.aborted, true, "closing must abort the in-flight read");
      const state = await probe(page);
      assert.deepEqual(state.members, []);
    });
  } finally {
    await browser.close();
    server.close();
  }
}

/* ------------------------------------------------------ P4-L write matrix */

const MEMBER_ROW = "#doc-share-panel .share-members li:nth-of-type(2)";
const INVITATION_ROW = "#doc-share-panel .share-invitations li:nth-of-type(1)";

async function ownerPanel(browser, origin, source, queue, body, detail = session("owner")) {
  await scenario(browser, origin, source, {
    detail,
    queue: [json200(roster()), ...queue],
  }, async (page) => {
    await click(page, "#doc-share-button");
    await waitCalls(page, 1);
    await page.waitForFunction(() => document.querySelector("#doc-share-panel .share-invite") !== null,
      undefined, { timeout: 10_000 });
    await body(page);
  });
}

async function p4lMatrix() {
  const source = readFileSync(SHARE_JS, "utf8");
  const css = readFileSync(SHARE_CSS, "utf8");
  const { server, origin } = await serveFixture(css);
  const chromium = await loadPlaywright();
  const browser = await chromium.launch();
  try {
    /* Only a validated owner gets controls, and never on the owner's own row. */
    await ownerPanel(browser, origin, source, [], async (page) => {
      const state = await probe(page);
      assert.equal(state.hasInvite, true);
      assert.equal(state.hasDefaultControl, true);
      assert.equal(state.rowControls, 3, "two grants and one invitation carry controls");
      assert.equal(state.defaultText, "", "the read-only default paragraph is replaced for an owner");
      assert.equal(state.ops, 17, "invite, default, two grants and one invitation carry 17 controls");
      assert.equal(state.disabled, 4, "every Save button starts disabled");
      const shape = await page.evaluate(([memberRow, invitationRow]) => {
        const owner = document.querySelector("#doc-share-panel .share-members li:nth-of-type(1)");
        const invite = document.querySelector("#doc-share-panel .share-invite");
        const options = (selector) => Array.from(document.querySelectorAll(selector))
          .map((node) => `${node.value}:${node.textContent}`);
        return {
          ownerControls: owner.querySelectorAll(".share-row-controls").length,
          novalidate: invite.hasAttribute("novalidate"),
          emailType: invite.querySelector(".share-invite-email").getAttribute("type"),
          autocomplete: invite.querySelector(".share-invite-email").getAttribute("autocomplete"),
          maxlength: invite.querySelector(".share-invite-email").getAttribute("maxlength"),
          inviteRole: options("#doc-share-panel .share-invite-role option"),
          inviteValue: invite.querySelector(".share-invite-role").value,
          defaultOptions: options("#doc-share-panel .share-default-control option"),
          defaultValue: document.querySelector("#doc-share-panel .share-default-control").value,
          rowOptions: options(`${memberRow} .share-role option`),
          rowValue: document.querySelector(`${memberRow} .share-role`).value,
          rowLabel: document.querySelector(`${memberRow} .share-op-label`).textContent,
          buttons: Array.from(document.querySelectorAll(`${memberRow} button`)).map((node) => node.textContent),
          invitationButtons: Array.from(document.querySelectorAll(`${invitationRow} button`)).map((node) => node.textContent),
        };
      }, [MEMBER_ROW, INVITATION_ROW]);
      assert.equal(shape.ownerControls, 0, "the owner row carries no role, revoke or transfer control");
      assert.equal(shape.novalidate, true);
      assert.equal(shape.emailType, "email");
      assert.equal(shape.autocomplete, "off");
      assert.equal(shape.maxlength, "254");
      assert.deepEqual(shape.inviteRole, ["commenter:Commenter", "viewer:Viewer", "editor:Editor"]);
      assert.equal(shape.inviteValue, "commenter");
      assert.deepEqual(shape.defaultOptions, ["commenter:Commenter", "viewer:Viewer", "none:None"]);
      assert.equal(shape.defaultValue, "commenter");
      assert.deepEqual(shape.rowOptions, ["editor:Editor", "commenter:Commenter", "viewer:Viewer"]);
      assert.equal(shape.rowValue, "editor");
      assert.ok(shape.rowLabel.startsWith(`Role for ${EDITOR_EMAIL}`));
      assert.deepEqual(shape.buttons, ["Save role", "Revoke access", "Transfer ownership"]);
      assert.deepEqual(shape.invitationButtons, ["Save role", "Cancel invitation", "Resend setup link"]);
      assert.equal((await calls(page)).length, 1, "rendering controls sends no request");
    });

    /* Local invite validation answers without a request and without echoing. */
    const at255 = `${"a".repeat(243)}@example.com`;
    assert.equal(at255.length, 255);
    for (const value of ["", "a@", "@example.com", "no-at-sign", "a b@example.com", at255]) {
      await ownerPanel(browser, origin, source, [], async (page) => {
        await setInvite(page, value);
        await click(page, "#doc-share-panel .share-invite-submit");
        await waitStatus(page, "Enter a valid email address.");
        assert.equal((await calls(page)).length, 1, `invalid invite sent a request: ${value}`);
        const state = await probe(page);
        assert.ok(!state.status.includes("@"), "the live status never carries an address");
      });
    }
    /* The 254-byte ceiling is the accepting boundary, 255 is not. */
    const at254 = `${"a".repeat(242)}@example.com`;
    assert.equal(at254.length, 254);
    await ownerPanel(browser, origin, source, [status(204), json200(roster())], async (page) => {
      await setInvite(page, `  ${at254.toUpperCase()}  `);
      await click(page, "#doc-share-panel .share-invite-submit");
      await waitStatus(page, "Access updated.");
      const [, write] = await calls(page);
      assertWriteTransport(write, origin, "POST", "/api/access", { doc: DOC, email: at254, role: "commenter" });
    });

    /* Every one of the seven P4-J body shapes, sent exactly. */
    const writes = [
      {
        label: "invite",
        act: async (page) => {
          await setInvite(page, NEW_EMAIL);
          await page.selectOption("#doc-share-panel .share-invite-role", "editor");
          await click(page, "#doc-share-panel .share-invite-submit");
        },
        method: "POST",
        path: "/api/access",
        body: { doc: DOC, email: NEW_EMAIL, role: "editor" },
      },
      {
        label: "grant role",
        act: async (page) => {
          await page.selectOption(`${MEMBER_ROW} .share-role`, "commenter");
          await click(page, `${MEMBER_ROW} .share-save-role`);
        },
        method: "PATCH",
        path: "/api/access",
        body: { doc: DOC, sub: "member-1", role: "commenter" },
      },
      {
        label: "revoke",
        act: (page) => click(page, `${MEMBER_ROW} .share-revoke`),
        method: "DELETE",
        path: "/api/access",
        body: { doc: DOC, sub: "member-1" },
      },
      {
        label: "invitation role",
        act: async (page) => {
          await page.selectOption(`${INVITATION_ROW} .share-role`, "viewer");
          await click(page, `${INVITATION_ROW} .share-save-role`);
        },
        method: "PATCH",
        path: "/api/access",
        body: { doc: DOC, email: INVITE_EMAIL, role: "viewer" },
      },
      {
        label: "cancel invitation",
        act: (page) => click(page, `${INVITATION_ROW} .share-cancel-invitation`),
        method: "DELETE",
        path: "/api/access",
        body: { doc: DOC, email: INVITE_EMAIL },
      },
      {
        label: "recovery resend",
        act: async (page) => {
          /* An unsaved select change must not leak into the reissue body: the
             recovery branch is the identical, same-role invite. */
          await page.selectOption(`${INVITATION_ROW} .share-role`, "editor");
          await click(page, `${INVITATION_ROW} .share-resend`);
        },
        method: "POST",
        path: "/api/access",
        body: { doc: DOC, email: INVITE_EMAIL, role: "commenter" },
      },
      {
        label: "organization default",
        act: async (page) => {
          await page.selectOption("#doc-share-panel .share-default-control", "none");
          await click(page, "#doc-share-panel .share-default-save");
        },
        method: "PATCH",
        path: "/api/access",
        body: { doc: DOC, orgDefault: "none" },
      },
    ];
    for (const write of writes) {
      await ownerPanel(browser, origin, source, [status(204), json200(roster())], async (page) => {
        await write.act(page);
        await waitStatus(page, "Access updated.");
        const record = await calls(page);
        assert.equal(record.length, 3, `${write.label} must send one write and exactly one refresh`);
        assertWriteTransport(record[1], origin, write.method, write.path, write.body);
        assertReadTransport(record[2], origin);
        const state = await probe(page);
        assert.equal(state.bodyReads, 0, "a mutation response body is never read");
        assert.equal(state.busy, null, "aria-busy is cleared once the refresh settles");
        assert.equal(await activeId(page), "doc-share-title", "focus lands on the panel heading");
      });
    }

    /* Save buttons are enabled only by an actual change. */
    await ownerPanel(browser, origin, source, [], async (page) => {
      const before = await page.evaluate(() => ({
        role: document.querySelector("#doc-share-panel .share-members li:nth-of-type(2) .share-save-role").disabled,
        org: document.querySelector("#doc-share-panel .share-default-save").disabled,
      }));
      assert.deepEqual(before, { role: true, org: true });
      await page.selectOption(`${MEMBER_ROW} .share-role`, "viewer");
      await page.selectOption("#doc-share-panel .share-default-control", "viewer");
      const changed = await page.evaluate(() => ({
        role: document.querySelector("#doc-share-panel .share-members li:nth-of-type(2) .share-save-role").disabled,
        org: document.querySelector("#doc-share-panel .share-default-save").disabled,
      }));
      assert.deepEqual(changed, { role: false, org: false });
      await page.selectOption(`${MEMBER_ROW} .share-role`, "editor");
      await page.selectOption("#doc-share-panel .share-default-control", "commenter");
      const restored = await page.evaluate(() => ({
        role: document.querySelector("#doc-share-panel .share-members li:nth-of-type(2) .share-save-role").disabled,
        org: document.querySelector("#doc-share-panel .share-default-save").disabled,
      }));
      assert.deepEqual(restored, { role: true, org: true });
      assert.equal((await calls(page)).length, 1);
    });

    /* Transfer is two-step, singular, and writes nothing until confirmed. */
    await ownerPanel(browser, origin, source, [], async (page) => {
      await click(page, `${MEMBER_ROW} .share-transfer`);
      let state = await probe(page);
      assert.equal(state.confirmations, 1);
      assert.equal(state.confirmText, TRANSFER_WARNING);
      assert.equal((await calls(page)).length, 1, "opening the confirmation sends nothing");
      assert.equal(await page.evaluate(() => document.activeElement.className.includes("share-transfer-yes")), true);
      const rowDisabled = await page.evaluate((selector) =>
        Array.from(document.querySelectorAll(`${selector} .share-row-controls .share-op`)).every((node) => node.disabled),
      MEMBER_ROW);
      assert.equal(rowDisabled, true, "the initiating row's ordinary controls are disabled");

      /* Opening another confirmation first cancels and restores this one. */
      await click(page, "#doc-share-panel .share-members li:nth-of-type(3) .share-transfer");
      state = await probe(page);
      assert.equal(state.confirmations, 1, "only one confirmation may exist");
      /* Restoring a row is not the same as enabling it: the Save button an
         unchanged select left disabled must stay disabled. */
      const restored = await page.evaluate((selector) => ({
        select: document.querySelector(`${selector} .share-role`).disabled,
        save: document.querySelector(`${selector} .share-save-role`).disabled,
        revoke: document.querySelector(`${selector} .share-revoke`).disabled,
        transfer: document.querySelector(`${selector} .share-transfer`).disabled,
      }), MEMBER_ROW);
      assert.deepEqual(restored, { select: false, save: true, revoke: false, transfer: false },
        "the replaced row is restored to the state the roster justified");

      await click(page, "#doc-share-panel .share-transfer-no");
      state = await probe(page);
      assert.equal(state.confirmations, 0);
      assert.equal((await calls(page)).length, 1, "cancelling writes nothing");
      assert.equal(await page.evaluate(() =>
        document.activeElement.className.includes("share-transfer")), true, "focus returns to the initiator");
      assert.equal(state.modals, 0, "no native modal is ever used");
    });

    /* Closing clears the confirmation and writes nothing. */
    await ownerPanel(browser, origin, source, [json200(roster())], async (page) => {
      await click(page, `${MEMBER_ROW} .share-transfer`);
      await page.keyboard.press("Escape");
      assert.equal((await probe(page)).confirmations, 0);
      assert.equal((await calls(page)).length, 1);
    });

    /* A committed transfer gives up cached authority before it reads. */
    for (const [label, mutation] of [
      ["204", status(204)],
      ["409", status(409)],
      ["500", status(500)],
      ["network", { kind: "reject" }],
      ["redirect", { status: 204, poison: true, redirected: true }],
    ]) {
      const expected = label === "204" ? "Access updated." : "Access change could not be completed.";
      await ownerPanel(browser, origin, source, [mutation, json200(session("editor")), json200(roster())], async (page) => {
        await click(page, `${MEMBER_ROW} .share-transfer`);
        await click(page, "#doc-share-panel .share-transfer-yes");
        await waitStatus(page, expected);
        const record = await calls(page);
        assert.equal(record.length, 4, `transfer ${label} must write, reconcile, then read`);
        assertWriteTransport(record[1], origin, "POST", "/api/access/transfer", { doc: DOC, sub: "member-1" });
        assert.equal(record[2].url, `${origin}/api/session?doc=${DOC}`);
        assert.equal(record[2].method, "GET");
        assert.equal(record[2].mode, "same-origin");
        assert.equal(record[2].credentials, "same-origin");
        assert.equal(record[2].cache, "no-store");
        assert.equal(record[2].redirect, "error");
        assert.deepEqual(record[2].headers, { Accept: "application/json" });
        assertReadTransport(record[3], origin);
        const state = await probe(page);
        assert.equal(state.hasButton, true, "a validated editor keeps the read-only Share surface");
        assert.equal(state.ops, 0, "no owner control survives a transfer");
        assert.equal(state.confirmations, 0);
        assert.equal(state.members.length, 3);
      });
    }

    /* A write-time 403 is the same reconciliation, and a fresh owner session
       is the only thing that may restore owner controls. */
    for (const [refreshed, ops] of [[session("editor"), 0], [session("owner"), 17]]) {
      await ownerPanel(browser, origin, source, [status(403), json200(refreshed), json200(roster())], async (page) => {
        await click(page, `${MEMBER_ROW} .share-revoke`);
        await waitStatus(page, "Your access changed.");
        const record = await calls(page);
        assert.equal(record.length, 4);
        assert.equal(record[2].url, `${origin}/api/session?doc=${DOC}`);
        const state = await probe(page);
        assert.equal(state.ops, ops, "owner controls follow the refreshed session only");
        assert.equal(state.hasButton, true);
      });
    }

    /* Any unusable session after that reconciliation removes everything. */
    for (const bad of [
      status(401),
      status(403),
      status(500),
      { kind: "reject" },
      json200(session("commenter", { canShare: false, canSeeMembers: false })),
      json200(session("owner", { shared: false })),
      json200(session("owner", { canSeeMembers: false })),
      json200({ doc: DOC, role: "owner" }),
      { status: 200, contentType: "text/plain", json: session("owner") },
    ]) {
      await ownerPanel(browser, origin, source, [status(403), bad], async (page) => {
        await click(page, `${MEMBER_ROW} .share-revoke`);
        await page.waitForFunction(() => document.querySelector("#doc-share-button") === null,
          undefined, { timeout: 10_000 });
        assert.equal((await calls(page)).length, 3, "no roster read follows an unusable session");
      });
    }

    /* A write 401 removes the feature with no refresh of any kind. */
    await ownerPanel(browser, origin, source, [status(401)], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await page.waitForFunction(() => document.querySelector("#doc-share-button") === null,
        undefined, { timeout: 10_000 });
      const state = await probe(page);
      assert.equal(state.hasPanel, false);
      assert.equal((await calls(page)).length, 2, "401 starts no session or roster read");
    });

    /* Definite client failures and ambiguous failures both refresh the roster
       once, and neither one touches the session. */
    for (const [code, message] of [
      [400, "Access change was not accepted."],
      [404, "Access change was not accepted."],
      [409, "Access change was not accepted."],
      [413, "Access change was not accepted."],
      [415, "Access change was not accepted."],
      [429, "Access change was not accepted."],
      [500, "Access change could not be completed."],
      [503, "Access change could not be completed."],
      [418, "Access change could not be completed."],
    ]) {
      await ownerPanel(browser, origin, source, [status(code), json200(roster())], async (page) => {
        await click(page, `${MEMBER_ROW} .share-revoke`);
        await waitStatus(page, message);
        const record = await calls(page);
        assert.equal(record.length, 3, `status ${code} must refresh exactly once`);
        assert.equal(record.filter((call) => call.url.includes("/api/session")).length, 0);
        assert.equal((await probe(page)).ops, 17, "a non-transfer failure keeps owner controls");
      });
    }

    /* One active mutation: everything else is refused, not queued. */
    await ownerPanel(browser, origin, source, [HOLD, json200(roster())], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await waitHold(page);
      let state = await probe(page);
      assert.equal(state.busy, "true");
      assert.equal(state.status, "Updating access…");
      assert.equal(state.ops, state.disabled, "every owner control is disabled while a write is active");
      assert.equal(state.closeDisabled, false, "the close button is never disabled");
      await page.evaluate((selector) => {
        /* A forged enabled button and a dispatched click must still be refused. */
        const node = document.querySelector(`${selector} .share-revoke`);
        node.disabled = false;
        node.click();
        document.querySelector("#doc-share-panel .share-invite-submit").disabled = false;
        document.querySelector("#doc-share-panel .share-invite").dispatchEvent(
          new Event("submit", { cancelable: true, bubbles: true }));
      }, MEMBER_ROW);
      assert.equal((await calls(page)).length, 2, "a second activation is refused without queueing");
      await page.evaluate(() => window.__p4l.release({ status: 204, poison: true }));
      await waitStatus(page, "Access updated.");
      state = await probe(page);
      assert.equal(state.busy, null);
      assert.equal((await calls(page)).length, 3);
    });

    /* The 15-second write deadline aborts, reports, and refreshes once. */
    await ownerPanel(browser, origin, source, [HOLD, json200(roster())], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await waitHold(page);
      await waitStatus(page, "Access change could not be completed.");
      const record = await calls(page);
      assert.equal(record[1].aborted, true);
      assert.equal(record.length, 3);
    });

    /* A close during a write aborts it, says nothing, and reads nothing. */
    await ownerPanel(browser, origin, source, [HOLD], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await waitHold(page);
      assert.equal((await calls(page)).length, 2);
      await click(page, "#doc-share-panel .share-close");
      const record = await calls(page);
      assert.equal(record[1].aborted, true);
      assert.equal(record.length, 2, "a close-caused abort starts no follow-up read");
      const state = await probe(page);
      assert.equal(state.hidden, true);
      assert.equal(state.busy, null);
      assert.equal(await activeId(page), "doc-share-button");
    });

    /* Closing during a transfer marks authority unknown: reopening must ask
       the server for the session before it renders anything. */
    await ownerPanel(browser, origin, source, [HOLD], async (page) => {
      await click(page, `${MEMBER_ROW} .share-transfer`);
      await click(page, "#doc-share-panel .share-transfer-yes");
      await waitHold(page);
      await click(page, "#doc-share-panel .share-close");
      assert.equal((await probe(page)).ops, 0, "closing mid-transfer gives up owner controls");
      await push(page, [json200(session("editor")), json200(roster())]);
      await click(page, "#doc-share-button");
      await waitCalls(page, 4);
      const record = await calls(page);
      assert.equal(record[2].url, `${origin}/api/session?doc=${DOC}`);
      assertReadTransport(record[3], origin);
      assert.equal((await probe(page)).ops, 0);
    });

    /* A read failure outranks and replaces the retained mutation result. */
    await ownerPanel(browser, origin, source, [status(204), { status: 500, poison: true }], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await waitStatus(page, "Access list could not be refreshed.");
      assert.equal((await probe(page)).members.length, 3, "the last validated roster is retained");
    });

    /* Privacy: no address, sub or role reaches an attribute, a global, a log,
       storage, a cookie or the live status. */
    await ownerPanel(browser, origin, source, [status(204), json200(roster())], async (page) => {
      await click(page, `${MEMBER_ROW} .share-revoke`);
      await waitStatus(page, "Access updated.");
      const state = await probe(page);
      for (const secret of [OWNER_EMAIL, EDITOR_EMAIL, VIEWER_EMAIL, INVITE_EMAIL, "member-1", "owner-1"]) {
        assert.equal(state.attributeText.includes(secret), false, `${secret} reached an attribute`);
      }
      assert.equal(state.status, "Access updated.");
      assert.equal(state.globals, "");
      assert.equal(state.stored, 0);
      assert.equal(state.logged, 0);
      assert.equal(state.modals, 0);
      assert.equal(state.cookie, "");
      assert.equal(state.dataSession, null, "the reconciliation never rewrites data-session");
    });

    /* The member cap is the control-group cap. */
    const many = roster({
      members: [
        { sub: "owner-1", email: OWNER_EMAIL, name: "", role: "owner" },
        ...Array.from({ length: 50 }, (unused, index) => ({
          sub: `member-${String(index).padStart(2, "0")}`,
          email: `person-${String(index).padStart(2, "0")}@example.com`,
          name: "",
          role: "viewer",
        })),
      ],
      invitations: [],
    });
    await scenario(browser, origin, source, {
      detail: session("owner"),
      queue: [json200(many)],
    }, async (page) => {
      await click(page, "#doc-share-button");
      await waitCalls(page, 1);
      await page.waitForFunction(() => document.querySelector("#doc-share-panel .share-invite") !== null,
        undefined, { timeout: 10_000 });
      assert.equal((await probe(page)).rowControls, 50);
    });

    /* The production stylesheet carries the states the controls depend on. */
    for (const needle of [
      ".share-op", ".share-op:focus-visible", ".share-op:disabled", ".share-op-label",
      ".share-invite", ".share-default-form", ".share-row-controls", ".share-transfer-confirm",
      '.share-pop[aria-busy="true"]', "@media (forced-colors: active)",
      "@media (prefers-reduced-motion: reduce)", "@media print", "@media (max-width: 24rem)",
    ]) {
      assert.ok(css.includes(needle), `share.css is missing ${needle}`);
    }
    for (const selector of css.replace(/\/\*[\s\S]*?\*\//g, "").split("{").slice(0, -1)) {
      const head = selector.split("}").pop().trim();
      if (head === "" || head.startsWith("@")) continue;
      for (const part of head.split(",")) {
        const trimmed = part.trim();
        if (trimmed === "") continue;
        assert.ok(trimmed.includes(".share-"), `share.css escaped its scope with: ${trimmed}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

function worker(run) {
  run().then(() => process.exit(0), (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

const MODE = process.argv[2];
if (MODE === "--p3i") worker(p3iMatrix);
else if (MODE === "--p4l") worker(p4lMatrix);
else if (MODE === "contract") worker(supervise);
else fail(`P4-L takes exactly one argument, "contract", not ${JSON.stringify(MODE)}`);
