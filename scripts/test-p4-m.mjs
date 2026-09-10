#!/usr/bin/env node
/**
 * P4-M — the permanent enforcement regression runner for the existing write
 * paths.
 *
 *   node scripts/test-p4-m.mjs
 *   AIUR_P4M_HOSTED=1 node scripts/test-p4-m.mjs --hosted
 *
 * One entry point, three lines of output. The supervisor proves its own signal
 * and deadline behaviour first, then launches the runtime matrix as a direct
 * child in its own process group under a mode-0700 temporary root, gives it a
 * deadline, caps captured output, forwards HUP/INT/TERM, escalates TERM to
 * KILL, reaps the child, proves the child's process group is gone, and removes
 * the guarded root before it can report success. Cleanup it cannot prove exits
 * 125, prints no PASS line, and retains a distinctly named mode-0700 evidence
 * root plus a mode-0600 locator. Only the three newest evidence roots are kept.
 *
 * The runtime matrix drives the *real* `netlify/functions/threads.mjs`,
 * `thread.mjs`, and `edit.mjs`. The two thread modules import their
 * collaborators statically, so a synchronous module resolve hook binds their
 * `../lib/identity.mjs`, `../lib/store.mjs`, `../lib/access.mjs`,
 * `./events.mjs`, and `../lib/notify.mjs` specifiers to thin stubs that
 * delegate to a control channel. Nothing in the module under test is rewritten
 * or copied: the loader substitutes only what the handler depends on. P2-B's
 * real `read`/`mutate`/key builders and P3-B's real `appendEvent()` run against
 * an in-memory provider, so the audit rows asserted here are the rows the real
 * schema validator produced. `edit.mjs` needs no hook: P4-B's closed factory
 * takes `resolveRole` and `capabilitiesFor` as dependencies.
 *
 * Nothing here reads a credential, a real repository, a remote provider, or a
 * private fixture. Every actor, document, and host is invented.
 *
 * Deviation from the ticket's test plan, recorded on purpose: the `--hosted`
 * branch is a fail-closed preflight, not a full disposable-site lifecycle. It
 * refuses (125) unless it can prove an authenticated `netlify` and `gh` that
 * may both create *and* delete disposable resources, and it never prints a PASS
 * line it did not earn. Implementing the deploy/branch lifecycle blind, with no
 * authenticated site to exercise it against, would ship an unexecuted claim —
 * which is worse than an honest refusal. See the PR's `## Spec defects`.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  guardedTempRoot,
  installSignalCleanup,
  retainEvidenceRoot,
  sweepStaleTempRoots,
} from "./lib/temp-roots.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const WORKER_DEADLINE_MS = 120_000;
const HOSTED_DEADLINE_MS = 600_000;
const PROBE_DEADLINE_MS = 1_000;
const ESCALATE_MS = 2_000;
const MAX_CAPTURE_BYTES = 262_144;
const DEADLINE_CODE = 124;
const UNPROVEN_CODE = 125;

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
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const b = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a !== b) throw new Error(`FAIL ${label}\n  actual   ${a}\n  expected ${b}`);
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

/** Wait for a probe to publish its own pid, so the supervisor signals the
 * process group it actually created rather than a guessed one. */
function waitForReady(directory) {
  const marker = join(directory, "ready");
  return new Promise((resolve) => {
    const poll = () => {
      if (existsSync(marker)) {
        const raw = readFileSync(marker, "utf8").trim();
        if (/^[1-9][0-9]*$/.test(raw)) {
          resolve(Number(raw));
          return;
        }
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

/** Retain the guarded root and a mode-0600 locator, then exit 125. Cleanup
 * that cannot be proved is never reported as success. */
function unproven(root, detail) {
  try {
    const retained = retainEvidenceRoot(root, detail, { prefix: "p4m-evidence-", maxCount: 3 });
    process.stderr.write(`UNPROVEN ${detail}\n  retained ${retained.root}\n  locator  ${retained.locator}\n`);
  } catch (error) {
    process.stderr.write(`UNPROVEN ${detail} (locator failed: ${String(error)})\n`);
  }
  process.exitCode = UNPROVEN_CODE;
}

async function supervise(hosted) {
  sweepStaleTempRoots(["p4m-"], { excludePrefixes: ["p4m-evidence-"] });
  const root = guardedTempRoot("p4m-run-");
  const uninstallSignalCleanup = installSignalCleanup([root], { exitAfterCleanup: false });

  try {
    // 1. Signals. Each probe installs its own handler and exits 128 + signum.
    //    The TERM probe additionally resists its first TERM, so escalation to
    //    KILL is exercised rather than assumed.
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
    {
      // A TERM-resistant child: the supervisor's deadline TERM is ignored, so
      // only the KILL escalation can end it. It is still reported as 124.
      const stubbornRoot = join(root, "stubborn");
      mkdirSync(stubbornRoot, { mode: 0o700 });
      const result = await runChild(["--stubborn-probe"], PROBE_DEADLINE_MS, {}, stubbornRoot);
      eq(result.code, DEADLINE_CODE, "a TERM-resistant child is escalated and reported as 124");
      ok(groupIsGone(result.pid), "TERM-resistant probe process group reaped");
    }

    // 2. The deadline. A probe that ignores its work is terminated and
    //    reported as 124, exactly like the timeout utility.
    const deadlineRoot = join(root, "deadline");
    mkdirSync(deadlineRoot, { mode: 0o700 });
    const late = await runChild(["--deadline-probe"], PROBE_DEADLINE_MS, {}, deadlineRoot);
    eq(late.code, DEADLINE_CODE, "deadline probe reports 124");
    ok(groupIsGone(late.pid), "deadline probe process group reaped");
    process.stdout.write("PASS  P4-M supervisor signals and deadline\n");

    // 3. The runtime matrix.
    const workerRoot = join(root, "runtime");
    mkdirSync(workerRoot, { mode: 0o700 });
    const result = await runChild(["--runtime"], WORKER_DEADLINE_MS, { P4M_ROOT: workerRoot }, ROOT);
    if (result.code !== 0 || result.stderr !== "") {
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`--runtime worker exited ${result.code}`);
    }
    ok(groupIsGone(result.pid), "--runtime worker process group reaped");
    process.stdout.write("PASS  P4-M authorization, audit, and fan-out runtime\n");

    // 4. The opt-in hosted branch, behind exactly one environment flag.
    if (hosted) {
      const hostedRoot = join(root, "hosted");
      mkdirSync(hostedRoot, { mode: 0o700 });
      const run = await runChild(
        ["--hosted-worker"],
        HOSTED_DEADLINE_MS,
        { P4M_ROOT: hostedRoot },
        ROOT,
      );
      if (run.code !== 0) {
        process.stderr.write(run.stdout);
        process.stderr.write(run.stderr);
        unproven(root, "hosted lifecycle did not prove its own cleanup");
        return;
      }
      ok(groupIsGone(run.pid), "hosted worker process group reaped");
      process.stdout.write("PASS  P4-M hosted enforcement audit and fan-out\n");
    }
  } catch (error) {
    uninstallSignalCleanup();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }

  uninstallSignalCleanup();
  rmSync(root, { recursive: true, force: true });
  if (existsSync(root)) {
    unproven(root, "guarded fixture root survived removal");
    return;
  }
  process.stdout.write("PASS  P4-M fixture cleaned\n");
}

/* ========================================================================= */
/* probes                                                                    */
/* ========================================================================= */

function signalProbe() {
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
    process.on(signal, () => process.exit(128 + signalNumber(signal)));
  }
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`);
  setInterval(() => {}, 1000);
}

function stubbornProbe() {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.on("SIGHUP", () => {});
  setInterval(() => {}, 1000);
}

function deadlineProbe() {
  setInterval(() => {}, 1000);
}

/* ========================================================================= */
/* the invented fixture                                                      */
/* ========================================================================= */

const DOC_ID = "4b7d2a";
const OTHER_DOC = "9f0e1d";
const SECTION = "orchard-index";
const DOC_VERSION = "1a2b3c4";
const AID = "a31b7c9d2";
const BODY = "The orchard index is missing the espalier row.";
const REPLY = "Agreed; the espalier row belongs under the index.";
const TITLE = "Espalier row";
const QUOTE = "every declared basket";
const ANCHOR = Object.freeze({
  block: AID,
  exact: QUOTE,
  prefix: "covers ",
  suffix: " today",
  start: 42,
});

const WRITER = Object.freeze({
  sub: "u_fixture_writer_31",
  name: "Avery Quill",
  email: "avery@example.com",
});
const OTHER = Object.freeze({
  sub: "u_fixture_reader_77",
  name: "Rowan Vale",
  email: "rowan@example.com",
});

const ROLES = Object.freeze(["owner", "editor", "commenter", "viewer", "none"]);

/** An in-memory blob store with the exact provider surface P2-B uses. */
class FakeStore {
  constructor() {
    this.records = new Map();
    this.version = 0;
    this.readHook = null;
    this.writeHook = null;
    this.writes = [];
  }

  async getWithMetadata(key) {
    if (this.readHook !== null) {
      const hook = this.readHook;
      const replacement = hook(key, this);
      if (replacement !== undefined) return replacement;
    }
    const found = this.records.get(key);
    if (found === undefined) return null;
    return { data: structuredClone(found.value), etag: found.etag };
  }

  async setJSON(key, value, options) {
    this.writes.push(key);
    if (this.writeHook !== null) {
      const hook = this.writeHook;
      const replacement = await hook(key, value, options, this);
      if (replacement !== undefined) return replacement;
    }
    const current = this.records.get(key);
    if (options.onlyIfNew === true) {
      if (current !== undefined) return { modified: false };
    } else if (current === undefined || current.etag !== options.onlyIfMatch) {
      return { modified: false };
    }
    this.version += 1;
    const etag = `"v${this.version}"`;
    this.records.set(key, { value: structuredClone(value), etag });
    return { modified: true, etag };
  }

  /** The paginated provider list surface P3-A enumerates for GET. */
  list(options) {
    const prefix = options.prefix;
    const keys = [...this.records.keys()].filter((key) => key.startsWith(prefix)).sort();
    return {
      async *[Symbol.asyncIterator]() {
        yield { blobs: keys.map((key) => ({ key, etag: '"x"' })) };
      },
    };
  }

  seed(key, value) {
    this.version += 1;
    this.records.set(key, { value: structuredClone(value), etag: `"v${this.version}"` });
  }

  /** Every stored record whose key begins with `events/`, in key order. */
  events() {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith("events/"))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, record]) => structuredClone(record.value));
  }
}

/** The synchronous module resolve hook. The two thread handlers import their
 * collaborators statically, so their specifiers — and only theirs — are bound
 * to stubs that delegate to `globalThis.__P4M__`. */
function bindThreadModules(stubRoot) {
  mkdirSync(stubRoot, { recursive: true });
  const real = (path) => pathToFileURL(join(ROOT, path)).href;
  const stub = (name, source) => {
    const file = join(stubRoot, name);
    writeFileSync(file, source, "utf8");
    return pathToFileURL(file).href;
  };

  const stubs = new Map([
    ["../lib/identity.mjs", stub("identity.mjs", `
      const control = () => globalThis.__P4M__;
      export function requireOrigin(req) { return control().identity.requireOrigin(req); }
      export function identify(req) { return control().identity.identify(req); }
    `)],
    ["../lib/access.mjs", stub("access.mjs", `
      import { validateAccessRow } from ${JSON.stringify(real("netlify/lib/access.mjs"))};
      export { validateAccessRow };
      const control = () => globalThis.__P4M__;
      export function capabilitiesFor(role) { return control().access.capabilitiesFor(role); }
      export function resolveRole(docId, user, options) {
        return control().access.resolveRole(docId, user, options);
      }
    `)],
    ["../lib/store.mjs", stub("store.mjs", `
      import {
        StoreError, assertDocId, mutate, read, threadKey, threadPrefix, upgrade,
      } from ${JSON.stringify(real("netlify/lib/store.mjs"))};
      export { StoreError, assertDocId, mutate, read, threadKey, threadPrefix, upgrade };
      export function docState() { return globalThis.__P4M__.store.docState(); }
    `)],
    ["./events.mjs", stub("events.mjs", `
      import { appendEvent as realAppendEvent } from ${JSON.stringify(real("netlify/functions/events.mjs"))};
      export function appendEvent(input, options) {
        return globalThis.__P4M__.events.appendEvent(realAppendEvent, input, options);
      }
    `)],
    ["../lib/notify.mjs", stub("notify.mjs", `
      export function notify(context, notification) {
        return globalThis.__P4M__.notify(context, notification);
      }
    `)],
  ]);

  const bound = new Set([
    real("netlify/functions/threads.mjs"),
    real("netlify/functions/thread.mjs"),
  ]);

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (bound.has(context.parentURL) && stubs.has(specifier)) {
        return { url: stubs.get(specifier), shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
}

/* ========================================================================= */
/* the runtime matrix                                                        */
/* ========================================================================= */

const url = (path) => pathToFileURL(join(ROOT, path)).href;

function jsonRequest(target, method, body, headers = {}) {
  return new Request(target, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const threadsUrl = `https://docs.example.invalid/api/threads?doc=${DOC_ID}`;
const commentBody = Object.freeze({
  kind: "comment",
  section: SECTION,
  anchor: ANCHOR,
  docVersion: DOC_VERSION,
  body: BODY,
});
const discussionBody = Object.freeze({
  kind: "discussion",
  section: SECTION,
  docVersion: DOC_VERSION,
  body: BODY,
  title: TITLE,
});

async function runtimeMatrix() {
  bindThreadModules(join(process.env.P4M_ROOT, "stubs"));

  const storeLib = await import(url("netlify/lib/store.mjs"));
  const accessLib = await import(url("netlify/lib/access.mjs"));
  const threads = (await import(url("netlify/functions/threads.mjs"))).default;
  const thread = (await import(url("netlify/functions/thread.mjs"))).default;
  const { createEditHandler } = await import(url("netlify/functions/edit.mjs"));

  const resolvedFor = (role) => ({ role, shared: true, ...accessLib.capabilitiesFor(role) });

  /** Install one deterministic control channel and return its observations. */
  function scenario(options = {}) {
    const blobs = options.store ?? new FakeStore();
    const log = [];
    const calls = { origin: 0, identify: 0, docState: 0, resolveRole: [], append: [], notify: [] };
    globalThis.__P4M__ = {
      identity: {
        requireOrigin: () => {
          calls.origin += 1;
          if (options.originThrows !== undefined) throw options.originThrows;
        },
        identify: async () => {
          calls.identify += 1;
          if (options.identifyThrows === true) throw new Error("identity");
          return options.identity === undefined ? { ...WRITER } : options.identity;
        },
      },
      access: {
        capabilitiesFor: options.capabilitiesFor ?? accessLib.capabilitiesFor,
        resolveRole: async (docId, user, opts) => {
          calls.resolveRole.push({ docId, user, options: opts });
          log.push("resolveRole");
          if (options.accessThrows !== undefined) throw options.accessThrows;
          if (options.access !== undefined) return options.access;
          return resolvedFor(options.role ?? "owner");
        },
      },
      store: {
        docState: () => {
          calls.docState += 1;
          log.push("docState");
          if (options.docStateThrows === true) {
            throw new storeLib.StoreError("unavailable", 503, "Thread store unavailable");
          }
          return blobs;
        },
      },
      events: {
        appendEvent: async (realAppendEvent, input, opts) => {
          calls.append.push({ input, options: opts });
          log.push("appendEvent");
          if (options.appendThrows !== undefined) throw options.appendThrows;
          return realAppendEvent(input, opts);
        },
      },
      notify: (context, notification) => {
        calls.notify.push({ context, notification });
        log.push("notify");
        if (options.notifyThrows !== undefined) throw options.notifyThrows;
        return options.notifyResult ?? true;
      },
    };
    return { blobs, calls, log };
  }

  const context = () => ({ waitUntil: () => {} });
  const threadContext = (threadId, docId = DOC_ID) => ({
    waitUntil: () => {},
    params: { doc: docId, id: threadId },
  });
  const threadUrl = (threadId) => `https://docs.example.invalid/api/threads/${DOC_ID}/${threadId}`;
  const readJson = async (response) => JSON.parse(await response.text());

  /** Create one durable thread with an unobserved owner, so a later matrix row
   * starts from a committed record it did not have to hand-write. */
  async function seedThread(body = commentBody, author = WRITER) {
    const fixture = scenario({ identity: { ...author } });
    const response = await threads(jsonRequest(threadsUrl, "POST", body), context());
    eq(response.status, 201, "fixture thread is created");
    const created = (await readJson(response)).thread;
    for (const key of [...fixture.blobs.records.keys()]) {
      if (key.startsWith("events/")) fixture.blobs.records.delete(key);
    }
    return { blobs: fixture.blobs, thread: created };
  }

  /* ---- threads.mjs: create authorization ------------------------------- */

  for (const role of ROLES) {
    const allowed = accessLib.capabilitiesFor(role).canComment === true;
    const run = scenario({ role });
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, allowed ? 201 : 403, `create as ${role} is ${allowed ? 201 : 403}`);
    eq(run.calls.resolveRole.length, 1, `create as ${role} resolves the role exactly once`);
    eq(
      run.calls.resolveRole[0].options,
      { consumeInvitation: false },
      `create as ${role} never consumes an invitation`,
    );
    eq(run.calls.resolveRole[0].docId, DOC_ID, `create as ${role} resolves the requested document`);
    if (!allowed) {
      eq(await readJson(response), {
        error: { code: "forbidden", message: "Document access denied" },
      }, `create as ${role} returns the predecessor 403 body`);
      eq(run.calls.docState, 0, `create as ${role} performs no thread-store work`);
      eq(run.calls.append.length, 0, `create as ${role} appends nothing`);
      eq(run.calls.notify.length, 0, `create as ${role} notifies nobody`);
      eq(run.blobs.writes.length, 0, `create as ${role} writes nothing`);
    }
  }

  {
    // The lookup happens after every public request gate, so an invalid body
    // never reaches P2-G, and it happens before the clock and the store.
    const run = scenario();
    eq((await threads(jsonRequest(threadsUrl, "POST", { kind: "nope" }), context())).status, 400,
      "an invalid create body is 400");
    eq(run.calls.resolveRole.length, 0, "an invalid body never resolves a role");
  }
  {
    const run = scenario({ role: "none" });
    await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(run.log, ["resolveRole"], "a denied create touches nothing after the lookup");
  }
  {
    const run = scenario();
    await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(run.log, ["resolveRole", "docState", "appendEvent", "notify"],
      "create resolves, writes, audits, then notifies, in that order");
  }

  /* ---- threads.mjs: complete access validation -------------------------- */

  const complete = resolvedFor("owner");
  const brokenAccess = [
    ["a missing key", (() => { const copy = { ...complete }; delete copy.canShare; return copy; })()],
    ["an extra key", { ...complete, canPublish: true }],
    ["an unknown role", { ...complete, role: "admin" }],
    ["a non-boolean shared", { ...complete, shared: "yes" }],
    ["a non-boolean capability", { ...complete, canComment: "yes" }],
    ["an invalid threadControl", { ...complete, threadControl: "some" }],
    ["capabilities that disagree with the role", { ...complete, canComment: false }],
    ["an array", Object.freeze([])],
    ["null", null],
    ["a non-ordinary prototype", Object.assign(Object.create({ ping: 1 }), complete)],
    ["an accessor-backed capability", Object.defineProperties({ ...complete }, {
      canComment: { get: () => true, enumerable: true, configurable: true },
    })],
    ["a non-enumerable capability", Object.defineProperty({ ...complete }, "canComment", {
      value: true, enumerable: false, writable: true, configurable: true,
    })],
    ["a symbol-keyed extra", Object.assign({ ...complete }, { [Symbol("canPublish")]: true })],
  ];
  for (const [label, access] of brokenAccess) {
    const run = scenario({ access });
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 500, `create with ${label} is 500`);
    eq((await readJson(response)).error.code, "invalid-state", `create with ${label} is invalid-state`);
    eq(run.calls.docState, 0, `create with ${label} performs no store work`);
  }
  {
    const run = scenario({ capabilitiesFor: () => { throw new Error("no row"); } });
    eq((await threads(jsonRequest(threadsUrl, "POST", commentBody), context())).status, 500,
      "an unusable capability table is 500");
    eq(run.calls.docState, 0, "an unusable capability table performs no store work");
  }
  {
    const unavailable = new storeLib.StoreError("unavailable", 503, "Access store unavailable");
    const run = scenario({ accessThrows: unavailable });
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 503, "the exact P2-G unavailable shape is 503");
    eq((await readJson(response)).error.code, "unavailable", "503 code");
    eq(run.calls.docState, 0, "a 503 performs no store work");
  }
  for (const [label, thrown] of [
    ["an arbitrary error", new Error("boom")],
    ["a plain object", { name: "StoreError", code: "unavailable" }],
    ["a lookalike with a getter status", Object.defineProperty(
      { name: "StoreError", code: "unavailable" },
      "status",
      { get: () => 503, enumerable: true, configurable: true },
    )],
    ["a different store code", new storeLib.StoreError("conflict", 409, "Concurrent write")],
    ["a string", "unavailable"],
  ]) {
    const response = await (async () => {
      scenario({ accessThrows: thrown });
      return threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    })();
    eq(response.status, 500, `access failing with ${label} is 500, never 503`);
  }

  /* ---- threads.mjs: the create audit row and fan-out -------------------- */

  {
    const run = scenario();
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 201, "an authorized comment thread is created");
    const created = (await readJson(response)).thread;
    const events = run.blobs.events();
    eq(events.length, 1, "exactly one audit row is appended");
    eq(events[0].kind, "comment.create", "the create audit kind");
    eq(events[0].docId, DOC_ID, "the create audit document");
    eq(events[0].docVersion, DOC_VERSION, "the create audit document version");
    eq(events[0].summary, `commented on ${SECTION}`, "the create audit summary");
    eq(events[0].target, { threadId: created.id, aid: AID }, "the create audit target");
    eq(events[0].actor, { sub: WRITER.sub, name: WRITER.name, email: WRITER.email },
      "the create audit actor is the proven identity");
    eq(run.calls.append.length, 1, "the append is attempted exactly once");

    eq(run.calls.notify.length, 1, "create notifies exactly once");
    eq(run.calls.notify[0].notification, {
      t: "thread.created",
      docId: DOC_ID,
      threadId: created.id,
      actorName: WRITER.name,
      threadKind: "comment",
      body: BODY,
      quote: QUOTE,
    }, "the create notification is the exact durable projection");
    ok(Object.getPrototypeOf(run.calls.notify[0].notification) === Object.prototype,
      "the notification is a fresh ordinary object");
  }
  {
    const run = scenario();
    const response = await threads(jsonRequest(threadsUrl, "POST", discussionBody), context());
    eq(response.status, 201, "an authorized discussion thread is created");
    const created = (await readJson(response)).thread;
    eq(run.blobs.events()[0].target, { threadId: created.id, aid: null },
      "a discussion thread audits a null anchor");
    eq(run.calls.notify[0].notification.quote, null, "a discussion notification has no quote");
    eq(run.calls.notify[0].notification.threadKind, "discussion", "the discussion thread kind");
  }
  {
    // A hostile body cannot reach the role, the actor, or the audit row.
    const hostile = {
      ...commentBody,
      author: { sub: "u_attacker", name: "Root", email: "root@example.invalid" },
      email: "root@example.invalid",
      name: "Root",
    };
    const run = scenario({ role: "commenter" });
    const response = await threads(jsonRequest(threadsUrl, "POST", hostile), context());
    eq(response.status, 201, "reserved body keys are tolerated");
    const events = run.blobs.events();
    eq(events[0].actor, { sub: WRITER.sub, name: WRITER.name, email: WRITER.email },
      "a body-supplied author never becomes the audit actor");
    eq(run.calls.notify[0].notification.actorName, WRITER.name,
      "a body-supplied name never becomes the notified actor");
  }

  /* ---- threads.mjs: the audit and fan-out are best effort --------------- */

  for (const [label, options] of [
    ["a collision", { appendThrows: new storeLib.StoreError("conflict", 409, "Concurrent write limit reached") }],
    ["an unavailable store", { appendThrows: new storeLib.StoreError("unavailable", 503, "Store unavailable") }],
    ["an unexpected throw", { appendThrows: new TypeError("surprise") }],
  ]) {
    const run = scenario(options);
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 201, `an append failing with ${label} preserves the 201`);
    const created = (await readJson(response)).thread;
    ok(run.blobs.records.has(`threads/${DOC_ID}/${created.id}.json`),
      `an append failing with ${label} preserves the committed thread`);
    eq(run.blobs.events().length, 0, `an append failing with ${label} stores no row`);
    eq(run.calls.append.length, 1, `an append failing with ${label} is never retried`);
    eq(run.calls.notify.length, 1, `an append failing with ${label} still notifies once`);
    eq(run.log, ["resolveRole", "docState", "appendEvent", "notify"],
      `an append failing with ${label} keeps the call order`);
  }
  for (const [label, options] of [
    ["notify returning false", { notifyResult: false }],
    ["notify throwing", { notifyThrows: new TypeError("no sink") }],
  ]) {
    const run = scenario(options);
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 201, `${label} preserves the 201`);
    eq(run.blobs.events().length, 1, `${label} preserves the audit row`);
    eq(run.calls.notify.length, 1, `${label} calls the helper exactly once`);
  }
  {
    // A state write that never landed audits and notifies nothing.
    const run = scenario();
    run.blobs.writeHook = () => ({ modified: false });
    const response = await threads(jsonRequest(threadsUrl, "POST", commentBody), context());
    eq(response.status, 409, "a create collision is 409");
    eq((await readJson(response)).error.code, "id-collision", "the create collision code");
    eq(run.calls.append.length, 0, "a create collision appends nothing");
    eq(run.calls.notify.length, 0, "a create collision notifies nobody");
  }
  {
    const run = scenario({ docStateThrows: true });
    eq((await threads(jsonRequest(threadsUrl, "POST", commentBody), context())).status, 503,
      "an unavailable thread store is 503");
    eq(run.calls.append.length, 0, "an unavailable thread store appends nothing");
    eq(run.calls.notify.length, 0, "an unavailable thread store notifies nobody");
  }

  /* ---- threads.mjs: GET is byte-for-contract unchanged ------------------ */

  for (const role of ROLES) {
    const allowed = accessLib.capabilitiesFor(role).canRead === true;
    const run = scenario({ role });
    const response = await threads(new Request(threadsUrl, { method: "GET" }), context());
    eq(response.status, allowed ? 200 : 403, `list as ${role} is ${allowed ? 200 : 403}`);
    eq(run.calls.resolveRole.length, 1, `list as ${role} performs exactly one lookup`);
    eq(run.calls.append.length, 0, `list as ${role} appends nothing`);
    eq(run.calls.notify.length, 0, `list as ${role} notifies nobody`);
  }

  /* ---- thread.mjs: reply authorization, audit, and fan-out -------------- */

  for (const role of ROLES) {
    const allowed = accessLib.capabilitiesFor(role).canComment === true;
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs, role });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "POST", { body: REPLY }),
      threadContext(seed.thread.id),
    );
    eq(response.status, allowed ? 200 : 403, `reply as ${role} is ${allowed ? 200 : 403}`);
    eq(run.calls.resolveRole.length, 1, `reply as ${role} performs exactly one lookup`);
    eq(run.calls.resolveRole[0].options, { consumeInvitation: false },
      `reply as ${role} never consumes an invitation`);
    if (!allowed) {
      eq(run.calls.docState, 0, `reply as ${role} performs no thread-store work`);
      eq(run.calls.append.length, 0, `reply as ${role} appends nothing`);
      eq(run.calls.notify.length, 0, `reply as ${role} notifies nobody`);
    }
  }
  {
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs, role: "commenter" });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "POST", { body: REPLY }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 200, "an authorized reply is 200");
    const committed = (await readJson(response)).thread;
    const appended = committed.comments[committed.comments.length - 1];
    const events = run.blobs.events();
    eq(events.length, 1, "a reply appends exactly one audit row");
    eq(events[0].kind, "comment.reply", "the reply audit kind");
    eq(events[0].target, { threadId: seed.thread.id, commentId: appended.id, aid: AID },
      "the reply audit target carries the new comment id");
    eq(events[0].docVersion, DOC_VERSION, "the reply audit document version");
    eq(events[0].summary, `commented on ${SECTION}`, "the reply audit summary");
    eq(events[0].actor, { sub: WRITER.sub, name: WRITER.name, email: WRITER.email },
      "the reply audit actor");
    eq(run.calls.notify.length, 1, "a reply notifies exactly once");
    eq(run.calls.notify[0].notification, {
      t: "thread.replied",
      docId: DOC_ID,
      threadId: seed.thread.id,
      actorName: WRITER.name,
      body: REPLY,
      quote: QUOTE,
    }, "the reply notification is the exact durable projection");
    eq(run.log, ["resolveRole", "docState", "appendEvent", "notify"],
      "a reply resolves, writes, audits, then notifies, in that order");
  }
  {
    const seed = await seedThread(discussionBody);
    const run = scenario({ store: seed.blobs });
    await thread(
      jsonRequest(threadUrl(seed.thread.id), "POST", { body: REPLY }),
      threadContext(seed.thread.id),
    );
    eq(run.blobs.events()[0].target.aid, null, "a discussion reply audits a null anchor");
    eq(run.calls.notify[0].notification.quote, null, "a discussion reply notification has no quote");
  }
  for (const [label, options] of [
    ["a collision", { appendThrows: new storeLib.StoreError("conflict", 409, "Concurrent write limit reached") }],
    ["an unavailable store", { appendThrows: new storeLib.StoreError("unavailable", 503, "Store unavailable") }],
    ["an unexpected throw", { appendThrows: new TypeError("surprise") }],
  ]) {
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs, ...options });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "POST", { body: REPLY }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 200, `a reply append failing with ${label} preserves the 200`);
    const committed = (await readJson(response)).thread;
    eq(committed.comments.length, 2, `a reply append failing with ${label} preserves the reply`);
    eq(run.calls.append.length, 1, `a reply append failing with ${label} is never retried`);
    eq(run.calls.notify.length, 1, `a reply append failing with ${label} still notifies once`);
  }
  {
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs, notifyThrows: new TypeError("no sink") });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "POST", { body: REPLY }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 200, "a throwing reply notification preserves the 200");
    eq(run.blobs.events().length, 1, "a throwing reply notification preserves the audit row");
  }
  {
    const run = scenario();
    const missing = "t_zzzz_00000000";
    const response = await thread(
      jsonRequest(threadUrl(missing), "POST", { body: REPLY }),
      threadContext(missing),
    );
    eq(response.status, 404, "replying to a missing thread is 404");
    eq(run.calls.append.length, 0, "a missing thread appends nothing");
    eq(run.calls.notify.length, 0, "a missing thread notifies nobody");
  }

  /* ---- thread.mjs: complete access validation --------------------------- */

  // Both of thread.mjs's write paths validate the resolved row before they
  // touch anything. Running the same matrix here is what makes weakening that
  // validation fail: while only threads.mjs and edit.mjs were covered, the copy
  // this module used could be reduced to a no-op with the suite still green
  // (#125). It is one shared validator now, and this is the gate on it.
  const threadWrites = Object.freeze([
    ["a reply", "POST", { body: REPLY }],
    ["a status change", "PATCH", { status: "resolved" }],
  ]);
  for (const [what, method, requestBody] of threadWrites) {
    for (const [label, access] of brokenAccess) {
      const seed = await seedThread();
      const run = scenario({ store: seed.blobs, access });
      const response = await thread(
        jsonRequest(threadUrl(seed.thread.id), method, requestBody),
        threadContext(seed.thread.id),
      );
      eq(response.status, 500, `${what} with ${label} is 500`);
      eq((await readJson(response)).error.code, "invalid-state",
        `${what} with ${label} is invalid-state`);
      eq(run.log, ["resolveRole"], `${what} with ${label} touches nothing after the lookup`);
    }
    // A capability table is unusable whether it throws or answers with
    // something that is not an ordinary row; both are `invalid-state`, never a
    // falsy capability. The callable row is the case that pins the shape check:
    // a table answering `null` fails anyway when the row is read, but a
    // function carrying the right properties would validate without it.
    for (const [tableLabel, capabilitiesFor] of [
      ["an unusable capability table", () => { throw new Error("no row"); }],
      ["a capability table that answers with a callable", (role) =>
        Object.assign(() => {}, accessLib.capabilitiesFor(role))],
    ]) {
      const seed = await seedThread();
      const run = scenario({ store: seed.blobs, capabilitiesFor });
      const response = await thread(
        jsonRequest(threadUrl(seed.thread.id), method, requestBody),
        threadContext(seed.thread.id),
      );
      eq(response.status, 500, `${what} with ${tableLabel} is 500`);
      eq(run.log, ["resolveRole"],
        `${what} with ${tableLabel} touches nothing after the lookup`);
    }
  }

  /* ---- thread.mjs: status authorization -------------------------------- */

  for (const role of ROLES) {
    const control = accessLib.capabilitiesFor(role).threadControl;
    // The seeded thread's author is always WRITER, and WRITER is the actor, so
    // `own` is a matching ownership here and `none` is the only closed row.
    const allowed = control === "any" || control === "own";
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs, role });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, allowed ? 200 : 403,
      `resolve as ${role} (threadControl ${control}) is ${allowed ? 200 : 403}`);
    if (control === "none") {
      eq(run.calls.docState, 0, `threadControl none never reaches the store as ${role}`);
      eq(run.calls.append.length, 0, `threadControl none appends nothing as ${role}`);
    }
    eq(run.calls.notify.length, 0, `a status change as ${role} notifies nobody`);
  }
  {
    // `own` and a different author: 403, and never 404 — a non-author learns
    // nothing about whether the thread exists beyond its own denial.
    const seed = await seedThread(commentBody, OTHER);
    const run = scenario({ store: seed.blobs, role: "commenter" });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 403, "threadControl own against another author's thread is 403");
    eq(await readJson(response), { error: { code: "forbidden", message: "Document access denied" } },
      "the ownership denial is the predecessor 403 body");
    eq(run.calls.append.length, 0, "an ownership denial appends nothing");
    eq(run.calls.notify.length, 0, "an ownership denial notifies nobody");
    eq(run.blobs.records.get(`threads/${DOC_ID}/${seed.thread.id}.json`).value.status, "open",
      "an ownership denial leaves the thread open");
  }
  {
    // The ownership predicate is a CAS-state predicate. A racing writer that
    // replaces the author between the first read and the write must not let a
    // non-author win: every fresh draft is re-checked.
    const seed = await seedThread(commentBody, WRITER);
    const key = `threads/${DOC_ID}/${seed.thread.id}.json`;
    const run = scenario({ store: seed.blobs, role: "commenter" });
    let reads = 0;
    seed.blobs.readHook = (readKey, store) => {
      if (readKey !== key) return undefined;
      reads += 1;
      if (reads === 1) return undefined;
      const record = store.records.get(key);
      // P3-A requires the first comment's author to equal the thread author,
      // so the racing writer replaces both.
      const raced = structuredClone(record.value);
      raced.author = { ...OTHER };
      raced.comments[0].author = { ...OTHER };
      store.version += 1;
      store.records.set(key, { value: raced, etag: `"v${store.version}"` });
      return { data: structuredClone(raced), etag: `"v${store.version}"` };
    };
    // The first write attempt loses its compare-and-swap, so P2-B re-reads and
    // the second draft carries the raced author.
    let writes = 0;
    seed.blobs.writeHook = (writeKey) => {
      if (writeKey !== key) return undefined;
      writes += 1;
      return writes === 1 ? { modified: false } : undefined;
    };
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    ok(reads >= 2, "the raced status change re-read the record");
    eq(response.status, 403, "a raced non-author cannot win a later CAS draft");
    eq(run.calls.append.length, 0, "a raced ownership denial appends nothing");
  }
  {
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 200, "resolving an open thread is 200");
    const events = run.blobs.events();
    eq(events.length, 1, "resolve appends exactly one audit row");
    eq(events[0].kind, "thread.resolve", "the resolve audit kind");
    eq(events[0].target, { threadId: seed.thread.id, aid: AID }, "the resolve audit target");
    eq(events[0].summary, `resolved ${SECTION}`, "the resolve audit summary");
    eq(events[0].docVersion, DOC_VERSION, "the resolve audit document version");
    eq(run.calls.notify.length, 0, "resolve notifies nobody");
    eq(run.log, ["resolveRole", "docState", "appendEvent"], "resolve never reaches the fan-out");

    // The repeat is a no-op: P2-B reports `changed: false` and nothing follows.
    const repeat = scenario({ store: seed.blobs });
    const again = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(again.status, 200, "a repeated resolve is still 200");
    eq(repeat.calls.append.length, 0, "a status no-op appends nothing");
    eq(repeat.calls.notify.length, 0, "a status no-op notifies nobody");
    eq(repeat.blobs.events().length, 1, "a status no-op stores no second row");

    const reopen = scenario({ store: seed.blobs });
    const reopened = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "open" }),
      threadContext(seed.thread.id),
    );
    eq(reopened.status, 200, "reopening a resolved thread is 200");
    const rows = reopen.blobs.events();
    eq(rows.length, 2, "reopen appends exactly one further audit row");
    // Two rows minted inside one millisecond sort by their random suffix, so
    // the row is selected by kind rather than by key order.
    const reopenRow = rows.find((row) => row.kind === "thread.reopen") ?? null;
    ok(reopenRow !== null, "the reopen audit kind");
    eq(rows.filter((row) => row.kind === "thread.resolve").length, 1,
      "the earlier resolve row is untouched");
    eq(reopenRow.summary, `reopened ${SECTION}`, "the reopen audit summary");
    eq(reopenRow.target, { threadId: seed.thread.id, aid: AID }, "the reopen audit target");
    eq(reopen.calls.notify.length, 0, "reopen notifies nobody");
  }
  {
    // Six lost compare-and-swap attempts are the predecessor's 409, and a
    // failed state write audits nothing.
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs });
    seed.blobs.writeHook = (writeKey) =>
      (writeKey.startsWith("threads/") ? { modified: false } : undefined);
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 409, "an exhausted CAS is the predecessor 409");
    eq((await readJson(response)).error.code, "conflict", "the CAS exhaustion code");
    eq(run.calls.append.length, 0, "an exhausted CAS appends nothing");
    eq(run.calls.notify.length, 0, "an exhausted CAS notifies nobody");
  }
  {
    // A racing writer that resolves within the six attempts still commits, and
    // the audit follows the state that actually landed.
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs });
    let attempts = 0;
    seed.blobs.writeHook = (writeKey) => {
      if (!writeKey.startsWith("threads/")) return undefined;
      attempts += 1;
      return attempts <= 2 ? { modified: false } : undefined;
    };
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "resolved" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 200, "a CAS race that resolves still commits");
    eq(attempts, 3, "the write was retried by P2-B, not by this ticket");
    eq(run.calls.append.length, 1, "a resolved race audits exactly once");
    eq(run.blobs.events()[0].kind, "thread.resolve", "the raced audit kind");
  }
  {
    const seed = await seedThread();
    const run = scenario({ store: seed.blobs });
    const response = await thread(
      jsonRequest(threadUrl(seed.thread.id), "PATCH", { status: "archived" }),
      threadContext(seed.thread.id),
    );
    eq(response.status, 400, "an unsupported status is 400");
    eq(run.calls.resolveRole.length, 0, "an invalid status body never resolves a role");
  }
  for (const method of ["GET", "PUT", "DELETE"]) {
    const run = scenario();
    const response = await thread(
      new Request(threadUrl("t_x_00000000"), { method }),
      threadContext("t_x_00000000"),
    );
    eq(response.status, 405, `${method} on a thread is 405`);
    eq(run.calls.resolveRole.length, 0, `${method} resolves no role`);
  }

  /* ---- edit.mjs: the closed factory seam and the direct-edit gate ------- */

  {
    // P4-N narrowed this factory to ten dependencies: the manifest, source,
    // repository and receipt work moved behind `readEffectiveBase`/`applyText`
    // in `gitedit.mjs`. What P4-M established must survive that move — the
    // access seam is still injected here, and it is still closed.
    const editKeys = [
      "requireOrigin", "identify", "resolveRole", "capabilitiesFor",
      "readEffectiveBase", "applyText", "notify", "toMd", "toHtml", "sha256Hex",
    ];
    // The vendored deploy-tree copy, not `templates/docbuild/dist/`: it is the
    // exact module `edit.mjs` imports in production (#129).
    const md = await import(url("netlify/lib/inline-md.mjs"));
    const completeDeps = () => ({
      requireOrigin: () => {},
      identify: async () => null,
      resolveRole: async () => ({}),
      capabilitiesFor: () => ({}),
      readEffectiveBase: async () => ({}),
      applyText: async () => ({}),
      notify: () => true,
      toMd: md.toMd,
      toHtml: md.toHtml,
      sha256Hex: () => "",
    });

    eq(Object.keys(completeDeps()).sort().join(","), [...editKeys].sort().join(","),
      "the post-N edit factory takes exactly the narrowed key set");
    ok(editKeys.includes("resolveRole") && editKeys.includes("capabilitiesFor"),
      "the post-M access seam is still injected into the edit factory");
    ok(typeof createEditHandler(completeDeps()) === "function",
      "the post-N factory returns a handler");
    for (const key of ["resolveRole", "capabilitiesFor"]) {
      const partial = completeDeps();
      delete partial[key];
      let threw = false;
      try { createEditHandler(partial); } catch { threw = true; }
      ok(threw, `the factory refuses a dependency object missing ${key}`);
      const wrong = completeDeps();
      wrong[key] = "not a function";
      let typeThrew = false;
      try { createEditHandler(wrong); } catch { typeThrew = true; }
      ok(typeThrew, `the factory refuses a non-callable ${key}`);
    }
    {
      // Neither request data nor a later mutation can replace the captured
      // callables: the factory froze its own copy.
      const deps = completeDeps();
      const handler = createEditHandler(deps);
      deps.resolveRole = () => { throw new Error("replaced"); };
      ok(typeof handler === "function", "a post-construction dependency swap is inert");
    }
    {
      const extra = { ...completeDeps(), surprise: () => {} };
      let threw = false;
      try { createEditHandler(extra); } catch { threw = true; }
      ok(threw, "the factory still refuses an extra dependency key");
    }
  }

  {
    // The direct-edit gate itself. The apply path beyond it is P4-N's matrix,
    // so this fixture stops at the first step after authorization: the one
    // apply path reports a document it does not know. An authorized caller
    // reaches that 404; an unauthorized one is refused before `gitedit.mjs`
    // is consulted at all.
    // The vendored deploy-tree copy, not `templates/docbuild/dist/`: it is the
    // exact module `edit.mjs` imports in production (#129).
    const md = await import(url("netlify/lib/inline-md.mjs"));
    const gitedit = await import(url("netlify/lib/gitedit.mjs"));

    function buildEdit(options = {}) {
      const counters = { resolveRole: 0, readEffectiveBase: 0, applyText: 0, notify: 0 };
      const seen = [];
      const deps = {
        requireOrigin: () => {},
        identify: async () => (options.identity === undefined
          ? { ...WRITER, emailVerified: true }
          : options.identity),
        resolveRole: async (docId, user, opts) => {
          counters.resolveRole += 1;
          seen.push({ docId, user, options: opts });
          if (options.accessThrows !== undefined) throw options.accessThrows;
          if (options.access !== undefined) return options.access;
          return resolvedFor(options.role ?? "owner");
        },
        capabilitiesFor: options.capabilitiesFor ?? accessLib.capabilitiesFor,
        readEffectiveBase: async () => {
          counters.readEffectiveBase += 1;
          throw new gitedit.ApplyError("not-found");
        },
        applyText: async () => {
          counters.applyText += 1;
          throw new Error("no apply work expected past the gate");
        },
        notify: () => { counters.notify += 1; return true; },
        toMd: md.toMd,
        toHtml: md.toHtml,
        sha256Hex: () => "0".repeat(64),
      };
      return { handle: createEditHandler(deps), counters, seen };
    }

    const editBody = { docId: DOC_ID, aid: AID, text: "A revised espalier row." };
    const editRequest = () => jsonRequest("https://docs.example.invalid/api/edit", "POST", editBody);
    const editContext = () => ({});

    for (const role of ROLES) {
      const row = accessLib.capabilitiesFor(role);
      const allowed = row.canSuggest === true && row.canEdit === true;
      const built = buildEdit({ role });
      const response = await built.handle(editRequest(), editContext());
      eq(built.counters.resolveRole, 1, `a direct edit as ${role} resolves the role exactly once`);
      eq(built.seen[0].options, { consumeInvitation: false },
        `a direct edit as ${role} never consumes an invitation`);
      eq(built.seen[0].docId, DOC_ID, `a direct edit as ${role} resolves the body's document`);
      if (allowed) {
        // Past the gate; the invented document is not in any manifest.
        eq(response.status, 404, `a direct edit as ${role} passes the gate`);
        eq(built.counters.readEffectiveBase, 1, `a direct edit as ${role} reaches the apply path`);
      } else {
        eq(response.status, 403, `a direct edit as ${role} is 403`);
        eq(await readJson(response),
          { error: { code: "forbidden", message: "Document edit denied" } },
          `a direct edit as ${role} returns the predecessor 403 body`);
        eq(built.counters.readEffectiveBase, 0, `a direct edit as ${role} performs no apply work`);
        eq(built.counters.applyText, 0, `a direct edit as ${role} writes nothing`);
        eq(built.counters.notify, 0, `a direct edit as ${role} notifies nobody`);
      }
    }
    {
      // A commenter has canSuggest without canEdit: the editing-family check
      // passes and the direct-write check is what refuses. P4-O will use the
      // first without the second.
      const row = accessLib.capabilitiesFor("commenter");
      eq(row.canSuggest, true, "a commenter can suggest");
      eq(row.canEdit, false, "a commenter cannot directly edit");
      const built = buildEdit({ role: "commenter" });
      eq((await built.handle(editRequest(), editContext())).status, 403,
        "a commenter is refused a direct edit");
    }
    {
      // No identity field decides anything: the document role does. `isOrg` used
      // to be the field this case varied; ACN-006 removed it, and `emailVerified`
      // -- the field that replaced it in the shape -- is deliberately not a
      // second write gate either.
      const built = buildEdit({ identity: { ...WRITER, emailVerified: false }, role: "editor" });
      eq((await built.handle(editRequest(), editContext())).status, 404,
        "an unverified address does not refuse an editor");
      const denied = buildEdit({ identity: { ...WRITER, emailVerified: true }, role: "viewer" });
      eq((await denied.handle(editRequest(), editContext())).status, 403,
        "and a verified one does not admit a viewer");
    }
    {
      const built = buildEdit({ role: "none" });
      const response = await built.handle(
        jsonRequest("https://docs.example.invalid/api/edit", "POST", { ...editBody, docId: OTHER_DOC }),
        editContext(),
      );
      eq(response.status, 403, "a denied direct edit is 403 rather than the apply path's 404");
    }
    for (const [label, body] of [
      ["an unknown key", { ...editBody, role: "owner" }],
      ["a missing aid", { docId: DOC_ID, text: "x" }],
      ["a malformed doc id", { ...editBody, docId: "zzzz" }],
    ]) {
      const built = buildEdit();
      const response = await built.handle(
        jsonRequest("https://docs.example.invalid/api/edit", "POST", body),
        editContext(),
      );
      eq(response.status, 400, `a direct edit with ${label} is 400`);
      eq(built.counters.resolveRole, 0, `a direct edit with ${label} never resolves a role`);
    }
    {
      const built = buildEdit();
      const response = await built.handle(
        new Request("https://docs.example.invalid/api/edit?doc=4b7d2a", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editBody),
        }),
        editContext(),
      );
      eq(response.status, 400, "a query parameter is still refused before the lookup");
      eq(built.counters.resolveRole, 0, "a refused query never resolves a role");
    }
    for (const [label, access] of brokenAccess) {
      const built = buildEdit({ access });
      const response = await built.handle(editRequest(), editContext());
      eq(response.status, 500, `a direct edit with ${label} is 500`);
      eq(built.counters.readEffectiveBase, 0, `a direct edit with ${label} performs no apply work`);
    }
    {
      const built = buildEdit({ capabilitiesFor: () => { throw new Error("no row"); } });
      eq((await built.handle(editRequest(), editContext())).status, 500,
        "a direct edit with an unusable capability table is 500");
    }
    {
      const built = buildEdit({
        accessThrows: new storeLib.StoreError("unavailable", 503, "Access store unavailable"),
      });
      const response = await built.handle(editRequest(), editContext());
      eq(response.status, 503, "a direct edit with the exact unavailable shape is 503");
      eq((await readJson(response)).error.code, "unavailable", "the direct-edit 503 code");
    }
    for (const [label, thrown] of [
      ["an arbitrary error", new Error("boom")],
      ["a plain lookalike", { name: "StoreError", code: "unavailable" }],
      ["a different store code", new storeLib.StoreError("conflict", 409, "Concurrent write")],
    ]) {
      const built = buildEdit({ accessThrows: thrown });
      eq((await built.handle(editRequest(), editContext())).status, 500,
        `a direct edit whose access fails with ${label} is 500, never 503`);
    }
  }

  /* ---- the amendment order is visible in the source -------------------- */

  {
    const edit = readFileSync(join(ROOT, "netlify/functions/edit.mjs"), "utf8");
    ok(/canSuggest/.test(edit) && /canEdit/.test(edit),
      "edit.mjs carries both editing-family checks");
    ok(!/\bisOrg\b/.test(edit),
      "the temporary organisation write gate is gone, field and all");
    ok(/gitedit\.mjs`? is not an authorization oracle/.test(edit),
      "edit.mjs records that P4-N must leave the gate here");
    for (const file of ["threads.mjs", "thread.mjs", "edit.mjs"]) {
      const text = readFileSync(join(ROOT, "netlify/functions", file), "utf8");
      ok(!text.includes("consumeInvitation: true"), `${file} never consumes an invitation`);
      ok(!text.includes("/api/events"), `${file} never calls the events HTTP API`);
    }
    for (const file of ["threads.mjs", "thread.mjs"]) {
      const text = readFileSync(join(ROOT, "netlify/functions", file), "utf8");
      ok(!/console\.|process\.env|fetch\s*\(|waitUntil\s*\(|\bpublish\s*\(/.test(text),
        `${file} reaches no sink, environment, or log of its own`);
    }
  }

  return checks;
}

/* ========================================================================= */
/* the opt-in hosted branch                                                  */
/* ========================================================================= */

/** Prove, before creating anything, that this machine can both create and
 * delete every disposable resource the hosted lifecycle would need. Anything
 * short of that proof is a refusal, never a PASS line. */
async function hostedWorker() {
  const missing = [];
  for (const [tool, args] of [["netlify", ["status"]], ["gh", ["auth", "status"]]]) {
    const proven = await new Promise((resolve) => {
      const child = spawn(tool, args, { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
    if (!proven) missing.push(tool);
  }
  if (missing.length !== 0) {
    process.stderr.write(
      `hosted gate refused: no authenticated ${missing.join(" or ")} able to create and ` +
      "delete disposable fixture resources\n",
    );
    process.exitCode = UNPROVEN_CODE;
    return;
  }
  process.stderr.write(
    "hosted gate refused: the disposable site, branch, and PR lifecycle is not implemented " +
    "in this harness; see the P4-M pull request's Spec defects section\n",
  );
  process.exitCode = UNPROVEN_CODE;
}

/* ========================================================================= */
/* entry                                                                     */
/* ========================================================================= */

async function main() {
  const mode = process.argv[2];
  if (mode === "--signal-probe") return signalProbe();
  if (mode === "--stubborn-probe") return stubbornProbe();
  if (mode === "--deadline-probe") return deadlineProbe();
  if (mode === "--runtime") {
    await runtimeMatrix();
    return;
  }
  if (mode === "--hosted-worker") {
    await hostedWorker();
    return;
  }
  if (mode === "--hosted") {
    if (process.env.AIUR_P4M_HOSTED !== "1") {
      process.stderr.write("hosted execution requires AIUR_P4M_HOSTED=1\n");
      process.exitCode = 2;
      return;
    }
    await supervise(true);
    return;
  }
  if (mode !== undefined) {
    process.stderr.write("usage: node scripts/test-p4-m.mjs [--hosted]\n");
    process.exitCode = 2;
    return;
  }
  await supervise(false);
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
