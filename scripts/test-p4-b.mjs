#!/usr/bin/env node
/**
 * P4-B — the permanent edit-write-path regression runner.
 *
 *   node scripts/test-p4-b.mjs
 *
 * One entry point, no public arguments, four lines of output. The supervisor
 * proves its own signal and deadline behaviour first, then launches the server
 * and client matrices as direct children in their own process groups under a
 * mode-0700 temporary root, gives each a deadline, caps captured output,
 * forwards HUP/INT/TERM, escalates TERM to KILL, reaps the child, proves the
 * child's process group is gone, and removes the guarded root before it can
 * report success.
 *
 * Nothing here reads a credential, a real repository, a remote provider, or a
 * private fixture. The server matrix drives the real `createEditHandler()`
 * through an injected fetch and an in-memory store; the client matrix
 * evaluates the real `templates/base/edit.js` inside a closed VM/DOM seam.
 * Both fixtures are invented.
 *
 * Deviation from the ticket's test plan, recorded on purpose: the rendered
 * matrix runs through the deterministic VM/DOM seam and a parse of the
 * stylesheet, not a pinned Playwright install under the temporary root.
 * Nothing in CI runs this script, so a browser download would turn an offline
 * regression gate into a network dependency for the one person running it by
 * hand. A real-browser worker is the natural follow-up when a rendered check
 * needs layout or paint, which none of the assertions here do.
 */

import { spawn } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const WORKER_DEADLINE_MS = 180_000;
const PROBE_DEADLINE_MS = 1_000;
const ESCALATE_MS = 2_000;
const MAX_CAPTURE_BYTES = 262_144;
const DEADLINE_CODE = 124;

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
    const forward = (signal) => () => group(signal);
    const handlers = forwarded.map((signal) => {
      const handler = forward(signal);
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
  const root = mkdtempSync(join(tmpdir(), "p4b-"));
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

    // 2. The deadline. A probe that ignores its work is terminated and reported
    //    as 124, exactly like the timeout utility.
    const deadlineRoot = join(root, "deadline");
    mkdirSync(deadlineRoot, { mode: 0o700 });
    const late = await runChild(["--deadline-probe"], PROBE_DEADLINE_MS, {}, deadlineRoot);
    eq(late.code, DEADLINE_CODE, "deadline probe reports 124");
    ok(groupIsGone(late.pid), "deadline probe process group reaped");
    process.stdout.write("PASS P4-B supervisor signals and deadline\n");

    // 3. The two matrices.
    for (const [mode, line] of [
      ["--server", "PASS P4-B server request, locator, GitHub, conflict, and receipt matrix"],
      ["--client", "PASS P4-B overlay barrier, plaintext editor, save, conflict, and degradation matrix"],
    ]) {
      const workerRoot = join(root, mode.slice(2));
      mkdirSync(workerRoot, { mode: 0o700 });
      const result = await runChild([mode], WORKER_DEADLINE_MS, { P4B_ROOT: workerRoot }, ROOT);
      if (result.code !== 0 || result.stderr !== "") {
        process.stderr.write(result.stdout);
        process.stderr.write(result.stderr);
        throw new Error(`${mode} worker exited ${result.code}`);
      }
      ok(groupIsGone(result.pid), `${mode} worker process group reaped`);
      process.stdout.write(`${line}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (existsSync(root)) throw new Error("FAIL guarded fixture root survived");
  process.stdout.write("PASS P4-B fixture cleaned\n");
}

/** Wait for the probe to publish its own pid, so the supervisor signals the
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

function deadlineProbe() {
  setInterval(() => {}, 1000);
}

/* ========================================================================= */
/* the shared fixture                                                        */
/* ========================================================================= */

const DOC_ID = "4b7d2a";
const AID = "a31b7c9d2";
const OTHER_AID = "a1111111a";
const INSTANCE = "orchard";
const SECTION_FILE = "sections/01-index.html";
const SECTION_ID = "index";
const SUB = "u_fixture_writer_31";
const NAME = "Avery Quill";
const EMAIL = "avery@example.com";
const BOT_EMAIL = "bot@example.com";
const REPO = "orchard-team/orchard-docs";
const BASE = "main";
const NOW_MS = Date.parse("2026-09-03T17:04:11.201Z");
const NOW_ISO = "2026-09-03T17:04:11.201Z";

const INNER = "The orchard index covers <strong>every</strong> declared basket.";
const TEXT = "The orchard index covers **every** declared basket.";
const NEXT_TEXT = "The orchard index covers **each** declared basket.";

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

function writeManifest(root, overrides = {}) {
  const dist = join(root, INSTANCE, "dist");
  mkdirSync(dist, { recursive: true });
  const manifest = {
    docId: DOC_ID,
    instance: INSTANCE,
    commit: "",
    blocks: {
      [AID]: { file: SECTION_FILE, section: SECTION_ID, tag: "p", hash: BASE_HASH },
    },
    ...overrides,
  };
  writeFileSync(join(dist, `${INSTANCE}.edit.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/* ========================================================================= */
/* the server matrix                                                         */
/* ========================================================================= */

/** An in-memory blob store with the exact provider surface P2-B uses. */
class FakeStore {
  constructor() {
    this.records = new Map();
    this.version = 0;
    this.readHook = null;
    this.writeHook = null;
  }

  async getWithMetadata(key) {
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

  seed(key, value) {
    this.version += 1;
    this.records.set(key, { value: structuredClone(value), etag: `"v${this.version}"` });
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
    this.pulls = options.pulls ?? [];
    this.createPull = options.createPull ?? { status: 201, number: 412 };
    this.contentsStatus = options.contentsStatus ?? 200;
    this.committed = null;
    this.baseSha = "1".repeat(40);
    this.headSha = "2".repeat(40);
    this.blobSha = "3".repeat(40);
  }

  json(status, body) {
    return new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  file(text) {
    return this.json(this.contentsStatus, {
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
      return this.json(200, this.pulls);
    }
    if (method === "POST" && path === `/repos/${REPO}/pulls`) {
      if (this.createPull.status !== 201) return this.json(this.createPull.status, { message: "no" });
      return this.json(201, {
        number: this.createPull.number,
        head: { ref: this.branchName() },
        base: { ref: BASE },
      });
    }
    throw new Error(`undeclared route ${method} ${path}`);
  }

  branchName() {
    return `docedit/${DOC_ID}/${sha256(SUB).slice(0, 16)}`;
  }
}

function identityFor(overrides) {
  return { sub: SUB, email: EMAIL, emailVerified: true, name: NAME, ...overrides };
}

async function serverMatrix() {
  const store = await import(pathToFileURL(join(ROOT, "netlify/lib/store.mjs")).href);
  // The vendored deploy-tree copies, not `templates/docbuild/dist/`: these are
  // the exact modules `edit.mjs` imports in production, so the server matrix
  // exercises the same functions the endpoint will actually call.
  const core = await import(pathToFileURL(join(ROOT, "netlify/lib/anchor-core.mjs")).href);
  const md = await import(pathToFileURL(join(ROOT, "netlify/lib/inline-md.mjs")).href);
  const { createEditHandler } = await import(
    pathToFileURL(join(ROOT, "netlify/functions/edit.mjs")).href
  );
  const access = await import(
    pathToFileURL(join(ROOT, "netlify/lib/access.mjs")).href
  );
  const gitedit = await import(pathToFileURL(join(ROOT, "netlify/lib/gitedit.mjs")).href);

  const fixture = join(process.env.P4B_ROOT, "fixture");
  mkdirSync(fixture, { recursive: true });
  writeManifest(fixture);
  process.chdir(fixture);

  const env = {
    DOCS_REPO: REPO,
    DOCS_BASE_BRANCH: BASE,
    DOCS_GITHUB_TOKEN: "fixture-token",
    DOCS_BOT_EMAIL: BOT_EMAIL,
  };

  /** Build one handler plus the doubles it was wired to.
   *
   * P4-N moved the manifest, source, repository and receipt work out of
   * `edit.mjs` and behind the one apply path in `gitedit.mjs`. The seam moved;
   * the behaviour this matrix pins did not. The same doubles are therefore
   * wired into `createGitEditService()`, and the two apply entry points it
   * returns are injected into the narrowed edit factory. */
  function build(options = {}) {
    const blobs = options.store ?? new FakeStore();
    const github = options.github ?? new FakeGitHub();
    const counters = { identify: 0, origin: 0, docState: 0, notify: 0 };
    const converters = options.converters ?? md;
    // `undefined` means "this variable is not set", which the service models by
    // omitting the name rather than by capturing an undefined value.
    const environment = {};
    for (const [name, value] of Object.entries({ ...env, ...(options.env ?? {}) })) {
      if (value !== undefined) environment[name] = value;
    }
    const service = gitedit.createGitEditService({
      storeFn: () => {
        counters.docState += 1;
        if (options.docStateThrows === true) {
          throw new store.StoreError("unavailable", 503, "State store unavailable");
        }
        return blobs;
      },
      readFn: store.read,
      mutateFn: store.mutate,
      fetchFn: (url, init) => github.fetch(url, init),
      // The apply path's audit row is best effort and strictly downstream of
      // the receipt; this matrix is about the write, so it is a no-op here.
      appendEventFn: async () => {},
      nowFn: () => options.now ?? NOW_MS,
      sha256Fn: sha256,
      scanBlocksFn: core.scanBlocks,
      toMdFn: converters.toMd,
      toHtmlFn: converters.toHtml,
      env: environment,
    });
    const deps = {
      requireOrigin: (req) => {
        counters.origin += 1;
        if (options.originThrows !== undefined) throw options.originThrows;
      },
      identify: async () => {
        counters.identify += 1;
        if (options.identifyThrows === true) throw new Error("identity");
        return options.identity === undefined ? identityFor({}) : options.identity;
      },
      // P4-M replaced the temporary `isOrg` gate with the P2-G document role.
      // The P4-B matrix is about the apply path, so the default double grants
      // an owner; `options.role` selects a denial for the gate cases below.
      resolveRole: async () => ({
        role: options.role ?? "owner",
        shared: true,
        ...access.capabilitiesFor(options.role ?? "owner"),
      }),
      capabilitiesFor: access.capabilitiesFor,
      readEffectiveBase: service.readEffectiveBase,
      applyText: service.applyText,
      notify: () => { counters.notify += 1; return true; },
      toMd: converters.toMd,
      toHtml: converters.toHtml,
      sha256Hex: sha256,
    };
    const handler = createEditHandler(deps);
    return {
      handle: (req) => handler(req, {}),
      blobs,
      github,
      counters,
      service,
    };
  }

  const post = (body, init = {}) => new Request("https://docs.example.com/api/edit", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });

  const valid = { docId: DOC_ID, aid: AID, text: NEXT_TEXT };

  async function readJson(response) {
    return JSON.parse(await response.text());
  }

  /* ---- the factory ---------------------------------------------------- */

  const keys = [
    "requireOrigin", "identify", "resolveRole", "capabilitiesFor",
    "readEffectiveBase", "applyText", "notify", "toMd", "toHtml", "sha256Hex",
  ];
  ok(typeof build().handle === "function", "the factory returns a handler");
  for (const bad of [null, undefined, [], "x", 1, Object.create(null)]) {
    let threw = false;
    try {
      createEditHandler(bad);
    } catch (error) {
      threw = error instanceof TypeError && error.message === "Invalid edit dependencies";
    }
    ok(threw, `factory refuses ${JSON.stringify(bad) ?? "a bare object"}`);
  }
  {
    const complete = {
      requireOrigin: () => {}, identify: async () => null,
      resolveRole: async () => ({}), capabilitiesFor: () => ({}),
      readEffectiveBase: async () => ({}), applyText: async () => ({}),
      notify: () => true, toMd: md.toMd, toHtml: md.toHtml, sha256Hex: () => "",
    };
    for (const key of keys) {
      const partial = { ...complete };
      delete partial[key];
      let threw = false;
      try {
        createEditHandler(partial);
      } catch {
        threw = true;
      }
      ok(threw, `factory refuses a dependency object missing ${key}`);
    }
    let extraThrew = false;
    try {
      createEditHandler({ ...complete, surprise: () => {} });
    } catch {
      extraThrew = true;
    }
    ok(extraThrew, "factory refuses an extra dependency key");
    let nonCallableThrew = false;
    try {
      createEditHandler({ ...complete, applyText: "not a function" });
    } catch {
      nonCallableThrew = true;
    }
    ok(nonCallableThrew, "factory refuses a non-callable apply path");
    // The apply seam is closed on its own side too: the store, the provider
    // and the environment reach the write only through this service.
    let unknownSeamThrew = false;
    try {
      gitedit.createGitEditService({ surprise: () => {} });
    } catch {
      unknownSeamThrew = true;
    }
    ok(unknownSeamThrew, "the apply service refuses an unknown dependency key");
    // The handler now also receives the Functions context, which it passes to
    // the fan-out and to nothing else.
    ok(createEditHandler(complete).length === 2, "handler takes the request and its context");
  }

  /* ---- method, origin, identity, gate ---------------------------------- */

  for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const built = build();
    const response = await built.handle(
      new Request("https://docs.example.com/api/edit", { method }),
    );
    eq(response.status, 405, `${method} is 405`);
    eq(response.headers.get("allow"), "POST", `${method} advertises POST`);
    eq(response.headers.get("cache-control"), "private, no-store", `${method} is private`);
    eq(built.counters.origin, 0, `${method} performs no origin work`);
    eq(built.counters.identify, 0, `${method} performs no identity work`);
    eq(built.github.calls.length, 0, `${method} performs no provider work`);
    if (method !== "HEAD") {
      const body = await readJson(response);
      eq(body, { error: { code: "method-not-allowed", message: "Method not allowed" } },
        `${method} body`);
    }
  }

  {
    const thrown = new Response("Bad origin", { status: 403 });
    const built = build({ originThrows: thrown });
    const response = await built.handle(post(valid));
    ok(response === thrown, "a thrown origin Response is returned unchanged");
    eq(built.counters.identify, 0, "origin short-circuits identity");
  }
  {
    const built = build({ originThrows: new Error("boom") });
    const response = await built.handle(post(valid));
    eq(response.status, 500, "a non-Response origin throw is an invalid state");
  }
  {
    const built = build({ identity: null });
    const response = await built.handle(post(valid));
    eq(response.status, 401, "no identity is 401");
    eq((await readJson(response)).error.code, "unauthenticated", "401 code");
    eq(built.github.calls.length, 0, "401 performs no provider work");
  }
  {
    const built = build({ identifyThrows: true });
    eq((await built.handle(post(valid))).status, 500, "a thrown identity is 500");
  }
  for (const [label, identity] of [
    ["missing email", { sub: SUB, emailVerified: true, name: NAME }],
    ["empty email", identityFor({ email: "" })],
    ["uppercase email", identityFor({ email: "Avery@example.com" })],
    ["padded email", identityFor({ email: " avery@example.com" })],
    ["bad subject", identityFor({ sub: "-nope" })],
    ["long name", identityFor({ name: "x".repeat(201) })],
    ["non-boolean emailVerified", identityFor({ emailVerified: "yes" })],
    ["the removed organisation field", { sub: SUB, email: EMAIL, name: NAME, isOrg: true }],
    ["extra field", { ...identityFor({}), role: "owner" }],
  ]) {
    const built = build({ identity });
    const response = await built.handle(post(valid));
    eq(response.status, 500, `identity with ${label} is 500`);
    eq(built.github.calls.length, 0, `identity with ${label} performs no provider work`);
  }
  {
    // P4-M owns the write gate: the document role decides, and a role without
    // `canEdit` is the denial P4-B's apply path must never see. The identity's
    // own fields decide nothing here -- `isOrg` used to, and after ACN-006
    // there is no field on an identity that could. The full capability matrix
    // lives in scripts/test-p4-m.mjs.
    const built = build({ identity: identityFor({ emailVerified: false }), role: "owner" });
    eq((await built.handle(post(valid))).status, 200,
      "no identity field gates the write");
    const denied = build({ role: "viewer" });
    const response = await denied.handle(post(valid));
    eq(response.status, 403, "a role without canEdit is 403");
    eq((await readJson(response)).error,
      { code: "forbidden", message: "Document edit denied" }, "403 body");
    eq(denied.github.calls.length, 0, "403 performs no provider work");
    eq(denied.counters.docState, 0, "403 performs no store work");
  }

  /* ---- URL and body ---------------------------------------------------- */

  {
    const built = build();
    const response = await built.handle(new Request("https://docs.example.com/api/edit?doc=4b7d2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(valid),
    }));
    eq(response.status, 400, "a query parameter is refused");
  }
  {
    const built = build();
    const response = await built.handle(post(valid, { headers: { "Content-Type": "text/plain" } }));
    eq(response.status, 415, "a wrong media type is 415");
    eq((await readJson(response)).error.message, "Content-Type must be application/json", "415 body");
  }
  for (const accepted of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
    const built = build();
    const response = await built.handle(post(valid, { headers: { "Content-Type": accepted } }));
    ok(response.status !== 415, `${accepted} is a JSON media type`);
  }
  {
    const oversized = { docId: DOC_ID, aid: AID, text: "x".repeat(3999), pad: "y".repeat(70000) };
    const built = build();
    const response = await built.handle(post(oversized));
    eq(response.status, 413, "an over-limit body is 413");
    eq((await readJson(response)).error.message, "Request body exceeds 65536 bytes", "413 body");
  }
  {
    const built = build();
    const response = await built.handle(post(valid, {
      headers: { "Content-Type": "application/json", "Content-Length": "65537" },
    }));
    eq(response.status, 413, "an over-limit Content-Length is 413");
  }
  {
    const built = build();
    const response = await built.handle(post(valid, {
      headers: { "Content-Type": "application/json", "Content-Length": "007" },
    }));
    eq(response.status, 400, "a non-canonical Content-Length is refused");
  }
  for (const [label, body] of [
    ["a bare array", "[]"],
    ["a bare string", '"x"'],
    ["broken JSON", "{"],
    ["an unknown key", JSON.stringify({ ...valid, extra: 1 })],
    ["a missing docId", JSON.stringify({ aid: AID, text: TEXT })],
    ["a missing aid", JSON.stringify({ docId: DOC_ID, text: TEXT })],
    ["a missing text", JSON.stringify({ docId: DOC_ID, aid: AID })],
    ["a short docId", JSON.stringify({ ...valid, docId: "4b7d2" })],
    ["an uppercase docId", JSON.stringify({ ...valid, docId: "4B7D2A" })],
    ["a bad aid", JSON.stringify({ ...valid, aid: "b31b7c9d2" })],
    ["a numeric text", JSON.stringify({ ...valid, text: 12 })],
    ["a null text", JSON.stringify({ ...valid, text: null })],
    ["a 4001-unit text", JSON.stringify({ ...valid, text: "x".repeat(4001) })],
  ]) {
    const built = build();
    const response = await built.handle(post(body));
    eq(response.status, 400, `${label} is 400`);
    eq((await readJson(response)).error.code, "invalid-body", `${label} code`);
    eq(built.github.calls.length, 0, `${label} performs no provider work`);
  }
  {
    // The reserved keys are tolerated and never read: the response author is
    // always the proven identity.
    const built = build();
    const response = await built.handle(post({
      ...valid, author: "someone", email: "attacker@example.com", name: "Attacker",
    }));
    eq(response.status, 200, "reserved body keys are tolerated");
    const body = await readJson(response);
    eq(body.receipt.by, { sub: SUB, name: NAME, email: EMAIL }, "the author is the server identity");
  }
  {
    // The twin gate. The real converter pair looks total over this vocabulary
    // -- an exhaustive search finds no string it cannot reproduce -- so the
    // rejection branch can only be reached through the injected pair. Assert
    // both halves: totality (so a future converter change that breaks it is
    // caught here) and that a non-reproducing pair actually refuses the write.
    const alphabet = ["*", "`", "<", ">", "&", "a"];
    let hostile = null;
    const walk = (prefix) => {
      if (hostile !== null) return;
      if (prefix.length > 0) {
        const html = md.toHtml(prefix);
        if (md.toMd(html) !== prefix || md.toHtml(md.toMd(html)) !== html) {
          hostile = prefix;
          return;
        }
      }
      if (prefix.length === 4) return;
      for (const letter of alphabet) walk(prefix + letter);
    };
    walk("");
    eq(hostile, null, "the committed converter pair reproduces every short input");

    const built = build({});
    eq((await built.handle(post(valid))).status, 200, "the real pair admits the text");

    // A pair whose first twin fails, and a pair whose second twin fails.
    const broken = build({
      converters: { toMd: (html) => `${md.toMd(html)} ` , toHtml: md.toHtml },
    });
    const first = await broken.handle(post(valid));
    eq(first.status, 400, "a text that fails toMd(toHtml(text)) === text is refused");
    eq(broken.github.calls.length, 0, "a refused text performs no provider work");
  }
  for (const [label, text] of [["empty", ""], ["4000 units", "x".repeat(4000)]]) {
    const built = build();
    const response = await built.handle(post({ ...valid, text }));
    eq(response.status, 200, `a ${label} text is accepted`);
    eq((await readJson(response)).receipt.text, text, `a ${label} text round-trips`);
  }

  /* ---- manifest and configuration -------------------------------------- */

  {
    const built = build();
    const response = await built.handle(post({ ...valid, docId: "aaaaaa" }));
    eq(response.status, 404, "an unknown document is 404");
    eq((await readJson(response)).error,
      { code: "not-found", message: "Document or block not found" }, "404 body");
  }
  {
    const built = build();
    const response = await built.handle(post({ ...valid, aid: "a99999999" }));
    eq(response.status, 404, "an unknown block is 404");
    eq(built.github.calls.length, 0, "404 performs no provider work");
  }
  for (const [label, overrides] of [
    ["a missing repository", { DOCS_REPO: undefined }],
    ["a malformed repository", { DOCS_REPO: "orchard" }],
    ["a traversing base branch", { DOCS_BASE_BRANCH: "main/../evil" }],
    ["a leading-slash base branch", { DOCS_BASE_BRANCH: "/main" }],
    ["a reflog base branch", { DOCS_BASE_BRANCH: "main@{1}" }],
    ["an empty token", { DOCS_GITHUB_TOKEN: "" }],
    ["a malformed bot email", { DOCS_BOT_EMAIL: "bot@localhost" }],
  ]) {
    const built = build({ env: overrides });
    const response = await built.handle(post(valid));
    eq(response.status, 500, `${label} is 500`);
    eq(built.github.calls.length, 0, `${label} is decided before any request`);
    const body = await readJson(response);
    eq(body, { error: { code: "invalid-state", message: "Invalid edit state" } },
      `${label} leaks nothing`);
  }
  {
    // The default base branch is `main` and needs no configuration.
    const built = build({ env: { DOCS_BASE_BRANCH: undefined } });
    eq((await built.handle(post(valid))).status, 200, "the base branch defaults to main");
  }
  {
    const built = build({ docStateThrows: true });
    const response = await built.handle(post(valid));
    eq(response.status, 503, "an unavailable store is 503");
    eq((await readJson(response)).error,
      { code: "unavailable", message: "Edit state unavailable" }, "503 body");
  }

  /* ---- the branch ------------------------------------------------------ */

  {
    const github = new FakeGitHub({ branchExists: true });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 200, "an existing branch is reused");
    ok(!github.calls.some((call) => call.startsWith("POST /repos") && call.endsWith("/git/refs")),
      "an existing branch is never recreated");
  }
  {
    const github = new FakeGitHub({ branchExists: false, createStatus: 201 });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 200, "a missing branch is created");
    ok(github.calls.includes(`POST /repos/${REPO}/git/refs`), "the ref create was issued");
  }
  {
    const github = new FakeGitHub({ branchExists: false, createStatus: 422, raceResolves: true });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 200, "a raced 422 create is accepted once proved");
  }
  {
    const github = new FakeGitHub({ branchExists: false, createStatus: 422, raceResolves: false });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "an unproved 422 create is 502");
  }
  {
    const github = new FakeGitHub({ branchExists: false, createStatus: 500 });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "a failed ref create is 502");
  }
  {
    const github = new FakeGitHub();
    const built = build({ github });
    await built.handle(post(valid));
    const expected = `docedit/${DOC_ID}/${sha256(SUB).slice(0, 16)}`;
    ok(github.calls.some((call) => call.includes(encodeURIComponent(expected).replace(/%2F/g, "/"))
      || call.includes(expected)), "the branch is derived from the subject digest");
    ok(!github.calls.some((call) => call.includes(EMAIL)), "the branch never carries the email");
    ok(!github.calls.some((call) => call.includes(SUB)), "the branch never carries the raw subject");
  }

  /* ---- the locator ----------------------------------------------------- */

  for (const [label, options] of [
    ["malformed anchors JSON", { anchors: "{" }],
    ["an anchors section with an extra key", {
      anchors: JSON.stringify({ [SECTION_ID]: { ids: [], texts: [], extra: 1 } }),
    }],
    ["mismatched anchors lengths", {
      anchors: JSON.stringify({ [SECTION_ID]: { ids: [AID], texts: [] } }),
    }],
    ["an invalid anchor id", {
      anchors: JSON.stringify({ [SECTION_ID]: { ids: ["nope"], texts: ["x"] } }),
    }],
    ["a source with no body marker", { source: SOURCE.replace("<!-- body -->", "") }],
    ["a source with two body markers", { source: `${SOURCE}\n<!-- body -->` }],
    ["an unscannable source", { source: `<!-- body -->\n<p>unclosed` }],
    ["a 404 contents read", { contentsStatus: 404 }],
  ]) {
    const github = new FakeGitHub(options);
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 502, `${label} is 502`);
    eq((await readJson(response)).error,
      { code: "repository-unavailable", message: "Repository write unavailable" },
      `${label} leaks nothing`);
    ok(github.committed === null, `${label} never writes`);
  }
  {
    const github = new FakeGitHub({
      anchors: JSON.stringify({ [SECTION_ID]: { ids: [OTHER_AID], texts: ["Orchard"] } }),
    });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "an aid absent from the committed anchors is 409");
    const body = await readJson(response);
    eq(body, {
      error: { code: "conflict", message: "The block changed since this document was built" },
      current: null,
    }, "the 409 body carries a null current");
    ok(github.committed === null, "a missing aid never writes");
  }
  {
    const github = new FakeGitHub({
      anchors: JSON.stringify({ other: { ids: [AID], texts: ["x"] } }),
    });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 409, "an absent anchors section is 409");
  }
  {
    // The block moved: the anchors index now selects a heading, not the
    // paragraph the manifest hashed.
    const source = SOURCE.replace(`<p data-aid="${AID}">${INNER}</p>`,
      `<h3 data-aid="${AID}">${INNER}</h3>`);
    const github = new FakeGitHub({ source });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "a retagged block is 409");
    eq((await readJson(response)).current, TEXT, "the retagged block reports representable text");
    ok(github.committed === null, "a retagged block never writes");
  }
  {
    const source = SOURCE.replace(INNER, "The orchard index covers <em>every</em> basket.");
    const github = new FakeGitHub({ source });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "a changed block is 409");
    eq((await readJson(response)).current, "The orchard index covers *every* basket.",
      "a changed block reports its current text");
  }
  {
    // Unrepresentable current text: a link survives the scan but not the
    // three-mark vocabulary, so `current` must be null rather than a guess.
    const source = SOURCE.replace(INNER, 'See <a href="/x">here</a>.');
    const github = new FakeGitHub({ source });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "unrepresentable current text is 409");
    eq((await readJson(response)).current, null, "unrepresentable current text is null");
  }
  {
    // A source index that no longer reaches the anchor position refuses.
    const source = SOURCE.replace(`<p data-aid="${AID}">${INNER}</p>`, "");
    const github = new FakeGitHub({ source });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 409, "a deleted block is 409");
  }

  /* ---- the commit ------------------------------------------------------ */

  {
    const github = new FakeGitHub();
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 200, "a matching block commits");
    const payload = github.committed;
    eq(payload.message, `Edit block ${AID} in document ${DOC_ID}`, "the commit message");
    eq(payload.branch, github.branchName(), "the commit branch");
    eq(payload.sha, github.blobSha, "the commit carries the file SHA just read");
    eq(payload.author, { name: NAME, email: EMAIL }, "the reader stays the author");
    eq(payload.committer, { name: "Architecture Docs", email: BOT_EMAIL }, "the site is committer");
    const next = Buffer.from(payload.content, "base64").toString("utf8");
    eq(next, SOURCE.replace(INNER, md.toHtml(NEXT_TEXT)), "only the inner range changed");
    ok(next.includes(`<h2 data-aid="${OTHER_AID}">Orchard</h2>`), "sibling blocks are preserved");
  }
  {
    const github = new FakeGitHub({ putStatuses: [409, 200] });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 200, "one file-SHA race retries once");
    const reads = github.calls.filter((call) => call.startsWith("GET") && call.includes("/contents/"));
    eq(reads.length, 4, "the retry repeats both reads");
  }
  {
    const github = new FakeGitHub({ putStatuses: [409, 409] });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "a second file-SHA conflict is the public conflict");
    // P4-N deliberately widened this one body. The retry has already re-read
    // the source, so the conflict can report what the block now says instead
    // of a bare null the client cannot act on. Nothing else about the case
    // changed: the write is refused and the commit never loops.
    eq((await readJson(response)).current, TEXT,
      "the second conflict reports the re-read source text");
    const puts = github.calls.filter((call) => call.startsWith("PUT"));
    eq(puts.length, 2, "the handler never loops on the commit");
  }
  {
    const github = new FakeGitHub({ putStatuses: [500] });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "a failed commit is 502");
    const puts = github.calls.filter((call) => call.startsWith("PUT"));
    eq(puts.length, 1, "a non-conflict commit failure never retries");
  }

  /* ---- pull requests --------------------------------------------------- */

  {
    const github = new FakeGitHub({ pulls: [] });
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq((await readJson(response)).receipt.pr, 412, "a created pull request is recorded");
    const query = github.calls.find((call) => call.startsWith(`GET /repos/${REPO}/pulls`));
    ok(query.includes("state=open"), "the listing is scoped to open pull requests");
    ok(query.includes("per_page=2"), "the listing asks for at most two rows");
    ok(query.includes(encodeURIComponent(`orchard-team:${github.branchName()}`)),
      "the listing is scoped to the derived head");
  }
  {
    const github = new FakeGitHub();
    github.pulls = [{ number: 77, head: { ref: github.branchName() }, base: { ref: BASE } }];
    const built = build({ github });
    const response = await built.handle(post(valid));
    eq((await readJson(response)).receipt.pr, 77, "one open pull request is reused");
    ok(!github.calls.includes(`POST /repos/${REPO}/pulls`), "an existing pull request is not recreated");
  }
  {
    const github = new FakeGitHub();
    github.pulls = [
      { number: 77, head: { ref: github.branchName() }, base: { ref: BASE } },
      { number: 78, head: { ref: github.branchName() }, base: { ref: BASE } },
    ];
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "two open pull requests are ambiguous");
  }
  {
    const github = new FakeGitHub({ pulls: [{ number: 0 }] });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "a malformed pull request row is 502");
  }
  {
    const github = new FakeGitHub({ createPull: { status: 500 } });
    const built = build({ github });
    eq((await built.handle(post(valid))).status, 502, "a failed pull request create is 502");
  }

  /* ---- the receipt ----------------------------------------------------- */

  const receiptKey = store.editKey(DOC_ID, AID);
  const freshReceipt = (overrides = {}) => ({
    v: 1,
    aid: AID,
    text: TEXT,
    by: { sub: SUB, name: NAME, email: EMAIL },
    at: NOW_ISO,
    baseHash: BASE_HASH,
    pr: 412,
    via: "edit",
    ...overrides,
  });

  {
    const blobs = new FakeStore();
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    const response = await built.handle(post(valid));
    eq(response.status, 200, "a first save succeeds");
    eq(blobs.records.get(receiptKey).value, freshReceipt({ text: NEXT_TEXT }),
      "the stored receipt is exact");
    const body = await readJson(response);
    // P4-N's spec adds `aid` to the head of this projection so a client that
    // fans an edit out has the block it applies to without re-deriving it.
    eq(body, {
      receipt: {
        aid: AID,
        text: NEXT_TEXT,
        by: { sub: SUB, name: NAME, email: EMAIL },
        at: NOW_ISO,
        pr: 412,
        via: "edit",
      },
    }, "the response is the direct projection");
    eq(await new Response(JSON.stringify(body)).text(), JSON.stringify(body), "no trailing LF");
    eq(response.headers.get("content-type"), "application/json; charset=utf-8", "the response type");
    eq(response.headers.get("cache-control"), "private, no-store", "the response is private");
  }
  {
    const blobs = new FakeStore();
    blobs.seed(receiptKey, freshReceipt());
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    const response = await built.handle(post(valid));
    eq(response.status, 409, "a fresh receipt for this base refuses");
    eq((await readJson(response)).current, TEXT, "the fresh receipt reports its exact text");
    eq(github.calls.length, 0, "a fresh receipt is decided before any provider work");
  }
  {
    const blobs = new FakeStore();
    blobs.seed(receiptKey, freshReceipt({ baseHash: "0".repeat(64) }));
    const built = build({ store: blobs });
    eq((await built.handle(post(valid))).status, 200, "a stale receipt may be replaced");
    eq(blobs.records.get(receiptKey).value.text, NEXT_TEXT, "the stale receipt was replaced");
  }
  {
    // The idempotent branch. The precheck must miss and the swap must then see
    // a byte-identical receipt, which is the only way `apply` returns null.
    // Under P4-N the effective base is read before the apply path runs, so the
    // first two reads are the ones that must miss.
    const blobs = new FakeStore();
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    const identical = freshReceipt({ text: NEXT_TEXT });
    let reads = 0;
    blobs.getWithMetadata = async () => {
      reads += 1;
      return reads <= 2 ? null : { data: structuredClone(identical), etag: '"v7"' };
    };
    let written = null;
    blobs.setJSON = async (key, value) => {
      written = structuredClone(value);
      return { modified: true, etag: '"v8"' };
    };
    const response = await built.handle(post(valid));
    eq(response.status, 200, "an identical receipt still reports success");
    // P4-N's callback contract distinguishes the two snapshots P4-B collapsed.
    // The captured pre-apply snapshot here is null, so an identical receipt
    // observed at the swap is rewritten with the same bytes rather than
    // skipped. It is still idempotent: nothing a caller can observe changes.
    eq(written, identical, "an identical receipt is rewritten with the same value");
    eq((await readJson(response)).receipt.text, NEXT_TEXT, "the projection is the stored text");
  }
  {
    // A competing writer lands a different fresh receipt between the precheck
    // and the compare-and-swap: the callback throws the private sentinel.
    const blobs = new FakeStore();
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    blobs.readHook = () => null;
    const original = blobs.getWithMetadata.bind(blobs);
    let seeded = false;
    blobs.getWithMetadata = async (key) => {
      if (!seeded) {
        seeded = true;
        return null;
      }
      if (blobs.records.size === 0) blobs.seed(receiptKey, freshReceipt({ text: TEXT }));
      return original(key);
    };
    const response = await built.handle(post(valid));
    eq(response.status, 409, "a competing fresh receipt is a conflict");
    eq((await readJson(response)).current, TEXT, "the competing receipt reports its text");
    ok(github.committed !== null, "the commit still landed and is not rolled back");
  }
  {
    const blobs = new FakeStore();
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    blobs.writeHook = () => {
      throw new Error("provider down");
    };
    const response = await built.handle(post(valid));
    eq(response.status, 503, "a post-commit receipt failure is 503");
    eq((await readJson(response)).error,
      { code: "unavailable", message: "Edit state unavailable" }, "503 body");
    ok(github.committed !== null, "the commit is not claimed to be rolled back");
  }
  {
    const blobs = new FakeStore();
    blobs.seed(receiptKey, { v: 1, aid: AID, nonsense: true });
    const built = build({ store: blobs });
    eq((await built.handle(post(valid))).status, 500, "a malformed stored receipt is 500");
  }
  {
    // A receipt shape this build cannot read appears only after the precheck.
    // It is neither stale nor fresh, so the callback refuses rather than
    // clobbering what could be a later schema's acceptance or audit state.
    // The effective-base read and the precheck both precede the swap.
    const blobs = new FakeStore();
    const github = new FakeGitHub();
    const built = build({ store: blobs, github });
    let reads = 0;
    const original = blobs.getWithMetadata.bind(blobs);
    blobs.getWithMetadata = async (key) => {
      reads += 1;
      if (reads <= 2) return null;
      return { data: { v: 1, aid: AID, fromTheFuture: true }, etag: '"v9"' };
    };
    const response = await built.handle(post(valid));
    eq(response.status, 500, "an unreadable receipt at the swap fails closed");
    ok(github.committed !== null, "the commit still landed and is not rolled back");
    eq(blobs.records.size, 0, "the unreadable slot was never overwritten");
    blobs.getWithMetadata = original;
  }
  {
    const blobs = new FakeStore();
    const built = build({ store: blobs, now: 1.5 });
    eq((await built.handle(post(valid))).status, 500, "a non-integer clock is 500");
  }

  /* ---- the locator against real build output --------------------------- */

  {
    // The invented fixture proves the rules; this proves the rules describe the
    // documents this repository actually builds. Every editable block in the
    // committed example manifest must be reachable by the same anchors-index
    // plus body-marker join the handler uses, and must hash to the manifest.
    const manifestPath = join(ROOT, "example/dist/example.edit.json");
    const anchorsPath = join(ROOT, "example/anchors.json");
    if (existsSync(manifestPath) && existsSync(anchorsPath)) {
      const built = JSON.parse(readFileSync(manifestPath, "utf8"));
      const anchors = JSON.parse(readFileSync(anchorsPath, "utf8"));
      let reached = 0;
      for (const [aid, row] of Object.entries(built.blocks)) {
        const source = readFileSync(join(ROOT, "example", row.file), "utf8");
        const at = source.indexOf("<!-- body -->");
        ok(at !== -1 && source.indexOf("<!-- body -->", at + 13) === -1,
          `${row.file} has exactly one body marker`);
        const start = at + "<!-- body -->".length;
        const scanned = core.scanBlocks(source.slice(start));
        const index = anchors[row.section].ids.indexOf(aid);
        const block = scanned[index];
        ok(block !== undefined, `${aid} is reachable at its anchor index`);
        eq(block.tag, row.tag, `${aid} keeps its manifest tag`);
        const inner = source.slice(start + block.innerStart, start + block.innerEnd);
        eq(sha256(inner), row.hash, `${aid} hashes to its manifest entry`);
        reached += 1;
      }
      ok(reached > 0, "the committed example manifest has editable blocks");
    }
  }

  /* ---- leak audit ------------------------------------------------------ */

  {
    const github = new FakeGitHub({ contentsStatus: 500 });
    const built = build({ github });
    const response = await built.handle(post(valid));
    const text = await response.text();
    for (const secret of ["fixture-token", REPO, INSTANCE, SECTION_FILE, BOT_EMAIL, BASE_HASH]) {
      ok(!text.includes(secret), `the 502 body never carries ${secret}`);
    }
  }

  return checks;
}

/* ========================================================================= */
/* the client matrix                                                         */
/* ========================================================================= */

/* A closed DOM. It is deliberately small: only the surface `edit.js` is
   allowed to touch exists, so a module that reached for anything else would
   fail loudly here instead of passing by accident. */

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

/** Decode the three references this document vocabulary uses in ONE pass. A
 * sequential split/join would decode `&amp;lt;` to `<`, where a real
 * `textContent` yields `&lt;`, and that is exactly the input class a
 * mark-free block feeds to the editor. */
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
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class El {
  constructor(document, tagName) {
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.listeners = new Map();
    this.disabled = false;
    this.html = "";
    this.focused = false;
  }

  get className() {
    return this.attributes.get("class") ?? "";
  }

  set className(value) {
    this.attributes.set("class", value);
    this.classList.values = new Set(value.split(" ").filter(Boolean));
  }

  get innerHTML() {
    return this.html;
  }

  set innerHTML(value) {
    this.html = String(value);
  }

  get textContent() {
    return stripTags(this.html);
  }

  set textContent(value) {
    this.html = escapeText(String(value));
  }

  get isConnected() {
    return this.ownerDocument.order.includes(this);
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
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertAdjacentElement(position, element) {
    if (position !== "afterend") throw new Error(`unsupported position ${position}`);
    element.parentNode = this.parentNode;
    const siblings = this.ownerDocument.order;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
    return element;
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
    this.focused = true;
  }

  blur() {
    this.focused = false;
    this.dispatchEvent(makeEvent("blur"));
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

/** Match only the two selector shapes this module uses. */
function matches(element, selector) {
  const parts = selector.match(/\[[^\]]+\]|^[a-z]+/g) ?? [];
  for (const part of parts) {
    if (!part.startsWith("[")) {
      if (element.tagName !== part.toUpperCase()) return false;
      continue;
    }
    const inner = part.slice(1, -1);
    const equals = inner.indexOf("=");
    if (equals === -1) {
      if (!element.hasAttribute(inner)) return false;
      continue;
    }
    const name = inner.slice(0, equals);
    const raw = inner.slice(equals + 1);
    const value = raw.replace(/^["']|["']$/g, "");
    if (element.getAttribute(name) !== value) return false;
  }
  return true;
}

function makeDocument() {
  const document = {
    order: [],
    active: null,
    supportsPlaintextOnly: true,
    listeners: new Map(),
    executed: [],
  };
  document.createElement = (tag) => new El(document, tag);
  document.querySelectorAll = (selector) =>
    document.order.filter((element) => matches(element, selector));
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] ?? null;
  document.addEventListener = (type, handler) => {
    if (!document.listeners.has(type)) document.listeners.set(type, []);
    document.listeners.get(type).push(handler);
  };
  document.removeEventListener = (type, handler) => {
    const list = document.listeners.get(type);
    if (list === undefined) return;
    const at = list.indexOf(handler);
    if (at !== -1) list.splice(at, 1);
  };
  document.dispatchEvent = (event) => {
    for (const handler of [...(document.listeners.get(event.type) ?? [])]) handler(event);
    return true;
  };
  document.execCommand = (command, _show, value) => {
    document.executed.push([command, value]);
    if (command !== "insertText" || document.active === null) return false;
    document.active.textContent = document.active.textContent + value;
    return true;
  };
  document.documentElement = new El(document, "html");
  return document;
}

/** Evaluate the real client module against one closed environment. */
function evaluateClient(options = {}) {
  const source = readFileSync(join(ROOT, "templates/base/edit.js"), "utf8");
  const document = makeDocument();
  document.supportsPlaintextOnly = options.plaintextOnly !== false;

  const overlayEvents = [];
  document.addEventListener("doc:overlay", (event) => overlayEvents.push(event));

  if (options.metas === undefined || options.metas.length > 0) {
    for (const content of options.metas ?? [DOC_ID]) {
      const meta = new El(document, "meta");
      meta.setAttribute("name", "doc-id");
      meta.setAttribute("content", content);
      document.order.push(meta);
    }
  }

  const blocks = new Map();
  for (const spec of options.blocks ?? [{ aid: AID, html: INNER, md: TEXT }]) {
    const element = new El(document, spec.tag ?? "p");
    element.setAttribute("data-editable", "");
    element.setAttribute("data-aid", spec.aid);
    element.innerHTML = spec.html ?? "plain";
    if (spec.md !== undefined) element.setAttribute("data-md", spec.md);
    document.order.push(element);
    blocks.set(spec.aid, element);
  }

  const requests = [];
  const responder = options.responder ?? (() => ({ status: 200, body: {} }));
  const sandboxFetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    const answer = await responder(url, init);
    if (answer instanceof Error) throw answer;
    const headers = new Map([[
      "content-type",
      answer.contentType === undefined ? "application/json; charset=utf-8" : answer.contentType,
    ]]);
    const bytes = new TextEncoder().encode(JSON.stringify(answer.body));
    let sent = false;
    return {
      status: answer.status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }),
        cancel: async () => {},
        releaseLock: () => {},
      }) },
      json: async () => {
        if (answer.malformed === true) throw new SyntaxError("bad json");
        return answer.body;
      },
    };
  };

  const win = {
    doc: options.namespace === undefined
      ? { rail: null, panel: null, anchor: { BLOCK: ["p"], norm: (s) => s, scanBlocks: () => [] } }
      : options.namespace,
  };

  const sandbox = {
    window: win,
    document,
    location: { protocol: options.protocol ?? "https:", href: "https://docs.example.com/doc.html" },
    fetch: options.noFetch === true ? undefined : sandboxFetch,
    AbortController,
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init === undefined ? null : init.detail;
      }
    },
    Range: class Range {},
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    crypto: webcrypto,
    URL,
    Object,
    Array,
    Number,
    JSON,
    Promise,
    Date,
    Error,
    SyntaxError,
    Math,
    String,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "edit.js" });

  return { document, win, blocks, requests, overlayEvents, sandbox };
}

const SESSION_EDITOR = Object.freeze({
  sub: SUB,
  email: EMAIL,
  name: NAME,
  canComment: true,
  canEdit: true,
  doc: DOC_ID,
  role: "editor",
  shared: false,
  canSuggest: true,
  canAccept: false,
  canShare: false,
  canSeeMembers: true,
});

const SESSION_VIEWER = Object.freeze({ ...SESSION_EDITOR, role: "viewer", canEdit: false });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function reveal(harness, session) {
  harness.document.dispatchEvent({ type: "session", detail: session });
  for (let turn = 0; turn < 12; turn += 1) await settle();
}

function controlsFor(harness, aid) {
  const block = harness.blocks.get(aid);
  const at = harness.document.order.indexOf(block);
  const next = harness.document.order[at + 1];
  return next !== undefined && next.classList.contains("doc-edit-controls") ? next : null;
}

function buttonOf(controls) {
  return controls.children.find((child) => child.classList.contains("doc-edit-button"));
}

function statusOf(controls) {
  return controls.children.find((child) => child.classList.contains("doc-edit-status"));
}

async function clientMatrix() {
  const md = await import(pathToFileURL(join(ROOT, "templates/docbuild/dist/inline_md.js")).href);

  /* ---- the converter twin --------------------------------------------- */

  {
    const harness = evaluateClient();
    const rows = [
      "",
      "plain text",
      "The orchard index covers **every** declared basket.",
      "a `code` span",
      "*emphasis* and **strength**",
      "an & ampersand",
      "a <tag> that is not markup",
      "`a` and *b* and **c**",
      "x".repeat(4000),
      "**a**b**",
      "*a*b*",
      "`a`b`",
    ];
    for (const row of rows) {
      const html = md.toHtml(row);
      eq(harness.sandbox.toHtml(row), html, `the client toHtml matches P2-D for ${JSON.stringify(row.slice(0, 24))}`);
      eq(harness.sandbox.toMd(html), md.toMd(html), `the client toMd matches P2-D for ${JSON.stringify(row.slice(0, 24))}`);
      eq(md.toMd(html), row, `the twin reproduces ${JSON.stringify(row.slice(0, 24))}`);
    }
  }

  /* ---- degradation ----------------------------------------------------- */

  for (const protocol of ["file:", "data:", "blob:", "about:"]) {
    const harness = evaluateClient({ protocol });
    eq(harness.win.doc.edit, undefined, `${protocol} installs nothing`);
    eq(harness.requests.length, 0, `${protocol} issues no request`);
  }
  for (const protocol of ["http:", "https:"]) {
    const harness = evaluateClient({ protocol });
    ok(harness.win.doc.edit !== undefined, `${protocol} installs the barrier`);
  }
  {
    const harness = evaluateClient({ metas: [] });
    eq(harness.win.doc.edit, undefined, "no document id installs nothing");
  }
  {
    const harness = evaluateClient({ metas: [DOC_ID, DOC_ID] });
    eq(harness.win.doc.edit, undefined, "two document ids install nothing");
  }
  {
    const harness = evaluateClient({ metas: ["nope"] });
    eq(harness.win.doc.edit, undefined, "a malformed document id installs nothing");
  }
  {
    const harness = evaluateClient({ namespace: { anchor: {} } });
    eq(harness.win.doc.edit, undefined, "an absent anchor core installs nothing");
  }
  {
    const existing = Object.freeze({ overlaysReady: Promise.resolve(null) });
    const harness = evaluateClient({
      namespace: { edit: existing, anchor: { BLOCK: [], norm: () => "", scanBlocks: () => [] } },
    });
    ok(harness.win.doc.edit === existing, "an owned namespace is never overwritten");
  }
  {
    const harness = evaluateClient({ noFetch: true });
    eq(harness.win.doc.edit, undefined, "a host without fetch installs nothing");
  }
  {
    const harness = evaluateClient({ blocks: [{ aid: "nope", html: "x" }] });
    eq(harness.win.doc.edit, undefined, "an invalid block aid installs nothing");
  }
  {
    const harness = evaluateClient({
      blocks: [{ aid: AID, html: "x" }, { aid: AID, html: "y" }],
    });
    eq(harness.win.doc.edit, undefined, "duplicate block aids install nothing");
  }

  /* ---- the barrier ----------------------------------------------------- */

  {
    const harness = evaluateClient();
    const surface = harness.win.doc.edit;
    ok(Object.isFrozen(surface), "the published surface is frozen");
    eq(Object.keys(surface), ["overlaysReady"], "the surface publishes only the barrier");
    let settled = false;
    surface.overlaysReady.then(() => {
      settled = true;
    });
    await settle();
    eq(settled, false, "the barrier stays pending before a valid session");
    eq(harness.requests.length, 0, "no session means no request");
  }
  {
    // A reveal this module cannot read must still settle the barrier: leaving
    // it pending would strand P4-Q on a promise nothing resolves.
    const harness = evaluateClient();
    await reveal(harness, { sub: 1 });
    const result = await harness.win.doc.edit.overlaysReady;
    eq(result, { applied: [], available: false }, "a malformed session settles empty");
    eq(harness.requests.length, 0, "a malformed session issues no request");
    eq(harness.blocks.get(AID).innerHTML, INNER, "a malformed session keeps the built text");
    eq(controlsFor(harness, AID), null, "a malformed session gets no control");
  }
  for (const [label, answer] of [
    ["a 401", { status: 401, body: {} }],
    ["a 403", { status: 403, body: {} }],
    ["a 500", { status: 500, body: {} }],
    ["a malformed body", { status: 200, malformed: true }],
    ["a wrong content type", { status: 200, body: {}, contentType: "text/html" }],
    ["a malformed overlay", { status: 200, body: { [AID]: { text: 1 } } }],
    ["an unknown overlay key", { status: 200, body: { nope: { text: "x" } } }],
  ]) {
    const harness = evaluateClient({ responder: () => answer });
    await reveal(harness, SESSION_EDITOR);
    const result = await harness.win.doc.edit.overlaysReady;
    eq(result, { applied: [], available: false }, `${label} settles empty`);
    eq(harness.blocks.get(AID).innerHTML, INNER, `${label} retains the built text`);
    eq(harness.overlayEvents.length, 0, `${label} announces nothing`);
  }
  {
    const harness = evaluateClient({
      responder: () => new Error("network down"),
    });
    await reveal(harness, SESSION_EDITOR);
    const result = await harness.win.doc.edit.overlaysReady;
    eq(result.available, false, "a fetch failure settles false");
    eq(harness.blocks.get(AID).innerHTML, INNER, "a fetch failure retains the built text");
  }
  {
    const overlay = {
      [AID]: {
        text: NEXT_TEXT,
        by: { sub: SUB, name: NAME, email: EMAIL },
        at: NOW_ISO,
        pr: 412,
        via: "edit",
      },
    };
    const harness = evaluateClient({ responder: () => ({ status: 200, body: overlay }) });
    await reveal(harness, SESSION_EDITOR);
    const result = await harness.win.doc.edit.overlaysReady;
    eq(result.applied, [AID], "the applied aids are reported");
    eq(result.available, true, "a valid response is available");
    ok(Object.isFrozen(result) && Object.isFrozen(result.applied), "the result is frozen");
    const block = harness.blocks.get(AID);
    eq(block.innerHTML, md.toHtml(NEXT_TEXT), "the overlay is painted");
    eq(block.getAttribute("data-md"), NEXT_TEXT, "data-md carries the exact plaintext");
    ok(block.classList.contains("doc-edit-pending"), "the block is marked pending");
    eq(harness.overlayEvents.length, 1, "one batch was announced");
    eq(harness.overlayEvents[0].detail.aids, [AID], "the batch carries the aid");
    ok(Object.isFrozen(harness.overlayEvents[0].detail), "the detail is frozen");
    ok(Object.isFrozen(harness.overlayEvents[0].detail.aids), "the batch array is frozen");
    const request = harness.requests[0];
    ok(request.url.endsWith(`/api/pending?doc=${DOC_ID}`), "the pending request is exact");
    eq(request.init.method, "GET", "the pending request is a GET");
    eq(request.init.credentials, "same-origin", "the pending request is same-origin");
    eq(request.init.cache, "no-store", "the pending request is not cached");
    eq(request.init.redirect, "error", "the pending request refuses redirects");
  }
  for (const size of [1, 50, 51, 1000]) {
    const blocks = [];
    const overlay = {};
    for (let at = 0; at < size; at += 1) {
      const aid = `a${at.toString(16).padStart(8, "0")}`;
      blocks.push({ aid, html: "built" });
      overlay[aid] = {
        text: `text ${at}`,
        by: { sub: SUB, name: NAME, email: EMAIL },
        at: NOW_ISO,
        pr: null,
        via: "edit",
      };
    }
    const harness = evaluateClient({
      blocks,
      responder: () => ({ status: 200, body: overlay }),
    });
    await reveal(harness, SESSION_VIEWER);
    const result = await harness.win.doc.edit.overlaysReady;
    eq(result.applied.length, size, `${size} aids are applied`);
    const expected = Math.ceil(size / 50);
    eq(harness.overlayEvents.length, expected, `${size} aids become ${expected} batches`);
    let total = 0;
    for (const event of harness.overlayEvents) {
      ok(event.detail.aids.length >= 1 && event.detail.aids.length <= 50,
        `${size}: every batch holds 1 to 50 aids`);
      total += event.detail.aids.length;
    }
    eq(total, size, `${size}: every aid is announced exactly once`);
    const flat = harness.overlayEvents.flatMap((event) => [...event.detail.aids]);
    eq(flat, [...result.applied], `${size}: the batches are the sorted applied aids in order`);
    eq(new Set(flat).size, size, `${size}: no aid is announced twice`);
  }

  /* ---- the controls ---------------------------------------------------- */

  {
    const harness = evaluateClient({ responder: () => ({ status: 200, body: {} }) });
    await reveal(harness, SESSION_VIEWER);
    eq(controlsFor(harness, AID), null, "a session that may not edit gets no control");
  }
  {
    const harness = evaluateClient({ responder: () => ({ status: 200, body: {} }) });
    await reveal(harness, SESSION_EDITOR);
    const controls = controlsFor(harness, AID);
    ok(controls !== null, "an editing session gets one control");
    eq(buttonOf(controls).textContent, "Edit", "the control is an Edit button");
    eq(buttonOf(controls).type, "button", "the control never submits");
    eq(statusOf(controls).getAttribute("role"), "status", "the state is announced");
  }

  /* ---- editing --------------------------------------------------------- */

  const okOverlay = () => ({ status: 200, body: {} });

  async function editable(options = {}) {
    const harness = evaluateClient({
      plaintextOnly: options.plaintextOnly,
      responder: options.responder ?? okOverlay,
    });
    await reveal(harness, SESSION_EDITOR);
    const block = harness.blocks.get(AID);
    const controls = controlsFor(harness, AID);
    return { harness, block, controls, button: buttonOf(controls), status: statusOf(controls) };
  }

  async function activate(button) {
    button.dispatchEvent(makeEvent("click"));
    for (let turn = 0; turn < 4; turn += 1) await settle();
  }

  {
    const { block, button } = await editable();
    await activate(button);
    eq(block.textContent, TEXT, "activating reveals the data-md plaintext");
    eq(block.getAttribute("contenteditable"), "plaintext-only", "the native probe is used");
    ok(block.classList.contains("doc-edit-editing"), "the block is marked editing");
  }
  {
    const harness = evaluateClient({ plaintextOnly: false, responder: okOverlay });
    await reveal(harness, SESSION_EDITOR);
    const block = harness.blocks.get(AID);
    const controls = controlsFor(harness, AID);
    await activate(buttonOf(controls));
    eq(block.getAttribute("contenteditable"), "true", "the fallback sets plain contenteditable");
    const paste = makeEvent("paste", {
      clipboardData: { getData: (type) => (type === "text/plain" ? " pasted" : "<b>no</b>") },
    });
    block.dispatchEvent(paste);
    eq(paste.defaultPrevented, true, "the fallback intercepts paste");
    eq(harness.document.executed[0][0], "insertText", "the fallback inserts text only");
    eq(block.textContent, `${TEXT} pasted`, "only the plain-text flavour is inserted");
  }
  {
    const { block, button, status } = await editable();
    await activate(button);
    block.textContent = "changed";
    block.dispatchEvent(makeEvent("keydown", { key: "Escape" }));
    eq(block.innerHTML, INNER, "Escape restores the prior HTML");
    eq(block.getAttribute("data-md"), TEXT, "Escape restores the prior data-md");
    eq(status.textContent, "", "Escape clears the status");
  }
  {
    const harness = evaluateClient({
      blocks: [{ aid: AID, html: "plain built text" }],
      responder: okOverlay,
    });
    await reveal(harness, SESSION_EDITOR);
    const block = harness.blocks.get(AID);
    const controls = controlsFor(harness, AID);
    await activate(buttonOf(controls));
    eq(block.textContent, "plain built text", "a block without data-md edits its text content");
    block.dispatchEvent(makeEvent("keydown", { key: "Escape" }));
    eq(block.hasAttribute("data-md"), false, "Escape restores the absence of data-md");
  }
  {
    const { block, button } = await editable();
    await activate(button);
    block.dispatchEvent(makeEvent("blur"));
    eq(block.innerHTML, INNER, "an unchanged blur restores without a request");
  }
  {
    let posts = 0;
    const responder = (url, init) => {
      if (init.method === "POST") {
        posts += 1;
        return {
          status: 200,
          body: {
            receipt: {
              aid: JSON.parse(init.body).aid,
              text: JSON.parse(init.body).text,
              by: { sub: SUB, name: NAME, email: EMAIL },
              at: NOW_ISO,
              pr: 412,
              via: "edit",
            },
          },
        };
      }
      return okOverlay();
    };
    const { harness, block, button, status } = await editable({ responder });
    await activate(button);
    block.textContent = NEXT_TEXT;
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(posts, 1, "Ctrl+Enter saves exactly once");
    const request = harness.requests[harness.requests.length - 1];
    eq(request.init.method, "POST", "the save is a POST");
    eq(JSON.parse(request.init.body), {
      docId: DOC_ID,
      aid: AID,
      text: NEXT_TEXT,
      baseHash: createHash("sha256").update(INNER, "utf8").digest("hex"),
    },
      "the save body is exact");
    eq(request.init.credentials, "same-origin", "the save is same-origin");
    eq(request.init.redirect, "error", "the save refuses redirects");
    eq(block.innerHTML, md.toHtml(NEXT_TEXT), "the receipt text is rendered");
    eq(block.getAttribute("data-md"), NEXT_TEXT, "data-md follows the receipt");
    ok(block.classList.contains("doc-edit-pending"), "a saved block is pending");
    eq(status.textContent, "", "a successful save clears the status");
    const announced = harness.overlayEvents[harness.overlayEvents.length - 1];
    eq(announced.detail.aids, [AID], "the save announces its own aid");
    ok(Object.isFrozen(announced.detail.aids), "the announced array is frozen");
  }
  {
    const responder = (url, init) => (init.method === "POST"
      ? { status: 409, body: { error: { code: "conflict", message: "x" }, current: "**other** text" } }
      : okOverlay());
    const { block, button, status, controls } = await editable({ responder });
    await activate(button);
    block.textContent = NEXT_TEXT;
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", metaKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(block.innerHTML, md.toHtml("**other** text"), "a 409 renders the current text");
    eq(block.getAttribute("data-md"), "**other** text", "a 409 updates data-md");
    eq(status.textContent, "This block changed. Review the current text and try again.",
      "a 409 explains itself");
    ok(controls.classList.contains("doc-edit-conflict"), "a 409 marks the conflict state");
  }
  {
    const responder = (url, init) => (init.method === "POST"
      ? { status: 409, body: { error: { code: "conflict", message: "x" }, current: null } }
      : okOverlay());
    const { block, button, status } = await editable({ responder });
    await activate(button);
    block.textContent = NEXT_TEXT;
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(block.innerHTML, INNER, "a null current restores the prior HTML");
    eq(block.getAttribute("data-md"), TEXT, "a null current restores the prior data-md");
    ok(status.textContent.startsWith("This block changed."), "a null current still explains itself");
  }
  {
    const responder = (url, init) => (init.method === "POST"
      ? {
        status: 409,
        body: { error: { code: "conflict", message: "x" }, current: '<img src=x onerror="go()">' },
      }
      : okOverlay());
    const { block, button } = await editable({ responder });
    await activate(button);
    block.textContent = NEXT_TEXT;
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    ok(!block.innerHTML.includes("<img"), "hostile current text never becomes markup");
  }
  for (const [label, answer] of [
    ["a 500", { status: 500, body: {} }],
    ["a 403", { status: 403, body: {} }],
    ["a mismatched receipt", {
      status: 200,
      body: {
        receipt: {
          aid: AID,
          text: "something else",
          by: { sub: SUB, name: NAME, email: EMAIL },
          at: NOW_ISO,
          pr: 1,
          via: "edit",
        },
      },
    }],
    ["a malformed receipt", { status: 200, body: { receipt: { text: NEXT_TEXT } } }],
  ]) {
    const responder = (url, init) => (init.method === "POST" ? answer : okOverlay());
    const { block, button, status, controls } = await editable({ responder });
    await activate(button);
    block.textContent = NEXT_TEXT;
    block.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(block.innerHTML, INNER, `${label} restores the prior HTML`);
    eq(block.getAttribute("data-md"), TEXT, `${label} restores the prior data-md`);
    eq(status.textContent, "The edit was not saved.", `${label} says so quietly`);
    ok(controls.classList.contains("doc-edit-failed"), `${label} marks the failed state`);
  }
  {
    // Only one block may be in flight at a time.
    let release = null;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let posts = 0;
    const responder = async (url, init) => {
      if (init.method !== "POST") return okOverlay();
      posts += 1;
      await gate;
      return {
        status: 200,
        body: {
          receipt: {
            aid: JSON.parse(init.body).aid,
            text: JSON.parse(init.body).text,
            by: { sub: SUB, name: NAME, email: EMAIL },
            at: NOW_ISO,
            pr: 412,
            via: "edit",
          },
        },
      };
    };
    const harness = evaluateClient({
      blocks: [
        { aid: AID, html: INNER, md: TEXT },
        { aid: OTHER_AID, html: "second", },
      ],
      responder,
    });
    await reveal(harness, SESSION_EDITOR);
    const first = harness.blocks.get(AID);
    const second = harness.blocks.get(OTHER_AID);
    // Both blocks enter editing before either saves, so the guard under test
    // is the in-flight save and not the activation check.
    await activate(buttonOf(controlsFor(harness, AID)));
    await activate(buttonOf(controlsFor(harness, OTHER_AID)));
    first.textContent = NEXT_TEXT;
    first.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    await settle();
    second.textContent = "second changed";
    second.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    await settle();
    eq(posts, 1, "a second save is refused while one is in flight");
    eq(second.textContent, "second changed", "the refused save keeps what the reader typed");
    ok(second.classList.contains("doc-edit-editing"), "the refused block stays editable");
    ok(!controlsFor(harness, OTHER_AID).classList.contains("doc-edit-failed"),
      "the refused save is not reported as a server failure");
    eq(statusOf(controlsFor(harness, OTHER_AID)).textContent,
      "Another block is saving. Try again in a moment.", "the refusal explains itself");
    release();
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(first.getAttribute("data-md"), NEXT_TEXT, "the in-flight save still lands");
    // Retrying after the queue drains now succeeds, so no work was lost.
    second.dispatchEvent(makeEvent("keydown", { key: "Enter", ctrlKey: true }));
    for (let turn = 0; turn < 12; turn += 1) await settle();
    eq(posts, 2, "the refused block can retry once the queue drains");
    eq(second.getAttribute("data-md"), "second changed", "the retried edit lands");
  }
  {
    const responder = (url, init) => (init.method === "POST"
      ? {
        status: 200,
        body: {
          receipt: {
            aid: JSON.parse(init.body).aid,
            text: JSON.parse(init.body).text,
            by: { sub: SUB, name: NAME, email: EMAIL },
            at: NOW_ISO,
            pr: null,
            via: "edit",
          },
        },
      }
      : okOverlay());
    for (const [label, text] of [["an empty", ""], ["a 4000-unit", "x".repeat(4000)]]) {
      const { block, button } = await editable({ responder });
      await activate(button);
      block.textContent = text;
      block.dispatchEvent(makeEvent("blur"));
      for (let turn = 0; turn < 12; turn += 1) await settle();
      eq(block.getAttribute("data-md"), text, `${label} text saves`);
    }
  }

  /* ---- the stylesheet -------------------------------------------------- */

  {
    const css = readFileSync(join(ROOT, "templates/base/edit.css"), "utf8");
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((rule) => rule.split("{")[0].trim())
      .filter((rule) => rule !== "" && !rule.startsWith("@"))
      .flatMap((rule) => rule.split(","))
      .map((rule) => rule.trim())
      .filter((rule) => rule !== "");
    for (const selector of selectors) {
      ok(selector.includes(".doc-edit-") || selector.includes(".doc-suggest-") ||
        selector.includes("[data-suggest]"), `the stylesheet stays inside edit/suggestion selectors: ${selector}`);
    }
    ok(css.includes("@media print"), "print is handled");
    ok(css.includes("prefers-reduced-motion"), "reduced motion is handled");
    ok(css.includes("forced-colors"), "forced colours are handled");
    ok(css.includes(":focus-visible"), "keyboard focus is visible");
    ok(css.includes("max-width"), "narrow layouts are handled");
  }

  return checks;
}

/* ========================================================================= */
/* entry                                                                     */
/* ========================================================================= */

async function main() {
  const mode = process.argv[2];
  if (mode === "--signal-probe") return signalProbe();
  if (mode === "--deadline-probe") return deadlineProbe();
  if (mode === "--server") {
    await serverMatrix();
    return;
  }
  if (mode === "--client") {
    await clientMatrix();
    return;
  }
  if (mode !== undefined) {
    process.stderr.write("usage: node scripts/test-p4-b.mjs\n");
    process.exitCode = 2;
    return;
  }
  await supervise();
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
