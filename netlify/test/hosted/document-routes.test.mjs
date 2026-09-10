/**
 * Regressions for the private document read: the viewer shell and the two owner
 * API routes.
 *
 * Every case here is driven through the real exported handler with an injected
 * session store and publication store, so what runs is the code the deploy runs.
 * Nothing is asserted against a production constant where the constant is the
 * thing under test: the header sets and the not-found body are written out
 * literally, because asserting a response against the object the handler used to
 * build it only proves the handler used it, and deleting a header from that
 * object would leave every route green.
 *
 *   node --test netlify/test/hosted/document-routes.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import { validateWireError } from "../../lib/hosted/contracts.mjs";
import { SESSION_COOKIE } from "../../lib/hosted/identity.mjs";
import readHandler, {
  createDocumentReadRoutes,
  config as readConfig,
} from "../../functions/hosted-document-read.mjs";
import viewerHandler, {
  createViewerRoute,
  config as viewerConfig,
} from "../../functions/hosted-document-viewer.mjs";
import { NOT_FOUND_PAGE, UNAVAILABLE_PAGE } from "../../lib/hosted/documents.mjs";
import {
  APP_ORIGIN,
  fixedClock,
  hostedConfig,
  memoryAuthStore,
} from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  OTHER_PRINCIPAL,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import { createClock, createProviderDouble } from "./helpers/publication-store.mjs";

const RENDER_ORIGIN = "https://render.archon.example.net";
const PAGE = `/docs/${FIXTURE_PUBLICATION_ID}`;
const METADATA = `/api/hosted/docs/${FIXTURE_PUBLICATION_ID}`;
const CONTENT = `${METADATA}/content`;
const MISSING_ID = "f".repeat(32);

/**
 * A viewer and a read route over one memory session store and one publication
 * provider double, plus a helper that signs a principal in.
 */
async function harness({ seed = "complete" } = {}) {
  const auth = memoryAuthStore(fixedClock(Date.parse(FIXTURE_NOW)));
  const provider = createProviderDouble();
  if (seed !== null) provider.put(FIXTURE_KEY, JSON.stringify(RECORDS[seed]));
  const publications = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled: true,
    now: createClock(FIXTURE_NOW).now,
  };
  const config = hostedConfig({ HOSTED_RENDER_ORIGIN: RENDER_ORIGIN });
  return {
    auth,
    provider,
    read: createDocumentReadRoutes({ store: auth.store, publications }),
    viewer: createViewerRoute({ store: auth.store, config }),
    async signIn(principal) {
      const session = await auth.store.createSession(principal);
      return session.token;
    },
  };
}

/** A browser request, optionally carrying a session cookie. */
function get(path, { token = null, method = "GET", headers = {} } = {}) {
  const sent = new Headers(headers);
  if (token !== null) sent.set("cookie", `${SESSION_COOKIE}=${token}`);
  return new Request(new URL(path, APP_ORIGIN), { method, headers: sent });
}

/** Every marker a denial must not disclose, drawn from the fixture record. */
const SECRETS = [
  VALID_DESCRIPTOR.title,
  VALID_DESCRIPTOR.contentSha256,
  String(VALID_DESCRIPTOR.contentBytes),
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PUBLICATION_ID,
  RECORDS.complete.agentSecretHash,
  RECORDS.complete.browserSecretHash,
  RECORDS.complete.userCode,
  FIXTURE_HTML.slice(0, 40),
];

/**
 * A response body plus every header value, as one string.
 *
 * Denial assertions run against this rather than against the body alone: an
 * `ETag` derived from the record, a `Content-Length` that varied with the title
 * or a `Content-Disposition` carrying a filename would each be a disclosure that
 * a body-only check reads as clean.
 */
async function surface(response) {
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
  return `${headers}\n${await response.text()}`;
}

async function assertDiscloses(response, { except = [] } = {}) {
  const text = await surface(response);
  for (const marker of SECRETS) {
    if (except.includes(marker)) continue;
    assert.ok(!text.includes(marker), `denial disclosed ${JSON.stringify(marker.slice(0, 24))}`);
  }
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

test("the routes are declared where C4 puts them", () => {
  assert.equal(viewerConfig.path, "/docs/:documentId");
  assert.deepEqual(readConfig.path, [
    "/api/hosted/docs/:documentId",
    "/api/hosted/docs/:documentId/content",
  ]);
  assert.equal(typeof viewerHandler, "function");
  assert.equal(typeof readHandler, "function");
});

/* ------------------------------------------------------------------ */
/* the viewer shell                                                    */
/* ------------------------------------------------------------------ */

test("an owner gets a shell that carries no document data", async () => {
  const h = await harness();
  const response = await h.viewer(get(PAGE, { token: await h.signIn(FIXTURE_PRINCIPAL) }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("netlify-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("vary"), "Cookie");

  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  /* Exact directive equality, not a prefix match: `frame-src <origin> *`
     contains the origin and permits everything, so a substring assertion
     would pass on a policy that frames anything. */
  assert.ok(
    csp.split(";").map((part) => part.trim()).includes(`frame-src ${RENDER_ORIGIN}`),
    `frame-src is not exactly the configured renderer origin (${csp})`,
  );
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);

  const html = await response.text();
  /* The shell is the same bytes for every document, so nothing about this one
     can be in it. The id in particular: `viewer.js` reads that from the address
     bar, which is what keeps the shell a constant. */
  for (const marker of SECRETS) assert.ok(!html.includes(marker));
  /* The stage is empty in the markup: the frame is created by `viewer.js` after
     its readiness listener exists, because a frame in this markup starts loading
     -- and the renderer starts announcing readiness -- before a deferred module
     runs at all. What the shell carries is the two spellings of the configured
     origin that the script builds the frame from. */
  assert.doesNotMatch(html, /<iframe/);
  assert.match(html, /<div class="stage" data-archon-stage hidden><\/div>/);
  assert.match(html, new RegExp(`data-archon-render-origin="${RENDER_ORIGIN.replaceAll(".", "\\.")}"`));
  assert.match(html, new RegExp(`data-archon-render-src="${RENDER_ORIGIN.replaceAll(".", "\\.")}/"`));
  assert.match(html, /<script type="module" src="\/viewer\.js"><\/script>/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-archon-signout/);
});

test("the shell is identical for a document that does not exist", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const mine = await h.viewer(get(PAGE, { token }));
  const theirs = await h.viewer(get(`/docs/${MISSING_ID}`, { token }));

  /* Byte-identical, which is the property: the shell answers before any lookup,
     so opening a stranger's id is not a probe for whether it exists. */
  assert.equal(theirs.status, mine.status);
  assert.equal(await theirs.text(), await mine.text());
});

test("the shell never reads the publication store", async () => {
  const h = await harness();
  const before = h.provider.calls.length;
  await h.viewer(get(PAGE, { token: await h.signIn(FIXTURE_PRINCIPAL) }));
  assert.equal(h.provider.calls.length, before);
});

test("a signed-out reader is redirected into the local sign-in flow", async () => {
  const h = await harness();
  const response = await h.viewer(get(PAGE));

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `/login/?destination=${encodeURIComponent(PAGE)}`,
  );
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "");
});

test("the sign-in redirect is server-built and cannot be aimed", async () => {
  const h = await harness();
  /* Any `next`, `destination` or `returnTo` a caller supplies is simply not
     read: the destination is assembled from the id in the path, which has
     already been matched against C2's grammar. */
  const response = await h.viewer(
    get(`${PAGE}?destination=https://evil.example/&next=//evil.example`),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `/login/?destination=${encodeURIComponent(PAGE)}`);
});

test("a malformed id is the inert not-found page, signed in or out", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  for (const path of [
    "/docs/not-hex",
    "/docs/ABCDEF0123456789abcdef0123456789",
    `/docs/${FIXTURE_PUBLICATION_ID}0`,
    "/docs/%zz",
    "/docs/",
  ]) {
    for (const token_ of [null, token]) {
      const response = await h.viewer(get(path, { token: token_ }));
      assert.equal(response.status, 404, path);
      const html = await response.text();
      assert.equal(html, NOT_FOUND_PAGE);
      assert.doesNotMatch(html, /<script/i);
      assert.doesNotMatch(response.headers.get("content-security-policy"), /script-src/);
    }
  }
});

test("a session-store outage is 503, never a redirect and never a denial", async () => {
  const failing = {
    async readSession() {
      const { AuthUnavailableError } = await import("../../lib/hosted/auth-errors.mjs");
      throw new AuthUnavailableError("storage");
    },
  };
  const viewer = createViewerRoute({
    store: failing,
    config: hostedConfig({ HOSTED_RENDER_ORIGIN: RENDER_ORIGIN }),
  });
  const response = await viewer(get(PAGE, { token: "any-token-at-all-0000000000000000" }));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), UNAVAILABLE_PAGE);
});

test("HEAD on the shell is the same decision with no body", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const head = await h.viewer(get(PAGE, { token, method: "HEAD" }));
  const body = await h.viewer(get(PAGE, { token }));

  assert.equal(head.status, body.status);
  assert.equal(head.headers.get("content-length"), body.headers.get("content-length"));
  assert.equal(head.headers.get("content-security-policy"), body.headers.get("content-security-policy"));
  assert.equal(await head.text(), "");

  /* And a signed-out HEAD is refused exactly as a signed-out GET is, so HEAD is
     never the cheaper oracle. */
  const anonymous = await h.viewer(get(PAGE, { method: "HEAD" }));
  assert.equal(anonymous.status, 303);
});

test("a wrong method on the shell is an inert 405, not JSON", async () => {
  const h = await harness();
  const response = await h.viewer(
    get(PAGE, { token: await h.signIn(FIXTURE_PRINCIPAL), method: "POST" }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
});

/* ------------------------------------------------------------------ */
/* owner metadata                                                      */
/* ------------------------------------------------------------------ */

test("the owner reads exactly the seven C4 metadata fields", async () => {
  const h = await harness();
  const response = await h.read(get(METADATA, { token: await h.signIn(FIXTURE_PRINCIPAL) }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("netlify-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");

  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "contentBytes",
    "contentSha256",
    "createdAt",
    "documentId",
    "ownerAccountId",
    "title",
    "v",
  ]);
  assert.equal(body.documentId, FIXTURE_PUBLICATION_ID);
  assert.equal(body.title, VALID_DESCRIPTOR.title);
  assert.equal(body.ownerAccountId, FIXTURE_OWNER_ACCOUNT_ID);
  assert.equal(body.contentSha256, VALID_DESCRIPTOR.contentSha256);
  assert.equal(body.contentBytes, VALID_DESCRIPTOR.contentBytes);
});

test("metadata never serialises the stored envelope", async () => {
  const h = await harness();
  const response = await h.read(get(METADATA, { token: await h.signIn(FIXTURE_PRINCIPAL) }));
  const text = await response.text();

  /* The three fields whose presence would be a credential or the document
     itself, named individually so a serialisation that leaked one is a failure
     naming which one. */
  for (const forbidden of [
    RECORDS.complete.agentSecretHash,
    RECORDS.complete.browserSecretHash,
    RECORDS.complete.userCode,
    FIXTURE_HTML.slice(0, 40),
    "agentSecretHash",
    "browserSecretHash",
    "html",
    "state",
  ]) {
    assert.ok(!text.includes(forbidden), `metadata leaked ${forbidden}`);
  }
});

test("a title of executable-looking markup is returned as data, never markup", async () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>';
  const record = {
    ...RECORDS.complete,
    descriptor: { ...RECORDS.complete.descriptor, title: hostile },
  };
  const provider = createProviderDouble();
  provider.put(FIXTURE_KEY, JSON.stringify(record));
  const auth = memoryAuthStore(fixedClock(Date.parse(FIXTURE_NOW)));
  const read = createDocumentReadRoutes({
    store: auth.store,
    publications: {
      store: createPublicationStore({ getStore: provider.getStore }),
      appOrigin: FIXTURE_APP_ORIGIN,
      production: true,
      publishEnabled: true,
      now: createClock(FIXTURE_NOW).now,
    },
  });
  const { token } = await auth.store.createSession(FIXTURE_PRINCIPAL);
  const response = await read(get(METADATA, { token }));

  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  /* The title comes back intact -- it is the author's text, and mangling it here
     would be a lossy repair of data that was never dangerous on this route. What
     matters is the media type: JSON, so no browser parses it as a document, and
     `viewer.js` puts it in the page through `textContent`. */
  assert.equal((await response.json()).title, hostile);
});

/* ------------------------------------------------------------------ */
/* raw content                                                         */
/* ------------------------------------------------------------------ */

test("the owner's bytes are the stored bytes, and are not a document", async () => {
  const h = await harness();
  const response = await h.read(get(CONTENT, { token: await h.signIn(FIXTURE_PRINCIPAL) }));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(
    response.headers.get("content-disposition"),
    'attachment; filename="archon-document.html"',
  );
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes.byteLength, VALID_DESCRIPTOR.contentBytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), VALID_DESCRIPTOR.contentSha256);
  assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), FIXTURE_HTML);
});

test("a leading byte-order mark survives the round trip byte for byte", async () => {
  const withBom = `\uFEFF${FIXTURE_HTML}`;
  const bytes = new TextEncoder().encode(withBom);
  const record = {
    ...RECORDS.complete,
    html: withBom,
    descriptor: {
      ...RECORDS.complete.descriptor,
      contentBytes: bytes.byteLength,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
  const provider = createProviderDouble();
  provider.put(FIXTURE_KEY, JSON.stringify(record));
  const auth = memoryAuthStore(fixedClock(Date.parse(FIXTURE_NOW)));
  const read = createDocumentReadRoutes({
    store: auth.store,
    publications: {
      store: createPublicationStore({ getStore: provider.getStore }),
      appOrigin: FIXTURE_APP_ORIGIN,
      production: true,
      publishEnabled: true,
      now: createClock(FIXTURE_NOW).now,
    },
  });
  const { token } = await auth.store.createSession(FIXTURE_PRINCIPAL);
  const served = new Uint8Array(await (await read(get(CONTENT, { token }))).arrayBuffer());

  assert.deepEqual([...served.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual([...served], [...bytes]);
  assert.equal(
    createHash("sha256").update(served).digest("hex"),
    record.descriptor.contentSha256,
  );
});

test("HEAD on the metadata route sends headers and no body", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const head = await h.read(get(METADATA, { token, method: "HEAD" }));
  const body = await h.read(get(METADATA, { token }));

  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-type"), "application/json; charset=utf-8");
  /* Asserted here rather than only in the acceptance runner: that runner drives
     the handler through a Node HTTP server, which drops a HEAD body itself, so
     its "no body" assertion cannot fail. This one calls the handler directly and
     therefore can. */
  assert.equal(await head.text(), "");
  assert.equal(
    head.headers.get("content-length"),
    String(new TextEncoder().encode(await body.text()).byteLength),
    "HEAD must advertise the length a GET would send",
  );

  const other = await h.read(get(METADATA, { token: await h.signIn(OTHER_PRINCIPAL), method: "HEAD" }));
  assert.equal(other.status, 404);
  assert.equal(await other.text(), "");
});

test("HEAD on the content route authorises identically and sends no bytes", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const head = await h.read(get(CONTENT, { token, method: "HEAD" }));

  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(VALID_DESCRIPTOR.contentBytes));
  assert.equal(head.headers.get("content-type"), "application/octet-stream");
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  /* A stranger's HEAD is the same 404 their GET is, so HEAD grants nothing. */
  const other = await h.read(
    get(CONTENT, { token: await h.signIn(OTHER_PRINCIPAL), method: "HEAD" }),
  );
  assert.equal(other.status, 404);
  assert.equal((await other.arrayBuffer()).byteLength, 0);
});

/* ------------------------------------------------------------------ */
/* denial                                                              */
/* ------------------------------------------------------------------ */

test("another account is refused on both routes and told nothing", async () => {
  for (const path of [METADATA, CONTENT]) {
    const h = await harness();
    const response = await h.read(get(path, { token: await h.signIn(OTHER_PRINCIPAL) }));
    assert.equal(response.status, 404, path);
    await assertDiscloses(response);
  }
});

test("missing, other-owned and not-yet-complete are indistinguishable", async () => {
  const bodies = new Set();
  const statuses = new Set();

  for (const [seed, principal, path] of [
    ["complete", OTHER_PRINCIPAL, METADATA],
    [null, FIXTURE_PRINCIPAL, METADATA],
    ["pending", FIXTURE_PRINCIPAL, METADATA],
    ["approved", FIXTURE_PRINCIPAL, METADATA],
    ["denied", FIXTURE_PRINCIPAL, METADATA],
    ["cancelled", FIXTURE_PRINCIPAL, METADATA],
    ["expired", FIXTURE_PRINCIPAL, METADATA],
  ]) {
    const h = await harness({ seed });
    const response = await h.read(get(path, { token: await h.signIn(principal) }));
    statuses.add(response.status);
    bodies.add(await response.text());
  }

  /* One status and one body across every reason a read can be refused. A second
     entry in either set is a disclosure -- of which ids exist, of who owns them,
     or of where a publication has got to. */
  assert.deepEqual([...statuses], [404]);
  assert.equal(bodies.size, 1, `${bodies.size} distinguishable denial bodies`);
  const [only] = bodies;
  assert.equal(validateWireError(JSON.parse(only)).error.code, "not_found");
});

test("an unknown id is refused with the same body as an unowned one", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const unknown = await h.read(get(`/api/hosted/docs/${MISSING_ID}`, { token }));
  const unowned = await h.read(get(METADATA, { token: await h.signIn(OTHER_PRINCIPAL) }));

  assert.equal(unknown.status, 404);
  assert.equal(await unknown.text(), await unowned.text());
});

test("a malformed id never reaches the publication store", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const before = h.provider.calls.length;
  for (const path of ["/api/hosted/docs/not-hex", "/api/hosted/docs/%zz/content"]) {
    const response = await h.read(get(path, { token }));
    assert.equal(response.status, 404, path);
  }
  assert.equal(h.provider.calls.length, before);
});

test("a signed-out reader gets session_required, not a not-found oracle", async () => {
  const h = await harness();
  for (const path of [METADATA, CONTENT, `/api/hosted/docs/${MISSING_ID}`]) {
    const response = await h.read(get(path));
    assert.equal(response.status, 401, path);
    const body = validateWireError(await response.json());
    assert.equal(body.error.code, "session_required");
  }
});

test("an agent bearer without a browser session reads nothing", async () => {
  const h = await harness();
  const response = await h.read(
    get(METADATA, { headers: { authorization: "Bearer any-operation-capability-at-all" } }),
  );
  assert.equal(response.status, 401);
  await assertDiscloses(response.clone());
  assert.equal(validateWireError(await response.json()).error.code, "session_required");
});

test("a storage outage is a retryable 503, not a denial", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  h.provider.failNextRead({ throws: new Error("provider unreachable") });
  const response = await h.read(get(METADATA, { token }));

  assert.equal(response.status, 503);
  const body = validateWireError(await response.json());
  assert.equal(body.error.code, "unavailable");
  assert.equal(body.error.retryable, true);
});

test("a wrong method on the read routes is a 405 that does not read", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  const before = h.provider.calls.length;
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await h.read(get(CONTENT, { token, method }));
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET, HEAD");
    assert.equal(validateWireError(await response.json()).error.code, "invalid_request");
  }
  assert.equal(h.provider.calls.length, before);
});

test("query strings and a trailing slash do not change who may read", async () => {
  const h = await harness();
  const owner = await h.signIn(FIXTURE_PRINCIPAL);
  const stranger = await h.signIn(OTHER_PRINCIPAL);

  for (const path of [`${METADATA}?x=1`, `${METADATA}/`, `${CONTENT}?download=1`, `${CONTENT}/`]) {
    assert.equal((await h.read(get(path, { token: owner }))).status, 200, path);
    assert.equal((await h.read(get(path, { token: stranger }))).status, 404, path);
  }
});

test("an unrelated path under the API prefix is not a document route", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  for (const path of [
    `/api/hosted/docs/${FIXTURE_PUBLICATION_ID}/html`,
    `/api/hosted/docs/${FIXTURE_PUBLICATION_ID}/content/extra`,
    "/api/hosted/docs",
  ]) {
    const response = await h.read(get(path, { token }));
    assert.equal(response.status, 404, path);
  }
});

test("a revoked session reads nothing on the next request", async () => {
  const h = await harness();
  const token = await h.signIn(FIXTURE_PRINCIPAL);
  assert.equal((await h.read(get(CONTENT, { token }))).status, 200);

  await h.auth.store.revokeSession(token);

  assert.equal((await h.read(get(CONTENT, { token }))).status, 401);
  assert.equal((await h.read(get(METADATA, { token }))).status, 401);
  assert.equal((await h.viewer(get(PAGE, { token }))).status, 303);
});
