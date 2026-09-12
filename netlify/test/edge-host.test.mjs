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
  documentHeaders,
  applicationOrigin,
  authorizationOrigin,
  classifyHost,
  firstPartyPageHeaders,
  landingPageHeaders,
  LANDING_AVATAR_IMAGE_ORIGINS,
  withDocumentHeaders,
  APP_AGENT_FILE_PATHS,
  APP_PUBLIC_DOCUMENT_PATHS,
  isAgentFile,
  isApplicationPublic,
  isApplicationPassThrough,
  isLandingPage,
  isPublicDocument,
  isRenderPrefix,
  notFoundForeignHost,
  notFoundRenderer,
  rendererHeaders,
  rendererRewriteTarget,
  withApplicationHeaders,
  withFirstPartyPageHeaders,
  notFoundPageHeaders,
} from "../lib/edge-host.mjs";
import { AVATAR_IMAGE_ORIGINS } from "../lib/hosted/contracts.mjs";
import { VIEWER_ASSET_PATHS, viewerShell } from "../lib/hosted/documents.mjs";
import { RESERVED_FIRST_SEGMENTS } from "../lib/hosted/identity.mjs";

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
  for (const pass of ["/api/session", "/api/hosted/session", "/_assets/x.js", "/login/", "/docs/abcdef", "/publish/authorize", "/invite/", "/request-access/", "/request-access/request-access.js"]) {
    assert.equal(isApplicationPassThrough(pass), true, `${pass} passes through`);
  }
  /* The prefix does not leak into look-alike collaboration slugs: a document
     named `request-access-x` is a slug and stays gated, exactly as `/admin` and
     `/welcome` are guarded from their near misses. */
  for (const gated of ["/", "/some-slug/", "/renderer.js", "/_render/index.html", "/request-access-x/", "/request-accessing/"]) {
    assert.equal(isApplicationPassThrough(gated), false, `${gated} is not a pass-through`);
  }
});

test("isPublicDocument matches the reference documents by exact path only", () => {
  assert.deepEqual(
    [...APP_PUBLIC_DOCUMENT_PATHS].sort(),
    ["/components/", "/d/3c7f1a", "/d/52c164", "/d/a2e912", "/example/", "/how-archon-works/"],
    "the public set is the three reference documents, each at its slug and its permanent link",
  );
  for (const pub of APP_PUBLIC_DOCUMENT_PATHS) {
    assert.equal(isPublicDocument(pub), true, `${pub} is a public document`);
  }
  /* The whole safety argument of the public document set is that membership is
     equality, never a prefix. Each of these shares a prefix with a public route
     and is a path a collaboration document could legitimately be served at, so
     each one being false is what keeps the public set from leaking into the slug
     namespace around it. */
  for (const gated of [
    "/example",
    "/example-thing/",
    "/example/deeper/",
    "/example//",
    "/examples/",
    "/Example/",
    "/components",
    "/components-v2/",
    "/how-archon-works",
    "/how-archon-works-2/",
    "/",
    "/some-slug/",
    // The permanent links are exact too: no prefix, no trailing slash, and no
    // other six-hex id rides in on them.
    "/d/",
    "/d/a2e912/",
    "/d/a2e912x",
    "/d/a2e91",
    "/d/000000",
    "/d",
  ]) {
    assert.equal(isPublicDocument(gated), false, `${gated} is not a public document`);
  }
  /* The two public sets are disjoint and stay that way: one is the landing
     page's images, the other is documents, and neither answers for the other. */
  for (const pub of APP_PUBLIC_DOCUMENT_PATHS) {
    assert.equal(isApplicationPublic(pub), false, `${pub} is not a landing-page subresource`);
  }
  assert.equal(isPublicDocument("/assets/logo.png"), false, "an image is not a public document");
});

test("isAgentFile matches the three agent-facing files by exact path only", () => {
  assert.deepEqual(
    [...APP_AGENT_FILE_PATHS].sort(),
    ["/AGENTS.md", "/llms.txt", "/skills/archon-doc/SKILL.md"],
    "the agent set is the two served root files and the one skill file",
  );
  for (const served of APP_AGENT_FILE_PATHS) {
    assert.equal(isAgentFile(served), true, `${served} is served to an anonymous agent`);
  }
  /* The whole safety argument of this set is the same one the public-document
     set makes: membership is equality, never a prefix. `/skills/` and
     `/skills/archon-doc/` are the two prefixes a reader might assume were
     granted, and both are slug-shaped or tree-shaped paths a future file or a
     future collaboration route could occupy -- exactly the defect the
     `/assets/` prefix shipped. Each one being false is the guard. */
  for (const gated of [
    "/skills",
    "/skills/",
    "/skills/archon-doc",
    "/skills/archon-doc/",
    "/skills/archon-doc/SKILL.md/",
    "/skills/archon-doc/OTHER.md",
    "/skills/other/SKILL.md",
    "/skills-x/",
    "/skillset/",
    "/AGENTS.md/",
    "/agents.md",
    "/AGENTS.markdown",
    "/llms.txt/",
    "/llms.txt.bak",
    "/LLMS.TXT",
    "/",
    "/some-slug/",
  ]) {
    assert.equal(isAgentFile(gated), false, `${gated} is not an agent file`);
  }
  /* The grant is this set and nothing else: none of the three rides in on a
     pass-through prefix, a landing page, a landing-page subresource or the
     public-document list, so removing `isAgentFile` from the gate leaves them
     gated rather than quietly served by a neighbour. */
  for (const served of APP_AGENT_FILE_PATHS) {
    assert.equal(isApplicationPassThrough(served), false, `${served} is not a pass-through`);
    assert.equal(isApplicationPublic(served), false, `${served} is not a landing-page subresource`);
    assert.equal(isPublicDocument(served), false, `${served} is not a public document`);
    assert.equal(isLandingPage(served), false, `${served} is not a landing page`);
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

test("firstPartyPageHeaders is a page CSP: self scripts, inline styles, self fetch and form-action", () => {
  const headers = firstPartyPageHeaders();
  const csp = headers.find(([name]) => name === "Content-Security-Policy")[1];
  assert.ok(csp.startsWith("default-src 'none'"), "still default-deny");
  assert.ok(/(^|; )script-src 'self'(;|$)/.test(csp), "the page's own script may load, with no unsafe-inline");
  assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"), "the page's inline <style> may apply");
  assert.ok(csp.includes("connect-src 'self'"), "login.js may fetch the CSRF binding same-origin");
  assert.ok(csp.includes("form-action 'self'"), "the sign-in form may post to this origin");
  assert.ok(csp.includes("frame-ancestors 'none'"), "the page is still unframable");
  assert.ok(csp.includes("base-uri 'none'"));
  assert.ok(!csp.includes("form-action 'none'"), "a page must never carry the API form-action 'none'");
  assert.equal(headers.find(([name]) => name === "X-Frame-Options")[1], "DENY");
  assert.equal(headers.find(([name]) => name === "X-Content-Type-Options")[1], "nosniff");
  assert.equal(headers.find(([name]) => name === "Referrer-Policy")[1], "no-referrer");
});

test("a sign-in page names the configured provider in form-action, because the post redirects there", () => {
  /* `form-action` is enforced across the redirect the start route answers with,
     so `'self'` alone blocks the submission before the provider is reached --
     the browser refuses with "violates ... form-action 'self'" and no sign-in
     can complete. Both page sets must name the provider's origin, and only in
     this directive. */
  const origin = authorizationOrigin({ AUTH0_DOMAIN: "tenant.us.auth0.example" });
  assert.equal(origin, "https://tenant.us.auth0.example");

  for (const [label, set] of [
    ["landing", landingPageHeaders(origin)],
    ["first-party", firstPartyPageHeaders(origin)],
  ]) {
    const csp = set.find(([name]) => name === "Content-Security-Policy")[1];
    assert.ok(
      csp.includes("form-action 'self' https://tenant.us.auth0.example"),
      `${label}: the submission may reach the provider`,
    );
    assert.ok(!csp.includes("form-action 'none'"), `${label}: never the API form-action`);
    /* The grant is confined to form-action: nothing else names the provider. */
    for (const directive of ["script-src", "style-src", "connect-src", "img-src", "font-src"]) {
      const clause = csp.split("; ").find((part) => part.startsWith(`${directive} `));
      if (clause !== undefined) {
        assert.ok(
          !clause.includes("auth0.example"),
          `${label}: ${directive} does not name the provider`,
        );
      }
    }
  }

  /* A missing or malformed setting yields no origin, and the policy stays
     same-origin-only rather than emitting a header a caller could have shaped. */
  for (const bad of [
    undefined,
    {},
    { AUTH0_DOMAIN: "" },
    { AUTH0_DOMAIN: "https://tenant.us.auth0.example" },
    { AUTH0_DOMAIN: "tenant.us.auth0.example/path" },
    { AUTH0_DOMAIN: "tenant.us.auth0.example evil.example" },
    { AUTH0_DOMAIN: "nodots" },
  ]) {
    assert.equal(authorizationOrigin(bad), null, `refused: ${JSON.stringify(bad)}`);
  }
  const fallback = landingPageHeaders(authorizationOrigin({}))
    .find(([name]) => name === "Content-Security-Policy")[1];
  assert.ok(/(^|; )form-action 'self'(;|$)/.test(fallback), "unconfigured stays same-origin-only");
});

test("the landing img-src names the avatar hosts, exactly and only", () => {
  /* The signed-in nav draws the visitor's picture, and identity providers serve
     avatars from their own hosts, so `img-src 'self' data:` blocked every one of
     them with no visible error. The grant is four named origins - not `https:`,
     not a wildcard, and not a whole provider domain - because an unbounded
     `img-src` would let the identity tenant choose which host every signed-in
     visitor's browser is made to contact. */
  const csp = landingPageHeaders().find(([name]) => name === "Content-Security-Policy")[1];
  const sources = /(^|; )img-src ([^;]+)/.exec(csp)[2].split(" ");
  assert.deepEqual(sources, ["'self'", "data:", ...AVATAR_IMAGE_ORIGINS]);
  for (const source of sources) {
    assert.ok(!source.includes("*"), `no wildcard in img-src: ${source}`);
  }

  /* Held equal to the list the hosted contract validates an `avatarUrl`
     against. The gate module cannot import that one - these tests copy it alone
     into a bundle root - so the two are written twice and compared here. An
     origin allowed in one and not the other is either a broken image or a grant
     nothing uses. */
  assert.deepEqual(
    [...LANDING_AVATAR_IMAGE_ORIGINS].sort(),
    [...AVATAR_IMAGE_ORIGINS].sort(),
    "the landing CSP and the avatar contract disagree about which hosts serve avatars",
  );

  /* The widening is confined to img-src on the landing set. The document and
     first-party sets are untouched, and no other landing directive gained a
     source. */
  assert.ok(
    documentHeaders().find(([name]) => name === "Content-Security-Policy")[1]
      .includes("img-src 'self' data:;"),
    "a built document still loads only its own and inline images",
  );
  for (const directive of ["script-src", "style-src", "font-src", "connect-src", "form-action"]) {
    const clause = csp.split("; ").find((part) => part.startsWith(`${directive} `));
    for (const origin of AVATAR_IMAGE_ORIGINS) {
      assert.ok(!clause.includes(origin), `${directive} does not name ${origin}`);
    }
  }
  assert.ok(csp.includes("connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com"));
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(csp.includes("base-uri 'none'"));
});

test("withFirstPartyPageHeaders adds the page set only when no CSP is present", () => {
  const bare = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  withFirstPartyPageHeaders(bare);
  assert.ok(bare.headers.get("Content-Security-Policy").includes("form-action 'self'"), "a bare page gains the page CSP");
  assert.equal(bare.headers.get("X-Frame-Options"), "DENY");

  const owned = new Response("x", {
    headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
  });
  withFirstPartyPageHeaders(owned);
  assert.equal(
    owned.headers.get("Content-Security-Policy"),
    "default-src 'none'; frame-ancestors 'none'",
    "a response that already carries a CSP keeps its own",
  );
  assert.equal(owned.headers.get("X-Frame-Options"), null, "and gains no page X-Frame-Options");
});

test("documentHeaders is a built artifact's CSP: inline script and style, its fonts and its realtime stream", () => {
  const headers = documentHeaders();
  const csp = headers.find(([name]) => name === "Content-Security-Policy")[1];
  assert.ok(csp.startsWith("default-src 'none'"), "still default-deny");
  assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), "the artifact's inline <script> may run");
  assert.ok(
    csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"),
    "its inline <style> may apply and its font stylesheet may load",
  );
  assert.ok(csp.includes("font-src https://fonts.gstatic.com"), "the font files it links may load");
  assert.ok(csp.includes("connect-src 'self'"), "/api/edit and /api/realtime-token may be called");
  assert.ok(csp.includes("img-src 'self' data:"), "an authored image may load");
  assert.ok(csp.includes("form-action 'none'"), "a document posts with fetch, never a form");
  assert.ok(csp.includes("frame-ancestors 'none'"), "a document is still unframable");
  assert.ok(csp.includes("base-uri 'none'"));
  assert.equal(headers.find(([name]) => name === "X-Frame-Options")[1], "DENY");
  assert.equal(headers.find(([name]) => name === "X-Content-Type-Options")[1], "nosniff");
  assert.equal(headers.find(([name]) => name === "Referrer-Policy")[1], "no-referrer");

  /* The set a document must NOT be served under. `applicationHeaders` names no
     script-src, style-src, font-src or connect-src, so each falls back to
     'none' and the artifact renders as unstyled text with nothing running
     (#235). Pinning the inequality means loosening documentHeaders back into
     the API set fails here rather than only in the two gate assertions. */
  const api = applicationHeaders().find(([name]) => name === "Content-Security-Policy")[1];
  assert.notEqual(csp, api, "a document never takes the API header set's CSP");
  for (const directive of ["script-src", "style-src", "font-src", "connect-src", "img-src"]) {
    assert.ok(!api.includes(directive), `applicationHeaders still omits ${directive}`);
  }
});

test("the document CSP names the realtime origin the document actually opens", () => {
  /* `DOCUMENT_REALTIME_ORIGIN` is a third hand copy of a literal that lives in
     the browser client the build inlines and in the Node module that mints the
     client's token, neither of which the edge bundle can import. If the
     realtime origin ever moves, this fails rather than leaving every document's
     presence, comments and cursors silently blocked by connect-src. */
  const csp = documentHeaders().find(([name]) => name === "Content-Security-Policy")[1];
  const connect = /(^|; )connect-src ([^;]+)/.exec(csp)[2].split(" ");
  const named = connect.filter((source) => source !== "'self'");
  assert.equal(named.length, 1, "connect-src grants exactly one origin beyond same-origin");

  for (const file of ["templates/base/realtime.js", "netlify/lib/realtime.mjs"]) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const found = /ABLY_ORIGIN = "([^"]+)"/.exec(source);
    assert.ok(found !== null, `${file} still declares ABLY_ORIGIN`);
    assert.equal(found[1], named[0], `${file}'s realtime origin is the one the document CSP grants`);
  }
});

test("withDocumentHeaders adds the document set only when no CSP is present", () => {
  const bare = new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
  withDocumentHeaders(bare);
  assert.ok(
    bare.headers.get("Content-Security-Policy").includes("script-src 'self' 'unsafe-inline'"),
    "a bare document gains the document CSP",
  );
  assert.equal(bare.headers.get("X-Frame-Options"), "DENY");

  const owned = new Response("x", {
    headers: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'" },
  });
  withDocumentHeaders(owned);
  assert.equal(
    owned.headers.get("Content-Security-Policy"),
    "default-src 'none'; frame-ancestors 'none'",
    "a response that already carries a CSP keeps its own",
  );
  assert.equal(owned.headers.get("X-Frame-Options"), null, "and gains no document X-Frame-Options");

  /* The same unreadable-headers contract its siblings hold: it returns the
     response rather than throwing out of the gate's answer path. */
  const opaque = { get headers() { throw new Error("unreadable"); } };
  assert.equal(withDocumentHeaders(opaque), opaque, "an unreadable response is returned untouched");
  const wrong = { headers: { set() { throw new Error("must not be called"); } } };
  assert.equal(withDocumentHeaders(wrong), wrong, "a non-Headers headers object is left alone");
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

/** A served text file with no CSP, as `_site/AGENTS.md` has none. */
function markdownFile(body) {
  return new Response(body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8" } });
}

/** An API answer with no CSP of its own, as a JSON route response has none. */
function jsonNoCsp() {
  return new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
/** The cookie header a request carries unless a test says otherwise. */
const SESSION_COOKIE_HEADER = "__Host-archon_session=opaque-session-token";

async function runGate(host, path, { next, rewrite, env, session, cookie, method } = {}) {
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
    const presented = cookie === undefined ? SESSION_COOKIE_HEADER : cookie;
    const response = await gate(
      new Request(`https://${host}${path}`, {
        method: method ?? "GET",
        headers: presented === null ? {} : { cookie: presented },
      }),
      context,
    );
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
/** The header names `applicationHeaders()` owns, lowercased for comparison. */
const applicationHeaderNames = new Set(applicationHeaders().map(([name]) => name.toLowerCase()));

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

/* --- the viewer shell's own chrome ---------------------------------------- */

/**
 * The content type Netlify serves each viewer subresource as, keyed by
 * extension. The gate never sets a `Content-Type`; what these stand for is the
 * static answer the deploy gives, which is the answer a browser under `nosniff`
 * will accept for a stylesheet and for a module.
 */
const VIEWER_ASSET_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

/** A served static subresource, as `_site/viewer.css` and `_site/viewer.js` are. */
function staticAsset(path) {
  const type = VIEWER_ASSET_TYPES[path.slice(path.lastIndexOf("."))];
  assert.ok(type !== undefined, `no content type is declared for ${path}`);
  return new Response("/* the committed viewer asset */\n", {
    status: 200,
    headers: { "content-type": type },
  });
}

test("every subresource the viewer shell references is reachable with no session at all", async () => {
  /* Derived from the shell rather than restated. The two lists that have to
     agree are the markup at `/docs/<id>` and the gate's pass-through set, and a
     test that names the paths itself would keep passing while the shell moved
     to a third path nobody had granted. */
  const shell = viewerShell(RENDER_ORIGIN);
  const referenced = [...shell.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(
    referenced.sort(),
    [VIEWER_ASSET_PATHS.stylesheet, VIEWER_ASSET_PATHS.module].sort(),
    "the viewer shell references a same-origin subresource this test does not cover",
  );

  for (const path of referenced) {
    /* The committed file is really published at this path: a grant for a path
       the build does not serve is a 404 the gate has made anonymous. */
    assert.ok(
      readFileSync(join(ROOT, "netlify/public", path.slice(1))).byteLength > 0,
      `${path} is not a committed file under netlify/public`,
    );

    assert.equal(isApplicationPassThrough(path), true, `${path} passes the gate with no session`);

    /* Anonymous: no cookie at all, which is the state of the visitor the
       sign-in page is about to send to `/docs/<id>`. Before #255 each of these
       answered a 303 to `/login/` -- the stylesheet and module of the page the
       sign-in exists to reach were behind the sign-in itself. */
    const { response, calls } = await runGate(APP_HOST, path, {
      cookie: null,
      next: () => staticAsset(path),
    });
    assert.equal(response.status, 200, `${path} is served to an anonymous visitor`);
    assert.equal(calls.next, 1, `${path} reaches the published file`);
    assert.equal(control.identifyCalls, 0, `${path} is not session-checked at the gate`);
    assert.equal(response.headers.get("Location"), null, `${path} is never a sign-in redirect`);

    /* The second half of the defect, and the one `nosniff` turns into a dead
       page: a stylesheet and a module have to arrive as a stylesheet and a
       module. `sessionGate` answers anything that is not `text/html` with a
       `text/plain` refusal body, so a regression that puts either file back
       inside the gate fails here on the content type even if it kept a 200. */
    assert.equal(
      response.headers.get("Content-Type"),
      VIEWER_ASSET_TYPES[path.slice(path.lastIndexOf("."))],
      `${path} keeps the content type the deploy served it with`,
    );
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", `${path} is still nosniff`);
  }
});

test("the viewer asset grant is two exact paths and reaches nothing else", async () => {
  /* Every near miss of the two granted spellings. Each one being gated is what
     keeps this grant from becoming the `/assets/` prefix that once served a
     slug-shaped path: membership is equality, so no document, no deeper file
     and no look-alike rides in on it. */
  for (const gated of [
    "/viewer.css/",
    "/viewer.js/",
    "/viewer.css/x",
    "/viewer.js/x",
    "/viewer.csset",
    "/viewer.json",
    "/viewer/",
    "/viewer",
    "/viewer-notes/",
    "/VIEWER.JS",
    "/some-slug/viewer.js",
  ]) {
    assert.equal(isApplicationPassThrough(gated), false, `${gated} is not a pass-through`);
  }

  /* And the documents themselves are untouched by the grant: a collaboration
     slug is still the session gate's business, and an anonymous caller still
     gets the sign-in redirect rather than a document. */
  const { response, calls } = await runGate(APP_HOST, "/some-slug/", { cookie: null });
  assert.equal(response.status, 303, "a document still demands a session");
  assert.equal(response.headers.get("Location"), "/login/?destination=%2Fsome-slug%2F");
  assert.equal(calls.next, 0, "no document is read for an anonymous caller");
});

test("a static HTML page pass-through gets the page CSP; an API/JSON one keeps the strict API CSP", async () => {
  // The sign-in and approval pages are static text/html with no CSP of their
  // own. The API set's `default-src 'none'` freezes them -- no script, no inline
  // style, no fetch, no form post -- so the gate gives a static HTML answer a
  // page CSP that admits exactly those, and no more.
  for (const path of ["/login/", "/publish/authorize", "/invite/"]) {
    const { response } = await runGate(APP_HOST, path, { next: () => staticPage() });
    assert.equal(response.status, 200, `${path} passes through`);
    assert.equal(control.identifyCalls, 0, `${path} is not session-checked`);
    assert.equal(cspCount(response), 1, `exactly one CSP on ${path}`);
    const csp = response.headers.get("Content-Security-Policy");
    assert.ok(/(^|; )script-src 'self'(;|$)/.test(csp), `${path}: its script may load`);
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"), `${path}: its inline style may apply`);
    assert.ok(csp.includes("connect-src 'self'"), `${path}: it may fetch same-origin`);
    assert.ok(csp.includes("form-action 'self'"), `${path}: its form may post same-origin`);
    assert.ok(!csp.includes("form-action 'none'"), `${path}: never the API form-action 'none'`);
    assert.equal(
      response.headers.get("X-Frame-Options"),
      "DENY",
      `${path}: still frame-denied`,
    );
  }

  // A pass-through that answers JSON with no CSP is an API answer: it keeps the
  // strict application set, byte for byte, `form-action 'none'` and all.
  for (const path of ["/api/hosted/session", "/api/whatever"]) {
    const { response } = await runGate(APP_HOST, path, { next: () => jsonNoCsp() });
    assert.equal(cspCount(response), 1, `exactly one CSP on ${path}`);
    assert.equal(
      response.headers.get("Content-Security-Policy"),
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      `${path}: the strict API CSP is unchanged`,
    );
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  }

  // A pass-through that owns a CSP keeps it, static-HTML or not.
  const { response: owned } = await runGate(APP_HOST, "/login/", { next: () => functionResponse() });
  assert.equal(cspCount(owned), 1, "still exactly one CSP");
  assert.ok(
    owned.headers.get("Content-Security-Policy").includes("frame-src https://renderer.example.net"),
    "a response that owns a CSP is never replaced by the page set",
  );
});

test("the application-host root serves the public splash to an anonymous visitor, while a deeper path still redirects to sign in", async () => {
  // The bare root is public: an anonymous visitor (no session cookie) is served
  // the splash with no session check, not the sign-in redirect.
  const root = await runGate(APP_HOST, "/", { cookie: null, next: () => staticPage() });
  assert.equal(root.response.status, 200, "the splash is served, not a redirect");
  assert.equal(root.calls.next, 1, "the static splash is fetched downstream");
  assert.equal(root.response.headers.get("Location"), null, "the root is never a redirect");
  assert.equal(control.identifyCalls, 0, "the root is never session-checked");
  assert.equal(control.resolveCalls, 0, "and no role is resolved for the public root");
  assert.equal(cspCount(root.response), 1, "the splash gains exactly one application CSP");
  assert.ok(
    root.response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"),
    "the splash gains the application header set",
  );
  // The root is the public landing page, not an app answer or a first-party
  // form page: its CSP admits the splash's inline scripts and Google Fonts,
  // which the strict app CSP and the sign-in page CSP both refuse.
  {
    const csp = root.response.headers.get("Content-Security-Policy");
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), "the landing page may run its inline scripts");
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"), "the landing page may load the Google Fonts stylesheet");
    assert.ok(csp.includes("font-src https://fonts.gstatic.com"), "the landing page may load the font files");
    assert.ok(csp.includes("frame-ancestors 'none'"), "the landing page is still frame-denied");
    assert.equal(root.response.headers.get("X-Frame-Options"), "DENY", "and still X-Frame-Options DENY");
  }
  // The sign-in page, a deeper first-party HTML page, keeps the stricter page
  // CSP -- no inline script, no font origins -- so the loose set is the root's
  // alone.
  {
    const login = await runGate(APP_HOST, "/login/", { next: () => staticPage() });
    const csp = login.response.headers.get("Content-Security-Policy");
    assert.ok(/(^|; )script-src 'self'(;|$)/.test(csp), "the sign-in page gets no inline-script grant");
    assert.ok(!csp.includes("fonts.googleapis.com"), "and no Google Font origins");
  }

  // Only the exact root is public: a deeper path with no session still redirects.
  const gated = await runGate(APP_HOST, "/some-slug/", {
    session: () => sessionResponse({ v: 1, authenticated: false }),
  });
  assert.equal(gated.response.status, 303, "a deeper path stays gated");
  assert.equal(gated.response.headers.get("Location"), "/login/?destination=%2Fsome-slug%2F");
});

test("the onboarding page is public, takes the landing header set, and does not widen the root", async () => {
  // `/welcome` is where an ordinary sign-in now lands, and the callback redirect
  // reaches it before anything has established a session on this browser's next
  // request -- so a session check here would bounce the visitor straight back to
  // sign in. It is served like the splash: no session check, landing headers.
  for (const path of ["/welcome", "/welcome/"]) {
    const page = await runGate(APP_HOST, path, { cookie: null, next: () => staticPage() });
    assert.equal(page.response.status, 200, `${path} is served, not a redirect`);
    assert.equal(page.response.headers.get("Location"), null, `${path} is never a redirect`);
    assert.equal(control.identifyCalls, 0, `${path} is never session-checked`);
    assert.equal(control.resolveCalls, 0, `and no role is resolved for ${path}`);
    assert.equal(cspCount(page.response), 1, `${path} gains exactly one CSP`);
    const csp = page.response.headers.get("Content-Security-Policy");
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"), `${path} may run its inline copy button`);
    assert.ok(csp.includes("font-src https://fonts.gstatic.com"), `${path} may load the splash's fonts`);
    assert.ok(csp.includes("frame-ancestors 'none'"), `${path} is still frame-denied`);
    assert.equal(page.response.headers.get("X-Frame-Options"), "DENY");
  }

  // Two exact spellings and no prefix: a sibling slug that merely starts with
  // the same letters is an ordinary gated document, and so is anything else
  // under the page's own directory -- a file dropped into
  // `netlify/public/welcome/` later must not become anonymous by inheritance.
  for (const gated of ["/welcomer/", "/welcome-x/", "/welcome/index.html"]) {
    const response = (
      await runGate(APP_HOST, gated, {
        session: () => sessionResponse({ v: 1, authenticated: false }),
      })
    ).response;
    assert.equal(response.status, 303, `${gated} is not the onboarding page`);
  }
  assert.equal(isLandingPage("/welcome/anything.json"), false, "the directory is not a public tree");
});

test("application host session-checks a collaboration slug and serves a readable document", async () => {
  const { response, calls } = await runGate(APP_HOST, "/some-slug/", { next: () => docPage() });
  assert.equal(response.status, 200);
  assert.equal(calls.next, 1);
  assert.equal(control.identifyCalls, 1, "the slug path performs the session lookup");
  assert.equal(control.resolveCalls, 1, "and resolves the role");
  assert.equal(await response.text(), PAGE, "the whole document is replayed");
  assert.equal(cspCount(response), 1, "with exactly one CSP");
  assert.ok(response.headers.get("Content-Security-Policy").includes("frame-ancestors 'none'"));
  /* A granted reader's copy is a built artifact too, so it takes the document
     set rather than the `default-src 'none'` application set that blocks its
     own inline style and script (#235). Asserting the exact set here and the
     identical one on the public branch above is what pins the property that a
     document's policy does not depend on who asked for it. */
  assert.deepEqual(
    [...response.headers].filter(([name]) => applicationHeaderNames.has(name.toLowerCase())).sort(),
    documentHeaders().map(([name, value]) => [name.toLowerCase(), value]).sort(),
    "a gated document gets exactly the document header set",
  );
});

test("the built reference documents are served to an anonymous visitor with no session check", async (t) => {
  /* The acceptance property of #232: each public reference route answers 200
     with the built document body to a visitor carrying no session cookie -- no
     303 to /login/, no 403 "You do not have access to this document". If the
     public-document passlist is removed these assertions fail loudly, because
     the path falls straight back to `sessionGate` and an anonymous request
     there is a redirect. */
  for (const path of APP_PUBLIC_DOCUMENT_PATHS) {
    const { response, calls } = await runGate(APP_HOST, path, {
      cookie: null,
      next: () => docPage(),
    });
    assert.equal(response.status, 200, `${path} is served, not a redirect or a refusal`);
    assert.equal(calls.next, 1, `${path} is fetched downstream exactly once`);
    assert.equal(response.headers.get("Location"), null, `${path} is never a redirect`);
    assert.equal(await response.text(), PAGE, `${path} replays the whole built document`);
    assert.equal(control.identifyCalls, 0, `${path} is never session-checked`);
    assert.equal(control.resolveCalls, 0, `${path} resolves no role`);
    assert.equal(cspCount(response), 1, `${path} carries exactly one CSP`);
    /* The exact policy, not merely "some CSP with frame-ancestors". The
       application set, the first-party page set and the document set all
       satisfy a looser assertion, so a looser one would stay green if the
       public branch fell through to `finalizePassThrough` -- which is the
       single line the comment beside it argues hardest for -- or if it kept the
       `default-src 'none'` application set that renders the artifact unstyled
       and inert (#235). */
    assert.deepEqual(
      [...response.headers].filter(([name]) => applicationHeaderNames.has(name.toLowerCase())).sort(),
      documentHeaders().map(([name, value]) => [name.toLowerCase(), value]).sort(),
      `${path} gets exactly the document header set`,
    );
    assert.equal(response.headers.get("Set-Cookie"), null, `${path} carries no Set-Cookie`);
  }

  /* A public document's `doc-id` is never even read, so its answer cannot
     depend on an access row. Presenting a session changes nothing about what
     comes back, which is what makes it a publication rather than a grant. */
  const withSession = await runGate(APP_HOST, "/example/", { next: () => docPage() });
  assert.equal(withSession.response.status, 200, "a signed-in visitor gets the same answer");
  assert.equal(control.identifyCalls, 0, "whose session is not even resolved");
  assert.equal(control.resolveCalls, 0, "and still no role is resolved");
  t.diagnostic(`public reference routes: ${APP_PUBLIC_DOCUMENT_PATHS.join(" ")}`);
});

test("the agent-facing files are served to an anonymous agent, while a slug-shaped path still redirects", async (t) => {
  /* The acceptance property of #249. These three files exist for a reader that
     cannot sign in, and behind the session gate each answered `303 -> /login/`
     on the live site -- published by the build and unreadable by the only
     audience it has. Each one now answers 200 with its own bytes to a request
     carrying no session cookie.

     Reverting the grant fails these loudly rather than quietly: the path falls
     straight back to `sessionGate`, and an anonymous request there is the
     sign-in redirect asserted at the bottom of this test. */
  for (const path of APP_AGENT_FILE_PATHS) {
    const body = `# ${path}\n`;
    const { response, calls } = await runGate(APP_HOST, path, {
      cookie: null,
      next: () => markdownFile(body),
    });
    assert.equal(response.status, 200, `${path} is served, not a redirect or a refusal`);
    assert.equal(calls.next, 1, `${path} is fetched downstream exactly once`);
    assert.equal(response.headers.get("Location"), null, `${path} is never a redirect`);
    assert.equal(await response.text(), body, `${path} replays the whole file`);
    assert.equal(control.identifyCalls, 0, `${path} is never session-checked`);
    assert.equal(control.resolveCalls, 0, `${path} resolves no role`);
    assert.equal(response.headers.get("Set-Cookie"), null, `${path} carries no Set-Cookie`);
    /* Text, not HTML: it takes the strict application set exactly as a built
       asset does, so the grant adds no script, style, fetch or form capability
       to the origin. */
    assert.equal(cspCount(response), 1, `${path} carries exactly one CSP`);
    assert.equal(
      response.headers.get("Content-Security-Policy"),
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      `${path} keeps the strict application CSP`,
    );
    assert.equal(response.headers.get("X-Frame-Options"), "DENY", `${path} is still frame-denied`);
  }

  /* The other half of the acceptance criteria, and the one an adversarial
     reading is about: nothing slug-shaped falls inside the grant. A
     collaboration slug, the near misses of each granted path, and every
     containing directory of the skill file all still meet the session gate and
     answer an anonymous caller with the sign-in redirect. `/skills/` is the one
     to watch -- `skills` is a legal slug under `[a-z0-9-]{1,64}`, so a prefix
     grant here would have served somebody else's document to whoever asked. */
  const expected = new Map([
    /* Slug-shaped and not reserved: the gate offers the path back as the
       sign-in destination, which is what an ordinary gated document does. */
    ["/some-slug/", "/login/?destination=%2Fsome-slug%2F"],
    ["/skills-x/", "/login/?destination=%2Fskills-x%2F"],
    /* Slug-shaped and reserved. `skills` is a legal slug under
       `[a-z0-9-]{1,64}`, so a prefix grant would have served whatever claimed
       it; the path is gated, and `RESERVED_FIRST_SEGMENTS` additionally refuses
       it as a destination, so the redirect carries none. */
    ["/skills/", "/login/"],
    /* Not slug-shaped at all: deeper paths and the near misses of the two root
       files. Gated, and no destination is offered for any of them. */
    ["/skills/archon-doc/", "/login/"],
    ["/skills/archon-doc/OTHER.md", "/login/"],
    ["/agents.md", "/login/"],
    ["/AGENTS.md/", "/login/"],
    ["/llms.txt.bak", "/login/"],
  ]);
  for (const [gated, location] of expected) {
    const { response } = await runGate(APP_HOST, gated, {
      cookie: null,
      session: () => sessionResponse({ v: 1, authenticated: false }),
    });
    assert.equal(response.status, 303, `${gated} still demands a session`);
    assert.equal(response.headers.get("Location"), location, `${gated} redirects to sign in`);
  }

  /* The skill file's own tree is reserved by every layer that names a first
     segment, so nothing can claim the slug or be offered it as a destination. */
  assert.ok(RESERVED_FIRST_SEGMENTS.includes("skills"), "the identity layer reserves the segment");
  const gateSource = readFileSync(join(ROOT, "netlify/edge-functions/gate.ts"), "utf8");
  const segments = gateSource.slice(gateSource.indexOf("const RESERVED_FIRST_SEGMENTS"));
  assert.match(
    segments.slice(0, segments.indexOf("]")),
    /"skills",/,
    "and the gate never offers /skills/ as a sign-in destination",
  );
  const siteSource = readFileSync(join(ROOT, "templates/docbuild/src/site.ts"), "utf8");
  const reserved = siteSource.slice(siteSource.indexOf("const RESERVED_ROUTES"));
  for (const route of ['"skills",', '"AGENTS.md",', '"llms.txt",']) {
    assert.ok(
      reserved.slice(0, reserved.indexOf("]")).includes(route),
      `templates/docbuild/src/site.ts reserves ${route} so no document can claim it`,
    );
  }

  t.diagnostic(`agent files: ${APP_AGENT_FILE_PATHS.join(" ")}`);
});

test("a public document's permanent link, HEAD and query spellings are public too", async () => {
  /* `/d/<id>` is served by a `_redirects` 301 rather than a document body, and
     the gate answers before `_redirects` does -- so without the route on the
     list an anonymous visitor following the permanent link the document prints
     in its own masthead gets a sign-in redirect that has already thrown the
     destination away. It relays the redirect untouched instead. */
  const moved = await runGate(APP_HOST, "/d/a2e912", {
    cookie: null,
    next: () => new Response(null, { status: 301, headers: { location: "/example/" } }),
  });
  assert.equal(moved.response.status, 301, "the permanent link relays its redirect");
  assert.equal(moved.response.headers.get("Location"), "/example/");
  assert.equal(control.identifyCalls, 0, "and is never session-checked");

  // A query string is not part of `pathname`, so it neither publishes nor gates.
  const queried = await runGate(APP_HOST, "/example/?utm_source=x", {
    cookie: null,
    next: () => docPage(),
  });
  assert.equal(queried.response.status, 200, "a query string does not gate a public document");
  assert.equal(control.identifyCalls, 0, "and does not provoke a session check");

  /* HEAD goes downstream as HEAD. The gated path has to re-issue it as a GET to
     read the `doc-id` line and then discard the body; a public document is
     never read, so the cheaper method survives. */
  const headed = await runGate(APP_HOST, "/example/", {
    cookie: null,
    method: "HEAD",
    next: (request) => {
      assert.equal(request, undefined, "HEAD is not rewritten into a GET for a public document");
      return new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  assert.equal(headed.response.status, 200, "HEAD on a public document is answered");
  assert.equal(control.identifyCalls, 0, "without a session check");
});

test("a public document never relays a Set-Cookie to the anonymous caller", async () => {
  /* Nothing that answers these routes has a session to establish today, but this
     is the one branch whose answer goes back to a caller the gate never
     identified -- and the site labels responses `Cache-Control: public`. A
     cookie escaping here would be handed to whoever asked and possibly stored
     for the next asker, so the branch drops it unconditionally. */
  const { response } = await runGate(APP_HOST, "/example/", {
    cookie: null,
    next: () =>
      new Response(PAGE, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "__Host-archon_session=leaked; Path=/; Secure; HttpOnly",
        },
      }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Set-Cookie"), null, "the cookie is dropped, not relayed");
  assert.equal(await response.text(), PAGE, "and the document itself is untouched");
});

test("a near miss of a public reference route is still gated", async () => {
  /* The public set is matched by exact full path, so every path that merely
     shares a prefix with one stays in the session gate. `example-thing` is a
     slug `SLUG_RE` admits, which is exactly the future collaboration document a
     prefix match would have published by accident. */
  for (const [path, location] of [
    ["/example-thing/", "/login/?destination=%2Fexample-thing%2F"],
    ["/components-v2/", "/login/?destination=%2Fcomponents-v2%2F"],
    ["/how-archon-works-2/", "/login/?destination=%2Fhow-archon-works-2%2F"],
  ]) {
    const { response, calls } = await runGate(APP_HOST, path, {
      cookie: null,
      session: () => sessionResponse({ v: 1, authenticated: false }),
    });
    assert.equal(response.status, 303, `${path} is not public`);
    assert.equal(response.headers.get("Location"), location);
    assert.equal(calls.next, 0, `${path} is refused before anything is fetched`);
  }

  /* Without its trailing slash `/example` is not the document's route and not a
     destination ACN-005's grammar accepts, so it is the bare sign-in page. */
  const bare = await runGate(APP_HOST, "/example", {
    cookie: null,
    session: () => sessionResponse({ v: 1, authenticated: false }),
  });
  assert.equal(bare.response.status, 303, "/example is not the public /example/");
  assert.equal(bare.response.headers.get("Location"), "/login/");
});

test("a signed-in visitor with no grant on a private document still gets the refusal", async (t) => {
  /* The other half of the acceptance: widening the public set must not weaken
     the gated one. A document outside the public set is still read for its
     `doc-id`, still resolved, and still refused when the role cannot read. */
  const original = control.resolveRole;
  control.resolveRole = function refuse() {
    this.resolveCalls += 1;
    return { role: "none", canRead: false };
  };
  t.after(() => {
    control.resolveRole = original;
  });

  const { response } = await runGate(APP_HOST, "/private-doc/", { next: () => docPage() });
  assert.equal(response.status, 403, "a role that cannot read is refused");
  assert.equal(await response.text(), "You do not have access to this document.");
  assert.equal(control.resolveCalls, 1, "the private document's role is resolved");
});

/* --- the connect-consumer fallback ---------------------------------------- */

test("with neither origin configured every host reaches the application branch", async () => {
  for (const host of [APP_HOST, RENDER_HOST, OTHER_HOST]) {
    // The homepage is the public splash on every host; a slug reaches the
    // session path. Both prove the unconfigured request reaches the app branch.
    const home = await runGate(host, "/", { env: {}, next: () => staticPage() });
    assert.equal(home.response.status, 200, `${host} / reaches the application branch`);
    assert.equal(control.identifyCalls, 0, `${host} / is the public splash, not session-checked`);

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
  for (const path of ["/some-slug/deeper/", "/some-slug", "/Some-Slug/", "/a_b/"]) {
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

test("a landing subresource costs no session lookup and resolves no role", async () => {
  for (const path of ["/favicon.ico", "/assets/aiur-logo.png"]) {
    const { response, calls } = await runGate(APP_HOST, path, {
      session: () => sessionResponse({ v: 1, authenticated: false }),
      next: () => staticPage(),
    });
    assert.equal(response.status, 200, `${path} is served with no session`);
    assert.equal(calls.session.length, 0, `${path} costs no session lookup`);
    assert.equal(control.resolveCalls, 0, `${path} resolves no role`);
  }
});

test("the landing page's own subresources are served to an anonymous visitor", () => {
  /* #229 made the splash at `/` public; it did not make what the page loads
     public with it, and every one of those is a deeper path that still reaches
     the session gate. Without this the page is public and looks broken: each
     image answers a sign-in redirect. */
  for (const path of ["/favicon.ico", "/apple-touch-icon.png", "/assets/aiur-logo.png"]) {
    assert.equal(isApplicationPublic(path), true, `${path} is a public subresource`);
  }
  /* And the root is deliberately absent: `PUBLIC_ROOT` in the gate owns the page
     itself and gives it the landing-page policy. A second opinion here would be
     two answers to one question. */
  assert.equal(isApplicationPublic("/"), false, "the root is not this set's business");
  assert.equal(isApplicationPublic("/some-slug/"), false, "a document slug is still gated");
  assert.equal(isApplicationPublic("/assets"), false, "the tree is a prefix, not a bare name");
  /* The trailing-slash case is the dangerous one: `/assets/` is slug-shaped, so
     it is only safe to answer it publicly because `assets` is a reserved first
     segment (in this gate and in the builder's RESERVED_ROUTES) and can never be
     a collaboration document. It is the marketing image tree's root, public. */
  assert.equal(isApplicationPublic("/assets/"), true, "the image tree root is public, and `assets` is a reserved slug so it is never a gated document");
});

test("a document slug that merely starts with admin is still gated", () => {
  /* `/admin` is the console's own address and carries no trailing slash, so it
     cannot go in the prefix list: those are tested with `startsWith`, and a bare
     "/admin" also matches `/adminfoo/` and `/admin-x/`. Both are legal
     collaboration slugs -- the grammar is `[a-z0-9-]{1,64}` -- so that spelling
     would pass somebody else's document straight through the session gate. */
  assert.equal(isApplicationPassThrough("/admin"), true, "the console itself passes through");
  assert.equal(isApplicationPassThrough("/admin/admin.js"), true, "and so does its asset tree");
  for (const slug of ["/adminfoo/", "/admin-x/", "/administrator/", "/admins/"]) {
    assert.equal(isApplicationPassThrough(slug), false, `${slug} is a document slug and stays gated`);
  }
});

test("the admin console passes through to its own authorisation", async () => {
  // `/admin` decides for itself: a signed-out visitor gets a redirect from the
  // route and a signed-in non-admin gets a 403 from it. The gate must not turn
  // the first of those into its own sign-in redirect, because a route that
  // knows `ARCHON_ADMINS` is the only thing that can tell the two apart.
  const { response, calls } = await runGate(APP_HOST, "/admin", {
    session: () => sessionResponse({ v: 1, authenticated: false }),
    next: () => staticPage(),
  });
  assert.equal(response.status, 200, "the route's own answer is returned");
  assert.equal(calls.session.length, 0, "the gate performs no session lookup of its own");
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

test("a request with no session cookie is answered without asking the session route", async () => {
  // The route mints a fresh pre-login binding on every call, so asking about a
  // request that provably has no session would write a record per page view --
  // and an unauthenticated flood of gated URLs would be free write amplification
  // against the store every signed-in read depends on.
  for (const cookie of [null, "", "other=1", "__Host-archon_login=binding"]) {
    const { response, calls } = await runGate(APP_HOST, "/some-slug/", { cookie });
    assert.equal(calls.session.length, 0, `${cookie ?? "(absent)"}: the route is not asked`);
    assert.equal(response.status, 303, `${cookie ?? "(absent)"}: still a sign-in redirect`);
    assert.equal(response.headers.get("Location"), "/login/?destination=%2Fsome-slug%2F");
    assert.equal(calls.next, 0, "and the document is never fetched");
  }
});

test("a presented session cookie is always resolved by the route, never by the gate", async () => {
  // Presence only. Expired, revoked and forged all look alike here, and only the
  // route can tell them apart -- so anything carrying the cookie is asked about.
  const { calls } = await runGate(APP_HOST, "/some-slug/", {
    next: () => docPage(),
    cookie: "__Host-archon_session=a-token-this-deployment-never-issued",
  });
  assert.equal(calls.session.length, 1);
  assert.equal(
    calls.session[0].headers.get("cookie"),
    "__Host-archon_session=a-token-this-deployment-never-issued",
  );
});

test("the session subrequest is addressed to the configured origin, not the request's", async () => {
  const { calls } = await runGate(APP_HOST, "/some-slug/", { next: () => docPage() });
  assert.equal(calls.session[0].url.origin, APP_ORIGIN);

  // With no host configuration there is no configured origin to prefer, so the
  // request's own is the only one there is -- which is what keeps a
  // connect-vendored consumer serving.
  const unconfigured = await runGate(OTHER_HOST, "/some-slug/", { env: {}, next: () => docPage() });
  assert.equal(unconfigured.calls.session[0].url.origin, `https://${OTHER_HOST}`);
});

/* --- the sign-out page and the not-found page ----------------------------- */

/** The deploy's static 404, as Netlify answers an unmatched path with it. */
function notFoundPage() {
  return new Response('<!doctype html><title>404 Page Not Found</title>', {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

test("the sign-out page is served with no session check, under the first-party page set", async () => {
  /* A signed-out visitor who types /logout has to reach the page to be told
     they are signed out. A session check here would answer them with the
     sign-in redirect, which is the opposite of what they asked for. */
  for (const path of ["/logout", "/logout/", "/logout/logout.js"]) {
    const page = await runGate(APP_HOST, path, { cookie: null, next: () => staticPage() });
    assert.equal(page.response.status, 200, `${path} is served, not a redirect`);
    assert.equal(page.response.headers.get("Location"), null, `${path} is never a redirect`);
    assert.equal(control.identifyCalls, 0, `${path} is never session-checked`);
    assert.equal(control.resolveCalls, 0, `and no role is resolved for ${path}`);
    assert.equal(cspCount(page.response), 1, `${path} gains exactly one CSP`);
  }

  /* The page carries no inline script, so it is given no inline-script grant.
     It does read the session route and post to the logout route, both
     same-origin. The logout route answers a form navigation with a 303 to the
     identity provider and `form-action` is enforced across that redirect, which
     is why the set names the configured provider there -- asserted against
     `firstPartyPageHeaders` above, where the provider origin is an argument
     rather than a process-wide variable. */
  const page = await runGate(APP_HOST, "/logout", { cookie: null, next: () => staticPage() });
  const csp = page.response.headers.get("Content-Security-Policy");
  assert.ok(/(^|; )script-src 'self'(;|$)/.test(csp), "no inline-script grant");
  assert.ok(csp.includes("connect-src 'self'"), "it may read /api/hosted/session");
  assert.ok(csp.includes("form-action 'self'"), "and may post to the logout route");
  assert.ok(csp.includes("frame-ancestors 'none'"), "the page is frame-denied");
  assert.equal(page.response.headers.get("X-Frame-Options"), "DENY");
  assert.ok(
    firstPartyPageHeaders("https://tenant.eu.auth0.com")[0][1].includes(
      "form-action 'self' https://tenant.eu.auth0.com",
    ),
    "and the 303 the route answers it with reaches the provider",
  );
});

test("the sign-out pass-through is three exact paths and no prefix", async () => {
  /* `/logout-notes/` and `/logoutx/` are legal collaboration slugs. A prefix
     entry would have passed somebody else's document through the session gate,
     and a file dropped into `netlify/public/logout/` later would have become
     anonymous by inheritance. */
  for (const gated of ["/logoutx/", "/logout-notes/", "/logout/index.html", "/logout/other.js"]) {
    const { response } = await runGate(APP_HOST, gated, {
      session: () => sessionResponse({ v: 1, authenticated: false }),
    });
    assert.equal(response.status, 303, `${gated} is not the sign-out page`);
  }
});

test("an unrouted path answers with the not-found page, under its own header set", async () => {
  /* Two surfaces reach it. A miss under a pass-through prefix -- a sign-in
     asset that is not there, an API path no function claims -- is answered to
     anybody; and a signed-in visitor asking for a path this site does not route
     reaches the deploy's 404 through the session gate. */
  const passThrough = await runGate(APP_HOST, "/login/not-a-file.js", {
    cookie: null,
    next: () => notFoundPage(),
  });
  assert.equal(passThrough.response.status, 404, "the miss is a 404, not a redirect");
  assert.equal(control.identifyCalls, 0, "and costs no session lookup");

  const signedIn = await runGate(APP_HOST, "/no-such-path/", { next: () => notFoundPage() });
  assert.equal(signedIn.response.status, 404, "a signed-in visitor reaches the same 404");

  for (const { response } of [passThrough, signedIn]) {
    assert.equal(cspCount(response), 1, "exactly one CSP");
    const csp = response.headers.get("Content-Security-Policy");
    assert.equal(csp, notFoundPageHeaders()[0][1], "the not-found set, on both surfaces");
    assert.ok(csp.includes("img-src 'self'"), "so the logo is drawn");
    assert.ok(csp.includes("font-src https://fonts.gstatic.com"), "and the fonts load");
    assert.equal(/script-src/.test(csp), false, "with no script grant of any kind");
    assert.equal(response.headers.get("X-Frame-Options"), "DENY", "and still frame-denied");
  }
});

test("a slug-shaped path still refuses an anonymous visitor rather than 404ing", async () => {
  /* The property the not-found page must not cost: the gate does not reveal
     whether a private document exists. An anonymous visitor asking for a real
     slug and an invented one get the same sign-in redirect, and `context.next()`
     is never reached -- so there is nothing for a 404 to be told apart from. */
  for (const path of ["/some-slug/", "/an-invented-slug/"]) {
    const { response, calls } = await runGate(APP_HOST, path, {
      cookie: SESSION_COOKIE_HEADER,
      session: () => sessionResponse({ v: 1, authenticated: false }),
    });
    assert.equal(response.status, 303, `${path} is a sign-in redirect, never a 404`);
    assert.equal(
      response.headers.get("Location"),
      `/login/?destination=${encodeURIComponent(path)}`,
    );
    assert.equal(calls.next, 0, `${path} is never fetched downstream for an anonymous visitor`);
  }
});

test("the renderer host's not-found stays bodyless and tells nothing apart", async () => {
  /* The renderer answers its own 404 before `context.next()`, so the
     application's not-found page is not reachable there and the four shell
     paths stay indistinguishable from every other path from outside. */
  const { response, calls } = await runGate(RENDER_HOST, "/anything", {});
  assert.equal(response.status, 404);
  assert.equal(response.body, null, "no body at all");
  assert.equal(calls.next, 0, "and nothing downstream is reached");
});
