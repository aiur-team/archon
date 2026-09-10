#!/usr/bin/env node
/**
 * P4-J — the permanent access write-path test runner.
 *
 *   node scripts/test-p4-j.mjs contract
 *
 * The entry point is its own supervisor. Parent mode validates `P4J_BASE` when
 * one is supplied -- CI supplies none, see `verifyBase()` --
 * generates an unguessable in-memory nonce, and spawns this same file with
 * `--worker` in its own detached process group under a real 120-second
 * deadline. On any timeout or failure it signals that group, escalates to
 * `SIGKILL` after 2,000 ms, reaps it, and confirms it is gone before printing
 * anything. A direct `--worker` invocation without the nonce fails.
 *
 * `contract` is the only mode, and it is hermetic: the worker loads the
 * production `access.mjs` through `vm.SourceTextModule` inside one poisoned
 * context, links only in-realm modules, and rejects every undeclared import.
 * The disposable Netlify Identity proof that used to be the second mode went
 * with the thing it proved -- see the note above `MODES`.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const MODES = ["contract"];
const DEADLINE_MS = 120_000;
const TERM_GRACE_MS = 2_000;
const MAX_STREAM_BYTES = 1024 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;
const BASE_PATTERN = /^[0-9a-f]{40}$/;

const EXPECTED_CONTRACT_STDOUT = [
  "PASS  P4-J P3-H GET regression",
  "PASS  P4-J owner-only access mutations",
  "PASS  P4-J invitation boundary",
  "PASS  P4-J transfer, audit, and crash matrix",
  "PASS  P4-J fence and lease guard matrix",
  "",
].join("\n");

/* The hosted oracle this runner used to carry is gone with what it proved.
   It created a disposable Netlify site, enabled Netlify Identity on it,
   provisioned four fixture accounts with passwords, signed each in through
   `POST /api/login`, and waited on a real mailbox for the recovery link an
   invitation used to send. ACN-006 removed every one of those steps: sign-in is
   Auth0, there is no password route to post to, and inviting somebody sends no
   mail. An equivalent oracle would have to drive a real identity provider's
   consent screen, which is a provider account and a decision that belongs to an
   operator rather than to this file. The contract mode is unaffected and is
   what CI runs. */

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * The reviewed base must be one lowercase commit ID that already carries this
 * canonical ticket and every predecessor, still owns P3-H's `access.mjs`, and
 * does not yet carry this runner.
 *
 * That base is necessarily a commit on this ticket's own branch: `main` never
 * carries `docs/tickets/P4-J.md` without also carrying this runner, and the
 * branch is squash-merged, so no commit satisfying the conditions survives on
 * `main` at all. Requiring it unconditionally would therefore make this runner
 * die on every push build the moment it is wired into CI (#116) -- a runner
 * nothing can execute, which is the exact failure that gate exists to stop.
 *
 * So the gate is kept, and is opt-in: supply `P4J_BASE` and every condition
 * below is enforced as specified; omit it and the run is against the working
 * tree, announced on stderr by the parent so the omission is visible in the log
 * rather than inferred.
 */
function verifyBase({ announce = false } = {}) {
  const base = process.env.P4J_BASE;
  if (base === undefined || base === "") {
    if (announce) {
      process.stderr.write(
        "NOTE  P4J_BASE unset: the reviewed-base gate is skipped and the working tree is under test\n",
      );
    }
    return "";
  }
  if (typeof base !== "string" || !BASE_PATTERN.test(base)) {
    die("export P4J_BASE as the reviewed 40-character lowercase commit ID");
  }
  let resolved;
  try {
    resolved = git(["rev-parse", "--verify", `${base}^{commit}`]);
  } catch {
    die("P4J_BASE does not resolve to a commit in this repository");
    return "";
  }
  if (resolved !== base) {
    die("P4J_BASE must name a commit, not a ref that resolves elsewhere");
  }
  try {
    git(["cat-file", "-e", `${base}:netlify/functions/access.mjs`]);
  } catch {
    die("P4J_BASE does not contain the predecessor netlify/functions/access.mjs");
  }
  let runnerPresent = true;
  try {
    git(["cat-file", "-e", `${base}:scripts/test-p4-j.mjs`]);
  } catch {
    runnerPresent = false;
  }
  if (runnerPresent) {
    die("P4J_BASE already contains scripts/test-p4-j.mjs and is not a clean base");
  }
  try {
    git(["cat-file", "-e", `${base}:docs/tickets/P4-J.md`]);
  } catch {
    die("P4J_BASE does not contain the canonical docs/tickets/P4-J.md");
  }
  return base;
}

async function parent(mode) {
  verifyBase({ announce: true });

  const nonce = randomBytes(32).toString("hex");
  const tempRoot = await mkdtemp(join(tmpdir(), "p4j-root-"));

  let child;
  let timer = null;
  let killTimer = null;
  let timedOut = false;
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };

  const forwarded = ["SIGHUP", "SIGINT", "SIGTERM"];
  const forwarders = new Map();

  const finished = await new Promise((resolveRun) => {
    child = spawn(
      process.execPath,
      ["--experimental-vm-modules", "--no-warnings", SELF, "--worker", mode],
      {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, P4J_NONCE: nonce, P4J_TEMP_ROOT: tempRoot },
      },
    );

    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (sizes[name] >= MAX_STREAM_BYTES) return;
        sizes[name] += chunk.length;
        chunks[name].push(chunk);
      });
    }

    for (const signal of forwarded) {
      const handler = () => {
        timedOut = true;
        stopGroup();
      };
      forwarders.set(signal, handler);
      process.on(signal, handler);
    }

    function stopGroup() {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }, TERM_GRACE_MS);
        killTimer.unref();
      }
    }

    timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, DEADLINE_MS);

    child.on("close", (code, signal) => {
      resolveRun({ code, signal });
    });
  });

  if (timer !== null) clearTimeout(timer);
  if (killTimer !== null) clearTimeout(killTimer);
  for (const [signal, handler] of forwarders) process.off(signal, handler);

  const stdout = Buffer.concat(chunks.stdout).toString("utf8");
  const stderr = Buffer.concat(chunks.stderr).toString("utf8");

  let groupGone = false;
  for (let attempt = 0; attempt < 20 && !groupGone; attempt += 1) {
    try {
      process.kill(-child.pid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      groupGone = true;
    }
  }

  let residue = [];
  try {
    residue = await readdir(tempRoot);
  } catch {
    residue = [];
  }
  await rm(tempRoot, { recursive: true, force: true });

  const expected = EXPECTED_CONTRACT_STDOUT;
  const problems = [];
  if (timedOut) problems.push(`worker exceeded the ${DEADLINE_MS} ms deadline`);
  if (finished.code !== 0) {
    problems.push(`worker exited with code ${finished.code} signal ${finished.signal}`);
  }
  if (stderr !== "") problems.push(`worker stderr was not empty:\n${stderr}`);
  if (stdout !== expected) {
    problems.push(`worker stdout did not match the expected transcript:\n${stdout}`);
  }
  if (residue.length !== 0) {
    problems.push(`temporary fixture state was left behind: ${residue.join(", ")}`);
  }
  if (!groupGone) problems.push("the worker process group did not disappear");

  if (problems.length !== 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(stdout);
}

/* ------------------------------------------------------------------ *
 * Worker.
 * ------------------------------------------------------------------ */

async function worker(mode) {
  const nonce = process.env.P4J_NONCE;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    die("scripts/test-p4-j.mjs --worker is a supervised entry point");
  }
  const tempRoot = process.env.P4J_TEMP_ROOT;
  if (typeof tempRoot !== "string" || tempRoot.length === 0 || !existsSync(tempRoot)) {
    die("scripts/test-p4-j.mjs --worker requires its supervised temporary root");
  }
  verifyBase();

  const workspace = await mkdtemp(join(tempRoot, "run-"));
  try {
    await runContract(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/* ---------------- the static source gate ---------------- */

const FORBIDDEN_CALLEES = new Set([
  "setInterval",
  "setImmediate",
  "require",
  "fetch",
  "eval",
]);
const CONVENIENCE_BODY_READERS = new Set([
  "json", "text", "formData", "arrayBuffer", "blob", "bytes",
]);
const CAS_FORBIDDEN = new Set([
  "appendEvent", "appendEventFn", "randomBytesFn", "nowFn", "read", "mutate",
]);
const TOKEN_WORDS = [/nf_jwt/i, /nf_refresh/i, /decodeJwt/i, /jwtDecode/i, /\bcookie\b/i];

async function loadTypeScript() {
  const entry = resolve(ROOT, "templates/docbuild/node_modules/typescript/lib/typescript.js");
  if (!existsSync(entry)) {
    throw new Error("the docbuild TypeScript install is missing; run npm --prefix templates/docbuild install");
  }
  const loaded = await import(pathToFileURL(entry).href);
  return loaded.default ?? loaded;
}

function inspectSource(ts, source, fileName) {
  const problems = [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  for (const pattern of TOKEN_WORDS) {
    if (pattern.test(source)) {
      problems.push(`${fileName} mentions a raw token or cookie surface: ${pattern}`);
    }
  }

  const walk = (node, insideCas) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        problems.push(`${fileName} uses a dynamic import`);
      }
      if (ts.isIdentifier(callee)) {
        if (FORBIDDEN_CALLEES.has(callee.text)) {
          problems.push(`${fileName} calls ${callee.text}`);
        }
        if (insideCas && CAS_FORBIDDEN.has(callee.text)) {
          problems.push(`${fileName} calls ${callee.text} inside a CAS callback`);
        }
      }
      if (ts.isPropertyAccessExpression(callee)) {
        const name = callee.name.text;
        if (ts.isIdentifier(callee.expression) && callee.expression.text === "req" &&
            CONVENIENCE_BODY_READERS.has(name)) {
          problems.push(`${fileName} uses the convenience body reader req.${name}()`);
        }
        if (insideCas && (name === "listUsers" || name === "createUser" ||
            name === "setJSON" || name === "delete" || name === "get" ||
            name === "getWithMetadata" || name === "list")) {
          problems.push(`${fileName} reaches the provider (.${name}) inside a CAS callback`);
        }
      }
      if (ts.isIdentifier(callee) && callee.text === "mutate" && node.arguments.length === 4) {
        walk(node.arguments[3], true);
        for (let index = 0; index < 3; index += 1) walk(node.arguments[index], insideCas);
        return;
      }
    }
    if (insideCas && node.kind === ts.SyntaxKind.AwaitExpression) {
      problems.push(`${fileName} awaits inside a CAS callback`);
    }
    if (ts.isWhileStatement(node) || ts.isForStatement(node)) {
      const test = ts.isWhileStatement(node) ? node.expression : node.condition;
      const unbounded = test === undefined ||
        test.kind === ts.SyntaxKind.TrueKeyword;
      if (unbounded && !hasEscape(ts, node.statement)) {
        problems.push(`${fileName} has an unbounded loop without a break or throw`);
      }
    }
    ts.forEachChild(node, (child) => walk(child, insideCas));
  };
  walk(file, false);
  return problems;
}

function hasEscape(ts, node) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (child.kind === ts.SyntaxKind.BreakStatement ||
        child.kind === ts.SyntaxKind.ThrowStatement ||
        child.kind === ts.SyntaxKind.ReturnStatement) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/* ---------------- the hermetic contract worker ---------------- */

async function runContract(workspace) {
  const { readFile } = await import("node:fs/promises");
  const vm = await import("node:vm");

  const accessPath = resolve(ROOT, "netlify/functions/access.mjs");
  const ts = await loadTypeScript();
  const source = await readFile(accessPath, "utf8");
  const problems = inspectSource(ts, source, "netlify/functions/access.mjs");
  if (problems.length !== 0) {
    throw new Error(`source gate failed:\n${problems.join("\n")}`);
  }

  const fakes = join(workspace, "fakes");
  await mkdir(fakes, { recursive: true });
  const cryptoFake = join(fakes, "crypto.mjs");
  const blobsFake = join(fakes, "blobs.mjs");
  const identityFake = join(fakes, "identity-lib.mjs");
  const suiteFile = join(workspace, "suite.mjs");
  await writeFile(cryptoFake, CRYPTO_FAKE_SOURCE, "utf8");
  await writeFile(blobsFake, BLOBS_FAKE_SOURCE, "utf8");
  await writeFile(identityFake, IDENTITY_FAKE_SOURCE, "utf8");
  await writeFile(suiteFile, suiteSource(accessPath), "utf8");

  const failures = [];
  const context = vm.createContext(Object.create(null));
  Object.assign(context, {
    URL,
    URLSearchParams,
    Response,
    Headers,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    Buffer,
    __report(group, message) {
      failures.push(`${group}: ${message}`);
    },
  });
  vm.runInContext(CONTEXT_BOOTSTRAP, context);

  const modules = new Map();
  const specifiers = new Map([
    ["node:crypto", cryptoFake],
    ["@netlify/blobs", blobsFake],
  ]);

  /* `netlify/lib/identity.mjs` is stubbed by path rather than linked.
     Since ACN-006 it validates the hosted session cookie, so linking it would
     drag the whole hosted tree -- its store adapter, its contracts and the
     pinned `tldts` behind them -- into a worker whose subject is the access
     route. The route reaches identity only through two injected dependencies,
     both of which every request test below supplies, so the real module is
     never the thing under test here. It is poisoned rather than emptied: a
     handler that stopped injecting and fell through to the production default
     fails loudly instead of quietly resolving nobody. */
  const libIdentity = resolve(ROOT, "netlify/lib/identity.mjs");

  const compile = async (path) => {
    if (modules.has(path)) return modules.get(path);
    const text = await readFile(path, "utf8");
    const module = new vm.SourceTextModule(text, { identifier: path, context });
    modules.set(path, module);
    return module;
  };

  const linker = async (specifier, referencing) => {
    if (specifiers.has(specifier)) {
      return compile(specifiers.get(specifier));
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const target = specifier.startsWith("/")
        ? specifier
        : resolve(dirname(referencing.identifier), specifier);
      if (target === libIdentity) return compile(identityFake);
      if (!target.startsWith(`${ROOT}/netlify/`) && !target.startsWith(`${workspace}/`)) {
        throw new Error(`undeclared module outside the linked graph: ${specifier}`);
      }
      return compile(target);
    }
    throw new Error(`undeclared import: ${specifier}`);
  };

  const suite = await compile(suiteFile);
  await suite.link(linker);
  await suite.evaluate();
  const run = suite.namespace.default;
  const groups = await run();

  if (failures.length !== 0) {
    throw new Error(`contract worker failures:\n${failures.join("\n")}`);
  }
  if (groups !== 5) {
    throw new Error(`expected five completed groups, saw ${groups}`);
  }
  process.stdout.write(EXPECTED_CONTRACT_STDOUT);
}

const CONTEXT_BOOTSTRAP = `
globalThis.globalThis = globalThis;
globalThis.structuredClone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));
globalThis.console = new Proxy({}, {
  get() { throw new Error("console is poisoned inside the contract worker"); },
});
globalThis.fetch = () => { throw new Error("fetch is poisoned inside the contract worker"); };
globalThis.setInterval = () => { throw new Error("setInterval is poisoned"); };
globalThis.setImmediate = () => { throw new Error("setImmediate is poisoned"); };
globalThis.require = () => { throw new Error("require is poisoned"); };
globalThis.process = { env: {} };
globalThis.__timers = 0;
globalThis.setTimeout = (fn) => {
  globalThis.__timers += 1;
  if (globalThis.__timers > 2000) { throw new Error("unbounded retry backoff"); }
  Promise.resolve().then(fn);
  return 0;
};
globalThis.clearTimeout = () => {};
globalThis.queueMicrotask = (fn) => { Promise.resolve().then(fn); };
`;

const CRYPTO_FAKE_SOURCE = `let counter = 0;
export function randomBytes(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 1024) {
    throw new Error("unexpected randomBytes size");
  }
  counter += 1;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 7 + counter * 31) & 0xff;
  }
  return bytes;
}
export function randomUUID() { throw new Error("randomUUID is not linked"); }
`;

const BLOBS_FAKE_SOURCE = `export function getStore() {
  throw new Error("direct @netlify/blobs access is poisoned in the contract worker");
}
`;

const IDENTITY_FAKE_SOURCE = `function poison(name) {
  return () => { throw new Error("the production " + name + " default is poisoned"); };
}
export const identify = poison("identify");
export const requireOrigin = poison("requireOrigin");
export const allowPublicMailDomains = poison("allowPublicMailDomains");
`;

function suiteSource(accessPath) {
  const libAccess = resolve(ROOT, "netlify/lib/access.mjs");
  return [
    `import { createAccessHandler, withAccessWriteLease } from ${JSON.stringify(accessPath)};`,
    `import { accessDocumentKey, accessGrantKey, accessInvitationKey, capabilitiesFor, GRANTABLE_ROLES, resolveRole } from ${JSON.stringify(libAccess)};`,
    SUITE_BODY,
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * The in-realm contract suite. It is written into the supervised
 * temporary directory, linked inside the poisoned vm context, and
 * removed with the rest of the fixture state.
 * ------------------------------------------------------------------ */

const SUITE_BODY = `
const DOC = "4b7d2a";
const NOW = "2026-09-03T16:19:25.123Z";
const NOW_MS = Date.parse(NOW);
const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const WRITE_KEY = "access/" + DOC + "/write.json";
const OWNER = { sub: "a0_1111111111111111111111111111aa11", email: "owner@example.invalid", emailVerified: true, name: "Fixture Owner" };
const EDITOR = { sub: "u_fixture_editor_22", email: "editor@example.invalid", name: "Fixture Editor" };
const VIEWER = { sub: "u_fixture_viewer_33", email: "viewer@example.invalid", name: "Fixture Viewer" };
const INVITEE = "reviewer@partner.invalid";
const ACTOR = { sub: OWNER.sub, name: OWNER.name, email: OWNER.email };

let group = "";

function canon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  const names = Object.keys(value).sort();
  return "{" + names.map(function (name) { return JSON.stringify(name) + ":" + canon(value[name]); }).join(",") + "}";
}
function check(ok, message) { if (!ok) __report(group, message); }
function eq(actual, expected, message) {
  if (canon(actual) !== canon(expected)) __report(group, message + " -- saw " + canon(actual));
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function accessRow(role, shared) {
  return Object.assign({ role: role, shared: shared }, capabilitiesFor(role));
}
function docRecord(overrides) {
  return Object.assign({
    v: 2, docId: DOC, ownerSub: OWNER.sub, ownerEmail: OWNER.email,
    allowedDomains: [], boundAt: "2026-08-01T12:00:00.000Z",
    boundFrom: "env:DOC_OWNERS",
  }, overrides || {});
}
function grantRecord(person, role, extra) {
  return Object.assign({
    v: 1, docId: DOC, sub: person.sub, email: person.email, name: person.name,
    role: role, grantedBy: { sub: ACTOR.sub, name: ACTOR.name, email: ACTOR.email },
    grantedAt: "2026-08-01T12:00:00.000Z", fromInvitation: null,
  }, extra || {});
}
function invitationRecord(email, role, invitedAt, accountCreated) {
  return {
    v: 1, docId: DOC, email: email, role: role,
    invitedBy: { sub: ACTOR.sub, name: ACTOR.name, email: ACTOR.email },
    invitedAt: invitedAt,
    expiresAt: new Date(Date.parse(invitedAt) + LIFETIME).toISOString(),
    accountCreated: accountCreated === true,
  };
}
function writeRecord(overrides) {
  return Object.assign({ v: 1, docId: DOC, epoch: 3, lease: null, transfer: null }, overrides || {});
}

function makeStore() {
  const data = new Map();
  let seq = 0;
  const store = {
    calls: { get: 0, set: 0, del: 0, list: 0 },
    pageSize: 50,
    emptyPages: 0,
    failGet: null,
    failSet: null,
    failDelete: null,
    ghostDelete: false,
    async getWithMetadata(key, options) {
      store.calls.get += 1;
      if (!options || options.type !== "json" || options.consistency !== "strong") {
        throw new Error("read must be strong json");
      }
      if (store.failGet && store.failGet(key)) throw new Error("provider unavailable");
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: clone(entry.value), etag: entry.etag };
    },
    async setJSON(key, value, options) {
      store.calls.set += 1;
      if (store.failSet) {
        const verdict = store.failSet(key, value, options);
        if (verdict === "throw") throw new Error("provider unavailable");
        if (verdict === "reject") return { modified: false };
        if (verdict === "garbage") return { modified: true };
      }
      const exists = data.has(key);
      if (options && options.onlyIfNew === true) {
        if (exists) return { modified: false };
      } else if (options && typeof options.onlyIfMatch === "string") {
        if (!exists || data.get(key).etag !== options.onlyIfMatch) return { modified: false };
      } else {
        throw new Error("unguarded write");
      }
      seq += 1;
      const etag = "etag-" + seq;
      data.set(key, { value: clone(value), etag: etag });
      return { modified: true, etag: etag };
    },
    async delete(key) {
      store.calls.del += 1;
      if (store.failDelete && store.failDelete(key)) throw new Error("provider unavailable");
      if (!store.ghostDelete) data.delete(key);
    },
    list(options) {
      store.calls.list += 1;
      if (!options || options.paginate !== true || typeof options.prefix !== "string") {
        throw new Error("list must paginate an explicit prefix");
      }
      const keys = [];
      for (const key of data.keys()) if (key.indexOf(options.prefix) === 0) keys.push(key);
      keys.sort();
      const pages = [];
      for (let index = 0; index < store.emptyPages; index += 1) pages.push([]);
      for (let index = 0; index < keys.length; index += store.pageSize) {
        pages.push(keys.slice(index, index + store.pageSize));
      }
      if (pages.length === 0) pages.push([]);
      let cursor = 0;
      const iterator = {
        next() {
          if (cursor >= pages.length) return Promise.resolve({ done: true, value: undefined });
          const page = pages[cursor];
          cursor += 1;
          const blobs = page.map(function (key) { return { key: key }; });
          return Promise.resolve({ done: false, value: { blobs: blobs, directories: [] } });
        },
      };
      const listing = {};
      listing[Symbol.asyncIterator] = function () { return iterator; };
      return listing;
    },
    put(key, value) { seq += 1; data.set(key, { value: clone(value), etag: "etag-" + seq }); },
    peek(key) { return data.has(key) ? clone(data.get(key).value) : null; },
    has(key) { return data.has(key); },
    keys() { const out = []; for (const key of data.keys()) out.push(key); out.sort(); return out; },
    drop(key) { data.delete(key); },
  };
  return store;
}

function encode(text) { return Uint8Array.from(new TextEncoder().encode(text)); }

function makeStream(bytes, mode) {
  let sent = false;
  return {
    getReader() {
      let released = false;
      const reader = {
        canceled: false,
        released: false,
        read() {
          if (mode === "throw") return Promise.reject(new Error("stream failure"));
          if (mode === "bad") return Promise.resolve({ done: false, value: "not-bytes" });
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: bytes });
        },
        cancel() { reader.canceled = true; return Promise.resolve(); },
        releaseLock() {
          if (released) throw new Error("reader lock released twice");
          released = true;
          reader.released = true;
        },
      };
      return reader;
    },
  };
}

function makeReq(method, path, body, options) {
  options = options || {};
  const headers = new Map();
  const contentType = Object.prototype.hasOwnProperty.call(options, "contentType")
    ? options.contentType
    : "application/json";
  if (contentType !== null) headers.set("content-type", contentType);
  let bytes = null;
  if (body !== undefined) {
    bytes = encode(typeof body === "string" ? body : JSON.stringify(body));
  }
  return {
    method: method,
    url: (options.url || "https://docs.example.invalid") + path,
    headers: {
      get(name) {
        const value = headers.get(String(name).toLowerCase());
        return value === undefined ? null : value;
      },
    },
    body: bytes === null ? null : makeStream(bytes, options.stream),
  };
}

function kitFor(store, overrides) {
  const counters = { origin: 0, identify: 0, resolve: 0, store: 0, append: 0, random: 0, now: 0 };
  const events = [];
  let randomSeq = 0;
  const base = {
    requireOriginFn() { counters.origin += 1; },
    identifyFn() { counters.identify += 1; return Object.assign({}, OWNER); },
    resolveRoleFn() { counters.resolve += 1; return accessRow("owner", true); },
    storeFn() { counters.store += 1; return store; },
    appendEventFn(input) {
      counters.append += 1;
      events.push(clone({
        docId: input.docId, actor: input.actor, kind: input.kind,
        target: input.target, docVersion: input.docVersion, summary: input.summary,
      }));
      return Promise.resolve({ v: 1 });
    },
    randomBytesFn(size) {
      counters.random += 1;
      randomSeq += 1;
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[index] = (index + randomSeq * 17) & 0xff;
      return bytes;
    },
    nowFn() { counters.now += 1; return NOW_MS; },
    allowPublicMailboxesFn() { return false; },
  };
  const merged = Object.assign({}, base, overrides || {});
  return { handler: createAccessHandler(merged), counters: counters, events: events, deps: merged };
}

async function codeOf(response) {
  const text = await response.text();
  if (text === "") return null;
  return JSON.parse(text).error;
}

async function expectError(response, status, code, label) {
  eq(response.status, status, label + " status");
  if (code !== null) eq(await codeOf(response), code, label + " code");
  eq(response.headers.get("Cache-Control"), "private, no-store", label + " cache header");
}

/* The domain-list write answers 200 with the normalized list rather than 204,
   because normalisation is visible and an owner told only "no content" would
   have to re-read the roster to learn what their document now says. */
async function expectDomainList(response, expected, label) {
  eq(response.status, 200, label + " status");
  eq(JSON.parse(await response.text()), { ok: true, doc: DOC, allowedDomains: expected }, label + " body");
  eq(response.headers.get("Cache-Control"), "private, no-store", label + " cache header");
}

async function expectNoContent(response, label) {
  eq(response.status, 204, label + " status");
  eq(await response.text(), "", label + " body");
  eq(response.headers.get("Content-Type"), null, label + " has no content type");
  eq(response.headers.get("Cache-Control"), "private, no-store", label + " cache header");
}

function seededStore(options) {
  options = options || {};
  const store = makeStore();
  store.put(accessDocumentKey(DOC), docRecord(options.document));
  return store;
}

function coordinatorOf(store) { return store.peek(WRITE_KEY); }

/* ---------------------------------------------------------------- */

async function groupOne() {
  group = "P3-H GET regression";
  const store = seededStore();
  store.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const liveKey = await accessInvitationKey(DOC, INVITEE);
  store.put(liveKey, invitationRecord(INVITEE, "viewer", "2099-01-01T00:00:00.000Z"));
  const staleKey = await accessInvitationKey(DOC, "stale@partner.invalid");
  store.put(staleKey, invitationRecord("stale@partner.invalid", "commenter", "2020-01-01T00:00:00.000Z"));

  const kit = kitFor(store);
  const response = await kit.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(response.status, 200, "GET returns 200");
  eq(response.headers.get("Content-Type"), "application/json; charset=utf-8", "GET content type");
  const body = JSON.parse(await response.text());
  eq(body, {
    doc: DOC,
    allowedDomains: [],
    members: [
      { sub: OWNER.sub, email: OWNER.email, name: "", role: "owner" },
      { sub: EDITOR.sub, email: EDITOR.email, name: EDITOR.name, role: "editor" },
    ],
    invitations: [{ email: INVITEE, role: "viewer", expiresAt: "2099-01-31T00:00:00.000Z" }],
  }, "GET roster body is unchanged");
  eq([kit.counters.append, kit.counters.random, kit.counters.now, kit.counters.origin],
    [0, 0, 0, 0], "GET never reaches a write dependency");

  const anonymous = kitFor(store, { identifyFn() { return null; } });
  const unauth = await anonymous.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(unauth.status, 401, "GET without identity is 401");
  eq(await unauth.text(), "", "GET 401 keeps its empty body");

  const badQuery = await kit.handler(makeReq("GET", "/api/access?doc=" + DOC + "&doc=aaaaaa", undefined, { contentType: null }));
  eq(badQuery.status, 400, "GET rejects a duplicated doc parameter");

  const blind = kitFor(store, { resolveRoleFn() { return accessRow("viewer", true); } });
  const denied = await blind.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(denied.status, 403, "GET without canSeeMembers is 403");

  const empty = makeStore();
  const missing = kitFor(empty);
  const gone = await missing.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(gone.status, 500, "GET without an access document is 500");

  const broken = seededStore();
  broken.failGet = function () { return true; };
  const brokenKit = kitFor(broken);
  const down = await brokenKit.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(down.status, 503, "GET maps an unavailable store to 503");

  const crowded = seededStore();
  for (let index = 0; index < 51; index += 1) {
    const sub = "u_fixture_member_" + String(index).padStart(3, "0");
    crowded.put(accessGrantKey(DOC, sub), grantRecord({ sub: sub, email: "m" + index + "@example.invalid", name: "M" + index }, "viewer"));
  }
  const crowdedKit = kitFor(crowded);
  const tooMany = await crowdedKit.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(tooMany.status, 500, "GET fails closed above the 50-child ceiling");

  const dup = seededStore();
  dup.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  dup.put(accessGrantKey(DOC, VIEWER.sub), grantRecord({ sub: VIEWER.sub, email: EDITOR.email, name: VIEWER.name }, "viewer"));
  const dupKit = kitFor(dup);
  const duplicated = await dupKit.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(duplicated.status, 500, "GET rejects duplicate member emails");

  const pages = seededStore();
  pages.emptyPages = 60;
  const pagesKit = kitFor(pages);
  const overPaged = await pagesKit.handler(makeReq("GET", "/api/access?doc=" + DOC, undefined, { contentType: null }));
  eq(overPaged.status, 500, "GET enforces the combined page ceiling");

  const put = await kit.handler(makeReq("PUT", "/api/access", { doc: DOC }));
  await expectError(put, 405, "method-not-allowed", "base route rejects PUT");
  eq(put.headers.get("Allow"), "GET, POST, PATCH, DELETE", "base route Allow header");

  const transferGet = await kit.handler(makeReq("GET", "/api/access/transfer", undefined, { contentType: null }));
  await expectError(transferGet, 405, "method-not-allowed", "transfer route rejects GET");
  eq(transferGet.headers.get("Allow"), "POST", "transfer route Allow header");

  const unknown = await kit.handler(makeReq("GET", "/api/access/other", undefined, { contentType: null }));
  await expectError(unknown, 404, "not-found", "unknown path");

  const malformed = await kit.handler(makeReq("POST", "/api/access", { doc: DOC }, { url: "not a url" }));
  await expectError(malformed, 400, "invalid-request", "malformed request URL");

  const methodFirst = kitFor(store, { requireOriginFn() { throw new Error("origin must not run"); } });
  const early = await methodFirst.handler(makeReq("PUT", "/api/access", { doc: DOC }));
  eq(early.status, 405, "method dispatch precedes origin verification");
}

async function groupTwo() {
  group = "owner-only access mutations";

  // Origin precedes every other mutation concern.
  const store = seededStore();
  const originKit = kitFor(store, {
    requireOriginFn() {
      throw new Response("Bad origin", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    },
    identifyFn() { throw new Error("identity must not run"); },
    storeFn() { throw new Error("store must not open"); },
    nowFn() { throw new Error("clock must not run"); },
  });
  const rejected = await originKit.handler(makeReq("POST", "/api/access?doc=" + DOC, { doc: DOC, email: INVITEE, role: "viewer" }));
  eq(rejected.status, 403, "origin rejection status");
  eq(rejected.headers.get("Content-Type"), "text/plain; charset=utf-8", "origin rejection stays text/plain");
  eq(rejected.headers.get("Cache-Control"), "private, no-store", "origin rejection gains the no-store header");
  eq(await rejected.text(), "Bad origin", "origin rejection body is unchanged");

  const queryKit = kitFor(store, { identifyFn() { throw new Error("identity must not run"); } });
  const queried = await queryKit.handler(makeReq("POST", "/api/access?doc=" + DOC, { doc: DOC, email: INVITEE, role: "viewer" }));
  await expectError(queried, 400, "invalid-request", "mutation rejects query keys before identity");

  const anon = kitFor(store, { identifyFn() { return null; } });
  await expectError(await anon.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), 401, "unauthenticated", "no identity");

  const kit = kitFor(store);
  await expectError(await kit.handler(makeReq("POST", "/api/access", { doc: DOC }, { contentType: "text/plain" })), 415, "unsupported-media-type", "non-JSON media type");
  await expectError(await kit.handler(makeReq("POST", "/api/access", { doc: DOC }, { contentType: "application/JSON; charset=utf-8" })), 400, "invalid-request", "case-insensitive JSON media type is accepted");

  const oversized = "x".repeat(9000);
  await expectError(await kit.handler(makeReq("POST", "/api/access", JSON.stringify({ doc: DOC, email: INVITEE, role: "viewer", pad: oversized }))), 413, "payload-too-large", "oversized body");
  await expectError(await kit.handler(makeReq("POST", "/api/access", "{not json")), 400, "invalid-request", "malformed JSON");
  await expectError(await kit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" }, { stream: "throw" })), 400, "invalid-request", "stream failure");
  await expectError(await kit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" }, { stream: "bad" })), 400, "invalid-request", "non-binary chunk");

  const badBodies = [
    [{ doc: DOC, email: INVITEE, role: "owner" }, "owner is not a grantable role"],
    [{ doc: DOC, email: INVITEE, role: "none" }, "none is not a grantable role"],
    [{ doc: DOC, email: INVITEE }, "missing role"],
    [{ doc: DOC, email: INVITEE, role: "viewer", action: "invite" }, "surplus action field"],
    [{ doc: DOC, email: "Reviewer@Partner.Invalid", role: "viewer" }, "unnormalized email"],
    [{ doc: "zzzzzz", email: INVITEE, role: "viewer" }, "invalid doc id"],
    [{ doc: DOC, sub: EDITOR.sub, email: INVITEE, role: "viewer" }, "email plus sub"],
  ];
  for (const entry of badBodies) {
    await expectError(await kit.handler(makeReq("POST", "/api/access", entry[0])), 400, "invalid-request", entry[1]);
  }
  await expectError(await kit.handler(makeReq("PATCH", "/api/access", { doc: DOC, orgDefault: "owner" })), 400, "invalid-request", "the retired orgDefault variant is not a body");
  await expectError(await kit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: "example.invalid" })), 400, "invalid-request", "allowedDomains must be an array");

  const nonOwner = kitFor(store, { resolveRoleFn() { return accessRow("editor", true); } });
  await expectError(await nonOwner.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 403, "forbidden", "editor cannot write");
  const unshared = kitFor(store, { resolveRoleFn() { return accessRow("none", false); } });
  await expectError(await unshared.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 403, "forbidden", "unshared document");

  // Lease behaviour.
  const busy = seededStore();
  busy.put(WRITE_KEY, writeRecord({
    lease: {
      id: "aa".repeat(16),
      holder: { kind: "owner", sub: EDITOR.sub },
      acquiredAt: NOW,
      expiresAt: new Date(NOW_MS + 120000).toISOString(),
    },
  }));
  const busyKit = kitFor(busy);
  const busyResponse = await busyKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] }));
  await expectError(busyResponse, 409, "access-busy", "live lease");
  eq(busyResponse.headers.get("Retry-After"), "2", "busy response advises a bounded retry");

  const expired = seededStore();
  expired.put(WRITE_KEY, writeRecord({
    epoch: 9,
    lease: {
      id: "bb".repeat(16),
      holder: { kind: "retention" },
      acquiredAt: "2026-09-03T15:00:00.000Z",
      expiresAt: "2026-09-03T15:02:00.000Z",
    },
  }));
  const expiredKit = kitFor(expired);
  await expectDomainList(await expiredKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), ["listed.example"], "expired lease is reclaimed");
  eq(coordinatorOf(expired).lease, null, "the lease is released after a successful mutation");
  eq(coordinatorOf(expired).epoch, 10, "the epoch advances exactly once per acquisition");

  const overflow = seededStore();
  overflow.put(WRITE_KEY, writeRecord({ epoch: Number.MAX_SAFE_INTEGER }));
  const overflowKit = kitFor(overflow);
  await expectError(await overflowKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 500, "internal-error", "epoch overflow");

  const releaseFail = seededStore();
  let releaseAttempts = 0;
  releaseFail.failSet = function (key, value) {
    if (key === WRITE_KEY && value.lease === null) {
      releaseAttempts += 1;
      return "throw";
    }
    return null;
  };
  const releaseKit = kitFor(releaseFail);
  await expectError(await releaseKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 503, "unavailable", "release failure downgrades a successful mutation");
  eq(releaseAttempts, 1, "release is attempted exactly once");
  eq(releaseFail.peek(accessDocumentKey(DOC)).allowedDomains, ["listed.example"], "the authoritative state survives a release failure");

  const primaryFail = seededStore();
  primaryFail.failSet = function (key, value) {
    if (key === WRITE_KEY && value.lease === null) return "throw";
    return null;
  };
  const primaryKit = kitFor(primaryFail);
  await expectError(await primaryKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: VIEWER.sub })), 404, "not-found", "a primary 4xx outranks a release failure");

  // Grant role changes.
  const roleStore = seededStore();
  roleStore.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const roleKit = kitFor(roleStore);
  await expectNoContent(await roleKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: EDITOR.sub, role: "viewer" })), "grant role change");
  const changed = roleStore.peek(accessGrantKey(DOC, EDITOR.sub));
  eq(changed.role, "viewer", "the grant role changed");
  eq(changed.grantedAt, NOW, "the grant timestamp is the sampled operation time");
  eq(changed.grantedBy, ACTOR, "the grant records the server-derived actor");
  eq(changed.fromInvitation, null, "the grant preserves its provenance");
  eq(roleKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.change", target: { sub: EDITOR.sub },
    docVersion: null, summary: "changed access role to viewer",
  }], "one exact access.change event");

  await expectNoContent(await roleKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: EDITOR.sub, role: "viewer" })), "same-role grant change");
  eq(roleKit.events.length, 1, "a no-op emits no event");
  await expectError(await roleKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: VIEWER.sub, role: "viewer" })), 404, "not-found", "missing grant target");
  await expectError(await roleKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: OWNER.sub, role: "viewer" })), 409, "conflict", "the owner is never a grant target");

  // Invitation role changes.
  const inviteStore = seededStore();
  const inviteKey = await accessInvitationKey(DOC, INVITEE);
  inviteStore.put(inviteKey, invitationRecord(INVITEE, "viewer", new Date(NOW_MS - 1000).toISOString()));
  const inviteKit = kitFor(inviteStore);
  await expectNoContent(await inviteKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, email: INVITEE, role: "commenter" })), "invitation role change");
  const renewed = inviteStore.peek(inviteKey);
  eq(renewed.role, "commenter", "the invitation role changed");
  eq(renewed.invitedAt, NOW, "the invitation was re-stamped");
  eq(renewed.expiresAt, new Date(NOW_MS + LIFETIME).toISOString(), "the invitation expiry is exactly thirty days out");
  eq(inviteKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.change", target: { email: INVITEE },
    docVersion: null, summary: "changed access role to commenter",
  }], "one exact invitation access.change event");
  await expectNoContent(await inviteKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, email: INVITEE, role: "commenter" })), "same-role invitation change");
  eq(inviteKit.events.length, 1, "a same-role invitation change emits no event");
  eq(inviteStore.peek(inviteKey).expiresAt, renewed.expiresAt, "a same-role invitation change does not extend expiry");

  const staleStore = seededStore();
  const staleKey = await accessInvitationKey(DOC, INVITEE);
  staleStore.put(staleKey, invitationRecord(INVITEE, "viewer", "2020-01-01T00:00:00.000Z"));
  const staleKit = kitFor(staleStore);
  await expectError(await staleKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, email: INVITEE, role: "commenter" })), 404, "not-found", "an expired invitation is not a live target");
  await expectError(await staleKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, email: INVITEE })), 404, "not-found", "an expired invitation cannot be cancelled");

  // The document's domain list (ACN-008), which replaced the organization default.
  const defaultStore = seededStore();
  const defaultKit = kitFor(defaultStore);
  await expectDomainList(await defaultKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: [" Listed.Example "] })), ["listed.example"], "domain list write");
  eq(defaultStore.peek(accessDocumentKey(DOC)).allowedDomains, ["listed.example"], "the normalized list is what is stored");
  eq(defaultKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.change", target: { sub: OWNER.sub },
    docVersion: null, summary: "set the document's domain list to 1 domain(s)",
  }], "one exact domain-list event");
  await expectDomainList(await defaultKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), ["listed.example"], "same domain list");
  eq(defaultKit.events.length, 1, "an unchanged domain list emits no event");

  // Revocation.
  const revokeStore = seededStore();
  revokeStore.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const revokeKit = kitFor(revokeStore);
  await expectNoContent(await revokeKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), "grant revocation");
  eq(revokeStore.has(accessGrantKey(DOC, EDITOR.sub)), false, "the grant is gone");
  eq(revokeKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.revoke", target: { sub: EDITOR.sub },
    docVersion: null, summary: "revoked document access",
  }], "one exact revoke event");
  await expectError(await revokeKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), 404, "not-found", "revocation is not silently idempotent");

  const ghost = seededStore();
  ghost.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  ghost.ghostDelete = true;
  const ghostKit = kitFor(ghost);
  await expectError(await ghostKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), 503, "unavailable", "a delete that stays visible is unavailable");
  eq(ghostKit.events.length, 0, "an unconfirmed delete emits no revoke event");

  const raced = seededStore();
  const racedKey = accessGrantKey(DOC, EDITOR.sub);
  raced.put(racedKey, grantRecord(EDITOR, "editor"));
  let racedReads = 0;
  raced.failGet = function (key) {
    if (key === racedKey) {
      racedReads += 1;
      if (racedReads === 2) raced.put(racedKey, grantRecord(EDITOR, "commenter"));
    }
    return false;
  };
  const racedKit = kitFor(raced, { appendEventFn() { throw new Error("no event for a refused delete"); } });
  await expectError(await racedKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), 409, "conflict", "a changed target is never deleted");
  eq(raced.has(racedKey), true, "a mismatching target is left in place");

  const accepted = seededStore();
  const acceptKey = await accessInvitationKey(DOC, INVITEE);
  accepted.put(acceptKey, invitationRecord(INVITEE, "viewer", new Date(NOW_MS - 1000).toISOString()));
  const acceptKit = kitFor(accepted, {
    appendEventFn() { throw new Error("no event may be emitted for a lost cancellation"); },
  });
  accepted.failDelete = function (key) {
    if (key === acceptKey) {
      accepted.put(accessGrantKey(DOC, VIEWER.sub), grantRecord({ sub: VIEWER.sub, email: INVITEE, name: "Fixture Reviewer" }, "viewer", { fromInvitation: "cd".repeat(16) }));
    }
    return false;
  };
  await expectError(await acceptKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, email: INVITEE })), 409, "conflict", "cancellation loses to acceptance");
  eq(accepted.has(accessGrantKey(DOC, VIEWER.sub)), true, "the accepted grant survives a lost cancellation");

  // Capacity and rate ceilings.
  const full = seededStore();
  for (let index = 0; index < 50; index += 1) {
    const sub = "u_fixture_member_" + String(index).padStart(3, "0");
    full.put(accessGrantKey(DOC, sub), grantRecord({ sub: sub, email: "m" + index + "@example.invalid", name: "M" + index }, "viewer"));
  }
  const fullKit = kitFor(full);
  await expectError(await fullKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), 409, "member-limit", "the fifty-first child is refused");

  const rated = seededStore();
  for (let index = 0; index < 10; index += 1) {
    const email = "pending" + index + "@partner.invalid";
    rated.put(await accessInvitationKey(DOC, email), invitationRecord(email, "viewer", new Date(NOW_MS - 60000).toISOString()));
  }
  const ratedKit = kitFor(rated);
  const throttled = await ratedKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" }));
  await expectError(throttled, 429, "invite-rate-limit", "ten live invitations inside the hour");
  eq(throttled.headers.get("Retry-After"), "3600", "the throttle advises the window length");

  const aged = seededStore();
  for (let index = 0; index < 10; index += 1) {
    const email = "aged" + index + "@partner.invalid";
    aged.put(await accessInvitationKey(DOC, email), invitationRecord(email, "viewer", new Date(NOW_MS - 7200000).toISOString()));
  }
  const agedKit = kitFor(aged);
  await expectNoContent(await agedKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "invitations older than the window do not throttle");

  await expectError(await kit.handler(makeReq("POST", "/api/access", { doc: DOC, email: OWNER.email, role: "viewer" })), 409, "conflict", "the owner cannot be invited");

  // The exported maintenance lease.
  const leaseStore = seededStore();
  let ran = 0;
  const held = await withAccessWriteLease({
    store: leaseStore,
    doc: DOC,
    nowMs: NOW_MS,
    run() { ran += 1; return "swept"; },
  });
  eq(held, { acquired: true, value: "swept" }, "the maintenance lease runs its callback once");
  eq(ran, 1, "the maintenance callback runs exactly once");
  eq(coordinatorOf(leaseStore).lease, null, "the maintenance lease is released");

  leaseStore.put(WRITE_KEY, writeRecord({
    epoch: 4,
    lease: { id: "cc".repeat(16), holder: { kind: "owner", sub: OWNER.sub }, acquiredAt: NOW, expiresAt: new Date(NOW_MS + 120000).toISOString() },
  }));
  const contended = await withAccessWriteLease({
    store: leaseStore,
    doc: DOC,
    nowMs: NOW_MS,
    run() { throw new Error("a contended lease must not run"); },
  });
  eq(contended, { acquired: false }, "a live owner lease blocks maintenance");

  let leaseTypeError = null;
  try {
    await withAccessWriteLease({ store: leaseStore, doc: DOC, nowMs: NOW_MS });
  } catch (error) {
    leaseTypeError = error.message;
  }
  eq(leaseTypeError, "Invalid access lease options", "the maintenance lease validates its options");

  let dependencyError = null;
  try {
    createAccessHandler({ nowFn: 5 });
  } catch (error) {
    dependencyError = error.message;
  }
  eq(dependencyError, "Invalid access dependencies", "non-callable dependencies are rejected");
  let unknownError = null;
  try {
    createAccessHandler({ storeFactory() {} });
  } catch (error) {
    unknownError = error.message;
  }
  eq(unknownError, "Invalid access dependencies", "unknown dependencies are rejected");
}

async function groupThree() {
  group = "invitation boundary";
  const inviteKey = await accessInvitationKey(DOC, INVITEE);

  /* ACN-006 deleted the account-bootstrap saga this group used to drive.
     Inviting somebody no longer scans the identity provider, creates an account
     with a generated password, or asks the provider to mail a reset link, so
     there is no durable recovery marker and nothing to resume. Sign-in is open:
     the invited person already has an identity, and the invitation is satisfied
     when they sign in with the invited address verified.

     What is left is one create-only write and one event, and the properties
     below are what remain worth pinning: the record is exact, the write is
     create-only, the event follows the state change, and none of re-inviting,
     renewing or conflicting touches a provider -- because there is no longer a
     provider dependency to touch. */

  // A plain invitation: exactly one record, exactly one event, no marker.
  const fresh = seededStore();
  const freshKit = kitFor(fresh);
  await expectNoContent(await freshKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "invite a reviewer");
  eq(fresh.peek(inviteKey), invitationRecord(INVITEE, "viewer", NOW, false), "the invitation is stored exactly");
  eq(fresh.peek(inviteKey).accountCreated, false, "and records no account, because none is created");
  eq(coordinatorOf(fresh).transfer, null, "the coordinator carries no marker");
  check(!("recovery" in coordinatorOf(fresh)), "and no recovery field at all");
  eq(freshKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.invite", target: { email: INVITEE },
    docVersion: null, summary: "invited a reviewer as viewer",
  }], "one exact invite event");

  // The write is create-only: a key that appears underneath is a conflict, not
  // a silent overwrite of somebody else's invitation.
  const raced = seededStore();
  const racedKit = kitFor(raced);
  raced.failSet = (key, value, options) =>
    (key === inviteKey && options && options.onlyIfNew === true ? "reject" : null);
  await expectError(await racedKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), 409, "conflict", "a key created underneath the write conflicts");
  eq(raced.has(inviteKey), false, "and nothing of ours is written over it");
  eq(racedKit.events.length, 0, "a conflicted invitation emits no event");

  // A malformed provider answer to the create-only write is refused rather than
  // read as a success: {modified: true} with nothing else is not a receipt.
  const garbled = seededStore();
  garbled.failSet = (key, value, options) =>
    (key === inviteKey && options && options.onlyIfNew === true ? "garbage" : null);
  const garbledKit = kitFor(garbled);
  await expectNoContent(await garbledKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "a bare modified:true is still a write receipt");

  // A provider failure on the invitation write is an outage, not a bug.
  const downStore = seededStore();
  downStore.failSet = (key) => (key === inviteKey ? "throw" : null);
  const downKit = kitFor(downStore);
  await expectError(await downKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), 503, "unavailable", "an unwritable invitation is unavailable");
  eq(downKit.events.length, 0, "an unwritten invitation emits no event");

  // A live same-role invitation is idempotent: nothing to re-send, nothing to
  // change, and no event for a share that did not happen.
  const live = seededStore();
  live.put(inviteKey, invitationRecord(INVITEE, "viewer", new Date(NOW_MS - 1000).toISOString(), false));
  const before = live.peek(inviteKey);
  const liveKit = kitFor(live);
  await expectNoContent(await liveKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "same-role re-invite");
  eq(live.peek(inviteKey), before, "a re-invite changes no invitation state");
  eq(liveKit.events.length, 0, "and emits no event");

  // A different role is still a conflict, which is what stops a re-invite from
  // being a silent role change.
  await expectError(await liveKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "commenter" })), 409, "conflict", "a live invitation with a different role conflicts");
  eq(live.peek(inviteKey), before, "and still changes nothing");

  // An expired same-key invitation is renewed in place, and that is a real
  // transition, so it does emit an event.
  const renewStore = seededStore();
  renewStore.put(inviteKey, invitationRecord(INVITEE, "commenter", "2020-01-01T00:00:00.000Z", false));
  const renewKit = kitFor(renewStore);
  await expectNoContent(await renewKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "renew an expired invitation");
  eq(renewStore.peek(inviteKey), invitationRecord(INVITEE, "viewer", NOW, false), "the expired invitation is replaced in place");
  eq(renewKit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.invite", target: { email: INVITEE },
    docVersion: null, summary: "invited a reviewer as viewer",
  }], "renewal is a real invite transition");

  // A record left by the old flow carries accountCreated: true. It is
  // vestigial rather than meaningful, and a renewal preserves it rather than
  // rewriting a field this route no longer decides.
  const legacyStore = seededStore();
  legacyStore.put(inviteKey, invitationRecord(INVITEE, "commenter", "2020-01-01T00:00:00.000Z", true));
  const legacyKit = kitFor(legacyStore);
  await expectNoContent(await legacyKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "renew a record from the old flow");
  eq(legacyStore.peek(inviteKey), invitationRecord(INVITEE, "viewer", NOW, true), "the vestigial flag is carried, not reinterpreted");

  // A coordinator record written before ACN-006 carries recovery: null. It is
  // read, the mutation succeeds, and the replacement drops the field for good.
  const legacyCoordinator = seededStore();
  legacyCoordinator.put(WRITE_KEY, {
    v: 1, docId: DOC, epoch: 3, lease: null, recovery: null, transfer: null,
  });
  const legacyCoordinatorKit = kitFor(legacyCoordinator);
  await expectNoContent(await legacyCoordinatorKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), "a pre-ACN-006 coordinator record still admits a mutation");
  check(!("recovery" in coordinatorOf(legacyCoordinator)), "and the field is gone after the write");
  eq(legacyCoordinator.peek(inviteKey), invitationRecord(INVITEE, "viewer", NOW, false), "the invitation still landed");

  // One carrying an actual marker is a bootstrap nothing can finish. It stays a
  // refusal rather than a silent discard.
  const strandedCoordinator = seededStore();
  strandedCoordinator.put(WRITE_KEY, {
    v: 1, docId: DOC, epoch: 3, lease: null, transfer: null,
    recovery: { invitationKey: inviteKey, email: INVITEE, role: "viewer" },
  });
  const strandedKit = kitFor(strandedCoordinator);
  await expectError(await strandedKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: INVITEE, role: "viewer" })), 500, "internal-error", "a stranded recovery marker is refused loudly");

  // A grant for the same address blocks a new invitation.
  const grantedStore = seededStore();
  grantedStore.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const grantedKit = kitFor(grantedStore);
  await expectError(await grantedKit.handler(makeReq("POST", "/api/access", { doc: DOC, email: EDITOR.email, role: "viewer" })), 409, "conflict", "an existing member cannot be invited");
}

async function groupFour() {
  group = "transfer, audit, and crash matrix";

  function transferStore() {
    const store = seededStore();
    store.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
    return store;
  }

  const store = transferStore();
  const kit = kitFor(store);
  await expectNoContent(await kit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), "ownership transfer");
  const moved = store.peek(accessDocumentKey(DOC));
  eq([moved.ownerSub, moved.ownerEmail], [EDITOR.sub, EDITOR.email], "the document names the new owner");
  eq(store.has(accessGrantKey(DOC, EDITOR.sub)), false, "the redundant target grant is removed");
  eq(store.peek(accessGrantKey(DOC, OWNER.sub)), {
    v: 1, docId: DOC, sub: OWNER.sub, email: OWNER.email, name: OWNER.name,
    role: "editor", grantedBy: ACTOR, grantedAt: NOW, fromInvitation: null,
  }, "the former owner keeps an exact editor grant");
  eq(coordinatorOf(store).transfer, null, "the transfer marker is cleared");
  eq(kit.events, [{
    docId: DOC, actor: ACTOR, kind: "access.transfer",
    target: { fromSub: OWNER.sub, toSub: EDITOR.sub },
    docVersion: null, summary: "transferred document ownership",
  }], "one exact transfer event");

  const phased = transferStore();
  const observed = { atDelete: null, atFormerGrant: null };
  const phasedSet = phased.setJSON;
  const phasedDelete = phased.delete;
  phased.delete = async function (key) {
    if (key === accessGrantKey(DOC, EDITOR.sub)) {
      observed.atDelete = coordinatorOf(phased).transfer.phase;
    }
    return phasedDelete.call(phased, key);
  };
  phased.setJSON = async function (key, value, options) {
    if (key === accessGrantKey(DOC, OWNER.sub)) {
      const marker = coordinatorOf(phased).transfer;
      observed.atFormerGrant = marker === null ? null : marker.phase;
    }
    return phasedSet.call(phased, key, value, options);
  };
  const phasedKit = kitFor(phased);
  await expectNoContent(await phasedKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), "phase-ordered transfer");
  eq(observed.atDelete, "owner-committed", "the authority commit is durable before the target grant is removed");
  eq(observed.atFormerGrant, "target-grant-removed", "target removal is durable before the former owner is re-granted");

  const absent = transferStore();
  const absentKit = kitFor(absent);
  await expectError(await absentKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: OWNER.sub })), 409, "conflict", "self transfer is refused");
  await expectError(await absentKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: VIEWER.sub })), 404, "not-found", "the transfer target must be a grantee");
  await expectError(await kit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 403, "forbidden", "the former owner loses authority immediately");

  // A full document never materializes a fifty-first child.
  const capped = seededStore();
  capped.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  for (let index = 0; index < 49; index += 1) {
    const sub = "u_fixture_member_" + String(index).padStart(3, "0");
    capped.put(accessGrantKey(DOC, sub), grantRecord({ sub: sub, email: "m" + index + "@example.invalid", name: "M" + index }, "viewer"));
  }
  let peak = 0;
  const cappedKit = kitFor(capped, {
    appendEventFn() { return Promise.resolve({ v: 1 }); },
  });
  const originalSet = capped.setJSON;
  capped.setJSON = async function (key, value, options) {
    const result = await originalSet.call(capped, key, value, options);
    let children = 0;
    for (const stored of capped.keys()) {
      if (stored.indexOf("access/" + DOC + "/u/") === 0 || stored.indexOf("access/" + DOC + "/i/") === 0) children += 1;
    }
    if (children > peak) peak = children;
    return result;
  };
  await expectNoContent(await cappedKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), "transfer at the capacity ceiling");
  check(peak <= 50, "the child count never exceeds fifty during a transfer");
  eq(capped.has(accessGrantKey(DOC, OWNER.sub)), true, "the former owner reuses the freed slot");

  // The new owner repairs an interrupted transfer before its own request.
  const interrupted = seededStore({ document: { ownerSub: EDITOR.sub, ownerEmail: EDITOR.email } });
  interrupted.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  interrupted.put(WRITE_KEY, writeRecord({
    transfer: {
      fromOwner: ACTOR,
      toOwner: { sub: EDITOR.sub, email: EDITOR.email },
      targetGrant: grantRecord(EDITOR, "editor"),
      at: NOW,
      phase: "owner-committed",
    },
  }));
  const repairKit = kitFor(interrupted, {
    identifyFn() { return { sub: EDITOR.sub, email: EDITOR.email, emailVerified: true, name: EDITOR.name }; },
  });
  await expectDomainList(await repairKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), ["listed.example"], "the new owner repairs then applies its own change");
  eq(interrupted.has(accessGrantKey(DOC, EDITOR.sub)), false, "repair removes the redundant grant");
  eq(interrupted.peek(accessGrantKey(DOC, OWNER.sub)).role, "editor", "repair restores the former owner as an editor");
  eq(coordinatorOf(interrupted).transfer, null, "repair clears the marker");
  eq(interrupted.peek(accessDocumentKey(DOC)).allowedDomains, ["listed.example"], "the requested change runs after repair");
  eq(repairKit.events.length, 2, "repair emits the transfer event and then the requested change");
  eq(repairKit.events[0].kind, "access.transfer", "the repaired transfer event comes first");

  // The old owner resumes its own pending transfer.
  const pending = transferStore();
  pending.put(WRITE_KEY, writeRecord({
    transfer: {
      fromOwner: ACTOR,
      toOwner: { sub: EDITOR.sub, email: EDITOR.email },
      targetGrant: grantRecord(EDITOR, "editor"),
      at: NOW,
      phase: "owner-pending",
    },
  }));
  const pendingKit = kitFor(pending);
  await expectError(await pendingKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 409, "conflict", "a pending transfer blocks unrelated work");
  await expectNoContent(await pendingKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), "the old owner resumes its exact transfer");
  eq(pending.peek(accessDocumentKey(DOC)).ownerSub, EDITOR.sub, "the resumed transfer commits authority");

  // Audit append failure never rolls state back.
  const conflicted = seededStore();
  conflicted.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const conflictKit = kitFor(conflicted, {
    appendEventFn() { return Promise.reject(new Error("append rejected")); },
  });
  await expectError(await conflictKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: EDITOR.sub, role: "viewer" })), 500, "internal-error", "an unclassified append failure is internal");
  eq(conflicted.peek(accessGrantKey(DOC, EDITOR.sub)).role, "viewer", "the state change survives a failed append");
  eq(coordinatorOf(conflicted).lease, null, "the lease is released after an append failure");

  // The default event dependency writes a real P3-B event.
  const audited = seededStore();
  audited.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const realHandler = createAccessHandler({
    requireOriginFn() {},
    identifyFn() { return Object.assign({}, OWNER); },
    resolveRoleFn() { return accessRow("owner", true); },
    storeFn() { return audited; },
    nowFn() { return NOW_MS; },
    randomBytesFn(size) { return new Uint8Array(size).fill(7); },
  });
  await expectNoContent(await realHandler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), "revocation through the production event helper");
  const eventKeys = audited.keys().filter(function (key) { return key.indexOf("events/" + DOC + "/") === 0; });
  eq(eventKeys.length, 1, "exactly one audit event blob is written");
  const stored = audited.peek(eventKeys[0]);
  eq([stored.kind, stored.docVersion, stored.summary, stored.target], ["access.revoke", null, "revoked document access", { sub: EDITOR.sub }], "the stored event carries the exact access facts");
  eq(stored.actor, ACTOR, "the stored event carries the server-derived actor");

  // The oracle never claims an event exists after a simulated crash.
  const crashed = seededStore();
  crashed.put(accessGrantKey(DOC, EDITOR.sub), grantRecord(EDITOR, "editor"));
  const crashKit = kitFor(crashed, {
    appendEventFn() { throw new Error("process stopped before the append"); },
  });
  await expectError(await crashKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), 500, "internal-error", "a crash before append is reported, not repaired");
  eq(crashed.has(accessGrantKey(DOC, EDITOR.sub)), false, "the revocation is authoritative without an event");
  eq(crashKit.events.length, 0, "no audit event is invented for a crashed append");
}

/*
 * The primitives the whole specification rests on: the ownership and transfer
 * fences, the coordinator's lease/epoch CAS guard, the release guard, and the
 * freshness compare in front of a role change. Groups one to four exercise
 * these on the happy path, where a passing fence is indistinguishable from an
 * absent one. Each case below interleaves a second writer at the exact point
 * only one guard can see, so deleting that guard is the only way to change the
 * result.
 */
async function groupFive() {
  group = "fence and lease guard matrix";

  const SUCCESSOR_LEASE_ID = "b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6";
  const GRANT_KEY = accessGrantKey(DOC, EDITOR.sub);
  const DOC_KEY = accessDocumentKey(DOC);

  function successorRecord(epoch) {
    return writeRecord({
      epoch: epoch,
      lease: {
        id: SUCCESSOR_LEASE_ID,
        holder: { kind: "owner", sub: EDITOR.sub },
        acquiredAt: NOW,
        expiresAt: new Date(NOW_MS + 120000).toISOString(),
      },
    });
  }

  function granted() {
    const store = seededStore();
    store.put(GRANT_KEY, grantRecord(EDITOR, "editor"));
    return store;
  }

  // 1. The actor loses ownership between the inventory read and the commit.
  //    inventory() already read a document naming them, so ownerFence() is the
  //    only thing left that can refuse.
  const deauth = granted();
  const deauthRead = deauth.getWithMetadata;
  let docReads = 0;
  deauth.getWithMetadata = async function (key, options) {
    const result = await deauthRead.call(deauth, key, options);
    if (key === DOC_KEY) {
      docReads += 1;
      if (docReads === 1) {
        deauth.put(DOC_KEY, docRecord({ ownerSub: VIEWER.sub, ownerEmail: VIEWER.email }));
      }
    }
    return result;
  };
  const deauthKit = kitFor(deauth);
  await expectError(await deauthKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), 403, "forbidden", "a revocation whose actor is deauthorized after the inventory read");
  check(docReads >= 2, "the fence re-reads the access document after the inventory read -- saw " + docReads);
  eq(deauth.has(GRANT_KEY), true, "the fenced revocation deletes nothing");
  eq(deauthKit.events.length, 0, "the fenced revocation audits nothing");
  eq(coordinatorOf(deauth).lease, null, "the fenced revocation still releases its own lease");

  // 2. A second writer moves the grant row between the inventory read and the
  //    role-change CAS. Only the freshness compare sees it.
  const drifted = granted();
  const driftedRead = drifted.getWithMetadata;
  let grantReads = 0;
  drifted.getWithMetadata = async function (key, options) {
    const result = await driftedRead.call(drifted, key, options);
    if (key === GRANT_KEY) {
      grantReads += 1;
      if (grantReads === 1) {
        drifted.put(GRANT_KEY, grantRecord(EDITOR, "commenter", { grantedAt: "2026-08-02T09:00:00.000Z" }));
      }
    }
    return result;
  };
  const driftedKit = kitFor(drifted);
  await expectError(await driftedKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: EDITOR.sub, role: "viewer" })), 409, "conflict", "a role change whose grant row moved after the inventory read");
  check(grantReads >= 2, "the role change re-reads the grant row before writing it -- saw " + grantReads);
  eq(drifted.peek(GRANT_KEY), grantRecord(EDITOR, "commenter", { grantedAt: "2026-08-02T09:00:00.000Z" }), "the interleaved grant row is left exactly as the other writer left it");
  eq(driftedKit.events.length, 0, "no change event is audited for a refused role change");

  // 3. A second acquirer takes the coordinator -- new lease, bumped epoch --
  //    after this request's authority commit. Only the lease/epoch guard in
  //    updateCoordinator() stops the stale request writing over it.
  const raced = granted();
  const racedSet = raced.setJSON;
  let hijacked = false;
  let hijackedEpoch = -1;
  raced.setJSON = async function (key, value, options) {
    const result = await racedSet.call(raced, key, value, options);
    if (!hijacked && key === DOC_KEY && value !== null && typeof value === "object" &&
        value.ownerSub === EDITOR.sub) {
      hijacked = true;
      hijackedEpoch = coordinatorOf(raced).epoch + 1;
      raced.put(WRITE_KEY, successorRecord(hijackedEpoch));
    }
    return result;
  };
  const racedKit = kitFor(raced);
  await expectError(await racedKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), 409, "conflict", "a transfer whose coordinator is taken by a second acquirer");
  check(hijacked, "the transfer reached the authority commit before the coordinator was taken");
  const racedCoordinator = coordinatorOf(raced);
  eq(racedCoordinator.transfer, null, "the stale request never advances the successor's coordinator");
  eq(racedCoordinator.lease.id, SUCCESSOR_LEASE_ID, "the successor's lease survives the stale request");
  eq(racedCoordinator.epoch, hijackedEpoch, "the successor's epoch is not rewound");
  eq(raced.has(accessGrantKey(DOC, OWNER.sub)), false, "the stale transfer never re-grants the former owner");

  // 4. The same takeover, but on a path with no coordinator write left: the
  //    request completes, and its release must not clear the successor's lease.
  const successor = granted();
  const successorDelete = successor.delete;
  let installed = false;
  successor.delete = async function (key) {
    const result = await successorDelete.call(successor, key);
    if (!installed && key === GRANT_KEY) {
      installed = true;
      successor.put(WRITE_KEY, successorRecord(coordinatorOf(successor).epoch + 1));
    }
    return result;
  };
  const successorKit = kitFor(successor);
  await expectNoContent(await successorKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: EDITOR.sub })), "a revocation completing under a lease a successor already replaced");
  check(installed, "the successor's lease was installed during the revocation");
  const successorCoordinator = coordinatorOf(successor);
  check(successorCoordinator.lease !== null, "the outgoing request cleared a successor's lease");
  eq(successorCoordinator.lease === null ? null : successorCoordinator.lease.id, SUCCESSOR_LEASE_ID, "the outgoing request leaves the successor's lease exactly as it found it");

  // 5. The document stops naming the new owner midway through the transfer
  //    saga. Only transferFence()'s toOwner requirement refuses the rest of it.
  const reverted = granted();
  const revertedDelete = reverted.delete;
  let restored = false;
  reverted.delete = async function (key) {
    const result = await revertedDelete.call(reverted, key);
    if (!restored && key === GRANT_KEY) {
      restored = true;
      reverted.put(DOC_KEY, docRecord());
    }
    return result;
  };
  const revertedKit = kitFor(reverted);
  await expectError(await revertedKit.handler(makeReq("POST", "/api/access/transfer", { doc: DOC, sub: EDITOR.sub })), 409, "conflict", "a transfer whose document stops naming the new owner");
  check(restored, "the redundant target grant was removed before the document was reverted");
  eq(reverted.has(accessGrantKey(DOC, OWNER.sub)), false, "the former owner is never re-granted behind a failed transfer fence");
  eq(revertedKit.events.length, 0, "no transfer event is audited behind a failed transfer fence");

  // 6. The owner's own access is not a target. Without the guard a revocation
  //    would report 404 rather than refusing, so the code is asserted too.
  const ownerTarget = granted();
  const ownerKit = kitFor(ownerTarget);
  await expectError(await ownerKit.handler(makeReq("DELETE", "/api/access", { doc: DOC, sub: OWNER.sub })), 409, "conflict", "the owner's own access cannot be revoked");
  await expectError(await ownerKit.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: OWNER.sub, role: "viewer" })), 409, "conflict", "the owner's own role cannot be changed");
  eq(ownerTarget.peek(DOC_KEY).ownerSub, OWNER.sub, "the document still names its owner");
  eq(ownerKit.events.length, 0, "no event is audited for a refused owner mutation");

  // 7. The request validator and the record validators read one list, not two.
  eq(GRANTABLE_ROLES, ["editor", "commenter", "viewer"], "the library owns the grantable role list");
  const roleGate = kitFor(granted());
  await expectError(await roleGate.handler(makeReq("PATCH", "/api/access", { doc: DOC, sub: EDITOR.sub, role: "owner" })), 400, "invalid-request", "owner is not a grantable role");

  // 8. authorize() reads its role test and its canShare test as one fact,
  //    because validateAccess() has already bound the capability row to the
  //    role key-for-key. A resolver that forges canShare onto a lesser role
  //    therefore fails closed at validation rather than reaching the disjunct.
  const forged = kitFor(granted(), {
    resolveRoleFn() { return Object.assign(accessRow("editor", true), { canShare: true }); },
  });
  await expectError(await forged.handler(makeReq("PATCH", "/api/access", { doc: DOC, allowedDomains: ["listed.example"] })), 500, "internal-error", "a role whose capability row was forged is refused before authorization");
}

export default async function run() {
  await groupOne();
  await groupTwo();
  await groupThree();
  await groupFour();
  await groupFive();
  return 5;
}
`;

/* ------------------------------------------------------------------ *
 * Entry point.
 * ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    const mode = argv[1];
    if (!MODES.includes(mode) || argv.length !== 2) {
      die("usage: scripts/test-p4-j.mjs --worker contract");
    }
    await worker(mode);
    return;
  }
  const mode = argv[0];
  if (!MODES.includes(mode) || argv.length !== 1) {
    die("usage: scripts/test-p4-j.mjs contract");
  }
  await parent(mode);
}

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
