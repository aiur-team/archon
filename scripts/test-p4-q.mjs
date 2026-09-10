#!/usr/bin/env node
/**
 * P4-Q — the permanent shared-client-surface regression runner.
 *
 *   node scripts/test-p4-q.mjs
 *
 * One entry point, no public arguments, four lines of output. The supervisor
 * proves its own signal and deadline behaviour first, then launches the
 * runtime and rendered matrices as direct children, each in its own
 * mode-0700 temporary root, with a deadline, a capped capture, TERM escalated
 * to KILL, forwarded HUP/INT/TERM, a reaped child, a proof that the child's
 * process group is gone, and a guarded removal of every root before it can
 * report success.
 *
 * Nothing here reads a credential, a real repository, a remote provider or a
 * private fixture. Both matrices drive the real integrated
 * `templates/base/comments.js` -- P3-C's read path, P4-A's writes and P4-Q's
 * shared surfaces -- inside an invented loopback document. The runtime matrix
 * stubs `fetch`, the barrier and the clock so every route, deadline and
 * failure mode is exact; the rendered matrix uses the committed stylesheet and
 * real layout so geometry, ordering and environment behaviour are measured
 * rather than asserted.
 *
 * The pinned Playwright installation lives in a third mode-0700 root that both
 * workers read; installing the same pinned browser twice would cost a second
 * download and isolate nothing, since neither worker writes to it.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/* The contract's own numbers, restated here so a change to either side is a
   test failure rather than a silent agreement. */
const BARRIER_MS = 5500;
const MARKER_STEP = 24;
const OVERLAY_MAX = 50;

const DOC_ID = "4b7d2a";
const HEAD = "7aaca51";
const SUB = "reader-1";
const BLOCK_TAGS = ["p", "li", "blockquote", "h2", "h3", "pre", "td", "th", "dd", "dt", "figcaption"];

const A1 = "a31b7c9d2";
const A2 = "a44f0e1b7";
const A3 = "a5c1d2e3f";
const A4 = "a6a7b8c9d";
const A5 = "a70f1e2d3";

/* ------------------------------------------------------------ fixtures */

/* One invented document. Every identifier, name and address below is made up
   for this fixture and matches nothing outside it. */
function fixtureDocument({ docId = DOC_ID, head = HEAD, collapsed = false } = {}) {
  const rollout = collapsed
    ? `<details><summary>Rollout</summary><p data-aid="${A5}">Rollout happens in two stages.</p></details>`
    : `<p data-aid="${A5}">Rollout happens in two stages.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="doc-id" content="${docId}">
<title>Invented fixture document</title>
<style>{{CSS}}</style>
</head>
<body>
<div class="head-top"><h1>Invented fixture document</h1><button type="button" class="share-btn">Share</button></div>
<script type="application/json" id="doc-history" data-head="${head}">{}<\/script>
<main>
<section id="architecture">
<p class="sec-label">Architecture</p>
<p data-aid="${A1}">The cache key covers every input to the render.</p>
<p data-aid="${A2}">A second <strong>paragraph with <code>nested</code> text</strong> nodes.</p>
<p data-aid="${A3}">A third paragraph nobody names in an overlay.</p>
<p data-aid="${A4}">A fourth paragraph that carries a quote worth moving.</p>
</section>
<section id="rollout">
<p class="sec-label">Rollout</p>
${rollout}
</section>
</main>
</body>
</html>
`;
}

/* P1-B's exact globals: both shared fields start as null and edit is emitted
   before comments. P1-D's `norm` collapses every whitespace run to one space
   and trims the ends, which is the only property the client depends on. */
const BASE_SHIM = `
window.doc = { rail: null, panel: null };
window.doc.anchor = {
  BLOCK: ${JSON.stringify(BLOCK_TAGS)},
  norm: function (value) { return String(value).replace(/\\s+/g, " ").replace(/^ | $/g, ""); },
};
window.__timers = [];
(function () {
  var real = window.setTimeout;
  window.setTimeout = function (fn, delay) {
    window.__timers.push(delay);
    return real.apply(window, arguments);
  };
})();
`;

/* The optional P4-B seam in each of the shapes the contract names. The two
   accessor shapes record any invocation and throw: discovering the barrier
   must never read through a getter. */
function editShim(mode) {
  if (mode === "absent") return "";
  if (mode === "editAccessor") {
    return `
window.__accessed = [];
Object.defineProperty(window.doc, "edit", {
  configurable: true,
  enumerable: true,
  get: function () { window.__accessed.push("edit"); throw new Error("invented accessor"); },
});
`;
  }
  if (mode === "readyAccessor") {
    return `
window.__accessed = [];
var seam = {};
Object.defineProperty(seam, "overlaysReady", {
  configurable: true,
  enumerable: true,
  get: function () { window.__accessed.push("overlaysReady"); throw new Error("invented accessor"); },
});
window.doc.edit = Object.freeze(seam);
`;
  }
  if (mode === "notPromise") return `window.doc.edit = Object.freeze({ overlaysReady: { then: function () {} } });`;
  /* Passes `instanceof Promise` and throws synchronously out of `then()`. */
  if (mode === "promiseProto") return `window.doc.edit = Object.freeze({ overlaysReady: Object.create(Promise.prototype) });`;
  if (mode === "editNotObject") return `window.doc.edit = "not an object";`;
  const body = mode === "resolve"
    ? "window.__settle = function () { resolve(Object.freeze({ applied: Object.freeze([]), available: true })); };"
    : mode === "reject"
      ? "window.__settle = function () { reject(new Error(\"invented barrier failure\")); };"
      : "window.__settle = function () {};";
  return `
var settled = null;
var pending = new Promise(function (resolve, reject) { ${body} });
window.doc.edit = Object.freeze({ overlaysReady: pending });
void settled;
`;
}

const HELPERS = `
window.__q = {
  tokens: [],
  fired: [],
  renders: [],
  rendered: 0,
  session: function (patch) {
    var detail = Object.assign({
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
  add: function (kind, aid, label, mode) {
    var self = this;
    var token = window.doc.rail.add(kind, aid, label, function () {
      self.fired.push(label);
      if (mode === "throw") throw new Error("invented callback failure");
      if (mode === "reject") return Promise.reject(new Error("invented callback rejection"));
      if (mode === "thenable") return { then: function (ok) { ok(1); } };
      return undefined;
    });
    if (token === null) return -1;
    this.tokens.push(token);
    return this.tokens.length - 1;
  },
  tokenShape: function (index) {
    var token = this.tokens[index];
    return {
      frozen: Object.isFrozen(token),
      proto: Object.getPrototypeOf(token),
      keys: Object.getOwnPropertyNames(token).length,
      symbols: Object.getOwnPropertySymbols(token).length,
      typed: typeof token,
    };
  },
  remove: function (index) { return window.doc.rail.remove(this.tokens[index]); },
  removeValue: function (value) { return window.doc.rail.remove(value); },
  place: function () { return window.doc.rail.place(); },
  markers: function () {
    var rail = document.getElementById("doc-comments-rail");
    if (rail === null) return [];
    return [].map.call(rail.children, function (node) {
      return {
        cls: node.getAttribute("class"),
        label: node.getAttribute("aria-label"),
        text: node.textContent,
        hidden: node.hidden === true,
        top: node.style.top,
        thread: node.getAttribute("data-thread-id"),
        type: node.getAttribute("type"),
        tag: node.localName,
      };
    });
  },
  placed: function () {
    var rail = document.getElementById("doc-comments-rail");
    if (rail === null) return [];
    return [].filter.call(rail.children, function (node) { return !node.hidden; })
      .map(function (node) {
        return {
          kind: node.classList.contains("doc-rail-suggestion") ? "suggestion" : "comment",
          label: node.getAttribute("aria-label"),
          top: parseFloat(node.style.top),
        };
      })
      .sort(function (a, b) { return a.top - b.top; });
  },
  register: function (mode) {
    var self = this;
    return window.doc.panel.register("suggestion", function (mount, aid) {
      self.rendered += 1;
      self.renders.push({
        aid: aid,
        connected: mount.isConnected,
        empty: mount.childNodes.length === 0,
        cls: mount.getAttribute("class"),
        tag: mount.localName,
        element: mount instanceof HTMLElement,
        beforeEmpty: mount.nextElementSibling !== null
          && mount.nextElementSibling.classList.contains("doc-comments-empty"),
        afterGroups: mount.previousElementSibling === null
          || mount.previousElementSibling.classList.contains("doc-comments-group"),
      });
      if (mode === "throw") throw new Error("invented renderer failure");
      if (mode === "reject") return Promise.reject(new Error("invented renderer rejection"));
      if (mode === "async") return Promise.resolve(1);
      var card = document.createElement("p");
      card.className = "doc-suggest-card";
      card.textContent = aid === null ? "every block" : "block " + aid;
      mount.appendChild(card);
      return undefined;
    });
  },
  registerValue: function (kind, value) { return window.doc.panel.register(kind, value); },
  panelRefresh: function () { return window.doc.panel.refresh(); },
  open: function (aid) { return window.doc.panel.open(aid); },
  filter: function (label) {
    var groups = document.querySelectorAll("#doc-comments-filters [role=group]");
    for (var g = 0; g < groups.length; g += 1) {
      var buttons = groups[g].querySelectorAll("button");
      for (var b = 0; b < buttons.length; b += 1) {
        if (buttons[b].textContent === label) { buttons[b].click(); return true; }
      }
    }
    return false;
  },
  pressed: function (group) {
    var groups = document.querySelectorAll("#doc-comments-filters [role=group]");
    for (var g = 0; g < groups.length; g += 1) {
      if (groups[g].getAttribute("aria-label") !== group) continue;
      return [].map.call(groups[g].querySelectorAll("button"), function (node) {
        return node.textContent + ":" + node.getAttribute("aria-pressed");
      });
    }
    return null;
  },
  panelOrder: function () {
    var list = document.getElementById("doc-comments-list");
    if (list === null) return [];
    return [].map.call(list.children, function (node) {
      return node.getAttribute("class") + (node.hidden ? "[hidden]" : "");
    });
  },
  visibleCards: function () {
    var out = [];
    var items = document.querySelectorAll("#doc-comments-list .doc-comments-group > ul > li");
    for (var i = 0; i < items.length; i += 1) {
      if (items[i].hidden) continue;
      var article = items[i].firstElementChild;
      out.push(article.getAttribute("data-thread-id"));
    }
    return out;
  },
  extension: function () {
    var node = document.querySelector(".doc-panel-extension");
    if (node === null) return null;
    return { text: node.textContent, children: node.children.length, connected: node.isConnected };
  },
  emptyNote: function () {
    var node = document.querySelector(".doc-comments-empty");
    return node === null ? null : { text: node.textContent, hidden: node.hidden === true };
  },
  overlay: function (shape) {
    var detail = window.__q.detail(shape);
    document.dispatchEvent(new CustomEvent("doc:overlay", { detail: detail }));
  },
  detail: function (shape) {
    if (shape.raw !== undefined) return shape.raw;
    var aids = shape.aids.slice();
    if (shape.looseArray === true) return Object.freeze({ aids: aids });
    if (shape.extraKey === true) return Object.freeze({ aids: Object.freeze(aids), extra: 1 });
    if (shape.accessor === true) {
      var host = {};
      Object.defineProperty(host, "aids", {
        enumerable: true, configurable: false,
        get: function () { window.__q.coerced = true; return Object.freeze(aids); },
      });
      return Object.freeze(host);
    }
    if (shape.symbol === true) {
      var withSymbol = { aids: Object.freeze(aids) };
      withSymbol[Symbol("invented")] = 1;
      return Object.freeze(withSymbol);
    }
    if (shape.sparse === true) {
      var sparse = new Array(2);
      sparse[0] = aids[0];
      return Object.freeze({ aids: Object.freeze(sparse) });
    }
    if (shape.arrayExtra === true) {
      var extra = aids.slice();
      extra.note = "invented";
      return Object.freeze({ aids: Object.freeze(extra) });
    }
    if (shape.loose === true) return { aids: Object.freeze(aids) };
    if (shape.subclass === true) {
      var sub = Object.create(Array.prototype);
      var made = Object.assign(sub, aids);
      made.length = aids.length;
      return Object.freeze({ aids: Object.freeze(made) });
    }
    return Object.freeze({ aids: Object.freeze(aids) });
  },
  paint: function (aid, text) {
    var block = document.querySelector('[data-aid="' + aid + '"]');
    block.textContent = text;
  },
  paintNested: function (aid, before, mid, after) {
    var block = document.querySelector('[data-aid="' + aid + '"]');
    block.textContent = "";
    block.appendChild(document.createTextNode(before));
    var em = document.createElement("em");
    em.appendChild(document.createTextNode(mid));
    block.appendChild(em);
    block.appendChild(document.createTextNode(after));
  },
  dropBlock: function (aid) {
    var block = document.querySelector('[data-aid="' + aid + '"]');
    block.parentNode.removeChild(block);
  },
  states: function () {
    var out = {};
    var cards = document.querySelectorAll("#doc-comments-list article[data-thread-id]");
    for (var i = 0; i < cards.length; i += 1) {
      var note = cards[i].querySelector(".doc-comments-state");
      out[cards[i].getAttribute("data-thread-id")] = note === null ? "exact" : note.textContent;
    }
    return out;
  },
  highlights: function () {
    var registry = window.CSS && window.CSS.highlights;
    if (!registry) return null;
    var open = registry.get("doc-comments-open");
    var active = registry.get("doc-comments-active");
    var count = function (set) {
      if (!set) return 0;
      var n = 0;
      set.forEach(function () { n += 1; });
      return n;
    };
    var texts = [];
    if (open) open.forEach(function (range) { texts.push(range.toString()); });
    return { open: count(open), active: count(active), texts: texts.sort() };
  },
  statusText: function () {
    var node = document.getElementById("doc-comments-status");
    return node === null ? null : node.textContent;
  },
  active: function () {
    var node = document.activeElement;
    if (node === null) return null;
    return { tag: node.localName, id: node.id, label: node.getAttribute("aria-label"), text: (node.textContent || "").slice(0, 40) };
  },
};
`;

const FETCH_STUB = `
window.__calls = [];
window.__list = { threads: [], nextCursor: null };
window.__first = null;
window.fetch = function (input, init) {
  var options = init || {};
  if (window.__first === null) window.__first = performance.now();
  window.__calls.push({ url: String(input), method: options.method });
  return Promise.resolve({
    status: 200,
    json: function () { return Promise.resolve(JSON.parse(JSON.stringify(window.__list))); },
  });
};
`;

function fixturePage(scripts, options = {}) {
  const css = options.css === true ? readFileSync(COMMENTS_CSS, "utf8") : "";
  const html = fixtureDocument(options).replace("{{CSS}}", () => css);
  const source = readFileSync(COMMENTS_JS, "utf8");
  const head = scripts.filter((code) => code !== "").map((code) => `<script>${code}<\/script>`).join("\n");
  return html.replace("</body>", `${head}
<script type="module">${source}<\/script>
<script type="module">window.__installed = true;<\/script>
</body>`);
}

/* ---------------------------------------------------------- thread data */

const actor = (sub = SUB, name = "Invented Reader") => ({ sub, name, email: "reader@invented.example" });

function fixtureThread(id, anchor, overrides = {}) {
  return Object.assign({
    v: 1,
    id,
    docId: DOC_ID,
    kind: anchor === null ? "discussion" : "comment",
    status: "open",
    section: "architecture",
    anchor,
    title: anchor === null ? "An invented discussion" : null,
    docVersion: HEAD,
    createdAt: "2026-01-02T03:04:05.000Z",
    author: actor(),
    resolvedAt: null,
    resolvedBy: null,
    comments: [{
      id: `c_m8x2k1_${id.slice(-8)}`,
      body: "Could we name the invalidation case?",
      author: actor(),
      createdAt: "2026-01-02T03:04:05.000Z",
      editedAt: null,
    }],
  }, overrides);
}

const quote = (block, exact, prefix, suffix, start) => ({ block, exact, prefix, suffix, start });

const T1 = "t_m8x2k1_4f7a9c31";
const T2 = "t_m8x2k2_4f7a9c32";
const T3 = "t_m8x2k3_4f7a9c33";
const T4 = "t_m8x2k4_4f7a9c34";

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
    this.parts.push(text.length > room ? text.slice(0, room) : text);
    this.length += Math.min(text.length, room);
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

    let giveUpTimer = null;
    const timer = setTimeout(() => {
      expired = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS);
      /* SIGKILL cannot be caught, so this only fires when the escalation
         itself is broken.  Reporting that is the whole point: a supervisor
         whose last resort does not work must fail the run, not hang it. */
      giveUpTimer = setTimeout(() => {
        for (const [name, handler] of forwarded) process.removeListener(name, handler);
        resolve({
          code: 125,
          signal: null,
          stdout: out.toString(),
          stderr: `${err.toString()}child ${child.pid} outlived TERM and KILL\n`,
          orphaned: true,
        });
      }, KILL_GRACE_MS * 2);
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
    child.on("error", (error) => { err.push(Buffer.from(`spawn failed: ${error.message}\n`)); });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (giveUpTimer !== null) clearTimeout(giveUpTimer);
      for (const [name, handler] of forwarded) process.removeListener(name, handler);
      const resolved = expired ? 124 : code !== null ? code : 128 + (SIGNALS[signal] || 0);
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
    if (result.code !== 128 + number) fail(`P4-Q ${name} probe expected ${128 + number}`, result);
    if (result.orphaned) fail(`P4-Q ${name} probe left its process group behind`, result);
  }

  const hung = await runChild([self, "--probe-hang"], { deadline: HANG_DEADLINE_MS });
  if (hung.code !== 124) fail("P4-Q deadline probe expected 124", hung);
  if (hung.signal !== "SIGTERM") fail("P4-Q deadline probe expected a TERM stop", hung);
  if (hung.orphaned) fail("P4-Q deadline probe left its process group behind", hung);

  /* A child that ignores TERM has to be escalated.  The probe above dies on
     TERM by default disposition, so it can never reach the KILL timer and
     cannot prove the escalation exists. */
  const stubborn = await runChild([self, "--probe-stubborn"], { deadline: HANG_DEADLINE_MS });
  if (stubborn.code !== 124) fail("P4-Q stubborn probe expected 124", stubborn);
  if (stubborn.signal !== "SIGKILL") fail("P4-Q stubborn probe expected TERM escalated to KILL", stubborn);
  if (stubborn.orphaned) fail("P4-Q stubborn probe left its process group behind", stubborn);

  /* Forwarding is a property of the supervisor, not of the probe: signalling
     the child directly only proves the child's own handler.  This probe runs
     one supervisor of its own, signals *itself*, and reports what its
     grandchild exited with. */
  const forwarded = await runChild([self, "--probe-forward"], { deadline: PROBE_DEADLINE_MS });
  if (forwarded.code !== 0) fail("P4-Q forwarding probe failed", forwarded);
  if (forwarded.stdout !== "forwarded:143\n") fail("P4-Q forwarding probe did not relay TERM to its child", forwarded);
  if (forwarded.orphaned) fail("P4-Q forwarding probe left its process group behind", forwarded);
}

async function installPlaywright(root) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify({
    name: "p4q-fixture",
    private: true,
    version: "0.0.0",
    type: "module",
  })}\n`, { mode: 0o600 });

  const npm = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const install = await runChild([npm, "install", "--no-save", "--no-audit", "--no-fund", "--silent", PLAYWRIGHT], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { npm_config_yes: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  });
  if (install.code !== 0) fail(`P4-Q could not install ${PLAYWRIGHT}`, install);

  const browsers = await runChild([join(root, "node_modules", "playwright", "cli.js"), "install", "chromium"], {
    deadline: INSTALL_DEADLINE_MS,
    cwd: root,
    env: { PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
  });
  if (browsers.code !== 0) fail("P4-Q could not install the pinned browser", browsers);
}

async function supervise(self) {
  await proveSupervision(self);
  process.stdout.write("PASS  P4-Q supervisor signals and deadline\n");

  sweepStaleTempRoots(["p4q-install-", "p4q-runtime-", "p4q-browser-"]);
  const install = guardedTempRoot("p4q-install-");
  const roots = [install];
  const uninstallSignalCleanup = installSignalCleanup(roots, { exitAfterCleanup: false });
  try {
    await installPlaywright(install);
    for (const [flag, prefix, line] of [
      ["--runtime", "p4q-runtime-", "PASS  P4-Q rail, panel, barrier, and overlay matrix"],
      ["--browser", "p4q-browser-", "PASS  P4-Q rendered shared surface and overlay ordering"],
    ]) {
      const root = guardedTempRoot(prefix);
      roots.push(root);
      const result = await runChild([self, flag], {
        deadline: WORKER_DEADLINE_MS,
        cwd: root,
        env: {
          P4Q_INSTALL: install,
          /* Playwright puts each launch's user-data-dir in `os.tmpdir()`, so
             pointing the worker's temporary directory at its own guarded root
             is what actually keeps the browser profile inside it. */
          TMPDIR: root,
          P4Q_ROOT: root,
          PLAYWRIGHT_BROWSERS_PATH: join(install, "browsers"),
        },
      });
      if (result.code !== 0) fail(`P4-Q worker ${flag}`, result);
      if (result.orphaned) fail(`P4-Q worker ${flag} left its process group behind`, result);
      /* The contract fixes this runner's whole output, so a worker that exits
         0 while narrating to either stream is a failure, not a success. */
      if (result.stderr !== "") fail(`P4-Q worker ${flag} wrote to stderr`, result);
      if (result.stdout !== "") fail(`P4-Q worker ${flag} wrote to stdout`, result);
      process.stdout.write(`${line}\n`);
    }
  } finally {
    uninstallSignalCleanup();
    removeTempRoots(roots);
  }
  /* Printing the line is not the evidence; the roots being gone is. */
  const left = roots.filter((root) => existsSync(root));
  if (left.length !== 0) fail(`P4-Q left fixture state behind: ${left.join(", ")}`);
  process.stdout.write("PASS  P4-Q fixture cleaned\n");
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

/* Ignores TERM on purpose, so only the KILL escalation can stop it. */
function probeStubborn() {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

/* One supervisor over one grandchild.  It signals itself and must relay that
   to the group it started; 143 is the grandchild's TERM exit. */
async function probeForward(self) {
  let signalled = false;
  const result = await runChild([self, "--probe-signal"], {
    deadline: PROBE_DEADLINE_MS,
    onLine: (line) => {
      if (line === "ready" && !signalled) {
        signalled = true;
        process.kill(process.pid, "SIGTERM");
      }
    },
  });
  process.stdout.write(`forwarded:${result.code}\n`);
}

/* ============================================================== workers */

/* Both matrices need a real origin: the client builds every endpoint from
   `location.href` and does not install at all outside http(s). */
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
  const root = process.env.P4Q_INSTALL;
  if (typeof root !== "string" || root === "") throw new Error("P4Q_INSTALL is not set");
  const entry = pathToFileURL(join(root, "node_modules", "playwright", "index.js")).href;
  const module = await import(entry);
  const api = module.chromium !== undefined ? module : module.default;
  return api.chromium;
}

function html(response, body) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

async function withBrowser(run) {
  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const host = { body: "", origin: "" };
  const server = await serve((request, response) => html(response, host.body));
  host.origin = server.origin;
  try {
    await run(browser, host);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/* One page per scenario, so no assertion inherits another's state. */
async function withPage(browser, host, { scripts, options = {}, contextOptions = undefined }, run) {
  host.body = fixturePage(scripts, options);
  const context = contextOptions === undefined ? null : await browser.newContext(contextOptions);
  const page = context === null ? await browser.newPage() : await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.goto(`${host.origin}/`, { waitUntil: "load" });
    await page.waitForFunction("window.__installed === true");
    await run(page);
  } finally {
    await page.close();
    if (context !== null) await context.close();
  }
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join(" | ")}`);
}

/* Reveal the session and wait for P3-C's first list to settle. */
async function activate(page, threads = []) {
  await page.evaluate((threads) => {
    window.__list = { threads, nextCursor: null };
    window.__q.session();
  }, threads);
  await page.waitForFunction(() => {
    const node = document.getElementById("doc-comments-status");
    return node !== null && /threads? loaded\./.test(node.textContent);
  }, null, { timeout: 20_000 });
}

const openPanel = async (page) => {
  await page.click("#doc-comments-toggle");
  await page.waitForSelector("#doc-comments-panel:not([hidden])");
};

const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/* A manual clock, installed before comments.js so the 5.5-second guard can be
   driven to 5,499 and 5,500 milliseconds exactly rather than waited out. Every
   other timer this client sets is queued in the same list, which is fine: the
   barrier scenarios never depend on one. */
const CLOCK_SHIM = `
window.__realTimeout = window.setTimeout.bind(window);
window.__clock = { now: 0, seq: 0, queue: [] };
window.setTimeout = function (fn, delay) {
  window.__clock.seq += 1;
  var id = window.__clock.seq;
  var args = [].slice.call(arguments, 2);
  window.__clock.queue.push({ id: id, at: window.__clock.now + (delay || 0), fn: fn, args: args });
  return id;
};
window.clearTimeout = function (id) {
  window.__clock.queue = window.__clock.queue.filter(function (task) { return task.id !== id; });
};
window.__clock.advance = function (ms) {
  var target = window.__clock.now + ms;
  for (;;) {
    var due = window.__clock.queue.filter(function (task) { return task.at <= target; });
    if (due.length === 0) break;
    due.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
    var task = due[0];
    window.__clock.queue = window.__clock.queue.filter(function (other) { return other !== task; });
    window.__clock.now = task.at;
    task.fn.apply(null, task.args);
  }
  window.__clock.now = target;
};
window.__clock.delays = function () {
  return window.__clock.queue.map(function (task) { return task.at - window.__clock.now; });
};
`;

/* Let every queued microtask and the stubbed fetch settle without giving the
   manual clock any time. */
async function flush(page, rounds = 4) {
  for (let round = 0; round < rounds; round += 1) {
    await page.evaluate(() => new Promise((done) => {
      const later = window.__realTimeout || window.setTimeout;
      later(done, 0);
    }));
  }
}

/* `pageerror` reports uncaught exceptions, not unhandled rejections, so
   without this probe "the rejection was contained" is indistinguishable from
   "the rejection was ignored by the harness". */
const REJECTION_PROBE = `
window.__rejections = [];
window.addEventListener("unhandledrejection", function (event) {
  window.__rejections.push(String(event.reason));
  event.preventDefault();
});
`;

const RUNTIME_SCRIPTS = [BASE_SHIM, REJECTION_PROBE, FETCH_STUB, HELPERS];

/* An unhandled rejection is delivered in a later task than the one that
   created it, so give it one before reading the log. */
async function rejections(page) {
  await flush(page, 2);
  return page.evaluate(() => window.__rejections);
}

const q = (page, fn, ...args) => page.evaluate(fn, ...args);

/* `All` is a visible label in both filter groups, so every click here names
   the group it means. */
const choose = (page, group, label) => page.evaluate(([name, text]) => {
  for (const candidate of document.querySelectorAll("#doc-comments-filters [role=group]")) {
    if (candidate.getAttribute("aria-label") !== name) continue;
    for (const button of candidate.querySelectorAll("button")) {
      if (button.textContent === text) { button.click(); return true; }
    }
  }
  return false;
}, [group, label]);

/* --------------------------------------------------------- thread data */

const THREADS = () => [
  fixtureThread(T1, quote(A1, "cache key", "The ", " covers", 4)),
  fixtureThread(T2, quote(A2, "nested", "with ", " text", 24)),
  fixtureThread(T3, quote(A4, "a quote worth moving", "carries ", ".", 33)),
  fixtureThread(T4, null),
];

const SYNTH = (index) => `ac${index.toString(16).padStart(7, "0")}`;

async function addSyntheticBlocks(page, count) {
  await page.evaluate((n) => {
    const main = document.querySelector("main");
    const section = document.createElement("section");
    section.id = "synthetic";
    const label = document.createElement("p");
    label.className = "sec-label";
    label.textContent = "Synthetic";
    section.appendChild(label);
    for (let i = 0; i < n; i += 1) {
      const block = document.createElement("p");
      block.setAttribute("data-aid", `ac${i.toString(16).padStart(7, "0")}`);
      block.textContent = `Synthetic block holds quote number ${i} here.`;
      section.appendChild(block);
    }
    main.appendChild(section);
  }, count);
}

/* ======================================================= runtime matrix */

/* --- publication ------------------------------------------------------- */

async function publicationScenarios(browser, host) {
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    const shape = await q(page, () => {
      const describe = (surface) => ({
        frozen: Object.isFrozen(surface),
        proto: Object.getPrototypeOf(surface) === Object.prototype,
        keys: Object.getOwnPropertyNames(surface).sort(),
        symbols: Object.getOwnPropertySymbols(surface).length,
        slots: Object.getOwnPropertyNames(surface).sort().map((key) => {
          const slot = Object.getOwnPropertyDescriptor(surface, key);
          return {
            key,
            type: typeof slot.value,
            writable: slot.writable,
            configurable: slot.configurable,
            frozen: Object.isFrozen(slot.value),
          };
        }),
      });
      return {
        rail: describe(window.doc.rail),
        panel: describe(window.doc.panel),
        comments: {
          frozen: Object.isFrozen(window.doc.comments),
          keys: Object.getOwnPropertyNames(window.doc.comments),
        },
      };
    });

    assert.deepEqual(shape.rail.keys, ["add", "place", "remove"]);
    assert.deepEqual(shape.panel.keys, ["open", "refresh", "register"]);
    assert.deepEqual(shape.comments.keys, ["refresh"], "window.doc.comments stays exactly {refresh}");
    assert.equal(shape.comments.frozen, true);
    for (const surface of [shape.rail, shape.panel]) {
      assert.equal(surface.frozen, true);
      assert.equal(surface.proto, true);
      assert.equal(surface.symbols, 0);
      for (const slot of surface.slots) {
        assert.equal(slot.type, "function", slot.key);
        assert.equal(slot.writable, false, slot.key);
        assert.equal(slot.configurable, false, slot.key);
        assert.equal(slot.frozen, true, slot.key);
      }
    }

    /* Nothing throws through the public boundary before the UI exists. */
    const early = await q(page, () => ({
      add: window.doc.rail.add("suggestion", "a31b7c9d2", "1 suggestion", function () {}),
      remove: window.doc.rail.remove(null),
      place: window.doc.rail.place(),
      refresh: window.doc.panel.refresh(),
      open: window.doc.panel.open("a31b7c9d2"),
      register: window.doc.panel.register("suggestion", function () {}),
    }));
    assert.deepEqual(early, {
      add: null, remove: false, place: undefined, refresh: undefined, open: false, register: true,
    });
  });

  /* A field another owner already holds is never replaced, and this module
     returns before any UI, listener or request. */
  for (const field of ["rail", "panel"]) {
    const claim = `window.doc.${field} = Object.freeze({ mine: true });`;
    await withPage(browser, host, { scripts: [BASE_SHIM, claim, FETCH_STUB, HELPERS] }, async (page) => {
      const state = await q(page, (name) => ({
        kept: window.doc[name].mine === true,
        other: window.doc[name === "rail" ? "panel" : "rail"],
        comments: window.doc.comments === undefined,
        toggle: document.getElementById("doc-comments-toggle") === null,
        rail: document.getElementById("doc-comments-rail") === null,
        calls: window.__calls.length,
      }), field);
      assert.deepEqual(state, {
        kept: true, other: null, comments: true, toggle: true, rail: true, calls: 0,
      });
    });
  }
}

/* --- the rail ---------------------------------------------------------- */

async function railScenarios(browser, host) {
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());

    const refusals = await q(page, (aid) => {
      const ok = function () {};
      const add = window.doc.rail.add;
      return {
        kindMissing: add(undefined, aid, "1 suggestion", ok),
        kindWrong: add("Suggestion", aid, "1 suggestion", ok),
        kindObject: add({ toString: function () { return "suggestion"; } }, aid, "1 suggestion", ok),
        aidShort: add("suggestion", "a31b7c9d", "1 suggestion", ok),
        aidUpper: add("suggestion", "A31B7C9D2", "1 suggestion", ok),
        aidUnknown: add("suggestion", "affffffff", "1 suggestion", ok),
        aidObject: add("suggestion", { toString: function () { return aid; } }, "1 suggestion", ok),
        labelEmpty: add("suggestion", aid, "", ok),
        labelNewline: add("suggestion", aid, "1 suggestion\n2", ok),
        labelReturn: add("suggestion", aid, "1 suggestion\r2", ok),
        labelTab: add("suggestion", aid, "1\tsuggestion", ok),
        labelDelete: add("suggestion", aid, "1 suggestion\u007f", ok),
        labelC1: add("suggestion", aid, "1 suggestion\u0085", ok),
        labelLone: add("suggestion", aid, "1 suggestion\ud800", ok),
        labelLong: add("suggestion", aid, "s".repeat(161), ok),
        labelNumber: add("suggestion", aid, 1, ok),
        clickMissing: add("suggestion", aid, "1 suggestion", undefined),
        clickObject: add("suggestion", aid, "1 suggestion", { call: function () {} }),
        aidDuplicated: (function () {
          /* The contract wants one *unique* connected block, so an aid that
             now names two elements is not addressable. */
          var twin = document.createElement("p");
          twin.setAttribute("data-aid", "a5c1d2e3f");
          twin.textContent = "A duplicate of the third paragraph.";
          document.querySelector("main").appendChild(twin);
          var refused = add("suggestion", "a5c1d2e3f", "1 suggestion", ok);
          twin.parentNode.removeChild(twin);
          return refused;
        }()),
        aidDetached: (function () {
          var block = document.querySelector('[data-aid="a6a7b8c9d"]');
          var parent = block.parentNode;
          var next = block.nextSibling;
          parent.removeChild(block);
          var refused = add("suggestion", "a6a7b8c9d", "1 suggestion", ok);
          parent.insertBefore(block, next);
          return refused;
        }()),
      };
    }, A1);
    for (const [name, value] of Object.entries(refusals)) assert.equal(value, null, `rail.add rejects ${name}`);
    assert.notEqual(await q(page, () => document.getElementById("doc-comments-rail")), null,
      "the rail exists, so an empty marker list means refusal and not a missing rail");
    assert.deepEqual(await q(page, () => window.__q.markers().filter((m) => m.cls.includes("doc-rail-suggestion"))), []);

    /* 160 scalars is the boundary, not 160 UTF-16 units. */
    const boundary = await q(page, (aid) => ({
      at160: window.doc.rail.add("suggestion", aid, "\u{1f4dd}".repeat(160), function () {}) !== null,
      at161: window.doc.rail.add("suggestion", "a44f0e1b7", "\u{1f4dd}".repeat(161), function () {}) !== null,
    }), A1);
    assert.deepEqual(boundary, { at160: true, at161: false });

    const token = await q(page, () => {
      window.__q.token = window.doc.rail.add("suggestion", "a44f0e1b7", "3 suggestions", function () {});
      return {
        frozen: Object.isFrozen(window.__q.token),
        proto: Object.getPrototypeOf(window.__q.token),
        names: Object.getOwnPropertyNames(window.__q.token).length,
        symbols: Object.getOwnPropertySymbols(window.__q.token).length,
        type: typeof window.__q.token,
      };
    });
    assert.deepEqual(token, { frozen: true, proto: null, names: 0, symbols: 0, type: "object" });

    /* One suggestion marker per aid, whatever the count says. */
    assert.equal(await q(page, () => window.doc.rail.add("suggestion", "a44f0e1b7", "4 suggestions", function () {})), null);
    /* A comment marker beside it is a second entry, not a replacement -- and
       it is placed whole-block, because a caller's marker carries no thread
       entry and must not be hidden forever for want of one. */
    assert.notEqual(await q(page, () => window.doc.rail.add("comment", "a44f0e1b7", "1 message", function () {})), null);
    await settle(page);
    const foreign = await q(page, () => window.__q.markers().filter((marker) => marker.label === "1 message"));
    assert.equal(foreign.length, 1);
    assert.equal(foreign[0].hidden, false, "a caller's comment marker is placed, not hidden");
    assert.equal(foreign[0].top !== "" && Number.isFinite(parseFloat(foreign[0].top)), true,
      "a caller's comment marker gets a real position");

    await settle(page);
    const drawn = await q(page, () => window.__q.markers());
    const suggestion = drawn.filter((marker) => marker.cls === "doc-comment-marker doc-rail-suggestion");
    const comment = drawn.filter((marker) => marker.cls === "doc-comment-marker doc-rail-comment");
    assert.equal(suggestion.length, 2, "one suggestion marker per aid, on two blocks");
    assert.equal(comment.length, 4, "three comment markers plus the added one");
    assert.deepEqual(
      suggestion.map((marker) => [marker.tag, marker.type]),
      [["button", "button"], ["button", "button"]],
    );

    /* `1 suggestion` draws a 1; a label without a leading count draws an empty
       circle and keeps its complete accessible name. */
    const labels = await q(page, () => {
      window.doc.rail.add("suggestion", "a5c1d2e3f", "1 suggestion", function () {});
      window.doc.rail.add("suggestion", "a6a7b8c9d", "Suggestions here", function () {});
      return window.__q.markers()
        .filter((marker) => marker.cls.includes("doc-rail-suggestion"))
        .map((marker) => [marker.label, marker.text]);
    });
    assert.deepEqual(
      labels.filter((pair) => pair[0].length < 40).sort(),
      [["1 suggestion", "1"], ["3 suggestions", "3"], ["Suggestions here", ""]],
    );

    /* The glyph is the label's own leading digits, however many there are. */
    const wide = await q(page, () => {
      const block = document.createElement("p");
      block.setAttribute("data-aid", "ab1c2d3e4");
      block.textContent = "A block with a great many suggestions on it.";
      document.querySelector("main").appendChild(block);
      window.doc.rail.add("suggestion", "ab1c2d3e4", "1000 suggestions", function () {});
      const found = window.__q.markers().filter((marker) => marker.label === "1000 suggestions");
      return found.length === 1 ? found[0].text : null;
    });
    assert.equal(wide, "1000", "a four-digit count is not silently blanked");

    /* The rail hosts both kinds now, and says so. */
    assert.equal(
      await q(page, () => document.getElementById("doc-comments-rail").getAttribute("aria-label")),
      "Comment and suggestion locations",
    );

    /* Only the exact identity this controller returned names an entry. */
    const removal = await q(page, () => ({
      foreign: window.doc.rail.remove(Object.freeze(Object.create(null))),
      nullValue: window.doc.rail.remove(null),
      undefinedValue: window.doc.rail.remove(undefined),
      string: window.doc.rail.remove("a44f0e1b7"),
      first: window.doc.rail.remove(window.__q.token),
      repeat: window.doc.rail.remove(window.__q.token),
    }));
    assert.deepEqual(removal, {
      foreign: false, nullValue: false, undefinedValue: false, string: false, first: true, repeat: false,
    });
    assert.equal(await q(page, () => window.__q.markers().filter((m) => m.label === "3 suggestions").length), 0);

    /* `place()` schedules; it never returns a value. */
    assert.equal(await q(page, () => window.doc.rail.place()), undefined);
  });

  /* A callback that throws, rejects or returns a thenable is contained, and no
     page error escapes -- `withPage` fails the run on any uncaught page error. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    const added = await q(page, () => [
      window.__q.add("suggestion", "a31b7c9d2", "1 suggestion", "throw"),
      window.__q.add("suggestion", "a44f0e1b7", "2 suggestions", "reject"),
      window.__q.add("suggestion", "a5c1d2e3f", "3 suggestions", "thenable"),
    ]);
    assert.deepEqual(added, [0, 1, 2]);
    await q(page, () => {
      const rail = document.getElementById("doc-comments-rail");
      for (const button of rail.querySelectorAll(".doc-rail-suggestion")) button.click();
    });
    await settle(page);
    assert.deepEqual(await q(page, () => window.__q.fired),
      ["1 suggestion", "2 suggestions", "3 suggestions"]);
    assert.equal(await q(page, () => window.__q.markers().filter((m) => m.cls.includes("doc-rail-suggestion")).length), 3);
    assert.deepEqual(await rejections(page), [],
      "a rejecting callback is contained, not merely unobserved");
  });

  /* A collapsed section hides both kinds; opening it shows both again. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS, options: { collapsed: true } }, async (page) => {
    await activate(page, [fixtureThread(T1, quote(A5, "two stages", "in ", ".", 20))]);
    await q(page, () => { window.doc.rail.add("suggestion", "a70f1e2d3", "1 suggestion", function () {}); });
    await settle(page);
    assert.deepEqual(await q(page, () => window.__q.markers().map((m) => m.hidden)), [true, true]);
    await q(page, () => { document.querySelector("details").open = true; });
    await settle(page);
    assert.deepEqual(await q(page, () => window.__q.markers().map((m) => m.hidden)), [false, false]);
  });
}

/* --- the panel --------------------------------------------------------- */

async function panelScenarios(browser, host) {
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);

    const registration = await q(page, () => ({
      wrongKind: window.__q.registerValue("comment", function () {}),
      missingKind: window.__q.registerValue(undefined, function () {}),
      coercedKind: window.__q.registerValue({ toString: function () { return "suggestion"; } }, function () {}),
      notFunction: window.__q.registerValue("suggestion", {}),
      nullFn: window.__q.registerValue("suggestion", null),
    }));
    assert.deepEqual(registration, {
      wrongKind: false, missingKind: false, coercedKind: false, notFunction: false, nullFn: false,
    });
    assert.equal(await q(page, () => window.__q.extension()), null, "no extension before a renderer");

    assert.equal(await q(page, () => window.__q.register("card")), true, "first registration wins");
    assert.equal(await q(page, () => window.__q.register("throw")), false, "duplicate registration is refused");

    /* All: comments first, then one connected empty section, then the panel's
       own empty note. */
    const all = await q(page, () => ({
      order: window.__q.panelOrder(),
      renders: window.__q.renders,
      extension: window.__q.extension(),
    }));
    assert.deepEqual(all.order.slice(-2), ["doc-panel-extension", "doc-comments-empty[hidden]"]);
    assert.equal(all.order.indexOf("doc-comments-group") >= 0, true, "a comment group is present to order against");
    assert.equal(all.order.indexOf("doc-panel-extension") > all.order.lastIndexOf("doc-comments-group"), true,
      "the extension is rendered after every comment group");
    const last = all.renders[all.renders.length - 1];
    assert.deepEqual(
      [last.aid, last.connected, last.empty, last.cls, last.tag, last.element, last.beforeEmpty, last.afterGroups],
      [null, true, true, "doc-panel-extension", "section", true, true, true],
    );
    assert.equal(all.extension.text, "every block");

    /* Every kind value, and only Suggestions suppresses the comment list. */
    for (const [label, expectExtension, expectCards] of [
      ["Anchored", false, true],
      ["Discussions", false, true],
      ["Suggestions", true, false],
      ["All", true, true],
    ]) {
      assert.equal(await choose(page, "Kind", label), true, label);
      const view = await q(page, () => ({
        extension: window.__q.extension(),
        cards: window.__q.visibleCards(),
        empty: window.__q.emptyNote(),
      }));
      assert.equal(view.extension !== null, expectExtension, `${label} extension`);
      assert.equal(view.cards.length > 0, expectCards, `${label} comment cards`);
      if (label === "Suggestions") assert.equal(view.empty.hidden, true, "Suggestions never claims no comment matched");
    }
    assert.deepEqual(await q(page, () => window.__q.pressed("Kind")),
      ["Anchored:false", "Discussions:false", "Suggestions:false", "All:true"]);

    /* Status filters comments only.  Pin the extension's whole shape, not just
       its existence: a status filter that emptied or hid the suggestion cards
       inside it would leave the section standing. */
    const untouched = { text: "every block", children: 1, connected: true };
    for (const label of ["Open", "Resolved", "All"]) {
      assert.equal(await choose(page, "Status", label), true, label);
      assert.deepEqual(await q(page, () => window.__q.extension()), untouched,
        `${label} leaves the suggestion cards alone`);
      assert.equal(await q(page, () => {
        const node = document.querySelector(".doc-panel-extension .doc-suggest-card");
        return node === null ? null : node.hidden;
      }), false, `${label} does not hide a suggestion card`);
    }
    assert.deepEqual(await q(page, () => window.__q.pressed("Status")),
      ["Open:false", "Resolved:false", "All:true"]);

    /* open(): validation, the All view, the block filter, and comment-first
       order for one block. */
    const opened = await q(page, (aid) => ({
      wrong: window.doc.panel.open("nope"),
      unknown: window.doc.panel.open("affffffff"),
      undef: window.doc.panel.open(undefined),
      valid: window.doc.panel.open(aid),
    }), A1);
    assert.deepEqual(opened, { wrong: false, unknown: false, undef: false, valid: true });
    const focused = await q(page, () => ({
      pressed: window.__q.pressed("Kind"),
      cards: window.__q.visibleCards(),
      renders: window.__q.renders[window.__q.renders.length - 1],
      extension: window.__q.extension(),
      order: window.__q.panelOrder(),
    }));
    assert.deepEqual(focused.pressed, ["Anchored:false", "Discussions:false", "Suggestions:false", "All:true"]);
    assert.deepEqual(focused.cards, [T1], "only the named block's comment threads");
    assert.equal(focused.renders.aid, A1, "the renderer is told which block");
    assert.equal(focused.extension.text, `block ${A1}`);
    assert.equal(focused.order.indexOf("doc-comments-group") >= 0, true, "a comment group is present to order against");
    assert.equal(focused.order.indexOf("doc-panel-extension") > focused.order.lastIndexOf("doc-comments-group"), true,
      "comment threads render above suggestion cards for one block");

    /* Any kind click takes the panel back from open(). */
    assert.equal(await choose(page, "Kind", "All"), true);
    assert.equal((await q(page, () => window.__q.visibleCards())).length > 1, true, "the block filter cleared");
    assert.equal(await q(page, () => window.doc.panel.open(null)), true, "exact null clears the filter");

    /* refresh() repaints and reads nothing. */
    const before = await q(page, () => window.__calls.length);
    assert.equal(await q(page, () => window.doc.panel.refresh()), undefined);
    await settle(page);
    assert.equal(await q(page, () => window.__calls.length), before, "panel.refresh() issues no request");
    assert.notEqual(await q(page, () => window.__q.extension()), null);
  });

  /* No renderer: Suggestions shows the exact safe empty text and nothing else. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    assert.equal(await q(page, () => window.__q.extension()), null, "All shows no extension without a renderer");
    assert.equal(await choose(page, "Kind", "Suggestions"), true);
    assert.deepEqual(await q(page, () => window.__q.extension()),
      { text: "Suggestions are unavailable.", children: 1, connected: true });
  });

  /* A renderer that throws loses only its section. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    assert.equal(await q(page, () => window.__q.register("throw")), true);
    const after = await q(page, () => ({
      extension: window.__q.extension(),
      cards: window.__q.visibleCards(),
      rendered: window.__q.rendered > 0,
    }));
    assert.equal(after.extension, null, "the failed section is removed");
    assert.equal(after.rendered, true);
    assert.equal(after.cards.length > 0, true, "the comments beside it stay usable");
    assert.equal(await q(page, () => window.doc.panel.refresh()), undefined);
    assert.equal(await q(page, () => window.__q.visibleCards().length > 0), true);
  });

  /* A renderer that repaints from inside its own repaint must be refused,
     not recursed until the stack gives out. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    const registered = await q(page, () => {
      window.__q.reentered = 0;
      return window.doc.panel.register("suggestion", function (mount) {
        window.__q.reentered += 1;
        window.doc.panel.refresh();
        mount.appendChild(document.createElement("p"));
        return undefined;
      });
    });
    assert.equal(registered, true);
    await settle(page);
    const nested = await q(page, () => ({
      reentered: window.__q.reentered,
      extension: window.__q.extension(),
      cards: window.__q.visibleCards().length,
    }));
    assert.equal(nested.reentered, 1, "the nested repaint was refused rather than recursed");
    assert.notEqual(nested.extension, null, "the section survives");
    assert.equal(nested.cards > 0, true, "the comments beside it stay usable");
    assert.deepEqual(await rejections(page), []);
    /* And an ordinary repaint from outside still works afterwards. */
    assert.equal(await q(page, () => window.doc.panel.refresh()), undefined);
    assert.equal(await q(page, () => window.__q.reentered), 2);
  });

  /* A thenable return is misuse: it is not awaited and the section goes. */
  for (const mode of ["reject", "async"]) {
    await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
      await activate(page, THREADS());
      await openPanel(page);
      assert.equal(await q(page, (name) => window.__q.register(name), mode), true);
      await settle(page);
      assert.equal(await q(page, () => window.__q.extension()), null, `${mode} renderer keeps no section`);
      assert.equal(await q(page, () => window.__q.visibleCards().length > 0), true);
      assert.deepEqual(await rejections(page), [],
        `a ${mode} renderer's rejection is contained, not merely unobserved`);
    });
  }
}

/* --- the optional barrier ---------------------------------------------- */

async function barrierScenarios(browser, host) {
  /* An accessor at either level is a foreign object shaped like the seam. It
     is refused without ever being read, and the comments load immediately. */
  for (const mode of ["editAccessor", "readyAccessor"]) {
    await withPage(browser, host, {
      scripts: [BASE_SHIM, editShim(mode), FETCH_STUB, HELPERS],
    }, async (page) => {
      await activate(page, THREADS());
      assert.deepEqual(await q(page, () => window.__accessed), [], `${mode} was never invoked`);
      assert.equal((await q(page, () => window.__q.states()))[T1], "exact");
    });
  }

  /* An absent seam, a non-object seam and a thenable that is not a genuine
     Promise all refresh immediately. */
  for (const mode of ["absent", "editNotObject", "notPromise", "promiseProto"]) {
    await withPage(browser, host, {
      scripts: [BASE_SHIM, REJECTION_PROBE, CLOCK_SHIM, editShim(mode), FETCH_STUB, HELPERS],
    }, async (page) => {
      await q(page, (threads) => { window.__list = { threads, nextCursor: null }; window.__q.session(); }, THREADS());
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length > 0), true, `${mode} refreshes without waiting`);
      assert.equal(await q(page, () => window.__clock.delays().includes(5500)), false,
        `${mode} arms no barrier guard`);
      /* A seam that only looks like a Promise must be refused, not awaited and
         not thrown through: the whole comments read hangs off this call. */
      assert.equal(await q(page, () => window.__q.states()[Object.keys(window.__q.states())[0]]), "exact",
        `${mode} still resolves anchors`);
      assert.deepEqual(await rejections(page), [], `${mode} leaves no unhandled rejection`);
    });
  }

  /* The guard is exactly 5,500 ms and no anchor is resolved before it.  Only
     the never-settling shape belongs here; a barrier that does settle is
     released by its settlement, which is a different property, below. */
  for (const mode of ["never"]) {
    await withPage(browser, host, {
      scripts: [BASE_SHIM, REJECTION_PROBE, CLOCK_SHIM, editShim(mode), FETCH_STUB, HELPERS],
    }, async (page) => {
      await q(page, (threads) => { window.__list = { threads, nextCursor: null }; window.__q.session(); }, THREADS());
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length), 0, `${mode}: no read before the barrier`);
      assert.equal(await q(page, () => window.__clock.delays().includes(5500)), true,
        `${mode}: the guard is armed at exactly 5,500 ms`);
      assert.equal(await q(page, () => document.getElementById("doc-comments-rail")), null,
        `${mode}: no UI before the barrier`);

      /* A caller of the public seam joins the same readiness Promise instead
         of resolving anchors early. */
      await q(page, () => { window.__q.joined = null; window.doc.comments.refresh().then(() => { window.__q.joined = true; }); });
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length), 0, `${mode}: refresh() joined the barrier`);
      assert.equal(await q(page, () => window.__q.joined), null);

      await q(page, () => { window.__clock.advance(5499); });
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length), 0, `${mode}: nothing at 5,499 ms`);

      await q(page, () => { window.__clock.advance(1); });
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length > 0), true, `${mode}: read at 5,500 ms`);
      assert.equal(await q(page, () => window.__q.joined), true, "the joined caller resolved after the barrier");
      assert.equal((await q(page, () => window.__q.states()))[T1], "exact");
    });
  }

  /* A barrier that settles before the guard is not waited out -- and a
     *rejected* barrier releases the read exactly like a fulfilled one, with
     its failure ignored rather than escaping. */
  for (const mode of ["resolve", "reject"]) {
    await withPage(browser, host, {
      scripts: [BASE_SHIM, REJECTION_PROBE, CLOCK_SHIM, editShim(mode), FETCH_STUB, HELPERS],
    }, async (page) => {
      await q(page, (threads) => { window.__list = { threads, nextCursor: null }; window.__q.session(); }, THREADS());
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length), 0, `${mode}: nothing before settlement`);
      await q(page, () => { window.__settle(); });
      await flush(page);
      assert.equal(await q(page, () => window.__calls.length > 0), true, `${mode}: settlement releases the read at once`);
      assert.equal(await q(page, () => window.__clock.now), 0, `${mode}: no clock time was needed`);
      assert.equal((await q(page, () => window.__q.states()))[T1], "exact", `${mode}: anchors resolved`);
      assert.deepEqual(await rejections(page), [], `${mode}: the barrier's own failure is ignored, not leaked`);
    });
  }
}

/* --- the overlay event -------------------------------------------------- */

async function overlayScenarios(browser, host) {
  /* Every malformed shape does nothing at all: the text under a thread is
     already changed, so a thread that stays `exact` proves nothing was
     re-resolved and no getter was coerced. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    assert.equal((await q(page, () => window.__q.states()))[T1], "exact");
    await q(page, (aid) => { window.__q.paint(aid, "The rendering identity covers every input."); }, A1);

    const shapes = [
      ["null detail", { raw: null }],
      ["string detail", { raw: "a31b7c9d2" }],
      ["array detail", { raw: Object.freeze([]) }],
      ["unfrozen detail", { aids: [A1], loose: true }],
      ["unfrozen array", { aids: [A1], looseArray: true }],
      ["extra key", { aids: [A1], extraKey: true }],
      ["accessor aids", { aids: [A1], accessor: true }],
      ["symbol key", { aids: [A1], symbol: true }],
      ["sparse array", { aids: [A1], sparse: true }],
      ["array extra key", { aids: [A1], arrayExtra: true }],
      ["array subclass", { aids: [A1], subclass: true }],
      ["empty aids", { aids: [] }],
      ["duplicate aids", { aids: [A1, A1] }],
      ["unsorted aids", { aids: [A2, A1] }],
      ["invalid aid", { aids: ["A31B7C9D2"] }],
      ["unknown aid", { aids: ["affffffff"] }],
    ];
    for (const [name, shape] of shapes) {
      await q(page, (value) => { window.__q.overlay(value); }, shape);
      await flush(page, 2);
      assert.equal((await q(page, () => window.__q.states()))[T1], "exact", `${name} does no work`);
    }
    /* Two shapes cannot survive the structured clone that carries a shape
       across, so they are built in the page instead: a non-string member, and
       an accessor at the *index* level rather than on `aids` itself. */
    await q(page, () => {
      document.dispatchEvent(new CustomEvent("doc:overlay", {
        detail: Object.freeze({ aids: Object.freeze([1]) }),
      }));
    });
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "exact", "a non-string aid does no work");

    await q(page, (aid) => {
      const aids = [];
      Object.defineProperty(aids, "0", {
        enumerable: true,
        configurable: false,
        get: function () { window.__q.indexCoerced = true; return aid; },
      });
      aids.length = 1;
      document.dispatchEvent(new CustomEvent("doc:overlay", {
        detail: Object.freeze({ aids: Object.freeze(aids) }),
      }));
    }, A1);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "exact", "an indexed accessor does no work");
    assert.equal(await q(page, () => window.__q.indexCoerced), undefined, "no indexed getter was invoked");
    assert.equal(await q(page, () => window.__q.coerced), undefined, "no getter was invoked");

    /* A non-bubbling event on a block never reaches the document listener. */
    await q(page, (aid) => {
      const detail = Object.freeze({ aids: Object.freeze([aid]) });
      document.querySelector(`[data-aid="${aid}"]`)
        .dispatchEvent(new CustomEvent("doc:overlay", { detail, bubbles: false }));
    }, A1);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "exact",
      "the overlay signal is a document event");

    /* The exact shape is accepted and only then is the anchor re-resolved. */
    const calls = await q(page, () => window.__calls.length);
    await q(page, (aid) => { window.__q.overlay({ aids: [aid] }); }, A1);
    await flush(page, 2);
    const after = await q(page, () => ({
      states: window.__q.states(), calls: window.__calls.length,
    }));
    assert.equal(after.states[T1], "Text changed", "the affected thread was re-resolved");
    assert.equal(after.states[T2], "exact", "an unnamed present block keeps its location");
    assert.equal(after.states[T3], "exact");
    assert.equal(after.calls, calls, "no HTTP request occurs");
  });

  /* All four transitions, including the missing-block inclusion. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);

    await q(page, (aid) => {
      window.__q.paint(aid, "The rendering identity covers every input.");
      window.__q.overlay({ aids: [aid] });
    }, A1);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "Text changed");

    /* The home block is gone and the quote now lives, uniquely, elsewhere: a
       thread whose block is absent from the rebuilt index is re-run too. */
    await q(page, (aids) => {
      window.__q.paint(aids[1], "Rollout happens in two stages once the cache key settles.");
      window.__q.dropBlock(aids[0]);
      window.__q.overlay({ aids: [aids[1]] });
    }, [A1, A5]);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "Moved from its original block");

    await q(page, (aid) => {
      window.__q.paint(aid, "Rollout happens in two stages.");
      window.__q.overlay({ aids: [aid] });
    }, A5);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "Not attached any more");

    /* A present home block wins over a unique match elsewhere. */
    await q(page, (aids) => {
      window.__q.paint(aids[0], "A third paragraph carries a quote worth moving now.");
      window.__q.paint(aids[1], "A fourth paragraph that carries nothing in particular.");
      window.__q.overlay({ aids: aids });
    }, [A3, A4].sort());
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T3], "Text changed",
      "the home block is consulted first even when the quote moved");

    /* No discussion card and no thread record changed. */
    const discussion = await q(page, (id) => {
      const card = document.querySelector(`article[data-thread-id="${id}"]`);
      return card === null ? null : card.querySelector("h4").textContent;
    }, T4);
    assert.equal(discussion, "An invented discussion", "discussion cards are unchanged");
  });

  /* Highlights are deleted and recreated rather than reused, and the panel's
     focus survives the repaint. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    const before = await q(page, () => window.__q.highlights());
    assert.notEqual(before, null, "the Custom Highlight API is available here");
    assert.equal(before.texts.includes("cache key"), true);
    assert.equal(before.texts.includes("nested"), true);

    await q(page, (aid) => {
      document.getElementById("doc-comments-close").focus();
      window.__q.paintNested(aid, "A second ", "renamed", " span of text nodes.");
      window.__q.overlay({ aids: [aid] });
    }, A2);
    await flush(page, 2);
    const after = await q(page, () => ({ highlights: window.__q.highlights(), active: window.__q.active() }));
    assert.equal(after.highlights.texts.includes("nested"), false, "the stale range is gone");
    assert.equal(after.highlights.texts.includes("cache key"), true, "an untouched range is still painted");
    assert.equal(after.active.id, "doc-comments-close", "panel focus is preserved across the repaint");
  });

  /* Without the Custom Highlight API the client decorates whole blocks with a
     class instead.  That is a second, independent branch of `paintDecoration`,
     and an overlay has to repair it exactly like the registries. */
  await withPage(browser, host, {
    scripts: [BASE_SHIM, REJECTION_PROBE, "window.Highlight = undefined;", FETCH_STUB, HELPERS],
  }, async (page) => {
    await activate(page, THREADS());
    await openPanel(page);
    const decorated = () => q(page, () => [].map.call(
      document.querySelectorAll(".doc-comment-block"), (node) => node.getAttribute("data-aid")).sort());

    assert.equal(await q(page, () => typeof window.Highlight), "undefined",
      "the Highlight constructor is genuinely absent here");
    assert.deepEqual(await q(page, () => window.__q.highlights()), { open: 0, active: 0, texts: [] },
      "nothing was painted into the registries");
    assert.deepEqual(await decorated(), [A1, A2, A4].sort(), "every open live thread decorates its block");

    /* Move T1: its home block goes and the quote turns up, uniquely, in A5. */
    await q(page, (aids) => {
      window.__q.paint(aids[1], "Rollout happens in two stages once the cache key settles.");
      window.__q.dropBlock(aids[0]);
      window.__q.overlay({ aids: [aids[1]] });
    }, [A1, A5]);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "Moved from its original block");
    assert.deepEqual(await decorated(), [A2, A4, A5].sort(),
      "the fallback follows the repaired anchors instead of stranding a class");

    /* Orphan it: no block may keep a stale decoration. */
    await q(page, (aid) => {
      window.__q.paint(aid, "Rollout happens in two stages.");
      window.__q.overlay({ aids: [aid] });
    }, A5);
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "Not attached any more");
    assert.deepEqual(await decorated(), [A2, A4].sort(), "an orphaned thread decorates nothing");
    assert.deepEqual(await rejections(page), []);
  });

  /* Bounds and coalescing, on a document with enough named blocks to reach
     them honestly. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await addSyntheticBlocks(page, 61);
    const threads = [
      fixtureThread(T1, quote(SYNTH(0), "quote number 0", "holds ", " here.", 20)),
      fixtureThread(T2, quote(SYNTH(50), "quote number 50", "holds ", " here.", 20)),
      fixtureThread(T3, quote(SYNTH(59), "quote number 59", "holds ", " here.", 20)),
    ];
    await activate(page, threads);
    await openPanel(page);
    assert.deepEqual(await q(page, () => window.__q.states()), { [T1]: "exact", [T2]: "exact", [T3]: "exact" });

    /* All 61 exist, so the two over-bound cases are refused by the bound and
       not incidentally by an unknown aid. */
    const aids = Array.from({ length: 61 }, (unused, index) => SYNTH(index));
    await q(page, (list) => {
      for (const aid of list) window.__q.paint(aid, "Synthetic block now holds nothing nameable.");
    }, [SYNTH(0), SYNTH(50), SYNTH(59)]);

    for (const [name, batch] of [["61 aids", aids], ["51 aids", aids.slice(0, 51)]]) {
      await q(page, (list) => { window.__q.overlay({ aids: list }); }, batch);
      await flush(page, 2);
      assert.deepEqual(await q(page, () => window.__q.states()), { [T1]: "exact", [T2]: "exact", [T3]: "exact" },
        `${name} is over the bound and does nothing`);
    }

    await q(page, (list) => { window.__q.overlay({ aids: list }); }, aids.slice(0, 50));
    await flush(page, 2);
    let states = await q(page, () => window.__q.states());
    assert.equal(states[T1], "Text changed", "50 aids is the accepted bound");
    assert.equal(states[T2], "exact", "an unnamed present block is untouched");
    assert.equal(states[T3], "exact", "an unnamed present block is untouched");

    /* Two events in one task become one microtask with the sorted union; a
       union past the bound queues a second finite batch and loses no aid. */
    await q(page, (lists) => {
      window.__q.overlay({ aids: lists[0] });
      window.__q.overlay({ aids: lists[1] });
    }, [aids.slice(0, 30), aids.slice(30, 60)]);
    await flush(page, 3);
    states = await q(page, () => window.__q.states());
    assert.equal(states[T2], "Text changed", "the first batch reconciled");
    assert.equal(states[T3], "Text changed", "the queued remainder past the bound reconciled too");

    /* One aid is still a valid batch. */
    await q(page, (aid) => {
      window.__q.paint(aid, "Synthetic block holds quote number 0 here.");
      window.__q.overlay({ aids: [aid] });
    }, SYNTH(0));
    await flush(page, 2);
    assert.equal((await q(page, () => window.__q.states()))[T1], "exact", "a one-aid batch is valid");
  });

  /* An overlay before the session builds nothing. */
  await withPage(browser, host, { scripts: RUNTIME_SCRIPTS }, async (page) => {
    await q(page, (aid) => { window.__q.overlay({ aids: [aid] }); }, A1);
    await flush(page, 2);
    assert.equal(await q(page, () => document.getElementById("doc-comments-rail")), null,
      "an overlay before the session builds no UI");
  });
}

async function runtimeMatrix() {
  await withBrowser(async (browser, host) => {
    await publicationScenarios(browser, host);
    await railScenarios(browser, host);
    await panelScenarios(browser, host);
    await barrierScenarios(browser, host);
    await overlayScenarios(browser, host);
  });
}

/* ======================================================= browser matrix */

const RENDERED = { css: true };

const quoteBox = (page, text) => page.evaluate((needle) => {
  const set = window.CSS.highlights.get("doc-comments-open");
  let box = null;
  if (set) set.forEach((range) => { if (range.toString() === needle) box = range.getBoundingClientRect(); });
  return box === null ? null : { left: box.left, top: box.top, width: box.width };
}, text);

async function browserMatrix() {
  await withBrowser(async (browser, host) => {
    /* Applied overlay text precedes the first anchor resolution: the barrier
       holds the read, the page paints, and only then is any Range built. */
    await withPage(browser, host, {
      scripts: [BASE_SHIM, editShim("resolve"), FETCH_STUB, HELPERS], options: RENDERED,
    }, async (page) => {
      await q(page, (threads) => { window.__list = { threads, nextCursor: null }; window.__q.session(); }, THREADS());
      await settle(page);
      const held = await q(page, () => ({
        calls: window.__calls.length,
        highlights: window.__q.highlights(),
        rail: document.getElementById("doc-comments-rail"),
      }));
      assert.equal(held.calls, 0, "comments wait for the pending overlay");
      assert.deepEqual(held.highlights, { open: 0, active: 0, texts: [] }, "no Range exists before settlement");
      assert.equal(held.rail, null);

      await q(page, (aid) => {
        window.__q.paint(aid, "The cache key covers every input to the render, exactly once.");
        window.__settle();
      }, A1);
      await page.waitForFunction(() => window.__calls.length > 0, null, { timeout: 20000 });
      await settle(page);
      const resolved = await q(page, () => ({
        highlights: window.__q.highlights(), states: window.__q.states(),
      }));
      assert.equal(resolved.states[T1], "exact", "the first resolution saw the applied text");
      assert.equal(resolved.highlights.texts.includes("cache key"), true);
    });

    /* A later overlay across nested text nodes produces fresh, correct
       geometry rather than a reused stale Range. */
    await withPage(browser, host, { scripts: RUNTIME_SCRIPTS, options: RENDERED }, async (page) => {
      await activate(page, THREADS());
      await openPanel(page);
      const before = await quoteBox(page, "nested");
      assert.notEqual(before, null);
      assert.equal(before.width > 0, true);

      await q(page, (aid) => {
        window.__q.paintNested(aid, "A far longer second paragraph carrying a ", "nested", " run of text nodes.");
        window.__q.overlay({ aids: [aid] });
      }, A2);
      await flush(page, 2);
      await settle(page);
      const after = await quoteBox(page, "nested");
      assert.notEqual(after, null, "the quote is painted again after the overlay");
      assert.equal(after.width > 0, true, "the recreated range has real geometry");
      assert.notEqual(Math.round(after.left), Math.round(before.left),
        "the geometry follows the new text rather than the stale range");
    });

    /* Two kinds on one block are two entries, in document order, comments
       first, pushed apart by exactly the declutter step. */
    await withPage(browser, host, { scripts: RUNTIME_SCRIPTS, options: RENDERED }, async (page) => {
      await activate(page, THREADS());
      await q(page, (aid) => { window.doc.rail.add("suggestion", aid, "2 suggestions", function () {}); }, A1);
      await settle(page);
      const placed = await q(page, () => window.__q.placed());
      assert.equal(placed.length >= 2, true);
      assert.equal(placed[0].kind, "comment", "a comment marker precedes the suggestion on one block");
      assert.equal(placed[1].kind, "suggestion");
      for (let at = 1; at < placed.length; at += 1) {
        assert.equal(placed[at].top - placed[at - 1].top >= MARKER_STEP - 0.5, true,
          `every pair is pushed apart by ${MARKER_STEP} pixels`);
      }
    });

    /* One block: comment threads above suggestion cards, and the keyboard
       reaches both. */
    await withPage(browser, host, { scripts: RUNTIME_SCRIPTS, options: RENDERED }, async (page) => {
      await activate(page, THREADS());
      assert.equal(await q(page, () => window.__q.register("card")), true);
      await q(page, (aid) => { window.doc.panel.open(aid); }, A1);
      await settle(page);
      const geometry = await q(page, () => {
        const list = document.getElementById("doc-comments-list");
        const panel = document.getElementById("doc-comments-panel");
        const card = list.querySelector(".doc-comments-group");
        const extension = list.querySelector(".doc-panel-extension");
        return {
          hidden: panel.hidden,
          cardTop: card.getBoundingClientRect().top,
          extensionTop: extension.getBoundingClientRect().top,
          extensionWidth: extension.getBoundingClientRect().width,
          panelWidth: panel.getBoundingClientRect().width,
          overflow: list.scrollWidth <= list.clientWidth + 1,
        };
      });
      assert.equal(geometry.hidden, false, "open(aid) opened the existing panel");
      assert.equal(geometry.extensionTop > geometry.cardTop, true, "comments render above suggestions");
      assert.equal(geometry.extensionWidth <= geometry.panelWidth, true, "the extension keeps the panel's width");
      assert.equal(geometry.overflow, true, "the extension does not force the panel to scroll sideways");

      await page.keyboard.press("Tab");
      assert.equal(
        await q(page, () => document.getElementById("doc-comments-panel").contains(document.activeElement)),
        true,
        "the panel keeps keyboard focus after the extension rendered",
      );
      await page.keyboard.press("Escape");
      assert.equal(await q(page, () => document.getElementById("doc-comments-panel").hidden), true,
        "Escape still closes the panel");
    });

    /* Zoom, a narrow viewport, and every environment the contract names. A
       wide layout has to leave both kinds drawn, labelled, one shape and
       inside the page; P3-C's narrow layout drops the rail entirely, and the
       panel with the extension in it has to carry the reader instead. */
    const environments = [
      /* Browser zoom shrinks the CSS viewport, it does not change the device
         pixel ratio: 200% on an ordinary 1280-pixel window is 640 CSS pixels,
         which is inside P3-C's narrow layout.  The separate 2x entry keeps the
         device-pixel-ratio case honest at a width that still has a rail. */
      ["200% zoom", { viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 }, false],
      ["2x device pixels", { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 }, true],
      ["narrow", { viewport: { width: 360, height: 720 } }, false],
      ["light", { colorScheme: "light" }, true],
      ["dark", { colorScheme: "dark" }, true],
      ["reduced motion", { reducedMotion: "reduce" }, true],
      ["forced colors", { forcedColors: "active" }, true],
    ];
    for (const [name, contextOptions, railed] of environments) {
      await withPage(browser, host, {
        scripts: RUNTIME_SCRIPTS, options: RENDERED, contextOptions,
      }, async (page) => {
        await activate(page, THREADS());
        assert.equal(await q(page, () => window.__q.register("card")), true);
        await q(page, (aid) => { window.doc.rail.add("suggestion", aid, "2 suggestions", function () {}); }, A1);
        await settle(page);
        const view = await q(page, () => {
          const rail = document.getElementById("doc-comments-rail");
          const suggestion = rail.querySelector(".doc-rail-suggestion");
          const box = suggestion.getBoundingClientRect();
          const style = getComputedStyle(suggestion);
          const comment = getComputedStyle(rail.querySelector(".doc-rail-comment"));
          return {
            railDisplay: getComputedStyle(rail).display,
            label: suggestion.getAttribute("aria-label"),
            hidden: suggestion.hidden,
            width: box.width,
            height: box.height,
            right: box.right,
            documentWidth: document.documentElement.scrollWidth,
            borderWidth: style.borderTopWidth,
            sameShape: style.borderTopWidth === comment.borderTopWidth
              && style.borderRadius === comment.borderRadius
              && style.width === comment.width,
            distinct: style.borderTopColor !== comment.borderTopColor,
          };
        });
        /* The accessible name and the registry entry survive either layout. */
        assert.equal(view.hidden, false, `${name}: the suggestion marker is registered and placed`);
        assert.equal(view.label, "2 suggestions", `${name}: the accessible name is complete`);
        assert.equal(view.sameShape, true, `${name}: both kinds keep one border, radius and size`);

        if (!railed) {
          assert.equal(view.railDisplay, "none", `${name}: P3-C's narrow layout drops the rail`);
          await openPanel(page);
          assert.deepEqual(await rejections(page), []);
          const panelled = await q(page, () => ({
            cards: window.__q.visibleCards().length,
            extension: window.__q.extension(),
            overflow: document.getElementById("doc-comments-list").scrollWidth
              <= document.getElementById("doc-comments-list").clientWidth + 1,
          }));
          assert.equal(panelled.cards > 0, true, `${name}: comments are still reachable in the panel`);
          assert.notEqual(panelled.extension, null, `${name}: so is the extension`);
          assert.equal(panelled.overflow, true, `${name}: the extension does not widen the panel`);
          return;
        }

        assert.equal(view.railDisplay !== "none", true, `${name}: the rail is drawn`);
        assert.equal(view.width > 0 && view.height > 0, true, `${name}: the marker has a box`);
        assert.equal(view.right <= view.documentWidth + 1, true, `${name}: the marker stays inside the page`);
        if (name === "forced colors") {
          assert.equal(view.borderWidth, "1px", "forced colours keeps a visible border");
        } else {
          assert.equal(view.distinct, true, `${name}: the kinds differ in ordinary colour`);
        }
        if (name === "reduced motion") {
          await openPanel(page);
          const still = await q(page, () => {
            const read = (node) => {
              const style = getComputedStyle(node);
              return [style.animationDuration, style.transitionDuration];
            };
            return {
              marker: read(document.querySelector(".doc-rail-suggestion")),
              panel: read(document.getElementById("doc-comments-panel")),
              extension: read(document.querySelector(".doc-panel-extension")),
            };
          });
          for (const [where, pair] of Object.entries(still)) {
            assert.deepEqual(pair, ["0s", "0s"], `reduced motion: ${where} animates nothing`);
          }
        }
      });
    }

    /* Print. The panel and rail are the reader's chrome, not the document. */
    await withPage(browser, host, { scripts: RUNTIME_SCRIPTS, options: RENDERED }, async (page) => {
      await activate(page, THREADS());
      assert.equal(await q(page, () => window.__q.register("card")), true);
      await q(page, (aid) => { window.doc.rail.add("suggestion", aid, "2 suggestions", function () {}); }, A1);
      await page.emulateMedia({ media: "print" });
      await settle(page);
      const printed = await q(page, (aid) => ({
        rail: getComputedStyle(document.getElementById("doc-comments-rail")).display,
        panel: getComputedStyle(document.getElementById("doc-comments-panel")).display,
        prose: document.querySelector(`[data-aid="${aid}"]`).textContent,
      }), A1);
      assert.equal(printed.rail, "none", "the rail is not printed");
      assert.equal(printed.panel, "none", "the panel is not printed");
      assert.equal(printed.prose, "The cache key covers every input to the render.",
        "no prose node was wrapped or moved");
      await page.emulateMedia({ media: null });
    });

    /* A static artifact opened from the filesystem installs nothing at all. */
    const root = process.env.P4Q_ROOT;
    assert.equal(typeof root === "string" && root !== "", true, "P4Q_ROOT is not set");
    const artifact = join(root, "artifact.html");
    writeFileSync(artifact, fixturePage(RUNTIME_SCRIPTS, RENDERED), { mode: 0o600 });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.goto(pathToFileURL(artifact).href, { waitUntil: "load" });
      await page.waitForFunction("window.__installed === true");
      const isolated = await page.evaluate((aid) => ({
        rail: window.doc.rail,
        panel: window.doc.panel,
        comments: window.doc.comments === undefined,
        toggle: document.getElementById("doc-comments-toggle") === null,
        calls: window.__calls.length,
        prose: document.querySelector(`[data-aid="${aid}"]`).textContent,
      }), A1);
      assert.deepEqual(isolated, {
        rail: null,
        panel: null,
        comments: true,
        toggle: true,
        calls: 0,
        prose: "The cache key covers every input to the render.",
      }, "file: output stays network-free and unchanged");
    } finally {
      await page.close();
      rmSync(artifact, { force: true });
    }
    assert.deepEqual(errors, [], `uncaught page errors: ${errors.join(" | ")}`);
  });
}

/* ================================================================ entry */

const SELF = fileURLToPath(import.meta.url);

function worker(run) {
  run().then(() => process.exit(0), (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

const MODE = process.argv[2];
if (MODE === "--probe-signal") probeSignal();
else if (MODE === "--probe-hang") probeHang();
else if (MODE === "--probe-stubborn") probeStubborn();
else if (MODE === "--probe-forward") worker(() => probeForward(SELF));
else if (MODE === "--runtime") worker(runtimeMatrix);
else if (MODE === "--browser") worker(browserMatrix);
else if (MODE === undefined) worker(() => supervise(SELF));
else fail(`P4-Q does not take the argument ${JSON.stringify(MODE)}`);
