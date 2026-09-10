/**
 * The host-aware edge gate.
 *
 * Two layers are proven here. The pure helpers in `host.mjs` -- host
 * classification, the shell rewrite table, the two header sets -- are asserted
 * directly. The whole refusal matrix is then driven against the real
 * `gate.ts`, transpiled with the repository's pinned TypeScript exactly as
 * `scripts/test-access-row.mjs` does it, so the control flow under test is the
 * shipped control flow. The transpile is type-erasure only.
 *
 * `identify()` is injected as a seam that throws the moment it is called. That
 * is how the invariants "the renderer branch never performs a session lookup"
 * and "a foreign host is refused before any store read" are proven rather than
 * asserted: a call reaches the seam, the seam throws, and the test fails.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applicationHeaders,
  applicationOrigin,
  classifyHost,
  isApplicationPassThrough,
  isRenderPrefix,
  notFoundForeignHost,
  notFoundRenderer,
  rendererHeaders,
  rendererRewriteTarget,
  withApplicationHeaders,
} from "../lib/edge-host.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(dirname(HERE));
const real = (path) => pathToFileURL(join(ROOT, path)).href;

const APP_ORIGIN = "https://app.example.test";
const RENDER_ORIGIN = "https://renderer.example.net";
const APP_HOST = "app.example.test";
const RENDER_HOST = "renderer.example.net";
const OTHER_HOST = "deploy-preview-7--archon-site.netlify.app";

const DOC_ID = "0dc0de";
const META_LINE = `<meta name="doc-id" content="${DOC_ID}">\n`;
const PAGE = `${META_LINE}<p>An invented collaboration document body.</p>\n`;

/* -------------------------------------------------------------------------- */
/* host.mjs pure helpers                                                      */
/* -------------------------------------------------------------------------- */

const APP_ENV = { HOSTED_APP_ORIGIN: APP_ORIGIN, HOSTED_RENDER_ORIGIN: RENDER_ORIGIN };

function urlOn(host, path = "/") {
  return new URL(`https://${host}${path}`);
}

test("classifyHost maps each hostname to exactly one class", () => {
  assert.equal(classifyHost(urlOn(APP_HOST), APP_ENV), "app");
  assert.equal(classifyHost(urlOn(RENDER_HOST), APP_ENV), "render");
  assert.equal(classifyHost(urlOn(OTHER_HOST), APP_ENV), "other");
  // Case- and port-insensitive: the URL parser lowercases and drops the port.
  assert.equal(classifyHost(new URL(`https://${APP_HOST.toUpperCase()}:443/`), APP_ENV), "app");
});

test("classifyHost falls back to the application host with no configuration", () => {
  assert.equal(classifyHost(urlOn(RENDER_HOST), {}), "app");
  assert.equal(classifyHost(urlOn(OTHER_HOST), {}), "app");
  assert.equal(classifyHost(urlOn(RENDER_HOST), { HOSTED_APP_ORIGIN: APP_ORIGIN }), "app");
  // A malformed origin is "no configuration", never a silent third host.
  assert.equal(
    classifyHost(urlOn(OTHER_HOST), { HOSTED_APP_ORIGIN: "not a url", HOSTED_RENDER_ORIGIN: RENDER_ORIGIN }),
    "app",
  );
  assert.equal(
    classifyHost(urlOn(OTHER_HOST), { HOSTED_APP_ORIGIN: APP_ORIGIN + "/path", HOSTED_RENDER_ORIGIN: RENDER_ORIGIN }),
    "app",
  );
});

test("rendererRewriteTarget maps the four shell paths and nothing else", () => {
  assert.equal(rendererRewriteTarget("/", ""), "/_render/index.html");
  assert.equal(rendererRewriteTarget("/renderer.js", ""), "/_render/renderer.js");
  assert.equal(rendererRewriteTarget("/renderer.css", ""), "/_render/renderer.css");
  assert.equal(rendererRewriteTarget("/renderer-config.js", ""), "/_render/renderer-config.js");
  // A query string is not one of the four shells.
  assert.equal(rendererRewriteTarget("/", "?x=1"), null);
  assert.equal(rendererRewriteTarget("/renderer.js", "?v=2"), null);
  // Anything else is not a shell.
  assert.equal(rendererRewriteTarget("/index.html", ""), null);
  assert.equal(rendererRewriteTarget("/_render/index.html", ""), null);
  assert.equal(rendererRewriteTarget("/docs/abcdef", ""), null);
});

test("applicationOrigin returns a header-safe origin or null", () => {
  assert.equal(applicationOrigin(APP_ENV), APP_ORIGIN);
  assert.equal(applicationOrigin({ HOSTED_APP_ORIGIN: APP_ORIGIN + "/" }), APP_ORIGIN);
  assert.equal(applicationOrigin({}), null);
  assert.equal(applicationOrigin({ HOSTED_APP_ORIGIN: "javascript:alert(1)" }), null);
});

test("isRenderPrefix and isApplicationPassThrough classify application paths", () => {
  assert.equal(isRenderPrefix("/_render/index.html"), true);
  assert.equal(isRenderPrefix("/_render"), true);
  assert.equal(isRenderPrefix("/_renderer"), false);
  assert.equal(isRenderPrefix("/docs/abcdef"), false);
  for (const pass of ["/api/session", "/api/hosted/session", "/_assets/x.js", "/login/", "/docs/abcdef", "/publish/authorize", "/invite/"]) {
    assert.equal(isApplicationPassThrough(pass), true, `${pass} passes through`);
  }
  for (const gated of ["/", "/some-slug/", "/renderer.js", "/_render/index.html"]) {
    assert.equal(isApplicationPassThrough(gated), false, `${gated} is not a pass-through`);
  }
});

test("rendererHeaders is the renderer set: one CSP, no X-Frame-Options", () => {
  const headers = rendererHeaders(APP_ORIGIN);
  const names = headers.map(([name]) => name.toLowerCase());
  assert.equal(names.filter((name) => name === "content-security-policy").length, 1);
  assert.equal(names.includes("x-frame-options"), false, "the renderer set carries no X-Frame-Options");
  const csp = headers.find(([name]) => name === "Content-Security-Policy")[1];
  assert.ok(csp.includes(`frame-ancestors ${APP_ORIGIN}`), "frame-ancestors names the application origin");
  assert.ok(csp.startsWith("default-src 'none'"));
  assert.equal(headers.find(([name]) => name === "Referrer-Policy")[1], "no-referrer");
  assert.equal(headers.find(([name]) => name === "Cross-Origin-Resource-Policy")[1], "cross-origin");
  assert.throws(() => rendererHeaders("not-an-origin"), /header-safe/);
});

test("applicationHeaders is frame-ancestors 'none' with X-Frame-Options DENY", () => {
  const headers = applicationHeaders();
  const csp = headers.find(([name]) => name === "Content-Security-Policy")[1];
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.equal(headers.find(([name]) => name === "X-Frame-Options")[1], "DENY");
});

test("withApplicationHeaders adds the set only when no CSP is present", () => {
  const bare = new Response("x", { headers: { "content-type": "text/html" } });
  withApplicationHeaders(bare);
  assert.equal(bare.headers.get("Content-Security-Policy"), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  assert.equal(bare.headers.get("X-Frame-Options"), "DENY");

  const owned = new Response("x", {
    headers: { "content-security-policy": "default-src 'none'; frame-src https://renderer.example.net; frame-ancestors 'none'" },
  });
  withApplicationHeaders(owned);
  assert.equal(
    owned.headers.get("Content-Security-Policy"),
    "default-src 'none'; frame-src https://renderer.example.net; frame-ancestors 'none'",
    "a response that already carries a CSP keeps its own",
  );
  assert.equal(owned.headers.get("X-Frame-Options"), null, "and gains no application X-Frame-Options");
});

test("notFoundForeignHost is a bodyless 404 with noindex", async () => {
  const response = notFoundForeignHost();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex");
  assert.equal(await response.text(), "");
});

test("notFoundRenderer is a bodyless 404 with no Set-Cookie", async () => {
  const response = notFoundRenderer();
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Set-Cookie"), null);
  assert.equal(await response.text(), "");
});

/* -------------------------------------------------------------------------- */
/* the real gate.ts, transpiled and driven through the whole matrix           */
/* -------------------------------------------------------------------------- */

/** The account id the signed-in fixture presents: C1 v2's `a0_` + 32 hex. */
const READER_ACCOUNT = `a0_${"9f2c1b7d4e5a6083c1d2e3f4a5b6c7d8"}`;

/** A `GET /api/hosted/session` answer, as the real route serializes one. */
function sessionResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      /* The real route issues a fresh pre-login CSRF binding on every call. It
         is here so the matrix can assert the gate drops it rather than passing
         another browser's cookie to this one. */
      "set-cookie": "__Host-archon_login=binding; Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=/",
    },
  });
}

/** The signed-in body the frozen C1 contract allows, and nothing else. */
function signedIn(overrides = {}) {
  return sessionResponse({
    v: 1,
    authenticated: true,
    accountId: READER_ACCOUNT,
    login: "Reader",
    email: "reader@app.example.test",
    emailVerified: true,
    csrfToken: "Y3NyZi10b2tlbi1mb3ItdGhlLXJlYWRlci1maXh0dXJl",
    ...overrides,
  });
}

/** The one control surface every stub reads. */
const control = {
  identifyCalls: 0,
  resolveCalls: 0,
  /** What `GET /api/hosted/session` answers the gate's internal request. The
   *  counter is kept by the `fetch` seam, which is the thing being counted. */
  session() {
    return signedIn();
  },
  resolveRole() {
    this.resolveCalls += 1;
    return { role: "viewer", canRead: true };
  },
  capabilitiesFor() {
    return { canRead: true };
  },
  validateAccessRow() {
    return true;
  },
};
globalThis.__HOSTGATE__ = control;

async function loadTypeScript() {
  const entry = join(ROOT, "templates/docbuild/node_modules/typescript/lib/typescript.js");
  const loaded = await import(pathToFileURL(entry).href);
  return loaded.default ?? loaded;
}

function transpileGate(ts, gateRoot) {
  mkdirSync(join(gateRoot, "edge-functions"), { recursive: true });
  mkdirSync(join(gateRoot, "lib"), { recursive: true });

  writeFileSync(
    join(gateRoot, "lib/edge-host.mjs"),
    `export * from ${JSON.stringify(real("netlify/lib/edge-host.mjs"))};\n`,
    "utf8",
  );
  /* The address grammar is the real one, not a stub. The gate's projection has
     to agree with `netlify/lib/identity.mjs`'s field for field, and a permissive
     stub here would let the two drift without the matrix noticing. */
  mkdirSync(join(gateRoot, "lib/hosted"), { recursive: true });
  writeFileSync(
    join(gateRoot, "lib/hosted/email.mjs"),
    `export * from ${JSON.stringify(real("netlify/lib/hosted/email.mjs"))};\n`,
    "utf8",
  );
  writeFileSync(
    join(gateRoot, "lib/access.mjs"),
    `export function resolveRole(docId, user, options) { return globalThis.__HOSTGATE__.resolveRole(docId, user, options); }\n` +
      `export function capabilitiesFor(role) { return globalThis.__HOSTGATE__.capabilitiesFor(role); }\n` +
      `export function validateAccessRow(row, cap) { return globalThis.__HOSTGATE__.validateAccessRow(row, cap); }\n`,
    "utf8",
  );

  const source = readFileSync(join(ROOT, "netlify/edge-functions/gate.ts"), "utf8");
  const emitted = ts.transpileModule(source, {
    fileName: "gate.ts",
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  });
  const errors = (emitted.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `gate.ts failed to transpile: ${errors.map((d) => d.messageText).join("; ")}`);

  const file = join(gateRoot, "edge-functions/gate.mjs");
  writeFileSync(file, emitted.outputText, "utf8");
  return pathToFileURL(file).href;
}

/** A downstream that carries a `doc-id` meta first line, for the session path. */
function docPage() {
  return new Response(PAGE, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** A hosted function response that owns its own CSP, as the viewer's does. */
function functionResponse() {
  return new Response("{}", {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-security-policy": "default-src 'none'; frame-src https://renderer.example.net; frame-ancestors 'none'",
    },
  });
}

/** A static page with no CSP, as a served `_site/login/index.html` has none. */
function staticPage(body = "<!doctype html><title>page</title>") {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

let gatePromise;
async function loadGate() {
  if (gatePromise === undefined) {
    gatePromise = (async () => {
      const ts = await loadTypeScript();
      const gateRoot = mkdtempSync(join(tmpdir(), "host-gate-"));
      const url = transpileGate(ts, gateRoot);
      const mod = await import(url);
      return { gate: mod.default, gateRoot };
    })();
  }
  return gatePromise;
}

/**
 * Run the gate against one request with the two origins configured, recording
 * how the context seams were used. `next` and `rewrite` each default to a
 * throwing seam so a branch that should not touch downstream is caught.
 */
async function runGate(host, path, { next, rewrite, env, session } = {}) {
  const { gate } = await loadGate();
  control.identifyCalls = 0;
  control.resolveCalls = 0;
  const calls = { next: 0, rewrite: null, session: [] };
  const context = {
    async next(request) {
      calls.next += 1;
      if (typeof next !== "function") throw new Error("context.next called unexpectedly");
      return next(request);
    },
    async rewrite(target) {
      calls.rewrite = target;
      if (typeof rewrite !== "function") throw new Error("context.rewrite called unexpectedly");
      return rewrite(target);
    },
  };

  const configured = env === undefined ? APP_ENV : env;
  const saved = {};
  for (const key of ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"]) {
    saved[key] = process.env[key];
    if (configured[key] === undefined) delete process.env[key];
    else process.env[key] = configured[key];
  }
  /* The gate resolves identity by an internal request rather than a module
     call, so the seam the matrix drives is `fetch`. It is installed for exactly
     the session route and throws for anything else, which is what proves the
     gate reaches nothing else from the edge. */
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const requested = new URL(typeof input === "string" ? input : input.url);
    calls.session.push({ url: requested, headers: new Headers(init?.headers) });
    if (requested.pathname !== "/api/hosted/session") {
      throw new Error(`the gate fetched ${requested.pathname}, which it must not`);
    }
    control.identifyCalls += 1;
    return typeof session === "function" ? session(requested, init) : control.session();
  };

  try {
    const response = await gate(new Request(`https://${host}${path}`, { method: "GET" }), context);
    return { response, calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * The number of `Content-Security-Policy` headers on a response. `Headers`
 * merges same-name entries into one, and the gate only ever `set`s the header,
 * so this is 1 when a policy is present and 0 when none is -- which is the
 * "exactly one CSP" invariant the matrix asserts.
 */
function cspCount(response) {
  return [...response.headers].filter(([name]) => name.toLowerCase() === "content-security-policy").length;
}

/* --- the renderer host ---------------------------------------------------- */

test("renderer host rewrites the four shell paths with the renderer header set", async () => {
  for (const [path, target] of [
    ["/", "/_render/index.html"],
    ["/renderer.js", "/_render/renderer.js"],
    ["/renderer.css", "/_render/renderer.css"],
    ["/renderer-config.js", "/_render/renderer-config.js"],
  ]) {
    const { response, calls } = await runGate(RENDER_HOST, path, {
      rewrite: () => staticPage("<html>renderer shell</html>"),
    });
    assert.equal(response.status, 200, `${path} serves the shell`);
    assert.equal(calls.rewrite, target, `${path} rewrites to ${target}`);
    assert.equal(control.identifyCalls, 0, "the renderer branch performs no session lookup");
    const csp = response.headers.get("Content-Security-Policy");
    assert.ok(csp.includes(`frame-ancestors ${APP_ORIGIN}`), "the renderer CSP names the application as its framer");
    assert.equal(response.headers.get("X-Frame-Options"), null, "no X-Frame-Options on renderer paths");
    assert.equal(cspCount(response), 1, "exactly one CSP on the renderer shell");
  }
});

test("renderer host refuses every non-shell path: 404, no body, no Set-Cookie, no session lookup", async () => {
  for (const path of [
    "/?x=1",
    "/renderer.js?v=2",
    "/_render/index.html",
    "/api/hosted/session",
    "/api/session",
    "/docs/abcdef",
    "/login/",
    "/publish/authorize",
    "/invite/",
    "/some-slug/",
    "/anything-else",
  ]) {
    const { response } = await runGate(RENDER_HOST, path);
    assert.equal(response.status, 404, `${path} is refused`);
    assert.equal(await response.text(), "", `${path} has no body`);
    assert.equal(response.headers.get("Set-Cookie"), null, `${path} sets no cookie`);
    assert.equal(control.identifyCalls, 0, `${path} performs no session lookup`);
  }
});

/* --- a foreign (deploy-preview) host --------------------------------------- */

test("a foreign host is refused with noindex before any session lookup", async () => {
  for (const path of ["/", "/docs/abcdef", "/api/hosted/session", "/renderer.js"]) {
    const { response } = await runGate(OTHER_HOST, path);
    assert.equal(response.status, 404, `${path} is refused on a preview host`);
    assert.equal(response.headers.get("X-Robots-Tag"), "noindex", `${path} tells crawlers not to index`);
    assert.equal(await response.text(), "", `${path} has no body`);
    assert.equal(control.identifyCalls, 0, `${path} performs no session lookup`);
  }
});

/* --- the application host -------------------------------------------------- */

test("application host refuses the renderer shell prefix without a session check", async () => {
  const { response } = await runGate(APP_HOST, "/_render/index.html");
  assert.equal(response.status, 404);
  assert.equal(control.identifyCalls, 0, "the /_render refusal precedes any session lookup");
  assert.equal(cspCount(response), 1, "the refusal carries the application CSP");
  assert.ok(response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
});

test("application host passes through API, assets, login, docs, publish and invite with no session check", async () => {
  // A function path keeps its own CSP; the gate adds no second one.
  for (const path of ["/api/session", "/api/hosted/session", "/docs/abcdef"]) {
    const { response, calls } = await runGate(APP_HOST, path, { next: () => functionResponse() });
    assert.equal(response.status, 200, `${path} passes through`);
    assert.equal(calls.next, 1, `${path} reaches downstream`);
    assert.equal(control.identifyCalls, 0, `${path} is not session-checked at the gate`);
    assert.equal(cspCount(response), 1, `exactly one CSP on ${path}`);
    assert.ok(
      response.headers.get("Content-Security-Policy").includes("frame-src https://renderer.example.net"),
      `${path} keeps the function's own CSP`,
    );
  }
  // A static pass-through gains the application header set.
  for (const path of ["/login/", "/publish/authorize", "/invite/", "/_assets/app.js"]) {
    const { response } = await runGate(APP_HOST, path, { next: () => staticPage() });
    assert.equal(response.status, 200, `${path} passes through`);
    assert.equal(control.identifyCalls, 0, `${path} is not session-checked at the gate`);
    assert.equal(cspCount(response), 1, `exactly one CSP on ${path}`);
    assert.ok(response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
  }
});

test("application host session-checks a collaboration slug and serves a readable document", async () => {
  const { response, calls } = await runGate(APP_HOST, "/some-slug/", { next: () => docPage() });
  assert.equal(response.status, 200);
  assert.equal(calls.next, 1);
  assert.equal(control.identifyCalls, 1, "the slug path performs the session lookup");
  assert.equal(control.resolveCalls, 1, "and resolves the role");
  assert.equal(await response.text(), PAGE, "the whole document is replayed");
  assert.equal(cspCount(response), 1, "with exactly one application CSP");
  assert.ok(response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
});

/* --- the connect-consumer fallback ---------------------------------------- */

test("with neither origin configured every host reaches the application branch", async () => {
  for (const host of [APP_HOST, RENDER_HOST, OTHER_HOST]) {
    // The homepage and a slug both reach the session path when unconfigured.
    const home = await runGate(host, "/", { env: {}, next: () => docPage() });
    assert.equal(home.response.status, 200, `${host} / reaches the application branch`);
    assert.equal(control.identifyCalls, 1, `${host} / is session-checked`);

    const slug = await runGate(host, "/a-slug/", { env: {}, next: () => docPage() });
    assert.equal(slug.response.status, 200, `${host} /a-slug/ reaches the application branch`);
    assert.equal(control.identifyCalls, 1, `${host} /a-slug/ is session-checked`);
  }
});

/* --- the identity step (ACN-006) ------------------------------------------ */

test("the gate resolves identity by an internal request to the hosted session route", async () => {
  const { response, calls } = await runGate(APP_HOST, "/some-slug/", { next: () => docPage() });
  assert.equal(response.status, 200);
  assert.equal(calls.session.length, 1, "exactly one identity request");
  assert.equal(
    calls.session[0].url.toString(),
    `https://${APP_HOST}/api/hosted/session`,
    "addressed to the session route on this origin",
  );
});

test("the session subrequest forwards the browser's Cookie header and nothing else", async () => {
  const { gate } = await loadGate();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    seen.push(new Headers(init?.headers));
    return signedIn();
  };
  const saved = { ...process.env };
  process.env.HOSTED_APP_ORIGIN = APP_ORIGIN;
  process.env.HOSTED_RENDER_ORIGIN = RENDER_ORIGIN;
  try {
    await gate(
      new Request(`https://${APP_HOST}/some-slug/`, {
        headers: {
          cookie: "__Host-archon_session=opaque-token",
          authorization: "Bearer must-not-travel",
          "x-forwarded-for": "203.0.113.9",
        },
      }),
      { next: async () => docPage(), rewrite: async () => docPage() },
    );
  } finally {
    globalThis.fetch = realFetch;
    process.env.HOSTED_APP_ORIGIN = saved.HOSTED_APP_ORIGIN;
    process.env.HOSTED_RENDER_ORIGIN = saved.HOSTED_RENDER_ORIGIN;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].get("cookie"), "__Host-archon_session=opaque-token");
  assert.equal(seen[0].get("accept"), "application/json");
  assert.equal(seen[0].get("authorization"), null, "no credential beyond the cookie travels");
  assert.equal(seen[0].get("x-forwarded-for"), null, "and no client metadata either");
});

test("a visitor with no session is redirected to the one sign-in page with a destination", async () => {
  const { response, calls } = await runGate(APP_HOST, "/some-slug/", {
    session: () => sessionResponse({ v: 1, authenticated: false }),
  });
  assert.equal(response.status, 303, "a 303 so the browser re-fetches with GET");
  assert.equal(response.headers.get("Location"), "/login/?destination=%2Fsome-slug%2F");
  assert.equal(calls.next, 0, "the document is never fetched for an anonymous visitor");
  assert.equal(control.resolveCalls, 0, "and no role is resolved");
  assert.equal(response.headers.get("Set-Cookie"), null, "the subrequest's binding is not relayed");
});

test("the redirect destination is only ever one ACN-005's grammar accepts", async () => {
  // Every path here is gated -- none is a pass-through -- and none is a bare
  // collaboration slug, so none may be offered back as a destination.
  for (const path of ["/some-slug/deeper/", "/some-slug", "/Some-Slug/", "/", "/a_b/"]) {
    const { response } = await runGate(APP_HOST, path, {
      session: () => sessionResponse({ v: 1, authenticated: false }),
    });
    assert.equal(response.status, 303, `${path} is refused with a redirect`);
    assert.equal(
      response.headers.get("Location"),
      "/login/",
      `${path} is not expressible as a destination and none is offered`,
    );
  }
});

test("a session-store outage is a 503 and never a sign-in redirect", async () => {
  const outages = [
    ["the route answers 503", () => sessionResponse({ v: 1, error: { code: "unavailable" } }, 503)],
    ["the transport fails", () => { throw new TypeError("network error"); }],
    ["the body is not JSON", () => new Response("<html>gateway</html>", {
      status: 200, headers: { "content-type": "text/html" },
    })],
    ["the body is not the frozen shape", () => sessionResponse({ v: 1 })],
    ["a signed-in body is missing its account id", () => signedIn({ accountId: undefined })],
  ];
  for (const [label, session] of outages) {
    const { response, calls } = await runGate(APP_HOST, "/some-slug/", { session });
    assert.equal(response.status, 503, `${label}: 503`);
    assert.equal(await response.text(), "Authentication is temporarily unavailable.", label);
    assert.equal(response.headers.get("Location"), null, `${label}: no redirect`);
    assert.equal(calls.next, 0, `${label}: the document is never read`);
    assert.equal(control.resolveCalls, 0, `${label}: no role is resolved`);
  }
});

test("an identity with no address is a signed-in visitor, not an outage", async () => {
  const { response } = await runGate(APP_HOST, "/some-slug/", {
    next: () => docPage(),
    session: () => signedIn({ email: null, emailVerified: false }),
  });
  assert.equal(response.status, 200, "a GitHub identity with no email still reaches the document");
  assert.equal(control.resolveCalls, 1, "and its role is resolved like anybody else's");
});

test("the gate projects the session onto the identity resolveRole is given", async () => {
  let seen = null;
  const recording = function resolveRole(docId, user) {
    this.resolveCalls += 1;
    seen = user;
    return { role: "viewer", canRead: true };
  };
  const original = control.resolveRole;
  control.resolveRole = recording;
  try {
    await runGate(APP_HOST, "/some-slug/", {
      next: () => docPage(),
      session: () => signedIn({ email: "Ann@Example.COM " }),
    });
    assert.deepEqual(Object.keys(seen), ["sub", "email", "emailVerified", "name"]);
    assert.equal(seen.sub, READER_ACCOUNT, "the v2 accountId is the only grant key");
    assert.equal(seen.email, "ann@example.com", "the address is normalized exactly once");
    assert.equal(seen.emailVerified, true);
    assert.equal(seen.name, "Reader", "the display login is the name");

    /* An address the one grammar refuses is "no usable address", not a refusal
       to serve: this visitor may still own the document by subject. `emailVerified`
       goes with it, because a verified claim about an address this deployment
       cannot represent is a claim about nothing. */
    await runGate(APP_HOST, "/some-slug/", {
      next: () => docPage(),
      session: () => signedIn({ email: "ann@exam ple.com" }),
    });
    assert.equal(seen.email, "");
    assert.equal(seen.emailVerified, false);
  } finally {
    control.resolveRole = original;
  }
});
