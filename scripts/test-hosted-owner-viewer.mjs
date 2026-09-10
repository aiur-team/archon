#!/usr/bin/env node
/**
 * AHU-009 — the permanent private-document oracle.
 *
 *   node scripts/test-hosted-owner-viewer.mjs
 *
 * The claim this ticket makes is that a completed document is readable by
 * exactly one account, in a page where the document has no authority, and by
 * nobody else in any form. Half of that claim is about HTTP and can be asserted
 * against a handler; the other half is about what a browser does with a
 * cross-site frame, a sandbox, a `postMessage` and a `Content-Disposition`, and
 * cannot be asserted against a string. So this runner does both, and drives the
 * browser half against real engines and three real loopback origins.
 *
 * Three origins, because the design is about origins:
 *
 *   * the **application** origin, running the *actual* `document-viewer`,
 *     `document-read`, `session` and `logout` handlers over a deterministic
 *     identity store and AHU-004's complete-record fixtures, and serving the
 *     committed `viewer.js` and `viewer.css`;
 *   * the **renderer** origin, a different host serving exactly what
 *     `renderer/scripts/build.mjs` produced with its generated `_headers`;
 *   * an **adversary** origin, which the artifact is invited to reach and which
 *     records every request that arrives, so "blocked" is proven by the absence
 *     of a request at a server rather than by the absence of an exception.
 *
 * Two accounts, because every interesting denial is about the second one. The
 * owner and the stranger are distinct principals with distinct sessions in the
 * same store, and the stranger's requests go through the same handlers.
 *
 * What a pass here does and does not mean. It means the read authorisation and
 * the isolation hold in this engine at this version, over a deterministic store,
 * with a deterministic identity. It is **not** the live capstone: AHU-013 owns
 * real GitHub sessions, deployed origins and real CDN headers, and no number of
 * green cases here substitutes for it. AHU-012 separately owns reconnecting a
 * real upload to a real read; this runner starts from a complete record and does
 * not invoke AHU-008.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");

const PLAYWRIGHT = "playwright@1.55.0";
const ENGINE = "chromium";
const DEADLINE_MS = 420_000;
const INSTALL_DEADLINE_MS = 900_000;
const TERM_GRACE_MS = 2_000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

/* The transcript CI reads. It names the engine and its version, because the
   browser claims are about that engine at that version, and carries the number
   of cases that completed, so a run that returned early cannot print the same
   line as one that finished. */
const TRANSCRIPT = /^PASS {2}hosted owner viewer matrix \(chromium [\w.]+; (\d+) cases\)$/;

/**
 * Every case the worker must complete: the HTTP surface plus the browser matrix.
 *
 * Checked by the supervisor rather than trusted, because the transcript line is
 * the only thing CI reads and a worker that returned early after four cases
 * would otherwise print a `PASS` that reads exactly like a full run.
 */
const EXPECTED_CASES = 38;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * Supervisor.
 * ------------------------------------------------------------------ */

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
 * a browser that outlived a killed worker would otherwise be left running.
 */
async function parent() {
  const tempRoot = await mkdtemp(join(tmpdir(), "ahu009-viewer-"));
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
          AHU009_NONCE: nonce,
          AHU009_TEMP_ROOT: tempRoot,
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
      problems.push("the worker did not echo the supervisor nonce");
    }

    if (problems.length > 0) {
      for (const line of stderr.split("\n").slice(-25)) {
        if (line !== "") process.stderr.write(`${line}\n`);
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`FAIL hosted owner viewer: ${problem}\n`);
    process.exit(1);
  }
  for (const line of stdout.split("\n")) {
    if (line.startsWith("INFO") || TRANSCRIPT.test(line)) process.stdout.write(`${line}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures.
 * ------------------------------------------------------------------ */

/**
 * The artifact, as a self-contained document that tries everything.
 *
 * It is a real document with a real control -- a button that draws a chart -- so
 * "the artifact works" is asserted by driving it rather than by seeing markup.
 * Around that, it makes one attempt at each authority it must not have and
 * records the outcome of every attempt in its own DOM, where the matrix reads
 * them. Recording in the DOM rather than throwing is deliberate: an attempt that
 * *succeeded* has to be visible, and a payload that fails loudly on the first
 * denial would hide the second.
 *
 * The two absolute URLs are interpolated because the origins are only known once
 * the servers are listening. They are the adversary's beacon and the account
 * API; both are meant never to be reached.
 */
function artifactHtml({ appOrigin, evilOrigin }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Quarterly figures</title>
<style>#chart{display:flex;gap:4px;align-items:flex-end;height:60px}
#chart i{background:#48c;width:12px;display:block}</style>
</head>
<body>
<h1 id="heading">Quarterly figures</h1>
<button id="draw" type="button">Draw chart</button>
<div id="chart"></div>
<p id="state">idle</p>
<pre id="probe"></pre>
<script>
(function () {
  var results = [];
  function attempt(name, run) {
    try {
      var value = run();
      results.push(name + "=" + (value === undefined ? "undefined" : String(value)));
    } catch (error) {
      results.push(name + "=blocked");
    }
    document.getElementById("probe").textContent = results.join("\\n");
  }

  document.getElementById("draw").addEventListener("click", function () {
    var chart = document.getElementById("chart");
    chart.textContent = "";
    [30, 55, 20, 60].forEach(function (height) {
      var bar = document.createElement("i");
      bar.style.height = height + "px";
      chart.appendChild(bar);
    });
    document.getElementById("state").textContent = "drawn:" + chart.children.length;
  });

  attempt("parentDom", function () { return parent.document.title; });
  attempt("topDom", function () { return top.document.title; });
  attempt("parentLocation", function () { return parent.location.href; });
  attempt("cookie", function () { return document.cookie === "" ? "empty" : "readable"; });
  attempt("localStorage", function () { return localStorage.length; });
  attempt("origin", function () { return String(window.origin); });
  attempt("apiFetch", function () {
    fetch(${JSON.stringify(`${appOrigin}/api/hosted/session`)}, { credentials: "include" });
    return "issued";
  });
  attempt("beacon", function () {
    var image = new Image();
    image.src = ${JSON.stringify(`${evilOrigin}/beacon?from=artifact`)};
    return "issued";
  });
  attempt("resize", function () { return String(window.frameElement); });
})();
</script>
</body>
</html>
`;
}

/** A complete AHU-004 record whose descriptor actually describes `html`. */
function completeRecordFor(base, html, title) {
  const bytes = new TextEncoder().encode(html);
  return {
    ...base,
    html,
    descriptor: {
      ...base.descriptor,
      title,
      contentBytes: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The three loopback origins.
 * ------------------------------------------------------------------ */

function listen(server, host) {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(`http://${host}:${server.address().port}`));
  });
}

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

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** The `_headers` the renderer build generated, replayed exactly. */
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

/** A page on the renderer origin that is not the renderer. */
const FORGE_PATH = "/_forge.html";
/**
 * The renderer origin: the built tree, plus one page that is not it.
 *
 * `_forge.html` is the whole point of the source check. It is served from the
 * *correct* origin, so a message it posts to the viewer has a flawless
 * `event.origin` and the wrong `event.source` -- which is the one forgery an
 * origin comparison alone cannot see. It records every message it receives, so
 * "the document was not sent here" is an assertion about a list rather than
 * about an absence of errors.
 *
 */
async function startRenderer() {
  /* The port has to exist before the bundle can, because the bundle's
     `frame-ancestors` names the application origin and the application's
     configuration names this one. So the server is bound first and the built
     tree is loaded into it afterwards, before any browser is started. */
  let headers = [];
  let files = new Map();
  const state = { requests: [] };

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname });
    const common = Object.fromEntries(headers);

    if (url.pathname === FORGE_PATH) {
      /* It announces readiness *repeatedly*. A single message at load is easy
         for the viewer to be safe from by accident -- it arrives before the
         renderer frame exists, and a null frame is refused by a guard that has
         nothing to do with who sent the message. An attacker would not stop at
         one, and neither does this: the interval guarantees a forged message
         lands in the window where the viewer has a frame and is waiting for it
         to speak, which is the only moment the source check is what refuses it. */
      const script =
        'window.__seen=[];addEventListener("message",function(e){window.__seen.push(String(e.data&&e.data.type))});'
        + 'setInterval(function(){top.postMessage({type:"archon:ready",v:1},"*");},50);';
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

/** The adversary: it records, and it is never reached. */
async function startEvil() {
  const state = { requests: [] };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname, search: url.search });
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end("recorded");
  });
  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close, state };
}

/* ------------------------------------------------------------------ *
 * The application origin: the real handlers.
 * ------------------------------------------------------------------ */

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

/**
 * The application: the actual handlers, over a memory identity store and the
 * AHU-004 provider double seeded with real complete records.
 *
 * Nothing here re-implements a route. `/docs/<id>`, `/api/hosted/docs/<id>`,
 * `/api/hosted/docs/<id>/content`, `/api/hosted/session` and
 * `/api/hosted/auth/logout` are the exported production handlers, and the only
 * injected values are the store, the clock and the configuration -- which is the
 * same seam `hosted/test/` uses and the same code path the deploy runs.
 *
 * The three paths that are *not* production are prefixed `/_` and exist to give
 * the browser something to look at: a stand-in sign-in page that records where a
 * redirect landed, a page that frames the raw-content endpoint, and a beacon.
 */
async function startApp(handlers) {
  const state = { requests: [], loginArrivals: [], beacons: [] };

  const server = createServer((nodeRequest, nodeResponse) => {
    void (async () => {
      const url = new URL(nodeRequest.url, "http://127.0.0.1");
      state.requests.push({
        method: nodeRequest.method,
        path: url.pathname,
        search: url.search,
        cookie: nodeRequest.headers.cookie ?? "",
      });

      const inert = (status, type, body, headers = {}) => {
        nodeResponse.writeHead(status, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          ...headers,
        });
        nodeResponse.end(nodeRequest.method === "HEAD" ? undefined : body);
      };

      /* The stand-in sign-in page. The real one belongs to AHU-003 and needs the
         start route and a provider; what this case is about is *where the viewer
         sent the reader*, so the page records its own query and says so. */
      if (url.pathname === "/login/" || url.pathname === "/login") {
        state.loginArrivals.push(url.search);
        return inert(
          200,
          "text/html; charset=utf-8",
          '<!doctype html><meta charset="utf-8"><title>Sign in</title>'
            + '<h1 id="signin">Sign in</h1><p id="destination"></p>'
            + '<script>document.getElementById("destination").textContent='
            + 'new URL(location.href).searchParams.get("destination")||"";<\/script>',
        );
      }
      /* The one route that hands out a session without a provider round trip.
         It sets the *production* cookie through `serializeCookie`, so the
         browser has to accept the real attributes; it does not mint a session,
         only carry one the deterministic store already issued. */
      if (url.pathname === "/_signin") {
        const token = url.searchParams.get("token") ?? "";
        return inert(
          200,
          "text/html; charset=utf-8",
          '<!doctype html><meta charset="utf-8"><title>signed in</title>',
          { "Set-Cookie": handlers.serializeCookie(token) },
        );
      }
      if (url.pathname === "/_beacon") {
        state.beacons.push(url.search);
        return inert(200, "text/plain; charset=utf-8", "recorded");
      }
      if (url.pathname === "/_raw-frame") {
        /* An account-origin page that frames the raw endpoint directly. If the
           bytes were ever treated as a document here they would run with this
           origin's authority, and `__pwned` on this window would be set. */
        return inert(
          200,
          "text/html; charset=utf-8",
          '<!doctype html><meta charset="utf-8"><title>raw</title>'
            + '<script>window.__pwned=false;<\/script>'
            + `<iframe id="raw" src="/api/hosted/docs/${url.searchParams.get("id")}/content"></iframe>`,
        );
      }
      if (url.pathname === "/viewer.js" || url.pathname === "/viewer.css") {
        const body = await readFile(join(ROOT, "hosted", "public", url.pathname.slice(1)));
        return inert(200, CONTENT_TYPES[url.pathname.slice(url.pathname.lastIndexOf("."))], body);
      }

      const request = await toRequest(nodeRequest, "http://127.0.0.1");
      const head = nodeRequest.method === "HEAD";
      let handler = null;
      if (/^\/docs\//.test(url.pathname)) handler = handlers.viewer;
      else if (/^\/api\/hosted\/docs\//.test(url.pathname)) handler = handlers.read;
      else if (url.pathname === "/api/hosted/session") handler = handlers.session;
      else if (url.pathname === "/api/hosted/auth/logout") handler = handlers.logout;

      if (handler === null) return inert(404, "text/plain; charset=utf-8", "not found");
      return writeResponse(await handler(request), nodeResponse, { head });
    })().catch((error) => {
      nodeResponse.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      nodeResponse.end(`worker fault: ${error.message}`);
    });
  });

  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close, state };
}

/* ------------------------------------------------------------------ *
 * The HTTP half: what no browser is needed to prove.
 * ------------------------------------------------------------------ */

async function fetchApp(origin, path, { token = null, method = "GET", headers = {} } = {}) {
  const sent = new Headers(headers);
  if (token !== null) sent.set("cookie", `__Host-archon_session=${token}`);
  return fetch(`${origin}${path}`, { method, headers: sent, redirect: "manual" });
}

/**
 * The three routes, over HTTP, for every principal and every id shape.
 *
 * This is the half of the acceptance that a browser would only make slower. It
 * covers the method matrix, query variants, the trailing-slash and alias
 * spellings a deployment may expose, conditional requests, and the rule that a
 * denial's *whole response* -- headers included -- carries no marker of the
 * document it refused.
 */
async function assertHttpSurface({ app, ids, tokens, records, markers, base }) {
  const cases = [];
  const record = (label) => cases.push(label);

  /* Owner reads, on every spelling of both API routes. */
  for (const path of [
    `/api/hosted/docs/${ids.owned}`,
    `/api/hosted/docs/${ids.owned}/`,
    `/api/hosted/docs/${ids.owned}?download=1`,
  ]) {
    const response = await fetchApp(app.origin, path, { token: tokens.owner });
    assert.equal(response.status, 200, `owner metadata at ${path}`);
    const body = await response.json();
    assert.equal(body.documentId, ids.owned);
    assert.equal(body.title, records.owned.descriptor.title);
    assert.equal(body.contentSha256, records.owned.descriptor.contentSha256);
    record(`metadata:${path}`);
  }

  const content = await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}/content`, {
    token: tokens.owner,
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "application/octet-stream");
  assert.equal(
    content.headers.get("content-disposition"),
    'attachment; filename="archon-document.html"',
  );
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.equal(content.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(content.headers.get("cache-control"), "private, no-store");
  assert.equal(content.headers.get("netlify-cdn-cache-control"), "no-store");
  const bytes = new Uint8Array(await content.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    records.owned.descriptor.contentSha256,
    "the owner's bytes do not hash to the approved digest",
  );
  record("content:owner");

  /* The owner's *own* metadata is the response a projection bug leaks through:
     every denial assertion above is about somebody who gets nothing, so a
     handler that serialised the whole record would satisfy all of them. */
  const owned = await (await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}`, {
    token: tokens.owner,
  })).text();
  for (const forbidden of [
    base.agentSecretHash,
    base.browserSecretHash,
    base.userCode,
    records.owned.html.slice(0, 48),
    '"agentSecretHash"',
    '"browserSecretHash"',
    '"html"',
    '"state"',
  ]) {
    assert.ok(!owned.includes(forbidden), `owner metadata carried ${forbidden.slice(0, 24)}`);
  }
  record("metadata:no-envelope");

  /* The byte-order-mark document, whose whole point is the byte-exact round
     trip. It is a second complete record with a BOM at the front. */
  const bom = await fetchApp(app.origin, `/api/hosted/docs/${ids.bom}/content`, {
    token: tokens.owner,
  });
  const bomBytes = new Uint8Array(await bom.arrayBuffer());
  assert.deepEqual([...bomBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "the BOM was not preserved");
  assert.equal(
    createHash("sha256").update(bomBytes).digest("hex"),
    records.bom.descriptor.contentSha256,
  );
  record("content:bom");

  /* Every denial. The surface -- status, headers and body together -- must carry
     no marker of any document, and every denial must look the same. */
  const denials = new Map();
  for (const [label, path, token] of [
    ["other-account-metadata", `/api/hosted/docs/${ids.owned}`, tokens.stranger],
    ["other-account-content", `/api/hosted/docs/${ids.owned}/content`, tokens.stranger],
    ["missing-id", `/api/hosted/docs/${"a".repeat(32)}`, tokens.owner],
    ["pending-record", `/api/hosted/docs/${ids.pending}`, tokens.owner],
    ["approved-record", `/api/hosted/docs/${ids.approved}`, tokens.owner],
    ["expired-record", `/api/hosted/docs/${ids.expired}`, tokens.owner],
    ["malformed-id", "/api/hosted/docs/not-a-publication-id", tokens.owner],
    ["uppercase-id", `/api/hosted/docs/${ids.owned.toUpperCase()}`, tokens.owner],
    ["escaped-id", "/api/hosted/docs/%zz", tokens.owner],
    ["alias-path", `/api/hosted/docs/${ids.owned}/html`, tokens.owner],
  ]) {
    const response = await fetchApp(app.origin, path, { token });
    assert.equal(response.status, 404, `${label} was not a 404`);
    const text = await response.text();
    const surface = [...response.headers].map(([n, v]) => `${n}: ${v}`).join("\n") + "\n" + text;
    for (const marker of markers) {
      assert.ok(!surface.includes(marker), `${label} disclosed ${JSON.stringify(marker.slice(0, 20))}`);
    }
    denials.set(label, text);
    record(`denial:${label}`);
  }
  assert.equal(
    new Set(denials.values()).size,
    1,
    `denials are distinguishable: ${[...new Set(denials.values())].length} distinct bodies`,
  );

  /* Signed out. Distinct from a denial, and identical for every id, so it is not
     an oracle for which ids exist. */
  const anonymous = new Set();
  for (const id of [ids.owned, "a".repeat(32), ids.pending]) {
    const response = await fetchApp(app.origin, `/api/hosted/docs/${id}`);
    assert.equal(response.status, 401);
    anonymous.add(await response.text());
  }
  assert.equal(anonymous.size, 1, "the signed-out answer varies by document");
  record("denial:signed-out");

  /* An operation bearer is not a read capability. */
  const bearer = await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}/content`, {
    headers: { authorization: "Bearer an-operation-capability-that-is-not-a-session" },
  });
  assert.equal(bearer.status, 401, "an agent bearer read a private document");
  record("denial:agent-bearer");

  /* HEAD authorises exactly as GET does, on all three routes. */
  for (const [label, path, token, status] of [
    ["head-owner-metadata", `/api/hosted/docs/${ids.owned}`, tokens.owner, 200],
    ["head-owner-content", `/api/hosted/docs/${ids.owned}/content`, tokens.owner, 200],
    ["head-stranger-content", `/api/hosted/docs/${ids.owned}/content`, tokens.stranger, 404],
    ["head-page-owner", `/docs/${ids.owned}`, tokens.owner, 200],
    ["head-page-anonymous", `/docs/${ids.owned}`, null, 303],
  ]) {
    const response = await fetchApp(app.origin, path, { token, method: "HEAD" });
    assert.equal(response.status, status, label);
    assert.equal((await response.arrayBuffer()).byteLength, 0, `${label} returned a body`);
    record(label);
  }

  /* No pre-authorisation cache shortcut: a conditional request is answered on
     its merits, never with a 304 that skipped the owner check. */
  for (const token of [tokens.owner, tokens.stranger, null]) {
    const response = await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}/content`, {
      token,
      headers: { "if-none-match": "*", "if-modified-since": "Thu, 01 Jan 1970 00:00:00 GMT" },
    });
    assert.notEqual(response.status, 304, "a conditional request short-circuited authorisation");
    assert.equal(response.headers.get("etag"), null, "a private response carried an ETag");
    await response.arrayBuffer();
  }
  record("conditional-requests");

  /* No CORS grant anywhere: a cross-origin browser read is not permitted even
     for the owner. */
  const cors = await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}`, {
    token: tokens.owner,
    headers: { origin: "https://evil.example" },
  });
  assert.equal(cors.headers.get("access-control-allow-origin"), null, "the read routes grant CORS");
  await cors.text();
  record("no-cors");

  return cases.length;
}

/* ------------------------------------------------------------------ *
 * The browser matrix.
 * ------------------------------------------------------------------ */

const ARTIFACT_URL = "about:srcdoc";

async function waitFor(check, message, { timeout = 15_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() > deadline) {
      const text = typeof message === "function" ? await message() : message;
      throw new Error(`${text} (last: ${JSON.stringify(last)})`);
    }
    await new Promise((done) => setTimeout(done, interval));
  }
}

/** The trusted status line, which is where every state change is announced. */
const statusOf = (page) => page.locator("[data-archon-status]").innerText();

/**
 * Sign a principal in by asking the application to set the cookie.
 *
 * Deliberately a server round trip rather than `context.addCookies`. The cookie
 * production sets is `__Host-`-prefixed, `Secure`, `HttpOnly` and `SameSite=Lax`,
 * and every one of those attributes changes what a browser will do with it. A
 * cookie planted through the automation API is a cookie the browser never had to
 * accept, so a session that a real `Set-Cookie` could not have established would
 * still work here -- which is the one thing this fixture must not paper over.
 * `serializeCookie` from `hosted/lib/identity.mjs` produces the header, so the
 * attributes are production's rather than this file's.
 */
async function signIn(context, appOrigin, token) {
  await context.clearCookies();
  if (token === null) return;
  const page = await context.newPage();
  await page.goto(`${appOrigin}/_signin?token=${encodeURIComponent(token)}`);
  const accepted = await page.evaluate(() => document.title);
  assert.equal(accepted, "signed in", "the fixture sign-in page did not load");
  await page.close();
  /* Unfiltered: `context.cookies(url)` will not report a `Secure` cookie for an
     `http://` URL, even though Chromium both stores it and sends it, because
     loopback is a trustworthy origin. Filtering by the loopback URL here reported
     "refused" for a cookie the browser had accepted. */
  const cookies = await context.cookies();
  assert.ok(
    cookies.some((cookie) => cookie.name === "__Host-archon_session" && cookie.value === token),
    "the browser refused the production session cookie",
  );
}

/**
 * Every browser case, in order. Each returns nothing and throws on failure; the
 * count of them is what the transcript reports.
 */
function browserCases({ app, renderer, evil, ids, tokens, records }) {
  const page = (path) => `${app.origin}${path}`;

  return [
    ["the owner sees trusted chrome and a working artifact", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.owned}`));

      await waitFor(
        async () => (await tab.locator("[data-archon-title]").innerText()) === records.owned.descriptor.title,
        "the trusted title never showed the document's title",
      );
      assert.match(await tab.locator("[data-archon-owner]").innerText(), /Signed in as @/);
      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "rendered",
        async () => {
          const dump = {
            state: await tab.getAttribute("html", "data-archon-state"),
            status: await statusOf(tab),
            frames: tab.frames().map((f) => f.url()),
            rendererState: await tab
              .frames()
              .find((f) => f.url().startsWith(renderer.origin))
              ?.evaluate(() => document.documentElement.getAttribute("data-archon-state"))
              .catch((e) => `err:${e.message}`),
          };
          return `the viewer never reached the rendered state ${JSON.stringify(dump)}`;
        },
      );

      /* The trusted regions are siblings of the frame, not inside it. */
      const insideFrame = await tab.evaluate(() => {
        const frame = document.querySelector("[data-archon-renderer]");
        return ["[data-archon-title]", "[data-archon-owner]", "[data-archon-signout]", "[data-archon-status]"]
          .map((selector) => frame.contains(document.querySelector(selector)));
      });
      assert.deepEqual(insideFrame, [false, false, false, false], "trusted chrome is inside the frame");

      /* The account-origin document contains no authored node. This is the
         "do not fall back to inserting authored HTML in the account document"
         rule as an assertion about the DOM rather than about a policy: an
         `innerHTML` fallback added to `viewer.js` would put the artifact's own
         elements here, on the origin holding the session cookie, and every
         other case in this matrix would stay green. The stage holds exactly one
         child and it is the renderer frame. */
      const shell = await tab.evaluate(() => {
        const stage = document.querySelector("[data-archon-stage]");
        return {
          authoredIds: ["draw", "chart", "probe", "state", "heading"]
            .filter((id) => document.getElementById(id) !== null),
          stageChildren: [...stage.children].map((child) => child.localName),
          scriptSources: [...document.querySelectorAll("script")].map((s) => s.getAttribute("src")),
        };
      });
      assert.deepEqual(shell.authoredIds, [], "authored elements are in the account document");
      assert.deepEqual(shell.stageChildren, ["iframe"], "the stage holds more than the frame");
      assert.deepEqual(shell.scriptSources, ["/viewer.js"], "the trusted page grew a script");

      /* The artifact is two frames down, and its own control works. */
      const artifact = await waitFor(
        async () => tab.frames().find((frame) => frame.url() === ARTIFACT_URL) ?? null,
        "the artifact frame never appeared",
      );
      assert.equal(await artifact.locator("#heading").innerText(), "Quarterly figures");
      await artifact.locator("#draw").click();
      await waitFor(
        async () => (await artifact.locator("#state").innerText()) === "drawn:4",
        "the artifact's own control did not work inside the renderer",
      );
      await tab.close();
    }],

    ["the artifact has no authority over the account page", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      const beaconsBefore = evil.state.requests.length;
      const appRequestsBefore = app.state.requests.length;
      await tab.goto(page(`/docs/${ids.owned}`));
      const artifact = await waitFor(
        async () => tab.frames().find((frame) => frame.url() === ARTIFACT_URL) ?? null,
        "the artifact frame never appeared",
      );
      const probe = await waitFor(
        async () => {
          const text = await artifact.locator("#probe").innerText();
          return text.includes("resize=") ? text : null;
        },
        "the artifact never finished its probe",
      );
      const results = Object.fromEntries(
        probe.split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );

      for (const key of ["parentDom", "topDom", "parentLocation", "localStorage"]) {
        assert.equal(results[key], "blocked", `the artifact reached ${key}`);
      }
      /* Either answer is a pass and the difference is engine detail: an opaque
         origin makes `document.cookie` throw in some engines and return an empty
         string in others. What must never appear is `readable`. */
      assert.ok(
        results.cookie === "empty" || results.cookie === "blocked",
        `the artifact saw a cookie (${results.cookie})`,
      );
      /* An opaque origin serialises to `"null"`; engines differ on whether the
         legacy `document.origin` says so, but `window.origin` is the spelling
         the standard defines. The assertion that matters either way is that it
         is not one of the two real origins on the page. */
      assert.equal(
        results.origin,
        "null",
        `the artifact does not have an opaque origin (${results.origin})`,
      );
      assert.ok(!results.origin.includes(app.origin) && !results.origin.includes(renderer.origin));

      /* The two network attempts are proven blocked at the servers, not by an
         exception: an exception is what a fetch throws for a dozen reasons, and
         the assertion that has teeth is that no request ever arrived. */
      await new Promise((done) => setTimeout(done, 750));
      assert.equal(
        evil.state.requests.length,
        beaconsBefore,
        "the artifact reached the adversary origin",
      );
      const newAppRequests = app.state.requests.slice(appRequestsBefore);
      assert.ok(
        !newAppRequests.some((request) => request.path === "/api/hosted/session" && request.cookie === ""),
        "an unexpected session request arrived",
      );
      assert.equal(
        newAppRequests.filter((r) => r.path.startsWith("/api/hosted/docs/")).length,
        2,
        "the account API was called a number of times the viewer does not explain",
      );
      await tab.close();
    }],

    ["a stored title of executable markup is text, not markup", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      await tab.evaluate(() => {}).catch(() => {});
      await tab.goto(page(`/docs/${ids.hostileTitle}`));
      await waitFor(
        async () => (await tab.locator("[data-archon-title]").innerText()).includes("<script>"),
        "the hostile title never appeared as text",
      );
      const injected = await tab.evaluate(() => ({
        scripts: document.querySelectorAll("[data-archon-title] script, [data-archon-title] img").length,
        marker: window.__titleRan === true,
      }));
      assert.equal(injected.scripts, 0, "the title was parsed as markup");
      assert.equal(injected.marker, false, "the title executed");
      await tab.close();
    }],

    ["a signed-out reader is sent to the local sign-in flow", async (context) => {
      await signIn(context, app.origin, null);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.owned}`));
      await waitFor(
        async () => (await tab.locator("#destination").innerText()) === `/docs/${ids.owned}`,
        "the signed-out reader did not land on sign-in with this document as the destination",
      );
      assert.match(tab.url(), /\/login\//);
      await tab.close();
    }],

    ["another account is told nothing, in the page and over the API", async (context) => {
      await signIn(context, app.origin, tokens.stranger);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.owned}`));
      await waitFor(
        async () => (await statusOf(tab)).includes("no document at this address"),
        "the stranger was not refused",
      );
      const html = await tab.content();
      assert.ok(!html.includes(records.owned.descriptor.title), "the stranger saw the title");
      assert.ok(!html.includes(records.owned.descriptor.contentSha256), "the stranger saw the digest");
      assert.equal(tab.frames().filter((frame) => frame.url() === ARTIFACT_URL).length, 0);
      await tab.close();
    }],

    ["a missing document and a malformed id are the same dead end", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const missing = await context.newPage();
      await missing.goto(page(`/docs/${"a".repeat(32)}`));
      await waitFor(
        async () => (await statusOf(missing)).includes("no document at this address"),
        "a missing document did not report a dead end",
      );

      const malformed = await context.newPage();
      const response = await malformed.goto(page("/docs/nope"));
      assert.equal(response.status(), 404);
      assert.equal(await malformed.locator("h1").innerText(), "Not found");
      await missing.close();
      await malformed.close();
    }],

    ["a pending record is not readable by its future owner", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.pending}`));
      await waitFor(
        async () => (await statusOf(tab)).includes("no document at this address"),
        "a pending publication was readable",
      );
      await tab.close();
    }],

    ["the raw endpoint does not execute on the account origin", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      await tab.goto(page(`/_raw-frame?id=${ids.owned}`));
      await new Promise((done) => setTimeout(done, 1000));
      const pwned = await tab.evaluate(() => window.__pwned === true);
      assert.equal(pwned, false, "the raw bytes ran on the account origin");
      const frames = tab.frames().filter((frame) => frame !== tab.mainFrame());
      for (const frame of frames) {
        const heading = await frame.locator("#heading").count().catch(() => 0);
        assert.equal(heading, 0, "the raw endpoint was rendered as a document");
      }
      await tab.close();
    }],

    ["a forged readiness message from the renderer origin gets nothing", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();

      /* The forgery has to arrive *first*, and this case is only worth running
         if it does. A forged readiness message that lands after the document is
         already displayed is refused by a guard that has nothing to do with who
         sent it, so an earlier version of this case passed with the source check
         deleted -- it was testing the "one artifact per renderer" rule twice.
         So the real renderer's own document is held for two seconds while a
         second frame from the renderer origin announces readiness every fifty
         milliseconds. For those two seconds the viewer has a frame, is waiting
         for it to speak, and is being told it has -- by the wrong window, from
         the right origin. The source check is the only thing refusing. */
      await tab.route(`${renderer.origin}/`, async (route) => {
        await new Promise((done) => setTimeout(done, 2000));
        await route.continue();
      });
      await tab.addInitScript((forge) => {
        document.addEventListener("DOMContentLoaded", () => {
          const frame = document.createElement("iframe");
          frame.id = "forge";
          frame.src = forge;
          document.body.appendChild(frame);
        });
      }, `${renderer.origin}${FORGE_PATH}`);

      await tab.goto(page(`/docs/${ids.owned}`));

      /* The forged message is seen and discarded, and the real handshake still
         completes. With the source check removed the viewer acts on the forgery,
         hands the bytes to a frame whose renderer has not loaded yet, and marks
         itself rendered -- so this wait is what fails. */
      const artifact = await waitFor(
        async () => tab.frames().find((frame) => frame.url() === ARTIFACT_URL) ?? null,
        async () =>
          `a forged readiness message consumed the hand-off ${JSON.stringify({
            state: await tab.getAttribute("html", "data-archon-state"),
            status: await statusOf(tab),
          })}`,
        { timeout: 30_000 },
      );
      assert.equal(await tab.getAttribute("html", "data-archon-state"), "rendered");
      assert.equal(await artifact.locator("#heading").innerText(), "Quarterly figures");

      /* And the forger itself received nothing. */
      const seen = await tab.evaluate(() => {
        const frame = document.getElementById("forge");
        try {
          return frame.contentWindow.__seen ?? ["unreadable"];
        } catch {
          return ["unreadable"];
        }
      });
      assert.ok(
        !seen.includes("archon:render"),
        "the viewer sent the private document to a forged window",
      );
      await tab.close();
    }],

    ["a renderer that never says it is ready fails visibly and recovers", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      /* The frame is pointed at a renderer-origin page that mounts nothing,
         which is what a renderer that failed to load looks like from here. */
      /* The renderer origin is made to answer with a document that mounts
         nothing, which is what a renderer that failed to load looks like from
         here. It is served in place rather than as a redirect: a redirect is
         cacheable, and Chromium replayed the cached one on the retry, so the
         recovery half of this case could never have passed. */
      let silent = true;
      await tab.route(`${renderer.origin}/`, (route) =>
        silent
          ? route.fulfill({
              status: 200,
              contentType: "text/html; charset=utf-8",
              headers: { "cache-control": "no-store" },
              body: '<!doctype html><meta charset="utf-8"><title>silent renderer</title>',
            })
          : route.continue(),
      );
      await tab.goto(page(`/docs/${ids.owned}`));

      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "renderer-timeout",
        "the readiness deadline never fired",
        { timeout: 40_000 },
      );
      assert.match(await statusOf(tab), /did not start/);
      const focused = await tab.evaluate(() =>
        document.activeElement?.hasAttribute("data-archon-retry-button"),
      );
      assert.equal(focused, true, "focus did not move to the retry control");

      /* And the retry works once the renderer is reachable again, which needs a
         *new* renderer document -- the frame is replaced, not re-messaged. */
      silent = false;
      await tab.keyboard.press("Enter");
      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "rendered",
        async () =>
          `the retry never recovered the document ${JSON.stringify({
            state: await tab.getAttribute("html", "data-archon-state"),
            status: await statusOf(tab),
            frames: tab.frames().map((f) => f.url()),
          })}`,
        { timeout: 30_000 },
      );
      await tab.close();
    }],

    ["a content-fetch outage is reported, not rendered blank", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      let failing = true;
      await tab.route(`${app.origin}/api/hosted/docs/${ids.owned}/content`, (route) =>
        failing ? route.fulfill({ status: 503, body: "{}" }) : route.continue(),
      );
      await tab.goto(page(`/docs/${ids.owned}`));
      await waitFor(
        async () => (await statusOf(tab)).includes("could not load"),
        "a content outage was not reported",
      );
      const retryVisible = await tab.locator("[data-archon-retry-button]").isVisible();
      assert.equal(retryVisible, true, "no retry was offered after a content outage");

      failing = false;
      await tab.locator("[data-archon-retry-button]").click();
      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "rendered",
        "the retry did not recover after the outage cleared",
        { timeout: 30_000 },
      );
      await tab.close();
    }],

    ["sign-out is a protected POST and revokes the session server-side", async (context) => {
      await signIn(context, app.origin, tokens.signOut);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.owned}`));
      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "rendered",
        "the viewer never rendered before sign-out",
      );

      /* Reached and pressed from the keyboard alone. */
      await tab.locator("[data-archon-signout]").focus();
      const before = app.state.requests.length;
      await tab.keyboard.press("Enter");

      await waitFor(
        async () => (await tab.locator("#destination").innerText()) === `/docs/${ids.owned}`,
        "signing out did not land the reader back on sign-in for this document",
        { timeout: 20_000 },
      );
      const logouts = app.state.requests
        .slice(before)
        .filter((request) => request.path === "/api/hosted/auth/logout");
      assert.equal(logouts.length, 1, "sign-out did not POST once");
      assert.equal(logouts[0].method, "POST", "sign-out was not a POST");

      /* And the revoked token is dead on the server, not merely cleared in the
         browser: the same cookie, replayed, reads nothing. */
      const replay = await fetchApp(app.origin, `/api/hosted/docs/${ids.owned}/content`, {
        token: tokens.signOut,
      });
      assert.equal(replay.status, 401, "a revoked session still read a document");
      await replay.text();
      await tab.close();
    }],

    ["the renderer frame is announced, and the keyboard reaches every control", async (context) => {
      await signIn(context, app.origin, tokens.owner);
      const tab = await context.newPage();
      await tab.goto(page(`/docs/${ids.owned}`));
      await waitFor(
        async () => (await tab.getAttribute("html", "data-archon-state")) === "rendered",
        "the viewer never rendered",
      );

      const frameTitle = await tab.getAttribute("[data-archon-renderer]", "title");
      assert.equal(frameTitle, "Document renderer", "the renderer frame has no useful title");
      const artifact = tab.frames().find((frame) => frame.url() === ARTIFACT_URL);
      const artifactFrameTitle = await tab
        .frames()
        .find((frame) => frame.url().startsWith(renderer.origin))
        .locator(".artifact-frame")
        .getAttribute("title");
      assert.equal(artifactFrameTitle, "Published document content");
      assert.ok(artifact, "no artifact frame");

      const live = await tab.evaluate(() => {
        const status = document.querySelector("[data-archon-status]");
        return { role: status.getAttribute("role"), live: status.getAttribute("aria-live") };
      });
      assert.deepEqual(live, { role: "status", live: "polite" });

      /* Tab from the top of the document and require sign-out to be reachable
         without a pointer. */
      await tab.evaluate(() => document.body.focus());
      let reachedSignOut = false;
      for (let step = 0; step < 6 && !reachedSignOut; step += 1) {
        await tab.keyboard.press("Tab");
        reachedSignOut = await tab.evaluate(
          () => document.activeElement?.hasAttribute("data-archon-signout") === true,
        );
      }
      assert.equal(reachedSignOut, true, "sign-out is not reachable from the keyboard");
      await tab.close();
    }],
  ];
}

/* ------------------------------------------------------------------ *
 * Worker.
 * ------------------------------------------------------------------ */

/** A distinct 32-hex publication id per fixture, derived and not random. */
const idFor = (label) => createHash("sha256").update(`ahu009:${label}`).digest("hex").slice(0, 32);

async function worker() {
  const nonce = process.env.AHU009_NONCE ?? "";
  const tempRoot = process.env.AHU009_TEMP_ROOT ?? "";
  if (!NONCE_PATTERN.test(nonce)) die("the worker was started without a supervisor nonce");
  if (tempRoot === "") die("the worker was started without a temporary root");

  const hosted = (path) => import(pathToFileURL(join(ROOT, "hosted", path)).href);
  const { createPublicationStore } = await hosted("lib/publication-store.mjs");
  const { createViewerRoute } = await hosted("functions/document-viewer.mjs");
  const { createDocumentReadRoutes } = await hosted("functions/document-read.mjs");
  const { createSessionRoute } = await hosted("functions/session.mjs");
  const { createLogoutRoute } = await hosted("functions/auth-logout.mjs");
  const { withErrorBoundary } = await hosted("lib/http.mjs");
  const { SESSION_COOKIE_MAX_AGE, serializeCookie } = await hosted("lib/identity.mjs");
  const { readHostedConfig } = await hosted("lib/config.mjs");
  const authFixtures = await hosted("test/fixtures/auth.mjs");
  const publicationFixtures = await hosted("test/fixtures/publications.mjs");
  const storeHelpers = await hosted("test/helpers/publication-store.mjs");
  const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);

  /* Ports first: the renderer's `frame-ancestors` names the application origin,
     the application's configuration names the renderer origin, and the artifact
     names the adversary. None of the three can be written before all three are
     bound. */
  const evil = await startEvil();
  const renderer = await startRenderer();
  const handlers = {};
  const app = await startApp(handlers);

  const ids = {
    owned: idFor("owned"),
    bom: idFor("bom"),
    hostileTitle: idFor("hostile-title"),
    pending: idFor("pending"),
    approved: idFor("approved"),
    expired: idFor("expired"),
  };

  const html = artifactHtml({ appOrigin: app.origin, evilOrigin: evil.origin });
  const base = publicationFixtures.RECORDS.complete;
  const records = {
    owned: { ...completeRecordFor(base, html, "Quarterly figures"), id: ids.owned },
    bom: { ...completeRecordFor(base, `﻿${html}`, "With a byte-order mark"), id: ids.bom },
    hostileTitle: {
      ...completeRecordFor(base, html, '<script>window.top.__titleRan=true</script><img src=x onerror=1>'),
      id: ids.hostileTitle,
    },
  };

  const provider = storeHelpers.createProviderDouble();
  for (const record of Object.values(records)) {
    provider.put(`publications/${record.id}`, JSON.stringify(record));
  }
  for (const [state, id] of [["pending", ids.pending], ["approved", ids.approved], ["expired", ids.expired]]) {
    provider.put(`publications/${id}`, JSON.stringify({ ...publicationFixtures.RECORDS[state], id }));
  }

  const auth = authFixtures.memoryAuthStore(
    authFixtures.fixedClock(Date.parse(publicationFixtures.FIXTURE_NOW)),
  );
  const hostedConfig = readHostedConfig(
    {
      HOSTED_APP_ORIGIN: app.origin,
      HOSTED_RENDER_ORIGIN: renderer.origin,
      GITHUB_CLIENT_ID: "Iv1.fixtureclientid",
      GITHUB_CLIENT_SECRET: "fixture-client-secret-not-a-real-credential",
      HOSTED_PUBLISH_ENABLED: "true",
    },
    { mode: "local-test" },
  );
  const publications = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: app.origin,
    production: false,
    publishEnabled: true,
    now: storeHelpers.createClock(publicationFixtures.FIXTURE_NOW).now,
  };

  const deps = { store: auth.store, config: hostedConfig };
  handlers.viewer = withErrorBoundary(createViewerRoute(deps));
  handlers.read = withErrorBoundary(createDocumentReadRoutes({ store: auth.store, publications }));
  handlers.session = withErrorBoundary(createSessionRoute(deps));
  handlers.logout = withErrorBoundary(createLogoutRoute(deps));
  handlers.serializeCookie = (token) =>
    serializeCookie("__Host-archon_session", token, { maxAgeSeconds: SESSION_COOKIE_MAX_AGE });

  const tokens = {
    owner: (await auth.store.createSession(publicationFixtures.FIXTURE_PRINCIPAL)).token,
    stranger: (await auth.store.createSession(publicationFixtures.OTHER_PRINCIPAL)).token,
    signOut: (await auth.store.createSession(publicationFixtures.FIXTURE_PRINCIPAL)).token,
  };

  /* Every string a denial must never carry, drawn from the records themselves so
     a fixture change cannot leave the list stale. */
  const markers = [
    records.owned.descriptor.title,
    records.owned.descriptor.contentSha256,
    records.bom.descriptor.contentSha256,
    base.agentSecretHash,
    base.browserSecretHash,
    base.userCode,
    publicationFixtures.FIXTURE_OWNER_ACCOUNT_ID,
    html.slice(0, 48),
  ];

  const distDir = join(tempRoot, "renderer-dist");
  const built = await build.buildRenderer({
    outDir: distDir,
    production: false,
    env: { HOSTED_APP_ORIGIN: app.origin, HOSTED_RENDER_ORIGIN: renderer.origin },
  });
  assert.equal(built.files.length, 5, "the renderer build did not publish its five files");
  await renderer.load(distDir);

  process.stdout.write(`INFO  app ${app.origin} renderer ${renderer.origin} adversary ${evil.origin}\n`);
  process.stdout.write(
    `INFO  renderer policy ${Object.fromEntries(renderer.headers())["Content-Security-Policy"]}\n`,
  );

  let cases = 0;
  let browser = null;
  try {
    cases += await assertHttpSurface({ app, ids, tokens, records, markers, base });

    const entry = join(tempRoot, "node_modules", "playwright", "index.js");
    const loaded = await import(pathToFileURL(entry).href);
    const playwright = loaded.chromium !== undefined ? loaded : loaded.default;
    browser = await playwright[ENGINE].launch();

    for (const [label, run] of browserCases({ app, renderer, evil, ids, tokens, records })) {
      const context = await browser.newContext();
      if (process.env.AHU009_TRACE === "1") {
        context.on("page", (p) => {
          p.on("console", (m) => process.stderr.write(`TRACE console ${m.type()} ${m.text()}\n`));
          p.on("pageerror", (e) => process.stderr.write(`TRACE pageerror ${e.message}\n`));
        });
      }
      const started = Date.now();
      try {
        await run(context);
        if (process.env.AHU009_TRACE === "1") {
          process.stderr.write(`TRACE ok ${Date.now() - started}ms ${label}\n`);
        }
      } catch (error) {
        throw new Error(`case "${label}": ${error.message}`);
      } finally {
        await context.close();
      }
      cases += 1;
    }

    process.stdout.write(`NONCE ${nonce}\n`);
    process.stdout.write(
      `PASS  hosted owner viewer matrix (${ENGINE} ${browser.version()}; ${cases} cases)\n`,
    );
  } finally {
    if (browser !== null) await browser.close();
    await app.close();
    await renderer.close();
    await evil.close();
  }
}

if (process.argv.includes("--worker")) {
  worker().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
} else {
  parent().catch((error) => die(error.stack ?? error.message));
}
