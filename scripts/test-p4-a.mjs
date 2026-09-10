#!/usr/bin/env node
/* P4-A regression runner — the permanent entry point for the comment write
   path.  It evaluates the real `templates/base/comments.js` against closed,
   invented selection, session, fetch and DOM fixtures; nothing here reads a
   credential, a remote service, or any document in this repository.

   The process shape is the point as much as the assertions are.  Every matrix
   runs in a direct child process inside a fresh mode-0700 temporary root, with
   its own deadline and a capped output buffer.  The supervisor forwards HUP,
   INT and TERM to the child's own process group, escalates TERM to KILL,
   reaps the child, proves the group is gone, and removes the guarded root
   before it reports success.  Its first assertions are about itself: three
   signal probes that must exit 129, 130 and 143, and a deadline probe that
   must be reported as 124.

   Both matrices drive a real engine because the write path is defined in
   terms of Selection, Range and focus, and a hand-written DOM would only be
   asserting against my own approximation rather than the browser's.  The
   runtime matrix stubs `fetch`, so every route, body, header, deadline and
   failure mode is exact and deterministic; the rendered matrix serves an
   invented loopback document, uses a real pointer and keyboard, and checks
   that the file: mode does nothing at all.

   Run it with no arguments:

     node scripts/test-p4-a.mjs
*/

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardedTempRoot,
  installSignalCleanup,
  removeTempRoots,
  sweepStaleTempRoots,
} from "./lib/temp-roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const COMMENTS = join(ROOT, "templates", "base", "comments.js");

const PLAYWRIGHT = "playwright@1.55.0";
const WORKER_DEADLINE_MS = 180_000;
/* The one-off dependency fetch is not a matrix and is not what the 180-second
   worker budget is for; it gets its own, and its output is only ever shown
   when it fails. */
const INSTALL_DEADLINE_MS = 900_000;
const PROBE_DEADLINE_MS = 20_000;
const HANG_DEADLINE_MS = 2_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 65_536;

const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

const DOC_ID = "4b7d2a";
const HEAD = "7aaca51";
const SUB = "reader-1";
const OTHER_SUB = "reader-2";
const BLOCK_TAGS = ["p", "li", "blockquote", "h2", "h3", "pre", "td", "th", "dd", "dt", "figcaption"];

/* ------------------------------------------------------------ fixtures */

const LONG = "abcdefghij".repeat(120);

/* One invented document.  Every identifier, name and address below is made up
   for this fixture and matches nothing outside it. */
function fixtureDocument({ head = HEAD, heads = 1, dupe = false, section = "rollout", docId = DOC_ID } = {}) {
  const one = head === null
    ? '<script type="application/json" id="doc-history">{}<\/script>'
    : `<script type="application/json" id="doc-history" data-head="${head}">{}<\/script>`;
  const history = Array.from({ length: heads }, () => one).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="doc-id" content="${docId}">
<title>Invented fixture document</title>
</head>
<body>
<div class="head-top"><h1>Invented fixture document</h1><button type="button" class="share-btn">Share</button></div>
${history}
<main>
<section id="architecture">
<p class="sec-label">Architecture</p>
<p data-aid="a31b7c9d2">The cache key covers every input to the render.</p>
<p data-aid="a44f0e1b7">A second <strong>paragraph with <code>nested</code> text</strong> nodes.</p>
<p data-aid="a5c1d2e3f">${LONG}</p>
<p data-aid="a6a7b8c9d">ab\u{1F600}cd follows two letters.</p>
</section>
<section id="${section}">
<p class="sec-label">Rollout</p>
<p data-aid="a70f1e2d3">Rollout happens in two stages.</p>
${dupe ? '<p data-aid="a31b7c9d2">A second paragraph carrying an already used aid.</p>' : ""}
</section>
</main>
</body>
</html>
`;
}

/* The P1-B and P1-D surfaces the comments client consumes.
   `window.doc` is initialised exactly as P1-B's bootstrap does it
   (`templates/base/layout.html`): both shared surfaces start as literal
   `null`. That is not decoration -- P4-Q's client refuses to install over a
   rail or panel it does not own, and tests `!== null`, so a fixture that
   leaves them `undefined` models a page P1-B never serves and the module
   returns before any UI, listener or request. `scripts/test-p4-q.mjs` models
   the same bootstrap.
   `norm` collapses every whitespace run to one space and trims the ends,
   which is the only property of P1-D the client depends on. */
const ANCHOR_SHIM = `
window.doc = { rail: null, panel: null };
window.doc.anchor = {
  BLOCK: ${JSON.stringify(BLOCK_TAGS)},
  norm: function (value) { return String(value).replace(/\\s+/g, " ").replace(/^ | $/g, ""); },
};
`;

const TEST_HELPERS = `
window.__t = {
  textNodes: function (selector) {
    const root = document.querySelector(selector);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const out = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) out.push(node);
    return out;
  },
  select: function (a, b) {
    const range = document.createRange();
    range.setStart(this.textNodes(a.sel)[a.node || 0], a.at);
    range.setEnd(this.textNodes(b.sel)[b.node || 0], b.at);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return range.toString();
  },
  collapse: function (a) {
    const selection = document.getSelection();
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(this.textNodes(a.sel)[a.node || 0], a.at);
    range.collapse(true);
    selection.addRange(range);
  },
  clear: function () { document.getSelection().removeAllRanges(); },
  mouseup: function () { document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); },
  key: function (init) { document.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init))); },
  session: function (patch) {
    const detail = Object.assign({
      sub: ${JSON.stringify(SUB)},
      email: "reader@invented.example",
      name: "Invented Reader",
      canComment: true,
      canEdit: false,
      doc: ${JSON.stringify(DOC_ID)},
      role: "owner",
      shared: false,
      canSuggest: false,
      canAccept: false,
      canShare: false,
      canSeeMembers: false,
    }, patch || {});
    Object.freeze(detail);
    document.dispatchEvent(new CustomEvent("session", { detail: detail }));
  },
  tooltip: function () {
    const hosts = [...document.body.children].filter((node) => node.style && node.style.position === "fixed");
    if (hosts.length === 0) return null;
    const host = hosts[hosts.length - 1];
    return { text: host.textContent, role: host.getAttribute("role"), button: host.querySelector("button") !== null };
  },
  statusText: function () {
    const node = document.getElementById("doc-comments-status");
    return node === null ? null : node.textContent;
  },
  card: function (id) { return document.querySelector('article[data-thread-id="' + id + '"]'); },
  active: function () {
    const node = document.activeElement;
    if (node === null) return null;
    return { tag: node.localName, id: node.id, text: (node.textContent || "").slice(0, 60) };
  },
};
`;

const FETCH_STUB = `
window.__calls = [];
window.__plans = [];
window.__list = { threads: [], nextCursor: null };
window.__aborted = null;
window.fetch = function (input, init) {
  const options = init || {};
  window.__calls.push({
    url: String(input),
    method: options.method,
    mode: options.mode,
    credentials: options.credentials,
    cache: options.cache,
    redirect: options.redirect,
    headers: Object.assign({}, options.headers),
    body: typeof options.body === "string" ? options.body : null,
    signal: options.signal instanceof AbortSignal,
  });
  const plan = window.__plans.length > 0 ? window.__plans.shift() : { mode: "list" };
  if (plan.mode === "reject") return Promise.reject(new TypeError("invented network failure"));
  if (plan.mode === "hang") {
    const started = performance.now();
    return new Promise(function (resolve, reject) {
      options.signal.addEventListener("abort", function () {
        window.__aborted = performance.now() - started;
        reject(new DOMException("invented abort", "AbortError"));
      });
    });
  }
  const status = plan.mode === "list" ? 200 : plan.status;
  const text = plan.mode === "list" ? JSON.stringify(window.__list) : plan.json;
  return Promise.resolve({
    status: status,
    json: function () {
      if (plan.malformed === true) return Promise.reject(new SyntaxError("invented malformed body"));
      return Promise.resolve(JSON.parse(text));
    },
  });
};
`;

function fixturePage(scripts, options) {
  const html = fixtureDocument(options);
  const source = readFileSync(COMMENTS, "utf8");
  const head = scripts.map((code) => `<script>${code}<\/script>`).join("\n");
  return html.replace("</body>", `${head}
<script type="module">${source}<\/script>
<script type="module">window.__installed = true;<\/script>
</body>`);
}

/* ---------------------------------------------------------- thread data */

function actor(sub = SUB, name = "Invented Reader") {
  return { sub, name, email: "reader@invented.example" };
}

function fixtureComment(suffix, body, author = actor(), createdAt = "2026-01-02T03:04:05.000Z") {
  return { id: `c_m8x2k1_${suffix}`, body, author, createdAt, editedAt: null };
}

function fixtureThread(overrides = {}) {
  const author = overrides.author || actor();
  const base = {
    v: 1,
    id: "t_m8x2k1_4f7a9c31",
    docId: DOC_ID,
    kind: "comment",
    status: "open",
    section: "architecture",
    anchor: { block: "a31b7c9d2", exact: "cache key", prefix: "The ", suffix: " covers every input", start: 4 },
    title: null,
    docVersion: HEAD,
    createdAt: "2026-01-02T03:04:05.000Z",
    author,
    resolvedAt: null,
    resolvedBy: null,
    comments: [fixtureComment("4f7a9c31", "Could we name the invalidation case?", author)],
  };
  return Object.assign(base, overrides);
}

/* ========================================================= supervision */

class Capture {
  constructor() {
    this.length = 0;
    this.parts = [];
  }

  push(chunk) {
    if (this.length >= OUTPUT_LIMIT) return;
    const text = chunk.toString("utf8");
    const room = OUTPUT_LIMIT - this.length;
    const slice = text.length > room ? text.slice(0, room) : text;
    this.length += slice.length;
    this.parts.push(slice);
  }

  toString() {
    return this.parts.join("");
  }
}

/* One direct child in its own process group, with a hard deadline, a capped
   buffer, TERM escalated to KILL, and 124 reported for a child that had to be
   stopped rather than one that chose its own exit. */
function runChild(args, { deadline, cwd = ROOT, env = {}, onLine = null } = {}) {
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

    let pending = "";
    child.stdout.on("data", (chunk) => {
      out.push(chunk);
      if (onLine === null) return;
      pending += chunk.toString("utf8");
      let at = pending.indexOf("\n");
      while (at !== -1) {
        onLine(pending.slice(0, at), stop);
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => err.push(chunk));

    child.on("error", (error) => {
      err.push(Buffer.from(`spawn failed: ${error.message}\n`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      for (const [name, handler] of forwarded) process.removeListener(name, handler);
      const resolved = expired
        ? 124
        : code !== null ? code : 128 + (SIGNALS[signal] || 0);
      /* Reaped: the group must be gone, or something outlived its supervisor. */
      let orphaned = false;
      try {
        process.kill(-child.pid, 0);
        orphaned = true;
      } catch (error) {
        orphaned = false;
      }
      resolve({ code: resolved, signal, stdout: out.toString(), stderr: err.toString(), orphaned });
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

async function proveSupervision(self) {
  for (const [name, number] of Object.entries(SIGNALS)) {
    let stopper = null;
    const result = await runChild([self, "--probe-signal"], {
      deadline: PROBE_DEADLINE_MS,
      onLine: (line, stop) => {
        if (line === "ready" && stopper === null) {
          stopper = stop;
          stop(name);
        }
      },
    });
    if (result.code !== 128 + number) fail(`P4-A ${name} probe expected ${128 + number}`, result);
    if (result.orphaned) fail(`P4-A ${name} probe left its process group behind`, result);
  }

  const hung = await runChild([self, "--probe-hang"], { deadline: HANG_DEADLINE_MS });
  if (hung.code !== 124) fail("P4-A deadline probe expected 124", hung);
  if (hung.orphaned) fail("P4-A deadline probe left its process group behind", hung);
}

async function installPlaywright(root) {
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "p4a-fixture",
    private: true,
    version: "0.0.0",
    type: "module",
  }) + "\n", { mode: 0o600 });

  const npm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const install = await runChild([npm, "install", "--no-save", "--no-audit", "--no-fund", "--silent", PLAYWRIGHT], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { npm_config_yes: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  if (install.code !== 0) fail(`P4-A could not install ${PLAYWRIGHT}`, install);

  const browsers = await runChild([join(root, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
  });
  if (browsers.code !== 0) fail("P4-A could not install the pinned browser", browsers);
}

async function supervise(self) {
  await proveSupervision(self);
  process.stdout.write("PASS  P4-A supervisor signals and deadline\n");

  sweepStaleTempRoots(["p4a-"]);
  const root = guardedTempRoot("p4a-");
  const roots = [root];
  const uninstallSignalCleanup = installSignalCleanup(roots, { exitAfterCleanup: false });
  try {
    await installPlaywright(root);
    const env = { P4A_ROOT: root, PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") };
    for (const [flag, line] of [
      ["--runtime", "PASS  P4-A selection, write, model, and focus matrix"],
      ["--browser", "PASS  P4-A rendered comment write behavior"],
    ]) {
      const result = await runChild([self, flag], { deadline: WORKER_DEADLINE_MS, env });
      if (result.code !== 0) fail(`P4-A worker ${flag}`, result);
      if (result.orphaned) fail(`P4-A worker ${flag} left its process group behind`, result);
      process.stdout.write(`${line}\n`);
    }
  } finally {
    uninstallSignalCleanup();
    removeTempRoots(roots);
  }
  process.stdout.write("PASS  P4-A fixture cleaned\n");
}

function probeSignal() {
  for (const [name, number] of Object.entries(SIGNALS)) {
    process.on(name, () => process.exit(128 + number));
  }
  process.stdout.write("ready\n");
  setInterval(() => {}, 1000);
}

function probeHang() {
  setInterval(() => {}, 1000);
}

/* ============================================================ workers */

/* Both matrices need a real origin: the client builds every endpoint from
   `location.href` and refuses anything cross-origin, and the module does not
   install at all outside http(s).  `page.setContent` would leave us on
   about:blank, so even the stubbed-fetch matrix is served over loopback. */
function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
      });
    });
  });
}

async function loadChromium() {
  const root = process.env.P4A_ROOT;
  if (typeof root !== "string" || root === "") throw new Error("P4A_ROOT is not set");
  const entry = pathToFileURL(join(root, "node_modules", "playwright", "index.js")).href;
  const module = await import(entry);
  const api = module.chromium !== undefined ? module : module.default;
  return api.chromium;
}

function html(response, body) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

/* -------------------------------------------------- runtime matrix */

/* One page per scenario. `fetch` is stubbed, so every route, header, body,
   deadline and failure mode below is exact rather than negotiated. */
async function withPage(browser, host, options, run) {
  host.body = fixturePage([ANCHOR_SHIM, TEST_HELPERS, FETCH_STUB], options);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${host.origin}/`, { waitUntil: "load" });
    await page.waitForFunction("window.__installed === true");
    await run(page);
  } finally {
    await page.close();
  }
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join(" | ")}`);
}

/* Reveal the session and wait for P3-C's first list to settle. */
async function activate(page, { threads = [], patch = undefined, none = false } = {}) {
  await page.evaluate(({ threads, patch, none }) => {
    window.__list = { threads, nextCursor: null };
    if (!none) window.__t.session(patch);
  }, { threads, patch, none });
  if (none) return;
  /* A bare 30-second timeout here would say nothing about why the client
     never committed, so report the page's own view of itself instead. */
  try {
    await page.waitForFunction(() => {
      const node = document.getElementById("doc-comments-status");
      return node !== null && /threads? loaded\./.test(node.textContent);
    }, null, { timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      installed: window.__installed === true,
      seam: typeof (window.doc && window.doc.comments),
      helpers: typeof window.__t,
      stubbed: typeof window.__calls,
      calls: (window.__calls || []).map((call) => `${call.method} ${call.url}`),
      status: (document.getElementById("doc-comments-status") || {}).textContent || null,
      toggle: document.getElementById("doc-comments-toggle") !== null,
      aids: [...document.querySelectorAll("[data-aid]")].map((node) => `${node.localName}:${node.getAttribute("data-aid")}`),
    }));
    throw new Error(`the client never committed a list: ${JSON.stringify(state)}`);
  }
}

const writesOf = (page) => page.evaluate(() => window.__calls.filter((call) => call.method !== undefined && call.method !== "GET"));

/* The kind filter group is addressed by visible label rather than by child
   index; see the ordering assertion in the read-behaviour scenario. */
const KIND_GROUP = '#doc-comments-filters [aria-label="Kind"]';

const kindLabels = (page) => page.evaluate((selector) =>
  [...document.querySelector(selector).querySelectorAll("button")].map((button) => button.textContent), KIND_GROUP);

const clickKind = (page, label) => page.evaluate(([selector, label]) => {
  const group = document.querySelector(selector);
  if (group === null) throw new Error("the kind filter group is absent");
  const button = [...group.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`no kind filter is labelled ${label}`);
  button.click();
}, [KIND_GROUP, label]);

async function openPanel(page) {
  await page.click("#doc-comments-toggle");
  await page.waitForSelector("#doc-comments-panel:not([hidden])");
}

/* Drive the debounced `selectionchange` path rather than the immediate
   `mouseup` one, so the 250 ms trailing timer is what is under test. */
async function selectAndSettle(page, a, b) {
  await page.evaluate(([a, b]) => window.__t.select(a, b), [a, b]);
  await page.evaluate(() => window.__t.mouseup());
  await page.waitForTimeout(SELECTION_SETTLE_MS);
}

/* Comfortably past the client's 250 ms trailing selection timer. */
const SELECTION_SETTLE_MS = 400;

/* The transient tooltip host is the one element this module positions itself,
   so `position: fixed` on a direct child of the body identifies it.  The
   description is spelled out once and quoted in every failure, because a
   selector that resolves to nothing is the failure these helpers exist to
   report by name. */
const TOOLTIP_HOST = "a direct child of <body> carrying style.position === 'fixed'";

/* The host is not stable the moment it first appears.  `selectionchange` is
   dispatched from a queued task, so it can land *after* the `mouseup` that
   already showed the tooltip; the client's own handler then removes the host
   and schedules a 250 ms trailing rebuild.  Any wait that is followed by a
   separate measuring round trip can therefore observe the first, doomed host
   and measure the gap after it.  Locally the queued task always won the race
   and the gap never opened; in GitHub Actions it did, and the measurement read
   `undefined.getBoundingClientRect()` (#124).

   What closes that gap is waiting and acting inside *one* page function, which
   is what every helper below does -- not any particular settling delay.  A
   `waitForTimeout` before one of these calls only keeps the common case out of
   the poll; the poll is what makes it correct, so tuning the delay is not how
   to fix a failure here. */

/* The page's own account of itself, for a failure that has to explain why no
   tooltip was there rather than throw a TypeError from inside the browser.
   `hostRect` separates "never appeared" from "appeared but never laid out". */
const tooltipState = (page) => page.evaluate(() => {
  const hosts = [...document.body.children].filter((node) => node.style && node.style.position === "fixed");
  const host = hosts[hosts.length - 1];
  const rect = host === undefined ? null : host.getBoundingClientRect();
  return {
    fixedChildren: hosts.length,
    hostRect: rect === null ? null : { w: rect.width, h: rect.height, x: rect.left, y: rect.top },
    hostButton: host === undefined ? null : host.querySelector("button") !== null,
    panel: document.getElementById("doc-comments-panel") !== null,
    panelHidden: (document.getElementById("doc-comments-panel") || {}).hidden === true,
    draftOpen: document.querySelector(".doc-comments-draft") !== null,
    selection: document.getSelection().toString(),
    status: (document.getElementById("doc-comments-status") || {}).textContent || null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
});

/* A page that has gone away cannot describe itself, and that must not become
   the error the caller sees instead of the one it was already reporting. */
const describe = (page) => tooltipState(page).then(JSON.stringify, (error) => `unavailable: ${String(error).split("\n")[0]}`);

const firstLine = (error) => String(error && error.message ? error.message : error).split("\n")[0];

/* A predicate that throws rejects immediately, so "within 5000 ms" would be a
   lie about a failure that took no time at all -- and the thing it names would
   be the wrong cause. Say which of the two happened. */
const waited = (error, timeout) =>
  (error && error.name === "TimeoutError" ? `within ${timeout} ms` : "and the page function threw");

/* Poll until a host exists *and* has been laid out, then hand back everything
   a caller could want to assert, measured in the same turn that found it. */
async function tooltipGeometry(page, label, { timeout = 5000 } = {}) {
  let handle;
  try {
    handle = await page.waitForFunction(() => {
      const hosts = [...document.body.children].filter((node) => node.style && node.style.position === "fixed");
      const host = hosts[hosts.length - 1];
      if (host === undefined) return null;
      const rect = host.getBoundingClientRect();
      /* A host that is present but not yet measurable is not a result; the
         poll simply has not finished waiting for layout. */
      if (rect.width === 0 || rect.height === 0) return null;
      return {
        text: host.textContent,
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        inner: { w: window.innerWidth, h: window.innerHeight },
      };
    }, null, { timeout });
  } catch (error) {
    /* A host that was there the whole time and never gained a size is a
       different defect from one that never appeared, and saying "no measurable
       tooltip host" for both would send the reader looking for the wrong one. */
    const state = await tooltipState(page).catch((failure) => ({ unavailable: firstLine(failure) }));
    const present = state.hostRect !== null && state.hostRect !== undefined;
    const what = present
      ? `the tooltip host (${TOOLTIP_HOST}) is present but was never laid out`
      : `no tooltip host (${TOOLTIP_HOST}) appeared`;
    throw new Error(`${label}: ${what} ${waited(error, timeout)} [${firstLine(error)}]: ${JSON.stringify(state)}`);
  }
  return handle.jsonValue();
}

/* Finding the button and pressing it are one page function on purpose: a
   rebuilt host between the two would leave the click on a detached node. */
async function clickTooltipButton(page, label, { timeout = 5000 } = {}) {
  try {
    await page.waitForFunction(() => {
      const hosts = [...document.body.children].filter((node) => node.style && node.style.position === "fixed");
      const host = hosts[hosts.length - 1];
      const button = host === undefined ? null : host.querySelector("button");
      if (button === null) return false;
      button.click();
      return true;
    }, null, { timeout });
  } catch (error) {
    throw new Error(`${label}: no tooltip button to press (${TOOLTIP_HOST} > button) ${waited(error, timeout)} [${firstLine(error)}]: ${await describe(page)}`);
  }
}

async function openTooltipDraft(page, label = "tooltip draft") {
  await tooltipGeometry(page, label);
  await clickTooltipButton(page, label);
  await page.waitForSelector("#doc-comments-draft-body");
}

/* Open the draft the tooltip offers, submit it against a planned failure, and
   hand back the anchor the client put on the wire.  The response is refused on
   purpose: the request body is the subject, and the model must stay untouched. */
async function draftAnchor(page) {
  await openTooltipDraft(page);
  await page.evaluate(() => { window.__plans.push({ mode: "json", status: 500, json: "{}" }); });
  await page.fill("#doc-comments-draft-body", "Invented draft body.");
  await page.click(".doc-comments-draft button[type=submit]");
  await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));
  const request = await page.evaluate(() => {
    const call = window.__calls.filter((item) => item.method === "POST").pop();
    window.__calls.length = 0;
    return JSON.parse(call.body);
  });
  await page.press("#doc-comments-draft-body", "Escape");
  await page.waitForFunction(() => document.querySelector(".doc-comments-draft") === null);
  return request.anchor;
}

async function runtimeMatrix() {
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const host = { body: "", origin: "" };
  const server = await serve((request, response) => html(response, host.body));
  host.origin = server.origin;

  const P1 = { sel: 'p[data-aid="a31b7c9d2"]' };
  const NESTED = { sel: 'p[data-aid="a44f0e1b7"]' };
  const LONGP = { sel: 'p[data-aid="a5c1d2e3f"]' };
  const EMOJI = { sel: 'p[data-aid="a6a7b8c9d"]' };
  const P2 = { sel: 'p[data-aid="a70f1e2d3"]' };

  const capture = (page) => page.evaluate(() => {
    const host = [...document.body.children].filter((n) => n.style && n.style.position === "fixed").pop();
    return host === undefined ? null : { text: host.textContent, role: host.getAttribute("role"), button: host.querySelector("button") !== null };
  });

  try {
    /* -- anchor construction: first, middle, last and whole block ------- */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      const cases = [
        { a: { at: 0 }, b: { at: 3 }, exact: "The", prefix: "", start: 0 },
        { a: { at: 4 }, b: { at: 13 }, exact: "cache key", prefix: "The ", start: 4 },
        { a: { at: 40 }, b: { at: 46 }, exact: "render", start: 40 },
        { a: { at: 0 }, b: { at: 47 }, exact: "The cache key covers every input to the render.", start: 0 },
      ];
      for (const item of cases) {
        await selectAndSettle(page, { ...P1, at: item.a.at }, { ...P1, at: item.b.at });
        const tip = await capture(page);
        assert.deepEqual(tip, { text: "Comment", role: null, button: true }, `tooltip for ${item.exact}`);
        await page.evaluate(() => window.__t.key({ key: "Escape" }));
      }
    });

    /* The anchors those captures actually submit, read off the request body.
       This is the inverse of P3-C's map, so `start` is a normalised text
       index and the context is exactly 32 units wherever the block affords
       them. */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      const anchors = [];
      for (const [from, to] of [[0, 3], [4, 13], [40, 46], [0, 47]]) {
        await selectAndSettle(page, { ...P1, at: from }, { ...P1, at: to });
        anchors.push(await draftAnchor(page));
      }
      assert.deepEqual(anchors, [
        { block: "a31b7c9d2", exact: "The", prefix: "", suffix: " cache key covers every input to", start: 0 },
        { block: "a31b7c9d2", exact: "cache key", prefix: "The ", suffix: " covers every input to the rende", start: 4 },
        { block: "a31b7c9d2", exact: "render", prefix: "e key covers every input to the ", suffix: ".", start: 40 },
        { block: "a31b7c9d2", exact: "The cache key covers every input to the render.", prefix: "", suffix: "", start: 0 },
      ]);
    });

    /* -- cross text nodes, and the normalised space between them -------- */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      const text = await page.evaluate(() => {
        const nodes = window.__t.textNodes('p[data-aid="a44f0e1b7"]');
        const range = document.createRange();
        range.setStart(nodes[0], 2);
        range.setEnd(nodes[2], 6);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return range.toString();
      });
      assert.match(text, /second/);
      await page.evaluate(() => window.__t.mouseup());
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true });
    });

    /* -- refusals: nothing shown, nothing sent, nothing clamped -------- */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);

      await page.evaluate(() => window.__t.collapse({ sel: 'p[data-aid="a31b7c9d2"]', at: 4 }));
      await page.evaluate(() => window.__t.mouseup());
      assert.equal(await capture(page), null, "collapsed selection shows nothing");

      await page.evaluate(() => window.__t.clear());
      await page.evaluate(() => window.__t.mouseup());
      assert.equal(await capture(page), null, "empty selection shows nothing");

      /* Multi-block: the refusal, and the untouched user selection. */
      const before = await page.evaluate(() => document.getSelection().toString());
      await selectAndSettle(page, { ...P1, at: 4 }, { ...P2, at: 7 });
      assert.deepEqual(await capture(page), { text: "Select inside one paragraph", role: "status", button: false });
      const spanning = await page.evaluate(() => document.getSelection().toString());
      assert.notEqual(spanning, before);
      assert.match(spanning, /Rollout/, "the cross-block selection is left exactly as the reader made it");

      assert.deepEqual(await writesOf(page), [], "no refusal ever sends a request");
    });

    /* -- exact length boundary: 1,000 accepted, 1,001 refused ---------- */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      await selectAndSettle(page, { ...LONGP, at: 0 }, { ...LONGP, at: 1000 });
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true }, "1,000 units is the longest quote");
      await selectAndSettle(page, { ...LONGP, at: 0 }, { ...LONGP, at: 1001 });
      assert.equal(await capture(page), null, "1,001 units is refused");
    });

    /* -- a range that would split an astral pair is not an anchor ------ */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      await selectAndSettle(page, { ...EMOJI, at: 2 }, { ...EMOJI, at: 3 });
      assert.equal(await capture(page), null, "half a surrogate pair is refused");
      await selectAndSettle(page, { ...EMOJI, at: 2 }, { ...EMOJI, at: 4 });
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true }, "the whole pair is fine");
    });

    /* -- a repeated aid cannot be attributed, so it is refused --------- */

    /* Present from the start, a repeated aid stops P3-C's block index from
       building at all, so the document keeps its static shape: no panel, no
       rail, no affordance.  That is stricter than suppressing the tooltip. */
    await withPage(browser, host, { dupe: true }, async (page) => {
      await page.evaluate(() => { window.__list = { threads: [], nextCursor: null }; window.__t.session(); });
      await page.waitForTimeout(500);
      assert.deepEqual(await page.evaluate(() => ({
        toggle: document.getElementById("doc-comments-toggle") !== null,
        panel: document.getElementById("doc-comments-panel") !== null,
        rail: document.getElementById("doc-comments-rail") !== null,
      })), { toggle: false, panel: false, rail: false }, "a duplicate aid leaves the document untouched");
    });

    /* Appearing after the model committed, it is `blockOf` that has to refuse
       it: the panel stays exactly as it was and only the capture withdraws. */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);
      await selectAndSettle(page, { ...P1, at: 4 }, { ...P1, at: 13 });
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true }, "the aid is unique to begin with");

      await page.evaluate(() => {
        const clone = document.querySelector('p[data-aid="a31b7c9d2"]').cloneNode(true);
        document.querySelector('section[id="rollout"]').appendChild(clone);
      });
      await selectAndSettle(page, { ...P1, at: 4 }, { ...P1, at: 13 });
      assert.equal(await capture(page), null, "a duplicate aid withdraws the affordance");
      assert.notEqual(await page.evaluate(() => document.getElementById("doc-comments-panel")), null, "and nothing else is torn down");
    });

    /* -- a path-shaped document id reaches no request ----------------- */

    /* `docId` is the one value that lands in a request *path*.  The client
       encodes it, and `validThread` independently refuses every thread whose
       `docId` is not P3-A's six hex characters -- so a document claiming a
       traversal renders no thread, offers no control, and writes nothing. */
    await withPage(browser, host, { docId: "4b7d2a/../../../admin/purge" }, async (page) => {
      await page.evaluate((thread) => {
        window.__list = { threads: [thread], nextCursor: null };
        window.__t.session({ doc: "4b7d2a/../../../admin/purge" });
      }, fixtureThread());
      await page.waitForTimeout(700);
      assert.deepEqual(await page.evaluate(() => ({
        cards: document.querySelectorAll("article[data-thread-id]").length,
        replies: document.querySelectorAll("form.doc-comments-reply").length,
        status: document.querySelectorAll(".doc-comments-status-action").length,
      })), { cards: 0, replies: 0, status: 0 }, "a traversal-shaped doc id renders nothing to press");
      assert.deepEqual(await writesOf(page), [], "and issues no write");
    });

    /* -- tooltip lifecycle: debounce, shortcut, escape, scroll, resize - */
    await withPage(browser, host, {}, async (page) => {
      await activate(page);

      /* Making the selection and looking for the tooltip in one page function
         is the only way to assert "not yet" about a 250 ms timer: read across
         two round trips, a runner slow enough to spend 250 ms between them
         fails this for no reason, which is the same class of defect as #124
         with its polarity reversed. Inside one task the timer cannot have run. */
      const immediate = await page.evaluate(() => {
        window.__t.select({ sel: 'p[data-aid="a31b7c9d2"]', at: 4 }, { sel: 'p[data-aid="a31b7c9d2"]', at: 13 });
        return [...document.body.children].filter((n) => n.style && n.style.position === "fixed").length;
      });
      assert.equal(immediate, 0, "the trailing timer has not fired yet");
      await page.waitForFunction(() => [...document.body.children].some((n) => n.style && n.style.position === "fixed"), null, { timeout: 4000 });

      await page.evaluate(() => window.__t.key({ key: "Escape" }));
      assert.equal(await capture(page), null, "Escape retires the tooltip");

      /* Ctrl+Alt+M captures the still-live selection immediately, and puts
         focus on the button it just produced -- a keyboard reader would
         otherwise have to Tab past the whole document to a host that the
         first scroll destroys. */
      await page.evaluate(() => window.__t.key({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }));
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true });
      assert.deepEqual(await page.evaluate(() => ({
        tag: document.activeElement.localName,
        text: document.activeElement.textContent,
        inTooltip: document.activeElement.parentElement.style.position === "fixed",
      })), { tag: "button", text: "Comment", inTooltip: true }, "the shortcut focuses its own affordance");

      await page.evaluate(() => document.dispatchEvent(new Event("scroll", { bubbles: true })));
      assert.equal(await capture(page), null, "scrolling retires the tooltip");

      await page.evaluate(() => window.__t.key({ key: "m", code: "KeyM", metaKey: true, altKey: true }));
      assert.deepEqual(await capture(page), { text: "Comment", role: null, button: true }, "Meta+Alt+M works too");
      await page.evaluate(() => window.dispatchEvent(new Event("resize")));
      assert.equal(await capture(page), null, "resizing retires the tooltip");

      /* The multi-block refusal retires itself after three seconds. */
      await selectAndSettle(page, { ...P1, at: 4 }, { ...P2, at: 7 });
      /* `capture` returns null when there is no host, so read it once and say
         which tooltip was missing rather than dereferencing null (#124). */
      const refusal = await capture(page);
      assert.notEqual(refusal, null, `the multi-block refusal is shown (${TOOLTIP_HOST})`);
      assert.equal(refusal.text, "Select inside one paragraph");
      await page.waitForFunction(() => ![...document.body.children].some((n) => n.style && n.style.position === "fixed"), null, { timeout: 6000 });
    });

    /* -- session roles decide only what is shown ----------------------- */
    const mine = fixtureThread();
    const theirs = fixtureThread({ id: "t_m8x2k1_4f7a9c32", author: actor(OTHER_SUB, "Other Reader"), comments: [fixtureComment("4f7a9c32", "A thread by someone else.", actor(OTHER_SUB, "Other Reader"))] });

    const shown = async (page) => page.evaluate(() => ({
      start: document.getElementById("doc-comments-start") !== null,
      replies: document.querySelectorAll("form.doc-comments-reply").length,
      status: [...document.querySelectorAll(".doc-comments-status-action")].map((b) => b.closest("article").getAttribute("data-thread-id")).sort(),
    }));

    for (const [role, expected] of [
      ["owner", { start: true, replies: 2, status: ["t_m8x2k1_4f7a9c31", "t_m8x2k1_4f7a9c32"] }],
      ["editor", { start: true, replies: 2, status: ["t_m8x2k1_4f7a9c31", "t_m8x2k1_4f7a9c32"] }],
      ["commenter", { start: true, replies: 2, status: ["t_m8x2k1_4f7a9c31"] }],
      ["viewer", { start: false, replies: 0, status: [] }],
      ["none", { start: false, replies: 0, status: [] }],
    ]) {
      await withPage(browser, host, {}, async (page) => {
        const canComment = role === "owner" || role === "editor" || role === "commenter";
        await activate(page, { threads: [mine, theirs], patch: { role, canComment } });
        await openPanel(page);
        assert.deepEqual(await shown(page), expected, `role ${role}`);
      });
    }

    /* A malformed session leaves the module read-only without breaking it. */
    for (const patch of [{ role: "wizard" }, { canComment: "yes" }, { doc: "aaaaaa" }, { sub: "" }]) {
      await withPage(browser, host, {}, async (page) => {
        await activate(page, { threads: [mine], patch });
        await openPanel(page);
        assert.deepEqual(await shown(page), { start: false, replies: 0, status: [] }, `malformed session ${JSON.stringify(patch)}`);
      });
    }

    /* No session at all: no panel, no controls, no requests. */
    await withPage(browser, host, {}, async (page) => {
      await activate(page, { none: true });
      assert.equal(await page.evaluate(() => document.getElementById("doc-comments-toggle")), null);
      assert.deepEqual(await page.evaluate(() => window.__calls), []);
    });

    /* -- history head: missing, malformed or ambiguous suppresses only
          creation, and leaves reply and resolve exactly as they were ---- */
    for (const options of [{ head: null }, { head: "zzzzzzz" }, { head: "7aaca5" }, { heads: 2 }]) {
      await withPage(browser, host, options, async (page) => {
        await activate(page, { threads: [mine] });
        await openPanel(page);
        const state = await shown(page);
        assert.equal(state.start, false, `create suppressed for ${JSON.stringify(options)}`);
        assert.equal(state.replies, 1, "replies survive a bad head");
        assert.deepEqual(state.status, ["t_m8x2k1_4f7a9c31"], "resolve survives a bad head");
        await selectAndSettle(page, { ...P1, at: 4 }, { ...P1, at: 13 });
        assert.equal(await capture(page), null, "and no comment tooltip is offered");
      });
    }

    /* An unusable section inventory withdraws the discussion action only. */
    await withPage(browser, host, { section: "Rollout" }, async (page) => {
      await activate(page, { threads: [mine] });
      await openPanel(page);
      const state = await shown(page);
      assert.equal(state.start, false, "an invalid section id withdraws the discussion action");
      assert.equal(state.replies, 1, "and nothing else");
    });

    await writeMatrix(browser, host);

    await server.close();
    await browser.close();
  } catch (error) {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

/* --------------------------------------- routes, responses, focus */

const THREAD_ID = "t_m8x2k1_4f7a9c31";

function created(request, id = THREAD_ID) {
  const author = actor();
  return fixtureThread({
    id,
    kind: request.kind,
    section: request.section,
    anchor: request.anchor,
    title: request.kind === "discussion" ? request.title : null,
    docVersion: request.docVersion,
    author,
    comments: [fixtureComment(id.slice(-8), request.body, author)],
  });
}

function replied(base, body, author = actor()) {
  return { ...base, comments: [...base.comments, fixtureComment("9d0e1f22", body, author, "2026-01-02T03:05:05.000Z")] };
}

function resolved(base) {
  return { ...base, status: "resolved", resolvedAt: "2026-01-02T03:06:05.000Z", resolvedBy: actor() };
}

/* Every write scenario shares one opened panel holding one open thread. */
async function withThread(browser, host, run, { threads = null, options = {} } = {}) {
  await withPage(browser, host, options, async (page) => {
    await activate(page, { threads: threads === null ? [fixtureThread()] : threads });
    await page.click("#doc-comments-toggle");
    await page.waitForSelector("#doc-comments-panel:not([hidden])");
    await page.evaluate(() => { window.__calls.length = 0; });
    await run(page);
  });
}

/* P3-C's status filter defaults to Open, so a resolved thread is rendered but
   hidden.  Anything asserting on a resolved card has to widen the filter. */
async function setStatusFilter(page, label) {
  const index = { Open: 1, Resolved: 2, All: 3 }[label];
  await page.click(`#doc-comments-filters [aria-label="Status"] button:nth-child(${index})`);
  await page.waitForFunction(
    (index) => document.querySelectorAll('#doc-comments-filters [aria-label="Status"] button')[index - 1].getAttribute("aria-pressed") === "true",
    index,
  );
}

const plan = (page, entries) => page.evaluate((entries) => { window.__plans.push(...entries); }, entries);
const lastWrite = (page) => page.evaluate(() => window.__calls.filter((call) => call.method !== "GET").pop() || null);
const statusText = (page) => page.textContent("#doc-comments-status");

async function writeMatrix(browser, host) {
  /* -- the three exact routes, bodies and transport options ---------- */
  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.fill("#doc-comments-draft-title", "Clarify the rollout boundary");
    await page.fill("#doc-comments-draft-body", "Should the first release keep the old reader available?");
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));

    const call = await lastWrite(page);
    const url = new URL(call.url);
    assert.equal(url.origin, new URL(page.url()).origin, "same origin");
    assert.equal(url.pathname, "/api/threads");
    assert.equal(url.search, `?doc=${DOC_ID}`, "create uses the query route");
    assert.equal(call.method, "POST");
    assert.equal(call.mode, "same-origin");
    assert.equal(call.credentials, "same-origin");
    assert.equal(call.cache, "no-store");
    assert.equal(call.redirect, "error");
    assert.deepEqual(call.headers, { "Content-Type": "application/json", Accept: "application/json" });
    assert.equal(call.signal, true, "every write carries an AbortSignal");
    assert.deepEqual(JSON.parse(call.body), {
      kind: "discussion",
      section: "architecture",
      anchor: null,
      title: "Clarify the rollout boundary",
      docVersion: HEAD,
      body: "Should the first release keep the old reader available?",
    });
  });

  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
    await page.click("form.doc-comments-reply button[type=submit]");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));
    const call = await lastWrite(page);
    const url = new URL(call.url);
    assert.equal(url.pathname, `/api/threads/${DOC_ID}/${THREAD_ID}`, "reply uses the path route");
    assert.equal(url.search, "", "and carries no query");
    assert.equal(call.method, "POST");
    assert.deepEqual(JSON.parse(call.body), { body: "The fixture now covers that case." });
  });

  for (const [from, next, label] of [["open", "resolved", "Resolve"], ["resolved", "open", "Reopen"]]) {
    await withThread(browser, host, async (page) => {
      if (from === "resolved") await setStatusFilter(page, "All");
      await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
      assert.equal(await page.textContent(".doc-comments-status-action"), label);
      await page.click(".doc-comments-status-action");
      await page.waitForFunction(() => window.__calls.some((call) => call.method === "PATCH"));
      const call = await lastWrite(page);
      assert.equal(new URL(call.url).pathname, `/api/threads/${DOC_ID}/${THREAD_ID}`);
      assert.equal(new URL(call.url).search, "");
      assert.deepEqual(JSON.parse(call.body), { status: next });
    }, { threads: [from === "open" ? fixtureThread() : resolved(fixtureThread())] });
  }

  /* -- body and title bounds are refused before any request ---------- */
  await withThread(browser, host, async (page) => {
    const send = async (body) => {
      await page.evaluate((body) => { document.getElementById(`doc-comments-reply-${"t_m8x2k1_4f7a9c31"}`).value = body; }, body);
      await page.click("form.doc-comments-reply button[type=submit]");
      return page.evaluate(() => window.__calls.filter((call) => call.method !== "GET").length);
    };
    assert.equal(await send(""), 0, "an empty body is not a write");
    assert.equal(await send("   \n  "), 0, "nor is whitespace");
    assert.equal(await send("x".repeat(8001)), 0, "8,001 units is refused");
    assert.equal(await page.getAttribute(`#doc-comments-reply-${THREAD_ID}`, "maxlength"), "8000");
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    assert.equal(await send("x".repeat(8000)), 1, "8,000 units is the longest reply");
  });

  await withThread(browser, host, async (page) => {
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    assert.equal(await page.getAttribute("#doc-comments-draft-title", "maxlength"), "200");
    assert.equal(await page.getAttribute("#doc-comments-draft-body", "maxlength"), "8000");
    const send = async (title, body) => {
      await page.evaluate(([title, body]) => {
        document.getElementById("doc-comments-draft-title").value = title;
        document.getElementById("doc-comments-draft-body").value = body;
      }, [title, body]);
      await page.click(".doc-comments-draft button[type=submit]");
      return page.evaluate(() => window.__calls.filter((call) => call.method !== "GET").length);
    };
    assert.equal(await send("", "A body."), 0, "a discussion needs a title");
    assert.equal(await send("x".repeat(201), "A body."), 0, "201 units is refused");
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    assert.equal(await send("x".repeat(200), "A body."), 1, "200 units is the longest title");
  });

  /* An anchored comment never offers the section select: its section is the
     one its captured block already belongs to. */
  await withThread(browser, host, async (page) => {
    await page.evaluate(() => window.__t.select({ sel: 'p[data-aid="a70f1e2d3"]', at: 0 }, { sel: 'p[data-aid="a70f1e2d3"]', at: 7 }));
    await page.evaluate(() => window.__t.mouseup());
    await openTooltipDraft(page);
    assert.equal(await page.evaluate(() => document.getElementById("doc-comments-draft-section")), null, "no section select on an anchored draft");
    assert.equal(await page.evaluate(() => document.getElementById("doc-comments-draft-title")), null, "and no title either");
    assert.equal(await page.textContent(".doc-comments-draft blockquote"), "Rollout", "the captured quote is shown back");

    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    await page.fill("#doc-comments-draft-body", "An invented question.");
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));
    const sent = JSON.parse((await lastWrite(page)).body);
    assert.equal(sent.section, "rollout", "the section comes from the captured block, not the panel");
    assert.equal(sent.anchor.block, "a70f1e2d3");
    assert.equal(sent.title, undefined, "an anchored create body carries no title");
  });

  /* -- the section select is bounded, labelled and hash-defaulted ---- */
  await withThread(browser, host, async (page) => {
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-section");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#doc-comments-draft-section option")].map((o) => [o.value, o.textContent])),
      [["architecture", "Architecture"], ["rollout", "Rollout"]], "options come from main > section[id], labelled by .sec-label");
    assert.equal(await page.inputValue("#doc-comments-draft-section"), "architecture", "the first option is the fallback default");
  });

  await withThread(browser, host, async (page) => {
    await page.evaluate(() => { location.hash = "#rollout"; });
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-section");
    assert.equal(await page.inputValue("#doc-comments-draft-section"), "rollout", "location.hash names the default section");
  });

  /* -- only P3-A's exact success commits, and it commits exactly once - */
  await withThread(browser, host, async (page) => {
    const request = {
      kind: "discussion", section: "rollout", anchor: null,
      title: "Clarify the rollout boundary", docVersion: HEAD,
      body: "Should the first release keep the old reader available?",
    };
    await plan(page, [{ mode: "json", status: 201, json: JSON.stringify({ thread: created(request, "t_m8x2k1_4f7a9c40") }) }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.selectOption("#doc-comments-draft-section", "rollout");
    await page.fill("#doc-comments-draft-title", request.title);
    await page.fill("#doc-comments-draft-body", request.body);
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForSelector('article[data-thread-id="t_m8x2k1_4f7a9c40"]');
    assert.equal(await page.evaluate(() => document.querySelector(".doc-comments-draft")), null, "a saved draft is taken down");
    assert.equal(await statusText(page), "The comment change was saved.");
    assert.deepEqual(await page.evaluate(() => ({ tag: document.activeElement.localName, text: document.activeElement.textContent })),
      { tag: "h4", text: "Clarify the rollout boundary" }, "focus lands on the new thread heading");
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.method !== "GET").length), 1, "the response is the acknowledgement; no immediate list");
  });

  /* A 201 whose record does not match what was asked for is not a success. */
  for (const [name, mutate] of [
    ["section", (thread) => ({ ...thread, section: "rollout" })],
    ["kind", (thread) => ({ ...thread, kind: "comment", title: null, anchor: fixtureThread().anchor })],
    ["docVersion", (thread) => ({ ...thread, docVersion: "0000000" })],
    ["title", (thread) => ({ ...thread, title: "A different title" })],
    ["body", (thread) => ({ ...thread, comments: [{ ...thread.comments[0], body: "A different body." }] })],
    ["docId", (thread) => ({ ...thread, docId: "aaaaaa" })],
  ]) {
    await withThread(browser, host, async (page) => {
      const request = { kind: "discussion", section: "architecture", anchor: null, title: "Clarify the rollout boundary", docVersion: HEAD, body: "An invented question." };
      await plan(page, [{ mode: "json", status: 201, json: JSON.stringify({ thread: mutate(created(request, "t_m8x2k1_4f7a9c41")) }) }]);
      await page.click("#doc-comments-start");
      await page.waitForSelector("#doc-comments-draft-body");
      await page.fill("#doc-comments-draft-title", request.title);
      await page.fill("#doc-comments-draft-body", request.body);
      await page.click(".doc-comments-draft button[type=submit]");
      await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.");
      assert.equal(await page.evaluate(() => document.querySelector('article[data-thread-id="t_m8x2k1_4f7a9c41"]')), null, `mismatched ${name} never enters the model`);
      assert.notEqual(await page.evaluate(() => document.querySelector(".doc-comments-draft")), null, "the draft is kept so the text is not lost");
    });
  }

  /* -- reply commits, focuses the new message, and keeps concurrent
        comments the server already had ------------------------------- */
  await withThread(browser, host, async (page) => {
    const base = fixtureThread();
    const other = actor(OTHER_SUB, "Other Reader");
    const withConcurrent = { ...base, comments: [...base.comments, fixtureComment("aabbccdd", "A concurrent note.", other, "2026-01-02T03:04:30.000Z")] };
    await plan(page, [{ mode: "json", status: 200, json: JSON.stringify({ thread: replied(withConcurrent, "The fixture now covers that case.") }) }]);
    await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
    await page.click("form.doc-comments-reply button[type=submit]");
    await page.waitForFunction(() => document.querySelectorAll(".doc-comments-messages > li").length === 3);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".doc-comments-messages > li .doc-comments-body")].map((n) => n.textContent)),
      ["Could we name the invalidation case?", "A concurrent note.", "The fixture now covers that case."],
      "a comment that arrived while the reply was in flight is retained");
    assert.deepEqual(await page.evaluate(() => ({ tag: document.activeElement.localName, text: document.activeElement.textContent.includes("The fixture now covers that case.") })),
      { tag: "li", text: true }, "focus lands on the appended message");
  });

  /* A reply attributed to somebody else, or to another thread, is refused. */
  for (const [name, thread] of [
    ["another author", replied(fixtureThread(), "The fixture now covers that case.", actor(OTHER_SUB, "Other Reader"))],
    ["another thread", { ...replied(fixtureThread(), "The fixture now covers that case."), id: "t_m8x2k1_4f7a9c99" }],
    ["another body", replied(fixtureThread(), "Something nobody typed.")],
  ]) {
    await withThread(browser, host, async (page) => {
      await plan(page, [{ mode: "json", status: 200, json: JSON.stringify({ thread }) }]);
      await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
      await page.click("form.doc-comments-reply button[type=submit]");
      await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.");
      assert.equal(await page.evaluate(() => document.querySelectorAll(".doc-comments-messages > li").length), 1, `a reply from ${name} never enters the model`);
    });
  }

  /* -- resolve and reopen -------------------------------------------- */
  await withThread(browser, host, async (page) => {
    await setStatusFilter(page, "All");
    await plan(page, [{ mode: "json", status: 200, json: JSON.stringify({ thread: resolved(fixtureThread()) }) }]);
    await page.click(".doc-comments-status-action");
    await page.waitForFunction(() => document.querySelector(".doc-comments-status-label").textContent === "Resolved");
    assert.equal(await page.textContent(".doc-comments-status-action"), "Reopen");
    assert.deepEqual(await page.evaluate(() => ({ tag: document.activeElement.localName, text: document.activeElement.textContent })),
      { tag: "h4", text: "Comment by Invented Reader" }, "focus stays on the thread heading");
  });

  await withThread(browser, host, async (page) => {
    await setStatusFilter(page, "All");
    await plan(page, [{ mode: "json", status: 200, json: JSON.stringify({ thread: fixtureThread() }) }]);
    await page.click(".doc-comments-status-action");
    await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.");
    assert.equal(await page.textContent(".doc-comments-status-label"), "Open", "a response that ignores the requested status is refused");
  });

  await denialMatrix(browser, host);
}

/* ------------------------------- denial, failure, and the in-flight rule */

async function denialMatrix(browser, host) {
  /* -- 401 and 403 retire every write control for the page's lifetime - */
  for (const status of [401, 403]) {
    await withThread(browser, host, async (page) => {
      await plan(page, [{ mode: "json", status, json: "{}" }]);
      await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
      await page.click("form.doc-comments-reply button[type=submit]");
      await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "You no longer have permission to change comments.");

      assert.deepEqual(await page.evaluate(() => ({
        start: document.getElementById("doc-comments-start") !== null,
        replies: document.querySelectorAll("form.doc-comments-reply").length,
        status: document.querySelectorAll(".doc-comments-status-action").length,
        draft: document.querySelector(".doc-comments-draft") !== null,
      })), { start: false, replies: 0, status: 0, draft: false }, `${status} suppresses every write control`);

      assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.method === "GET").length), 1, "the denial path refreshes exactly once");

      /* The flag is page-lifetime: a fresh, fully valid session cannot undo it. */
      await page.evaluate(() => window.__t.session());
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.querySelectorAll("form.doc-comments-reply").length), 0, "a replayed session never re-exposes writes");

      /* And no selection offers a comment any more. */
      await page.evaluate(() => window.__t.select({ sel: 'p[data-aid="a31b7c9d2"]', at: 4 }, { sel: 'p[data-aid="a31b7c9d2"]', at: 13 }));
      await page.evaluate(() => window.__t.mouseup());
      assert.equal(await page.evaluate(() => [...document.body.children].filter((n) => n.style && n.style.position === "fixed").length), 0);
    });
  }

  /* A denial arriving while a draft is open closes it and restores focus. */
  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "json", status: 403, json: "{}" }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.fill("#doc-comments-draft-title", "Clarify the rollout boundary");
    await page.fill("#doc-comments-draft-body", "An invented question.");
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "You no longer have permission to change comments.");
    assert.equal(await page.evaluate(() => document.querySelector(".doc-comments-draft")), null, "the draft is closed");
    /* The draft's own invoker is a create control, so the denial repaint takes
       it away; focus has to survive onto something that is still there. */
    assert.equal(await page.evaluate(() => document.activeElement.id), "doc-comments-title", "focus lands on a control that survived the repaint");
    assert.equal(await page.evaluate(() => document.activeElement === document.body), false, "focus is never dropped onto the document");
  });

  /* -- ordinary failure keeps the last good model and says so once ---- */
  const failures = [
    ["409", { mode: "json", status: 409, json: JSON.stringify({ error: "conflict" }) }],
    ["500", { mode: "json", status: 500, json: JSON.stringify({ error: "server" }) }],
    ["200 with the wrong envelope", { mode: "json", status: 200, json: JSON.stringify({ thread: fixtureThread(), extra: 1 }) }],
    ["200 with an invalid record", { mode: "json", status: 200, json: JSON.stringify({ thread: { ...fixtureThread(), status: "half" } }) }],
    ["a malformed body", { mode: "json", status: 200, json: "{}", malformed: true }],
    ["a rejected request", { mode: "reject" }],
  ];
  for (const [name, entry] of failures) {
    await withThread(browser, host, async (page) => {
      await plan(page, [entry]);
      await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
      await page.click("form.doc-comments-reply button[type=submit]");
      await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.");
      assert.deepEqual(await page.evaluate(() => ({
        messages: document.querySelectorAll(".doc-comments-messages > li").length,
        replies: document.querySelectorAll("form.doc-comments-reply").length,
        focused: document.activeElement.localName,
        kept: document.querySelector("form.doc-comments-reply textarea").value,
      })), { messages: 1, replies: 1, focused: "textarea", kept: "The fixture now covers that case." }, `${name} keeps the last good model and the typed text`);
      /* No server string ever becomes status text or markup. */
      assert.equal(await page.evaluate(() => document.getElementById("doc-comments-panel").querySelector("script")), null);
    });
  }

  /* -- one five-second deadline, no retry, one mutation at a time ----- */
  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "hang" }]);
    await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
    await page.click("form.doc-comments-reply button[type=submit]");

    await page.waitForFunction(() => document.querySelector("form.doc-comments-reply").getAttribute("aria-busy") === "true");
    assert.equal(await statusText(page), "Saving the comment change.");
    /* Disabling the textarea the reader was typing in would drop focus onto
       the body for the whole five-second window. */
    assert.deepEqual(await page.evaluate(() => ({
      onBody: document.activeElement === document.body,
      busyHost: document.activeElement === document.querySelector("form.doc-comments-reply"),
    })), { onBody: false, busyHost: true }, "focus moves to the aria-busy host, not the document");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("form.doc-comments-reply button, form.doc-comments-reply textarea")].map((n) => n.disabled)),
      [true, true], "the initiating form is disabled until settlement");

    /* A second mutation attempted mid-flight is simply not sent. */
    await page.evaluate(() => { const b = document.querySelector(".doc-comments-status-action"); if (b !== null) { b.disabled = false; b.click(); } });
    assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.method !== "GET").length), 1, "at most one write is in flight");

    await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.", null, { timeout: 15000 });
    const elapsed = await page.evaluate(() => window.__aborted);
    assert.ok(elapsed >= 4500 && elapsed <= 7000, `the deadline fired at ~5s, not ${elapsed}ms`);
    assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.method !== "GET").length), 1, "an abort is never retried");
    assert.equal(await page.evaluate(() => document.querySelector("form.doc-comments-reply").hasAttribute("aria-busy")), false, "aria-busy is cleared");
  });

  /* A create that settles while the reader has since opened another draft
     must take down only the one that was submitted. */
  await withThread(browser, host, async (page) => {
    const request = { kind: "discussion", section: "architecture", anchor: null, title: "Clarify the rollout boundary", docVersion: HEAD, body: "An invented question." };
    await plan(page, [{ mode: "hang" }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.fill("#doc-comments-draft-title", request.title);
    await page.fill("#doc-comments-draft-body", request.body);
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));

    /* The submitted draft is still on screen and still holds the typed text. */
    assert.equal(await page.inputValue("#doc-comments-draft-body"), request.body);
    await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.", null, { timeout: 15000 });
    assert.equal(await page.inputValue("#doc-comments-draft-body"), request.body, "an aborted create never discards the reader's text");
  });

  /* An in-flight create disables submit and cancel but deliberately leaves the
     message textarea usable, and its keydown handler routes Ctrl/Meta+Enter
     straight to submitDraft. The `writing` flag is the only thing standing
     between the keyboard and a second concurrent create. */
  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "hang" }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.fill("#doc-comments-draft-title", "Clarify the rollout boundary");
    await page.fill("#doc-comments-draft-body", "An invented question.");
    await page.click(".doc-comments-draft button[type=submit]");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));

    assert.deepEqual(await page.evaluate(() => ({
      body: document.getElementById("doc-comments-draft-body").disabled,
      submit: document.querySelector(".doc-comments-draft button[type=submit]").disabled,
    })), { body: false, submit: true }, "the message stays typable while its submit control is disabled");

    await page.press("#doc-comments-draft-body", "Control+Enter");
    await page.press("#doc-comments-draft-body", "Meta+Enter");
    assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.method === "POST").length), 1,
      "the keyboard path cannot start a second create while one is in flight");

    await page.waitForFunction(() => document.getElementById("doc-comments-status").textContent === "The comment change was not saved.", null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__calls.filter((call) => call.method === "POST").length), 1, "and never retries the aborted one");
  });

  /* -- draft keyboard and focus behaviour ---------------------------- */
  await withThread(browser, host, async (page) => {
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    assert.equal(await page.evaluate(() => document.activeElement.id), "doc-comments-draft-body", "the draft opens focused on its message");
    await page.press("#doc-comments-draft-body", "Escape");
    assert.equal(await page.evaluate(() => document.querySelector(".doc-comments-draft")), null, "Escape closes the draft");
    assert.equal(await page.evaluate(() => document.activeElement.id), "doc-comments-start", "and returns focus to the invoker");
    assert.equal(await page.evaluate(() => document.getElementById("doc-comments-panel").hidden), false, "without also closing the panel");
  });

  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.fill("#doc-comments-draft-title", "Clarify the rollout boundary");
    await page.fill("#doc-comments-draft-body", "An invented question.");
    await page.press("#doc-comments-draft-body", "Control+Enter");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));
    assert.equal(await statusText(page), "The comment change was not saved.");
  });

  await withThread(browser, host, async (page) => {
    await plan(page, [{ mode: "json", status: 500, json: "{}" }]);
    await page.fill(`#doc-comments-reply-${THREAD_ID}`, "The fixture now covers that case.");
    await page.press(`#doc-comments-reply-${THREAD_ID}`, "Meta+Enter");
    await page.waitForFunction(() => window.__calls.some((call) => call.method === "POST"));
  });

  /* Only one draft exists at a time. */
  await withThread(browser, host, async (page) => {
    await page.click("#doc-comments-start");
    await page.waitForSelector("#doc-comments-draft-body");
    await page.evaluate(() => window.__t.select({ sel: 'p[data-aid="a31b7c9d2"]', at: 4 }, { sel: 'p[data-aid="a31b7c9d2"]', at: 13 }));
    await page.evaluate(() => window.__t.mouseup());
    assert.equal(await page.evaluate(() => [...document.body.children].filter((n) => n.style && n.style.position === "fixed").length), 0, "an open draft suppresses the tooltip");
    assert.equal(await page.evaluate(() => document.querySelectorAll(".doc-comments-draft").length), 1);
  });

  /* -- P3-C's read behaviour is untouched ---------------------------- */
  await withThread(browser, host, async (page) => {
    const discussion = fixtureThread({ id: "t_m8x2k1_4f7a9c50", kind: "discussion", anchor: null, title: "An invented discussion", comments: [fixtureComment("4f7a9c50", "A discussion body.")] });
    await page.evaluate(([anchored, discussion]) => {
      window.__list = { threads: [anchored, discussion], nextCursor: null };
      return window.doc.comments.refresh();
    }, [fixtureThread(), discussion]);
    await page.waitForFunction(() => document.querySelectorAll("article[data-thread-id]").length === 2);

    assert.equal(await page.evaluate(() => typeof window.doc.comments.refresh), "function", "the public seam is unchanged");
    assert.deepEqual(await page.evaluate(() => Object.keys(window.doc.comments)), ["refresh"]);
    assert.equal(await page.evaluate(() => Object.isFrozen(window.doc.comments)), true);

    /* Filters still partition the same model, and still do it by hiding cards
       rather than dropping them, exactly as P3-C did. */
    const visible = () => page.evaluate(() => [...document.querySelectorAll("article[data-thread-id]")]
      .filter((article) => article.closest("li").hidden === false)
      .map((article) => article.getAttribute("data-thread-id")));

    /* P4-Q extends the kind group from `anchored | discussions | all` to
       `anchored | discussions | suggestions | all`, so `All` is the fourth
       control rather than the third. These clicks name the visible label
       instead of a position: a positional selector does not fail when the
       group grows, it silently retargets to a different filter, which is how
       this assertion came to click `Suggestions` and read an empty list. The
       order itself is asserted once, below, so a reorder still fails loudly. */
    assert.deepEqual(await kindLabels(page), ["Anchored", "Discussions", "Suggestions", "All"],
      "the kind group is exactly P4-Q's four controls, in order");

    await clickKind(page, "Anchored");
    await page.waitForFunction(() => document.querySelectorAll("article[data-thread-id]").length === 2);
    assert.deepEqual(await visible(), [THREAD_ID], "Anchored keeps only the comment");

    await clickKind(page, "Discussions");
    assert.deepEqual(await visible(), ["t_m8x2k1_4f7a9c50"], "Discussions keeps only the discussion");

    /* Neither fixture thread is a suggestion, and no renderer is registered,
       so the new view hides both cards without dropping them. */
    await clickKind(page, "Suggestions");
    assert.deepEqual(await visible(), [], "Suggestions keeps neither a comment nor a discussion");

    await clickKind(page, "All");
    assert.deepEqual((await visible()).sort(), [THREAD_ID, "t_m8x2k1_4f7a9c50"].sort(), "All restores both");
    assert.equal(await page.evaluate(() => document.querySelectorAll("article[data-thread-id]").length), 2, "filtering hides cards, it does not drop them");

    /* The anchored thread still resolves to its block, without touching prose. */
    assert.equal(await page.evaluate(() => document.querySelector('p[data-aid="a31b7c9d2"]').outerHTML),
      '<p data-aid="a31b7c9d2">The cache key covers every input to the render.</p>', "no prose node is wrapped or moved");
  }, { threads: [fixtureThread()] });
}

/* ---------------------------------------------------- browser matrix */

/* The rendered matrix drops the fetch stub and serves an invented loopback
   API instead, so a real pointer and a real keyboard drive real requests. */
function inventedApi(state) {
  return (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      html(response, state.body);
      return;
    }
    if (!url.pathname.startsWith("/api/threads")) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      state.requests.push({ method: request.method, path: url.pathname, search: url.search, body: raw });
      const send = (status, payload) => {
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET") {
        send(200, { threads: state.threads, nextCursor: null });
        return;
      }
      const payload = raw === "" ? {} : JSON.parse(raw);
      if (url.pathname === "/api/threads") {
        const thread = created(payload, `t_m8x2k1_4f7a9c${state.threads.length + 60}`);
        state.threads = [...state.threads, thread];
        send(201, { thread });
        return;
      }
      const id = url.pathname.split("/").pop();
      const at = state.threads.findIndex((thread) => thread.id === id);
      if (at === -1) {
        send(404, { error: "unknown thread" });
        return;
      }
      const next = payload.status === undefined
        ? replied(state.threads[at], payload.body)
        : payload.status === "resolved" ? resolved(state.threads[at]) : { ...state.threads[at], status: "open", resolvedAt: null, resolvedBy: null };
      state.threads = state.threads.map((thread, index) => (index === at ? next : thread));
      send(200, { thread: next });
    });
  };
}

/* Every context in this matrix pins its own viewport.  Playwright's default is
   already fixed, but the clamping assertions below compare against these
   numbers, and a context that inherited them silently would make the next
   headless-vs-headed difference look like a client bug. */
const VIEWPORT = { viewport: { width: 1280, height: 900 } };

async function browserMatrix() {
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const state = { body: "", threads: [fixtureThread()], requests: [] };
  state.body = fixturePage([ANCHOR_SHIM, TEST_HELPERS], {});
  const server = await serve(inventedApi(state));

  const open = async (context) => {
    state.threads = [fixtureThread()];
    state.requests = [];
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(`${server.origin}/`, { waitUntil: "load" });
    await page.waitForFunction("window.__installed === true");
    await page.evaluate(() => window.__t.session());
    await page.waitForSelector("#doc-comments-toggle");
    return { page, errors };
  };

  try {
    /* -- a real pointer drag across nested inline markup -------------- */
    {
      const context = await browser.newContext(VIEWPORT);
      const { page, errors } = await open(context);
      const target = page.locator('p[data-aid="a44f0e1b7"] strong');
      /* Measure the drag target only once it is actually laid out, so a
         missing or zero-sized element reports the selector rather than
         reading `x` off `null`. */
      await target.waitFor({ state: "visible", timeout: 5000 });
      const box = await target.boundingBox();
      assert.ok(box !== null && box.width > 0 && box.height > 0,
        `pointer drag: p[data-aid="a44f0e1b7"] strong has no layout box to drag across: ${JSON.stringify(box)}`);
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();
      /* The drag's last `selectionchange` may still be queued behind the
         `mouseup`, which removes the host and rebuilds it 250 ms later. This
         wait is not what makes the measurement safe -- `tooltipGeometry` polls,
         so it would find the rebuilt host anyway -- it just keeps the common
         case out of the poll. A real drag on a saturated runner is the slowest
         path in this matrix, so it gets a budget nearer Playwright's default
         than the 5 s the helper assumes. */
      await page.waitForTimeout(SELECTION_SETTLE_MS);

      const tooltip = await tooltipGeometry(page, "pointer drag", { timeout: 15_000 });
      assert.equal(tooltip.text, "Comment");
      assert.ok(tooltip.left >= 0 && tooltip.top >= 0 && tooltip.right <= VIEWPORT.viewport.width && tooltip.bottom <= VIEWPORT.viewport.height,
        `the tooltip is clamped into the viewport: ${JSON.stringify(tooltip)}`);

      const before = await page.evaluate(() => document.querySelector("main").innerHTML);
      await clickTooltipButton(page, "pointer drag", { timeout: 15_000 });
      await page.waitForSelector("#doc-comments-draft-body");
      await page.fill("#doc-comments-draft-body", "A real comment typed into a real browser.");
      await page.click(".doc-comments-draft button[type=submit]");
      await page.waitForFunction(() => document.querySelectorAll("article[data-thread-id]").length === 2);

      const create = state.requests.filter((item) => item.method === "POST" && item.path === "/api/threads").pop();
      assert.equal(create.search, `?doc=${DOC_ID}`);
      const sent = JSON.parse(create.body);
      assert.equal(sent.kind, "comment");
      assert.equal(sent.section, "architecture");
      assert.equal(sent.docVersion, HEAD);
      assert.equal(sent.anchor.block, "a44f0e1b7");
      assert.ok(sent.anchor.exact.length > 0 && sent.anchor.exact.length <= 1000);
      assert.equal(sent.anchor.exact.includes("  "), false, "the quote arrives already normalised");

      assert.equal(await page.evaluate(() => document.querySelector("main").innerHTML), before, "writing a comment mutates no prose");
      assert.deepEqual(errors, [], errors.join(" | "));
      await context.close();
    }

    /* -- keyboard only: tab to the panel, reply, resolve -------------- */
    {
      const context = await browser.newContext(VIEWPORT);
      const { page, errors } = await open(context);
      await page.focus("#doc-comments-toggle");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#doc-comments-panel:not([hidden])");

      await page.focus(`#doc-comments-reply-${THREAD_ID}`);
      await page.keyboard.type("A reply typed with no pointer at all.");
      await page.keyboard.press("Control+Enter");
      await page.waitForFunction(
        (id) => document.querySelectorAll(`article[data-thread-id="${id}"] .doc-comments-messages > li`).length === 2,
        THREAD_ID,
      );
      await page.waitForFunction(() => document.activeElement.localName === "li");
      assert.match(await page.evaluate(() => document.activeElement.textContent), /A reply typed with no pointer at all\./,
        "focus follows the appended message");

      await setStatusFilter(page, "All");
      await page.focus(".doc-comments-status-action");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector(".doc-comments-status-label").textContent === "Resolved");
      await page.waitForFunction(() => document.activeElement.localName === "h4");

      /* Every control the write path added is a real, labelled native one. */
      const controls = await page.evaluate(() => {
        const labelled = (node) => {
          if (node.getAttribute("aria-label") !== null) return true;
          if (node.labels !== undefined && node.labels.length > 0) return true;
          return (node.textContent || "").trim() !== "";
        };
        const panel = document.getElementById("doc-comments-panel");
        return {
          tags: [...new Set([...panel.querySelectorAll("button, textarea, input, select")].map((n) => n.localName))].sort(),
          unlabelled: [...panel.querySelectorAll("button, textarea, input, select")].filter((n) => !labelled(n)).length,
          types: [...new Set([...panel.querySelectorAll("button")].map((n) => n.type))].sort(),
        };
      });
      assert.deepEqual(controls.tags, ["button", "textarea"], "replies and status use native controls only");
      assert.equal(controls.unlabelled, 0, "every control carries an accessible name");
      assert.deepEqual(controls.types, ["button", "submit"], "no button defaults to an implicit submit");
      assert.deepEqual(errors, [], errors.join(" | "));
      await context.close();
    }

    /* -- narrow, zoomed, dark and forced-colors all stay usable ------- */
    for (const [name, contextOptions, prepare] of [
      ["narrow", { viewport: { width: 380, height: 720 } }, null],
      ["200% zoom", VIEWPORT, (page) => page.evaluate(() => { document.documentElement.style.zoom = "200%"; })],
      ["dark", { ...VIEWPORT, colorScheme: "dark" }, null],
      ["forced colors", { ...VIEWPORT, forcedColors: "active" }, null],
    ]) {
      const context = await browser.newContext(contextOptions);
      const { page, errors } = await open(context);
      if (prepare !== null) await prepare(page);
      await page.click("#doc-comments-toggle");
      await page.waitForSelector("#doc-comments-panel:not([hidden])");
      /* `selectAndSettle` leaves the selection in its settled state, so the
         host measured below is whichever of the two the client last placed --
         they are the same element with the same rect either way. */
      await selectAndSettle(page, { sel: 'p[data-aid="a31b7c9d2"]', at: 4 }, { sel: 'p[data-aid="a31b7c9d2"]', at: 13 });
      /* "The tooltip is rendered" is enforced by `tooltipGeometry`, which will
         not return a host of zero size and reports a host that is present but
         never laid out as exactly that.  Asserting it again here would be an
         assertion that cannot fail. */
      const geometry = await tooltipGeometry(page, name);
      /* `showRefusal` builds a `position: fixed` host through the same
         `placeTooltip`, so geometry alone cannot tell "the comment affordance
         survived this rendering condition" from "the client refused the
         selection and offered nothing" -- which is the only thing these rows
         are for. */
      assert.equal(geometry.text, "Comment", `${name}: the comment affordance is what is offered`);
      assert.ok(geometry.left >= 0 && geometry.top >= 0, `${name}: the tooltip is on screen`);
      /* The far edges, not the near ones: at 380px the clamp in `placeTooltip`
         is load-bearing, and a tooltip hanging off the right passes a `left`
         check trivially. */
      assert.ok(geometry.right <= geometry.inner.w && geometry.bottom <= geometry.inner.h,
        `${name}: the tooltip is inside the viewport: ${JSON.stringify(geometry)}`);
      assert.deepEqual(errors, [], `${name}: ${errors.join(" | ")}`);
      await context.close();
    }

    /* -- file: does nothing at all ------------------------------------ */
    {
      const root = process.env.P4A_ROOT;
      const file = join(root, "p4a-file-mode.html");
      writeFileSync(file, state.body, { mode: 0o600 });
      const context = await browser.newContext(VIEWPORT);
      const page = await context.newPage();
      const seen = [];
      page.on("request", (request) => seen.push(request.url()));
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.waitForFunction("window.__installed === true");
      await page.evaluate(() => window.__t.session());
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => window.doc.comments), undefined, "the module does not install outside http(s)");
      assert.equal(await page.evaluate(() => document.getElementById("doc-comments-toggle")), null, "no control is added");
      assert.deepEqual(seen.filter((url) => url.includes("/api/")), [], "and no request is made");
      rmSync(file, { force: true });
      await context.close();
    }

    await server.close();
    await browser.close();
  } catch (error) {
    await server.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

/* ============================================================== entry */

const SELF = fileURLToPath(import.meta.url);

async function main() {
  const flag = process.argv[2];
  if (flag === undefined) return supervise(SELF);
  if (flag === "--probe-signal") return probeSignal();
  if (flag === "--probe-hang") return probeHang();
  if (flag === "--runtime") return runtimeMatrix();
  if (flag === "--browser") return browserMatrix();
  throw new Error(`unknown argument ${flag}`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
});
