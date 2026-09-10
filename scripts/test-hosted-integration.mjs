#!/usr/bin/env node
/**
 * AHU-012 -- the integrated publishing gate.
 *
 *   node scripts/test-hosted-integration.mjs
 *
 * Every producer in this build order has its own regression suite, and every
 * one of them passes against a seam its own ticket controls. AHU-006 proves a
 * client against a protocol fixture. AHU-007, AHU-008 and AHU-009 each prove a
 * handler against a store double. AHU-010 proves a package against a fixture
 * service. Each of those is a true statement about one producer, and the set of
 * them is still not the statement this build order has to make: that the
 * approval a person clicked, the upload an agent sent and the document that
 * person can read afterwards all refer to *the same record and the same
 * account*.
 *
 * That is the claim this runner exists to test, and it is a claim about joins
 * rather than about parts. So the topology below is deliberately assembled out
 * of production pieces, with exactly one thing controlled:
 *
 *   * **Storage is the real producer over a real local runtime.** The record is
 *     written by `hosted/lib/publication-store.mjs` through `@netlify/blobs`
 *     into `BlobsServer`, the provider's own local server -- the same
 *     implementation `netlify dev` runs -- over a private temporary directory.
 *     ETags, `If-Match`, `If-None-Match` and 412 are the provider's, not ours.
 *     This is not the live proof: AHU-013 owns Netlify's production
 *     conditional-write semantics, and no local runtime can stand in for them.
 *     It is the difference between exercising a compare-and-set and exercising
 *     a hand-written map that agrees with the code under test by construction.
 *   * **Every route is the merged handler.** `handleStart`, `handleStatus`,
 *     `handleArtifact`, `handleCancel`, `createBindRoute`, `createReviewRoute`,
 *     `createDecisionRoute`, `createStartRoute`, `createCallbackRoute`,
 *     `createSessionRoute`, `createLogoutRoute`, `createViewerRoute` and
 *     `createDocumentReadRoutes` are imported and dispatched by the `config.path`
 *     each one exports. Nothing here re-implements a route, and a route that
 *     changed its declared path stops being reachable rather than being quietly
 *     shadowed.
 *   * **The client is the installed package.** `templates/docbuild` is packed
 *     with `npm pack` and installed into a directory outside this repository,
 *     and the document is built and published by the installed `docbuild` and
 *     `archon-publish` binaries -- separate processes, exactly as an agent runs
 *     them.
 *   * **The person is a real browser.** A pinned Chromium drives the real
 *     `/publish/authorize` page and the real `/docs/<id>` viewer, and the
 *     renderer it frames is what `renderer/scripts/build.mjs` produced, served
 *     with its own generated `_headers`.
 *   * **Only the identity provider upstream is controlled.** GitHub itself is a
 *     loopback fixture: it validates the client id, the redirect URI, the PKCE
 *     challenge and the client secret, it lets a person pick between two
 *     accounts, and it can be told to fail or to grant an unexpected scope. The
 *     state cookie, the PKCE verifier, the callback handler, the session and
 *     every CSRF check between them are production code.
 *
 * ## What a pass here does not mean
 *
 * It is not a deployed acceptance result and must never be reported as one.
 * Three limits are structural rather than incidental, and the evidence report
 * this runner is paired with states each of them:
 *
 *   * **Two loopback ports are two origins and one site.** `http://127.0.0.1:a`
 *     and `http://localhost:b` are different origins -- which is what the exact
 *     origin comparisons in every handler and in the renderer are about -- but
 *     they are not different *registrable sites*, so the SameSite consequences
 *     of the two-site split are not exercised here. `hosted/lib/config.mjs`
 *     enforces the site rule in production and skips it in `local-test` mode
 *     precisely because a loopback host has no registrable site to compare.
 *     AHU-013 owns that half.
 *   * **`BlobsServer` is the provider's local server, not the provider.**
 *   * **The identity provider is a fixture.** Real GitHub scopes, the real
 *     callback registration and a real account are AHU-013's.
 *
 * ## Output contract
 *
 * One `PASS  hosted integration matrix (chromium <version>; <n> cases)` line on
 * stdout, one `NONCE <hex>` line, exit 0. Anything else is a failure, and the
 * supervisor checks the case count as well as the line: a worker that returned
 * early after four cases would otherwise print a `PASS` that reads exactly like
 * a full run.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const execFileAsync = promisify(execFile);

const PLAYWRIGHT = "playwright@1.55.0";
const ENGINE = "chromium";
const DEADLINE_MS = 900_000;
const INSTALL_DEADLINE_MS = 900_000;
const COMMAND_TIMEOUT_MS = 180_000;
const TERM_GRACE_MS = 2_000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

const TRANSCRIPT = /^PASS {2}hosted integration matrix \(chromium [\w.]+; (\d+) cases\)$/;

/**
 * Every case the worker must complete.
 *
 * Checked by the supervisor rather than trusted. The transcript line is the
 * only thing CI reads, and a worker that threw after the happy path and was
 * caught somewhere forgiving would otherwise print a line that reads like a
 * full run.
 */
const EXPECTED_CASES = 102;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}


/**
 * Anything above `dir` that would give a consumer a source-checkout fallback,
 * or `null` when there is nothing.
 *
 * The builder's own `repoRoot()` walks up from its working directory looking
 * for `templates/base/layout.html` and builds from the first one it finds, and
 * Node's resolution walks up for `node_modules`. A consumer with either above
 * it is not a clean consumer, and the packaged-client half of this runner would
 * pass for the wrong reason. Resolved rather than merely absolute, because
 * `dirname()` walks the spelling of a path and a `TMPDIR` symlinked into a
 * checkout walks a chain of ancestors that does not exist on disk.
 *
 * The twin of this pair lives in `scripts/test-publish-package.mjs`, which
 * makes the same isolation claim about the same package for its own reasons.
 */
function checkoutFallbackAbove(dir) {
  let start;
  try {
    start = realpathSync(dir);
  } catch {
    start = resolve(dir);
  }
  for (let at = start; ; at = dirname(at)) {
    if (existsSync(join(at, "templates", "base", "layout.html"))) {
      return `${at}/templates/base/layout.html`;
    }
    if (existsSync(join(at, "node_modules", "@aiur-team"))) return `${at}/node_modules/@aiur-team`;
    if (dirname(at) === at) return null;
  }
}

/**
 * A temporary directory with no source checkout above it.
 *
 * `os.tmpdir()` honours `TMPDIR`, and a sandbox or a git worktree can easily
 * point it inside this repository. Falling back to the platform default keeps
 * the isolation real rather than turning the assertion that enforces it into
 * something a run can be configured past.
 */
function isolatedTmpdir() {
  const rejected = [];
  for (const candidate of [tmpdir(), "/tmp"]) {
    const fallback = checkoutFallbackAbove(candidate);
    if (fallback === null) return candidate;
    rejected.push(`${candidate} (${fallback} is above it)`);
  }
  die(`no usable temporary directory: ${rejected.join(", ")}; set TMPDIR to one`);
  return "";
}

/* ------------------------------------------------------------------ *
 * Supervisor.
 * ------------------------------------------------------------------ */

/**
 * Install the pinned Playwright and its browser into a temporary root.
 *
 * Pinned rather than floating because the browser claims in this file are
 * claims about an engine at a version, and the transcript names the version it
 * measured. `--ignore-scripts` on the npm install and an explicit
 * `playwright install` afterwards keeps the download an observable step rather
 * than a lifecycle side effect.
 */
function install(root) {
  const browsers = join(root, "browsers");
  const npm = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund",
      "--silent", "--prefix", root, PLAYWRIGHT],
    { stdio: ["ignore", "ignore", "pipe"], timeout: INSTALL_DEADLINE_MS, encoding: "utf8" },
  );
  if (npm.status !== 0) {
    die(`could not install ${PLAYWRIGHT}: ${(npm.stderr || "").split("\n")[0]}`);
  }
  const cli = join(root, "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) die(`the pinned ${PLAYWRIGHT} install produced no CLI`);
  const browserInstall = spawnSync(process.execPath, [cli, "install", ENGINE], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: INSTALL_DEADLINE_MS,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  if (browserInstall.status !== 0) {
    die(`could not install the pinned browser: ${(browserInstall.stderr || "").split("\n")[0]}`);
  }
  return browsers;
}

/**
 * Run the matrix as a detached child under a real deadline.
 *
 * The nonce is the point: the child prints it beside the transcript line, so a
 * parent that saw a `PASS` cannot have been reading a line some other process
 * wrote. The child is detached so `SIGTERM` reaches its whole process group --
 * a browser, a blob server and a packaged-client install that outlived a killed
 * worker would otherwise be left behind.
 */
async function parent() {
  if (!existsSync(join(ROOT, "hosted", "node_modules", "@netlify", "blobs"))) {
    die("hosted/node_modules is missing; run `npm --prefix hosted ci --ignore-scripts --no-audit --no-fund` first");
  }
  const tempRoot = await mkdtemp(join(isolatedTmpdir(), "ahu012-integration-"));
  let stdout = "";
  const problems = [];

  try {
    const browsers = install(tempRoot);
    const nonce = randomBytes(32).toString("hex");
    if (!NONCE_PATTERN.test(nonce)) die("the supervisor produced an unusable nonce");

    let child;
    let timer = null;
    let killTimer = null;
    let timedOut = false;
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };

    const finished = await new Promise((done) => {
      child = spawn(process.execPath, ["--no-warnings", SELF, "--worker"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AHU012_NONCE: nonce,
          AHU012_TEMP_ROOT: tempRoot,
          PLAYWRIGHT_BROWSERS_PATH: browsers,
          NODE_PATH: join(tempRoot, "node_modules"),
        },
      });

      for (const stream of ["stdout", "stderr"]) {
        child[stream].on("data", (chunk) => {
          if (sizes[stream] + chunk.length > MAX_STREAM_BYTES) return;
          sizes[stream] += chunk.length;
          chunks[stream].push(chunk);
        });
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, TERM_GRACE_MS);
      }, DEADLINE_MS);

      child.on("close", (code, signal) => done({ code, signal }));
      child.on("error", (error) => done({ code: null, signal: null, error }));
    });

    if (timer !== null) clearTimeout(timer);
    if (killTimer !== null) clearTimeout(killTimer);

    stdout = Buffer.concat(chunks.stdout).toString("utf8");
    const stderr = Buffer.concat(chunks.stderr).toString("utf8");

    if (timedOut) problems.push(`the matrix did not finish within ${DEADLINE_MS / 1000}s`);
    if (finished.error) problems.push(`the worker could not be started: ${finished.error.message}`);
    if (finished.code !== 0) {
      problems.push(`the worker exited with code ${finished.code} signal ${finished.signal}`);
    }

    const lines = stdout.split("\n").filter((line) => line !== "");
    const transcript = lines.filter((line) => TRANSCRIPT.test(line));
    if (transcript.length !== 1) {
      problems.push(`expected exactly one PASS transcript line, saw ${transcript.length}`);
    } else {
      const cases = Number(TRANSCRIPT.exec(transcript[0])[1]);
      if (cases !== EXPECTED_CASES) {
        problems.push(`the matrix reported ${cases} cases; ${EXPECTED_CASES} were expected`);
      }
    }
    if (!lines.includes(`NONCE ${nonce}`)) {
      problems.push("the worker did not echo the supervisor's nonce");
    }

    if (problems.length > 0) {
      for (const line of stderr.split("\n").slice(-40)) {
        if (line !== "") process.stderr.write(`  ${line}\n`);
      }
      for (const problem of problems) process.stderr.write(`FAIL hosted integration: ${problem}\n`);
      return 1;
    }
  } finally {
    /* Only what this runner created. The blob directory, the packed tarball,
       the consumer install and the browser all live under this one root. */
    spawnSync("rm", ["-rf", tempRoot], { stdio: "ignore" });
  }

  process.stdout.write(`${stdout.split("\n").filter((line) => TRANSCRIPT.test(line))[0]}\n`);
  return 0;
}

/* ------------------------------------------------------------------ *
 * Worker: shared plumbing.
 * ------------------------------------------------------------------ */

/** Every case label the matrix records, in the order it recorded them. */
const CASES = [];
const record = (label) => {
  CASES.push(label);
  return label;
};

function listen(server, host) {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://${host}:${server.address().port}`));
  });
}

/**
 * Close a server without waiting on keep-alive.
 *
 * Chromium holds connections open, so `server.close()` alone never settles and
 * the worker hangs until the supervisor's deadline kills it -- a timeout that
 * reads like a failed assertion.
 */
function trackSockets(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return () =>
    new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    });
}

/** Turn a Node request into the `Request` a Netlify handler receives. */
async function toRequest(nodeRequest, origin) {
  const url = new URL(nodeRequest.url, origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(name, one);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = nodeRequest.method;
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const chunks = [];
    for await (const chunk of nodeRequest) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method, headers, body });
}

/** Write a `Response` back out over Node's HTTP server. */
async function writeResponse(response, nodeResponse, { head = false } = {}) {
  const headers = {};
  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers[name] = value;
  }
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  nodeResponse.writeHead(response.status, headers);
  if (head || response.body === null) {
    nodeResponse.end();
    return;
  }
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

/** Poll a condition rather than sleep for a guessed duration. */
async function waitFor(check, message, { timeout = 20_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((done) => setTimeout(done, interval));
  }
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The `_headers` a Netlify build generated, replayed exactly. */
function parseHeadersFile(text) {
  const headers = [];
  const blocks = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (!line.startsWith(" ")) {
      blocks.push(line.trim());
      continue;
    }
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `malformed _headers line: ${line}`);
    headers.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }
  assert.deepEqual(blocks, ["/*"], "_headers must declare exactly one block, for /*");
  return headers;
}

/**
 * The hosted deployment's own `[[headers]]` block and its one rewrite, read off
 * `hosted/netlify.toml` rather than restated here.
 *
 * Restating them would make this runner agree with a copy of the deployment
 * rather than with the deployment: a policy loosened in the TOML would leave
 * every case in this file green. Reading the file is what makes gate item 7 --
 * "real configured origin/headers are applied" -- a claim about the artifact
 * that is actually deployed.
 *
 * The model is Netlify's: a `[[headers]]` rule decorates responses the CDN
 * serves from the publish directory, and a function's own headers are the
 * function's. So these are applied to static paths only, and a header a
 * function set is never overwritten.
 */
function readDeploymentHeaders() {
  const toml = readFileSync(join(ROOT, "hosted", "netlify.toml"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  const block = toml.match(/\[\[headers\]\]\s*\n\s*for\s*=\s*"\/\*"\s*\n\s*\[headers\.values\]\n([\s\S]*?)(?=\n\[|\n*$)/);
  assert.ok(block, "hosted/netlify.toml must declare a [[headers]] block for /*");
  const values = [...block[1].matchAll(/^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"\s*$/gm)]
    .map(([, name, value]) => [name, value]);
  assert.ok(values.length >= 4, "the hosted /* header block lost its entries");

  const rewrite = toml.match(
    /\[\[redirects\]\]\s*\n\s*from\s*=\s*"([^"]+)"\s*\n\s*to\s*=\s*"([^"]+)"\s*\n\s*status\s*=\s*200/,
  );
  assert.ok(rewrite, "hosted/netlify.toml must rewrite the contract's approval path");
  return { values, rewrite: { from: rewrite[1], to: rewrite[2] } };
}

/* ------------------------------------------------------------------ *
 * Storage: the provider's own local server, with a narrow fault seam.
 * ------------------------------------------------------------------ */

/**
 * Start `BlobsServer` over a private directory and return a `getStore` that
 * points at it.
 *
 * `BlobsServer` is what `@netlify/blobs` ships for local development and what
 * the Netlify CLI runs; it implements the API surface the client speaks,
 * including `If-Match` / `If-None-Match` and the 412 that the whole publication
 * state machine is a compare-and-set against. That is the difference this
 * runner is here to make: `hosted/lib/publication-store.mjs` is exercised
 * against an implementation that does not know what answer the code under test
 * wanted.
 *
 * It is still not the provider. Netlify's production conditional-write
 * semantics are AHU-013's to prove, and the evidence report says so.
 *
 * ## The fault seam
 *
 * `faults` wraps the `Store` object -- the boundary between the real store
 * producer and the real provider client, one call wide. It does not replace a
 * store, does not answer a read from a map and cannot make a write succeed that
 * the provider refused. It can only do the three things a provider does that a
 * happy path never shows:
 *
 *   * `failNextWrite` -- the write never reaches the provider.
 *   * `ambiguousNextWrite` -- the write reaches the provider *and commits*, and
 *     the answer is lost. This is the one that matters: the record exists and
 *     the caller does not know it.
 *   * `failNextRead` -- a read the provider could not answer.
 */
async function startBlobs(directory) {
  const hostedRequire = (specifier) =>
    import(pathToFileURL(join(ROOT, "hosted", "node_modules", specifier)).href);
  const { BlobsServer } = await hostedRequire("@netlify/blobs/dist/server.js");
  const { getStore } = await hostedRequire("@netlify/blobs/dist/main.js");

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("hex");
  const siteID = "ahu012-local-site";
  const server = new BlobsServer({ directory, token, port: 0 });
  const { port } = await server.start();
  const edgeURL = `http://127.0.0.1:${port}`;

  const faults = { failNextWrite: null, ambiguousNextWrite: null, failNextRead: null };
  const calls = [];

  /** One provider call, with the fault seam wrapped around it. */
  const guard = (store, method, kind) => async (...args) => {
    const key = typeof args[0] === "string" ? args[0] : "";
    calls.push({ method, key });
    if (kind === "read" && faults.failNextRead !== null && key.includes(faults.failNextRead)) {
      faults.failNextRead = null;
      throw new Error("provider read failed");
    }
    if (kind === "write" && faults.failNextWrite !== null && key.includes(faults.failNextWrite)) {
      faults.failNextWrite = null;
      throw new Error("provider write failed");
    }
    if (kind === "write" && faults.ambiguousNextWrite !== null && key.includes(faults.ambiguousNextWrite)) {
      faults.ambiguousNextWrite = null;
      /* The write is performed. Only the answer is lost -- which is exactly the
         failure the state machine has to survive without inventing a second
         record or reporting a success it cannot see. */
      await store[method](...args);
      throw new Error("provider write answer lost");
    }
    return store[method](...args);
  };

  /**
   * The one gap in the provider's local server, closed by reading the provider.
   *
   * `BlobsServer` emits an `etag` header on `PUT` and on `LIST`, and not on
   * `GET`. The publication store's whole concurrency story is read-an-ETag then
   * write-if-it-still-matches, so against the local server as shipped every read
   * fails with "storage returned a record with no ETag" and the real producer
   * cannot run at all. That is a limitation of the local runtime rather than of
   * the code under test, and the evidence report names it.
   *
   * What closes it is a second call to the same server: `list` for the exact
   * key, whose `etag` the server computes with the same function `PUT` and the
   * conditional-write comparison use. So the value is the provider's, the
   * comparison is the provider's, and the 412 is the provider's -- nothing here
   * decides whether a write wins. An ETag invented locally, or a compare-and-set
   * performed here, would make every race case in this file a test of this
   * function.
   */
  const withProviderEtag = (store) => async (key, options) => {
    const entry = await store.getWithMetadata(key, options);
    if (entry === null || (typeof entry.etag === "string" && entry.etag !== "")) return entry;
    const listed = await store.list({ prefix: key });
    const found = (listed?.blobs ?? []).find((blob) => blob.key === key);
    return found === undefined ? entry : { ...entry, etag: found.etag };
  };

  const wrap = (store) => {
    const read = withProviderEtag(store);
    const shim = { getWithMetadata: (key, options) => read(key, options) };
    return {
      get: guard(store, "get", "read"),
      getMetadata: guard(store, "getMetadata", "read"),
      getWithMetadata: guard(shim, "getWithMetadata", "read"),
      list: guard(store, "list", "read"),
      set: guard(store, "set", "write"),
      setJSON: guard(store, "setJSON", "write"),
      delete: guard(store, "delete", "write"),
    };
  };

  const options = { siteID, token, edgeURL, uncachedEdgeURL: edgeURL };

  /**
   * The production `getStore` shape, in both spellings its two callers use:
   * `createPublicationStore` passes one options object, `openAuthStore` passes
   * a name and an options object.
   */
  const factory = (input, extra) => {
    const merged = typeof input === "string"
      ? { ...extra, ...options, name: input }
      : { ...input, ...options };
    return wrap(getStore(merged));
  };

  /** A handle configured the way a deployment would be without strong reads. */
  const weakFactory = (input, extra) => {
    const { uncachedEdgeURL, ...weak } = options;
    return typeof input === "string"
      ? getStore({ ...extra, ...weak, name: input })
      : getStore({ ...input, ...weak });
  };

  return {
    getStore: factory,
    weakGetStore: weakFactory,
    faults,
    calls,
    /* How many times the provider was asked to write one key. The difference
       between "the state machine resolved this against what is stored" and "it
       tried again" is a count of writes, and it is the only instrument that can
       see it from outside. */
    writesTo: (key) => calls.filter((one) => one.key === key && one.method === "setJSON").length,
    edgeURL,
    close: () => server.stop(),
  };
}

/* ------------------------------------------------------------------ *
 * The one controlled upstream: a deterministic GitHub OAuth provider.
 * ------------------------------------------------------------------ */

/** The two people this run has. Numeric ids, because C1 keys ownership on them. */
const IDENTITIES = Object.freeze({
  first: Object.freeze({ id: 4210077, login: "fixture-first" }),
  second: Object.freeze({ id: 8830155, login: "fixture-second" }),
});

/**
 * A loopback GitHub.
 *
 * It is a fixture because a real provider cannot be part of an untrusted
 * pull-request build, and it is a *strict* fixture because a permissive one
 * would quietly excuse the application from the checks it is supposed to be
 * performing. It verifies the client id, the redirect URI, the response type,
 * the PKCE challenge method, the client secret and -- on redemption -- that the
 * verifier hashes to the challenge that was presented. A code is single use and
 * is bound to the account the person picked.
 *
 * The `plan` selects the two upstream faults C1 has answers for: an outage,
 * which must reach a truthful unavailable page, and a grant carrying a scope
 * this application never requested, which must be refused rather than used.
 */
/**
 * A certificate for `github.com`, generated into a private temporary directory.
 *
 * The browser has to walk to `https://github.com` for real: the deployment's
 * `form-action 'self' https://github.com` policy is applied to every hop of the
 * sign-in submission, so a redirect naming any other host is refused before it
 * is followed -- and a redirect on a navigation is not something an in-page
 * route interceptor can rewrite. Substituting the provider therefore has to
 * happen below the URL, at name resolution, which means the fixture has to be
 * able to complete a TLS handshake for that name.
 *
 * The key never leaves the run's temporary root, the certificate is for one
 * name, and the browser is the only thing that ever trusts it.
 */
function generateProviderCertificate(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = join(directory, "provider.key");
  const certificate = join(directory, "provider.crt");
  const openssl = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=github.com", "-addext", "subjectAltName=DNS:github.com",
      "-keyout", key, "-out", certificate],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 60_000 },
  );
  if (openssl.status !== 0 || !existsSync(key) || !existsSync(certificate)) {
    die(
      "openssl could not generate the provider certificate this runner needs to stand in for "
      + `github.com: ${(openssl.stderr || openssl.error?.message || "").split("\n")[0]}`,
    );
  }
  return { key: readFileSync(key), cert: readFileSync(certificate) };
}

async function startProvider({ clientId, clientSecret, certificateDir }) {
  const state = {
    plan: "ok",
    account: "first",
    tokenCalls: 0,
    userCalls: 0,
    selectAccountRequests: 0,
    violations: [],
  };
  const codes = new Map();
  const tokens = new Map();

  const violate = (message) => state.violations.push(message);
  /* The consent page echoes back the redirect URI, the state and the challenge
     the application sent. They are this run's own values, but a fixture that
     interpolates them raw is a fixture that teaches the wrong thing and would
     break confusingly on a value containing a quote. */
  const attr = (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const base64url = (input) => createHash("sha256").update(input).digest("base64url");

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const send = (status, type, body, headers = {}) => {
        response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
        response.end(body);
      };

      /* The consent screen. Reached by a real navigation, because the
         application answers the sign-in form with a 303 to the provider and a
         server redirect on a navigation is not something an in-page route
         interceptor can see. */
      if (url.pathname === "/login/oauth/authorize") {
        const query = url.searchParams;
        if (query.get("client_id") !== clientId) violate("authorize: wrong client_id");
        if (query.get("code_challenge_method") !== "S256") violate("authorize: PKCE method is not S256");
        for (const name of ["redirect_uri", "state", "code_challenge"]) {
          if ((query.get(name) ?? "") === "") violate(`authorize: missing ${name}`);
        }
        const redirectUri = query.get("redirect_uri") ?? "";
        const stateValue = query.get("state") ?? "";
        const challenge = query.get("code_challenge") ?? "";
        const selecting = query.get("prompt") === "select_account";

        /* Two buttons and a form, so the account choice is a real navigation a
           person makes and the runner drives it the way a person would. The
           chooser is always rendered rather than auto-submitting when the
           application did not ask to switch: an auto-submit would race the
           runner's click, and whether the application asked to switch is
           asserted directly instead, off `selectAccountRequests`. */
        if (selecting) state.selectAccountRequests += 1;
        const button = (key) =>
          `<button type="submit" name="account" value="${key}" id="pick-${key}">`
          + `Continue as ${IDENTITIES[key].login}</button>`;
        const script = "";
        return send(
          200,
          "text/html; charset=utf-8",
          `<!doctype html><meta charset="utf-8"><title>Sign in to GitHub</title>`
            + `<h1>Authorize Archon</h1>`
            + `<form id="consent" method="GET" action="/login/oauth/decide">`
            + `<input type="hidden" name="redirect_uri" value="${attr(redirectUri)}">`
            + `<input type="hidden" name="state" value="${attr(stateValue)}">`
            + `<input type="hidden" name="code_challenge" value="${attr(challenge)}">`
            + `${button("first")}${button("second")}</form>${script}`,
        );
      }

      if (url.pathname === "/login/oauth/decide") {
        const query = url.searchParams;
        const account = query.get("account") === "second" ? "second" : "first";
        state.account = account;
        const code = `fixture-code-${randomBytes(12).toString("hex")}`;
        codes.set(code, {
          challenge: query.get("code_challenge") ?? "",
          redirectUri: query.get("redirect_uri") ?? "",
          account,
        });
        const target = new URL(query.get("redirect_uri") ?? "");
        target.searchParams.set("code", code);
        target.searchParams.set("state", query.get("state") ?? "");
        return send(302, "text/plain; charset=utf-8", "", { Location: target.toString() });
      }

      if (url.pathname === "/login/oauth/access_token") {
        state.tokenCalls += 1;
        if (state.plan === "outage") return send(503, "text/plain; charset=utf-8", "upstream is down");

        const body = new URLSearchParams(await new Promise((done) => {
          const chunks = [];
          request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
        }));
        if (body.get("client_id") !== clientId) violate("token: wrong client_id");
        if (body.get("client_secret") !== clientSecret) violate("token: wrong client_secret");
        const issued = codes.get(body.get("code") ?? "");
        if (issued === undefined) {
          return send(200, "application/json", JSON.stringify({ error: "bad_verification_code" }));
        }
        /* Single use, and PKCE verified for real: a replayed code and a code
           redeemed without the verifier that produced its challenge are both
           refused here rather than assumed away. */
        codes.delete(body.get("code") ?? "");
        if (body.get("redirect_uri") !== issued.redirectUri) violate("token: redirect_uri did not match");
        if (base64url(body.get("code_verifier") ?? "") !== issued.challenge) {
          return send(200, "application/json", JSON.stringify({ error: "invalid_grant" }));
        }

        const accessToken = `fixture-token-${randomBytes(12).toString("hex")}`;
        tokens.set(accessToken, issued.account);
        return send(
          200,
          "application/json",
          JSON.stringify({
            access_token: accessToken,
            token_type: "bearer",
            /* C1: this application requests no scope, so a grant that carries
               one is a credential belonging to some other app. The `scope` plan
               is what proves the refusal is the application's and not ours. */
            scope: state.plan === "scope" ? "repo" : "",
          }),
        );
      }

      if (url.pathname === "/user") {
        state.userCalls += 1;
        const authorization = request.headers.authorization ?? "";
        const account = tokens.get(authorization.replace(/^Bearer /, ""));
        if (account === undefined) return send(401, "application/json", JSON.stringify({ message: "Bad credentials" }));
        const identity = IDENTITIES[account];
        return send(200, "application/json", JSON.stringify({ id: identity.id, login: identity.login }));
      }

      return send(404, "text/plain; charset=utf-8", "not found");
    })().catch((error) => {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(`provider fault: ${error.message}`);
    });
  });

  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");

  /* The same handler, over TLS, for the one name the browser must resolve. The
     Node side of the exchange -- the token and user calls the callback handler
     makes -- uses the plain loopback origin above; only the browser hop needs
     to be `https://github.com`. */
  const tls = createHttpsServer(generateProviderCertificate(certificateDir), server.listeners("request")[0]);
  const closeTls = trackSockets(tls);
  await new Promise((done) => tls.listen(0, "127.0.0.1", done));
  const tlsPort = tls.address().port;

  return {
    origin,
    tlsPort,
    resolverRule: `MAP github.com 127.0.0.1:${tlsPort}`,
    close: async () => {
      await closeTls();
      await close();
    },
    state,
    identities: IDENTITIES,
  };
}

/**
 * The `fetchImpl` the real callback handler is given.
 *
 * It maps exactly the two provider URLs `hosted/lib/github-oauth.mjs` names and
 * refuses everything else, so a handler that acquired a third provider call --
 * or reached any other host -- fails here rather than silently working against
 * a fixture that answers anything.
 */
function providerFetch(providerOrigin, { GITHUB_TOKEN_URL, GITHUB_USER_URL }) {
  const routes = new Map([
    [GITHUB_TOKEN_URL, `${providerOrigin}/login/oauth/access_token`],
    [GITHUB_USER_URL, `${providerOrigin}/user`],
  ]);
  return (url, init) => {
    const target = routes.get(String(url));
    if (target === undefined) throw new Error(`the callback reached an unexpected upstream: ${url}`);
    return fetch(target, init);
  };
}

/* ------------------------------------------------------------------ *
 * The application origin: every merged route, dispatched by its own path.
 * ------------------------------------------------------------------ */

/**
 * Compile a Netlify `config.path` into a matcher.
 *
 * The routing table below is built from the `config.path` each function module
 * exports rather than from a list written here. That is the difference between
 * testing the deployment's routes and testing a copy of them: a handler that
 * moved, or that started declaring an array of paths, changes what this runner
 * reaches. A path this runner cannot compile is a failure rather than a route
 * that silently never matches.
 */
function compilePath(pattern) {
  assert.match(pattern, /^\/[\w\-/:.]*$/, `unsupported route pattern: ${pattern}`);
  const source = pattern
    .split("/")
    .map((segment) => {
      if (segment === "") return "";
      if (segment.startsWith(":")) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern, regexp: new RegExp(`^${source}/?$`), literal: !pattern.includes(":") };
}

/** The static tree the hosted deployment publishes, and its one rewrite. */
const STATIC_ROOT = join(ROOT, "hosted", "public");

/**
 * The application: the actual handlers, the actual static tree, the actual
 * deployment headers.
 *
 * Two modelling decisions are stated rather than buried, because a reader has
 * to be able to tell what is production and what is this file:
 *
 *   * A `[[headers]]` rule decorates what the CDN serves out of the publish
 *     directory. It is applied here to static paths, and a header a function
 *     already set is never overwritten -- which is what lets `/docs/<id>` carry
 *     the viewer's own `frame-ancestors`-free policy while every static page
 *     carries `frame-ancestors 'none'`.
 *   * The 303 the sign-in route returns names `https://github.com`. A browser
 *     would follow it out to the real provider, so the `Location` is rewritten
 *     onto the loopback provider fixture *in the transport*. The route, the
 *     state, the PKCE challenge and the cookie are untouched; only the host the
 *     browser walks to is controlled. An in-page interceptor cannot do this --
 *     a server redirect on a navigation is not interceptable.
 */
async function startApp({ routes, deployment }) {
  const state = { requests: [], artifactUploads: 0 };
  const staticHeaders = deployment.values;

  const server = createServer((nodeRequest, nodeResponse) => {
    void (async () => {
      const url = new URL(nodeRequest.url, "http://127.0.0.1");
      const method = nodeRequest.method ?? "GET";
      state.requests.push({
        method,
        path: url.pathname,
        search: url.search,
        origin: nodeRequest.headers.origin ?? null,
        cookie: nodeRequest.headers.cookie ?? "",
      });

      /* Routes first: a function path always wins over a file of the same name,
         which is what Netlify does and what keeps `/docs/<id>` a handler rather
         than a 404 from the static tree. */
      for (const route of routes) {
        if (!route.match.regexp.test(url.pathname)) continue;
        const request = await toRequest(nodeRequest, "http://127.0.0.1");
        if (url.pathname.endsWith("/artifact")) state.artifactUploads += 1;
        const response = await route.handler(request);
        return writeResponse(response, nodeResponse, { head: method === "HEAD" });
      }

      /* The static tree, with the deployment's own header block. */
      let pathname = url.pathname === deployment.rewrite.from ? deployment.rewrite.to : url.pathname;
      if (pathname.endsWith("/")) pathname = `${pathname}index.html`;
      const file = join(STATIC_ROOT, pathname);
      if (!file.startsWith(`${STATIC_ROOT}/`) || !existsSync(file) || !statSync(file).isFile()) {
        nodeResponse.writeHead(404, {
          ...Object.fromEntries(staticHeaders),
          "Content-Type": "text/plain; charset=utf-8",
        });
        nodeResponse.end(method === "HEAD" ? undefined : "not found");
        return;
      }
      const body = await readFile(file);
      nodeResponse.writeHead(200, {
        ...Object.fromEntries(staticHeaders),
        "Content-Type": CONTENT_TYPES[pathname.slice(pathname.lastIndexOf("."))] ?? "application/octet-stream",
        "Content-Length": body.length,
      });
      nodeResponse.end(method === "HEAD" ? undefined : body);
    })().catch((error) => {
      nodeResponse.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      nodeResponse.end(`worker fault: ${error.message}`);
    });
  });

  /* A WebSocket handshake is an `upgrade`, not a `request`, so a recorder that
     listens only for `request` cannot see one -- and the hostile artifact tries
     exactly that vector. Without this listener the assertion that nothing
     reached the adversary would be true of a channel it was never watching. */
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    state.requests.push({ method: "UPGRADE", path: url.pathname, search: url.search });
    socket.destroy();
  });

  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close, state };
}

/* ------------------------------------------------------------------ *
 * The renderer origin, and one page on it that is not the renderer.
 * ------------------------------------------------------------------ */

const FORGE_PATH = "/_forge.html";

async function startRenderer() {
  let headers = [];
  let files = new Map();
  const state = { requests: [] };

  let available = true;
  let stalled = null;

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({
      method: request.method,
      path: url.pathname,
      cookie: request.headers.cookie ?? "",
    });
    const common = Object.fromEntries(headers);

    /* Held open, never answered. This is what puts the viewer in the state the
       forged-readiness case needs: the document is fetched and waiting to be
       handed over, and the *real* renderer has not spoken yet. Answering later
       is what lets the same case then prove the genuine handshake still works. */
    if (stalled !== null && url.pathname !== FORGE_PATH) {
      stalled.push({ request, response });
      return;
    }

    /* A renderer deployment that is simply not there. The viewer has to reach a
       readable failure state without having sent anything. */
    if (!available) {
      response.writeHead(503, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      response.end("renderer unavailable");
      return;
    }

    if (url.pathname === FORGE_PATH) {
      /* Served from the *correct* origin, so a message it posts to the viewer
         has a flawless `event.origin` and the wrong `event.source`. That is the
         one forgery an origin comparison alone cannot see, and it announces
         readiness repeatedly so the forged message lands in the window where
         the viewer has a frame and is waiting for it to speak. */
      const script =
        'window.__seen=[];'
        + 'addEventListener("message",function(e){window.__seen.push(String(e.data&&e.data.type));'
        + 'top.postMessage({archonForgeReport:window.__seen.slice()},"*");});'
        + 'setInterval(function(){top.postMessage({type:"archon:ready",v:1},"*");'
        + 'top.postMessage({archonForgeReport:window.__seen.slice()},"*");},50);';
      response.writeHead(200, { ...common, "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>not the renderer</title><script>${script}<\/script>`,
      );
      return;
    }

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const body = files.get(path);
    if (body === undefined) {
      response.writeHead(404, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      ...common,
      "Content-Type": CONTENT_TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(body);
  });

  const close = trackSockets(server);
  const origin = await listen(server, "localhost");
  return {
    origin,
    close,
    state,
    headers: () => headers,
    setAvailable(flag) {
      available = flag;
    },
    stall() {
      stalled = [];
    },
    release() {
      const held = stalled ?? [];
      stalled = null;
      for (const { request, response } of held) server.emit("request", request, response);
    },
    async load(distDir) {
      headers = parseHeadersFile(await readFile(join(distDir, "_headers"), "utf8"));
      files = new Map();
      for (const name of await readdir(distDir)) {
        if (name === "_headers") continue;
        files.set(`/${name}`, await readFile(join(distDir, name)));
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The adversary: it records, and it is never reached.
 * ------------------------------------------------------------------ */

async function startAdversary() {
  const state = { requests: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname, search: url.search });
    response.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    response.end("recorded");
  });
  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close, state };
}

/* ------------------------------------------------------------------ *
 * The client: packed, installed outside this repository, and run.
 * ------------------------------------------------------------------ */

const PACKAGE_DIR = join(ROOT, "templates", "docbuild");
const INSTALLED = Object.freeze({
  docbuild: join("node_modules", ".bin", "docbuild"),
  publish: join("node_modules", ".bin", "archon-publish"),
  skeleton: join("node_modules", "@aiur-team", "docbuild", "dist", "skeleton"),
});
const DOCUMENT_SENTINEL = "sentinel-integration-8b41f0";

/** One child process, with its whole transcript kept for the leak assertion. */
const TRANSCRIPTS = [];
async function run(command, args, { cwd, env = {} } = {}) {
  let stdout = "";
  let stderr = "";
  let status = 0;
  try {
    const done = await execFileAsync(command, args, {
      cwd,
      shell: false,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    stdout = done.stdout;
    stderr = done.stderr;
  } catch (error) {
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    status = typeof error.code === "number" ? error.code : 1;
    if (error.killed) throw new Error(`${command} ${args[0] ?? ""} timed out`);
  }
  TRANSCRIPTS.push({ command, args, stdout, stderr });
  return { status, stdout, stderr };
}

async function runExpecting(code, command, args, options) {
  const done = await run(command, args, options);
  assert.equal(
    done.status,
    code,
    `${command} ${args.join(" ")} exited ${done.status}, expected ${code}\n${done.stderr}`,
  );
  return done;
}

/** The one JSON line `--json` promises on stdout. */
function stdoutJson(done) {
  const lines = done.stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, `expected exactly one stdout line, saw ${lines.length}:\n${done.stdout}`);
  return JSON.parse(lines[0]);
}

/**
 * Pack the real tarball and install it into a directory outside the repository.
 *
 * Outside is asserted rather than assumed: a consumer nested under this
 * checkout would find `templates/base/` through the builder's own repository
 * walk, and every path assertion below would pass for the wrong reason.
 */
async function installClient(tempRoot) {
  if (!existsSync(join(PACKAGE_DIR, "node_modules", "typescript"))) {
    die("templates/docbuild/node_modules is missing; run `npm --prefix templates/docbuild ci --no-audit --no-fund` first");
  }
  const packRoot = join(tempRoot, "pack");
  const consumer = join(tempRoot, "consumer");
  mkdirSync(packRoot, { recursive: true, mode: 0o700 });
  mkdirSync(consumer, { recursive: true, mode: 0o700 });
  assert.ok(!consumer.startsWith(`${ROOT}/`), "the consumer install must live outside this repository");

  await runExpecting(0, "npm", ["pack", "--pack-destination", packRoot, "--silent"], { cwd: PACKAGE_DIR });
  const packed = (await readdir(packRoot)).filter((name) => name.endsWith(".tgz"));
  assert.equal(packed.length, 1, `npm pack produced ${packed.length} tarballs`);

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "archon-integration-consumer", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  await runExpecting(
    0,
    "npm",
    ["install", join(packRoot, packed[0]), "--no-audit", "--no-fund", "--ignore-scripts", "--silent"],
    { cwd: consumer },
  );
  for (const installed of Object.values(INSTALLED)) {
    assert.ok(existsSync(join(consumer, installed)), `the installed package is missing ${installed}`);
  }
  return consumer;
}

/**
 * Build a document with the installed builder, exactly as the packaged skill
 * tells a new user to.
 *
 * The instance directory is named something other than the slug on purpose:
 * the artifact is named after the directory, and a document whose two names
 * agree could not tell the difference.
 */
async function buildDocument(consumer) {
  const instance = "release-notes";
  const instanceDir = join(consumer, instance);
  cpSync(join(consumer, INSTALLED.skeleton), instanceDir, { recursive: true });

  writeFileSync(
    join(instanceDir, "doc.json"),
    `${JSON.stringify(
      {
        id: "b7e214",
        slug: "hosted-upload",
        aliases: [],
        title: "Hosted upload review",
        eyebrow: "Platform · Publishing",
        status: "Draft for review",
        heading: "What the hosted upload path guarantees",
        lede: "One approval, one upload, one reader.",
        meta: { DRI: "A. Consumer", Status: "Drafted", Related: "none" },
        footer: "Hosted upload review · Draft · Internal",
      },
      null,
      2,
    )}\n`,
  );
  const sections = (await readdir(join(instanceDir, "sections"))).sort();
  const sectionIds = [];
  for (const [index, name] of sections.entries()) {
    const id = name.replace(/^\d+-/, "").replace(/\.html$/, "");
    sectionIds.push(id);
    writeFileSync(
      join(instanceDir, "sections", name),
      `<!--\nid: ${id}\nlabel: Section ${index + 1}\nsummary: What section ${index + 1} concludes.\n-->\n`
        + `<!-- body -->\n      <h2>Section ${index + 1}</h2>\n`
        + `      <p>Integration fixture content. ${DOCUMENT_SENTINEL}</p>\n`,
    );
  }

  const built = await runExpecting(0, join(consumer, INSTALLED.docbuild), [instance, "--hosted"], { cwd: consumer });
  const artifact = join(instanceDir, "dist", `${instance}.hosted.html`);
  assert.ok(
    built.stdout.includes(`${instance}/dist/${instance}.hosted.html`),
    `the installed builder did not report the hosted artifact path; it said:\n${built.stdout}`,
  );
  assert.ok(existsSync(artifact), `the installed builder did not write ${artifact}`);

  const html = readFileSync(artifact, "utf8");
  assert.ok(html.includes(DOCUMENT_SENTINEL), "the artifact carries none of the document's own content");
  assert.ok(sectionIds.length >= 2, "the skeleton must give the artifact more than one section to navigate");
  for (const id of sectionIds) {
    assert.ok(html.includes(`href="#${id}"`), `the artifact has no navigation link to #${id}`);
    assert.ok(html.includes(`id="${id}"`), `the artifact has no section #${id} to navigate to`);
  }
  return { artifact, instanceDir, sectionIds, title: "Hosted upload review" };
}

/* ------------------------------------------------------------------ *
 * Browser helpers.
 * ------------------------------------------------------------------ */

/**
 * Refuse every origin this run did not create.
 *
 * `https://github.com` is in the allowed list and resolves, for this browser
 * only, to the loopback provider fixture -- see `providerResolverRule`. The
 * abort rule is what makes that substitution checkable rather than hopeful: any
 * other host fails as a blocked request instead of quietly succeeding on a
 * machine that happens to have a network.
 */
async function refuseTheInternet(context, allowed) {
  await context.route(/.*/, (route) => {
    const url = route.request().url();
    if (allowed.some((origin) => url.startsWith(`${origin}/`) || url === origin)) return route.continue();
    if (url.startsWith("data:") || url.startsWith("about:") || url.startsWith("blob:")) return route.continue();
    return route.abort();
  });
}

/**
 * A browsing context that can reach exactly this run's origins.
 *
 * `ignoreHTTPSErrors` covers the one-name certificate the provider fixture
 * generated for itself. It is a property of this browser context and of nothing
 * else -- no product code, no configuration and no handler is relaxed by it.
 */
async function openContext(world, browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await refuseTheInternet(context, [
    world.app.origin,
    world.renderer.origin,
    world.adversary.origin,
    "https://github.com",
  ]);
  return context;
}

/** The approval page's own status text. */
const statusOf = (page) => page.locator("#status").innerText();

/**
 * Walk one person through the real approval page.
 *
 * Nothing here writes an approval record, mints a session or sets a cookie by
 * hand. The link is opened, the fragment is exchanged by the page's own
 * bootstrap, the sign-in form is submitted, the provider fixture is answered
 * and the decision button is clicked -- which is the only path in this file
 * that can produce an owner.
 */
async function approveInBrowser(page, verificationUrl, { account = "first", decision = "approve" } = {}) {
  await page.goto(verificationUrl);
  await page.waitForFunction(() => location.hash === "", null, { timeout: 20_000 });

  /* The page settles into exactly one of three shapes, and which one it is
     cannot be read the instant the fragment clears -- the bootstrap has a bind
     call and a session call still in flight. Waiting for the settled shape is
     what keeps this from racing; waiting a fixed time would be the same race
     with a longer fuse. */
  const settle = async () => {
    if (await page.locator("#review").isVisible()) return "review";
    if (await page.locator("#signin").isVisible()) return "signin";
    if ((await page.locator("#status").getAttribute("data-tone")) === "error") return "error";
    return null;
  };
  let shape = await waitFor(settle, "the approval page to settle");
  if (shape === "signin") {
    await page.locator("#signin-submit").click();
    await page.locator(`#pick-${account}`).click();
    await page.waitForURL((url) => url.pathname === "/publish/authorize", { timeout: 30_000 });
    shape = await waitFor(settle, "the approval page to settle after signing in");
  }
  assert.equal(
    shape,
    "review",
    `the approval page did not show the review card; it said: ${await statusOf(page)}`,
  );

  const review = {
    title: await page.locator("#title").innerText(),
    size: await page.locator("#size").innerText(),
    userCode: await page.locator("#user-code").innerText(),
    account: await page.locator("#account").innerText(),
  };
  /* The decision route's own status code, captured off the wire.
   *
   * The page's copy is not a safe proxy for it. Every terminal answer -- an
   * approval, a denial, and a refusal such as `state_conflict` -- leaves the
   * review card hidden and a sentence in the status line, and the sentences do
   * not share a vocabulary a test can pattern-match on. Reading the response
   * the page actually got is the difference between "the person was told
   * something" and "the person was told it worked". */
  let decisionStatus = null;
  if (decision !== null) {
    const seen = [];
    const watch = (response) => {
      if (new URL(response.url()).pathname.endsWith("/decision")) seen.push(response.status());
    };
    page.on("response", watch);
    await page.locator(decision === "approve" ? "#approve" : "#deny").click();
    await waitFor(
      async () => (await page.locator("#review").isVisible()) === false,
      "the decision to settle",
    );
    await waitFor(() => seen.length > 0, "the decision response");
    page.off("response", watch);
    decisionStatus = seen[seen.length - 1];
  }
  return { ...review, status: await statusOf(page), decisionStatus };
}

/**
 * Sign in without a pending publication, through the real `/login/` page.
 *
 * This is the page a signed-out document reader is sent to, and its submit
 * button is disabled until its own script has fetched the one-time pre-login
 * binding -- so waiting for the button to enable is waiting for that binding,
 * not for a guessed number of milliseconds.
 */
async function signIn(page, appOrigin, { account = "first", destination = "/publish/authorize" } = {}) {
  await page.goto(`${appOrigin}/login/?destination=${encodeURIComponent(destination)}`);
  const submit = page.locator("#submit");
  await waitFor(async () => !(await submit.isDisabled()), "the sign-in binding to arrive");
  await submit.click();
  await page.locator(`#pick-${account}`).click();
  /* The settled condition is a session, not a URL: the landing page for a
     *failed* sign-in is also on this origin, and waiting for an address would
     accept one. */
  await waitFor(async () => {
    if (!page.url().startsWith(appOrigin)) return false;
    try {
      return (await currentSession(page)).authenticated === true;
    } catch {
      return false;
    }
  }, "the sign-in to produce a session");
}

/* ------------------------------------------------------------------ *
 * Worker: assemble the topology out of merged producers.
 * ------------------------------------------------------------------ */

const CLIENT_ID = "Iv1.integrationclient";
const CLIENT_SECRET = "integration-client-secret-not-a-real-credential";

async function assemble(tempRoot) {
  const hosted = (path) => import(pathToFileURL(join(ROOT, "hosted", path)).href);

  const [
    contracts, configModule, httpModule, identity, publicationsModule, publicationStore, authStoreModule,
    githubOauth, start, status, artifact, cancel, bind, review, decision,
    authStart, authCallback, authLogout, session, viewer, documentRead, documents,
  ] = await Promise.all([
    hosted("lib/contracts.mjs"), hosted("lib/config.mjs"), hosted("lib/http.mjs"),
    hosted("lib/identity.mjs"), hosted("lib/publications.mjs"), hosted("lib/publication-store.mjs"),
    hosted("lib/auth-store.mjs"), hosted("lib/github-oauth.mjs"),
    hosted("functions/publications-start.mjs"), hosted("functions/publications-status.mjs"),
    hosted("functions/publications-artifact.mjs"), hosted("functions/publications-cancel.mjs"),
    hosted("functions/publications-bind.mjs"), hosted("functions/publications-review.mjs"),
    hosted("functions/publications-decision.mjs"), hosted("functions/auth-github-start.mjs"),
    hosted("functions/auth-github-callback.mjs"), hosted("functions/auth-logout.mjs"),
    hosted("functions/session.mjs"), hosted("functions/document-viewer.mjs"),
    hosted("functions/document-read.mjs"), hosted("lib/documents.mjs"),
  ]);
  const rendererBuild = await import(pathToFileURL(join(ROOT, "renderer", "scripts", "build.mjs")).href);

  const blobs = await startBlobs(join(tempRoot, "blobs"));
  const adversary = await startAdversary();
  const renderer = await startRenderer();
  const provider = await startProvider({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    certificateDir: join(tempRoot, "provider-tls"),
  });

  /* Every port has to exist before any configuration can name one, so the
     routing table is a mutable array the server already holds and the handlers
     are pushed into it once the origins are known. */
  const routes = [];
  const deployment = readDeploymentHeaders();
  const app = await startApp({ routes, deployment });

  /* The operator environment, mutable so that C6's publish switch can be turned
     off mid-run the way an operator turns it off: by changing the environment
     the routes read, not by swapping a handler. */
  const env = {
    HOSTED_APP_ORIGIN: app.origin,
    HOSTED_RENDER_ORIGIN: renderer.origin,
    GITHUB_CLIENT_ID: CLIENT_ID,
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    HOSTED_PUBLISH_ENABLED: "true",
  };
  const mode = configModule.LOCAL_TEST;
  const hostedConfig = () => configModule.readHostedConfig(env, { mode });
  const authStore = authStoreModule.openAuthStore({ storeFactory: blobs.getStore });

  /* The real production assembly, with the provider handle pointed at the local
     blob server. `publicationDependencies` is the producer's own function: a
     dependency it stopped setting is a dependency these routes stop getting. */
  const publications = () =>
    publicationsModule.publicationDependencies({ env, getStore: blobs.getStore, mode });
  const browserDeps = () => ({
    config: hostedConfig(),
    store: authStore,
    publications: publications(),
  });
  const authDeps = () => ({ store: authStore, config: hostedConfig() });

  const callbackFetch = providerFetch(provider.origin, githubOauth);
  const bounded = (handler) => httpModule.withErrorBoundary(handler);

  /* Routing is by the `config.path` each module exports. Literal paths are
     sorted ahead of parameterised ones, because `/api/hosted/publications/bind`
     and `/api/hosted/publications/:publicationId/status` are siblings and the
     literal one is the one Netlify matches. */
  const declare = (module, handler) => {
    const declared = module.config?.path;
    assert.ok(declared !== undefined, "a routed function module declared no config.path");
    for (const pattern of Array.isArray(declared) ? declared : [declared]) {
      routes.push({ match: compilePath(pattern), handler });
    }
  };

  declare(start, (request) => start.handleStart(request, publications));
  declare(status, (request) => status.handleStatus(request, publications));
  declare(artifact, (request) => artifact.handleArtifact(request, publications));
  declare(cancel, (request) => cancel.handleCancel(request, publications));
  declare(bind, bind.createBindRoute(browserDeps));
  declare(review, review.createReviewRoute(browserDeps));
  declare(decision, decision.createDecisionRoute(browserDeps));
  declare(authStart, bounded(authStart.createStartRoute(authDeps())));
  declare(
    authCallback,
    bounded(authCallback.createCallbackRoute({ ...authDeps(), fetchImpl: callbackFetch })),
  );
  declare(authLogout, bounded(authLogout.createLogoutRoute(authDeps())));
  declare(session, bounded(session.createSessionRoute({ store: authStore })));
  declare(viewer, bounded(viewer.createViewerRoute(authDeps())));
  /* Rebuilt per request, like every other route. A snapshot taken once at
     startup would make the operator switch unreachable from these routes, and
     the cases that turn publishing off and require an owner's reads to survive
     would then be true of a configuration nothing could change. */
  declare(
    documentRead,
    bounded((request) =>
      documentRead.createDocumentReadRoutes({ store: authStore, publications: publications() })(request)),
  );
  routes.sort((left, right) => Number(right.match.literal) - Number(left.match.literal));

  const rendererDist = join(tempRoot, "renderer-dist");
  const built = await rendererBuild.buildRenderer({
    outDir: rendererDist,
    production: false,
    env: { HOSTED_APP_ORIGIN: app.origin, HOSTED_RENDER_ORIGIN: renderer.origin },
  });
  await renderer.load(rendererDist);

  return {
    app, renderer, adversary, provider, blobs, routes, env, deployment, built, rendererDist,
    modules: {
      contracts, configModule, identity, publicationsModule, publicationStore, authStoreModule,
      githubOauth, documents, start, status, artifact, cancel, viewer, documentRead,
    },
    hostedConfig, authStore, publications,
    async close() {
      await app.close();
      await renderer.close();
      await adversary.close();
      await provider.close();
      await blobs.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Agent-side helpers: the wire protocol, spoken the way a client speaks it.
 * ------------------------------------------------------------------ */

/** One agent request, with the headers C3 says an agent sends and no others. */
async function agentFetch(world, path, { method = "POST", secret = null, body, headers = {} } = {}) {
  const sent = new Headers({ accept: "application/json", ...headers });
  if (secret !== null) sent.set("authorization", `Bearer ${secret}`);
  return fetch(`${world.app.origin}${path}`, { method, headers: sent, body, redirect: "manual" });
}

/** Start a publication over the real route, as an agent would. */
async function startPublication(world, { title, html }) {
  const bytes = Buffer.from(html, "utf8");
  const descriptor = {
    v: 1,
    title,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    contentBytes: bytes.byteLength,
    artifactFormat: "html",
  };
  const response = await agentFetch(world, "/api/hosted/publications", {
    body: JSON.stringify(descriptor),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 201, `start returned ${response.status}`);
  const started = await response.json();
  return { ...started, descriptor, bytes };
}

/** Upload the approved bytes over the real route. */
function uploadArtifact(world, publication, bytes = publication.bytes) {
  return agentFetch(world, `/api/hosted/publications/${publication.publicationId}/artifact`, {
    method: "PUT",
    secret: publication.agentSecret,
    body: bytes,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Poll the real status route. */
function publicationStatus(world, publication) {
  return agentFetch(world, `/api/hosted/publications/${publication.publicationId}/status`, {
    secret: publication.agentSecret,
  });
}

/**
 * Start a publication and walk a person through approving it in a browser.
 *
 * Every matrix below that needs an owned document gets one this way, because
 * this is the only path in the design that can produce one: there is no seam
 * here that writes an approval, and adding one would make the ownership claims
 * in this file claims about the seam.
 */
async function publishThroughBrowser(world, context, { title, html, account = "first" }) {
  const publication = await startPublication(world, { title, html });
  const page = await context.newPage();
  const review = await approveInBrowser(page, publication.verificationUriComplete, { account });
  const uploaded = await uploadArtifact(world, publication);
  assert.equal(uploaded.status, 201, `the artifact upload returned ${uploaded.status}`);
  const receipt = await uploaded.json();
  await page.close();
  /* The browser secret is the fragment of the approval link. It is returned so
     the leak assertion can look for it: it is a capability, and a capability
     nobody searches for is a capability nobody would notice in a log. */
  const browserSecret = publication.verificationUriComplete.split("#")[1] ?? "";
  return { publication, review, receipt, browserSecret };
}

/* ------------------------------------------------------------------ *
 * 1. The whole happy path.
 * ------------------------------------------------------------------ */

/**
 * The renderer frame and the artifact frame inside it.
 *
 * Two levels, because that is the design: the renderer document is same-origin
 * with the renderer so it can compare origins, and the artifact is one level
 * deeper in an opaque-origin sandbox.
 */
async function artifactFrame(page, rendererOrigin) {
  /* Matched on the renderer's exact document URL rather than on its origin.
     Two cases put a *second* page from that origin on this tab -- the forge
     page that impersonates a renderer -- and an origin prefix would find
     whichever came first, then wait forever for a state attribute that page
     never sets. */
  const renderer = await waitFor(
    () => page.frames().find((candidate) => candidate.url() === `${rendererOrigin}/`) ?? null,
    "the renderer frame",
  );
  await waitFor(
    async () => (await renderer.locator("html").getAttribute("data-archon-state")) === "rendered",
    "the renderer to report a rendered artifact",
  );
  const artifact = await waitFor(
    () => renderer.childFrames()[0] ?? null,
    "the sandboxed artifact frame",
  );
  return { renderer, artifact };
}

async function happyPath(world, browser, client) {
  const { app, renderer, provider } = world;
  const stateDir = join(world.tempRoot, "publish-state");
  const env = { ARCHON_PUBLISH_STATE_DIR: stateDir, ARCHON_PUBLISH_SERVICE: "" };
  const publish = join(client.consumer, INSTALLED.publish);

  const before = createHash("sha256").update(readFileSync(client.document.artifact)).digest("hex");

  /* 1. The installed client starts a publication. Exit 10 is the success the
        contract fixes for "a person has not decided yet". */
  const started = stdoutJson(await runExpecting(10, publish, [
    "start",
    "--file", client.document.artifact,
    "--title", client.document.title,
    "--service", app.origin,
    "--local-test",
    "--json",
  ], { cwd: client.consumer, env }));
  assert.deepEqual(
    Object.keys(started).sort(),
    ["nextAction", "requestFile", "serviceOrigin", "state", "userCode", "v", "verificationUrl"],
    "the start command printed fields C5 does not allow it to print",
  );
  assert.equal(started.serviceOrigin, app.origin);
  assert.ok(
    started.verificationUrl.startsWith(`${app.origin}/publish/authorize#`),
    `the verification URL is not the contract's: ${started.verificationUrl}`,
  );
  record("start: installed client opened a publication");

  /* 2. A person approves it, in a browser, on the real page. */
  const context = await openContext(world, browser);
  const page = await context.newPage();
  if (process.env.AHU012_DEBUG === "1") {
    /* The approval link carries the browser secret in its fragment, and a
       diagnostic that printed it would put a live capability in a CI log. */
    const safe = (url) => String(url).split("#")[0];
    page.on("console", (m) => process.stderr.write(`DEBUG console ${m.type()} ${safe(m.text())}\n`));
    page.on("requestfailed", (r) => process.stderr.write(`DEBUG failed ${safe(r.url())} ${r.failure()?.errorText}\n`));
    page.on("response", (r) => process.stderr.write(`DEBUG response ${r.status()} ${safe(r.url())}\n`));
  }
  const review = await approveInBrowser(page, started.verificationUrl);

  assert.equal(review.title, client.document.title, "the approval page showed a different title");
  assert.equal(review.userCode, started.userCode, "the pairing code on screen is not the one the agent printed");
  assert.ok(
    review.account.includes(provider.identities.first.login),
    `the approval page showed "${review.account}", not the signed-in account`,
  );
  assert.match(review.size, /\d/, "the approval page showed no artifact size");
  assert.ok(
    !page.url().includes("#"),
    "the browser secret was still in the address bar after the bootstrap ran",
  );
  record("approve: the real page showed title, size, pairing code and account");

  /* 3. A *separate* client process finds the publication again through its
        request file alone and uploads. */
  const resumed = stdoutJson(await runExpecting(0, publish, [
    "resume", "--request", started.requestFile, "--json",
  ], { cwd: client.consumer, env }));
  assert.equal(resumed.state, "complete");
  assert.deepEqual(
    Object.keys(resumed.result).sort(),
    ["contentBytes", "contentSha256", "documentId", "ownerAccountId", "url"],
    "the receipt carried fields C3 does not allow",
  );
  assert.equal(
    resumed.result.ownerAccountId,
    `gh_${provider.identities.first.id}`,
    "the stored owner is not the canonical numeric GitHub identity of the account that approved",
  );
  assert.equal(resumed.result.contentSha256, before, "the receipt digest is not the artifact's digest");
  assert.equal(resumed.result.url, `${app.origin}/docs/${resumed.result.documentId}`);
  record("upload: a second client process completed the publication");

  /* 4. The durable record, read back through the real store producer. */
  const stored = await world.modules.publicationStore
    .createPublicationStore({ getStore: world.blobs.getStore })
    .read(resumed.result.documentId);
  assert.notEqual(stored, null, "no publication record was written to the store");
  assert.equal(stored.record.state, "complete");
  assert.equal(stored.record.ownerAccountId, resumed.result.ownerAccountId);
  assert.equal(stored.record.descriptor.contentSha256, before);
  assert.equal(
    createHash("sha256").update(Buffer.from(stored.record.html, "utf8")).digest("hex"),
    before,
    "the bytes the store holds do not hash to the digest that was approved",
  );
  record("store: the durable record carries the approved owner, digest and bytes");

  /* 5. The receipt URL opens the owner's shell, and the artifact renders. */
  await page.goto(resumed.result.url);
  const title = page.locator("[data-archon-title]");
  await waitFor(async () => (await title.innerText()) === client.document.title, "the document title");
  const owner = await page.locator("[data-archon-owner]").innerText();
  assert.ok(
    owner.includes(provider.identities.first.login),
    `the shell named "${owner}" rather than the owner`,
  );
  const frames = await artifactFrame(page, renderer.origin);
  await waitFor(
    async () => (await frames.artifact.locator("body").textContent()).includes(DOCUMENT_SENTINEL),
    "the artifact's own content",
  );
  record("read: the receipt URL rendered the owner's real artifact");

  /* 6. Publishing changed nothing on disk. */
  assert.equal(
    createHash("sha256").update(readFileSync(client.document.artifact)).digest("hex"),
    before,
    "publishing modified the source artifact",
  );
  record("retention: the local source artifact is unchanged");

  return { started, resumed, page, context, frames };
}

/* ------------------------------------------------------------------ *
 * Worker entry point.
 * ------------------------------------------------------------------ */

async function worker() {
  const nonce = process.env.AHU012_NONCE ?? "";
  const tempRoot = process.env.AHU012_TEMP_ROOT ?? "";
  if (!NONCE_PATTERN.test(nonce)) die("the worker was started without a supervisor nonce");
  if (tempRoot === "") die("the worker was started without a temporary root");

  const entry = join(tempRoot, "node_modules", "playwright", "index.js");
  const loaded = await import(pathToFileURL(entry).href);
  const playwright = loaded.chromium !== undefined ? loaded : loaded.default;

  const world = { tempRoot, ...(await assemble(tempRoot)) };
  world.tempRoot = tempRoot;

  /* Everything below runs inside this, so a failure anywhere -- including the
     browser launch itself -- still stops five servers and a blob server rather
     than leaving them for the supervisor's process-group kill. */
  let browser = null;
  try {
    /* The browser resolves `github.com` to the provider fixture's TLS listener.
       Nothing else about the browser is relaxed, and the rule names one host. */
    browser = await playwright[ENGINE].launch({
      args: [`--host-resolver-rules=${world.provider.resolverRule}`],
    });

    const consumer = await installClient(tempRoot);
    const document = await buildDocument(consumer);
    record("package: the installed builder produced a navigable hosted artifact");
    const client = { consumer, document };

    const first = await happyPath(world, browser, client);
    await first.context.close();

    await authBinding(world, browser);
    await providerFailures(world, browser);
    await uploadAndReceipt(world, browser);
    const owned = await ownerRead(world, browser);
    await storageAndRaces(world, browser);
    await renderedIsolation(world, browser, client);
    await deploymentConnection(world, owned);
    await operations(world, browser, owned);
    await accessibility(world, browser, owned);
    await owned.ownerContext.close();

    /* Last, and over the whole run: every OAuth round trip any matrix made had
       to carry the contract's client id, redirect URI and PKCE challenge. Read
       here rather than after the auth matrix, because five later matrices sign
       people in too and a check placed earlier would never see them. */
    assert.deepEqual(
      world.provider.state.violations,
      [],
      "the application broke the OAuth request contract",
    );
    assert.ok(world.provider.state.tokenCalls > 0, "no OAuth exchange happened in this run");
    record("auth: every provider round trip carried the contract's client id, redirect and PKCE");

    process.stdout.write(`NONCE ${nonce}\n`);
    process.stdout.write(
      `PASS  hosted integration matrix (chromium ${browser.version()}; ${CASES.length} cases)\n`,
    );
  } finally {
    if (browser !== null) await browser.close();
    await world.close();
  }
}

/* ------------------------------------------------------------------ */

if (process.argv.includes("--worker")) {
  worker().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
} else {
  parent().then((code) => {
    process.exitCode = code;
  });
}

/* ------------------------------------------------------------------ *
 * 2. Auth and account binding.
 * ------------------------------------------------------------------ */

/** One browser-side JSON call, with the page's own cookies and CSRF header. */
function browserJson(page, path, { method = "GET", body = null, headers = {} } = {}) {
  return page.evaluate(async (call) => {
    const response = await fetch(call.path, {
      method: call.method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...call.headers },
      body: call.body === null ? undefined : call.body,
    });
    let parsed = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }, { path, method, body, headers });
}

/** The session the browser is holding, as the app reports it. */
async function currentSession(page) {
  const answer = await browserJson(page, "/api/hosted/session");
  assert.equal(answer.status, 200, "the session route refused the page's own request");
  return answer.body;
}

/**
 * The cookie header this browser context holds for the application.
 *
 * Every cookie in this design carries the `__Host-` prefix, so every one of
 * them is `Secure`. Asking the context for the cookies of an `http://` URL
 * filters exactly those out and hands back an empty list -- which would make a
 * case about a *foreign Origin* pass because the request carried no session at
 * all. So the whole jar is read and filtered by host here, and the result is
 * asserted to be non-empty by the caller.
 */
async function cookieHeader(context, origin) {
  const host = new URL(origin).hostname;
  const cookies = (await context.cookies())
    .filter((cookie) => cookie.domain === host || cookie.domain === `.${host}`);
  assert.notEqual(cookies.length, 0, `the browser context holds no cookies for ${origin}`);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function authBinding(world, browser) {
  const { app, provider } = world;
  const context = await openContext(world, browser);
  const publication = await startPublication(world, {
    title: "Account binding review",
    html: "<!doctype html><title>binding</title><p>binding</p>",
  });

  const page = await context.newPage();
  /* Signing in but not deciding: the review card is the state every case below
     starts from. */
  const first = await approveInBrowser(page, publication.verificationUriComplete, { decision: null });
  assert.ok(first.account.includes(provider.identities.first.login));

  /* 2.1 The visitor changes their mind about which account to publish as. The
         switch is a real form on the real page, and it goes back out through
         the provider with `prompt=select_account`. */
  const beforeSwitch = provider.state.selectAccountRequests;
  await page.locator("#switch-submit").click();
  await page.locator("#pick-second").click();
  await page.waitForURL((url) => url.pathname === "/publish/authorize", { timeout: 30_000 });
  await page.locator("#review").waitFor({ state: "visible", timeout: 30_000 });
  const switched = await page.locator("#account").innerText();
  assert.ok(
    switched.includes(provider.identities.second.login),
    `the review card still named "${switched}" after the account was switched`,
  );
  assert.equal(
    provider.state.selectAccountRequests,
    beforeSwitch + 1,
    "the switch-account form did not ask the provider for an account chooser",
  );
  record("auth: switching accounts mid-review re-binds the review to the new session");

  const session = await currentSession(page);
  assert.equal(session.authenticated, true);
  assert.equal(session.accountId, `gh_${provider.identities.second.id}`);
  const decisionPath = `/api/hosted/publications/${publication.publicationId}/decision`;

  /* 2.2 Approving as the account that is no longer signed in. The displayed
         identity is the visitor's evidence of what they are agreeing to, so a
         decision that names a stale one is refused rather than applied to
         whoever happens to be signed in now. */
  const stale = await browserJson(page, decisionPath, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", displayedAccountId: `gh_${provider.identities.first.id}` }),
    headers: { "content-type": "application/json", "x-archon-csrf": session.csrfToken },
  });
  assert.equal(stale.status, 403, `a stale displayed account was answered ${stale.status}`);
  assert.equal(stale.body?.error?.code, "csrf_failed");
  record("auth: approving a stale displayed identity is refused");

  /* 2.3 The CSRF header, absent and wrong. */
  for (const [label, headers] of [
    ["absent", { "content-type": "application/json" }],
    ["wrong", { "content-type": "application/json", "x-archon-csrf": "not-the-token" }],
  ]) {
    const answer = await browserJson(page, decisionPath, {
      method: "POST",
      body: JSON.stringify({ decision: "approve", displayedAccountId: session.accountId }),
      headers,
    });
    assert.equal(answer.status, 403, `a decision with a ${label} CSRF token was answered ${answer.status}`);
    assert.equal(answer.body?.error?.code, "csrf_failed");
    record(`auth: a decision with a ${label} CSRF token is refused`);
  }

  /* 2.4 A foreign Origin, sent from outside the browser because a page cannot
         forge its own. The session cookie is real and so is the CSRF token; the
         only wrong thing is where the request claims to come from. */
  const cookie = await cookieHeader(context, app.origin);
  const foreign = await fetch(`${app.origin}${decisionPath}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie,
      origin: world.adversary.origin,
      "x-archon-csrf": session.csrfToken,
    },
    body: JSON.stringify({ decision: "approve", displayedAccountId: session.accountId }),
  });
  assert.equal(foreign.status, 403, `a cross-origin decision was answered ${foreign.status}`);
  record("auth: a decision from a foreign Origin is refused");

  /* 2.5 A decision cannot be reached by a method that a link or an image can
         produce. `GET` on the decision route is not an approval. */
  const byGet = await fetch(`${app.origin}${decisionPath}`, {
    method: "GET",
    headers: { accept: "application/json", cookie, origin: app.origin },
  });
  assert.equal(byGet.status, 405, `GET on the decision route was answered ${byGet.status}`);
  record("auth: GET cannot reach a decision");

  /* 2.6 The link's own capability. A visitor whose fragment carries anything
         other than this publication's browser secret is refused at `/bind`,
         which is the one place the secret is ever presented -- so the browser
         never reaches the review card and never holds a binding at all. The
         mutation is one character of the secret, in a fresh context, on the
         real page's own bootstrap. */
  const [fragmentId, fragmentSecret] = new URL(publication.verificationUriComplete).hash
    .slice(1)
    .split(".");
  const lastCharacter = fragmentSecret.slice(-1);
  const mutatedSecret = fragmentSecret.slice(0, -1) + (lastCharacter === "0" ? "1" : "0");
  const mutatedLink =
    `${publication.verificationUriComplete.split("#")[0]}#${fragmentId}.${mutatedSecret}`;

  const wrongContext = await openContext(world, browser);
  const wrongPage = await wrongContext.newPage();
  const binds = [];
  wrongPage.on("response", async (response) => {
    if (!new URL(response.url()).pathname.endsWith("/publications/bind")) return;
    binds.push({ status: response.status(), body: await response.json().catch(() => null) });
  });
  await wrongPage.goto(mutatedLink);
  await waitFor(
    async () => (await wrongPage.locator("#status").getAttribute("data-tone")) === "error",
    "the approval page to refuse a mutated link",
  );
  assert.equal(
    await wrongPage.locator("#review").isVisible(),
    false,
    "a mutated link reached the review card",
  );
  assert.equal(
    await wrongPage.locator("#signin").isVisible(),
    false,
    "a mutated link was offered a sign-in instead of being refused",
  );
  await waitFor(() => binds.length > 0, "the bind answer for a mutated link");
  assert.equal(binds[0].status, 401, `a mutated browser secret was answered ${binds[0].status}`);
  assert.equal(binds[0].body?.error?.code, "invalid_capability");
  record("auth: a link whose browser secret was altered is refused at bind");

  /* 2.7 Possession of a session is not possession of the operation. This
         context signed in through the same real provider, so it holds a valid
         session and a valid CSRF token -- and it never opened the link, so it
         holds no browser binding. Its decision for someone else's publication
         is refused before the account is even considered. */
  const unboundPage = await wrongContext.newPage();
  await signIn(unboundPage, app.origin, { account: "second", destination: "/login/" });
  const unboundSession = await currentSession(unboundPage);
  assert.equal(unboundSession.authenticated, true, "the unbound context has no session to test with");
  const unbound = await browserJson(unboundPage, decisionPath, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", displayedAccountId: unboundSession.accountId }),
    headers: { "content-type": "application/json", "x-archon-csrf": unboundSession.csrfToken },
  });
  assert.equal(unbound.status, 403, `a decision from an unbound session was answered ${unbound.status}`);
  assert.equal(unbound.body?.error?.code, "approval_required");
  record("auth: a signed-in browser that never opened the link cannot decide the publication");

  /* 2.8 And holding a binding is not holding *this* one. This third context
         opened a different publication's link and bound it legitimately, so it
         has both a session and a browser binding -- for someone else's
         operation. The route compares the bound id to the path's id before the
         adapter is reached, which is also the honest answer for a second tab:
         one pending approval per browser is what a single `__Host-` cookie can
         express. */
  const other = await startPublication(world, {
    title: "Another pending publication",
    html: "<!doctype html><title>other</title><p>other</p>",
  });
  const otherContext = await openContext(world, browser);
  const otherPage = await otherContext.newPage();
  await approveInBrowser(otherPage, other.verificationUriComplete, { decision: null });
  const otherSession = await currentSession(otherPage);
  const crossed = await browserJson(otherPage, decisionPath, {
    method: "POST",
    body: JSON.stringify({ decision: "approve", displayedAccountId: otherSession.accountId }),
    headers: { "content-type": "application/json", "x-archon-csrf": otherSession.csrfToken },
  });
  assert.equal(
    crossed.status,
    403,
    `a decision for a publication this browser never bound was answered ${crossed.status}`,
  );
  assert.equal(crossed.body?.error?.code, "approval_required");
  record("auth: a browser bound to one publication cannot decide another");

  /* 2.9 The adapter's own binding check, reached the one way the route cannot
   *     reach it.
   *
   * The browser's proof is an opaque `__Host-` cookie whose operation string
   * lives server-side, so no client can present the state machine with a
   * binding that names this publication under someone else's secret digest --
   * the route refuses an id mismatch first, and a digest mismatch under a
   * matching id is not a thing a browser can construct. The guard inside
   * `decidePublication` is therefore untestable from outside, and this calls the
   * real producer with the real dependencies and the real record and presents
   * exactly that combination. No owner may be fixed.
   *
   * Everything the call is judged against is created here rather than inherited
   * from a case above: its own publication, its own browser bound to that
   * publication through the real page bootstrap, and the record's real digest
   * read back from the real `bindPublication`. A proof whose kill depends on
   * what an earlier case left behind is not a proof, so the three ways this
   * could be refused for a reason other than the guard -- a record that is not
   * pending, a binding malformed in some second way, a digest that happens to
   * match -- are each asserted away before the call, and the rejection is
   * matched on the guard's own message rather than on a code that four other
   * checks in this module also raise.
   */
  const adapter = await startPublication(world, {
    title: "Adapter binding check",
    html: "<!doctype html><title>adapter</title><p>adapter</p>",
  });
  const adapterContext = await openContext(world, browser);
  const adapterPage = await adapterContext.newPage();
  await adapterPage.goto(adapter.verificationUriComplete);
  /* The sign-in offer is the page saying its bootstrap bound this operation:
     the bind call precedes it, and a link that failed to bind is refused
     instead (2.6). */
  await adapterPage.locator("#signin").waitFor({ state: "visible", timeout: 30_000 });

  const adapterSecret = new URL(adapter.verificationUriComplete).hash.slice(1).split(".")[1];
  const realBinding = await world.modules.publicationsModule.bindPublication(
    { publicationId: adapter.publicationId, browserSecret: adapterSecret },
    world.publications(),
  );
  const wrongDigest = "f".repeat(realBinding.browserSecretHash.length);
  assert.match(realBinding.browserSecretHash, /^[0-9a-f]{64}$/, "the record's browser digest is not a stored hash");
  assert.notEqual(realBinding.browserSecretHash, wrongDigest, "the wrong digest is this record's real one");
  const adapterBefore = await publicationStatus(world, adapter);
  assert.equal(
    (await adapterBefore.json()).state,
    "pending",
    "this case's own publication was not pending when the call was made",
  );

  const principal = {
    accountId: `gh_${provider.identities.first.id}`,
    provider: "github.com",
    providerUserId: String(provider.identities.first.id),
    login: provider.identities.first.login,
  };
  await assert.rejects(
    () => world.modules.publicationsModule.decidePublication(
      {
        publicationId: adapter.publicationId,
        /* This publication's id, under a digest that is not its browser
           secret's. Everything else about the binding is well formed. */
        browserBinding: { publicationId: adapter.publicationId, browserSecretHash: wrongDigest },
        principal,
        decision: "approve",
        displayedAccountId: principal.accountId,
      },
      world.publications(),
    ),
    (error) =>
      error.code === "invalid_capability" &&
      error.message === "browser binding does not match this publication",
    "a decision carrying a binding for another secret was accepted",
  );
  const adapterAfter = await publicationStatus(world, adapter);
  assert.equal(
    (await adapterAfter.json()).state,
    "pending",
    "a refused binding fixed an owner anyway",
  );
  record("auth: a binding that names this publication under another secret is refused before any owner is fixed");

  await adapterPage.close();
  await adapterContext.close();
  await otherPage.close();
  await otherContext.close();
  await unboundPage.close();
  await wrongPage.close();
  await wrongContext.close();

  /* Nothing above may have moved the publication off `pending`. */
  const stillPending = await publicationStatus(world, publication);
  assert.equal((await stillPending.json()).state, "pending", "a refused decision changed the state anyway");
  record("auth: every refused decision left the publication pending");

  await page.close();
  await context.close();
  return { publication };
}

/**
 * The upstream faults C1 has answers for, driven through the real callback.
 *
 * Each one is produced by the provider fixture behaving badly rather than by
 * calling a handler with a hand-made argument, so what is being tested is the
 * application's reading of a provider response.
 */
async function providerFailures(world, browser) {
  const { app, provider } = world;

  /* 3.1 A sign-in whose callback URL is captured, then replayed. */
  const context = await openContext(world, browser);
  const page = await context.newPage();
  const callbacks = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/hosted/auth/github/callback") callbacks.push(request.url());
  });
  await signIn(page, app.origin, { destination: "/login/" });
  assert.equal(callbacks.length, 1, `the sign-in produced ${callbacks.length} callbacks`);
  const callbackUrl = callbacks[0];
  const signedIn = await currentSession(page);
  assert.equal(signedIn.authenticated, true, "the sign-in produced no session");

  /* Replayed into the browser that made it. A completed sign-in clears the
     transaction's binding cookie, so this replay is refused at the first line
     of the handler -- it never reaches the store and never reaches the
     provider, which `tokenCalls` records. What this case owns is the *cookie*
     half; the consumed-transaction half is 3.1c below, which replays with the
     cookie still in hand. */
  const tokenCallsBeforeReplay = provider.state.tokenCalls;
  await page.goto(callbackUrl);
  await page.waitForURL(
    (url) => url.pathname === "/login/" && url.searchParams.get("status") !== null,
    { timeout: 30_000 },
  );
  assert.equal(
    new URL(page.url()).searchParams.get("status"),
    "expired",
    "a replayed callback did not land on a truthful refusal",
  );
  /* The refusal must be inert rather than destructive: the session the first
     callback legitimately created is still the session this browser holds, and
     the replay minted no second one. */
  const afterReplay = await currentSession(page);
  assert.equal(afterReplay.authenticated, true);
  assert.equal(afterReplay.accountId, signedIn.accountId);
  assert.equal(
    provider.state.tokenCalls,
    tokenCallsBeforeReplay,
    "the replayed callback was sent on to the provider instead of being refused by the application",
  );
  record("auth: replaying a consumed OAuth callback is refused and changes no session");

  /* Replayed into a browser that never started it: no binding cookie, so the
     state alone buys nothing. */
  const stranger = await openContext(world, browser);
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(callbackUrl);
  await strangerPage.waitForURL(
    (url) => url.pathname === "/login/" && url.searchParams.get("status") !== null,
    { timeout: 30_000 },
  );
  assert.equal(
    (await currentSession(strangerPage)).authenticated,
    false,
    "a replayed callback signed in a browser that never started the transaction",
  );
  record("auth: an OAuth callback replayed into another browser signs nobody in");
  await stranger.close();

  /* 3.1c The replay that still holds the transaction's binding cookie.
   *
   * The two cases above are refused by the *cookie*: a completed sign-in clears
   * `__Host-archon_oauth`, so a second arrival never gets past the first line of
   * the handler. That leaves the record's own single-use guard unowned, and a
   * captured cookie is exactly what an attacker who wanted to redeem the state a
   * second time would have. So the cookie is read out of the jar while the
   * visitor is still on the provider's chooser -- the one moment it legitimately
   * exists -- and the callback is replayed with it afterwards, from outside the
   * browser because a browser cannot re-send a cookie the server has cleared.
   *
   * The refusal it must produce is the application's, not the fixture's: the
   * fixture also issues single-use codes, so `tokenCalls` is what separates the
   * two. The handler consumes the transaction *before* it exchanges the code, so
   * an application holding the guard never reaches the provider at all. */
  const captured = await openContext(world, browser);
  const capturedPage = await captured.newPage();
  const capturedCallbacks = [];
  capturedPage.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/hosted/auth/github/callback") capturedCallbacks.push(request.url());
  });
  await capturedPage.goto(`${app.origin}/login/?destination=%2Flogin%2F`);
  await waitFor(
    async () => !(await capturedPage.locator("#submit").isDisabled()),
    "the sign-in binding for the captured-cookie replay",
  );
  await capturedPage.locator("#submit").click();
  await capturedPage.locator("#pick-first").waitFor({ state: "visible", timeout: 30_000 });

  /* Mid-flight: the transaction is open and its binding cookie is live. */
  const oauthCookie = (await captured.cookies())
    .find((cookie) => cookie.name === "__Host-archon_oauth");
  assert.notEqual(oauthCookie, undefined, "the sign-in set no OAuth binding cookie to capture");

  await capturedPage.locator("#pick-first").click();
  await waitFor(async () => {
    if (!capturedPage.url().startsWith(app.origin)) return false;
    try {
      return (await currentSession(capturedPage)).authenticated === true;
    } catch {
      return false;
    }
  }, "the captured-cookie sign-in to produce a session");
  assert.equal(capturedCallbacks.length, 1, "the captured sign-in produced no single callback");

  const tokenCallsBeforeCapturedReplay = provider.state.tokenCalls;
  const replayed = await fetch(capturedCallbacks[0], {
    redirect: "manual",
    headers: { cookie: `${oauthCookie.name}=${oauthCookie.value}` },
  });
  assert.equal(
    provider.state.tokenCalls,
    tokenCallsBeforeCapturedReplay,
    "a replay carrying the captured binding cookie was exchanged with the provider a second time",
  );
  assert.equal(
    new URL(replayed.headers.get("location"), app.origin).searchParams.get("status"),
    "expired",
    "a replay carrying the captured binding cookie was not refused",
  );
  assert.ok(
    (replayed.headers.getSetCookie() ?? []).every((cookie) => !cookie.startsWith("__Host-archon_session=")),
    "a refused replay handed out a session cookie",
  );
  record("auth: a callback replayed with the transaction's own binding cookie is refused before the provider");
  await captured.close();

  /* 3.2 The provider is down. The visitor must be told that, and must not be
         told it expired -- "we could not find out" and "no" are different
         answers and only one of them is worth retrying immediately. */
  const outage = await openContext(world, browser);
  const outagePage = await outage.newPage();
  provider.state.plan = "outage";
  await outagePage.goto(`${app.origin}/login/?destination=%2Flogin%2F`);
  await waitFor(async () => !(await outagePage.locator("#submit").isDisabled()), "the sign-in binding");
  await outagePage.locator("#submit").click();
  await outagePage.locator("#pick-first").click();
  await outagePage.waitForURL((url) => url.searchParams.get("status") !== null, { timeout: 30_000 });
  assert.equal(new URL(outagePage.url()).searchParams.get("status"), "unavailable");
  await waitFor(
    async () => /could not reach GitHub/.test(await outagePage.locator("#status").innerText()),
    "the sign-in page to say the provider was unreachable",
  );
  assert.equal((await currentSession(outagePage)).authenticated, false);
  record("auth: a provider outage reaches a truthful unavailable page and no session");

  /* 3.3 The provider grants a scope this application never asked for. Using a
         credential wider than the consent screen showed is refused. */
  provider.state.plan = "scope";
  await outagePage.goto(`${app.origin}/login/?destination=%2Flogin%2F`);
  await waitFor(async () => !(await outagePage.locator("#submit").isDisabled()), "the sign-in binding");
  await outagePage.locator("#submit").click();
  await outagePage.locator("#pick-first").click();
  await outagePage.waitForURL((url) => url.searchParams.get("status") !== null, { timeout: 30_000 });
  assert.equal(new URL(outagePage.url()).searchParams.get("status"), "expired");
  assert.equal((await currentSession(outagePage)).authenticated, false);
  record("auth: a grant carrying an unexpected scope signs nobody in");

  provider.state.plan = "ok";

  await outage.close();
  await context.close();
}

/* ------------------------------------------------------------------ *
 * 4. Upload and receipt binding.
 * ------------------------------------------------------------------ */

/**
 * The same real handler, over the same real store, with the clock moved.
 *
 * `publicationDependencies` builds the production dependency set and the state
 * machine reads its clock out of it, so a case about a deadline can be a case
 * about a deadline rather than a case about waiting ten minutes. Nothing else
 * is substituted: the handler, the store, the record and every guard are the
 * ones the deployment runs.
 */
function atTime(world, whenMs) {
  return () => ({ ...world.publications(), now: () => whenMs });
}

async function uploadAndReceipt(world, browser) {
  const { app } = world;
  const context = await openContext(world, browser);
  const html = "<!doctype html><title>receipt</title><p>receipt binding</p>";

  /* 4.1 An owner is not something a client may state. The descriptor grammar
         has no field for one, and a start that invents one is refused rather
         than having the extra key ignored. */
  const withOwner = await agentFetch(world, "/api/hosted/publications", {
    body: JSON.stringify({
      v: 1,
      title: "Owned by nobody",
      contentSha256: createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex"),
      contentBytes: Buffer.byteLength(html, "utf8"),
      artifactFormat: "html",
      ownerAccountId: "gh_1",
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(withOwner.status, 400, `a client-supplied owner was answered ${withOwner.status}`);
  assert.equal((await withOwner.json()).error.code, "invalid_request");
  record("upload: a client cannot name the owner of a publication");

  const publication = await startPublication(world, { title: "Receipt binding", html });

  /* 4.2 An upload before anybody approved. */
  const early = await uploadArtifact(world, publication);
  assert.equal(early.status, 403, `an unapproved upload was answered ${early.status}`);
  assert.equal((await early.json()).error.code, "approval_required");
  record("upload: an unapproved upload is refused");

  const page = await context.newPage();
  await approveInBrowser(page, publication.verificationUriComplete);

  /* 4.3 Bytes that are not the ones that were approved. The person agreed to a
         digest and a length; a different document under the same approval is
         the substitution the descriptor exists to prevent. */
  const altered = await uploadArtifact(world, publication, Buffer.from(`${html}<!-- altered -->`, "utf8"));
  assert.equal(altered.status, 409, `an altered artifact was answered ${altered.status}`);
  assert.equal((await altered.json()).error.code, "descriptor_mismatch");
  record("upload: altered bytes cannot be published under an approval of other bytes");

  /* 4.4 The media type is part of the contract. */
  const wrongType = await agentFetch(world, `/api/hosted/publications/${publication.publicationId}/artifact`, {
    method: "PUT",
    secret: publication.agentSecret,
    body: publication.bytes,
    headers: { "content-type": "application/json" },
  });
  assert.equal(wrongType.status, 415, `a wrong media type was answered ${wrongType.status}`);
  record("upload: a wrong media type is refused");

  /* Nothing above became readable. */
  const beforeUpload = await publicationStatus(world, publication);
  assert.equal((await beforeUpload.json()).state, "approved", "a refused upload advanced the state");
  record("upload: every refused upload left the publication approved and unread");

  /* 4.5 The real upload -- and then the answer is thrown away, which is the
         lost-response case: durably complete, and the client does not know. */
  const committed = await uploadArtifact(world, publication);
  assert.equal(committed.status, 201, `the first durable completion was ${committed.status}`);
  const receipt = await committed.json();
  assert.equal(receipt.state, "complete", "the completion response did not report a complete state");
  assert.ok(receipt.result, "the completion response carried no result");

  /* 4.6 The identical retry is a 200 carrying the same result, not a second
         document and not a conflict. */
  const retried = await uploadArtifact(world, publication);
  assert.equal(retried.status, 200, `an identical retry was answered ${retried.status}`);
  assert.deepEqual(await retried.json(), receipt, "the retry returned a different receipt");
  record("upload: an identical retry is the same receipt, not a second document");

  /* 4.6b And a *non*-identical retry is not. The approval covered one document;
     a second set of bytes arriving under the same publication is a substitution
     whether it arrives before the first completion or after it, and the answer
     must be the refusal rather than the receipt the first one earned. */
  const substituted = await uploadArtifact(
    world,
    publication,
    Buffer.from(`${html}<!-- substituted after completion -->`, "utf8"),
  );
  assert.equal(
    substituted.status,
    409,
    `a completed publication accepted other bytes with status ${substituted.status}`,
  );
  assert.equal((await substituted.json()).error.code, "descriptor_mismatch");
  const unchanged = await world.modules.publicationStore
    .createPublicationStore({ getStore: world.blobs.getStore })
    .read(publication.publicationId);
  assert.equal(
    unchanged.record.descriptor.contentSha256,
    publication.descriptor.contentSha256,
    "a refused substitution changed the stored document anyway",
  );
  record("upload: a completed publication refuses a retry carrying other bytes");

  /* 4.7 Recovery after the upload deadline has passed but inside the
         twenty-four-hour receipt window. The handler is the real one and the
         record is the real one; only the clock is moved past the deadline. */
  const pastDeadline = Date.now() + (world.modules.contracts.HOSTED_LIMITS.UPLOAD_TTL_SECONDS + 60) * 1000;
  const lateStatus = await world.modules.status.handleStatus(
    new Request(`${app.origin}/api/hosted/publications/${publication.publicationId}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${publication.agentSecret}`, accept: "application/json" },
    }),
    atTime(world, pastDeadline),
  );
  assert.equal(lateStatus.status, 200, "a completed publication stopped answering after its upload deadline");
  const recovered = await lateStatus.json();
  assert.equal(recovered.state, "complete");
  assert.deepEqual(recovered.result, receipt.result, "the recovered receipt is a different document");
  record("upload: the receipt survives the upload deadline inside the receipt window");

  /* 4.8 And it stops after it. The owner's read is unaffected -- that is the
         next matrix -- but the operation bearer's recovery window is over. */
  const pastReceipt = Date.now() + (world.modules.contracts.HOSTED_LIMITS.RECEIPT_TTL_SECONDS + 60) * 1000;
  const expired = await world.modules.status.handleStatus(
    new Request(`${app.origin}/api/hosted/publications/${publication.publicationId}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${publication.agentSecret}`, accept: "application/json" },
    }),
    atTime(world, pastReceipt),
  );
  assert.equal(expired.status, 410, `an expired receipt was answered ${expired.status}`);
  assert.equal((await expired.json()).error.code, "receipt_expired");
  record("upload: the receipt stops being recoverable after its window");

  /* 4.9 Exactly one record exists for this publication, and it is the one the
         receipt names. */
  const stored = await world.modules.publicationStore
    .createPublicationStore({ getStore: world.blobs.getStore })
    .read(publication.publicationId);
  assert.equal(stored.record.state, "complete");
  assert.equal(stored.record.id, receipt.result.documentId, "the document id is not the publication id");
  assert.equal(stored.record.descriptor.contentSha256, publication.descriptor.contentSha256);
  assert.equal(stored.record.contentBytes ?? stored.record.descriptor.contentBytes, publication.descriptor.contentBytes);
  record("upload: one publication produced one durable record");

  await page.close();
  await context.close();
}

/* ------------------------------------------------------------------ *
 * 5. Owner read, enumeration and legacy authority.
 * ------------------------------------------------------------------ */

/** Every response header, lower-cased, as one record. */
const headersOf = (response) => Object.fromEntries(response.headers);

/**
 * A refusal must carry nothing about what it refused.
 *
 * The whole response is searched, headers included, because an `ETag` or a
 * `Content-Length` derived from a private document is a disclosure exactly as
 * much as a body would be.
 */
async function assertDiscloses(response, markers, label) {
  const rendered = [
    response.status,
    JSON.stringify(headersOf(response)),
    await response.text(),
  ].join("\n");
  for (const marker of markers) {
    assert.ok(!rendered.includes(marker), `${label} disclosed ${JSON.stringify(marker)}`);
  }
}

async function ownerRead(world, browser) {
  const { app, provider } = world;
  const html = "<!doctype html><title>private</title><p>Private figures for one account only.</p>";
  const title = "Private quarterly figures";

  const ownerContext = await openContext(world, browser);
  provider.state.account = "first";
  const published = await publishThroughBrowser(world, ownerContext, { title, html, account: "first" });
  const documentId = published.receipt.result.documentId;
  const publication = published.publication;
  const digest = published.publication.descriptor.contentSha256;
  const markers = [title, digest, "Private figures"];

  const ownerCookie = await cookieHeader(ownerContext, app.origin);
  const read = (path, { cookie = "", method = "GET" } = {}) =>
    fetch(`${app.origin}${path}`, { method, headers: cookie === "" ? {} : { cookie }, redirect: "manual" });

  /* 5.1 The owner, on both API routes. */
  const metadata = await read(`/api/hosted/docs/${documentId}`, { cookie: ownerCookie });
  assert.equal(metadata.status, 200, `the owner's metadata read was answered ${metadata.status}`);
  const body = await metadata.json();
  assert.equal(body.title, title);
  assert.equal(body.ownerAccountId, `gh_${provider.identities.first.id}`);
  assert.equal(body.contentSha256, digest);
  record("read: the owner's metadata names the document that was approved");

  const content = await read(`/api/hosted/docs/${documentId}/content`, { cookie: ownerCookie });
  assert.equal(content.status, 200);
  const contentHeaders = headersOf(content);
  assert.equal(contentHeaders["content-type"], "application/octet-stream");
  assert.equal(contentHeaders["content-disposition"], world.modules.documents.CONTENT_DISPOSITION);
  assert.equal(contentHeaders["x-content-type-options"], "nosniff");
  assert.equal(contentHeaders["cache-control"], "private, no-store");
  const bytes = Buffer.from(await content.arrayBuffer());
  assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, "the returned bytes are not the approved bytes");
  record("read: private content is an attachment of the exact approved bytes");

  /* 5.2 A second account, using the first owner's known URL. This is the case
         a leaked link produces, and it must be indistinguishable from a
         document that does not exist. */
  const strangerContext = await openContext(world, browser);
  const strangerPage = await strangerContext.newPage();
  provider.state.account = "second";
  await signIn(strangerPage, app.origin, { account: "second", destination: "/login/" });
  const strangerCookie = await cookieHeader(strangerContext, app.origin);
  assert.notEqual(strangerCookie, ownerCookie, "the two accounts share a session");

  const missing = "0".repeat(32);
  const refusals = [];
  for (const [label, path, cookie] of [
    ["signed-out metadata", `/api/hosted/docs/${documentId}`, ""],
    ["signed-out content", `/api/hosted/docs/${documentId}/content`, ""],
    ["stranger metadata", `/api/hosted/docs/${documentId}`, strangerCookie],
    ["stranger content", `/api/hosted/docs/${documentId}/content`, strangerCookie],
    ["missing metadata", `/api/hosted/docs/${missing}`, strangerCookie],
    ["missing content", `/api/hosted/docs/${missing}/content`, strangerCookie],
    ["malformed metadata", "/api/hosted/docs/not-an-id", strangerCookie],
  ]) {
    const response = await read(path, { cookie });
    assert.ok(response.status >= 400, `${label} was answered ${response.status}`);
    refusals.push({ label, status: response.status });
    await assertDiscloses(response, markers, label);
    record(`read: ${label} discloses nothing`);
  }

  /* The stranger and the missing id are answered the same way, so the API is
     not an existence oracle. */
  const strangerStatus = refusals.find((one) => one.label === "stranger metadata").status;
  const missingStatus = refusals.find((one) => one.label === "missing metadata").status;
  assert.equal(strangerStatus, missingStatus, "a stranger can tell a real document from a missing one");
  record("read: a stranger cannot tell a real document from one that never existed");

  /* 5.3 HEAD authorises exactly as GET does, so it is never a cheaper oracle. */
  for (const [label, cookie, expected] of [
    ["owner", ownerCookie, 200],
    ["stranger", strangerCookie, missingStatus],
  ]) {
    const head = await read(`/api/hosted/docs/${documentId}`, { cookie, method: "HEAD" });
    assert.equal(head.status, expected, `HEAD for the ${label} was answered ${head.status}`);
    record(`read: HEAD authorises the ${label} exactly as GET does`);
  }

  /* 5.4 The shell. A signed-out reader is sent to the fixed sign-in flow with a
         server-validated destination, and never sees a title on the way. */
  const shellOut = await read(`/docs/${documentId}`);
  assert.equal(shellOut.status, 303, `the signed-out shell answered ${shellOut.status}`);
  const location = shellOut.headers.get("location");
  assert.equal(
    location,
    world.modules.documents.signInDestination(documentId),
    "the signed-out shell did not use the fixed sign-in destination",
  );
  await assertDiscloses(shellOut, markers, "the signed-out shell");
  record("read: a signed-out reader is sent to sign in with no title on the way");

  const shellStranger = await read(`/docs/${documentId}`, { cookie: strangerCookie });
  const shellMissing = await read(`/docs/${missing}`, { cookie: strangerCookie });
  assert.equal(shellStranger.status, shellMissing.status);
  assert.equal(await shellStranger.text(), await shellMissing.text());
  record("read: the stranger's shell is byte-identical to a missing document's");

  /* 5.5 Legacy authority cannot widen a hosted read. `DOC_OWNERS`, the
         organisation default and `PUBLIC_DEFAULT_ROLE` are the root
         deployment's, and this deployment reads none of them -- so setting all
         three, to values that would make the stranger an owner over there,
         changes nothing here. */
  const legacy = {
    DOC_OWNERS: `${documentId}:*`,
    PUBLIC_DEFAULT_ROLE: "owner",
    ORG_DEFAULT_ROLE: "owner",
    ORG_EMAIL_DOMAIN: "example.com",
  };
  Object.assign(process.env, legacy);
  Object.assign(world.env, legacy);
  try {
    const widened = await read(`/api/hosted/docs/${documentId}`, { cookie: strangerCookie });
    assert.equal(widened.status, missingStatus, "a legacy owner list widened a hosted read");
    await assertDiscloses(widened, markers, "the legacy-widened read");
    const stillOwner = await read(`/api/hosted/docs/${documentId}`, { cookie: ownerCookie });
    assert.equal(stillOwner.status, 200, "a legacy variable broke the owner's own read");
  } finally {
    for (const key of Object.keys(legacy)) {
      delete process.env[key];
      delete world.env[key];
    }
  }
  record("read: legacy DOC_OWNERS, org defaults and PUBLIC_DEFAULT_ROLE cannot widen a hosted read");

  await strangerContext.close();
  return {
    ownerContext,
    documentId,
    title,
    digest,
    markers,
    strangerCookie,
    ownerCookie,
    publication,
    browserSecret: published.browserSecret,
    sessionCookie: ownerCookie.split("=").slice(1).join("="),
  };
}

/* ------------------------------------------------------------------ *
 * 6. Storage faults and races, around the real store.
 * ------------------------------------------------------------------ */

async function storageAndRaces(world, browser) {
  const { app, blobs } = world;
  const context = await openContext(world, browser);
  world.provider.state.account = "first";

  /* 6.1 The write never reaches the provider. A publication that could not be
         durably created must not be reported as created: an inert failure is
         recoverable, and a receipt for a record nobody wrote is not. */
  blobs.faults.failNextWrite = "publications/";
  const refusedStart = await agentFetch(world, "/api/hosted/publications", {
    body: JSON.stringify({
      v: 1,
      title: "Never stored",
      contentSha256: createHash("sha256").update("x").digest("hex"),
      contentBytes: 1,
      artifactFormat: "html",
    }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(refusedStart.status, 503, `a failed create was answered ${refusedStart.status}`);
  const refusedBody = await refusedStart.json();
  assert.equal(refusedBody.error.code, "unavailable");
  assert.equal(refusedBody.error.retryable, true);
  assert.equal(refusedStart.headers.get("cache-control"), "private, no-store");
  blobs.faults.failNextWrite = null;
  record("storage: a create the provider never took is a retryable outage, not a receipt");

  /* 6.2 A read the provider could not answer is an outage, never an absence.
         Reporting it as "no such publication" would be a fail-open: the client
         would stop, and the record would still be there. */
  const readFailure = await startPublication(world, {
    title: "Read failure",
    html: "<!doctype html><title>r</title><p>r</p>",
  });
  blobs.faults.failNextRead = `publications/${readFailure.publicationId}`;
  const unreadable = await publicationStatus(world, readFailure);
  assert.equal(unreadable.status, 503, `an unreadable record was answered ${unreadable.status}`);
  assert.equal((await unreadable.json()).error.code, "unavailable");
  blobs.faults.failNextRead = null;
  record("storage: a read the provider could not answer is an outage, not a missing record");

  /* 6.3 The write commits and the answer is lost. The record exists; the caller
         does not know it. The one thing that must not happen is a second
         document -- and the one thing that must happen is that the truth is
         still recoverable. */
  const ambiguous = await startPublication(world, {
    title: "Ambiguous completion",
    html: "<!doctype html><title>a</title><p>ambiguous</p>",
  });
  const ambiguousPage = await context.newPage();
  await approveInBrowser(ambiguousPage, ambiguous.verificationUriComplete);
  await ambiguousPage.close();

  const ambiguousKey = `publications/${ambiguous.publicationId}`;
  const writesBefore = blobs.writesTo(ambiguousKey);
  blobs.faults.ambiguousNextWrite = ambiguousKey;
  const lost = await uploadArtifact(world, ambiguous);
  blobs.faults.ambiguousNextWrite = null;

  /* A success, not a 503. The record is stored; reporting an outage for a write
     that committed is the failure this readback exists to prevent, and
     accepting 503 here would have made that outcome indistinguishable from the
     correct one. */
  assert.ok(
    lost.status === 200 || lost.status === 201,
    `an ambiguous but committed completion was answered ${lost.status}`,
  );
  const lostBody = await lost.json();

  const afterLoss = await publicationStatus(world, ambiguous);
  assert.equal(afterLoss.status, 200);
  const settled = await afterLoss.json();
  assert.equal(settled.state, "complete", "an ambiguous write left the publication unrecoverable");
  assert.equal(settled.result.documentId, ambiguous.publicationId, "a second document id appeared");
  assert.deepEqual(
    lostBody.result,
    settled.result,
    "the ambiguous response and the recovered receipt name different documents",
  );
  /* One write reached the provider. The state machine resolved the lost answer
     by reading back what is stored, rather than by writing again. */
  assert.equal(
    blobs.writesTo(ambiguousKey) - writesBefore,
    1,
    "the lost write answer was resolved by writing again rather than by reading back",
  );
  record("storage: a committed write whose answer was lost is resolved by one readback");

  /* And a retry after recovery is still the same document rather than a new
     one, so a client that could not read its answer never creates a second. */
  const retryAfterLoss = await uploadArtifact(world, ambiguous);
  assert.equal(retryAfterLoss.status, 200, `the retry after an ambiguous write was ${retryAfterLoss.status}`);
  assert.deepEqual((await retryAfterLoss.json()).result, settled.result);
  record("storage: retrying after an ambiguous write returns the same document");

  /* 6.4 Two completions of the same publication at the same time.
   *
   * What is provable here and what is not has to be said out loud. The
   * publication state machine is a compare-and-set against the provider's own
   * ETag, and `BlobsServer` derives that ETag from the file's modification time
   * at millisecond resolution -- so two writes that land inside the same
   * millisecond present the same `If-Match` value and both are taken. "Exactly
   * one caller created the document" is therefore a claim about the *provider*,
   * and AHU-013 owns it against real Netlify.
   *
   * What this case does establish is the part that is local: both callers are
   * answered successfully, they are answered with the *same* document, and one
   * record exists afterwards carrying the approved owner, digest and bytes. A
   * regression that produced two document ids, or two records, or a conflict
   * reported as a failure, fails here.
   */
  const raced = await startPublication(world, {
    title: "Raced completion",
    html: "<!doctype html><title>race</title><p>raced</p>",
  });
  const racedPage = await context.newPage();
  await approveInBrowser(racedPage, raced.verificationUriComplete);
  await racedPage.close();

  const both = await Promise.all([uploadArtifact(world, raced), uploadArtifact(world, raced)]);
  const statuses = both.map((response) => response.status).sort();
  assert.ok(
    statuses.every((code) => code === 200 || code === 201),
    `a concurrent completion pair was answered ${statuses.join(" and ")}`,
  );
  const results = await Promise.all(both.map((response) => response.json()));
  assert.deepEqual(results[0].result, results[1].result, "the racing completions produced different documents");
  assert.equal(results[0].result.documentId, raced.publicationId);
  const racedRecord = await world.modules.publicationStore
    .createPublicationStore({ getStore: blobs.getStore })
    .read(raced.publicationId);
  assert.equal(racedRecord.record.state, "complete");
  assert.equal(racedRecord.record.descriptor.contentSha256, raced.descriptor.contentSha256);
  record("storage: two simultaneous completions are answered with one document");

  /* A conflict the local runtime *can* produce: a second completion whose
     compare-and-set is presented against an ETag the provider has already
     moved past. The write is refused by the provider, the state machine
     re-evaluates against what is stored, and the answer is the existing
     document rather than a failure or a second one. */
  const afterSettled = await uploadArtifact(world, raced);
  assert.equal(afterSettled.status, 200, `a completion against a moved ETag was ${afterSettled.status}`);
  assert.deepEqual((await afterSettled.json()).result, results[0].result);
  record("storage: a completion refused by the provider's conditional write resolves to the stored document");

  /* 6.5 A cancellation racing an upload. Whichever wins, the loser does not get
         to invent a different answer, and a completed publication's cancel
         returns the unchanged receipt rather than deleting anything. */
  const contested = await startPublication(world, {
    title: "Contested completion",
    html: "<!doctype html><title>c</title><p>contested</p>",
  });
  const contestedPage = await context.newPage();
  await approveInBrowser(contestedPage, contested.verificationUriComplete);
  await contestedPage.close();

  const [uploadRace, cancelRace] = await Promise.all([
    uploadArtifact(world, contested),
    agentFetch(world, `/api/hosted/publications/${contested.publicationId}/cancel`, {
      secret: contested.agentSecret,
    }),
  ]);
  const finalState = await (await publicationStatus(world, contested)).json();
  assert.ok(
    ["complete", "cancelled"].includes(finalState.state),
    `a contested publication settled as ${finalState.state}`,
  );
  if (finalState.state === "complete") {
    /* A cancellation after completion is not a deletion. */
    const afterCancel = await agentFetch(world, `/api/hosted/publications/${contested.publicationId}/cancel`, {
      secret: contested.agentSecret,
    });
    assert.equal(afterCancel.status, 200);
    assert.deepEqual((await afterCancel.json()).result, finalState.result, "cancelling a completed publication changed its receipt");
  } else {
    assert.notEqual(uploadRace.status, 201, "an upload completed a publication that had been cancelled");
  }
  assert.ok(
    cancelRace.status === 200 || cancelRace.status === 409,
    `the racing cancel was answered ${cancelRace.status}`,
  );
  record("storage: a cancel racing an upload leaves exactly one terminal state");

  /* 6.7 A committed-but-unanswered write on the *approval*, which is where the
   *     readback is load-bearing in a way a completion cannot show.
   *
   * A completion is idempotent: whichever way an ambiguous write resolves, a
   * retry finds the document and returns it. An approval is not. If the state
   * machine treats a lost answer as a refusal, its next attempt re-reads a
   * record that is now `approved` and reports `state_conflict` -- telling a
   * person their successful approval failed, on a publication that is in fact
   * theirs. So this drives the real approval, in the real browser, with the
   * write's answer thrown away, and requires the person to be told it worked.
   */
  const ambiguousApproval = await startPublication(world, {
    title: "Ambiguous approval",
    html: "<!doctype html><title>aa</title><p>ambiguous approval</p>",
  });
  const approvalKey = `publications/${ambiguousApproval.publicationId}`;
  const approvalWritesBefore = blobs.writesTo(approvalKey);
  const approvalPage = await context.newPage();
  blobs.faults.ambiguousNextWrite = approvalKey;
  const ambiguousReview = await approveInBrowser(approvalPage, ambiguousApproval.verificationUriComplete);
  blobs.faults.ambiguousNextWrite = null;
  await approvalPage.close();

  const approvedState = await (await publicationStatus(world, ambiguousApproval)).json();
  assert.equal(
    approvedState.state,
    "approved",
    `an approval whose write answer was lost settled as ${approvedState.state}`,
  );
  assert.equal(
    ambiguousReview.decisionStatus,
    200,
    "the person was told their approval failed on a publication that is in fact theirs "
    + `(the decision route answered ${ambiguousReview.decisionStatus}: "${ambiguousReview.status}")`,
  );
  assert.equal(
    blobs.writesTo(approvalKey) - approvalWritesBefore,
    1,
    "the lost approval answer was resolved by writing again rather than by reading back",
  );
  /* And the owner it fixed is the account that clicked, not an empty one. */
  const approvedUpload = await uploadArtifact(world, ambiguousApproval);
  assert.equal(approvedUpload.status, 201);
  assert.equal(
    (await approvedUpload.json()).result.ownerAccountId,
    `gh_${world.provider.identities.first.id}`,
  );
  record("storage: an approval whose write answer was lost is reported as the success it was");

  /* 6.8 The descriptor recheck inside the state machine, reached the one way
   *     the HTTP route cannot reach it.
   *
   * `handleArtifact` derives the digest and the length from the bytes it read,
   * so over the wire a client cannot claim facts that disagree with its own
   * body -- which means the route can never present `completePublication` with
   * a mismatched claim, and the guard inside it is untestable from outside.
   * This calls the real producer with the real dependencies and the real record
   * and presents exactly that combination. No storage may be touched.
   */
  const guarded = await startPublication(world, {
    title: "Descriptor recheck",
    html: "<!doctype html><title>d</title><p>descriptor</p>",
  });
  const guardedPage = await context.newPage();
  await approveInBrowser(guardedPage, guarded.verificationUriComplete);
  await guardedPage.close();

  const guardedKey = `publications/${guarded.publicationId}`;
  const guardedWritesBefore = blobs.writesTo(guardedKey);
  await assert.rejects(
    () => world.modules.publicationsModule.completePublication(
      {
        publicationId: guarded.publicationId,
        agentSecret: guarded.agentSecret,
        html: guarded.bytes.toString("utf8"),
        /* Bytes that match the stored descriptor, claimed under a digest and a
           length that do not. */
        contentSha256: createHash("sha256").update("something else").digest("hex"),
        contentBytes: guarded.descriptor.contentBytes + 1,
      },
      world.publications(),
    ),
    (error) => error.code === "descriptor_mismatch",
    "a completion whose claimed digest and length disagree with the approved descriptor was accepted",
  );
  assert.equal(
    blobs.writesTo(guardedKey) - guardedWritesBefore,
    0,
    "a refused completion still wrote to storage",
  );
  /* The record is untouched and the honest upload still works afterwards. */
  const honest = await uploadArtifact(world, guarded);
  assert.equal(honest.status, 201, `the honest upload after a refused one was ${honest.status}`);
  record("storage: a completion claiming a digest and length the approval did not cover is refused before any write");

  /* 6.9 The store producer asks for strongly consistent reads, and says so to
   *     the provider rather than merely intending to.
   *
   * `@netlify/blobs` refuses a strong read when the deployment was configured
   * without an uncached edge URL, so a handle built that way is a way to
   * observe the request the producer makes. A producer that stopped asking
   * would read from a replica in production -- a revoked session that keeps
   * working, and a compare-and-set against an ETag that has already moved.
   */
  await assert.rejects(
    () => world.modules.publicationStore
      .createPublicationStore({ getStore: blobs.weakGetStore })
      .read(guarded.publicationId),
    "the publication store no longer requires strongly consistent reads",
  );
  record("storage: the publication store demands strongly consistent reads from the provider");

  /* 6.6 No partial artifact ever became readable.
   *
   * The publication whose upload never happened has no completion at all, so
   * its content route has nothing to serve to anybody -- including the account
   * that started it. The contested one settles either way, and both
   * settlements have a definite answer: a completed publication serves its
   * owner, and a cancelled one serves nobody. What must never happen is the
   * third thing -- a half-written document readable by someone.
   */
  const ownerCookie = await cookieHeader(context, app.origin);
  const neverStored = await fetch(`${app.origin}/api/hosted/docs/${readFailure.publicationId}/content`, {
    headers: { cookie: ownerCookie },
  });
  assert.ok(neverStored.status >= 400, `a publication with no completion served content (${neverStored.status})`);
  record("storage: a publication that never completed exposes no content");
  const neverCreated = await fetch(`${app.origin}/api/hosted/docs/${"e".repeat(32)}/content`, {
    headers: { cookie: ownerCookie },
  });
  assert.ok(neverCreated.status >= 400, "a publication that was never created served content");
  record("storage: a create the provider never took leaves nothing to read");

  const contestedContent = await fetch(`${app.origin}/api/hosted/docs/${contested.publicationId}/content`, {
    headers: { cookie: ownerCookie },
  });
  if (finalState.state === "complete") {
    assert.equal(contestedContent.status, 200, "a completed document was unreadable by its owner");
    assert.equal(
      createHash("sha256").update(Buffer.from(await contestedContent.arrayBuffer())).digest("hex"),
      contested.descriptor.contentSha256,
      "the contested document's bytes are not the approved bytes",
    );
  } else {
    assert.ok(contestedContent.status >= 400, `a cancelled publication served content (${contestedContent.status})`);
  }
  record("storage: a contested publication serves its whole approved bytes or nothing at all");

  await context.close();
}

/* ------------------------------------------------------------------ *
 * 7. Rendered isolation, benign and hostile.
 * ------------------------------------------------------------------ */

const FIXTURE_DIR = join(ROOT, "scripts", "fixtures", "hosted");

/** One fixture artifact, with this run's origins substituted in. */
function fixtureArtifact(world, name, { requiresOrigins = false } = {}) {
  const source = readFileSync(join(FIXTURE_DIR, name), "utf8");
  const substituted = source
    .replaceAll("__APP_ORIGIN__", world.app.origin)
    .replaceAll("__ADVERSARY_ORIGIN__", world.adversary.origin);
  /* An unsubstituted hostile fixture would leave the adversary log empty for
     the wrong reason: the artifact would be naming a host that does not exist
     rather than being refused. Both directions are checked for the fixture that
     depends on it -- the placeholders were there, and none survived. The benign
     control names no origin at all, which is why the first check is opt-in. */
  if (requiresOrigins) {
    assert.notEqual(source, substituted, `${name} carries no origin placeholder to substitute`);
  }
  assert.doesNotMatch(substituted, /__[A-Z_]+__/, `${name} still carries an unsubstituted placeholder`);
  return substituted;
}

/** Open a published document as its owner and return both frames. */
async function openAsOwner(world, context, url) {
  const page = await context.newPage();
  await page.goto(url);
  const frames = await artifactFrame(page, world.renderer.origin);
  return { page, ...frames };
}

async function renderedIsolation(world, browser, client) {
  const { app, renderer, adversary } = world;
  const context = await openContext(world, browser);
  world.provider.state.account = "first";

  /* 7.1 Ordinary content, operated. A theme toggle, fragment navigation into
         sections, an authored click listener on every link, an inline image
         and a link whose target does not exist. */
  const benign = await publishThroughBrowser(world, context, {
    title: "Benign artifact",
    html: fixtureArtifact(world, "benign.html"),
  });
  const opened = await openAsOwner(world, context, benign.receipt.result.url);
  const artifact = opened.artifact;

  await artifact.locator("#theme").click();
  assert.equal(await artifact.locator("body").getAttribute("data-theme"), "dark");
  record("render: an artifact's own script runs inside the sandbox");

  const hrefs = await artifact.locator("#hrefs").textContent();
  assert.equal(
    hrefs,
    "#alpha #beta #percent%20sign #nowhere #",
    "the renderer rewrote the artifact's own href attributes",
  );
  record("render: the renderer leaves every authored href attribute alone");

  for (const [label, link, expected] of [
    ["a section", "#alpha", "alpha"],
    ["a percent-encoded target", "#percent%20sign", "percent sign"],
    ["a target that does not exist", "#nowhere", null],
  ]) {
    const before = await artifact.locator("#clicks").getAttribute("data-clicks");
    await artifact.locator(`nav.jump a[href="${link}"]`).click();
    await waitFor(
      async () => (await artifact.locator("#clicks").getAttribute("data-clicks")) !== before,
      `the artifact's own click listener to run for ${label}`,
    );
    if (expected !== null) {
      const focused = await artifact.evaluate(() => document.activeElement?.id ?? "");
      assert.equal(focused, expected, `navigating to ${label} did not move focus to the target`);
    }
    /* Whatever happened, the artifact is still the artifact: a fragment link is
       never allowed to unload it. */
    assert.equal(
      await artifact.locator("#hrefs").textContent(),
      hrefs,
      `${label} replaced the artifact document`,
    );
    record(`render: ${label} runs the authored listener and never replaces the artifact`);
  }

  /* 7.2 The packaged document's own navigation, which is what a reader
         actually gets. Its links are generated by the builder and its listeners
         come from `templates/base/app.js`; both run here for real. */
  const packaged = await publishThroughBrowser(world, context, {
    title: client.document.title,
    html: readFileSync(client.document.artifact, "utf8"),
  });
  const packagedView = await openAsOwner(world, context, packaged.receipt.result.url);
  const section = client.document.sectionIds[1];
  await packagedView.artifact.locator(`nav.jump a[href="#${section}"]`).click();
  await waitFor(
    async () => await packagedView.artifact.locator(`#${section} details`).getAttribute("open") !== null,
    "the packaged document's own click listener to open the section",
  );
  assert.equal(
    await packagedView.artifact.locator(`nav.jump a[href="#${section}"]`).getAttribute("href"),
    `#${section}`,
  );
  assert.ok(
    (await packagedView.artifact.locator("body").textContent()).includes(DOCUMENT_SENTINEL),
    "the packaged artifact was replaced by navigating within it",
  );
  record("render: the packaged document's section navigation works inside the sandbox");
  await packagedView.page.close();

  /* 7.3 Hostile content. Every attempt it makes is recorded somewhere it
         cannot reach, so the assertions are about servers and windows rather
         than about exceptions it swallowed.
   *
   * The recorder is proved to work first. "Nothing reached the adversary" is
   * worth exactly as much as the recorder's ability to notice something that
   * does, and a broken listener would make every isolation case below pass by
   * observing nothing. */
  const control = await context.newPage();
  await control.goto(`${adversary.origin}/positive-control`);
  assert.ok(
    adversary.state.requests.some((one) => one.path === "/positive-control"),
    "the adversary recorder cannot see a request that reaches it",
  );
  await control.close();
  record("render: the adversary recorder registers a request that does reach it");

  const adversaryBefore = adversary.state.requests.length;
  const appBefore = app.state.requests.length;

  const hostile = await publishThroughBrowser(world, context, {
    title: "Hostile artifact",
    html: fixtureArtifact(world, "hostile.html", { requiresOrigins: true }),
  });
  const pagesBefore = new Set(context.pages());
  /* Seeded before navigation. Setting it after the page has loaded would set it
     after the artifact's script had already had its chance, so the assertion
     below would be reading a value this line had just written. */
  const hostilePage = await context.newPage();
  await hostilePage.addInitScript(() => { window.__pwned = false; });
  await hostilePage.goto(hostile.receipt.result.url);
  const hostileFrames = await artifactFrame(hostilePage, renderer.origin);
  const hostileView = { page: hostilePage, ...hostileFrames };
  await waitFor(
    async () => (await hostileView.artifact.locator("body").getAttribute("data-hostile-ran")) === "true",
    "the hostile artifact to finish trying",
  );
  /* Its refusals are asynchronous, so the counters are read after the renderer
     has had the chance to refuse the flood. */
  await waitFor(
    async () => Number(await hostileView.renderer.locator("html").getAttribute("data-archon-refusals")) > 0,
    "the renderer to refuse the artifact's forged messages",
  );

  const reached = adversary.state.requests.slice(adversaryBefore);
  assert.deepEqual(reached, [], `the hostile artifact reached the adversary: ${JSON.stringify(reached)}`);
  record("render: no remote subresource, form, fetch or beacon left the sandbox");

  const account = app.state.requests.slice(appBefore).filter((one) => one.search.includes("from=artifact"));
  assert.deepEqual(account, [], "the hostile artifact reached the account origin");
  record("render: the artifact could not reach the account origin");

  assert.equal(
    await hostileView.page.evaluate(() => window.__pwned),
    false,
    "the hostile artifact reached the account page's window",
  );
  const shellTitle = await hostileView.page.locator("[data-archon-title]").innerText();
  assert.equal(shellTitle, "Hostile artifact", "the artifact replaced the trusted title region");
  assert.equal(
    await hostileView.page.locator("[data-archon-owner]").innerText(),
    `Signed in as @${world.provider.identities.first.login}`,
    "the artifact replaced the trusted owner region",
  );
  record("render: the trusted shell's own regions are untouched by an artifact that imitates them");

  const rejections = await hostileView.renderer.locator("html").getAttribute("data-archon-rejections");
  assert.ok(
    rejections.split(" ").includes("wrong-window"),
    `the renderer did not record refusing the artifact's forged messages: ${rejections}`,
  );
  assert.equal(
    await hostileView.renderer.locator("html").getAttribute("data-archon-state"),
    "rendered",
    "a forged message changed what the renderer was showing",
  );
  record("render: forged ready and render messages from the artifact are refused by source");

  /* The renderer's refusal log is a set, so a flood cannot grow it. */
  assert.ok(rejections.split(" ").length <= 4, `the refusal log grew to ${rejections}`);
  record("render: a message flood costs the renderer bounded work");

  assert.equal(hostileView.page.url(), hostile.receipt.result.url, "the artifact navigated the top window");
  assert.deepEqual(
    context.pages().filter((one) => one !== hostileView.page && !pagesBefore.has(one)).map((one) => one.url()),
    [],
    "the artifact opened a window outside the sandbox",
  );
  record("render: the artifact could not navigate the reader's tab or open a window");

  await hostileView.page.close();
  await opened.page.close();
  await context.close();
  return { renderer, benign, hostile };
}

/* ------------------------------------------------------------------ *
 * 8. The deployment's own configuration, applied.
 * ------------------------------------------------------------------ */

async function deploymentConnection(world, owned) {
  const { app, renderer, adversary } = world;
  /* The owner's own browsing context, carried over from the read matrix: the
     viewer is an owner-only page, so a fresh context would be looking at a
     sign-in redirect rather than at a rendered document. */
  const context = owned.ownerContext;
  const cookie = owned.ownerCookie;

  /* 8.1 The header block `hosted/netlify.toml` declares reaches every static
         surface, and the document routes carry their own policy on top of the
         private header set. Both are read off the deployment rather than
         restated here. */
  const declared = Object.fromEntries(world.deployment.values.map(([name, value]) => [name.toLowerCase(), value]));
  /* The directives are asserted on what the deployment *declares*, because that
     is the artifact Netlify serves from. Comparing the served response to the
     same block would only prove this runner echoes its own input. The served
     check below is kept for the one thing it does prove: that the block is
     applied to the contract's approval path at all. */
  assert.equal(declared["x-content-type-options"], "nosniff");
  assert.equal(declared["referrer-policy"], "no-referrer");
  assert.equal(declared["cache-control"], "private, no-store");
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self' https://github.com",
  ]) {
    assert.ok(
      declared["content-security-policy"].includes(directive),
      `the hosted deployment no longer declares ${directive}`,
    );
  }
  record("deploy: the deployment declares the C3 header set for every static surface");

  const authorize = await fetch(`${app.origin}/publish/authorize`);
  assert.equal(authorize.status, 200, "the contract's approval path is not served");
  for (const [name, value] of Object.entries(declared)) {
    assert.equal(authorize.headers.get(name), value, `the approval page lost its ${name}`);
  }
  record("deploy: the contract's approval path is served with that header block applied");

  const shell = await fetch(`${app.origin}/docs/${owned.documentId}`, { headers: { cookie } });
  assert.equal(shell.status, 200);
  const shellCsp = shell.headers.get("content-security-policy");
  assert.ok(shellCsp.includes(`frame-src ${renderer.origin}`), `the viewer may not frame the renderer: ${shellCsp}`);
  assert.equal(shell.headers.get("cache-control"), "private, no-store");
  assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  record("deploy: the viewer's policy names the configured renderer origin and nothing else");

  /* 8.2 The renderer's own generated headers, and the framing rule in both
         directions: the application may frame it, and nobody else may. */
  const rendererHeaders = Object.fromEntries(renderer.headers().map(([name, value]) => [name.toLowerCase(), value]));
  assert.ok(
    rendererHeaders["content-security-policy"].includes(`frame-ancestors ${app.origin}`),
    `the renderer does not name the application as its only framer: ${rendererHeaders["content-security-policy"]}`,
  );
  assert.equal(rendererHeaders["x-frame-options"], undefined, "X-Frame-Options would forbid the one framing this design needs");
  record("deploy: the renderer's generated headers admit exactly the configured application");

  /* An adversary page that frames the renderer. The frame must not load, so
     the renderer never mounts and never announces readiness to it. */
  const framePage = await context.newPage();
  await framePage.goto(`${adversary.origin}/frame-attempt`);
  const framed = await framePage.evaluate(async (origin) => {
    return new Promise((done) => {
      window.__ready = false;
      addEventListener("message", (event) => {
        if (event.data && event.data.type === "archon:ready") window.__ready = true;
      });
      const frame = document.createElement("iframe");
      frame.src = `${origin}/`;
      frame.addEventListener("load", () => setTimeout(() => done(window.__ready), 250));
      frame.addEventListener("error", () => done(window.__ready));
      document.body.appendChild(frame);
      setTimeout(() => done(window.__ready), 3000);
    });
  }, renderer.origin);
  assert.equal(framed, false, "the renderer announced itself to a page that framed it from another origin");
  record("deploy: an adversary page cannot frame the renderer into talking to it");

  /* The viewer's policy is its handler's rather than the deployment block's, so
     its refusal to be framed is a separate claim from the one above. */
  assert.ok(
    shellCsp.includes("frame-ancestors 'none'"),
    `the viewer does not refuse framing: ${shellCsp}`,
  );
  record("deploy: the viewer refuses framing");

  /* 8.3 The renderer origin is cookie-free, and the bytes it is handed carry
         no identity. The message grammar is exact-keyed by the renderer itself,
         so a rendered document already proves nothing else was in the message;
         what is asserted here is the surrounding claim -- that this origin has
         no session to leak and was told no identifier. */
  const view = await openAsOwner(world, context, `${app.origin}/docs/${owned.documentId}`);
  assert.equal(await view.renderer.evaluate(() => document.cookie), "", "the renderer origin has cookies");
  const rendererUrl = new URL(view.renderer.url());
  assert.equal(rendererUrl.search, "", "the renderer was given a query string");
  assert.equal(rendererUrl.hash, "", "the renderer was given a fragment");
  const baseUri = await view.artifact.evaluate(() => document.baseURI);
  assert.ok(!baseUri.includes(owned.documentId), `the artifact can read the document id from ${baseUri}`);
  assert.ok(
    renderer.state.requests.every((one) => one.cookie === ""),
    "a request to the renderer origin carried a cookie",
  );
  record("deploy: the renderer origin is cookie-free and is told no document identifier");
  await view.page.close();

  /* 8.4 A readiness message from the right origin and the wrong window.
   *
   * The timing is the whole case. The viewer hands the document over exactly
   * once, and once it has, a later forged message is refused by the
   * already-rendered guard rather than by the source check -- so a forged
   * message sent to a finished viewer proves nothing about who is allowed to
   * speak. This runs against a viewer that is *waiting*: the renderer's own
   * document is held open, so the bytes are fetched and pending and the real
   * renderer has not said anything yet. That is the one moment the source check
   * is the only thing between a private document and another window.
   *
   * The forge page is served by the renderer deployment itself, so its
   * `event.origin` is flawless; only its window is wrong.
   */
  renderer.stall();
  const forgeReports = [];
  try {
    const waiting = await context.newPage();
    await waiting.goto(`${app.origin}/docs/${owned.documentId}`);
    /* The pre-state, asserted rather than assumed: the viewer is still waiting
       for its renderer. If this ever stops being true the case has stopped
       testing the source check and says so here. */
    await waitFor(
      async () => (await waiting.locator("[data-archon-title]").innerText()) === owned.title,
      "the viewer to have fetched the document it is waiting to hand over",
    );
    assert.notEqual(
      await waiting.locator("html").getAttribute("data-archon-state"),
      "rendered",
      "the viewer had already handed the document over before the forged message was sent",
    );

    await waiting.exposeFunction("__archonForgeReport", (seen) => forgeReports.push(seen));
    await waiting.evaluate((url) => {
      addEventListener("message", (event) => {
        if (event.data && Array.isArray(event.data.archonForgeReport)) {
          window.__archonForgeReport(event.data.archonForgeReport);
        }
      });
      const frame = document.createElement("iframe");
      frame.src = url;
      document.body.appendChild(frame);
    }, `${renderer.origin}${FORGE_PATH}`);

    /* Bounded on the forge page's own reports rather than on a sleep: it posts
       readiness every 50ms and reports what it has received alongside, so three
       reports mean it has been announcing itself across three intervals and the
       viewer has had every chance to answer it. */
    await waitFor(() => forgeReports.length >= 3, "the forged renderer to report what it received");
    const forged = forgeReports.flat();
    assert.ok(
      !forged.includes("archon:render"),
      `the viewer sent the document to a window it was not waiting on: ${JSON.stringify(forged)}`,
    );
    assert.notEqual(
      await waiting.locator("html").getAttribute("data-archon-state"),
      "rendered",
      "a forged readiness message caused the viewer to hand the document over",
    );
    record("deploy: a readiness message from the right origin and the wrong window gets nothing");

    /* And the genuine handshake still works, which is what keeps the case above
       from passing on a viewer that simply never hands anything to anybody. */
    renderer.release();
    const real = await artifactFrame(waiting, renderer.origin);
    await waitFor(
      async () => (await real.artifact.locator("body").textContent()).includes("Private figures"),
      "the real renderer to receive the document once it announces itself",
    );
    record("deploy: the document is handed over as soon as the real renderer announces itself");
    await waiting.close();
  } finally {
    renderer.release();
  }

  /* 8.5 The renderer deployment is simply not there. The reader must be told,
         in the trusted shell, and the bytes must not have been sent anywhere. */
  renderer.setAvailable(false);
  try {
    const brokenPage = await context.newPage();
    await brokenPage.goto(`${app.origin}/docs/${owned.documentId}`);
    const status = brokenPage.locator("[data-archon-status]");
    await waitFor(
      async () => (await status.getAttribute("data-tone")) === "error",
      "the viewer to report that the renderer could not be reached",
    );
    const message = await status.innerText();
    assert.notEqual(message.trim(), "", "the failed-renderer state has no text for a reader");
    await assertDiscloses(
      new Response(await brokenPage.content()),
      [owned.digest],
      "the failed-renderer page",
    );
    assert.equal(
      await brokenPage.locator("[data-archon-title]").innerText(),
      owned.title,
      "the trusted title region is not available when the renderer is not",
    );
    record("deploy: an unreachable renderer produces a readable failure and sends no bytes");
    await brokenPage.close();
  } finally {
    renderer.setAvailable(true);
  }
}

/* ------------------------------------------------------------------ *
 * 9. Operations.
 * ------------------------------------------------------------------ */

async function operations(world, browser, owned) {
  const { app } = world;
  const limits = world.modules.contracts.HOSTED_LIMITS;
  const context = await openContext(world, browser);
  world.provider.state.account = "first";

  /* 9.1 An approved publication that has not uploaded yet, kept for the
         disabled-publishing case below. */
  const pending = await startPublication(world, {
    title: "Operations switch",
    html: "<!doctype html><title>ops</title><p>operations</p>",
  });
  const page = await context.newPage();
  await approveInBrowser(page, pending.verificationUriComplete);
  await page.close();

  /* 9.2 The operator turns publishing off. New work is refused; the reads and
         the recoveries that already exist keep working, because a switch that
         took away a person's document would be a switch nobody could safely
         use. */
  world.env.HOSTED_PUBLISH_ENABLED = "false";
  try {
    const refused = await agentFetch(world, "/api/hosted/publications", {
      body: JSON.stringify({
        v: 1,
        title: "Refused while disabled",
        contentSha256: createHash("sha256").update("y").digest("hex"),
        contentBytes: 1,
        artifactFormat: "html",
      }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(refused.status, 503, `a start while disabled was answered ${refused.status}`);
    assert.equal((await refused.json()).error.code, "publishing_disabled");
    record("ops: publishing disabled refuses a new start");

    const refusedUpload = await uploadArtifact(world, pending);
    assert.equal(refusedUpload.status, 503, `an upload while disabled was answered ${refusedUpload.status}`);
    assert.equal((await refusedUpload.json()).error.code, "publishing_disabled");
    record("ops: publishing disabled refuses an upload");

    const stillReadable = await fetch(`${app.origin}/api/hosted/docs/${owned.documentId}`, {
      headers: { cookie: owned.ownerCookie },
    });
    assert.equal(stillReadable.status, 200, "disabling publishing took away an owner's document");
    record("ops: an owner's existing document is still readable while publishing is disabled");

    const recovery = await publicationStatus(world, owned.publication);
    assert.equal(recovery.status, 200, `receipt recovery while disabled was answered ${recovery.status}`);
    const recovered = await recovery.json();
    assert.equal(recovered.state, "complete", "a completed receipt stopped being recoverable while disabled");
    assert.equal(recovered.result.documentId, owned.documentId);
    const completedRecovery = await fetch(`${app.origin}/api/hosted/docs/${owned.documentId}/content`, {
      headers: { cookie: owned.ownerCookie },
    });
    assert.equal(completedRecovery.status, 200, "disabling publishing broke a completed document's content route");
    record("ops: completed work is still recoverable while publishing is disabled");
  } finally {
    world.env.HOSTED_PUBLISH_ENABLED = "true";
  }

  /* 9.3 The payload bound, at both ends of the protocol. */
  const oversizedDescriptor = await agentFetch(world, "/api/hosted/publications", {
    body: JSON.stringify({
      v: 1,
      title: "Too large",
      contentSha256: createHash("sha256").update("z").digest("hex"),
      contentBytes: limits.HTML_MAX_BYTES + 1,
      artifactFormat: "html",
    }),
    headers: { "content-type": "application/json" },
  });
  /* 413 rather than 400: "your document is too big" is the one refusal a
     client can act on, and it is the same answer the upload route gives for
     the same reason. */
  assert.equal(oversizedDescriptor.status, 413, `an oversized descriptor was answered ${oversizedDescriptor.status}`);
  assert.equal((await oversizedDescriptor.json()).error.code, "artifact_too_large");
  record("ops: a descriptor over the byte cap is refused at the start");

  const oversized = Buffer.alloc(limits.HTML_MAX_BYTES + 1024, 0x61);
  const oversizedUpload = await uploadArtifact(world, pending, oversized);
  assert.equal(oversizedUpload.status, 413, `an oversized artifact was answered ${oversizedUpload.status}`);
  assert.equal((await oversizedUpload.json()).error.code, "artifact_too_large");
  record("ops: an artifact over the byte cap is refused at the upload");

  /* 9.4 Every refusal in this run carried the private header set. An error page
         cached by an intermediary is a private answer served to somebody
         else. */
  for (const [label, response] of [
    ["an unauthorised status", await agentFetch(world, `/api/hosted/publications/${pending.publicationId}/status`, { secret: "not-the-secret" })],
    ["a missing publication", await agentFetch(world, `/api/hosted/publications/${"f".repeat(32)}/status`, { secret: "not-the-secret" })],
    ["a browser header on an agent route", await agentFetch(world, `/api/hosted/publications/${pending.publicationId}/status`, { secret: pending.agentSecret, headers: { origin: app.origin } })],
  ]) {
    assert.ok(response.status >= 400, `${label} was answered ${response.status}`);
    assert.equal(response.headers.get("cache-control"), "private, no-store", `${label} was cacheable`);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    record(`ops: ${label} is private and uncacheable`);
  }

  /* 9.5 The rate rules, and what local evidence can and cannot say about them.
   *
   * The numbers are read off the handler modules' own `config` exports -- the
   * object Netlify packages -- because that is what a deploy carries. What this
   * runner cannot show is that they *work*: they are enforced by the platform's
   * edge, and nothing local implements them. Twelve starts in a row succeeding
   * here is that distinction made concrete rather than asserted in prose, and
   * it is why C6 calls this delayed best-effort mitigation and why AHU-013 owns
   * the live efficacy.
   */
  assert.deepEqual(
    world.modules.start.config.rateLimit,
    { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
    "the start route's pilot rate rule changed",
  );
  assert.deepEqual(
    world.modules.status.config.rateLimit,
    { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
    "the status route's pilot rate rule changed",
  );
  const burst = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    burst.push((await publicationStatus(world, pending)).status);
  }
  assert.ok(
    burst.every((code) => code === 200),
    "the local topology enforced a rate rule, which would make this evidence say something it cannot",
  );
  record("ops: the pilot rate rules are declared on the routes and are not enforced locally");

  /* 9.6 Nothing this run printed carries a capability or a private document.
         Every child process transcript is checked, because a secret in a log is
         the same disclosure as a secret in a response. */
  const secrets = [
    pending.agentSecret,
    owned.publication.agentSecret,
    owned.browserSecret,
    owned.sessionCookie,
    owned.digest,
    DOCUMENT_SENTINEL,
  ].filter((secret) => typeof secret === "string" && secret !== "");
  for (const entry of TRANSCRIPTS) {
    for (const secret of secrets) {
      assert.ok(
        !entry.stdout.includes(secret) && !entry.stderr.includes(secret),
        `${entry.command} ${entry.args[0] ?? ""} printed a secret or private content`,
      );
    }
    assert.ok(
      !entry.args.includes(pending.agentSecret),
      "an operation secret was passed on a command line",
    );
  }
  record("ops: no operation secret or private content reached a client transcript");

  await context.close();
}

/* ------------------------------------------------------------------ *
 * 10. Accessibility.
 * ------------------------------------------------------------------ */

async function accessibility(world, browser, owned) {
  const { app } = world;
  const context = await openContext(world, browser);
  world.provider.state.account = "first";

  /* 10.1 The decision is reachable from the keyboard, and the page's status is
          a live region so a screen reader is told what happened. */
  const publication = await startPublication(world, {
    title: "Keyboard approval",
    html: "<!doctype html><title>k</title><p>keyboard</p>",
  });
  const page = await context.newPage();
  await approveInBrowser(page, publication.verificationUriComplete, { decision: null });

  const status = page.locator("#status");
  assert.equal(await status.getAttribute("role"), "status");
  assert.equal(await status.getAttribute("aria-live"), "polite");
  record("a11y: the approval page's status is a live region");

  await page.locator("#approve").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "approve");
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "deny",
    "Deny is not the next stop after Approve",
  );
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await page.locator("#review").isVisible()) === false, "the keyboard approval to settle");
  const settled = await publicationStatus(world, publication);
  assert.equal((await settled.json()).state, "approved", "the keyboard approval did not approve");
  record("a11y: a publication can be approved entirely from the keyboard");

  await uploadArtifact(world, publication);
  await page.close();

  /* 10.2 The viewer. The title and the account are outside the untrusted
          frame, the frame carries a name assistive technology can announce, and
          sign-out is reachable without a pointer. */
  const view = await openAsOwner(world, context, `${app.origin}/docs/${owned.documentId}`);
  const frameTitle = await view.page.locator(".stage iframe").getAttribute("title");
  assert.notEqual(frameTitle, null, "the renderer frame has no accessible name");
  assert.notEqual(frameTitle.trim(), "", "the renderer frame's accessible name is empty");
  const innerTitle = await view.renderer.locator(".artifact-frame").getAttribute("title");
  assert.equal(innerTitle, "Published document content", "the artifact frame has no accessible name");
  record("a11y: both frames carry a meaningful accessible name");

  const viewerStatus = view.page.locator("[data-archon-status]");
  assert.equal(await viewerStatus.getAttribute("role"), "status");
  assert.equal(await viewerStatus.getAttribute("aria-live"), "polite");
  record("a11y: the viewer announces loading and failure through a live region");

  const signOut = view.page.locator("[data-archon-signout]");
  await signOut.focus();
  assert.equal(
    await view.page.evaluate(() => document.activeElement?.hasAttribute("data-archon-signout")),
    true,
    "sign-out cannot be reached from the keyboard",
  );
  assert.equal(await view.page.locator("[data-archon-title]").innerText(), owned.title);
  assert.match(await view.page.locator("[data-archon-owner]").innerText(), /Signed in as @/);
  record("a11y: the title, the account and sign-out are outside the untrusted frame");

  /* Signing out from the keyboard revokes server-side, not merely in the tab.
     The cookie is captured *before* the press and replayed afterwards: reading
     the jar again after sign-out returns an empty header, and an empty header
     is refused for having no session rather than for having a revoked one --
     which would make this case pass against a server that revoked nothing. */
  const revoked = await cookieHeader(context, app.origin);
  const beforeSignOut = await fetch(`${app.origin}/api/hosted/docs/${owned.documentId}`, {
    headers: { cookie: revoked },
  });
  assert.equal(beforeSignOut.status, 200, "the captured cookie was not a working session");
  await view.page.keyboard.press("Enter");
  await waitFor(async () => {
    const response = await fetch(`${app.origin}/api/hosted/docs/${owned.documentId}`, {
      headers: { cookie: revoked },
    });
    return response.status !== 200;
  }, "the keyboard sign-out to revoke the session");
  record("a11y: signing out from the keyboard revokes the session on the server");

  await context.close();
}
