#!/usr/bin/env node
/**
 * P4-O — permanent suggestion API regression runner.
 *
 *   node scripts/test-p4-o.mjs
 *   AIUR_P4O_HOSTED=1 node scripts/test-p4-o.mjs --hosted
 *
 * The default command is hermetic. Its parent first proves signal forwarding
 * and deadline escalation, then runs the real exported suggestion factories
 * against closed in-memory dependencies. The worker is a direct child in its
 * own process group; output is bounded, HUP/INT/TERM are forwarded, and TERM
 * escalates to KILL. Success is reported only after the group and the mode-0700
 * fixture root are proved gone.
 *
 * Hosted execution is deliberately opt-in. It creates one disposable Netlify
 * site/store/Identity fixture and one private invented GitHub repository,
 * exercises standalone and repository modes serially, then withholds success
 * until both remote resources and the guarded local root are proved gone.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

const OUTER_DEADLINE_MS = 180_000;
const HOSTED_DEADLINE_MS = 900_000;
const PROBE_DEADLINE_MS = 1_000;
const READY_DEADLINE_MS = 10_000;
const ESCALATE_MS = 2_000;
const MAX_CAPTURE_BYTES = 262_144;
const DEADLINE_CODE = 124;
const UNCERTAIN_CODE = 125;
const COMMAND_DEADLINE_MS = 300_000;
const HTTP_DEADLINE_MS = 30_000;
const CLEANUP_ATTEMPTS = 12;
const NETLIFY_API = "https://api.netlify.com/api/v1";
const NETLIFY_CLI = "netlify-cli@23.5.0";
const MAX_SUGGESTION_RESPONSE_BYTES = 67_108_864;

const DOC = "4b7d2a";
const AID = "a3f19c2b7";
const AID_2 = "a4e28d3c1";
const SECTION = "architecture";
const VERSION = "7aaca51";
const NOW_MS = Date.parse("2026-09-03T16:19:25.123Z");
const NOW = "2026-09-03T16:19:25.123Z";
const OLD = "2026-08-19T16:19:25.123Z";
const RANDOM = Uint8Array.from([0x4f, 0x7a, 0x9c, 0x31]);
const ID = `s_${NOW_MS.toString(36)}_4f7a9c31`;
const BASE_TEXT = "The cache key covers every declared input.";
const TEXT = "The cache key covers **every** declared input.";
const NOTE = "This matches the public diagram.";
const ACTOR = Object.freeze({
  sub: "u_fixture_author_31",
  name: "Avery Quill",
  email: "avery@example.invalid",
});
const DECIDER = Object.freeze({
  sub: "u_fixture_decider_77",
  name: "Rowan Vale",
  email: "rowan@example.invalid",
});
const CONTEXT = Object.freeze({ waitUntil() {} });

let checks = 0;

function ok(condition, label) {
  checks += 1;
  if (!condition) throw new Error(`FAIL ${label}`);
}

function eq(actual, expected, label) {
  checks += 1;
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const b = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${label}\n  actual   ${a}\n  expected ${b}`);
}

function throwsSync(run, check, label) {
  let error = null;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  ok(error !== null, `${label} threw synchronously`);
  check(error);
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signalNumber(name) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[name] ?? 0;
}

function groupState(pid) {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "gone" : "unknown";
  }
}

class Capture {
  constructor() {
    this.parts = [];
    this.bytes = 0;
    this.overflow = false;
  }

  push(chunk) {
    if (this.overflow) return;
    if (this.bytes + chunk.length > MAX_CAPTURE_BYTES) {
      this.overflow = true;
      return;
    }
    this.parts.push(chunk);
    this.bytes += chunk.length;
  }

  text() {
    if (this.overflow) throw new Error("child output exceeded the capture ceiling");
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(this.parts));
  }
}

function runChild(args, deadlineMs, env = {}, cwd = ROOT) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SELF, ...args], {
      cwd,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new Capture();
    const stderr = new Capture();
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => stderr.push(Buffer.from(`spawn failed: ${error.message}\n`)));

    let timedOut = false;
    let killer = null;
    const group = (signal) => {
      if (groupState(child.pid) !== "alive") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The proved-live group exited between observation and delivery.
      }
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      group("SIGTERM");
      killer = setTimeout(() => group("SIGKILL"), ESCALATE_MS);
    }, deadlineMs);
    const handlers = ["SIGHUP", "SIGINT", "SIGTERM"].map((signal) => {
      const handler = () => group(signal);
      process.on(signal, handler);
      return [signal, handler];
    });

    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      if (killer !== null) clearTimeout(killer);
      for (const [name, handler] of handlers) process.off(name, handler);
      let out = "";
      let err = "";
      let captureError = null;
      try {
        out = stdout.text();
        err = stderr.text();
      } catch (error) {
        captureError = error;
      }
      let resultCode = code;
      if (captureError !== null) resultCode = 126;
      else if (timedOut) resultCode = DEADLINE_CODE;
      else if (code === null) resultCode = 128 + signalNumber(signal);
      resolve({
        code: resultCode,
        pid: child.pid,
        signal,
        stdout: out,
        stderr: captureError === null ? err : `${captureError.message}\n`,
      });
    });
  });
}

function waitForReady(directory) {
  const marker = join(directory, "ready");
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (existsSync(marker)) {
        const raw = readFileSync(marker, "utf8").trim();
        if (/^[1-9][0-9]*$/.test(raw)) {
          resolve(Number(raw));
          return;
        }
      }
      if (Date.now() - started >= READY_DEADLINE_MS) {
        reject(new Error("signal probe did not publish a valid PID"));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function uncertain(root, detail) {
  const locator = `${root}.locator`;
  try {
    writeFileSync(locator, `${detail}\n${root}\n`, { mode: 0o600 });
    chmodSync(locator, 0o600);
  } catch {
    // stderr remains the fallback locator when the file cannot be written.
  }
  process.stderr.write(`UNRESOLVED ${detail}\n  root ${root}\n  locator ${locator}\n`);
  process.exit(UNCERTAIN_CODE);
}

function hostedUncertain(root, detail) {
  let cleanupDetail = detail;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    cleanupDetail += `; local root removal failed: ${error.code ?? "unknown"}`;
  }
  const locator = `${root}.locator`;
  try {
    writeFileSync(locator, `${cleanupDetail}\n`, { mode: 0o600 });
    chmodSync(locator, 0o600);
  } catch {
    // stderr remains the fallback locator when the file cannot be written.
  }
  process.stderr.write(`UNRESOLVED ${cleanupDetail}\n  locator ${locator}\n`);
  process.exit(UNCERTAIN_CODE);
}

async function superviseLocal() {
  const root = mkdtempSync(join(tmpdir(), "p4o-"));
  chmodSync(root, 0o700);
  const started = Date.now();
  const remaining = () => Math.max(1_000, OUTER_DEADLINE_MS - (Date.now() - started));
  try {
    for (const [signal, expected] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
      const probeRoot = join(root, `signal-${signal}`);
      mkdirSync(probeRoot, { mode: 0o700 });
      const pending = runChild(
        ["--signal-probe"], READY_DEADLINE_MS + ESCALATE_MS + 1_000, {}, probeRoot,
      );
      let pid;
      try {
        pid = await waitForReady(probeRoot);
      } catch (error) {
        const failed = await pending;
        if (groupState(failed.pid) !== "gone") {
          uncertain(root, `${signal} unready probe process group ${failed.pid} not proved gone`);
        }
        throw error;
      }
      process.kill(-pid, signal);
      const result = await pending;
      if (groupState(result.pid) !== "gone") {
        uncertain(root, `${signal} probe process group ${result.pid} not proved gone`);
      }
      eq(result.code, expected, `${signal} maps to ${expected}`);
    }

    const deadlineRoot = join(root, "deadline");
    mkdirSync(deadlineRoot, { mode: 0o700 });
    const late = await runChild(["--deadline-probe"], PROBE_DEADLINE_MS, {}, deadlineRoot);
    if (groupState(late.pid) !== "gone") {
      uncertain(root, `deadline probe process group ${late.pid} not proved gone`);
    }
    eq(late.code, DEADLINE_CODE, "TERM-resistant deadline maps to 124");
    process.stdout.write("PASS  P4-O supervisor signals and deadline\n");

    const workerRoot = join(root, "runtime");
    mkdirSync(workerRoot, { mode: 0o700 });
    const result = await runChild(["--runtime"], remaining(), { P4O_ROOT: workerRoot });
    if (groupState(result.pid) !== "gone") {
      uncertain(root, `runtime worker process group ${result.pid} not proved gone`);
    }
    if (result.code !== 0 || result.stderr !== "" || result.stdout !== "") {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`runtime worker exited ${result.code}`);
    }
    process.stdout.write("PASS  P4-O suggestion, reaping, and fan-out runtime\n");

    rmSync(root, { recursive: true, force: true });
    if (existsSync(root)) uncertain(root, "guarded fixture root survived removal");
    process.stdout.write("PASS  P4-O fixture cleaned\n");
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (cleanupError) {
      uncertain(root, `failed local fixture root could not be removed: ${cleanupError.code ?? "unknown"}`);
    }
    if (existsSync(root)) uncertain(root, "failed local fixture root survived removal");
    throw error;
  }
}

function signalProbe() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(128 + signalNumber(signal)));
  }
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`, { mode: 0o600 });
  setInterval(() => {}, 1_000);
}

function deadlineProbe() {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`, { mode: 0o600 });
  setInterval(() => {}, 1_000);
}

function clone(value) {
  return structuredClone(value);
}

class FakeStore {
  constructor() {
    this.rows = new Map();
    this.calls = [];
    this.version = 0;
    this.getHook = null;
    this.setHook = null;
    this.deleteHook = null;
    this.listHook = null;
  }

  seed(key, value) {
    this.version += 1;
    this.rows.set(key, { value: clone(value), etag: `"v${this.version}"` });
  }

  peek(key) {
    return this.rows.has(key) ? clone(this.rows.get(key).value) : null;
  }

  async getWithMetadata(key, options) {
    this.calls.push({ op: "get", key, options: clone(options) });
    if (this.getHook !== null) return this.getHook(key, options, this);
    const row = this.rows.get(key);
    return row === undefined ? null : { data: clone(row.value), etag: row.etag };
  }

  async setJSON(key, value, options) {
    this.calls.push({ op: "set", key, value: clone(value), options: clone(options) });
    if (this.setHook !== null) return this.setHook(key, value, options, this);
    if (options?.onlyIfNew !== true) throw new Error("unguarded suggestion write");
    if (this.rows.has(key)) return { modified: false };
    this.version += 1;
    const etag = `"v${this.version}"`;
    this.rows.set(key, { value: clone(value), etag });
    return { modified: true, etag };
  }

  async delete(key) {
    this.calls.push({ op: "delete", key });
    if (this.deleteHook !== null) return this.deleteHook(key, this);
    this.rows.delete(key);
    return undefined;
  }

  list(options) {
    this.calls.push({ op: "list", options: clone(options) });
    if (this.listHook !== null) return this.listHook(options, this);
    const blobs = [...this.rows.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort()
      .map((key) => ({ key }));
    return pages([[...blobs]]);
  }

  count(op) {
    return this.calls.filter((call) => call.op === op).length;
  }
}

function pages(pageBlobs, { finalDone = true } = {}) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < pageBlobs.length) {
            const value = { blobs: pageBlobs[index], directories: [] };
            index += 1;
            return { done: false, value };
          }
          if (finalDone) return { done: true, value: undefined };
          return { done: false, value: { blobs: [], directories: [] } };
        },
      };
    },
  };
}

function access(role) {
  const matrix = {
    owner: [true, true, "any", true, true, true, true, true],
    editor: [true, true, "any", true, true, true, false, true],
    commenter: [true, true, "own", true, false, false, false, false],
    viewer: [true, false, "none", false, false, false, false, false],
    none: [false, false, "none", false, false, false, false, false],
  };
  const row = matrix[role];
  return {
    role,
    shared: role !== "none",
    canRead: row[0],
    canComment: row[1],
    threadControl: row[2],
    canSuggest: row[3],
    canEdit: row[4],
    canAccept: row[5],
    canShare: row[6],
    canSeeMembers: row[7],
  };
}

function effective(hash, overrides = {}) {
  return {
    mode: "standalone",
    docId: DOC,
    aid: AID,
    section: SECTION,
    tag: "p",
    docVersion: VERSION,
    manifestHash: hash,
    hash,
    text: null,
    pending: false,
    ...overrides,
  };
}

function suggestion(hash, overrides = {}) {
  return {
    v: 1,
    id: ID,
    docId: DOC,
    aid: AID,
    section: SECTION,
    text: TEXT,
    note: NOTE,
    by: clone(ACTOR),
    at: NOW,
    baseHash: hash,
    baseText: BASE_TEXT,
    docVersion: VERSION,
    ...overrides,
  };
}

function receipt(hash, overrides = {}) {
  return {
    v: 1,
    aid: AID,
    text: TEXT,
    by: clone(ACTOR),
    at: NOW,
    baseHash: hash,
    pr: null,
    via: "suggestion",
    sugId: ID,
    acceptedBy: clone(DECIDER),
    acceptedAt: NOW,
    ...overrides,
  };
}

function request(method, path, body, options = {}) {
  const headers = new Map();
  const contentType = Object.hasOwn(options, "contentType")
    ? options.contentType
    : "application/json";
  if (contentType !== null) headers.set("content-type", contentType);
  const raw = Object.hasOwn(options, "raw")
    ? options.raw
    : body === undefined
      ? null
      : JSON.stringify(body);
  const chunks = raw === null
    ? []
    : options.chunks ?? [new TextEncoder().encode(raw)];
  let index = 0;
  const reader = {
    canceled: false,
    released: false,
    async read() {
      if (options.streamError === true) throw new Error("fixture stream failed");
      if (index >= chunks.length) return { done: true, value: undefined };
      const value = chunks[index];
      index += 1;
      return { done: false, value };
    },
    async cancel() {
      reader.canceled = true;
    },
    releaseLock() {
      reader.released = true;
    },
  };
  return {
    method,
    url: options.url ?? `https://docs.example.invalid${path}`,
    headers: {
      get(name) {
        return headers.get(String(name).toLowerCase()) ?? null;
      },
    },
    body: raw === null ? null : { getReader: () => reader },
    reader,
  };
}

async function responseJson(response, status, code = null) {
  eq(response.status, status, `response status ${status}`);
  eq(response.headers.get("Cache-Control"), "private, no-store", "response is private/no-store");
  eq(response.headers.get("Content-Type"), "application/json; charset=utf-8", "response is JSON");
  const text = await response.text();
  ok(!text.endsWith("\n"), "response has no terminal newline");
  const value = JSON.parse(text);
  if (code !== null) {
    eq(value.error.code, code, `${status} response code`);
    ok(!Object.hasOwn(value, "current") || code === "conflict", "only conflict exposes current");
  }
  return value;
}

function rawBodyAt(body, bytes) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) > bytes) throw new Error("fixture body exceeds target");
  return `${json}${" ".repeat(bytes - Buffer.byteLength(json))}`;
}

/** Production imports are loaded so their real validation helpers run, but
 * the hermetic worker must never resolve a provider SDK. `@netlify/blobs` is
 * the only bare provider import left in the server dependency graph -- ACN-006
 * removed `@netlify/identity`, and identity now arrives through the hosted
 * session store, which this store stub already stands in front of. The default
 * is poisoned because every request test injects its dependencies. */
function bindProviderPackages() {
  const source = (text) => `data:text/javascript,${encodeURIComponent(text)}`;
  const stubs = new Map([
    ["@netlify/blobs", source(
      'export function getStore(){throw new Error("provider store default reached")}\n',
    )],
  ]);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (stubs.has(specifier)) return { url: stubs.get(specifier), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
}

async function runtimeMatrix() {
  bindProviderPackages();
  const load = (relative) => import(pathToFileURL(join(ROOT, relative)).href);
  const many = await load("netlify/functions/suggestions.mjs");
  const one = await load("netlify/functions/suggestion.mjs");
  const storeLib = await load("netlify/lib/store.mjs");
  const git = await load("netlify/lib/gitedit.mjs");
  const md = await load("netlify/lib/inline-md.mjs");

  const BASE_HASH = sha256(md.toHtml(BASE_TEXT));
  const TEXT_HASH = sha256(md.toHtml(TEXT));
  const key = (record) => storeLib.suggestionKey(record.docId, record.aid, record.id);

  eq(Object.keys(many).sort(),
    ["assertSuggestionAtKey", "config", "createSuggestionsHandler", "default"],
    "suggestions exports exactly four names");
  eq(Object.keys(one).sort(), ["config", "createSuggestionHandler", "default"],
    "suggestion exports exactly three names");
  eq(many.config, { path: "/api/suggestions" }, "collection route path");
  eq(one.config, { path: "/api/suggestion" }, "action route path");
  eq(many.default.length, 2, "collection default handler arity");
  eq(one.default.length, 2, "action default handler arity");
  for (const file of ["suggestions.mjs", "suggestion.mjs"]) {
    const source = readFileSync(join(ROOT, "netlify", "functions", file), "utf8");
    for (const denied of [
      "doc.json", "@netlify/blobs", "console.", "process.env", "/api/edit", "/api/events",
      "waitUntil(", "publish(",
    ]) {
      ok(!source.includes(denied), `${file} excludes ${denied}`);
    }
  }

  const valid = suggestion(BASE_HASH);
  const validated = many.assertSuggestionAtKey(valid, DOC, key(valid));
  eq(validated, valid, "arbitrary-key validator returns the exact record");
  ok(validated !== valid && validated.by !== valid.by, "validator returns a fresh deep projection");
  eq(Object.keys(validated), [
    "v", "id", "docId", "aid", "section", "text", "note", "by", "at", "baseHash",
    "baseText", "docVersion",
  ], "record key order is canonical");

  const invalidRecords = [
    ["extra field", { ...valid, extra: true }],
    ["wrong version", { ...valid, v: 2 }],
    ["bad id", { ...valid, id: "s_bad" }],
    ["wrong doc", { ...valid, docId: "ffffff" }],
    ["bad aid", { ...valid, aid: "a123" }],
    ["bad section", { ...valid, section: "Architecture" }],
    ["long text", { ...valid, text: "x".repeat(4_001) }],
    ["long note", { ...valid, note: "x".repeat(281) }],
    ["control text", { ...valid, text: "x\u0000" }],
    ["lone surrogate", { ...valid, note: "\ud800" }],
    ["noncanonical time", { ...valid, at: "2026-09-03T16:19:25Z" }],
    ["bad hash", { ...valid, baseHash: "A".repeat(64) }],
    ["bad version", { ...valid, docVersion: "opaque" }],
    ["long actor name", { ...valid, by: { ...ACTOR, name: "n".repeat(201) } }],
    ["actor extra", { ...valid, by: { ...ACTOR, emailVerified: false } }],
  ];
  for (const [label, record] of invalidRecords) {
    throwsSync(
      () => many.assertSuggestionAtKey(record, DOC, key(valid)),
      (error) => ok(error instanceof Error, `${label} reports an error`),
      `validator rejects ${label}`,
    );
  }
  throwsSync(
    () => many.assertSuggestionAtKey(valid, DOC, storeLib.suggestionKey(DOC, AID, "s_other_01020304")),
    (error) => ok(error instanceof Error, "key mismatch reports an error"),
    "validator rejects body/key mismatch",
  );
  {
    const legacy = { ...valid, aid: "a1234567" };
    const legacyKey = storeLib.suggestionKey(DOC, legacy.aid, legacy.id);
    throwsSync(
      () => many.assertSuggestionAtKey(legacy, DOC, legacyKey),
      (error) => ok(error instanceof Error, "seven-hex aid reports an error"),
      "validator rejects a matching seven-hex stored record and key",
    );
  }

  const calls = [];
  const store = new FakeStore();
  const baseDeps = {
    requireOriginFn: () => calls.push("origin"),
    identifyFn: async () => {
      calls.push("identify");
      return { ...ACTOR, emailVerified: false };
    },
    resolveRoleFn: async (_identity, _docId, options) => {
      calls.push(["role", options]);
      return access("owner");
    },
    capabilitiesForFn: (role) => {
      const row = access(role);
      const { role: ignoredRole, shared: ignoredShared, ...capabilities } = row;
      void ignoredRole;
      void ignoredShared;
      return capabilities;
    },
    storeFn: () => store,
    appendEventFn: async (input) => {
      calls.push(["event", clone(input)]);
      return { id: "fixture-event" };
    },
    notifyFn: (context, notification) => {
      calls.push(["notify", context, clone(notification)]);
      return true;
    },
    sha256Fn: sha256,
    toHtmlFn: md.toHtml,
  };
  const manyDeps = (overrides = {}) => ({
    ...baseDeps,
    readEffectiveBaseFn: async (_docId, aid) => effective(BASE_HASH, { aid }),
    nowFn: () => NOW_MS,
    randomBytesFn: () => RANDOM.slice(),
    toMdFn: md.toMd,
    ...overrides,
  });
  const oneDeps = (overrides = {}) => ({
    ...baseDeps,
    assertApplyReceiptFn: git.assertApplyReceipt,
    readApplyReceiptFn: async () => null,
    applyTextFn: async () => ({ receipt: receipt(BASE_HASH), pr: null }),
    ...overrides,
  });
  const createBody = {
    docId: DOC, aid: AID, text: TEXT, note: NOTE, baseHash: BASE_HASH, baseText: BASE_TEXT,
  };

  const MANY_KEYS = [
    "requireOriginFn", "identifyFn", "resolveRoleFn", "capabilitiesForFn", "storeFn",
    "readEffectiveBaseFn", "appendEventFn", "notifyFn", "nowFn", "randomBytesFn",
    "sha256Fn", "toHtmlFn", "toMdFn",
  ];
  const ONE_KEYS = [
    "requireOriginFn", "identifyFn", "resolveRoleFn", "capabilitiesForFn", "storeFn",
    "assertApplyReceiptFn", "readApplyReceiptFn", "applyTextFn", "appendEventFn", "notifyFn",
    "sha256Fn", "toHtmlFn",
  ];
  for (const [factory, deps, names] of [
    [many.createSuggestionsHandler, manyDeps, MANY_KEYS],
    [one.createSuggestionHandler, oneDeps, ONE_KEYS],
  ]) {
    eq(factory(deps()).length, 2, "factory returns a two-argument handler");
    for (const name of names) {
      ok(factory({ [name]: deps()[name] }) !== null, `${name} is an optional callable override`);
      for (const bad of [undefined, null, "not callable", 7]) {
        throwsSync(
          () => factory({ [name]: bad }),
          (error) => eq(error.message, "Invalid suggestion dependencies", `${name} error message`),
          `${name} rejects ${String(bad)}`,
        );
      }
    }
    for (const malformed of [null, [], Object.create({ inherited: true })]) {
      throwsSync(
        () => factory(malformed),
        (error) => ok(error instanceof TypeError, "dependency object failure is TypeError"),
        "factory rejects malformed dependency object",
      );
    }
    throwsSync(
      () => factory({ extra: () => {} }),
      (error) => eq(error.message, "Invalid suggestion dependencies", "unknown dependency message"),
      "factory rejects unknown dependency",
    );
    const accessor = {};
    Object.defineProperty(accessor, names[0], { enumerable: true, get: () => () => {} });
    throwsSync(
      () => factory(accessor),
      (error) => ok(error instanceof TypeError, "accessor dependency is TypeError"),
      "factory rejects accessors without invoking them",
    );
    const symbolic = {};
    symbolic[Symbol("hidden")] = () => {};
    throwsSync(
      () => factory(symbolic),
      (error) => ok(error instanceof TypeError, "symbol dependency is TypeError"),
      "factory rejects symbols",
    );
  }

  calls.length = 0;
  let response = await many.createSuggestionsHandler(manyDeps())(
    request("PUT", "/api/suggestions", undefined), CONTEXT,
  );
  await responseJson(response, 405, "method-not-allowed");
  eq(response.headers.get("Allow"), "GET, POST", "collection Allow header");
  eq(calls, [], "unsupported collection method performs no request work");
  response = await one.createSuggestionHandler(oneDeps())(
    request("GET", "/api/suggestion", undefined, { contentType: null }), CONTEXT,
  );
  await responseJson(response, 405, "method-not-allowed");
  eq(response.headers.get("Allow"), "POST", "action Allow header");

  {
    let originCalls = 0;
    response = await many.createSuggestionsHandler(manyDeps({
      requireOriginFn: () => { throw new Error("GET must not inspect origin"); },
    }))(request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT);
    await responseJson(response, 200);
    const originResponse = new Response("Bad origin", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    const handler = many.createSuggestionsHandler(manyDeps({
      requireOriginFn: () => { originCalls += 1; throw originResponse; },
      identifyFn: async () => { throw new Error("identity ran after rejected origin"); },
    }));
    const denied = await handler(request("POST", "/api/suggestions", createBody), CONTEXT);
    ok(denied === originResponse, "origin Response is returned unchanged");
    eq(originCalls, 1, "supported POST invokes origin exactly once");
  }

  for (const [path, method] of [
    ["/api/suggestions", "GET"],
    [`/api/suggestions?doc=${DOC}&doc=${DOC}`, "GET"],
    [`/api/suggestions?doc=${DOC}&extra=1`, "GET"],
    ["/api/suggestions?doc=FFFFFF", "GET"],
    ["/api/suggestions?x=1", "POST"],
  ]) {
    response = await many.createSuggestionsHandler(manyDeps())(
      request(method, path, method === "POST" ? createBody : undefined, {
        contentType: method === "POST" ? "application/json" : null,
      }), CONTEXT,
    );
    await responseJson(response, 400, "invalid-request");
  }

  response = await many.createSuggestionsHandler(manyDeps({ identifyFn: async () => null }))(
    request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT,
  );
  await responseJson(response, 401, "unauthenticated");
  response = await many.createSuggestionsHandler(manyDeps({
    resolveRoleFn: async () => access("viewer"),
  }))(request("POST", "/api/suggestions", createBody), CONTEXT);
  await responseJson(response, 403, "forbidden");
  response = await many.createSuggestionsHandler(manyDeps({
    resolveRoleFn: async () => ({ ...access("owner"), canSuggest: false }),
  }))(request("POST", "/api/suggestions", createBody), CONTEXT);
  await responseJson(response, 500, "invalid-state");

  calls.length = 0;
  response = await many.createSuggestionsHandler(manyDeps())(
    request("POST", "/api/suggestions", createBody), CONTEXT,
  );
  const created = await responseJson(response, 201);
  eq(created, valid, "create returns the immutable stored record");
  eq(store.peek(key(valid)), valid, "create stores exactly the returned record");
  eq(store.calls.find((call) => call.op === "set").options, { onlyIfNew: true },
    "create is guarded onlyIfNew");
  const createEvent = calls.find((call) => call[0] === "event")[1];
  eq(createEvent.kind, "suggest.create", "create appends the canonical event kind");
  eq(createEvent.target, { suggestionId: ID, aid: AID }, "create event target is minimal");
  const createNotify = calls.find((call) => call[0] === "notify");
  eq(createNotify[2], {
    t: "suggest.created", docId: DOC, suggestionId: ID, aid: AID,
    actorName: ACTOR.name, text: TEXT,
  }, "create emits the exact notification");

  {
    const isolated = new FakeStore();
    let notifications = 0;
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => isolated,
      appendEventFn: async () => { throw new Error("audit unavailable"); },
      notifyFn: () => { notifications += 1; return true; },
    }))(request("POST", "/api/suggestions", createBody), CONTEXT);
    await responseJson(response, 201);
    ok(isolated.peek(key(valid)) !== null, "create event failure preserves durable suggestion");
    eq(notifications, 1, "create event failure does not suppress notification");
  }

  for (const notifier of [() => false, () => { throw new Error("sink failed"); },
    () => { throw new TypeError("unexpected context"); }]) {
    const isolated = new FakeStore();
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => isolated,
      notifyFn: notifier,
    }))(request("POST", "/api/suggestions", createBody), new Proxy({}, {
      get() { throw new Error("hostile context"); },
    }));
    await responseJson(response, 201);
  }

  const invalidBodies = [
    [{ ...createBody, actor: ACTOR }, "reserved actor"],
    [{ ...createBody, id: ID }, "client id"],
    [{ ...createBody, section: SECTION }, "client section"],
    [{ ...createBody, text: BASE_TEXT }, "same text"],
    [{ ...createBody, note: "x".repeat(281) }, "long note"],
    [{ ...createBody, text: "bad\u0000" }, "control"],
    [{ ...createBody, text: "\ud800" }, "lone surrogate"],
  ];
  for (const [body, label] of invalidBodies) {
    const isolated = new FakeStore();
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("POST", "/api/suggestions", body), CONTEXT,
    );
    await responseJson(response, 400, "invalid-body");
    eq(isolated.count("set"), 0, `${label} is rejected before write`);
  }

  {
    const isolated = new FakeStore();
    const currentText = "current";
    const currentHash = sha256(md.toHtml(currentText));
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => isolated,
      readEffectiveBaseFn: async () => effective(currentHash, {
        manifestHash: BASE_HASH,
        text: currentText,
        pending: true,
      }),
    }))(request("POST", "/api/suggestions", createBody), CONTEXT);
    const conflict = await responseJson(response, 409, "conflict");
    eq(conflict.current, { hash: currentHash, text: currentText }, "create conflict exposes current base");
    eq(isolated.count("list"), 0, "base conflict precedes inventory");
  }

  for (const count of [5, 6]) {
    const isolated = new FakeStore();
    for (let index = 0; index < count; index += 1) {
      const record = suggestion(BASE_HASH, {
        id: `s_${(NOW_MS - index).toString(36)}_${index.toString(16).padStart(8, "0")}`,
      });
      isolated.seed(key(record), record);
    }
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("POST", "/api/suggestions", createBody), CONTEXT,
    );
    await responseJson(response, 409, "suggestion-limit");
    eq(isolated.count("set"), 0, `${count} observed keys prevent a write`);
  }

  {
    const isolated = new FakeStore();
    isolated.setHook = async () => ({ modified: false });
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("POST", "/api/suggestions", createBody), CONTEXT,
    );
    await responseJson(response, 409, "suggestion-id-collision");
  }

  for (const [label, overrides] of [
    ["low clock", { nowFn: () => 999_999_999_999 }],
    ["unsafe clock", { nowFn: () => Number.MAX_SAFE_INTEGER + 1 }],
    ["short randomness", { randomBytesFn: () => new Uint8Array(3) }],
    ["plain randomness", { randomBytesFn: () => [1, 2, 3, 4] }],
  ]) {
    const isolated = new FakeStore();
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated, ...overrides }))(
      request("POST", "/api/suggestions", createBody), CONTEXT,
    );
    await responseJson(response, 500, "invalid-state");
    eq(isolated.count("set"), 0, `${label} fails before write`);
  }

  {
    const isolated = new FakeStore();
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...ACTOR, email: "", emailVerified: false }),
      readEffectiveBaseFn: async () => effective(BASE_HASH, {
        mode: "repository",
        text: BASE_TEXT,
      }),
    }))(request("POST", "/api/suggestions", createBody), CONTEXT);
    await responseJson(response, 500, "invalid-state");
    eq(isolated.count("list"), 0, "repository empty email fails before inventory");
  }

  for (const [raw, status, code] of [
    [rawBodyAt(createBody, 16_384), 201, null],
    [rawBodyAt(createBody, 16_385), 413, "payload-too-large"],
  ]) {
    const isolated = new FakeStore();
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("POST", "/api/suggestions", undefined, { raw }), CONTEXT,
    );
    await responseJson(response, status, code);
  }
  response = await many.createSuggestionsHandler(manyDeps())(
    request("POST", "/api/suggestions", createBody, { contentType: "text/plain" }), CONTEXT,
  );
  await responseJson(response, 415, "unsupported-media-type");

  const responseLimitFixture = (targetBytes) => {
    const count = 10_000;
    const id = "s_x_00000000";
    const aidAt = (index) => `a${index.toString(16).padStart(8, "0")}`;
    const base = suggestion("0".repeat(64), {
      id, aid: aidAt(0), note: "", text: "", baseText: "",
    });
    const framingBytes = 2 + count - 1;
    const emptyRecordBytes = Buffer.byteLength(JSON.stringify({ ...base, state: "open" }), "utf8");
    const contentBytes = targetBytes - framingBytes - count * emptyRecordBytes;
    if (contentBytes < 0) throw new Error("response-limit fixture target is too small");
    const baseLength = Math.floor(contentBytes / (2 * count));
    const textRemainder = contentBytes - 2 * count * baseLength;
    const extraPerText = Math.floor(textRemainder / count);
    const extraTextRecords = textRemainder % count;
    const baseText = "x".repeat(baseLength);
    const baseHash = sha256(md.toHtml(baseText));
    const recordAt = (index) => suggestion(baseHash, {
      id,
      aid: aidAt(index),
      note: "",
      text: `${baseText}${"x".repeat(extraPerText + (index < extraTextRecords ? 1 : 0))}`,
      baseText,
    });
    const keys = Array.from({ length: count }, (_, index) =>
      storeLib.suggestionKey(DOC, aidAt(index), id));
    const store = {
      list() {
        return pages(Array.from({ length: 10 }, (_, page) =>
          keys.slice(page * 1_000, (page + 1) * 1_000).map((key) => ({ key }))));
      },
      async getWithMetadata(fullKey) {
        const aid = fullKey.split("/").at(-2);
        const index = Number.parseInt(aid.slice(1), 16);
        if (!Number.isSafeInteger(index) || index < 0 || index >= count) return null;
        return { data: recordAt(index), etag: `"limit-${index}"` };
      },
      async setJSON() { throw new Error("GET must not write"); },
      async delete() { throw new Error("GET must not delete open rows"); },
    };
    return { store, recordAt, count, baseHash };
  };
  for (const targetBytes of [MAX_SUGGESTION_RESPONSE_BYTES - 1, MAX_SUGGESTION_RESPONSE_BYTES]) {
    const fixture = responseLimitFixture(targetBytes);
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => fixture.store,
      readEffectiveBaseFn: async (_docId, aid) => effective(fixture.baseHash, { aid }),
    }))(request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT);
    eq(response.status, 200, `response limit ${targetBytes} succeeds`);
    const body = await response.text();
    eq(Buffer.byteLength(body, "utf8"), targetBytes, `response limit ${targetBytes} returns every byte`);
    ok(body.startsWith("[{\"v\":1,"), `response limit ${targetBytes} starts with a record`);
    ok(body.endsWith(`${JSON.stringify({ ...fixture.recordAt(fixture.count - 1), state: "open" })}]`),
      `response limit ${targetBytes} includes its final record`);
  }
  {
    const targetBytes = MAX_SUGGESTION_RESPONSE_BYTES + 1;
    const fixture = responseLimitFixture(targetBytes);
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => fixture.store,
      readEffectiveBaseFn: async (_docId, aid) => effective(fixture.baseHash, { aid }),
    }))(request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT);
    eq(response.status, 503, "response limit 67108865 rejects before success");
    eq(await response.text(),
      '{"error":{"code":"resource-limit","message":"Suggestion response exceeds 67108864 bytes"}}',
      "response limit 67108865 returns only the quiet resource-limit error");
  }

  {
    const isolated = new FakeStore();
    const first = suggestion(BASE_HASH, { id: "s_m8x2k0_00000001", at: "2026-09-01T00:00:00.000Z" });
    const second = suggestion(BASE_HASH, {
      id: "s_m8x2k1_00000002", aid: AID_2, at: "2026-09-02T00:00:00.000Z",
    });
    const stale = suggestion("2".repeat(64), {
      id: "s_m8x2k2_00000003", at: OLD,
    });
    for (const record of [second, stale, first]) isolated.seed(key(record), record);
    const events = [];
    response = await many.createSuggestionsHandler(manyDeps({
      storeFn: () => isolated,
      readEffectiveBaseFn: async (_docId, aid) => effective(BASE_HASH, { aid }),
      appendEventFn: async (event) => { events.push(event); },
      nowFn: () => NOW_MS,
    }))(request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT);
    const listed = await responseJson(response, 200);
    eq(listed.map((item) => item.id), [first.id, second.id], "successful reap is removed from ordered list");
    eq(listed.map((item) => item.state), ["open", "open"], "list computes open state");
    eq(events.length, 1, "one eligible superseded row is audited");
    eq(events[0].kind, "suggest.supersede", "reap uses supersede event");
    eq(isolated.calls.filter((call) => call.op === "delete")[0].key, key(stale),
      "reap deletes only after the event");
  }

  {
    const isolated = new FakeStore();
    for (let index = 0; index < 7; index += 1) {
      const record = suggestion(BASE_HASH, {
        id: `s_m8x2k${index}_${index.toString(16).padStart(8, "0")}`,
        at: `2026-09-03T16:19:${String(10 + index).padStart(2, "0")}.123Z`,
      });
      isolated.seed(key(record), record);
    }
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT,
    );
    const listed = await responseJson(response, 200);
    eq(listed.length, 5, "list returns the oldest five per aid");
    eq(listed[0].id, "s_m8x2k0_00000000", "FIFO starts at the oldest record");
    isolated.rows.delete(key(suggestion(BASE_HASH, { id: listed[0].id })));
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT,
    );
    const emerged = await responseJson(response, 200);
    eq(emerged[4].id, "s_m8x2k5_00000005", "sixth record emerges after oldest deletion");
  }

  for (const [listHook, status, code] of [
    [() => pages([[{ key: "suggest/ffffff/a3f19c2b7/s_x_00000000.json" }]]), 500, "invalid-state"],
    [(options) => pages([[{ key: `${options.prefix}s_x_00000000.json` }, { key: `${options.prefix}s_x_00000000.json` }]]), 500, "invalid-state"],
    [(options) => pages([[...Array.from({ length: 1_001 }, (_, index) => ({ key: `${options.prefix}s_x_${index.toString(16).padStart(8, "0")}.json` }))]]), 503, "unavailable"],
    [() => pages([], { finalDone: false }), 503, "unavailable"],
  ]) {
    const isolated = new FakeStore();
    isolated.listHook = listHook;
    response = await many.createSuggestionsHandler(manyDeps({ storeFn: () => isolated }))(
      request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT,
    );
    await responseJson(response, status, code);
  }

  response = await many.createSuggestionsHandler(manyDeps({
    storeFn: () => { throw new Error("unexpected provider failure"); },
  }))(request("GET", `/api/suggestions?doc=${DOC}`, undefined, { contentType: null }), CONTEXT);
  await responseJson(response, 500, "invalid-state");

  const actionBody = (action, reason = "") => ({ docId: DOC, aid: AID, sugId: ID, action, reason });

  for (const [label, body] of [
    ["empty reject reason", actionBody("reject", "")],
    ["long reject reason", actionBody("reject", "x".repeat(281))],
    ["non-string reject reason", actionBody("reject", 7)],
    ["nonempty accept reason", actionBody("accept", "not allowed")],
    ["nonempty withdraw reason", actionBody("withdraw", "not allowed")],
  ]) {
    const isolated = new FakeStore();
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
    }))(request("POST", "/api/suggestion", body), CONTEXT);
    await responseJson(response, 400, "invalid-body");
    eq(isolated.calls, [], `${label} has no store side effects`);
  }

  response = await one.createSuggestionHandler(oneDeps({ storeFn: () => null }))(
    request("POST", "/api/suggestion", actionBody("accept")), CONTEXT,
  );
  await responseJson(response, 500, "invalid-state");

  {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    const sequence = [];
    const resultReceipt = receipt(BASE_HASH);
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...DECIDER, emailVerified: false }),
      applyTextFn: async (input) => {
        sequence.push(["apply", clone(input)]);
        return { receipt: resultReceipt, pr: null };
      },
      appendEventFn: async (event) => sequence.push(["event", clone(event)]),
      notifyFn: (_context, notification) => {
        sequence.push(["notify", clone(notification)]);
        return true;
      },
    }))(request("POST", "/api/suggestion", actionBody("accept")), CONTEXT);
    const accepted = await responseJson(response, 200);
    eq(accepted, { receipt: resultReceipt, pr: null }, "accept returns the exact validated apply result");
    eq(sequence[0][0], "apply", "accept applies before delete/audit/fan-out");
    eq(sequence[0][1], {
      docId: DOC, aid: AID, text: TEXT, author: ACTOR, acceptedBy: DECIDER,
      sugId: ID, via: "suggestion", expectBase: BASE_HASH,
    }, "accept delegates the exact P4-N input");
    eq(isolated.peek(key(valid)), null, "accept deletes the suggestion");
    eq(sequence.filter((item) => item[0] === "notify").map((item) => item[1].t),
      ["suggest.decided", "edit.saved"], "accept independently emits decided then edit.saved");
    eq(sequence.at(-1)[1].hash, TEXT_HASH, "edit.saved hashes converted accepted text");
  }

  for (const [label, firstNotify] of [
    ["false", () => false],
    ["throw", () => { throw new Error("first fan-out failed"); }],
  ]) {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    let notifyCount = 0;
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      notifyFn: (...args) => {
        notifyCount += 1;
        if (notifyCount === 1) return firstNotify(...args);
        return true;
      },
    }))(request("POST", "/api/suggestion", actionBody("accept")), CONTEXT);
    await responseJson(response, 200);
    eq(notifyCount, 2, `${label} first accept notification does not suppress the second`);
  }

  for (const [action, reason, eventKind, outcome, notifyCount] of [
    ["reject", "Not aligned", "suggest.reject", "rejected", 1],
    ["withdraw", "", "suggest.withdraw", null, 0],
  ]) {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    const sequence = [];
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...(action === "withdraw" ? ACTOR : DECIDER), emailVerified: false }),
      appendEventFn: async (event) => sequence.push(["event", clone(event)]),
      notifyFn: (_context, notification) => {
        sequence.push(["notify", clone(notification)]);
        return true;
      },
    }))(request("POST", "/api/suggestion", actionBody(action, reason)), CONTEXT);
    eq(await response.text(), '{"ok":true}', `${action} returns exact success body`);
    eq(sequence[0][1].kind, eventKind, `${action} appends before delete`);
    eq(isolated.peek(key(valid)), null, `${action} deletes after append`);
    eq(sequence.filter((item) => item[0] === "notify").length, notifyCount,
      `${action} notification count`);
    if (outcome !== null) eq(sequence.at(-1)[1].outcome, outcome, `${action} outcome`);
  }

  for (const action of ["accept", "reject"]) {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      resolveRoleFn: async () => access("commenter"),
      applyTextFn: async () => { throw new Error("authorization leaked to apply"); },
      readApplyReceiptFn: async () => { throw new Error("authorization leaked to receipt"); },
    }))(request("POST", "/api/suggestion", actionBody(action, action === "reject" ? "no" : "")), CONTEXT);
    await responseJson(response, 403, "forbidden");
    eq(isolated.count("get"), 0, `${action} denial precedes suggestion read`);
  }

  {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...DECIDER, emailVerified: false }),
      resolveRoleFn: async () => access("none"),
    }))(request("POST", "/api/suggestion", actionBody("withdraw")), CONTEXT);
    await responseJson(response, 404, "not-found");
    const missing = new FakeStore();
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => missing,
      identifyFn: async () => ({ ...DECIDER, emailVerified: false }),
      resolveRoleFn: async () => access("none"),
    }))(request("POST", "/api/suggestion", actionBody("withdraw")), CONTEXT);
    await responseJson(response, 404, "not-found");
  }

  {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...ACTOR, emailVerified: false }),
      resolveRoleFn: async () => access("none"),
    }))(request("POST", "/api/suggestion", actionBody("withdraw")), CONTEXT);
    eq(await response.text(), '{"ok":true}', "revoked author may withdraw known suggestion");
  }

  {
    const isolated = new FakeStore();
    const replayed = receipt(BASE_HASH);
    let reads = 0;
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...DECIDER, emailVerified: false }),
      readApplyReceiptFn: async () => { reads += 1; return replayed; },
      applyTextFn: async () => { throw new Error("replay must not reapply"); },
      notifyFn: () => { throw new Error("replay must not notify"); },
    }))(request("POST", "/api/suggestion", actionBody("accept")), CONTEXT);
    eq(await responseJson(response, 200), { receipt: replayed, pr: null }, "missing-key accept replays receipt");
    eq(reads, 1, "replay reads the receipt once");
  }

  {
    const isolated = new FakeStore();
    const directReceipt = {
      v: 1,
      aid: AID,
      text: TEXT,
      by: clone(ACTOR),
      at: NOW,
      baseHash: BASE_HASH,
      pr: null,
      via: "edit",
    };
    let sideEffects = 0;
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...DECIDER, emailVerified: false }),
      readApplyReceiptFn: async () => directReceipt,
      applyTextFn: async () => { sideEffects += 1; },
      appendEventFn: async () => { sideEffects += 1; },
      notifyFn: () => { sideEffects += 1; return true; },
    }))(request("POST", "/api/suggestion", actionBody("accept")), CONTEXT);
    await responseJson(response, 404, "not-found");
    eq(sideEffects, 0, "direct-edit replay has no apply, event, or notification side effects");
    eq(isolated.count("set"), 0, "direct-edit replay performs no store write");
    eq(isolated.count("delete"), 0, "direct-edit replay performs no store delete");
  }

  for (const [action, reason] of [["reject", "no"], ["withdraw", ""]]) {
    const isolated = new FakeStore();
    isolated.seed(key(valid), valid);
    response = await one.createSuggestionHandler(oneDeps({
      storeFn: () => isolated,
      identifyFn: async () => ({ ...(action === "withdraw" ? ACTOR : DECIDER), emailVerified: false }),
      appendEventFn: async () => { throw new Error("audit unavailable"); },
    }))(request("POST", "/api/suggestion", actionBody(action, reason)), CONTEXT);
    ok([500, 503].includes(response.status), `${action} append failure fails safely`);
    ok(isolated.peek(key(valid)) !== null, `${action} append failure preserves suggestion`);
  }

  ok(checks > 250, "runtime matrix executed a broad contract surface");
}

function runExternal(command, args, { cwd = ROOT, env = {}, deadline = COMMAND_DEADLINE_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new Capture();
    const stderr = new Capture();
    let expired = false;
    let killer = null;
    const stop = (signal) => {
      if (groupState(child.pid) !== "alive") return;
      try { process.kill(-child.pid, signal); } catch { /* exited after probe */ }
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => stderr.push(Buffer.from(`spawn failed: ${error.message}\n`)));
    const timer = setTimeout(() => {
      expired = true;
      stop("SIGTERM");
      killer = setTimeout(() => stop("SIGKILL"), ESCALATE_MS);
    }, deadline);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killer !== null) clearTimeout(killer);
      let out = "";
      let err = "";
      try {
        out = stdout.text();
        err = stderr.text();
      } catch (error) {
        resolve({ code: 126, stdout: "", stderr: `${error.message}\n`, signal });
        return;
      }
      resolve({
        code: expired ? DEADLINE_CODE : code === null ? 128 + signalNumber(signal) : code,
        stdout: out,
        stderr: err,
        signal,
      });
    });
  });
}

function parseObject(text, label) {
  const trimmed = text.trim();
  if (trimmed[0] !== "{" || trimmed.at(-1) !== "}" || Buffer.byteLength(trimmed) > MAX_CAPTURE_BYTES) {
    throw new Error(`${label} did not return one bounded JSON object`);
  }
  const value = JSON.parse(trimmed);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return an object`);
  }
  return value;
}

async function boundedResponseText(response, label) {
  if (response.body === null || typeof response.body.getReader !== "function") return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error(`${label} returned a non-byte chunk`);
      bytes += part.value.byteLength;
      if (bytes > MAX_CAPTURE_BYTES) {
        await reader.cancel();
        throw new Error(`${label} exceeded the response bound`);
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function provider(token, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_DEADLINE_MS);
  try {
    const response = await fetch(`${NETLIFY_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await boundedResponseText(response, "Netlify response");
    if (response.status === 404) return { status: 404, body: null };
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Netlify ${method} ${path.split("/").slice(0, 3).join("/")} answered ${response.status}`);
    }
    return { status: response.status, body: text === "" ? null : JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}

async function github(args, { expectFailure = false } = {}) {
  const result = await runExternal("gh", ["api", ...args], {
    env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  });
  if (!expectFailure && result.code !== 0) throw new Error(`gh api ${args[0]} exited ${result.code}`);
  return result;
}

async function putRepositoryFile(repo, path, bytes, sha = null) {
  const args = ["--method", "PUT", `repos/${repo}/contents/${path}`,
    "-f", "message=fixture content", "-f", `content=${Buffer.from(bytes).toString("base64")}`,
    "-f", "branch=main"];
  if (sha !== null) args.push("-f", `sha=${sha}`);
  const result = await github(args);
  return parseObject(result.stdout, `GitHub PUT ${path}`);
}

async function githubObject(path) {
  const result = await github([path]);
  return parseObject(result.stdout, `GitHub GET ${path}`);
}

async function netlifySiteByName(token, accountSlug, name) {
  const result = await provider(token, "GET", `/${accountSlug}/sites?name=${encodeURIComponent(name)}`);
  if (result.status === 404) return null;
  if (!Array.isArray(result.body)) throw new Error("Netlify site lookup returned a non-list response");
  const matches = result.body.filter((site) => site !== null && typeof site === "object" && site.name === name);
  if (matches.length === 0) return null;
  if (matches.length !== 1 || typeof matches[0].id !== "string" || matches[0].id === "") {
    throw new Error(`Netlify site locator ${name} was not unique and deletable`);
  }
  return matches[0].id;
}

async function githubRepositoryState(repo) {
  const result = await runExternal("gh", ["api", "--include", `repos/${repo}`], {
    env: { GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  });
  const status = `${result.stdout}\n${result.stderr}`.match(/^HTTP\/\S+\s+(\d{3})\b/m);
  if (status === null) throw new Error("GitHub repository lookup returned no HTTP status");
  if (status[1] === "200") return "present";
  if (status[1] === "404") return "absent";
  throw new Error(`GitHub repository lookup answered ${status[1]}`);
}

async function waitForSiteGone(token, siteId) {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    if ((await provider(token, "GET", `/sites/${siteId}`)).status === 404) return;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("disposable Netlify site remained visible after deletion");
}

async function waitForRepositoryGone(repo) {
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    if (await githubRepositoryState(repo) === "absent") return;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw new Error("disposable GitHub repository remained visible after deletion");
}

async function identityToken(siteUrl, email, password) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_DEADLINE_MS);
  try {
    const response = await fetch(`${siteUrl}/.netlify/identity/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: email, password }),
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) throw new Error(`Identity token request answered ${response.status}`);
    const body = JSON.parse(await boundedResponseText(response, "Identity response"));
    if (typeof body.access_token !== "string" || body.access_token === "") {
      throw new Error("Identity returned no access token");
    }
    return body.access_token;
  } finally {
    clearTimeout(timer);
  }
}

async function api(siteUrl, token, path, body, expected) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_DEADLINE_MS);
  try {
    const response = await fetch(`${siteUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: siteUrl,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await boundedResponseText(response, "suggestion API response");
    if (response.status !== expected) {
      throw new Error(`${path} answered ${response.status}, expected ${expected}`);
    }
    return text === "" ? null : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function fixtureBlocks(manifest, anchors, toHtml) {
  const found = [];
  for (const [section, row] of Object.entries(anchors)) {
    for (let index = 0; index < row.ids.length; index += 1) {
      const aid = row.ids[index];
      const block = manifest.blocks[aid];
      const text = row.texts[index];
      if (block?.tag === "p" && block.section === section && sha256(toHtml(text)) === block.hash) {
        found.push({ aid, text, ...block });
      }
      if (found.length === 3) return found;
    }
  }
  throw new Error("fixture did not contain three round-tripping paragraph blocks");
}

function oldSuggestion(docId, block, actor, index, version) {
  return {
    v: 1,
    id: `s_old${index}_${index.toString(16).padStart(8, "0")}`,
    docId,
    aid: block.aid,
    section: block.section,
    text: `${block.text} proposed ${index}`,
    note: "retention fixture",
    by: { sub: actor.id, name: actor.name, email: actor.email },
    at: `2026-08-${String(1 + index).padStart(2, "0")}T00:00:00.000Z`,
    baseHash: "0".repeat(64),
    baseText: block.text,
    docVersion: version,
  };
}

async function hostedWorker() {
  const required = ["NETLIFY_AUTH_TOKEN", "NETLIFY_ACCOUNT_SLUG", "GITHUB_TOKEN"];
  const missing = required.filter((name) => typeof process.env[name] !== "string" || process.env[name] === "");
  if (missing.length !== 0) {
    process.stderr.write(`hosted gate refused before creation: missing ${missing.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  const root = process.env.P4O_ROOT;
  if (typeof root !== "string" || !existsSync(root)) throw new Error("hosted worker has no guarded root");
  const netlifyToken = process.env.NETLIFY_AUTH_TOKEN;
  const slug = process.env.NETLIFY_ACCOUNT_SLUG;
  const suffix = randomBytes(8).toString("hex");
  const siteName = `p4o-${suffix}`;
  const repoName = `p4o-${suffix}`;
  const siteLocator = `${slug}/${siteName}`;
  const staging = join(root, "deploy");
  const installRoot = join(root, "tools");
  let siteId = null;
  let repo = null;
  let cleanupError = null;
  let behaviorError = null;

  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    cpSync(join(ROOT, "netlify"), join(staging, "netlify"), { recursive: true });
    cpSync(join(ROOT, "example"), join(staging, "example"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(staging, "package.json"));
    cpSync(join(ROOT, "package-lock.json"), join(staging, "package-lock.json"));
    const install = await runExternal("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], {
      cwd: staging,
    });
    if (install.code !== 0) throw new Error(`fixture dependency install exited ${install.code}`);
    mkdirSync(installRoot, { recursive: true, mode: 0o700 });
    const cliInstall = await runExternal("npm", ["install", "--ignore-scripts", "--no-save", "--no-audit",
      "--no-fund", "--silent", "--prefix", installRoot, NETLIFY_CLI]);
    if (cliInstall.code !== 0) throw new Error(`pinned Netlify CLI install exited ${cliInstall.code}`);
    const cli = join(installRoot, "node_modules", ".bin", "netlify");
    const version = await runExternal(cli, ["--version"], { cwd: staging });
    if (version.code !== 0 || !version.stdout.includes("23.5.0")) {
      throw new Error("pinned Netlify CLI did not report version 23.5.0");
    }

    const head = await runExternal("git", ["rev-parse", "--short=7", "HEAD"], { cwd: ROOT });
    if (head.code !== 0 || !/^[0-9a-f]{7}\n?$/.test(head.stdout)) throw new Error("could not resolve fixture commit");
    const versionId = head.stdout.trim();
    const manifestPath = join(staging, "example", "dist", "example.edit.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.commit = versionId;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const anchors = JSON.parse(readFileSync(join(staging, "example", "anchors.json"), "utf8"));
    const { toHtml } = await import(pathToFileURL(join(staging, "netlify", "lib", "inline-md.mjs")).href);
    const blocks = fixtureBlocks(manifest, anchors, toHtml);

    writeFileSync(join(staging, "netlify.toml"), [
      "[build]", 'publish = "example/dist"', "[functions]", 'directory = "netlify/functions"',
      'node_bundler = "esbuild"', "[functions.suggestions]",
      'included_files = ["example/dist/example.edit.json"]', "[functions.suggestion]",
      'included_files = ["example/dist/example.edit.json"]', "",
    ].join("\n"), { mode: 0o600 });

    const account = await github(["user"]);
    const login = parseObject(account.stdout, "GitHub user").login;
    if (typeof login !== "string" || login === "") throw new Error("GitHub returned no login");
    // Retain the unique locator before the create request so cleanup can resolve an ambiguous outcome.
    repo = `${login}/${repoName}`;
    const madeRepo = await github(["--method", "POST", "user/repos", "-f", `name=${repoName}`,
      "-F", "private=true", "-F", "auto_init=true"]);
    const reportedRepo = parseObject(madeRepo.stdout, "GitHub repository create").full_name;
    if (reportedRepo !== repo) throw new Error("GitHub created an unexpected repository");
    for (const path of ["example/anchors.json", ...new Set(blocks.map((block) => `example/${block.file}`))]) {
      await putRepositoryFile(repo, path, readFileSync(join(staging, path)));
    }

    // The generated name is the unique locator retained before this create request.
    const madeSite = await provider(netlifyToken, "POST", `/${slug}/sites`, { name: siteName });
    siteId = madeSite.body?.id;
    if (typeof siteId !== "string" || siteId === "") {
      siteId = null;
      throw new Error("Netlify created no site id");
    }
    const siteUrl = typeof madeSite.body.ssl_url === "string" ? madeSite.body.ssl_url : madeSite.body.url;
    if (typeof siteUrl !== "string" || !siteUrl.startsWith("https://")) {
      throw new Error("Netlify created no HTTPS site URL");
    }
    await provider(netlifyToken, "POST", `/sites/${siteId}/services/identity/instances`, {});
    const password = `Aa1!${randomBytes(12).toString("base64url")}`;
    const people = {};
    for (const name of ["owner", "author", "outsider"]) {
      const email = `p4o-${name}-${suffix}@example.invalid`;
      const created = await provider(netlifyToken, "POST", `/sites/${siteId}/identity/users`, {
        email, password, confirm: true,
      });
      if (typeof created.body?.id !== "string") throw new Error(`Netlify created no ${name} identity`);
      people[name] = { id: created.body.id, email, name: `Fixture ${name}` };
    }

    const { getStore } = await import(pathToFileURL(join(staging, "node_modules", "@netlify", "blobs", "dist", "main.js")).href);
    const store = getStore({ name: "doc-state", siteID: siteId, token: netlifyToken });
    await store.setJSON(`mode/${manifest.docId}/manifest.json`, manifest, { onlyIfNew: true });
    const boundAt = new Date().toISOString();
    await store.setJSON(`access/${manifest.docId}/doc.json`, {
      v: 1, docId: manifest.docId, ownerSub: people.owner.id, ownerEmail: people.owner.email,
      orgDefault: "none", boundAt, boundFrom: "env:DOC_OWNERS",
    }, { onlyIfNew: true });
    const ownerActor = { sub: people.owner.id, name: people.owner.name, email: people.owner.email };
    await store.setJSON(`access/${manifest.docId}/u/${people.author.id}.json`, {
      v: 1, docId: manifest.docId, sub: people.author.id, email: people.author.email,
      name: people.author.name, role: "commenter", grantedBy: ownerActor,
      grantedAt: boundAt, fromInvitation: null,
    }, { onlyIfNew: true });

    const configure = async (repository) => {
      const env = { DOC_OWNERS: `${manifest.docId}:${people.owner.email}` };
      if (repository) Object.assign(env, {
        DOCS_REPO: repo,
        DOCS_BASE_BRANCH: "main",
        DOCS_GITHUB_TOKEN: process.env.GITHUB_TOKEN,
        DOCS_BOT_EMAIL: `p4o-bot-${suffix}@example.invalid`,
      });
      await provider(netlifyToken, "PATCH", `/sites/${siteId}`, { build_settings: { env } });
      const deployed = await runExternal(cli, ["deploy", "--site", siteId, "--dir", "example/dist",
        "--functions", "netlify/functions", "--prod", "--json", "--config", "netlify.toml"], {
        cwd: staging,
        env: { NETLIFY_AUTH_TOKEN: netlifyToken, CI: "1", NO_COLOR: "1" },
      });
      if (deployed.code !== 0) throw new Error(`Netlify deploy exited ${deployed.code}`);
      const answer = parseObject(deployed.stdout, "Netlify deploy");
      if (answer.site_id !== undefined && answer.site_id !== siteId) throw new Error("deploy changed site id");
    };
    await configure(false);
    for (const person of Object.values(people)) {
      person.token = await identityToken(siteUrl, person.email, password);
    }

    const create = (block, text, note = "hosted fixture") => ({
      docId: manifest.docId, aid: block.aid, text, note,
      baseHash: block.hash, baseText: block.text,
    });
    const action = (record, kind, reason = "") => ({
      docId: manifest.docId, aid: record.aid, sugId: record.id, action: kind, reason,
    });
    const records = [];
    for (let index = 0; index < 5; index += 1) {
      const token = index === 3 ? people.author.token : people.owner.token;
      records.push(await api(siteUrl, token, "/api/suggestions",
        create(blocks[0], `${blocks[0].text} proposal ${index}`), 201));
    }
    await api(siteUrl, people.owner.token, "/api/suggestions",
      create(blocks[0], `${blocks[0].text} sixth`), 409);
    await api(siteUrl, people.outsider.token, "/api/suggestion", action(records[0], "accept"), 403);
    await api(siteUrl, people.outsider.token, "/api/suggestion", action(records[0], "reject", "no"), 403);
    await api(siteUrl, people.owner.token, "/api/suggestion", action(records[0], "accept"), 200);
    if ((await store.get(`suggest/${manifest.docId}/${blocks[0].aid}/${records[0].id}.json`,
      { type: "json", consistency: "strong" })) !== null) throw new Error("accepted suggestion survived");
    await api(siteUrl, people.owner.token, "/api/suggestion", action(records[1], "reject", "not now"), 200);
    await store.delete(`access/${manifest.docId}/u/${people.author.id}.json`);
    await api(siteUrl, people.author.token, "/api/suggestion", action(records[3], "withdraw"), 200);
    const miss = { ...action(records[2], "withdraw"), sugId: "s_missing_00000000" };
    const hidden = await api(siteUrl, people.outsider.token, "/api/suggestion", action(records[2], "withdraw"), 404);
    const absent = await api(siteUrl, people.outsider.token, "/api/suggestion", miss, 404);
    if (JSON.stringify(hidden) !== JSON.stringify(absent)) throw new Error("withdraw hit/miss concealment differed");

    await configure(true);
    const repoAccepted = await api(siteUrl, people.owner.token, "/api/suggestions",
      create(blocks[1], `${blocks[1].text} accepted from repository`), 201);
    await api(siteUrl, people.owner.token, "/api/suggestion", action(repoAccepted, "accept"), 200);
    const repoConflict = await api(siteUrl, people.owner.token, "/api/suggestions",
      create(blocks[2], `${blocks[2].text} conflicting repository edit`), 201);
    const remote = await githubObject(`repos/${repo}/contents/example/${blocks[2].file}?ref=main`);
    const originalSource = readFileSync(join(staging, "example", blocks[2].file), "utf8");
    const needle = blocks[2].text.slice(0, 24);
    if (!originalSource.includes(needle)) throw new Error("repository conflict fixture could not locate block text");
    const changed = Buffer.from(originalSource.replace(needle, `${needle.slice(0, -1)}!`));
    await putRepositoryFile(repo, `example/${blocks[2].file}`, changed, remote.sha);
    await api(siteUrl, people.owner.token, "/api/suggestion", action(repoConflict, "accept"), 409);

    const reaped = [];
    for (let index = 0; index < 11; index += 1) {
      const block = index < 5 ? blocks[0] : index < 10 ? blocks[1] : blocks[2];
      const row = oldSuggestion(manifest.docId, block, people.owner, index, versionId);
      const suggestionKey = `suggest/${manifest.docId}/${block.aid}/${row.id}.json`;
      await store.setJSON(suggestionKey, row, { onlyIfNew: true });
      reaped.push(suggestionKey);
    }
    await api(siteUrl, people.owner.token, `/api/suggestions?doc=${manifest.docId}`, undefined, 200);
    for (let index = 0; index < 10; index += 1) {
      if ((await store.get(reaped[index], { type: "json", consistency: "strong" })) !== null) {
        throw new Error(`superseded suggestion ${index} survived reaping`);
      }
    }
    if ((await store.get(reaped[10], { type: "json", consistency: "strong" })) === null) {
      throw new Error("eleventh superseded suggestion was reaped");
    }
    const receiptKey = `edits/${manifest.docId}/${blocks[1].aid}.json`;
    if ((await store.get(receiptKey, { type: "json", consistency: "strong" })) === null) {
      throw new Error("repository acceptance wrote no receipt");
    }
  } catch (error) {
    behaviorError = error;
  }

  const cleanupFailures = [];
  if (siteId === null) {
    try {
      siteId = await netlifySiteByName(netlifyToken, slug, siteName);
    } catch (error) {
      cleanupFailures.push(`Netlify site locator ${siteLocator}: absence unproved: ${error.message}`);
    }
  }
  if (siteId !== null) {
    try {
      await provider(netlifyToken, "DELETE", `/sites/${siteId}`);
      await waitForSiteGone(netlifyToken, siteId);
    } catch (error) {
      cleanupFailures.push(`Netlify site ${siteId}: ${error.message}`);
    }
  }
  if (repo !== null) {
    try {
      if (await githubRepositoryState(repo) === "present") {
        const deleted = await github(["--method", "DELETE", `repos/${repo}`], { expectFailure: true });
        if (deleted.code !== 0 && await githubRepositoryState(repo) !== "absent") {
          throw new Error(`GitHub repository delete exited ${deleted.code}`);
        }
        await waitForRepositoryGone(repo);
      }
    } catch (error) {
      cleanupFailures.push(`GitHub repository locator ${repo}: absence unproved: ${error.message}`);
    }
  }
  if (cleanupFailures.length !== 0) cleanupError = new Error(cleanupFailures.join("; "));

  if (cleanupError !== null) {
    process.stderr.write(`hosted cleanup unproved: ${cleanupError.message}\n`);
    process.exitCode = UNCERTAIN_CODE;
    return;
  }
  if (behaviorError !== null) throw behaviorError;
}

async function superviseHosted() {
  const root = mkdtempSync(join(tmpdir(), "p4o-hosted-"));
  chmodSync(root, 0o700);
  const workerRoot = join(root, "worker");
  mkdirSync(workerRoot, { mode: 0o700 });
  const result = await runChild(["--hosted-worker"], HOSTED_DEADLINE_MS, { P4O_ROOT: workerRoot });
  if (groupState(result.pid) !== "gone") {
    hostedUncertain(root, `hosted worker process group ${result.pid} not proved gone`);
  }
  if (result.code === UNCERTAIN_CODE) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    hostedUncertain(root, `hosted lifecycle did not prove complete cleanup: ${result.stderr.trim()}`);
  }
  if (result.code !== 0 || result.stderr !== "" || result.stdout !== "") {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      hostedUncertain(root, `failed hosted fixture root could not be removed: ${error.code ?? "unknown"}`);
    }
    if (existsSync(root)) hostedUncertain(root, "failed hosted fixture root survived removal");
    throw new Error(`hosted lifecycle worker exited ${result.code}`);
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    hostedUncertain(root, `hosted fixture root could not be removed: ${error.code ?? "unknown"}`);
  }
  if (existsSync(root)) hostedUncertain(root, "hosted fixture root survived removal");
  process.stdout.write("PASS  P4-O hosted suggestion lifecycle and fan-out\n");
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  if (args.length > 1) {
    process.stderr.write("usage: node scripts/test-p4-o.mjs [--hosted]\n");
    process.exitCode = 2;
    return;
  }
  if (mode === "--signal-probe") return signalProbe();
  if (mode === "--deadline-probe") return deadlineProbe();
  if (mode === "--runtime") return runtimeMatrix();
  if (mode === "--hosted-worker") return hostedWorker();
  if (mode === "--hosted") {
    if (process.env.AIUR_P4O_HOSTED !== "1") {
      process.stderr.write("Hosted execution requires AIUR_P4O_HOSTED=1.\n");
      process.exitCode = 2;
      return;
    }
    return superviseHosted();
  }
  if (mode !== undefined) {
    process.stderr.write("usage: node scripts/test-p4-o.mjs [--hosted]\n");
    process.exitCode = 2;
    return;
  }
  return superviseLocal();
}

const guard = setTimeout(() => {
  process.stderr.write("The P4-O parent exceeded its own deadline.\n");
  process.exit(DEADLINE_CODE);
}, process.argv[2] === "--hosted" ? HOSTED_DEADLINE_MS + 10_000 : OUTER_DEADLINE_MS + 10_000);
guard.unref();

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 2;
});
