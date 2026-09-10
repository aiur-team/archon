/**
 * Regressions for `../../lib/hosted/identity.mjs` - the C1 identity boundary.
 *
 * The two tests this suite exists for are the ones whose guard is a single line
 * that looks removable: the storage outage that must throw rather than read as
 * signed out, and the destination allowlist that must be two literals rather
 * than "a same-site path". Both have a plausible, tidier-looking wrong version.
 *
 *   node --test netlify/test/hosted/identity.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  AuthRequestError,
  AuthUnavailableError,
  CsrfFailedError,
  ForbiddenOriginError,
  SessionRequiredError,
} from "../../lib/hosted/auth-errors.mjs";
import { SESSION_TTL_SECONDS, TRANSIENT_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
import { constantTimeEqual } from "../../lib/hosted/secrets.mjs";
import {
  BINDING_COOKIE,
  LOGIN_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  clearPendingBinding,
  createPendingBinding,
  deriveCsrfToken,
  identifyHosted,
  parseCookies,
  readCookie,
  readPendingBinding,
  requireBrowserMutation,
  requireExactOrigin,
  serializeCookie,
  validateDestination,
} from "../../lib/hosted/identity.mjs";
import { APP_ORIGIN, PRINCIPAL_ALPHA, browserRequest, fixedClock, hostedConfig, memoryAuthStore } from "./fixtures/auth.mjs";

/** A signed-in browser: a live session, and the token it holds. */
async function signedIn(clock = fixedClock()) {
  const { store, blobs } = memoryAuthStore(clock);
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  return { store, blobs, clock, token, csrf: deriveCsrfToken(token) };
}

test("a secret comparison is total, whatever lengths arrive", () => {
  /* `crypto.timingSafeEqual` throws on a length mismatch, so a comparison built
     straight on it would need a length branch in front of it - and that branch
     is the length oracle the helper exists to remove. Comparing values of every
     shape a request can carry proves the helper is total instead. The
     constant-time property itself is not observable from a unit test and this
     suite does not claim to check it. */
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", "a-much-longer-value"), false);
  assert.equal(constantTimeEqual("a-much-longer-value", ""), false);
  assert.equal(constantTimeEqual("abc", null), false);
  assert.equal(constantTimeEqual(undefined, "abc"), false);
});

test("the four cookies are distinct __Host- names", () => {
  const names = [SESSION_COOKIE, OAUTH_COOKIE, LOGIN_COOKIE, BINDING_COOKIE];
  assert.equal(new Set(names).size, 4);
  for (const name of names) assert.ok(name.startsWith("__Host-"), name);
});

test("a Set-Cookie carries the whole hosted attribute set and no Domain", () => {
  const serialized = serializeCookie(SESSION_COOKIE, "abc-123_x", { maxAgeSeconds: 600 });
  assert.equal(serialized, "__Host-archon_session=abc-123_x; Max-Age=600; Secure; HttpOnly; SameSite=Lax; Path=/");
  assert.ok(!/domain=/i.test(serialized), "a Domain attribute lets a sibling subdomain overwrite this cookie");
});

test("a cookie without the host prefix, or with a value that could smuggle a separator, is refused", () => {
  assert.throws(() => serializeCookie("archon_session", "v", { maxAgeSeconds: 60 }), TypeError);
  assert.throws(() => serializeCookie("__Secure-archon", "v", { maxAgeSeconds: 60 }), TypeError);
  for (const value of ["a; Domain=example.com", "a=b", "a b", "a\nSet-Cookie: x=y"]) {
    assert.throws(() => serializeCookie(SESSION_COOKIE, value, { maxAgeSeconds: 60 }), TypeError);
  }
  assert.throws(() => serializeCookie(SESSION_COOKIE, "v", { maxAgeSeconds: -1 }), TypeError);
});

test("clearing a cookie is the same cookie with no value and no lifetime", () => {
  assert.equal(clearCookie(SESSION_COOKIE), "__Host-archon_session=; Max-Age=0; Secure; HttpOnly; SameSite=Lax; Path=/");
});

test("cookie parsing keeps the first occurrence and decodes nothing", () => {
  const cookies = parseCookies("__Host-archon_session=first; __Host-archon_session=second; a=%2Fb");
  assert.equal(cookies.get("__Host-archon_session"), "first");
  assert.equal(cookies.get("a"), "%2Fb", "decoding here would let %2F become a separator downstream");
  assert.equal(parseCookies(null).size, 0);
  assert.equal(parseCookies("=novalue; nokey").size, 0);
});

test("readCookie reports an empty cookie as absent", () => {
  assert.equal(readCookie(browserRequest("/x", { cookies: { [SESSION_COOKIE]: "" } }), SESSION_COOKIE), null);
  assert.equal(readCookie(browserRequest("/x"), SESSION_COOKIE), null);
});

test("the CSRF token is derived from the session and is not the session", () => {
  const token = "a-session-token";
  const csrf = deriveCsrfToken(token);
  assert.equal(csrf, createHash("sha256").update(`archon-hosted-csrf-v1:${token}`, "utf8").digest("base64url"));
  assert.notEqual(csrf, token);
  assert.notEqual(csrf, deriveCsrfToken("a-session-tokem"));
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => deriveCsrfToken(""), TypeError);
});

test("only the two frozen internal destinations are reachable", () => {
  assert.equal(validateDestination("/publish/authorize"), "/publish/authorize");
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  assert.equal(validateDestination(docs), docs);
});

test("every redirect-injection spelling is refused", () => {
  for (const bad of [
    "//evil.example.com",
    "///evil.example.com",
    "/\\evil.example.com",
    "\\\\evil.example.com",
    "https://evil.example.com/publish/authorize",
    "/publish/authorize?next=https://evil.example.com",
    "/publish/authorize#x",
    "/publish/authorize/",
    "/publish/authorise",
    "%2Fpublish%2Fauthorize",
    "/docs/../admin",
    "/docs/%2e%2e/admin",
    `/docs/${"A1B2C3D4".repeat(4)}`,
    `/docs/${"a1b2c3d4".repeat(4)}/`,
    `/docs/${"a1b2c3d4".repeat(4)}?x=1`,
    "/docs/short",
    "/",
    "",
    null,
    12,
  ]) {
    assert.throws(() => validateDestination(bad), AuthRequestError, `destination ${String(bad)}`);
  }
});

test("identifyHosted returns the principal behind a live session", async () => {
  const { store, token } = await signedIn();
  const principal = await identifyHosted(browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }), { store });
  assert.deepEqual(principal, PRINCIPAL_ALPHA);
  assert.equal(principal.accountId, "gh_1010");
});

test("identifyHosted returns null for absent, expired and revoked sessions", async () => {
  const clock = fixedClock();
  const { store, token } = await signedIn(clock);
  assert.equal(await identifyHosted(browserRequest("/x"), { store }), null);
  assert.equal(
    await identifyHosted(browserRequest("/x", { cookies: { [SESSION_COOKIE]: "not-a-token" } }), { store }),
    null,
  );

  await store.revokeSession(token);
  assert.equal(await identifyHosted(browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }), { store }), null);

  const later = fixedClock();
  const fresh = await signedIn(later);
  later.advanceSeconds(SESSION_TTL_SECONDS + 1);
  assert.equal(
    await identifyHosted(browserRequest("/x", { cookies: { [SESSION_COOKIE]: fresh.token } }), { store: fresh.store }),
    null,
  );
});

test("identifyHosted throws when the backing store cannot be read", async () => {
  const { store, blobs, token } = await signedIn();
  blobs.fail("sessions/", "read");
  await assert.rejects(
    () => identifyHosted(browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }), { store }),
    (error) => {
      assert.ok(error instanceof AuthUnavailableError, "a null here would be a fail-open read");
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("the origin must be the configured one, exactly", async () => {
  const config = hostedConfig();
  assert.equal(requireExactOrigin(browserRequest("/x"), config), APP_ORIGIN);
  for (const origin of [
    null,
    "https://evil.example.com",
    "https://app.archon.example.com.evil.example.net",
    "https://app.archon.example.com:443",
    "http://app.archon.example.com",
    "https://app.archon.example.com/",
    "APP.ARCHON.EXAMPLE.COM",
  ]) {
    assert.throws(
      () => requireExactOrigin(browserRequest("/x", { origin }), config),
      ForbiddenOriginError,
      `origin ${String(origin)}`,
    );
  }
});

test("a same-origin form navigation is accepted on its Fetch Metadata", () => {
  const config = hostedConfig();

  /* Every `<form method="post">` in this deployment arrives exactly like this.
     `Referrer-Policy: no-referrer` - which C3 requires on every response - makes
     Fetch append the literal string `null` as the Origin of a non-CORS request,
     so an exact-origin check with no exemption refuses the product's only
     sign-in path in every browser. Observed in Chromium by
     `netlify/test/hosted/approval-browser.test.mjs`, not reasoned about. */
  const navigation = browserRequest("/x", {
    method: "POST",
    origin: "null",
    headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
  });
  assert.equal(requireExactOrigin(navigation, config, { formNavigation: true }), APP_ORIGIN);

  /* And it is off unless the route asks. Only the two sign-in forms submit by
     navigation; bind, decision and logout are `fetch` callers that always
     present a real Origin, and handing them the exemption would widen it past
     the case that needs it. */
  assert.throws(() => requireExactOrigin(navigation, config), ForbiddenOriginError);
});

test("the Fetch Metadata exemption is exactly one case, and fails closed", () => {
  const config = hostedConfig();
  const nulled = (headers) =>
    browserRequest("/x", { method: "POST", origin: "null", headers });
  const check = (request) =>
    requireExactOrigin(request, config, { formNavigation: true });

  for (const [why, headers] of [
    ["no Fetch Metadata at all, as an old browser sends", {}],
    ["a cross-site form post", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }],
    ["a same-site but not same-origin post", { "sec-fetch-site": "same-site", "sec-fetch-mode": "navigate" }],
    ["a user-typed URL", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }],
    ["a fetch, which must present a real Origin", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }],
    ["a no-cors subresource", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" }],
    ["only the site half", { "sec-fetch-site": "same-origin" }],
    ["only the mode half", { "sec-fetch-mode": "navigate" }],
  ]) {
    assert.throws(() => check(nulled(headers)), ForbiddenOriginError, why);
  }

  /* And the exemption is for the literal `null` only: an absent Origin carrying
     the same metadata is still a refusal, so nothing that simply drops the
     header inherits it. */
  assert.throws(
    () =>
      check(
        browserRequest("/x", {
          method: "POST",
          origin: null,
          headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
        }),
      ),
    ForbiddenOriginError,
  );
});

test("requireBrowserMutation only forwards the exemption when its caller asks", async () => {
  const config = hostedConfig();
  const { store, token, csrf } = await signedIn();
  const navigation = () =>
    browserRequest("/x", {
      method: "POST",
      origin: "null",
      cookies: { [SESSION_COOKIE]: token },
      csrf,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
    });

  const allowed = await requireBrowserMutation(navigation(), {
    store,
    config,
    formNavigation: true,
  });
  assert.deepEqual(allowed.principal, PRINCIPAL_ALPHA);

  await assert.rejects(
    () => requireBrowserMutation(navigation(), { store, config }),
    ForbiddenOriginError,
  );
});

test("a browser mutation needs origin, session and the session-bound token", async () => {
  const config = hostedConfig();
  const { store, token, csrf } = await signedIn();

  const good = browserRequest("/x", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf });
  const result = await requireBrowserMutation(good, { store, config });
  assert.deepEqual(result.principal, PRINCIPAL_ALPHA);
  assert.equal(result.sessionToken, token);

  await assert.rejects(
    () => requireBrowserMutation(browserRequest("/x", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf, origin: "https://evil.example.com" }), { store, config }),
    ForbiddenOriginError,
  );
  await assert.rejects(
    () => requireBrowserMutation(browserRequest("/x", { method: "POST", csrf }), { store, config }),
    SessionRequiredError,
  );
  for (const forged of [null, "", deriveCsrfToken("some-other-session"), token, createHash("sha256").update(token).digest("hex")]) {
    await assert.rejects(
      () => requireBrowserMutation(browserRequest("/x", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf: forged }), { store, config }),
      CsrfFailedError,
      `forged token ${String(forged)}`,
    );
  }
});

test("a mutation on a revoked session is refused before the CSRF check can matter", async () => {
  const config = hostedConfig();
  const { store, token, csrf } = await signedIn();
  await store.revokeSession(token);
  await assert.rejects(
    () => requireBrowserMutation(browserRequest("/x", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf }), { store, config }),
    SessionRequiredError,
  );
});

test("a form-posted CSRF token is accepted through presentedCsrf", async () => {
  const config = hostedConfig();
  const { store, token, csrf } = await signedIn();
  const request = browserRequest("/x", { method: "POST", cookies: { [SESSION_COOKIE]: token } });
  const result = await requireBrowserMutation(request, { store, config, presentedCsrf: csrf });
  assert.equal(result.sessionToken, token);
});

test("the pending binding is created, read without consuming, and cleared", async () => {
  const { store } = memoryAuthStore();
  const operation = "b".repeat(43);
  const created = await createPendingBinding(store, { operation });
  assert.match(created.setCookie, /^__Host-archon_publish=[A-Za-z0-9_-]+; Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=\/$/);

  const value = created.setCookie.slice(created.setCookie.indexOf("=") + 1, created.setCookie.indexOf(";"));
  const request = browserRequest("/x", { cookies: { [BINDING_COOKIE]: value } });
  assert.equal((await readPendingBinding(store, request)).operation, operation);
  assert.equal((await readPendingBinding(store, request)).operation, operation, "reading must not consume");

  const cleared = await clearPendingBinding(store, request);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.setCookie, clearCookie(BINDING_COOKIE));
  assert.equal(await readPendingBinding(store, request), null);
});

test("a pending binding expires, and an absent one is null rather than an error", async () => {
  const clock = fixedClock();
  const { store } = memoryAuthStore(clock);
  const created = await createPendingBinding(store, { operation: "b".repeat(43) });
  const value = created.setCookie.slice(created.setCookie.indexOf("=") + 1, created.setCookie.indexOf(";"));
  clock.advanceSeconds(TRANSIENT_TTL_SECONDS + 1);
  assert.equal(await readPendingBinding(store, browserRequest("/x", { cookies: { [BINDING_COOKIE]: value } })), null);
  assert.equal(await readPendingBinding(store, browserRequest("/x")), null);
  assert.deepEqual(await clearPendingBinding(store, browserRequest("/x")), {
    cleared: false,
    setCookie: clearCookie(BINDING_COOKIE),
  });
});

test("a pending operation must be an opaque bounded token", async () => {
  const { store } = memoryAuthStore();
  for (const operation of ["", "short", "a/b".padEnd(40, "a"), "a".repeat(257), null, 12, "op with spaces".padEnd(40, "x")]) {
    await assert.rejects(() => createPendingBinding(store, { operation }), AuthRequestError, String(operation));
  }
});
