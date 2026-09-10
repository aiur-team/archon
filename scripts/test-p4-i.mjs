#!/usr/bin/env node
/**
 * P4-I — the permanent editing-soft-lock regression runner.
 *
 *   node scripts/test-p4-i.mjs
 *
 * One entry point, no public arguments, four lines of output. The supervisor
 * proves its own signal and deadline behaviour first, then launches the
 * runtime and rendered matrices as direct children in their own process groups
 * under a mode-0700 temporary root, gives each a deadline, caps captured
 * output, forwards HUP/INT/TERM, escalates TERM to KILL, reaps the child,
 * proves the child's process group is gone, and removes the guarded root
 * before it can report success.
 *
 * Both matrices evaluate the two real browser scripts — `templates/base/
 * edit.js` and `templates/base/presence.js`, in P1-B's order, with P3-F's
 * transport installed between them — inside one closed VM context whose DOM,
 * clock, timers, storage, publish seam and fetch seam are all invented here.
 * Nothing reads a credential, a remote service, a real repository or a private
 * fixture, and the only network surface is the injected `fetch`.
 *
 * Deviation from the ticket's test plan, recorded on purpose: the rendered
 * matrix runs through the same deterministic DOM seam plus a parse of the
 * committed stylesheets, not a pinned Playwright install under the temporary
 * root. This follows the precedent P4-B set and accepted for the same reason —
 * nothing in CI runs this script, so a browser download would turn an offline
 * regression gate into a network dependency for the one person running it by
 * hand. A real-browser worker is the natural follow-up when an assertion needs
 * layout or paint, which none of these do.
 */

import { spawn } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const WORKER_DEADLINE_MS = 180_000;
const PROBE_DEADLINE_MS = 1_000;
const ESCALATE_MS = 2_000;
const MAX_CAPTURE_BYTES = 262_144;
const DEADLINE_CODE = 124;

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`FAIL unhandled rejection: ${reason}\n`);
  process.exit(1);
});

/* ========================================================================= */
/* assertions                                                                */
/* ========================================================================= */

let checks = 0;

function ok(condition, label) {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}`);
}

function eq(actual, expected, label) {
  checks += 1;
  if (actual === expected) return;
  const shape = (value) => {
    if (typeof value === "string") return value;
    if (value !== null && typeof value === "object") {
      return value.tagName === undefined ? "[object]" : `<${value.tagName.toLowerCase()} ${value.className}>`;
    }
    return JSON.stringify(value);
  };
  const a = shape(actual);
  const b = shape(expected);
  if (a !== b || (actual !== null && typeof actual === "object")) {
    throw new Error(`FAIL ${label}\n  actual   ${a}\n  expected ${b}`);
  }
}

/* ========================================================================= */
/* the supervisor                                                            */
/* ========================================================================= */

/** Run one direct child in its own process group with a deadline, a bounded
 * capture, TERM-then-KILL escalation, and forwarded operator signals. */
function runChild(args, deadlineMs, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    const capture = (chunks, counter, chunk) => {
      if (counter >= MAX_CAPTURE_BYTES) return counter;
      chunks.push(chunk);
      return counter + chunk.length;
    };
    child.stdout.on("data", (chunk) => {
      outBytes = capture(out, outBytes, chunk);
    });
    child.stderr.on("data", (chunk) => {
      errBytes = capture(err, errBytes, chunk);
    });

    let timedOut = false;
    let killer = null;
    const group = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone; nothing to escalate to.
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      group("SIGTERM");
      killer = setTimeout(() => group("SIGKILL"), ESCALATE_MS);
    }, deadlineMs);

    const forwarded = ["SIGHUP", "SIGINT", "SIGTERM"];
    const handlers = forwarded.map((signal) => {
      const handler = () => group(signal);
      process.on(signal, handler);
      return [signal, handler];
    });

    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (killer !== null) clearTimeout(killer);
      for (const [name, handler] of handlers) process.off(name, handler);
      resolve({
        code: timedOut ? DEADLINE_CODE : (code === null ? 128 + signalNumber(signal) : code),
        signal,
        pid: child.pid,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function signalNumber(name) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
  return table[name] ?? 0;
}

/** The child's process group must be gone once it has been reaped. */
function groupIsGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

async function supervise() {
  const root = mkdtempSync(join(tmpdir(), "p4i-"));
  chmodSync(root, 0o700);
  try {
    // 1. Signals. Each probe installs its own handler and exits 128 + signum.
    for (const [signal, expected] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
      const probeRoot = join(root, `signal-${signal}`);
      mkdirSync(probeRoot, { mode: 0o700 });
      const started = runChild(["--signal-probe"], WORKER_DEADLINE_MS, {}, probeRoot);
      const pid = await waitForReady(probeRoot);
      process.kill(-pid, signal);
      const result = await started;
      eq(result.code, expected, `signal probe ${signal} exit code`);
      ok(groupIsGone(result.pid), `signal probe ${signal} process group reaped`);
    }

    // 2. The deadline. A probe that ignores its work is terminated and
    //    reported as 124, exactly like the timeout utility.
    const deadlineRoot = join(root, "deadline");
    mkdirSync(deadlineRoot, { mode: 0o700 });
    const late = await runChild(["--deadline-probe"], PROBE_DEADLINE_MS, {}, deadlineRoot);
    eq(late.code, DEADLINE_CODE, "deadline probe reports 124");
    ok(groupIsGone(late.pid), "deadline probe process group reaped");
    process.stdout.write("PASS P4-I supervisor signals and deadline\n");

    // 3. The two matrices.
    for (const [mode, line] of [
      ["--runtime", "PASS P4-I claim lifecycle, lease, chip, and advisory-conflict matrix"],
      ["--rendered", "PASS P4-I rendered peer chip, focus, print, and forced-conflict behavior"],
    ]) {
      const workerRoot = join(root, mode.slice(2));
      mkdirSync(workerRoot, { mode: 0o700 });
      const result = await runChild([mode], WORKER_DEADLINE_MS, { P4I_ROOT: workerRoot }, ROOT);
      // A passing matrix worker is silent on both streams. Gating on stdout
      // too is what makes the "no console output" criterion enforceable:
      // without it, a stray console.log -- including one leaking a client ID
      // -- would print a PASS line and exit 0.
      if (result.code !== 0 || result.stderr !== "" || result.stdout !== "") {
        process.stderr.write(result.stdout);
        process.stderr.write(result.stderr);
        throw new Error(result.code === 0 && result.stderr === ""
          ? `${mode} worker wrote to stdout`
          : `${mode} worker exited ${result.code}`);
      }
      ok(groupIsGone(result.pid), `${mode} worker process group reaped`);
      process.stdout.write(`${line}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (existsSync(root)) throw new Error("FAIL guarded fixture root survived");
  process.stdout.write("PASS P4-I fixture cleaned\n");
}

/** Wait for the probe to publish its own pid, so the supervisor signals the
 * process group it actually created rather than a guessed one. */
function waitForReady(directory) {
  const marker = join(directory, "ready");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (existsSync(marker)) {
        resolve(Number.parseInt(readFileSync(marker, "utf8").trim(), 10));
        return;
      }
      if (Date.now() - started > 10_000) {
        reject(new Error("FAIL signal probe never became ready"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function signalProbe() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(128 + signalNumber(signal)));
  }
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`);
  setInterval(() => {}, 1000);
}

function deadlineProbe() {
  // Deliberately ignores TERM so the supervisor has to escalate.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

/* ========================================================================= */
/* the invented DOM                                                          */
/* ========================================================================= */

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** Decode the three references this document vocabulary uses in ONE pass, so
 * `&amp;lt;` yields `&lt;` the way a real `textContent` does. */
function stripTags(html) {
  let out = "";
  let inside = false;
  for (const character of html) {
    if (character === "<") inside = true;
    else if (character === ">") inside = false;
    else if (!inside) out += character;
  }
  return out.replace(/&(?:amp|lt|gt);/g, (entity) => ENTITIES[entity]);
}

function escapeText(text) {
  return text.split("&").join("&amp;").split("<").join("&lt;").split(">").join("&gt;");
}

class ClassList {
  constructor(element) {
    this.element = element;
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
    this.element.attributes.set("class", [...this.values].join(" "));
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
    this.element.attributes.set("class", [...this.values].join(" "));
  }

  contains(name) {
    return this.values.has(name);
  }
}

/** One compound selector: a tag, `#id`, `.class`, `[attr]` and `[attr=value]`
 * parts in any order. Nothing this pair of modules queries needs more. */
function matches(element, selector) {
  const parts = selector.match(/\[[^\]]*\]|[#.][A-Za-z0-9_-]+|^[A-Za-z]+/g) ?? [];
  for (const part of parts) {
    if (part.startsWith("[")) {
      const inner = part.slice(1, -1);
      const equals = inner.indexOf("=");
      if (equals === -1) {
        if (!element.hasAttribute(inner)) return false;
        continue;
      }
      const name = inner.slice(0, equals);
      const value = inner.slice(equals + 1).replace(/^["']|["']$/g, "");
      if (element.getAttribute(name) !== value) return false;
      continue;
    }
    if (part.startsWith("#")) {
      if (element.getAttribute("id") !== part.slice(1)) return false;
      continue;
    }
    if (part.startsWith(".")) {
      if (!element.classList.contains(part.slice(1))) return false;
      continue;
    }
    if (element.tagName !== part.toUpperCase()) return false;
  }
  return true;
}

class El {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = String(tagName).toUpperCase();
    this.localName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.listeners = new Map();
    this.style = {};
    this.disabled = false;
    this.html = "";
    this.open = true;
    this.offsetWidth = 40;
    this.rect = { top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 };
  }

  get children() {
    return this.childNodes;
  }

  get parentElement() {
    return this.parentNode;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode !== null) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }

  get nextElementSibling() {
    if (this.parentNode === null) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }

  set id(value) {
    this.setAttribute("id", value);
  }

  get title() {
    return this.getAttribute("title") ?? "";
  }

  set title(value) {
    this.setAttribute("title", value);
  }

  get className() {
    return this.attributes.get("class") ?? "";
  }

  set className(value) {
    this.attributes.set("class", String(value));
    this.classList.values = new Set(String(value).split(" ").filter(Boolean));
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value) {
    this.html = String(value);
  }

  get textContent() {
    if (this.childNodes.length > 0) {
      let out = "";
      for (const child of this.childNodes) out += child.textContent;
      return out;
    }
    return stripTags(this.html);
  }

  set textContent(value) {
    this.childNodes = [];
    this.html = escapeText(String(value));
  }

  get contentEditable() {
    const value = this.attributes.get("contenteditable");
    if (value === undefined) return "inherit";
    if (value === "plaintext-only") {
      return this.ownerDocument.supportsPlaintextOnly ? "plaintext-only" : "true";
    }
    return value;
  }

  getAttribute(name) {
    const value = this.attributes.get(name);
    return value === undefined ? null : value;
  }

  setAttribute(name, value) {
    if (name === "class") {
      this.className = String(value);
      return;
    }
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    if (name === "class") this.classList.values = new Set();
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.detach();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }

  insertBefore(node, reference) {
    node.detach();
    node.parentNode = this;
    const at = reference === null ? -1 : this.childNodes.indexOf(reference);
    if (at === -1) this.childNodes.push(node);
    else this.childNodes.splice(at, 0, node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }

  detach() {
    if (this.parentNode === null) return;
    const siblings = this.parentNode.childNodes;
    const at = siblings.indexOf(this);
    if (at !== -1) siblings.splice(at, 1);
    this.parentNode = null;
  }

  remove() {
    this.detach();
  }

  insertAdjacentElement(position, element) {
    if (position !== "afterend") throw new Error(`unsupported position ${position}`);
    if (this.parentNode === null) throw new Error("orphan insertAdjacentElement");
    element.detach();
    element.parentNode = this.parentNode;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
    return element;
  }

  descendants(into = []) {
    for (const child of this.childNodes) {
      into.push(child);
      child.descendants(into);
    }
    return into;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((element) => matches(element, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector) {
    let node = this;
    while (node !== null) {
      if (matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  }

  dispatchEvent(event) {
    event.target = this;
    for (const handler of [...(this.listeners.get(event.type) ?? [])]) handler(event);
    return true;
  }

  focus() {
    this.ownerDocument.active = this;
  }
}

function makeEvent(type, fields = {}) {
  return {
    type,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...fields,
  };
}

/** A deterministic clock plus the timers both modules schedule against it. */
function makeClock(startMs) {
  let now = startMs;
  let sequence = 1;
  const timers = new Map();
  const clock = {
    get now() {
      return now;
    },
    pending() {
      return timers.size;
    },
    setTimeout(handler, delay) {
      const id = sequence;
      sequence += 1;
      timers.set(id, { at: now + (Number(delay) || 0), every: 0, handler });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    setInterval(handler, delay) {
      const every = Number(delay) || 1;
      const id = sequence;
      sequence += 1;
      timers.set(id, { at: now + every, every, handler });
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        let due = null;
        for (const entry of timers) {
          if (entry[1].at > target) continue;
          if (due === null || entry[1].at < due[1].at) due = entry;
        }
        if (due === null) break;
        now = due[1].at;
        if (due[1].every > 0) due[1].at = now + due[1].every;
        else timers.delete(due[0]);
        due[1].handler();
      }
      now = target;
    },
  };
  return clock;
}

const AID_A = "a11111111";
const AID_B = "a22222222";
const AID_OPEN = "a33333333";
const AID_CLOSED = "a44444444";
const AID_BARE = "a55555555";
const AID_DUPE = "a66666666";
const AID_LONE = "a77777777";

const DOC_ID = "4b7d2a";
const START_MS = Date.parse("2026-09-03T17:04:11.201Z");

const TEXT_A = "The orchard index covers **every** declared basket.";
const HTML_A = "The orchard index covers <strong>every</strong> declared basket.";

const PEERS = [
  { id: "c_quill_01", label: "Avery Quill" },
  { id: "c_marsh_02", label: "Bo Marsh" },
  { id: "c_nolan_03", label: "Cy Nolan" },
];

// P3-F publishes over REST and subscribes to the same channel, so every
// message this tab sends comes back to it as an ordinary client projection.
// Presence never learns its own client id, so on the wire this is
// indistinguishable from a peer -- which is exactly why the self-echo cases
// below matter. `SELF` stands in for this tab's own token-bound client id.
const SELF = { id: "c_self_00", label: "Local Reader" };

/**
 * One closed page running both real modules in P1-B's order, with P3-F's
 * transport installed between them exactly as the generated document does.
 */
function makePage(options = {}) {
  const clock = makeClock(START_MS);
  const log = [];
  let step = 0;
  const record = (kind, value) => {
    step += 1;
    log.push({ step, kind, value });
  };

  const document = {
    active: null,
    supportsPlaintextOnly: true,
    visibilityState: options.visibilityState ?? "visible",
    listeners: new Map(),
    executed: [],
  };
  document.createElement = (tag) => new El(document, tag);
  document.addEventListener = (type, handler) => {
    if (!document.listeners.has(type)) document.listeners.set(type, []);
    document.listeners.get(type).push(handler);
    record("listen:document", type);
  };
  document.removeEventListener = (type, handler) => {
    const list = document.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  };
  document.dispatchEvent = (event) => {
    if (event.type === "doc:edit-state") record("edit-state", event.detail);
    for (const handler of [...(document.listeners.get(event.type) ?? [])]) handler(event);
    return true;
  };
  document.execCommand = (command, _show, value) => {
    document.executed.push([command, value]);
    if (command !== "insertText" || document.active === null) return false;
    document.active.textContent = document.active.textContent + value;
    return true;
  };

  // --- the tree -------------------------------------------------------------
  const html = new El(document, "html");
  html.setAttribute("data-session", "editor");
  html.scrollWidth = 900;
  document.documentElement = html;
  document.querySelectorAll = (selector) => html.querySelectorAll(selector);
  document.querySelector = (selector) => html.querySelector(selector);

  const body = new El(document, "body");
  html.appendChild(body);
  document.body = body;

  const meta = new El(document, "meta");
  meta.setAttribute("name", "doc-id");
  meta.setAttribute("content", DOC_ID);
  body.appendChild(meta);

  const head = new El(document, "div");
  head.className = "head-top";
  body.appendChild(head);
  const theme = new El(document, "button");
  theme.setAttribute("id", "tt");
  head.appendChild(theme);

  const main = new El(document, "main");
  body.appendChild(main);

  const blocks = new Map();
  const addBlock = (parent, aid, editable) => {
    const element = new El(document, "p");
    if (editable) element.setAttribute("data-editable", "");
    element.setAttribute("data-aid", aid);
    element.innerHTML = HTML_A;
    element.setAttribute("data-md", TEXT_A);
    parent.appendChild(element);
    blocks.set(aid, element);
    return element;
  };

  addBlock(main, AID_A, true);
  addBlock(main, AID_B, true);

  // Extra editable blocks so the 200-key cap can be counted one chip per key.
  for (let index = 0; index < (options.blockCount ?? 0); index += 1) {
    addBlock(main, `a5${String(index).padStart(7, "0")}`, true);
  }

  const openDetails = new El(document, "details");
  openDetails.open = true;
  main.appendChild(openDetails);
  addBlock(openDetails, AID_OPEN, true);

  const closedDetails = new El(document, "details");
  closedDetails.open = false;
  main.appendChild(closedDetails);
  addBlock(closedDetails, AID_CLOSED, true);

  // A bare block P4-B never made editable: no controls follow it.
  addBlock(main, AID_BARE, false);

  // Two blocks sharing one aid name nothing, so they name none.
  const dupeOne = new El(document, "p");
  dupeOne.setAttribute("data-aid", AID_DUPE);
  main.appendChild(dupeOne);
  const dupeTwo = new El(document, "p");
  dupeTwo.setAttribute("data-aid", AID_DUPE);
  main.appendChild(dupeTwo);

  // A block whose only sibling is prose, so no controls are adjacent.
  const lone = new El(document, "p");
  lone.setAttribute("data-aid", AID_LONE);
  main.appendChild(lone);
  blocks.set(AID_LONE, lone);
  const filler = new El(document, "p");
  main.appendChild(filler);

  // --- the seams ------------------------------------------------------------
  const published = [];
  let publishMode = options.publishMode ?? "true";
  const publish = (event) => {
    published.push(event);
    record("publish", event);
    if (publishMode === "throw") throw new Error("transport is down");
    if (publishMode === "reject") return Promise.reject(new Error("refused"));
    if (publishMode === "false") return Promise.resolve(false);
    return Promise.resolve(true);
  };

  const requests = [];
  const responder = options.responder ?? (() => ({ status: 200, body: {} }));
  const sandboxFetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    record("fetch", url);
    const answer = await responder(url, init, requests.length);
    if (answer instanceof Error) throw answer;
    const headers = new Map([["content-type", answer.contentType ?? "application/json; charset=utf-8"]]);
    const bytes = new TextEncoder().encode(JSON.stringify(answer.body));
    let sent = false;
    return {
      status: answer.status,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
        cancel: async () => {},
        releaseLock: () => {},
      }) },
      json: async () => fromJson(answer.body),
    };
  };

  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  if (options.hiddenPreference === true) store.set("doc.presence.hidden.v1", "1");

  const frames = [];
  let frameSequence = 1;

  const win = {
    doc: { rail: null, panel: null, anchor: { BLOCK: ["p"], norm: (s) => s, scanBlocks: () => [] } },
    listeners: new Map(),
  };
  win.addEventListener = (type, handler) => {
    if (!win.listeners.has(type)) win.listeners.set(type, []);
    win.listeners.get(type).push(handler);
    record("listen:window", type);
  };
  win.removeEventListener = (type, handler) => {
    const list = win.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  };

  const sandbox = {
    window: win,
    document,
    localStorage,
    location: { protocol: options.protocol ?? "https:", href: "https://docs.example.com/doc.html" },
    fetch: sandboxFetch,
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init === undefined || init === null ? null : init.detail;
        this.bubbles = init !== undefined && init !== null && init.bubbles === true;
        this.cancelable = init !== undefined && init !== null && init.cancelable === true;
        this.composed = init !== undefined && init !== null && init.composed === true;
      }
    },
    Range: class Range {},
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    crypto: webcrypto,
    // The one clock both modules read. `new Date(value)` keeps its ordinary
    // behaviour so P4-B's timestamp round-trip still works.
    Date: class extends Date {
      static now() {
        return clock.now;
      }
    },
    URL,
    console,
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    requestAnimationFrame: (fn) => {
      const id = frameSequence;
      frameSequence += 1;
      frames.push([id, fn]);
      return id;
    },
    cancelAnimationFrame: (id) => {
      const at = frames.findIndex((frame) => frame[0] === id);
      if (at !== -1) frames.splice(at, 1);
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // Every injected record has to be built with the CONTEXT's intrinsics: both
  // modules compare `Object.getPrototypeOf(detail)` against their own realm's
  // `Object.prototype`, and a host object would be rejected for the wrong
  // reason. `fromJson` is the one door values come through.
  function fromJson(value) {
    if (value === undefined) return undefined;
    return vm.runInContext(`(${JSON.stringify(value)})`, sandbox);
  }

  function frozen(value) {
    const built = fromJson(value);
    const freezeDeep = (node) => {
      if (node === null || typeof node !== "object") return node;
      for (const key of Object.keys(node)) freezeDeep(node[key]);
      return Object.freeze(node);
    };
    return freezeDeep(built);
  }

  // The three real scripts, in the generated document's own order. `edit.js`
  // evaluates before the transport exists, which is exactly why it proves the
  // publish surface lazily.
  const run = (relative) => {
    const source = readFileSync(join(ROOT, relative), "utf8");
    vm.runInContext(source, sandbox, { filename: relative });
  };

  run("templates/base/edit.js");
  if (options.realtime !== false) {
    const surface = vm.runInContext("({})", sandbox);
    Object.defineProperty(surface, "publish", {
      value: publish,
      enumerable: true,
      writable: false,
      configurable: false,
    });
    win.doc.realtime = Object.freeze(surface);
  }
  run("templates/base/presence.js");

  return {
    clock, document, win, blocks, published, requests, log, sandbox,
    frozen, fromJson,
    head, theme, main,
    flushFrames() {
      const queued = frames.splice(0, frames.length);
      for (const frame of queued) frame[1]();
    },
    setPublishMode(mode) {
      publishMode = mode;
    },
    editStates() {
      return log.filter((row) => row.kind === "edit-state").map((row) => row.value);
    },
    kinds() {
      return log.map((row) => `${row.kind}:${describe(row)}`);
    },
  };
}

function describe(row) {
  if (row.kind === "publish") return `${row.value.t}${row.value.aid === undefined ? "" : `/${row.value.aid}`}`;
  if (row.kind === "edit-state") return String(row.value.aid);
  if (row.kind === "fetch") return row.value.replace(/^https?:\/\/[^/]+/, "");
  return String(row.value);
}

const SESSION_EDITOR = {
  sub: "u_fixture_writer_31",
  email: "writer@example.com",
  name: "Dale Ferro",
  canComment: true,
  canEdit: true,
  doc: DOC_ID,
  role: "editor",
  shared: false,
  canSuggest: true,
  canAccept: false,
  canShare: false,
  canSeeMembers: true,
};

const settle = () => new Promise((resolve) => globalThis.setTimeout(resolve, 0));

async function reveal(page) {
  page.document.dispatchEvent({ type: "session", detail: page.frozen(SESSION_EDITOR) });
  for (let turn = 0; turn < 12; turn += 1) await settle();
}

/** Bring one page up with the editor attached and presence proved. */
async function startPage(options = {}) {
  const page = makePage(options);
  await reveal(page);
  return page;
}

function controlsFor(page, aid) {
  const block = page.blocks.get(aid);
  const next = block === undefined ? null : block.nextElementSibling;
  if (next === null || !next.classList.contains("doc-edit-controls")) return null;
  return next;
}

function buttonFor(page, aid) {
  const controls = controlsFor(page, aid);
  return controls === null ? null : controls.querySelector("button.doc-edit-button");
}

function chipFor(page, aid) {
  const controls = controlsFor(page, aid);
  return controls === null ? null : controls.querySelector("span.doc-edit-claim");
}

async function clickEdit(page, aid) {
  buttonFor(page, aid).dispatchEvent(makeEvent("click"));
  for (let turn = 0; turn < 4; turn += 1) await settle();
}

function beatFrom(page, peer, act = "reading", aid = null) {
  page.document.dispatchEvent({
    type: "doc:event",
    detail: page.frozen({
      source: "client", t: "beat", clientId: peer.id, label: peer.label, act, aid,
    }),
  });
}

function claimFrom(page, peer, aid, kind = "edit.claim") {
  page.document.dispatchEvent({
    type: "doc:event",
    detail: page.frozen({ source: "client", t: kind, clientId: peer.id, aid }),
  });
}

function rawEvent(page, detail) {
  page.document.dispatchEvent({ type: "doc:event", detail });
}

function firePageHide(page) {
  for (const handler of [...(page.win.listeners.get("pagehide") ?? [])]) {
    handler(makeEvent("pagehide"));
  }
}

function firePageShow(page, persisted) {
  for (const handler of [...(page.win.listeners.get("pageshow") ?? [])]) {
    handler(makeEvent("pageshow", { persisted }));
  }
}

function fireVisibility(page, state) {
  page.document.visibilityState = state;
  for (const handler of [...(page.document.listeners.get("visibilitychange") ?? [])]) {
    handler(makeEvent("visibilitychange"));
  }
}

/** Every publish the transport saw, as compact `t/aid` strings. */
function publishTrail(page) {
  return page.published.map((event) => (event.aid === undefined ? event.t : `${event.t}/${event.aid}`));
}

/* ========================================================================= */
/* the runtime matrix                                                        */
/* ========================================================================= */

async function runtimeMatrix() {
  /* ---- 1. the local lifecycle ------------------------------------------ */

  {
    const page = await startPage();
    const before = page.published.length;
    await clickEdit(page, AID_A);

    const claims = page.published.slice(before);
    eq(claims.length, 1, "focus entry publishes exactly one event");
    eq(claims[0].t, "edit.claim", "focus entry publishes a claim");
    eq(claims[0].aid, AID_A, "the claim names the focused block");
    eq(Object.keys(claims[0]).join(","), "t,aid", "the claim carries exactly t and aid");

    const states = page.editStates();
    eq(states.length, 1, "focus entry dispatches exactly one local state");
    eq(states[0].aid, AID_A, "the local state names the focused block");

    const detail = states[0];
    ok(Object.isFrozen(detail), "the local detail is frozen");
    eq(Object.getOwnPropertyNames(detail).join(","), "aid", "the local detail has exactly one key");
    eq(Object.getOwnPropertySymbols(detail).length, 0, "the local detail carries no symbol");
    const descriptor = Object.getOwnPropertyDescriptor(detail, "aid");
    ok(Object.prototype.hasOwnProperty.call(descriptor, "value"), "the local detail key is a data property");
    eq(descriptor.enumerable, true, "the local detail key is enumerable");
    eq(descriptor.writable, false, "the local detail key is not writable");
    eq(descriptor.configurable, false, "the local detail key is not configurable");

    const dispatched = page.log.find((row) => row.kind === "edit-state");
    ok(dispatched !== undefined, "the local state reached document");
  }

  {
    // Blur with a change: the release precedes the write, and the write is not
    // delayed waiting for it.
    const page = await startPage({ responder: () => ({ status: 200, body: {} }) });
    await clickEdit(page, AID_A);
    const block = page.blocks.get(AID_A);
    block.textContent = "A different sentence entirely.";
    block.dispatchEvent(makeEvent("blur"));
    eq(publishTrail(page).slice(-1)[0], `edit.release/${AID_A}`, "changed blur releases the block");
    const trail = page.kinds();
    const release = trail.lastIndexOf(`publish:edit.release/${AID_A}`);
    const post = trail.lastIndexOf("fetch:/api/edit");
    ok(release !== -1 && post !== -1 && release < post, "the release is published before the POST");
    for (let turn = 0; turn < 8; turn += 1) await settle();
  }

  {
    // A blur that changed nothing is not an edit, and still releases.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const posts = page.requests.length;
    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    eq(publishTrail(page).slice(-1)[0], `edit.release/${AID_A}`, "unchanged blur releases the block");
    eq(page.requests.length, posts, "unchanged blur sends no request");
  }

  {
    // Escape cancels, then the programmatic blur must not release twice.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const block = page.blocks.get(AID_A);
    block.dispatchEvent(makeEvent("keydown", { key: "Escape" }));
    block.dispatchEvent(makeEvent("blur"));
    const releases = publishTrail(page).filter((entry) => entry === `edit.release/${AID_A}`);
    eq(releases.length, 1, "Escape then blur publishes one release");
    eq(page.editStates().map((state) => String(state.aid)).join(","), `${AID_A},null`,
      "Escape dispatches reading exactly once");
  }

  {
    // Ctrl+Enter save releases before the request starts.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const block = page.blocks.get(AID_A);
    block.textContent = "Saved through the keyboard.";
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    const trail = page.kinds();
    ok(trail.lastIndexOf(`publish:edit.release/${AID_A}`) < trail.lastIndexOf("fetch:/api/edit"),
      "Ctrl+Enter releases before the POST");
    for (let turn = 0; turn < 8; turn += 1) await settle();
  }

  {
    // Straight from one editor to another, with no intervening blur.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const before = page.published.length;
    await clickEdit(page, AID_B);
    eq(publishTrail(page).slice(before).join(","), `edit.release/${AID_A},edit.claim/${AID_B}`,
      "switching releases the old block then claims the new one");
    eq(page.editStates().map((state) => String(state.aid)).join(","), `${AID_A},null,${AID_B}`,
      "switching dispatches reading between the two blocks");
    // The stale blur of the first block must not release the second.
    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    eq(publishTrail(page).slice(-1)[0], `edit.claim/${AID_B}`,
      "a stale blur never releases the block another editor now holds");
  }

  {
    // Pagehide: the release, then P3-G's bye, in that order.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const before = page.published.length;
    firePageHide(page);
    eq(publishTrail(page).slice(before).join(","), `edit.release/${AID_A},bye`,
      "pagehide releases before the bye");
    firePageHide(page);
    eq(publishTrail(page).slice(before).filter((entry) => entry.startsWith("edit.")).join(","),
      `edit.release/${AID_A}`,
      "a second pagehide publishes no duplicate release");
  }

  {
    // The finish sequence with nothing active does nothing at all.
    const page = await startPage();
    const before = page.published.length;
    const states = page.editStates().length;
    firePageHide(page);
    eq(publishTrail(page).slice(before).join(","), "bye", "an idle pagehide publishes only the bye");
    eq(page.editStates().length, states, "an idle finish dispatches no local state");
  }

  /* ---- 2. transport degradation ---------------------------------------- */

  for (const mode of ["false", "reject", "throw"]) {
    const page = await startPage();
    page.setPublishMode(mode);
    await clickEdit(page, AID_A);
    const block = page.blocks.get(AID_A);
    block.dispatchEvent(makeEvent("blur"));
    eq(publishTrail(page).slice(-2).join(","), `edit.claim/${AID_A},edit.release/${AID_A}`,
      `a ${mode} publish is attempted exactly once each way`);
    eq(page.clock.pending(), 2, `a ${mode} publish creates no extra timer`);
    for (let turn = 0; turn < 8; turn += 1) await settle();
  }

  {
    // No transport at all: the editor is still fully usable.
    const page = await startPage({ realtime: false });
    await clickEdit(page, AID_A);
    eq(page.published.length, 0, "an absent transport is never published to");
    const block = page.blocks.get(AID_A);
    eq(block.classList.contains("doc-edit-editing"), true, "the editor opens without transport");
    block.textContent = "Still editable with realtime gone.";
    block.dispatchEvent(makeEvent("blur"));
    eq(page.requests.filter((request) => request.url.includes("/api/edit")).length, 1,
      "a save still reaches the server without transport");
    eq(page.editStates().map((state) => String(state.aid)).join(","), `${AID_A},null`,
      "the local state still runs without transport");
    for (let turn = 0; turn < 8; turn += 1) await settle();
  }

  /* ---- 3. the heartbeat ------------------------------------------------ */

  {
    const page = await startPage();
    const beats = () => page.published.filter((event) => event.t === "beat");
    eq(beats()[0].act, "reading", "the activation beat reads");
    eq(beats()[0].aid, null, "the activation beat carries no aid");

    await clickEdit(page, AID_A);
    page.clock.advance(20000);
    await settle();
    const editing = beats().slice(-1)[0];
    eq(editing.act, "editing", "the beat reports editing while a block is claimed");
    eq(editing.aid, AID_A, "the beat carries the claimed aid");
    eq(Object.keys(editing).join(","), "t,label,act,aid", "the beat keeps P3-G's exact shape");

    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    page.clock.advance(20000);
    await settle();
    const reading = beats().slice(-1)[0];
    eq(reading.act, "reading", "the beat returns to reading on finish");
    eq(reading.aid, null, "the beat drops the aid on finish");
  }

  {
    // Privacy outranks the claim: a hidden reader broadcasts nothing.
    const page = await startPage({ hiddenPreference: true });
    const beats = page.published.filter((event) => event.t === "beat");
    eq(beats.length, 0, "a hidden reader publishes no beat");
    await clickEdit(page, AID_A);
    eq(publishTrail(page).join(","), `edit.claim/${AID_A}`,
      "a hidden reader still claims, because the claim is the edge transition");
    page.clock.advance(60000);
    await settle();
    eq(page.published.filter((event) => event.t === "beat").length, 0,
      "a hidden reader still publishes no beat while editing");
  }

  /* ---- 4. the local edit-state contract -------------------------------- */

  {
    const page = await startPage();
    const beatAid = () => {
      page.clock.advance(20000);
      const beat = page.published.filter((event) => event.t === "beat").slice(-1)[0];
      return beat === undefined ? undefined : beat.aid;
    };

    let getterRan = false;
    const hostile = vm.runInContext("({})", page.sandbox);
    Object.defineProperty(hostile, "aid", {
      get() {
        getterRan = true;
        return AID_A;
      },
      enumerable: true,
      configurable: false,
    });
    Object.freeze(hostile);

    const rejected = [
      ["accessor", hostile],
      ["null detail", null],
      ["non-object", "a11111111"],
      ["unfrozen", page.fromJson({ aid: AID_A })],
      ["extra key", page.frozen({ aid: AID_A, act: "editing" })],
      ["missing key", page.frozen({})],
      ["invalid aid", page.frozen({ aid: "nope" })],
      ["host prototype", Object.freeze({ aid: AID_A })],
    ];
    for (const [label, detail] of rejected) {
      page.document.dispatchEvent({ type: "doc:edit-state", detail });
      eq(beatAid(), null, `a ${label} edit-state changes nothing`);
      await settle();
    }
    eq(getterRan, false, "no accessor on a rejected edit-state is ever invoked");

    page.document.dispatchEvent({ type: "doc:edit-state", detail: page.frozen({ aid: AID_B }) });
    eq(beatAid(), AID_B, "an exact edit-state is accepted");
    await settle();
    page.document.dispatchEvent({ type: "doc:edit-state", detail: page.frozen({ aid: null }) });
    eq(beatAid(), null, "an exact reading edit-state returns to null");
    await settle();
  }

  /* ---- 5. the remote claim registry ------------------------------------ */

  {
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    ok(chipFor(page, AID_A) !== null, "an exact claim renders a chip");
    claimFrom(page, avery, AID_A, "edit.release");
    eq(chipFor(page, AID_A), null, "an exact release removes the chip");

    // Wrong source, wrong name, wrong grammar, wrong descriptors.
    const bad = [
      ["server source", page.frozen({ source: "server", t: "edit.claim", clientId: avery.id, aid: AID_A })],
      ["unknown t", page.frozen({ source: "client", t: "edit.lock", clientId: avery.id, aid: AID_A })],
      ["null aid", page.frozen({ source: "client", t: "edit.claim", clientId: avery.id, aid: null })],
      ["bad aid", page.frozen({ source: "client", t: "edit.claim", clientId: avery.id, aid: "zzz" })],
      ["bad clientId", page.frozen({ source: "client", t: "edit.claim", clientId: "-bad", aid: AID_A })],
      ["extra key", page.frozen({ source: "client", t: "edit.claim", clientId: avery.id, aid: AID_A, x: 1 })],
      ["reordered keys", page.frozen({ t: "edit.claim", source: "client", clientId: avery.id, aid: AID_A })],
      ["unfrozen", page.fromJson({ source: "client", t: "edit.claim", clientId: avery.id, aid: AID_A })],
      ["host prototype", Object.freeze({ source: "client", t: "edit.claim", clientId: avery.id, aid: AID_A })],
    ];
    for (const [label, detail] of bad) {
      rawEvent(page, detail);
      eq(chipFor(page, AID_A), null, `a ${label} claim changes nothing`);
    }

    let claimGetter = false;
    const hostile = vm.runInContext("({})", page.sandbox);
    for (const [key, value] of [["source", "client"], ["t", "edit.claim"], ["clientId", avery.id]]) {
      Object.defineProperty(hostile, key, { value, enumerable: true, writable: false, configurable: false });
    }
    Object.defineProperty(hostile, "aid", {
      get() {
        claimGetter = true;
        return AID_A;
      },
      enumerable: true,
      configurable: false,
    });
    Object.freeze(hostile);
    rawEvent(page, hostile);
    eq(chipFor(page, AID_A), null, "an accessor-bearing claim changes nothing");
    eq(claimGetter, false, "no accessor on a rejected claim is ever invoked");
  }

  {
    // Out-of-order release, and replacement.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    claimFrom(page, avery, AID_B);
    eq(chipFor(page, AID_A), null, "a replacing claim leaves the old block alone");
    ok(chipFor(page, AID_B) !== null, "a replacing claim moves the chip");
    claimFrom(page, avery, AID_A, "edit.release");
    ok(chipFor(page, AID_B) !== null, "a stale release cannot clear a newer claim");
    claimFrom(page, avery, AID_B, "edit.release");
    eq(chipFor(page, AID_B), null, "the matching release clears the claim");
  }

  {
    // A claim ahead of the claimant's first beat is retained, not rendered.
    const page = await startPage();
    const [avery] = PEERS;
    claimFrom(page, avery, AID_A);
    eq(chipFor(page, AID_A), null, "a claim without a roster row renders nothing");
    beatFrom(page, avery);
    ok(chipFor(page, AID_A) !== null, "the claimant's first beat makes the retained claim visible");
  }

  {
    // The cap admits exactly 200 keys and not one more. The map is private, so
    // its size is counted through the render path: every filler is rostered on
    // its own block, which turns one accepted key into exactly one chip.
    const page = await startPage({ blockCount: 201 });
    const fillerAid = (index) => `a5${String(index).padStart(7, "0")}`;
    const chipCount = () =>
      page.document.documentElement.querySelectorAll("span.doc-edit-claim").length;

    for (let index = 0; index < 199; index += 1) {
      beatFrom(page, { id: `c_filler_${index}`, label: `Filler ${index}` });
      claimFrom(page, { id: `c_filler_${index}` }, fillerAid(index));
    }
    eq(chipCount(), 199, "199 distinct claimants render 199 chips");

    // The 200th is still accepted -- this is what pins the cap from below.
    beatFrom(page, { id: "c_filler_199", label: "Filler 199" });
    claimFrom(page, { id: "c_filler_199" }, fillerAid(199));
    eq(chipCount(), 200, "the 200th claimant is accepted at the cap");

    // The 201st is not, and nothing is evicted to make room for it.
    beatFrom(page, { id: "c_filler_200", label: "Filler 200" });
    claimFrom(page, { id: "c_filler_200" }, fillerAid(200));
    eq(chipCount(), 200, "the 201st claimant is dropped and evicts nothing");
    eq(chipFor(page, fillerAid(200)), null, "the dropped claimant renders no chip");
    ok(chipFor(page, fillerAid(0)) !== null, "the first claimant is not evicted");
  }

  {
    // The unconditional 200-key cap.
    const page = await startPage();
    for (let index = 0; index < 200; index += 1) {
      claimFrom(page, { id: `c_filler_${index}` }, AID_A);
    }

    // A rostered previously unseen claimant is dropped at the cap. This is
    // asserted FIRST and against a rendering claimant, because it is the only
    // observable that distinguishes `size >= 200` from `size > 200`: a later
    // claimant would silently spend the off-by-one and mask the mutation.
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_B);
    eq(chipFor(page, AID_B), null, "a rostered but previously unseen claimant is dropped at the cap");
    // An unrostered previously unseen claimant is dropped at the cap too.
    claimFrom(page, { id: "c_unrostered_x" }, AID_B);
    beatFrom(page, { id: "c_unrostered_x", label: "Unrostered" });
    eq(chipFor(page, AID_B), null, "an unrostered claimant is dropped at the cap");
    // A client that already holds a key may still move it.
    beatFrom(page, { id: "c_filler_0", label: "Avery Quill" });
    claimFrom(page, { id: "c_filler_0" }, AID_B);
    ok(chipFor(page, AID_B) !== null, "an existing claimant may replace its aid at the cap");
    eq(chipFor(page, AID_A), null, "the replaced claim leaves no chip behind");
  }

  /* ---- 6. lease, bye and expiry ---------------------------------------- */

  {
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    ok(chipFor(page, AID_A) !== null, "the claim renders while the lease is live");

    page.clock.advance(49999);
    ok(chipFor(page, AID_A) !== null, "the claim survives 49,999 ms");
    page.clock.advance(1);
    eq(chipFor(page, AID_A), null, "the lease sweep at 50,000 ms drops the claim");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false, "expiry restores the direct Edit button");

    // The sweep deleted the claim itself, not just its roster row: a replayed
    // beat from the same client must not resurrect the lock.
    beatFrom(page, avery);
    eq(chipFor(page, AID_A), null, "a beat after expiry cannot resurrect the expired claim");
    beatFrom(page, avery, "editing", AID_A);
    eq(chipFor(page, AID_A), null, "an editing beat is never a claim");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "an editing beat never hides a control");
    page.clock.advance(54999);
    eq(chipFor(page, AID_A), null, "nothing reappears through a later sweep");
  }

  {
    // Claim traffic is not a lease renewal.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    page.clock.advance(40000);
    claimFrom(page, avery, AID_B);
    claimFrom(page, avery, AID_A);
    page.clock.advance(14999);
    eq(chipFor(page, AID_A), null, "claim traffic never renewed the roster lease");
  }

  {
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    page.document.dispatchEvent({
      type: "doc:event",
      detail: page.frozen({ source: "client", t: "bye", clientId: avery.id }),
    });
    eq(chipFor(page, AID_A), null, "a bye removes the claim with the roster row");
    // The bye deleted the claim itself, not merely the roster row that was
    // rendering it: a later beat from the same client must not resurrect it.
    beatFrom(page, avery);
    eq(chipFor(page, AID_A), null, "a beat after a bye cannot resurrect the claim");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "a beat after a bye leaves the direct Edit button alone");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false, "a bye restores the direct Edit button");
  }

  /* ---- 7. the chip and the affordance ---------------------------------- */

  {
    const page = await startPage();
    for (const peer of PEERS) beatFrom(page, peer);

    claimFrom(page, PEERS[0], AID_A);
    let chip = chipFor(page, AID_A);
    eq(chip.textContent, "Avery Quill is editing", "one claimant names the claimant");
    eq(chip.className, "pill warn doc-edit-claim", "the chip reuses the existing pill component");
    eq(chip.getAttribute("role"), "status", "the chip announces itself as status");
    eq(chip.getAttribute("aria-label"), "Avery Quill, editing", "one claimant gets one phrase");
    eq(chip.title, "Avery Quill, editing", "the chip title matches its accessible name");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), true, "the direct Edit button is hidden");
    eq(chip.nextElementSibling, buttonFor(page, AID_A), "the chip sits immediately before the button");

    claimFrom(page, PEERS[1], AID_A);
    chip = chipFor(page, AID_A);
    eq(chip.textContent, "2 people are editing", "two claimants collapse to a count");
    eq(chip.getAttribute("aria-label"), "Avery Quill, editing; Bo Marsh, editing",
      "two claimants list first-sight ordered phrases");

    claimFrom(page, PEERS[2], AID_A);
    chip = chipFor(page, AID_A);
    eq(chip.textContent, "3 people are editing", "three claimants collapse to a count");
    eq(chip.getAttribute("aria-label"), "Avery Quill, editing; Bo Marsh, editing; Cy Nolan, editing",
      "three claimants list first-sight ordered phrases");
    eq(controlsFor(page, AID_A).querySelectorAll("span.doc-edit-claim").length, 1,
      "one block never carries two chips");

    // Only the direct Edit button is suppressed.
    eq(controlsFor(page, AID_A).querySelector("span.doc-edit-status").hasAttribute("hidden"), false,
      "the status region is untouched");
    eq(buttonFor(page, AID_B).hasAttribute("hidden"), false, "another block's button is untouched");

    for (const peer of PEERS) claimFrom(page, peer, AID_A, "edit.release");
    eq(chipFor(page, AID_A), null, "the last release removes the chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false, "the last release restores the button");
  }

  {
    // Targets that name no single, adjacent, open, controlled block.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);

    for (const [label, aid] of [
      ["duplicate", AID_DUPE],
      ["control-less", AID_BARE],
      ["nonadjacent", AID_LONE],
      ["unknown", "a99999999"],
    ]) {
      claimFrom(page, avery, aid);
      eq(page.document.documentElement.querySelectorAll("span.doc-edit-claim").length, 0,
        `a ${label} target renders no chip`);
      claimFrom(page, avery, aid, "edit.release");
    }

    // A closed `details` hides the block, so nothing is rendered or suppressed.
    claimFrom(page, avery, AID_CLOSED);
    eq(chipFor(page, AID_CLOSED), null, "a closed details renders no chip");
    eq(buttonFor(page, AID_CLOSED).hasAttribute("hidden"), false,
      "a closed details hides no button");

    // An open one does.
    claimFrom(page, avery, AID_OPEN);
    ok(chipFor(page, AID_OPEN) !== null, "an open details renders the chip");

    // A disconnected block drops back out.
    page.blocks.get(AID_OPEN).remove();
    beatFrom(page, avery, "reading", AID_OPEN);
    eq(page.document.documentElement.querySelectorAll("span.doc-edit-claim").length, 0,
      "a disconnected block renders no chip");
  }

  {
    // An ambiguous controls wrapper names no single direct Edit button, so it
    // renders nothing and -- more importantly -- hides nothing.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    const controls = controlsFor(page, AID_B);
    const intruder = new El(page.document, "button");
    intruder.className = "doc-edit-button";
    controls.appendChild(intruder);

    claimFrom(page, avery, AID_B);
    eq(chipFor(page, AID_B), null, "a two-button controls wrapper renders no chip");
    eq(buttonFor(page, AID_B).hasAttribute("hidden"), false,
      "a two-button controls wrapper hides no button");
    eq(intruder.hasAttribute("hidden"), false, "the ambiguous second button is untouched");

    // Removing the ambiguity makes the block renderable again. The claim is
    // re-announced because an identical repeat is deduped rather than repainted.
    intruder.remove();
    claimFrom(page, avery, AID_B, "edit.release");
    claimFrom(page, avery, AID_B);
    ok(chipFor(page, AID_B) !== null, "an unambiguous wrapper renders the claim");
  }

  {
    // A block detached AFTER it was indexed: the isConnected guard, not the
    // missing-from-index short circuit, is what has to catch this one.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    // The block stays in the tree -- and therefore in the freshly built index
    // -- but reports itself detached, which is the only way to reach the
    // isConnected guard rather than the missing-from-index short circuit.
    const block = page.blocks.get(AID_A);
    Object.defineProperty(block, "isConnected", { value: false, configurable: true });

    claimFrom(page, avery, AID_A);
    eq(chipFor(page, AID_A), null, "a block detached after indexing renders no chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "a block detached after indexing hides no button");

    delete block.isConnected;
    claimFrom(page, avery, AID_A, "edit.release");
    claimFrom(page, avery, AID_A);
    ok(chipFor(page, AID_A) !== null, "a reconnected block renders the claim");
  }

  {
    // The local editing host keeps its own P4-B controls.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    beatFrom(page, SELF);
    await clickEdit(page, AID_A);
    // What the wire actually delivers: this tab's own claim echoes back first,
    // because it published before any peer could react to it. Then a genuine
    // peer claims the same block.
    claimFrom(page, SELF, AID_A);
    claimFrom(page, avery, AID_A);
    eq(chipFor(page, AID_A), null, "no chip is inserted into the block being edited locally");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "the local editing host keeps its P4-B button state");

    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    const held = chipFor(page, AID_A);
    ok(held !== null, "the held claim appears once local editing ends");
    // The self echo is dropped on release, so only the real peer is named --
    // never the local reader, and never a count of two.
    eq(held.textContent, "Avery Quill is editing",
      "the tab's own echoed claim never joins the chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), true,
      "the held claim hides the button once local editing ends");
  }

  {
    // The self-echo on its own must never decorate anything. This is the
    // permanent-lockout case: if the release publish never lands there is no
    // retry, and the tab's own echoed beats keep renewing its own roster row,
    // so the lease sweep would never expire the claim either.
    const page = await startPage();
    beatFrom(page, SELF);
    await clickEdit(page, AID_A);
    claimFrom(page, SELF, AID_A);
    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    eq(chipFor(page, AID_A), null, "the tab's own echoed claim renders no chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "the tab never hides its own Edit button");

    // ... and it stays gone across the lease it would otherwise have ridden.
    page.clock.advance(54999);
    eq(chipFor(page, AID_A), null, "the self claim does not reappear after a sweep");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "the tab's own Edit button survives the lease window");

    // The retry editor is reachable, which is what the acceptance criterion
    // "focusing the retry editor publishes a new claim" actually requires.
    const before = page.published.length;
    await clickEdit(page, AID_A);
    eq(page.published.slice(before).map((event) => event.t).join(","), "edit.claim",
      "the retry editor publishes a fresh claim");
  }

  {
    // The finish sequence captures and clears the aid BEFORE its side effects,
    // which is the whole reentrancy defence. A listener that finishes again
    // from inside the synchronous reading/null dispatch must publish nothing.
    const page = await startPage();
    await clickEdit(page, AID_A);
    const before = page.published.length;
    const states = page.editStates().length;
    let reentered = false;
    const reenter = (event) => {
      if (reentered || event.detail.aid !== null) return;
      reentered = true;
      page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    };
    page.document.addEventListener("doc:edit-state", reenter);
    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));
    page.document.removeEventListener("doc:edit-state", reenter);

    ok(reentered, "the reentrant finish actually ran");
    eq(page.published.slice(before).map((event) => `${event.t}/${event.aid}`).join(","),
      `edit.release/${AID_A}`,
      "a finish reentered from its own dispatch publishes exactly one release");
    eq(page.editStates().length, states + 1,
      "a finish reentered from its own dispatch dispatches exactly one state");
  }

  {
    // A suggestion draft is not a direct edit: focusing one publishes no claim
    // and never flips the heartbeat to editing. P4-P reuses this lifecycle for
    // its direct Edit path only, and this is the negative test that pins it.
    const page = await startPage();
    const before = page.published.length;
    const states = page.editStates().length;
    const block = page.blocks.get(AID_A);
    // Editable focus reached without going through P4-B's direct Edit button.
    block.dispatchEvent(makeEvent("focus"));
    block.dispatchEvent(makeEvent("focusin"));
    eq(page.published.length, before, "a suggestion-style focus publishes nothing");
    eq(page.editStates().length, states, "a suggestion-style focus dispatches no local state");

    page.clock.advance(20000);
    const beats = page.published.filter((event) => event.t === "beat");
    eq(beats.filter((beat) => beat.act !== "reading").length, 0,
      "a suggestion-style focus never changes the heartbeat to editing");
  }

  {
    // A blur while another block is mid-save still runs the finish sequence.
    // save() returns at the busy guard before stopEditing(), so this is the
    // one enumerated finish trigger that could be skipped entirely.
    // A request that never settles keeps the module-level `saving` flag set.
    const page = await startPage({
      responder: (url) => (url.includes("/api/edit")
        ? new Promise(() => {})
        : { status: 200, body: {} }),
    });
    // Both editors are opened before either saves: `editing` is per block,
    // so B is still open when A's request takes the save slot.
    await clickEdit(page, AID_A);
    await clickEdit(page, AID_B);
    page.blocks.get(AID_A).textContent = "first edit";
    page.blocks.get(AID_A).dispatchEvent(makeEvent("blur"));

    page.blocks.get(AID_B).textContent = "second edit";
    const before = page.published.length;
    const states = page.editStates().length;
    page.blocks.get(AID_B).dispatchEvent(makeEvent("blur"));
    eq(page.published.slice(before).map((event) => `${event.t}/${event.aid}`).join(","),
      `edit.release/${AID_B}`,
      "a blur during a concurrent save still publishes its release");
    eq(page.editStates().length, states + 1,
      "a blur during a concurrent save still dispatches reading/null");
  }

  {
    // A BFCache restore comes back to a live editor. Without a re-claim the
    // heartbeat would report reading while the reader is still typing, and the
    // local-active exclusion protecting the editing host would be gone.
    const page = await startPage();
    await clickEdit(page, AID_A);
    firePageHide(page);
    const before = page.published.length;
    firePageShow(page, true);
    const restored = page.published.slice(before);
    eq(restored.filter((event) => event.t.startsWith("edit."))
      .map((event) => `${event.t}/${event.aid}`).join(","),
      `edit.claim/${AID_A}`,
      "a BFCache restore re-claims the still-open editor");
    // The re-claim lands before presence un-suspends, so the restored beat has
    // to carry the aid -- otherwise peers are told the reader went idle.
    eq(restored.filter((event) => event.t === "beat")
      .map((event) => `${event.act}/${event.aid}`).join(","),
      `editing/${AID_A}`,
      "the restored heartbeat still reports the open editor");

    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    eq(chipFor(page, AID_A), null,
      "a restored editor is still excluded from the chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "a restored editor keeps its own button state");
  }

  {
    // A normal navigation is not a restore, so nothing is re-claimed.
    const page = await startPage();
    await clickEdit(page, AID_A);
    firePageHide(page);
    const before = page.published.length;
    firePageShow(page, false);
    eq(page.published.length, before, "a non-persisted pageshow re-claims nothing");
  }

  {
    // No client ID ever reaches the DOM.
    const page = await startPage();
    for (const peer of PEERS) {
      beatFrom(page, peer);
      claimFrom(page, peer, AID_A);
    }
    const nodes = page.document.documentElement.descendants();
    for (const node of nodes) {
      for (const value of node.attributes.values()) {
        for (const peer of PEERS) {
          ok(!String(value).includes(peer.id), `no client ID in an attribute (${peer.id})`);
        }
      }
    }
    const text = page.document.documentElement.textContent;
    for (const peer of PEERS) ok(!text.includes(peer.id), `no client ID in text (${peer.id})`);
  }

  /* ---- 8. page lifecycle ----------------------------------------------- */

  {
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), true, "the chip is up before pagehide");

    firePageHide(page);
    eq(chipFor(page, AID_A), null, "pagehide clears every chip");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false, "pagehide restores every button");
    eq(page.clock.pending(), 0, "pagehide leaves no timer running");

    firePageShow(page, true);
    eq(chipFor(page, AID_A), null, "a BFCache restore starts with no stale claim");
    // The map was cleared, not just the chips: a beat alone -- with no fresh
    // claim -- must not repaint a lock the peer already gave up.
    beatFrom(page, avery);
    eq(chipFor(page, AID_A), null, "a beat after restore cannot revive a cleared claim");
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), false,
      "a beat after restore leaves the direct Edit button alone");

    // A second peer proves the roster is empty after the restore too: the
    // claim is retained but invisible until that client's own beat lands.
    const bo = PEERS[1];
    claimFrom(page, bo, AID_B);
    eq(chipFor(page, AID_B), null, "the restored tab has no roster row for the claimant yet");
    beatFrom(page, bo);
    ok(chipFor(page, AID_B) !== null, "a fresh beat after restore makes the claim visible again");

    // And a genuinely fresh claim from the original peer renders normally.
    claimFrom(page, avery, AID_A);
    ok(chipFor(page, AID_A) !== null, "a fresh claim after restore renders again");
  }

  {
    // Hiding and showing the local reader never disturbs peer chips.
    const page = await startPage();
    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    const toggle = page.document.documentElement.querySelector("button#doc-presence-toggle");
    toggle.dispatchEvent(makeEvent("click"));
    ok(chipFor(page, AID_A) !== null, "hiding the local reader keeps peer chips");
    toggle.dispatchEvent(makeEvent("click"));
    ok(chipFor(page, AID_A) !== null, "showing the local reader keeps peer chips");

    fireVisibility(page, "hidden");
    ok(chipFor(page, AID_A) !== null, "a hidden tab keeps peer chips");
    fireVisibility(page, "visible");
    ok(chipFor(page, AID_A) !== null, "a restored tab keeps peer chips");
  }

  /* ---- 9. the advisory conflict ---------------------------------------- */

  {
    // A peer holds the block; a forced save still reaches the server and the
    // authoritative 409 is what stops it.
    let posts = 0;
    const page = await startPage({
      responder: (url) => {
        if (!url.includes("/api/edit")) return { status: 404, body: {} };
        posts += 1;
        if (posts === 1) {
          return {
            status: 200,
            body: {
              receipt: {
                text: "First writer wins the race.",
                by: { sub: "u_fixture_writer_31", name: "Dale Ferro", email: "writer@example.com" },
                at: "2026-09-03T17:04:11.201Z",
                pr: null,
              },
            },
          };
        }
        return { status: 409, body: { current: "First writer wins the race." } };
      },
    });

    const [avery] = PEERS;
    beatFrom(page, avery);
    claimFrom(page, avery, AID_A);
    eq(buttonFor(page, AID_A).hasAttribute("hidden"), true, "the advisory chip hides the control");

    // The control is only a hint: a forced click still opens the editor.
    await clickEdit(page, AID_A);
    const block = page.blocks.get(AID_A);
    block.textContent = "First writer wins the race.";
    block.dispatchEvent(makeEvent("blur"));
    for (let turn = 0; turn < 12; turn += 1) await settle();

    await clickEdit(page, AID_A);
    block.textContent = "Second writer loses the race.";
    block.dispatchEvent(makeEvent("blur"));
    for (let turn = 0; turn < 12; turn += 1) await settle();

    eq(posts, 2, "both forced saves reached the server");
    const controls = controlsFor(page, AID_A);
    eq(controls.classList.contains("doc-edit-conflict"), true, "the second save is a conflict");
    eq(controls.querySelector("span.doc-edit-status").textContent,
      "This block changed. Review the current text and try again.",
      "the exact P4-B conflict message survives");
    eq(block.getAttribute("data-md"), "First writer wins the race.",
      "the conflict repaints the server's current text");
  }

  // Sits just under the real count so deleting assertions is what trips it.
  // Raise it deliberately when the matrix grows; a floor far below the actual
  // count cannot detect a regression that removes half the cases.
  ok(checks >= 380, `the runtime matrix ran ${checks} checks`);
}

/* ========================================================================= */
/* the rendered matrix                                                       */
/* ========================================================================= */

async function renderedMatrix() {
  const components = readFileSync(join(ROOT, "templates/base/components.css"), "utf8");
  const edit = readFileSync(join(ROOT, "templates/base/edit.css"), "utf8");

  /* ---- the chip reuses shipped component styling ----------------------- */

  ok(/\.pill\s*\{[^}]*display:\s*inline-block/.test(components),
    ".pill is a shipped inline-block component");
  ok(/\.pill\.warn\s*\{[^}]*color:\s*var\(--warn\)/.test(components),
    ".pill.warn carries the shipped warning colour");
  ok(!/doc-edit-claim/.test(components) && !/doc-edit-claim/.test(edit),
    "P4-I adds no stylesheet rule of its own");

  const presence = readFileSync(join(ROOT, "templates/base/presence.js"), "utf8");
  ok(presence.includes('chip.className = "pill warn doc-edit-claim"'),
    "the chip is built from the shipped class tokens");
  ok(!/chip\.style\./.test(presence), "the chip carries no inline style");

  /* ---- print drops the whole controls wrapper -------------------------- */

  const print = edit.slice(edit.indexOf("@media print"));
  ok(/\.doc-edit-controls\s*\{\s*display:\s*none\s*!important/.test(print),
    "print hides the controls wrapper the chip lives inside");

  /* ---- the rendered page ----------------------------------------------- */

  const page = await startPage();
  const [avery, bo] = PEERS;
  beatFrom(page, avery);
  beatFrom(page, bo);

  // Focus stays exactly where the reader put it while a chip arrives.
  const otherButton = buttonFor(page, AID_B);
  otherButton.focus();
  eq(page.document.active, otherButton, "focus starts on the second block's control");
  claimFrom(page, avery, AID_A);
  const chip = chipFor(page, AID_A);
  ok(chip !== null, "the peer claim renders one chip");
  eq(page.document.active, otherButton, "inserting a chip never moves keyboard focus");
  eq(chip.listeners.size, 0, "the chip is noninteractive");
  eq(chip.hasAttribute("tabindex"), false, "the chip is not focusable");

  // The chip lives inside the wrapper print drops, so it never prints.
  eq(chip.parentNode.className, "doc-edit-controls", "the chip is inside the controls wrapper");
  eq(chip.parentNode.parentNode, page.blocks.get(AID_A).parentNode,
    "the wrapper is still the block's own sibling");

  // The button's HTML hidden attribute is what changes, and it comes back.
  eq(buttonFor(page, AID_A).hasAttribute("hidden"), true, "the rendered button is hidden");
  claimFrom(page, bo, AID_A);
  eq(chipFor(page, AID_A).textContent, "2 people are editing", "the rendered chip recounts in place");
  eq(chipFor(page, AID_A), chip, "the rendered chip node is reused, not replaced");
  claimFrom(page, avery, AID_A, "edit.release");
  claimFrom(page, bo, AID_A, "edit.release");
  eq(buttonFor(page, AID_A).hasAttribute("hidden"), false, "the rendered button comes back");

  // The presence rail still places itself with claims in flight.
  claimFrom(page, avery, AID_A);
  beatFrom(page, avery, "editing", AID_A);
  page.flushFrames();
  ok(page.document.documentElement.querySelector("div#doc-presence-rail") !== null,
    "the presence rail still renders alongside claims");

  // A forced second POST still observes the authoritative 409.
  const forced = await startPage({
    responder: (url, _init, count) => {
      if (!url.includes("/api/edit")) return { status: 404, body: {} };
      if (count === 1) return { status: 404, body: {} };
      return { status: 409, body: { current: "Held by the first writer." } };
    },
  });
  beatFrom(forced, avery);
  claimFrom(forced, avery, AID_A);
  eq(buttonFor(forced, AID_A).hasAttribute("hidden"), true, "the forced page shows the advisory chip");
  await clickEdit(forced, AID_A);
  const block = forced.blocks.get(AID_A);
  block.textContent = "A forced concurrent write.";
  block.dispatchEvent(makeEvent("blur"));
  for (let turn = 0; turn < 12; turn += 1) await settle();
  eq(controlsFor(forced, AID_A).classList.contains("doc-edit-conflict"), true,
    "the forced write observes the server's 409");
  eq(block.getAttribute("data-md"), "Held by the first writer.",
    "the forced write repaints the authoritative text");

  ok(checks >= 21, `the rendered matrix ran ${checks} checks`);
}

/* ========================================================================= */
/* entry point                                                               */
/* ========================================================================= */

async function main() {
  const mode = process.argv[2];
  if (mode === "--signal-probe") {
    signalProbe();
    return;
  }
  if (mode === "--deadline-probe") {
    deadlineProbe();
    return;
  }
  if (mode === "--runtime") {
    await runtimeMatrix();
    return;
  }
  if (mode === "--rendered") {
    await renderedMatrix();
    return;
  }
  if (mode !== undefined) {
    process.stderr.write("usage: node scripts/test-p4-i.mjs\n");
    process.exitCode = 2;
    return;
  }
  await supervise();
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
