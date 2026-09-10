#!/usr/bin/env node
/**
 * P4-N — the permanent one-apply-path regression runner.
 *
 *   node scripts/test-p4-n.mjs
 *   AIUR_P4N_HOSTED=1 node scripts/test-p4-n.mjs --hosted
 *
 * One entry point, three lines of output. The supervisor proves its own signal
 * and deadline behaviour first — including against a child that installs a
 * TERM handler and refuses to die — then launches the runtime matrix as a
 * direct child in its own process group under a mode-0700 temporary root,
 * gives it a deadline, caps captured output, forwards HUP/INT/TERM, escalates
 * TERM to KILL only for a child it has proved is still alive, reaps it, proves
 * its process group is gone, and removes the guarded root before it can report
 * success. Cleanup it cannot prove exits 125 and retains a mode-0600 locator
 * naming the resource it could not resolve.
 *
 * Nothing in the default path reads a credential, a real repository, a remote
 * provider, or a private fixture. The matrix drives the real
 * `createGitEditService()`, the real `createEditHandler()`, and the real
 * `createPendingHandler()` through injected filesystem, store, fetch, access,
 * clock, hash, and notification seams. Every fixture is invented.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const OUTER_DEADLINE_MS = 240_000;
const HOSTED_DEADLINE_MS = 1_200_000;
const WORKER_DEADLINE_MS = 120_000;
const PROBE_DEADLINE_MS = 1_000;
const ESCALATE_MS = 2_000;
const MAX_CAPTURE_BYTES = 262_144;
const DEADLINE_CODE = 124;
const UNCERTAIN_CODE = 125;

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

/** Assert that `run` rejects, and hand the rejection to `check`. */
async function rejects(run, check, label) {
  let thrown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  ok(thrown !== null, `${label} rejected`);
  check(thrown);
}

/** Assert that `run` throws synchronously, and hand the throw to `check`. */
function throwsSync(run, check, label) {
  let thrown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  ok(thrown !== null, `${label} threw`);
  check(thrown);
}

/* ========================================================================= */
/* the supervisor                                                            */
/* ========================================================================= */

function signalNumber(name) {
  const table = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
  return table[name] ?? 0;
}

/** Whether the process group is provably gone. `false` means alive; `null`
 * means the answer is not knowable, which is never treated as gone. */
function groupState(pid) {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    if (error.code === "ESRCH") return "gone";
    return "unknown";
  }
}

/** Run one direct child in its own process group with a deadline, a bounded
 * capture, TERM-then-KILL escalation of a proved-live group, and forwarded
 * operator signals. */
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
    // Only a group this supervisor has just proved alive is signalled. A group
    // that is already gone is never "killed" again, and a group whose state is
    // unknown is left alone and surfaced as uncertainty by the caller.
    const group = (signal) => {
      if (groupState(child.pid) !== "alive") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // It exited between the probe and the signal. Nothing to escalate to.
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

/** Retain a mode-0600 locator naming exactly what could not be resolved, then
 * exit 125 without a PASS line. */
function uncertain(root, detail) {
  const locator = `${root}.locator`;
  try {
    writeFileSync(locator, `${detail}\n${root}\n`, { mode: 0o600 });
    chmodSync(locator, 0o600);
  } catch {
    // Even the locator could not be written. The message below is all there is.
  }
  process.stderr.write(`UNRESOLVED ${detail}\n  root ${root}\n  locator ${locator}\n`);
  process.exit(UNCERTAIN_CODE);
}

async function supervise() {
  const root = mkdtempSync(join(tmpdir(), "p4n-"));
  chmodSync(root, 0o700);
  const started = Date.now();
  const remaining = () => OUTER_DEADLINE_MS - (Date.now() - started);

  // 1. Signals. Each probe installs its own handler and exits 128 + signum.
  for (const [signal, expected] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
    const probeRoot = join(root, `signal-${signal}`);
    mkdirSync(probeRoot, { mode: 0o700 });
    const pending = runChild(["--signal-probe"], Math.max(1_000, remaining()), {}, probeRoot);
    const pid = await waitForReady(probeRoot);
    process.kill(-pid, signal);
    const result = await pending;
    eq(result.code, expected, `signal probe ${signal} exit code`);
    if (groupState(result.pid) !== "gone") {
      uncertain(root, `signal probe ${signal} process group ${result.pid} not proved gone`);
    }
  }

  // 2. The deadline, against a child that installs a TERM handler and refuses
  //    to leave. TERM alone cannot end it; the escalation to KILL must, and the
  //    supervisor reports 124 exactly like the timeout utility.
  const deadlineRoot = join(root, "deadline");
  mkdirSync(deadlineRoot, { mode: 0o700 });
  const late = await runChild(["--deadline-probe"], PROBE_DEADLINE_MS, {}, deadlineRoot);
  eq(late.code, DEADLINE_CODE, "TERM-resistant deadline probe reports 124");
  if (groupState(late.pid) !== "gone") {
    uncertain(root, `deadline probe process group ${late.pid} not proved gone`);
  }
  process.stdout.write("PASS  P4-N supervisor signals and deadline\n");

  // 3. The one runtime matrix.
  const workerRoot = join(root, "runtime");
  mkdirSync(workerRoot, { mode: 0o700 });
  const budget = Math.min(WORKER_DEADLINE_MS, Math.max(1_000, remaining()));
  const result = await runChild(["--runtime"], budget, { P4N_ROOT: workerRoot }, ROOT);
  if (result.code !== 0 || result.stderr !== "") {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`runtime worker exited ${result.code}`);
  }
  if (groupState(result.pid) !== "gone") {
    uncertain(root, `runtime worker process group ${result.pid} not proved gone`);
  }
  process.stdout.write(
    "PASS  P4-N modes, pending, conflict, Git, receipt, replay, and fan-out runtime\n",
  );

  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    uncertain(root, `guarded fixture root could not be removed: ${error.code ?? "unknown"}`);
  }
  if (existsSync(root)) uncertain(root, "guarded fixture root survived removal");
  process.stdout.write("PASS  P4-N fixture cleaned\n");
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

/** Deliberately TERM-resistant: it acknowledges the signal and keeps running,
 * so only the supervisor's escalation to KILL can end it. */
function deadlineProbe() {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
  writeFileSync(join(process.cwd(), "ready"), `${process.pid}\n`);
  setInterval(() => {}, 1000);
}

/* ========================================================================= */
/* the shared fixture                                                        */
/* ========================================================================= */

const DOC_ID = "4b7d2a";
const OTHER_DOC = "9c0e11";
const AID = "a31b7c9d2";
const OTHER_AID = "a1111111a";
const INSTANCE = "orchard";
const SECTION_FILE = "sections/01-index.html";
const SECTION_ID = "index";
const COMMIT = "7aaca51";

const SUB = "u_fixture_writer_31";
const NAME = "Avery Quill";
const EMAIL = "avery@example.com";
const OTHER_SUB = "u_fixture_decider_77";
const OTHER_NAME = "Rowan Vale";
const OTHER_EMAIL = "rowan@example.com";
const BOT_EMAIL = "bot@example.com";
const REPO = "orchard-team/orchard-docs";
const BASE = "main";
const TOKEN = "ghp_fixture_token_value";
const SUG_ID = "s_orchard_1a2b3c4d";
const OTHER_SUG = "s_orchard_9f8e7d6c";

const NOW_MS = Date.parse("2026-09-03T17:04:11.201Z");
const NOW_ISO = "2026-09-03T17:04:11.201Z";
const OLD_ISO = "2026-09-01T09:00:00.000Z";

const INNER = "The orchard index covers <strong>every</strong> declared basket.";
const TEXT = "The orchard index covers **every** declared basket.";
const NEXT_TEXT = "The orchard index covers **each** declared basket.";
const THIRD_TEXT = "The orchard index covers **most** declared baskets.";

const SOURCE = [
  "<!--",
  "id: index",
  "-->",
  "<!-- body -->",
  `<h2 data-aid="${OTHER_AID}">Orchard</h2>`,
  `<p data-aid="${AID}">${INNER}</p>`,
  "",
].join("\n");

const ANCHORS = JSON.stringify({
  [SECTION_ID]: {
    ids: [OTHER_AID, AID],
    texts: ["Orchard", "The orchard index covers every declared basket."],
  },
});

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const BASE_HASH = sha256(INNER);

const ACTOR = Object.freeze({ sub: SUB, name: NAME, email: EMAIL });
const DECIDER = Object.freeze({ sub: OTHER_SUB, name: OTHER_NAME, email: OTHER_EMAIL });

const REPO_ENV = Object.freeze({
  DOCS_REPO: REPO,
  DOCS_BASE_BRANCH: BASE,
  DOCS_GITHUB_TOKEN: TOKEN,
  DOCS_BOT_EMAIL: BOT_EMAIL,
});

const MODE_KEY = `mode/${DOC_ID}/manifest.json`;
const EDIT_KEY = `edits/${DOC_ID}/${AID}.json`;
const STRONG = JSON.stringify({ type: "json", consistency: "strong" });

function manifestFor(overrides = {}) {
  return {
    docId: DOC_ID,
    instance: INSTANCE,
    commit: COMMIT,
    blocks: {
      [AID]: { file: SECTION_FILE, section: SECTION_ID, tag: "p", hash: BASE_HASH },
    },
    ...overrides,
  };
}

function writeSidecar(root, manifest, instance = INSTANCE) {
  const dist = join(root, instance, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, `${instance}.edit.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** An in-memory blob store with the exact provider surface P2-B and the
 * standalone sidecar read both use. Every call is recorded. */
class FakeStore {
  constructor() {
    this.records = new Map();
    this.version = 0;
    this.calls = [];
    this.getHook = null;
    this.readHook = null;
    this.writeHook = null;
  }

  async get(key, options) {
    this.calls.push({ op: "get", key, options: JSON.stringify(options ?? null) });
    if (this.getHook !== null) {
      const hook = this.getHook;
      this.getHook = null;
      return hook(key, options, this);
    }
    const found = this.records.get(key);
    return found === undefined ? null : structuredClone(found.value);
  }

  async getWithMetadata(key, options) {
    this.calls.push({ op: "getWithMetadata", key, options: JSON.stringify(options ?? null) });
    if (this.readHook !== null) {
      const hook = this.readHook;
      this.readHook = null;
      return hook(key, this);
    }
    const found = this.records.get(key);
    if (found === undefined) return null;
    return { data: structuredClone(found.value), etag: found.etag };
  }

  async setJSON(key, value, options) {
    this.calls.push({ op: "setJSON", key, options: JSON.stringify(options) });
    if (this.writeHook !== null) {
      const hook = this.writeHook;
      this.writeHook = null;
      return hook(key, value, options, this);
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

  list(options) {
    this.calls.push({ op: "list", key: options.prefix, options: JSON.stringify(options) });
    const blobs = [...this.records.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .map(([key, row]) => ({ key, etag: row.etag }));
    return {
      async *[Symbol.asyncIterator]() {
        yield { blobs, directories: [] };
      },
    };
  }

  seed(key, value) {
    this.version += 1;
    this.records.set(key, { value: structuredClone(value), etag: `"v${this.version}"` });
    return `"v${this.version}"`;
  }

  gets() {
    return this.calls.filter((call) => call.op === "get");
  }
}

/** A closed GitHub double. Every route is declared; an undeclared route is a
 * test failure rather than a silent network call. */
class FakeGitHub {
  constructor(options = {}) {
    this.calls = [];
    this.branchExists = options.branchExists ?? true;
    this.createStatus = options.createStatus ?? 201;
    this.raceResolves = options.raceResolves ?? true;
    this.anchors = options.anchors ?? ANCHORS;
    this.source = options.source ?? SOURCE;
    this.putStatuses = options.putStatuses ?? [200];
    this.openPulls = options.openPulls ?? [];
    this.createdPull = options.createdPull ?? { status: 201, number: 412 };
    this.headMessage = options.headMessage ?? "Seed the orchard";
    this.committed = null;
    this.createdBody = null;
    this.baseSha = "1".repeat(40);
    this.headSha = "2".repeat(40);
    this.blobSha = "3".repeat(40);
    this.branch = options.branch ?? branchFor(SUB);
  }

  json(status, body) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  file(text) {
    return this.json(200, {
      type: "file",
      encoding: "base64",
      sha: this.blobSha,
      content: Buffer.from(text, "utf8").toString("base64"),
    });
  }

  async fetch(url, init) {
    const target = new URL(url);
    const path = target.pathname;
    const method = init.method;
    this.calls.push(`${method} ${path}${target.search}`);

    if (method === "GET" && path === `/repos/${REPO}/git/ref/heads/${BASE}`) {
      return this.json(200, { object: { sha: this.baseSha } });
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/git/ref/heads/docedit`)) {
      if (!this.branchExists) return this.json(404, { message: "Not Found" });
      return this.json(200, { object: { sha: this.headSha } });
    }
    if (method === "POST" && path === `/repos/${REPO}/git/refs`) {
      if (this.createStatus === 201) {
        this.branchExists = true;
        return this.json(201, { object: { sha: this.baseSha } });
      }
      if (this.createStatus === 422) {
        this.branchExists = this.raceResolves;
        return this.json(422, { message: "Reference already exists" });
      }
      return this.json(this.createStatus, { message: "no" });
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/commits/`)) {
      return this.json(200, { sha: this.headSha, commit: { message: this.headMessage } });
    }
    if (method === "GET" && path === `/repos/${REPO}/contents/${INSTANCE}/anchors.json`) {
      return this.file(this.anchors);
    }
    if (method === "GET" && path.startsWith(`/repos/${REPO}/contents/${INSTANCE}/sections/`)) {
      return this.file(this.source);
    }
    if (method === "PUT" && path.startsWith(`/repos/${REPO}/contents/${INSTANCE}/sections/`)) {
      const payload = JSON.parse(init.body);
      const status = this.putStatuses.shift() ?? 200;
      if (status === 200 || status === 201) {
        this.committed = payload;
        return this.json(status, { content: { sha: this.blobSha } });
      }
      return this.json(status, { message: "conflict" });
    }
    if (method === "GET" && path === `/repos/${REPO}/pulls`) {
      return this.json(200, this.openPulls);
    }
    if (method === "POST" && path === `/repos/${REPO}/pulls`) {
      this.createdBody = JSON.parse(init.body);
      if (this.createdPull.status !== 201) {
        return this.json(this.createdPull.status, { message: "no" });
      }
      return this.json(201, {
        number: this.createdPull.number,
        head: { ref: this.branch },
        base: { ref: BASE },
      });
    }
    throw new Error(`undeclared route ${method} ${path}`);
  }

  count(prefix) {
    return this.calls.filter((call) => call.startsWith(prefix)).length;
  }
}

const branchFor = (sub) => `docedit/${DOC_ID}/${sha256(sub).slice(0, 16)}`;

const openPullRow = (branch) => ({
  number: 77,
  head: { ref: branch },
  base: { ref: BASE },
});

/** The exact P3-E receipts this fixture writes and reads back. */
function directReceipt(overrides = {}) {
  return {
    v: 1,
    aid: AID,
    text: TEXT,
    by: { ...ACTOR },
    at: NOW_ISO,
    baseHash: BASE_HASH,
    pr: null,
    via: "edit",
    ...overrides,
  };
}

function suggestionReceipt(overrides = {}) {
  return {
    v: 1,
    aid: AID,
    text: NEXT_TEXT,
    by: { ...ACTOR },
    at: NOW_ISO,
    baseHash: BASE_HASH,
    pr: null,
    via: "suggestion",
    sugId: SUG_ID,
    acceptedBy: { ...DECIDER },
    acceptedAt: NOW_ISO,
    ...overrides,
  };
}

/* ========================================================================= */
/* the runtime matrix                                                        */
/* ========================================================================= */

async function runtimeMatrix() {
  const load = (relative) => import(pathToFileURL(join(ROOT, relative)).href);
  const gitedit = await load("netlify/lib/gitedit.mjs");
  const editModule = await load("netlify/functions/edit.mjs");
  const pendingModule = await load("netlify/functions/pending.mjs");
  const storeLib = await load("netlify/lib/store.mjs");
  const access = await load("netlify/lib/access.mjs");
  // The vendored deploy-tree copy, not `templates/docbuild/dist/`: it is the
  // exact module `gitedit.mjs` and `edit.mjs` import in production (#129).
  const md = await load("netlify/lib/inline-md.mjs");

  const { ApplyError, assertApplyManifest, assertApplyReceipt, createGitEditService } = gitedit;

  const workRoot = process.env.P4N_ROOT ?? mkdtempSync(join(tmpdir(), "p4n-work-"));
  const repoRoot = join(workRoot, "deploy");
  mkdirSync(repoRoot, { recursive: true, mode: 0o700 });
  writeSidecar(repoRoot, manifestFor());

  const overlayHash = (text) => sha256(md.toHtml(text));
  eq(md.toMd(INNER), TEXT, "fixture inner html round-trips to the fixture text");
  eq(md.toHtml(TEXT), INNER, "fixture text round-trips to the fixture inner html");

  const isApply = (error, status, code) => {
    ok(error instanceof ApplyError, `${code} is an ApplyError`);
    eq(error.status, status, `${code} status`);
    eq(error.code, code, `${code} code`);
  };

  /* ------------------------------------------------------------ the seam */

  eq(
    Object.keys(gitedit).sort(),
    ["ApplyError", "applyText", "assertApplyManifest", "assertApplyReceipt",
      "createGitEditService", "readApplyManifest", "readApplyReceipt", "readEffectiveBase"],
    "library exports exactly eight names",
  );
  eq(Object.keys(editModule).sort(), ["config", "createEditHandler", "default"], "edit exports");
  eq(
    Object.keys(pendingModule).sort(),
    ["config", "createPendingHandler", "default"],
    "pending exports",
  );
  eq(editModule.default.length, 2, "default edit handler has (req, context) arity");

  const seam = createGitEditService({});
  eq(
    Object.getOwnPropertyNames(seam).sort(),
    ["applyText", "readApplyManifest", "readApplyReceipt", "readEffectiveBase"],
    "service exposes exactly four members",
  );
  ok(Object.isFrozen(seam), "service object is frozen");
  for (const name of Object.getOwnPropertyNames(seam)) {
    eq(typeof seam[name], "function", `service.${name} is a function`);
    eq(seam[name].name, name, `service.${name} is named`);
    eq(seam[name].constructor.name, "AsyncFunction", `service.${name} is async`);
  }

  const noop = () => {};
  const acceptedKeys = [
    "storeFn", "readFn", "mutateFn", "fetchFn", "appendEventFn", "nowFn", "sha256Fn",
    "closeSyncFn", "fstatSyncFn", "lstatSyncFn", "openSyncFn", "readSyncFn", "readdirSyncFn",
    "scanBlocksFn", "toMdFn", "toHtmlFn",
  ];
  for (const key of acceptedKeys) {
    ok(createGitEditService({ [key]: noop }) !== null, `dependency ${key} accepted`);
    throwsSync(
      () => createGitEditService({ [key]: "nope" }),
      (error) => eq(error.message, "Invalid git edit dependencies", `${key} wrong type message`),
      `dependency ${key} wrong type`,
    );
    throwsSync(
      () => createGitEditService({ [key]: undefined }),
      (error) => ok(error instanceof TypeError, `${key} explicit undefined is a TypeError`),
      `dependency ${key} explicit undefined`,
    );
  }
  ok(createGitEditService({ manifestRoot: repoRoot }) !== null, "absolute manifestRoot accepted");
  ok(createGitEditService({ env: { DOCS_REPO: REPO } }) !== null, "narrow env accepted");
  ok(createGitEditService() !== null, "omitted dependency object accepted");

  const rejectedSeams = [
    ["unknown key", { unknown: noop }],
    ["null", null],
    ["array", []],
    ["custom prototype", Object.assign(Object.create({ x: 1 }), {})],
    ["relative manifestRoot", { manifestRoot: "relative/path" }],
    ["non-string manifestRoot", { manifestRoot: 7 }],
    ["env with unknown key", { env: { OTHER: "x" } }],
    ["env with non-string value", { env: { DOCS_REPO: 7 } }],
    ["env array", { env: [] }],
    ["env null", { env: null }],
  ];
  for (const [label, value] of rejectedSeams) {
    throwsSync(
      () => createGitEditService(value),
      (error) => {
        ok(error instanceof TypeError, `${label} is a TypeError`);
        eq(error.message, "Invalid git edit dependencies", `${label} message`);
      },
      `dependency ${label}`,
    );
  }
  const withSymbol = { storeFn: noop };
  withSymbol[Symbol("s")] = 1;
  throwsSync(
    () => createGitEditService(withSymbol),
    (error) => ok(error instanceof TypeError, "symbol key is a TypeError"),
    "dependency symbol key",
  );
  const withAccessor = {};
  Object.defineProperty(withAccessor, "storeFn", { get: () => noop, enumerable: true });
  throwsSync(
    () => createGitEditService(withAccessor),
    (error) => ok(error instanceof TypeError, "accessor is a TypeError"),
    "dependency accessor",
  );
  const withEnvSymbol = {};
  withEnvSymbol[Symbol("s")] = 1;
  throwsSync(
    () => createGitEditService({ env: withEnvSymbol }),
    (error) => ok(error instanceof TypeError, "env symbol is a TypeError"),
    "dependency env symbol",
  );

  /* ------------------------------------------------- the pure validators */

  eq(
    Reflect.ownKeys(assertApplyManifest(manifestFor(), DOC_ID)),
    ["docId", "instance", "commit", "blocks"],
    "manifest clone keeps the canonical field order",
  );
  throwsSync(
    () => assertApplyManifest(manifestFor(), OTHER_DOC),
    (error) => isApply(error, 500, "invalid-state"),
    "manifest with a different document id",
  );
  throwsSync(
    () => assertApplyManifest(manifestFor({ commit: "zzzzzzz" }), DOC_ID),
    (error) => isApply(error, 500, "invalid-state"),
    "manifest with a non-hex commit",
  );
  throwsSync(
    () => assertApplyManifest({ ...manifestFor(), owner: SUB }, DOC_ID),
    (error) => isApply(error, 500, "invalid-state"),
    "manifest carrying an authority field",
  );
  throwsSync(
    () => assertApplyManifest(
      { instance: INSTANCE, docId: DOC_ID, commit: COMMIT, blocks: {} }, DOC_ID,
    ),
    (error) => isApply(error, 500, "invalid-state"),
    "manifest with reordered fields",
  );

  {
    // A manifest larger than the declared bound is a corrupt document, not a
    // transient outage: it must never map to the 503 that invites a retry.
    const blocks = {};
    for (let at = 0; at <= 5_000; at += 1) {
      blocks[`a${at.toString(16).padStart(8, "0")}`] = {
        file: SECTION_FILE, section: SECTION_ID, tag: "p", hash: BASE_HASH,
      };
    }
    throwsSync(
      () => assertApplyManifest(manifestFor({ blocks }), DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "a manifest over the row bound is invalid state, never unavailable",
    );
  }

  for (const forged of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    // The public error table is consulted by own property only. A code that
    // happens to name something on `Object.prototype` must not resolve to a
    // row that is not a row, which would yield an undefined status.
    const error = new ApplyError(forged);
    isApply(error, 500, "invalid-state");
    eq(error.message, "Invalid edit state", `a forged ${forged} code keeps the safe message`);
  }

  const storedDirect = directReceipt();
  eq(
    Reflect.ownKeys(assertApplyReceipt(storedDirect, AID)),
    ["v", "aid", "text", "by", "at", "baseHash", "pr", "via"],
    "direct receipt clone keeps the canonical field order",
  );
  eq(
    Reflect.ownKeys(assertApplyReceipt(suggestionReceipt(), AID)),
    ["v", "aid", "text", "by", "at", "baseHash", "pr", "via",
      "sugId", "acceptedBy", "acceptedAt"],
    "suggestion receipt clone keeps the canonical field order",
  );
  ok(assertApplyReceipt(storedDirect, AID) !== storedDirect, "receipt is freshly cloned");
  throwsSync(
    () => assertApplyReceipt(storedDirect, OTHER_AID),
    (error) => isApply(error, 500, "invalid-state"),
    "receipt validated against the wrong aid",
  );
  throwsSync(
    () => assertApplyReceipt(storedDirect),
    (error) => isApply(error, 500, "invalid-state"),
    "receipt validated without a mandatory aid",
  );
  throwsSync(
    () => assertApplyReceipt(suggestionReceipt({ acceptedBy: null }), AID),
    (error) => isApply(error, 500, "invalid-state"),
    "suggestion receipt without a valid accepter",
  );
  throwsSync(
    () => assertApplyReceipt(directReceipt({ pr: 0 }), AID),
    (error) => isApply(error, 500, "invalid-state"),
    "receipt with a non-positive pull-request number",
  );
  ok(
    assertApplyReceipt(directReceipt({ by: { sub: SUB, name: "", email: "" } }), AID) !== null,
    "receipt admits the canonical empty actor",
  );

  /* ------------------------------------------------- mode and manifest */

  const modeService = (options = {}) => {
    const store = options.store ?? new FakeStore();
    const reads = [];
    const env = options.env ?? {};
    const service = createGitEditService({
      env,
      storeFn: () => store,
      readFn: async (...args) => {
        reads.push(args[1]);
        return storeLib.read(...args);
      },
      nowFn: () => NOW_MS,
      ...(env.DOCS_REPO === undefined
        ? {}
        : { manifestRoot: options.manifestRoot ?? repoRoot }),
      ...(options.extra ?? {}),
    });
    return { service, store, reads };
  };

  {
    const { service, store, reads } = modeService();
    store.seed(MODE_KEY, manifestFor());
    const selected = await service.readApplyManifest(DOC_ID);
    eq(selected.mode, "standalone", "standalone mode selected with no repository configuration");
    eq(Reflect.ownKeys(selected), ["mode", "manifest"], "selection is the exact boundary");
    ok(Object.isFrozen(selected), "selection is frozen");
    eq(selected.manifest.blocks[AID].hash, BASE_HASH, "standalone row hash");
    eq(store.gets().length, 1, "standalone performs exactly one raw get");
    eq(store.gets()[0].key, MODE_KEY, "standalone reads the exact private key");
    eq(store.gets()[0].options, STRONG, "standalone reads strongly as json");
    eq(reads.length, 0, "standalone never uses the versioned read() helper for the manifest");
  }

  {
    const { service } = modeService();
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 404, "not-found"),
      "missing standalone manifest is 404",
    );
  }

  {
    const { service, store } = modeService();
    store.getHook = () => {
      throw new SyntaxError("bad json");
    };
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "standalone SyntaxError is 500",
    );
  }

  {
    const { service, store } = modeService();
    store.getHook = () => {
      throw new Error("provider down");
    };
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 503, "unavailable"),
      "standalone provider failure is 503",
    );
  }

  {
    const { service, store } = modeService();
    store.seed(MODE_KEY, manifestFor({ commit: "aaaaaaa" }));
    eq(
      (await service.readApplyManifest(DOC_ID)).manifest.commit,
      "aaaaaaa",
      "standalone admits a seven-character commit",
    );
  }

  {
    const { service, store } = modeService();
    store.seed(MODE_KEY, manifestFor({ commit: "aaaaaaaa" }));
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "standalone rejects an eight-character commit the generic validator admits",
    );
  }

  const wideBlocks = (count) => {
    const blocks = {};
    for (let index = 0; index < count; index += 1) {
      blocks[`a${index.toString(16).padStart(8, "0")}`] = {
        file: SECTION_FILE, section: SECTION_ID, tag: "p", hash: BASE_HASH,
      };
    }
    return blocks;
  };

  {
    const { service, store } = modeService();
    store.seed(MODE_KEY, manifestFor({ blocks: wideBlocks(1000) }));
    eq(
      Object.keys((await service.readApplyManifest(DOC_ID)).manifest.blocks).length,
      1000,
      "standalone admits exactly one thousand rows",
    );
  }

  {
    const { service, store } = modeService();
    store.seed(MODE_KEY, manifestFor({ blocks: wideBlocks(1001) }));
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "standalone rejects a one-thousand-and-one row manifest the generic validator admits",
    );
  }

  {
    const { service, store } = modeService();
    store.seed(MODE_KEY, { ...manifestFor(), extra: 1 });
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "corrupt standalone manifest is 500",
    );
  }

  {
    const { service, store } = modeService({ env: { ...REPO_ENV } });
    const selected = await service.readApplyManifest(DOC_ID);
    eq(selected.mode, "repository", "repository mode selected from complete configuration");
    eq(selected.manifest.blocks[AID].hash, BASE_HASH, "repository row hash");
    eq(store.gets().length, 0, "repository mode never reads the private standalone key");
    await rejects(
      () => service.readApplyManifest(OTHER_DOC),
      (error) => isApply(error, 404, "not-found"),
      "a valid repository inventory without the document is 404",
    );
  }

  for (const partial of [
    { DOCS_GITHUB_TOKEN: TOKEN },
    { DOCS_BASE_BRANCH: BASE },
    { DOCS_BOT_EMAIL: BOT_EMAIL },
    { DOCS_BASE_BRANCH: BASE, DOCS_GITHUB_TOKEN: TOKEN, DOCS_BOT_EMAIL: BOT_EMAIL },
  ]) {
    const { service, store } = modeService({ env: partial });
    store.seed(MODE_KEY, manifestFor());
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      `partial configuration ${Object.keys(partial).join("+")} never falls into standalone`,
    );
  }

  for (const broken of [
    { ...REPO_ENV, DOCS_REPO: "not-a-repo" },
    { ...REPO_ENV, DOCS_GITHUB_TOKEN: "" },
    { ...REPO_ENV, DOCS_BOT_EMAIL: "Bot@Example.com" },
    { ...REPO_ENV, DOCS_BASE_BRANCH: "../evil" },
  ]) {
    const { service } = modeService({ env: broken });
    await rejects(
      () => service.readApplyManifest(DOC_ID),
      (error) => isApply(error, 500, "invalid-state"),
      "malformed repository configuration is a fatal invalid state",
    );
  }

  /* ----------------------------------------- receipts and effective base */

  const OVERLAY_HASH = overlayHash(NEXT_TEXT);
  ok(OVERLAY_HASH !== BASE_HASH, "the overlay fixture is distinguishable from the built base");

  const standalone = (options = {}) => {
    const built = modeService(options);
    built.store.seed(MODE_KEY, options.manifest ?? manifestFor());
    return built;
  };

  {
    const { service, store } = standalone();
    eq(await service.readApplyReceipt(DOC_ID, AID), null, "absent receipt reads as null");
    store.seed(EDIT_KEY, directReceipt());
    const found = await service.readApplyReceipt(DOC_ID, AID);
    eq(found.text, TEXT, "present receipt reads back its text");
    eq(store.gets().length, 0, "receipt read never touches the private manifest key");
    store.seed(EDIT_KEY, { ...directReceipt(), rogue: 1 });
    await rejects(
      () => service.readApplyReceipt(DOC_ID, AID),
      (error) => isApply(error, 500, "invalid-state"),
      "corrupt receipt is 500",
    );
  }

  {
    const { service, store } = standalone();
    const absent = await service.readEffectiveBase(DOC_ID, AID);
    eq(
      Reflect.ownKeys(absent),
      ["mode", "docId", "aid", "section", "tag", "docVersion", "manifestHash", "hash", "text",
        "pending"],
      "effective base keeps its exact declared order",
    );
    eq(absent.mode, "standalone", "effective base carries the selected mode");
    eq(absent.docVersion, COMMIT, "effective base carries the manifest commit");
    eq(absent.manifestHash, BASE_HASH, "absent receipt keeps the manifest hash");
    eq(absent.hash, BASE_HASH, "absent receipt is not authority");
    eq(absent.text, null, "the canonical manifest carries no source text");
    eq(absent.pending, false, "absent receipt is not pending");

    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT, baseHash: "0".repeat(64) }));
    const stale = await service.readEffectiveBase(DOC_ID, AID);
    eq(stale.hash, BASE_HASH, "a stale receipt does not become authority");
    eq(stale.text, null, "a stale receipt contributes no text");
    eq(stale.pending, false, "a stale receipt is not pending");

    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    const fresh = await service.readEffectiveBase(DOC_ID, AID);
    eq(fresh.hash, OVERLAY_HASH, "a current receipt supplies the overlay hash");
    eq(fresh.text, NEXT_TEXT, "a current receipt supplies its exact text");
    eq(fresh.pending, true, "a current receipt is pending");
    eq(
      fresh.hash,
      sha256(md.toHtml(NEXT_TEXT)),
      "a client can prove its base by hashing the converted text",
    );

    await rejects(
      () => service.readEffectiveBase(DOC_ID, OTHER_AID),
      (error) => isApply(error, 404, "not-found"),
      "an unknown aid is 404",
    );
  }

  /* ------------------------------------------------------- the apply seam */

  const applyService = (options = {}) => {
    const store = options.store ?? new FakeStore();
    const github = options.github ?? new FakeGitHub(options.github2 ?? {});
    const events = [];
    const env = options.env ?? {};
    const service = createGitEditService({
      env,
      storeFn: () => store,
      fetchFn: (url, init) => github.fetch(url, init),
      appendEventFn: async (input) => {
        events.push(input);
        if (options.auditThrows === true) throw new Error("audit unavailable");
        return { v: 1 };
      },
      nowFn: () => NOW_MS,
      ...(env.DOCS_REPO === undefined ? {} : { manifestRoot: repoRoot }),
    });
    if (env.DOCS_REPO === undefined) store.seed(MODE_KEY, options.manifest ?? manifestFor());
    return { service, store, github, events };
  };

  const directInput = (overrides = {}) => ({
    docId: DOC_ID,
    aid: AID,
    text: NEXT_TEXT,
    author: { ...ACTOR },
    acceptedBy: null,
    sugId: null,
    via: "edit",
    expectBase: BASE_HASH,
    ...overrides,
  });

  const suggestionInput = (overrides = {}) => directInput({
    via: "suggestion",
    acceptedBy: { ...DECIDER },
    sugId: SUG_ID,
    ...overrides,
  });

  {
    const { service } = applyService();
    const rejected = [
      ["unknown key", { ...directInput(), extra: 1 }],
      ["missing key", (() => {
        const value = directInput();
        delete value.sugId;
        return value;
      })()],
      ["array", []],
      ["null", null],
      ["bad via", directInput({ via: "other" })],
      ["direct with an accepter", directInput({ acceptedBy: { ...DECIDER } })],
      ["direct with a suggestion id", directInput({ sugId: SUG_ID })],
      ["suggestion without an accepter", suggestionInput({ acceptedBy: null })],
      ["suggestion without an id", suggestionInput({ sugId: null })],
      ["suggestion with a malformed id", suggestionInput({ sugId: "s_BAD" })],
      ["suggestion authored by the build actor",
        suggestionInput({ author: { sub: "system", name: "Build", email: "" } })],
      ["short base", directInput({ expectBase: "abc" })],
      ["upper-case base", directInput({ expectBase: BASE_HASH.toUpperCase() })],
      ["bad doc id", directInput({ docId: "zzzzzz" })],
      ["bad aid", directInput({ aid: "b1234567" })],
      ["over-long text", directInput({ text: "x".repeat(4001) })],
      ["lone surrogate text", directInput({ text: `x\uD800` })],
      ["non-actor author", directInput({ author: { sub: SUB } })],
      ["actor with an over-long name", directInput({ author: { sub: SUB, name: "n".repeat(201), email: EMAIL } })],
      ["actor with a non-canonical mailbox", directInput({ author: { sub: SUB, name: NAME, email: "Avery@Example.com" } })],
      ["reordered actor", directInput({ author: { name: NAME, sub: SUB, email: EMAIL } })],
    ];
    for (const [label, input] of rejected) {
      await rejects(
        () => service.applyText(input),
        (error) => isApply(error, 400, "invalid-body"),
        `apply input ${label}`,
      );
    }
    await rejects(
      () => service.applyText(directInput({ text: TEXT })),
      (error) => isApply(error, 400, "invalid-body"),
      "a no-op edit is refused before any write",
    );
  }

  {
    const { service } = applyService();
    eq(
      (await service.applyText(directInput({ text: "" }))).receipt.text,
      "",
      "an empty text is a valid erasure",
    );
  }

  {
    const long = "y".repeat(4000);
    const { service } = applyService();
    eq(
      (await service.applyText(directInput({ text: long }))).receipt.text.length,
      4000,
      "four thousand code units is the accepted ceiling",
    );
  }

  {
    const { service } = applyService();
    await rejects(
      () => service.applyText(directInput({ expectBase: OVERLAY_HASH })),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, BASE_HASH, "stale base reports the current hash");
        eq(error.current, null, "a built base has no bounded current text");
      },
      "a stale explicit base is a conflict",
    );
  }

  /* -------------------------------------------------------- standalone apply */

  {
    const { service, store, github, events } = applyService();
    const result = await service.applyText(directInput());
    eq(
      Reflect.ownKeys(result.receipt),
      ["v", "aid", "text", "by", "at", "baseHash", "pr", "via"],
      "standalone direct receipt is the exact eight-field shape",
    );
    eq(result.pr, null, "standalone never produces a pull request");
    eq(result.receipt.text, NEXT_TEXT, "standalone stores the submitted text");
    eq(result.receipt.baseHash, BASE_HASH, "receipt baseHash is always the built hash");
    eq(result.receipt.at, NOW_ISO, "receipt samples the injected clock once");
    eq(result.receipt.via, "edit", "standalone direct receipt is a direct receipt");
    eq(github.calls.length, 0, "standalone makes no repository request");
    eq(store.records.get(EDIT_KEY).value.text, NEXT_TEXT, "the receipt slot holds the new text");
    eq(events.length, 1, "a successful standalone direct edit appends exactly one event");
    eq(events[0].kind, "edit.apply", "standalone direct edits apply");
    eq(events[0].summary, `applied edit to ${SECTION_ID}`, "standalone audit summary");
    eq(events[0].docVersion, COMMIT, "audit carries the manifest commit");
    eq(events[0].target, { aid: AID }, "audit targets the anchor");
    eq(events[0].actor, { ...ACTOR }, "audit records the unprojected actor");
  }

  {
    const { service, events } = applyService();
    const result = await service.applyText(suggestionInput());
    eq(
      Reflect.ownKeys(result.receipt),
      ["v", "aid", "text", "by", "at", "baseHash", "pr", "via",
        "sugId", "acceptedBy", "acceptedAt"],
      "standalone suggestion receipt is the exact eleven-field shape",
    );
    eq(result.receipt.by, { ...ACTOR }, "the suggester stays the receipt author");
    eq(result.receipt.acceptedBy, { ...DECIDER }, "the decider is recorded as the accepter");
    eq(result.receipt.acceptedAt, NOW_ISO, "acceptance shares the sampled timestamp");
    eq(events.length, 0, "suggestion acceptance emits no duplicate direct-edit event");
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    const result = await service.applyText(
      directInput({ text: THIRD_TEXT, expectBase: OVERLAY_HASH }),
    );
    eq(result.receipt.text, THIRD_TEXT, "an explicit overlay base may replace the visible overlay");
    eq(result.receipt.baseHash, BASE_HASH, "the replacement still records the built hash");
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT, baseHash: "0".repeat(64) }));
    const result = await service.applyText(directInput({ text: THIRD_TEXT }));
    eq(result.receipt.text, THIRD_TEXT, "an unchanged stale receipt is replaced");
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, directReceipt({ text: THIRD_TEXT }));
    store.readHook = () => ({ data: directReceipt({ text: NEXT_TEXT }), etag: '"stale"' });
    await rejects(
      () => service.applyText(directInput({ text: TEXT, expectBase: OVERLAY_HASH })),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, overlayHash(THIRD_TEXT), "the CAS loser reports the winner's hash");
        eq(error.current, THIRD_TEXT, "the CAS loser reports the winner's bounded text");
      },
      "a slot changed under a captured snapshot conflicts",
    );
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, directReceipt({ text: THIRD_TEXT }));
    store.readHook = () => null;
    await rejects(
      () => service.applyText(directInput()),
      (error) => isApply(error, 409, "conflict"),
      "a newly observed receipt under a null snapshot conflicts",
    );
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, suggestionReceipt());
    const later = { sub: "u_fixture_third_9", name: "Sage Idris", email: "sage@example.com" };
    const result = await service.applyText(
      suggestionInput({ acceptedBy: later, expectBase: OVERLAY_HASH }),
    );
    eq(result.receipt.acceptedBy, { ...DECIDER }, "replay preserves the first stored accepter");
    eq(result.receipt.text, NEXT_TEXT, "replay returns the stored text");
    eq(store.records.get(EDIT_KEY).value.acceptedBy.sub, DECIDER.sub, "replay writes nothing");
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, suggestionReceipt({ text: THIRD_TEXT }));
    await rejects(
      () => service.applyText(suggestionInput({ expectBase: overlayHash(THIRD_TEXT) })),
      (error) => isApply(error, 409, "conflict"),
      "the same suggestion id with different text is a conflict, not a replay",
    );
  }

  {
    const { service, store } = applyService();
    store.seed(EDIT_KEY, suggestionReceipt({ by: { ...DECIDER } }));
    await rejects(
      () => service.applyText(suggestionInput({ expectBase: OVERLAY_HASH })),
      (error) => isApply(error, 409, "conflict"),
      "the same suggestion id with a different author is a conflict",
    );
  }

  {
    const { service, events } = applyService({ auditThrows: true });
    const result = await service.applyText(directInput());
    eq(result.receipt.text, NEXT_TEXT, "an audit failure preserves the successful apply");
    eq(events.length, 1, "the audit was attempted exactly once");
  }

  {
    const { service, events } = applyService({ manifest: manifestFor({ commit: "" }) });
    const result = await service.applyText(directInput());
    eq(result.receipt.text, NEXT_TEXT, "a document with no history head still applies");
    eq(events.length, 0, "no audit row is fabricated without a document version");
  }

  /* -------------------------------------------------------- repository apply */

  const sourceWith = (inner) => [
    "<!--",
    "id: index",
    "-->",
    "<!-- body -->",
    `<h2 data-aid="${OTHER_AID}">Orchard</h2>`,
    `<p data-aid="${AID}">${inner}</p>`,
    "",
  ].join("\n");

  const repository = (options = {}) => applyService({ ...options, env: { ...REPO_ENV } });
  const decodeCommitted = (github) =>
    Buffer.from(github.committed.content, "base64").toString("utf8");

  {
    const { service, github, events } = repository();
    const result = await service.applyText(directInput());
    eq(result.pr, 412, "a direct repository edit opens the one pull request");
    eq(result.receipt.pr, 412, "the receipt records that pull request");
    eq(result.receipt.baseHash, BASE_HASH, "the receipt records the built hash");
    eq(result.receipt.via, "edit", "a direct repository edit is a direct receipt");
    eq(github.committed.message, `Edit block ${AID} in document ${DOC_ID}`, "commit message");
    eq(github.committed.author, { name: NAME, email: EMAIL }, "the reader is the commit author");
    eq(
      github.committed.committer,
      { name: "Architecture Docs", email: BOT_EMAIL },
      "the site is only the committer",
    );
    eq(
      decodeCommitted(github),
      sourceWith(md.toHtml(NEXT_TEXT)),
      "only the selected inner range changed",
    );
    eq(github.createdBody.title, `Inline edits for document ${DOC_ID}`, "pull request title");
    eq(
      github.createdBody.body,
      "Edits proposed from the hosted document. Each commit changes one build-approved block.",
      "a direct pull request keeps its original body",
    );
    eq(events.length, 1, "a successful repository direct edit appends exactly one event");
    eq(events[0].kind, "edit.propose", "repository direct edits propose");
    eq(events[0].summary, `proposed edit to ${SECTION_ID}`, "repository audit summary");
  }

  {
    const { service, github } = repository();
    await rejects(
      () => service.applyText(
        directInput({ author: { sub: SUB, name: NAME, email: "" } }),
      ),
      (error) => isApply(error, 500, "invalid-state"),
      "an empty author mailbox fails safe in repository mode",
    );
    eq(github.calls.length, 0, "the empty-mailbox refusal happens before any provider work");
  }

  {
    const { service, github } = repository();
    const result = await service.applyText(
      directInput({ author: { sub: SUB, name: "", email: EMAIL } }),
    );
    eq(
      github.committed.author,
      { name: EMAIL, email: EMAIL },
      "an empty commit-author name falls back only to that author's own address",
    );
    eq(result.receipt.by, { sub: SUB, name: "", email: EMAIL },
      "the durable receipt keeps the exact empty-name actor");
  }

  {
    const { service, github } = repository({ github2: { branchExists: false } });
    await service.applyText(directInput());
    ok(
      github.calls.includes(`POST /repos/${REPO}/git/refs`),
      "an absent author branch is created from the configured base",
    );
  }

  {
    const { service, github } = repository({
      github2: { branchExists: false, createStatus: 422, raceResolves: true },
    });
    await service.applyText(directInput());
    eq(
      github.count(`GET /repos/${REPO}/git/ref/heads/docedit`),
      2,
      "a lost branch-create race is resolved by one fresh read",
    );
  }

  {
    const { service } = repository({
      github2: { branchExists: false, createStatus: 422, raceResolves: false },
    });
    await rejects(
      () => service.applyText(directInput()),
      (error) => isApply(error, 502, "repository-unavailable"),
      "an unresolvable branch-create race is a repository fault",
    );
  }

  {
    const { service, github } = repository({ github2: { putStatuses: [409, 200] } });
    const result = await service.applyText(directInput());
    eq(result.pr, 412, "one file-SHA conflict is retried exactly once and then succeeds");
    eq(github.count("PUT "), 2, "the retry issues exactly one more write");
    eq(
      github.count(`GET /repos/${REPO}/contents/${INSTANCE}/anchors.json`),
      2,
      "the retry repeats every locator check from scratch",
    );
  }

  {
    const { service, github } = repository({ github2: { putStatuses: [409, 409] } });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, BASE_HASH, "the second conflict reports the actual source hash");
        eq(error.current, TEXT, "the second conflict reports the bounded source text");
      },
      "a second file-SHA conflict stops rather than looping",
    );
    eq(github.count("PUT "), 2, "there is never a third write");
  }

  {
    const { service } = repository({ github2: { putStatuses: [500] } });
    await rejects(
      () => service.applyText(directInput()),
      (error) => isApply(error, 502, "repository-unavailable"),
      "an unexpected write status is a repository fault",
    );
  }

  {
    const branch = branchFor(SUB);
    const { service, github } = repository({ github2: { openPulls: [openPullRow(branch)] } });
    const result = await service.applyText(directInput());
    eq(result.pr, 77, "one open pull request is reused");
    eq(github.count(`POST /repos/${REPO}/pulls`), 0, "an existing pull request is never recreated");
  }

  {
    const branch = branchFor(SUB);
    const { service } = repository({
      github2: { openPulls: [openPullRow(branch), openPullRow(branch)] },
    });
    await rejects(
      () => service.applyText(directInput()),
      (error) => isApply(error, 502, "repository-unavailable"),
      "two open pull requests is an ambiguity this path refuses",
    );
  }

  {
    const { service } = repository({ github2: { source: sourceWith("<em>drifted</em>") } });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, sha256("<em>drifted</em>"), "a drifted source reports its hash");
        eq(error.current, "*drifted*", "a representable drifted source is projected");
      },
      "a drifted source is a conflict with the actual hash",
    );
  }

  {
    const inner = "text with <span>an unsupported element</span>";
    const { service } = repository({ github2: { source: sourceWith(inner) } });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, sha256(inner), "an unrepresentable source still reports its hash");
        eq(error.current, null, "an unrepresentable source projects no text");
      },
      "a source outside the editable vocabulary is bounded to null",
    );
  }

  {
    const { service } = repository({
      github2: { anchors: JSON.stringify({ other: { ids: [], texts: [] } }) },
    });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, undefined, "a locator failure reports no source hash");
        eq(error.current, null, "a locator failure reports no source text");
      },
      "a section missing from the committed map is a bounded conflict",
    );
  }

  {
    const { service } = repository({
      github2: { source: sourceWith(INNER).replace("<p ", "<h3 ").replace("</p>", "</h3>") },
    });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, BASE_HASH, "a retagged block still reports the source hash");
      },
      "a retagged block is a conflict rather than a guess",
    );
  }

  {
    // The anchors map and the scanned source no longer describe the same block
    // sequence, so the positional index names something other than the block
    // the caller meant. It is refused as drift rather than resolved by
    // indexing into a list that means something else.
    const { service, github } = repository({
      github2: {
        source: `${sourceWith(INNER)}<p data-aid="${OTHER_AID}">A later row.</p>\n`,
      },
    });
    await rejects(
      () => service.applyText(directInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, undefined, "an unsound join reports no source hash");
        eq(error.current, null, "an unsound join reports no source text");
      },
      "a source that grew past the committed anchors map is a bounded conflict",
    );
    eq(github.committed, null, "an unsound join never writes");
  }

  /* --------------------------------------- repository suggestion acceptance */

  const TRAILER = `X-Suggestion-Id: ${SUG_ID}`;
  const SUGGESTION_MESSAGE =
    `Edit block ${AID} in document ${DOC_ID}\n\nAccepted suggestion ${SUG_ID}.\n\n${TRAILER}`;

  {
    const { service, github, events } = repository();
    const result = await service.applyText(suggestionInput());
    eq(github.committed.message, SUGGESTION_MESSAGE, "the suggestion commit carries the trailer");
    eq(
      github.committed.author,
      { name: NAME, email: EMAIL },
      "the suggester authors the accepted commit",
    );
    eq(
      github.committed.committer,
      { name: "Architecture Docs", email: BOT_EMAIL },
      "the site remains the committer of an accepted suggestion",
    );
    eq(
      github.createdBody.body,
      "Edits proposed from the hosted document. Each commit changes one build-approved block. " +
        "Accepted suggestions retain their authorship in their commits and receipts.",
      "a new suggestion pull request carries the extra sentence",
    );
    eq(result.receipt.acceptedBy, { ...DECIDER }, "the accepter is retained in the receipt");
    eq(result.receipt.pr, 412, "the accepted suggestion records its pull request");
    eq(events.length, 0, "acceptance emits no direct-edit audit row");
    ok(
      github.calls.some((call) => call.includes(`git/ref/heads/${branchFor(SUB)}`)),
      "acceptance resolves the suggester's branch, never the accepter's",
    );
  }

  {
    const replayed = md.toHtml(NEXT_TEXT);
    const { service, github } = repository({
      github2: { source: sourceWith(replayed), headMessage: SUGGESTION_MESSAGE },
    });
    const result = await service.applyText(suggestionInput());
    eq(github.count("PUT "), 0, "a proved trailer replay skips the write entirely");
    eq(result.pr, 412, "a proved trailer replay still completes the pull request and receipt");
    eq(result.receipt.text, NEXT_TEXT, "a proved trailer replay records the intended text");
  }

  {
    const { service, github } = repository({
      github2: { source: sourceWith("<em>other</em>"), headMessage: SUGGESTION_MESSAGE },
    });
    await rejects(
      () => service.applyText(suggestionInput()),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, sha256("<em>other</em>"), "a mismatched replay reports its hash");
      },
      "a trailer at head whose source is not the accepted text is a conflict",
    );
    eq(github.count("PUT "), 0, "a mismatched replay writes nothing");
  }

  for (const [label, message] of [
    ["lower case", SUGGESTION_MESSAGE.toLowerCase()],
    ["substring", `X-Suggestion-Id: ${SUG_ID}x`],
    ["padded", `  ${TRAILER}  `],
    ["another suggestion", `X-Suggestion-Id: ${OTHER_SUG}`],
    ["later head commit", "Fix a typo in the orchard index"],
  ]) {
    const { service, github } = repository({
      github2: { source: sourceWith(md.toHtml(NEXT_TEXT)), headMessage: message },
    });
    await rejects(
      () => service.applyText(suggestionInput()),
      (error) => isApply(error, 409, "conflict"),
      `a ${label} trailer never counts as a replay`,
    );
    eq(github.count("PUT "), 0, `a ${label} trailer stops at the source gate`);
  }

  {
    // A different reader accepts this author's suggestion while the author's
    // own branch is still at the built source.
    const { service, store, github } = repository();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    const result = await service.applyText(
      suggestionInput({ text: THIRD_TEXT, expectBase: OVERLAY_HASH }),
    );
    eq(result.receipt.text, THIRD_TEXT, "acceptance from a manifest-base branch succeeds");
    eq(github.count("PUT "), 1, "acceptance from a manifest-base branch writes once");
  }

  {
    // The same acceptance when the target branch already carries the overlay.
    const { service, store, github } = repository({
      github2: { source: sourceWith(md.toHtml(NEXT_TEXT)) },
    });
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    const result = await service.applyText(
      suggestionInput({ text: THIRD_TEXT, expectBase: OVERLAY_HASH }),
    );
    eq(result.receipt.text, THIRD_TEXT, "acceptance from an overlay-carrying branch succeeds");
    eq(github.count("PUT "), 1, "acceptance from an overlay-carrying branch writes once");
  }

  {
    // A third, unrelated branch state is still a conflict: the branch is check
    // three, never a competing definition of the accepted base.
    const { service, store } = repository({
      github2: { source: sourceWith(md.toHtml(THIRD_TEXT)) },
    });
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    await rejects(
      () => service.applyText(suggestionInput({ text: TEXT, expectBase: OVERLAY_HASH })),
      (error) => isApply(error, 409, "conflict"),
      "an unrelated branch source is still a conflict",
    );
  }

  {
    // The captured overlay still has to be the base the caller proved.
    const { service, store } = repository();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    await rejects(
      () => service.applyText(suggestionInput({ text: THIRD_TEXT, expectBase: BASE_HASH })),
      (error) => {
        isApply(error, 409, "conflict");
        eq(error.currentHash, OVERLAY_HASH, "the overlay remains the accepted base");
        eq(error.current, NEXT_TEXT, "the overlay text is reported back");
      },
      "a branch at the manifest source does not redefine the accepted base",
    );
  }

  {
    const { service, github } = repository();
    github.fetch = async () => {
      throw new Error("network down");
    };
    await rejects(
      () => service.applyText(directInput()),
      (error) => isApply(error, 502, "repository-unavailable"),
      "an unreachable provider is a repository fault",
    );
  }

  /* ------------------------------------------------------------ the route */

  const EDIT_DEPENDENCY_KEYS = [
    "requireOrigin", "identify", "resolveRole", "capabilitiesFor",
    "readEffectiveBase", "applyText", "notify", "toMd", "toHtml", "sha256Hex",
  ];

  const roleAccess = (role) => ({
    role,
    shared: true,
    ...access.capabilitiesFor(role),
  });

  const editDeps = (overrides = {}) => ({
    requireOrigin: () => {},
    identify: async () => ({ sub: SUB, email: EMAIL, emailVerified: true, name: NAME }),
    resolveRole: async () => roleAccess("editor"),
    capabilitiesFor: access.capabilitiesFor,
    readEffectiveBase: async () => ({
      mode: "standalone",
      docId: DOC_ID,
      aid: AID,
      section: SECTION_ID,
      tag: "p",
      docVersion: COMMIT,
      manifestHash: BASE_HASH,
      hash: BASE_HASH,
      text: null,
      pending: false,
    }),
    applyText: async () => ({ receipt: directReceipt({ text: NEXT_TEXT }), pr: null }),
    notify: () => true,
    toMd: md.toMd,
    toHtml: md.toHtml,
    sha256Hex: sha256,
    ...overrides,
  });

  const editRequest = (body, url = "https://docs.example.com/api/edit") =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const CONTEXT = Object.freeze({ waitUntil: () => {} });

  eq(
    Object.keys(editDeps()).sort(),
    [...EDIT_DEPENDENCY_KEYS].sort(),
    "the post-N edit factory takes exactly ten members",
  );
  ok(editModule.createEditHandler(editDeps()) !== null, "the exact ten keys are accepted");
  eq(
    editModule.createEditHandler(editDeps()).length,
    2,
    "the constructed edit handler has (req, context) arity",
  );
  for (const key of EDIT_DEPENDENCY_KEYS) {
    const missing = editDeps();
    delete missing[key];
    throwsSync(
      () => editModule.createEditHandler(missing),
      (error) => eq(error.message, "Invalid edit dependencies", `edit missing ${key} message`),
      `edit factory missing ${key}`,
    );
    throwsSync(
      () => editModule.createEditHandler(editDeps({ [key]: undefined })),
      (error) => ok(error instanceof TypeError, `edit undefined ${key} is a TypeError`),
      `edit factory undefined ${key}`,
    );
    throwsSync(
      () => editModule.createEditHandler(editDeps({ [key]: "no" })),
      (error) => ok(error instanceof TypeError, `edit non-function ${key} is a TypeError`),
      `edit factory non-function ${key}`,
    );
  }
  throwsSync(
    () => editModule.createEditHandler(editDeps({ extra: () => {} })),
    (error) => ok(error instanceof TypeError, "an extra edit key is a TypeError"),
    "edit factory extra key",
  );
  {
    const accessorDeps = editDeps();
    delete accessorDeps.notify;
    Object.defineProperty(accessorDeps, "notify", { get: () => () => true, enumerable: true });
    throwsSync(
      () => editModule.createEditHandler(accessorDeps),
      (error) => ok(error instanceof TypeError, "an edit accessor is a TypeError"),
      "edit factory accessor",
    );
  }
  for (const bad of [null, [], "x", Object.assign(Object.create({ a: 1 }), editDeps())]) {
    throwsSync(
      () => editModule.createEditHandler(bad),
      (error) => ok(error instanceof TypeError, "a malformed edit dependency object is refused"),
      "edit factory malformed object",
    );
  }

  {
    const calls = [];
    const handler = editModule.createEditHandler(editDeps({
      applyText: async (input) => {
        calls.push(input);
        return { receipt: directReceipt({ text: NEXT_TEXT }), pr: null };
      },
      notify: (context, notification) => {
        calls.push({ context, notification });
        return true;
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 200, "a legitimate direct edit succeeds");
    eq(response.headers.get("Cache-Control"), "private, no-store", "the response is never cached");
    const body = await response.json();
    eq(
      Object.keys(body.receipt),
      ["aid", "text", "by", "at", "pr", "via"],
      "the public receipt projection is exactly these fields in this order",
    );
    eq(body.receipt.text, NEXT_TEXT, "the projection carries the stored text");
    eq(Object.keys(body), ["receipt"], "no sibling pull-request number is serialized");
    eq(calls[0].via, "edit", "the route always applies as a direct edit");
    eq(calls[0].acceptedBy, null, "the route never supplies an accepter");
    eq(calls[0].sugId, null, "the route never supplies a suggestion id");
    eq(calls[0].expectBase, BASE_HASH, "a legacy request adopts the manifest hash");
    eq(
      calls[0].author,
      { sub: SUB, name: NAME, email: EMAIL },
      "the proven identity is the only author",
    );
    eq(calls[1].notification, {
      t: "edit.saved",
      docId: DOC_ID,
      aid: AID,
      hash: sha256(md.toHtml(NEXT_TEXT)),
    }, "the fan-out carries the exact converted-text hash");
    eq(calls[1].context, CONTEXT, "the fan-out receives the Functions context unchanged");
    eq(calls.length, 2, "the fan-out helper is called exactly once");
  }

  {
    const seen = [];
    const handler = editModule.createEditHandler(editDeps({
      applyText: async (input) => {
        seen.push(input.expectBase);
        return { receipt: directReceipt({ text: NEXT_TEXT }), pr: null };
      },
      readEffectiveBase: async () => {
        throw new Error("the explicit path must not consult the effective base");
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT, baseHash: OVERLAY_HASH }), CONTEXT,
    );
    eq(response.status, 200, "an explicit base is accepted");
    eq(seen[0], OVERLAY_HASH, "an explicit base is passed through verbatim");
  }

  {
    const handler = editModule.createEditHandler(editDeps({
      readEffectiveBase: async () => ({
        mode: "standalone",
        docId: DOC_ID,
        aid: AID,
        section: SECTION_ID,
        tag: "p",
        docVersion: COMMIT,
        manifestHash: BASE_HASH,
        hash: OVERLAY_HASH,
        text: NEXT_TEXT,
        pending: true,
      }),
      applyText: async () => {
        throw new Error("a legacy request must never overwrite an unseen overlay");
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: THIRD_TEXT }), CONTEXT,
    );
    eq(response.status, 409, "a legacy request against a pending overlay is a conflict");
    const body = await response.json();
    eq(body.error.code, "conflict", "the conflict code");
    eq(body.current, NEXT_TEXT, "the conflict reports the visible overlay");
  }

  for (const [role, status] of [
    ["owner", 200], ["editor", 200], ["commenter", 403], ["viewer", 403], ["none", 403],
  ]) {
    const handler = editModule.createEditHandler(editDeps({
      resolveRole: async () => roleAccess(role),
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, status, `the ${role} role resolves to ${status}`);
  }

  {
    const handler = editModule.createEditHandler(editDeps({
      resolveRole: async () => ({ ...roleAccess("viewer"), canEdit: true, canSuggest: true }),
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 500, "a forged capability row is an invalid state, not a grant");
  }

  {
    const seen = [];
    const handler = editModule.createEditHandler(editDeps({
      resolveRole: async (docId, user, options) => {
        seen.push({ docId, sub: user.sub, options });
        return roleAccess("editor");
      },
    }));
    await handler(editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT);
    eq(seen.length, 1, "the route performs exactly one capability lookup");
    eq(seen[0].docId, DOC_ID, "the lookup is bound to the requested document");
    eq(seen[0].options, { consumeInvitation: false }, "the lookup never consumes an invitation");
  }

  {
    const outage = new Error("blobs unavailable");
    outage.name = "StoreError";
    outage.code = "unavailable";
    outage.status = 503;
    const handler = editModule.createEditHandler(editDeps({
      resolveRole: async () => {
        throw outage;
      },
    }));
    eq(
      (await handler(editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT)).status,
      503,
      "the exact access-outage shape is a 503",
    );
  }

  for (const [label, thrown] of [
    ["a bare error", new Error("nope")],
    ["a forged outage code", Object.assign(new Error("x"), { name: "Other", code: "unavailable", status: 503 })],
    ["a hostile object", { name: "StoreError", code: "unavailable", status: 503, extra: 1 }],
  ]) {
    const handler = editModule.createEditHandler(editDeps({
      resolveRole: async () => {
        throw thrown;
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    ok(response.status === 500 || response.status === 503, `${label} fails closed`);
    if (label !== "a hostile object") {
      eq(response.status, 500, `${label} is an invalid state, not an outage`);
    }
  }

  {
    const handler = editModule.createEditHandler(editDeps({
      identify: async () => null,
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 401, "an unauthenticated caller is refused");
  }

  {
    const handler = editModule.createEditHandler(editDeps());
    const response = await handler(
      new Request("https://docs.example.com/api/edit", { method: "GET" }), CONTEXT,
    );
    eq(response.status, 405, "only POST is routed");
    eq(response.headers.get("Allow"), "POST", "the Allow header names the one method");
  }

  for (const [label, body, status] of [
    ["unknown key", { docId: DOC_ID, aid: AID, text: NEXT_TEXT, rogue: 1 }, 400],
    ["missing text", { docId: DOC_ID, aid: AID }, 400],
    ["bad doc id", { docId: "zz", aid: AID, text: NEXT_TEXT }, 400],
    ["short base hash", { docId: DOC_ID, aid: AID, text: NEXT_TEXT, baseHash: "abc" }, 400],
    ["upper-case base hash",
      { docId: DOC_ID, aid: AID, text: NEXT_TEXT, baseHash: BASE_HASH.toUpperCase() }, 400],
    ["reserved keys tolerated",
      { docId: DOC_ID, aid: AID, text: NEXT_TEXT, author: "x", email: "y", name: "z" }, 200],
  ]) {
    const handler = editModule.createEditHandler(editDeps());
    const response = await handler(editRequest(body), CONTEXT);
    eq(response.status, status, `request body: ${label}`);
  }

  {
    const handler = editModule.createEditHandler(editDeps());
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT },
        "https://docs.example.com/api/edit?doc=4b7d2a"),
      CONTEXT,
    );
    eq(response.status, 400, "a query string is refused");
  }

  for (const [code, status] of [
    ["invalid-body", 400], ["not-found", 404], ["conflict", 409],
    ["invalid-state", 500], ["repository-unavailable", 502], ["unavailable", 503],
  ]) {
    const handler = editModule.createEditHandler(editDeps({
      applyText: async () => {
        throw new ApplyError(code, code === "conflict" ? { current: TEXT } : {});
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, status, `an imported ApplyError ${code} maps to ${status}`);
    const body = await response.json();
    eq(body.error.code, code, `the public code for ${code}`);
    if (code === "conflict") eq(body.current, TEXT, "the conflict carries its bounded text");
  }

  {
    const forged = new Error("nope");
    forged.status = 404;
    forged.code = "not-found";
    forged.current = "leak";
    const handler = editModule.createEditHandler(editDeps({
      applyText: async () => {
        throw forged;
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 500, "a forged error never steers the public status");
    const body = await response.json();
    eq(body.error.code, "invalid-state", "a forged error is an invalid state");
  }

  for (const [label, notifier] of [
    ["a false result", () => false],
    ["a throw", () => {
      throw new Error("fan-out down");
    }],
    ["a rejected schedule", () => {
      throw new TypeError("waitUntil unavailable");
    }],
  ]) {
    const handler = editModule.createEditHandler(editDeps({ notify: notifier }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 200, `${label} from the fan-out cannot change a durable success`);
  }

  {
    const handler = editModule.createEditHandler(editDeps({
      identify: async () => ({ sub: SUB, email: "", emailVerified: false, name: "" }),
      applyText: async (input) => {
        eq(input.author, { sub: SUB, name: "", email: "" },
          "the route forwards the canonical empty actor without projection");
        return { receipt: directReceipt({ text: NEXT_TEXT }), pr: null };
      },
    }));
    const response = await handler(
      editRequest({ docId: DOC_ID, aid: AID, text: NEXT_TEXT }), CONTEXT,
    );
    eq(response.status, 200, "an empty mailbox is not refused before mode selection");
  }

  /* --------------------------------------------------------- the overlay */

  const PENDING_DEPENDENCY_KEYS = [
    "identify", "resolveRole", "capabilitiesFor", "assertIdentitySub", "normalizeEmail",
    "docState", "editPrefix", "editKey", "read", "upgrade", "readApplyManifestFn",
  ];

  const pendingDeps = (overrides = {}) => ({
    identify: async () => ({ sub: SUB, email: EMAIL, emailVerified: true, name: NAME }),
    resolveRole: async () => roleAccess("editor"),
    capabilitiesFor: access.capabilitiesFor,
    assertIdentitySub: access.assertIdentitySub,
    normalizeEmail: access.normalizeEmail,
    docState: () => new FakeStore(),
    editPrefix: storeLib.editPrefix,
    editKey: storeLib.editKey,
    read: storeLib.read,
    upgrade: storeLib.upgrade,
    readApplyManifestFn: async () => ({ mode: "standalone", manifest: manifestFor() }),
    ...overrides,
  });

  eq(
    Object.keys(pendingDeps()).sort(),
    [...PENDING_DEPENDENCY_KEYS].sort(),
    "the post-N pending factory takes exactly eleven members",
  );
  ok(pendingModule.createPendingHandler(pendingDeps()) !== null, "the exact eleven keys pass");
  eq(pendingModule.createPendingHandler(pendingDeps()).length, 1, "the handler stays one-argument");
  for (const key of PENDING_DEPENDENCY_KEYS) {
    const missing = pendingDeps();
    delete missing[key];
    throwsSync(
      () => pendingModule.createPendingHandler(missing),
      (error) => eq(error.message, "Invalid pending dependencies", `pending missing ${key}`),
      `pending factory missing ${key}`,
    );
    throwsSync(
      () => pendingModule.createPendingHandler(pendingDeps({ [key]: "no" })),
      (error) => ok(error instanceof TypeError, `pending non-function ${key}`),
      `pending factory non-function ${key}`,
    );
  }
  throwsSync(
    () => pendingModule.createPendingHandler(pendingDeps({ manifestRoot: "/tmp" })),
    (error) => eq(error.message, "Invalid pending dependencies", "the scalar root is gone"),
    "pending factory rejects the removed manifestRoot key",
  );

  const pendingRequest = (docId) =>
    new Request(`https://docs.example.com/api/pending?doc=${docId}`, { method: "GET" });

  {
    const store = new FakeStore();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT }));
    store.seed(`edits/${DOC_ID}/${OTHER_AID}.json`,
      directReceipt({ aid: OTHER_AID, text: THIRD_TEXT }));
    let asked = 0;
    const handler = pendingModule.createPendingHandler(pendingDeps({
      docState: () => store,
      readApplyManifestFn: async (docId) => {
        asked += 1;
        eq(docId, DOC_ID, "pending selects the manifest for the requested document");
        return { mode: "standalone", manifest: manifestFor() };
      },
    }));
    const response = await handler(pendingRequest(DOC_ID));
    eq(response.status, 200, "an authorized standalone overlay read succeeds");
    eq(asked, 1, "the manifest is selected exactly once per request");
    const overlay = await response.json();
    eq(Object.keys(overlay), [AID], "only manifest rows are projected");
    eq(overlay[AID].text, NEXT_TEXT, "the standalone overlay is visible");
    eq(overlay[AID].via, "edit", "the projection keeps the receipt variant");
  }

  {
    const store = new FakeStore();
    store.seed(EDIT_KEY, directReceipt({ text: NEXT_TEXT, baseHash: "0".repeat(64) }));
    const handler = pendingModule.createPendingHandler(pendingDeps({ docState: () => store }));
    const response = await handler(pendingRequest(DOC_ID));
    eq(response.status, 200, "a stale overlay is still a successful read");
    eq(await response.text(), "{}", "a receipt whose block has landed is omitted");
  }

  {
    const store = new FakeStore();
    store.seed(EDIT_KEY, suggestionReceipt());
    const handler = pendingModule.createPendingHandler(pendingDeps({ docState: () => store }));
    const overlay = await (await handler(pendingRequest(DOC_ID))).json();
    eq(
      Object.keys(overlay[AID]),
      ["text", "by", "at", "pr", "via", "sugId", "acceptedBy", "acceptedAt"],
      "the suggestion projection is unchanged",
    );
  }

  for (const [label, status, expected] of [
    ["not found", 404, 404],
    ["unavailable", 503, 503],
    ["invalid state", 500, 500],
    ["repository fault", 502, 500],
    ["conflict", 409, 500],
  ]) {
    const code = {
      404: "not-found", 503: "unavailable", 500: "invalid-state",
      502: "repository-unavailable", 409: "conflict",
    }[status];
    const handler = pendingModule.createPendingHandler(pendingDeps({
      readApplyManifestFn: async () => {
        throw new ApplyError(code);
      },
      docState: () => {
        throw new Error("pending must not open the store before manifest success");
      },
    }));
    const response = await handler(pendingRequest(DOC_ID));
    eq(response.status, expected, `pending maps a manifest ${label} to ${expected}`);
    eq(await response.text(), "", "the pending error body stays empty");
  }

  {
    const handler = pendingModule.createPendingHandler(pendingDeps({
      readApplyManifestFn: async () => {
        throw new Error("something else");
      },
    }));
    eq(
      (await handler(pendingRequest(DOC_ID))).status,
      500,
      "a non-ApplyError manifest failure is never a 404",
    );
  }

  for (const [label, selection] of [
    ["a bare manifest", manifestFor()],
    ["an unknown mode", { mode: "hybrid", manifest: manifestFor() }],
    ["a reordered boundary", { manifest: manifestFor(), mode: "standalone" }],
    ["a manifest for another document",
      { mode: "standalone", manifest: { ...manifestFor(), docId: OTHER_DOC } }],
    ["an extra boundary key", { mode: "standalone", manifest: manifestFor(), root: "/tmp" }],
  ]) {
    const handler = pendingModule.createPendingHandler(pendingDeps({
      readApplyManifestFn: async () => selection,
    }));
    eq(
      (await handler(pendingRequest(DOC_ID))).status,
      500,
      `pending validates the boundary rather than trusting ${label}`,
    );
  }

  for (const [role, status] of [["viewer", 200], ["none", 403]]) {
    const handler = pendingModule.createPendingHandler(pendingDeps({
      resolveRole: async () => roleAccess(role),
    }));
    eq(
      (await handler(pendingRequest(DOC_ID))).status,
      status,
      `pending keeps its own read authorization for ${role}`,
    );
  }

  {
    const handler = pendingModule.createPendingHandler(pendingDeps({ identify: async () => null }));
    eq((await handler(pendingRequest(DOC_ID))).status, 401, "pending still refuses a stranger");
    const posted = pendingModule.createPendingHandler(pendingDeps());
    const response = await posted(
      new Request(`https://docs.example.com/api/pending?doc=${DOC_ID}`, { method: "POST" }),
    );
    eq(response.status, 405, "pending is still GET-only");
    eq(response.headers.get("Allow"), "GET", "pending still names its one method");
  }

  if (process.env.P4N_VERBOSE === "1") process.stdout.write(`checks ${checks}\n`);
  return checks;
}

/* ========================================================================= */
/* the hosted branch                                                         */
/* ========================================================================= */

/**
 * The opt-in hosted lifecycle is not implemented in this revision.
 *
 * It is refused loudly rather than reported as a pass: a hosted branch that
 * silently prints a success line it did not earn is worse than an absent one.
 * Tracked as a disclosed gap on the pull request that introduced this harness.
 */
function hostedRefusal() {
  process.stderr.write(
    "P4-N hosted lifecycle is not implemented.\n" +
    "  The deterministic gate is `node scripts/test-p4-n.mjs`.\n" +
    "  No PASS line is printed for a check that did not run.\n",
  );
  return 2;
}

/* ========================================================================= */
/* entry                                                                     */
/* ========================================================================= */

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? "";

  if (mode === "--signal-probe") return signalProbe();
  if (mode === "--deadline-probe") return deadlineProbe();
  if (mode === "--runtime") {
    await runtimeMatrix();
    return undefined;
  }
  if (mode === "--hosted") {
    if (process.env.AIUR_P4N_HOSTED !== "1") {
      process.stderr.write("Hosted execution requires AIUR_P4N_HOSTED=1.\n");
      process.exitCode = 2;
      return undefined;
    }
    process.exitCode = hostedRefusal();
    return undefined;
  }
  if (mode !== "") {
    process.stderr.write(`Unknown argument ${mode}\n`);
    process.exitCode = 2;
    return undefined;
  }

  const guard = setTimeout(() => {
    process.stderr.write("The supervisor exceeded its own deadline.\n");
    process.exit(DEADLINE_CODE);
  }, mode === "--hosted" ? HOSTED_DEADLINE_MS : OUTER_DEADLINE_MS);
  guard.unref();
  await supervise();
  return undefined;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 2;
});
