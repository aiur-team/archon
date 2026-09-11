/**
 * Regressions for the four frozen auth routes, exercised as HTTP.
 *
 * These are real `Request` objects through the real handlers behind the real
 * error boundary, with only the store, the clock, the token endpoint and the
 * JWKS injected. That matters for the cookie assertions in particular: C1's
 * cookie rules are properties of a response header, and a test that inspected a
 * helper's return value instead would pass while the handler forgot to attach
 * it.
 *
 * The suite asserts effects rather than rendered text - which token still works,
 * which record is dead, which cookie was not touched - because "the sign-in page
 * says you are signed in" is exactly the assertion that survives every
 * interesting bug. The provider is an Auth0 token endpoint that hands back a
 * genuine RS256 ID token signed by the fixture and verified against a local
 * JWKS, so the whole round trip runs with no live tenant and no network. The
 * nonce a token must echo is the one the start route minted into the authorize
 * URL, so each helper threads it from there.
 *
 *   node --test netlify/test/hosted/auth-routes.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthStore, SESSION_TTL_SECONDS, TRANSIENT_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
import { buildLogoutUrl, principalFromClaims } from "../../lib/hosted/auth0-oidc.mjs";
import { withErrorBoundary } from "../../lib/hosted/http.mjs";
import {
  BINDING_COOKIE,
  LOGIN_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  createPendingBinding,
  deriveCsrfToken,
  identifyHosted,
} from "../../lib/hosted/identity.mjs";
import startHandler, { createStartRoute } from "../../functions/hosted-auth-start.mjs";
import { createCallbackRoute } from "../../functions/hosted-auth-callback.mjs";
import { createLogoutRoute } from "../../functions/hosted-auth-logout.mjs";
import { CALLBACK_STATUSES } from "../../functions/hosted-auth-callback.mjs";
import { createSessionRoute } from "../../functions/hosted-session.mjs";
import { createAllowlistStore, addAllowlistEntry } from "../../lib/hosted/allowlist.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";
import { hashToken } from "../../lib/hosted/secrets.mjs";
import {
  AUDIENCE,
  CLAIMS_GITHUB_NO_EMAIL,
  CLAIMS_GOOGLE,
  TENANT_DOMAIN,
  auth0Provider,
  browserRequest,
  cookieValue,
  fixedClock,
  hostedConfig,
  localKeySet,
  memoryAuthStore,
  setCookies,
  signHs256Token,
  signIdToken,
} from "./fixtures/auth.mjs";

/** The address the allowlist cases use, which `CLAIMS_GOOGLE` asserts. */
const GOOGLE_EMAIL = CLAIMS_GOOGLE.email;

/** The principal the default happy-path claim set produces. */
const PRINCIPAL_GOOGLE = principalFromClaims(CLAIMS_GOOGLE);
/** A second, distinct principal for the rotation and multi-account cases. */
const PRINCIPAL_GITHUB = principalFromClaims(CLAIMS_GITHUB_NO_EMAIL);

/** The authorize origin the start route redirects a browser to. */
const AUTHORIZE_ORIGIN = `https://${TENANT_DOMAIN}`;

/**
 * One deployment: a store, a clock, a configuration and the four routes.
 *
 * The token endpoint is behind a mutable reference so a sign-in helper can set
 * the ID token to return *after* the start route has minted the nonce it must
 * carry. `getKeySet` is the deterministic seam: the callback verifies against
 * the fixture's local JWKS.
 */
function deployment({ clock = fixedClock(), env = {} } = {}) {
  const { store, blobs } = memoryAuthStore(clock);
  const config = hostedConfig(env);
  const providerRef = { impl: auth0Provider({ idToken: "unused-until-a-sign-in-sets-it" }) };
  const fetchImpl = (url, request) => providerRef.impl(url, request);
  /* The platform allowlist store the callback consults when the gate is on. It
     is the real adapter over the publication suite's provider double, so the
     gate is exercised against real conditional writes and real read failures. */
  const provider = createProviderDouble();
  const allowlist = createAllowlistStore({ getStore: provider.getStore });
  const deps = { store, config, allowlist };
  return {
    store,
    blobs,
    clock,
    config,
    provider,
    allowlist,
    providerRef,
    /** The token endpoint's recorded calls, whichever impl is current. */
    get providerCalls() {
      return providerRef.impl.calls;
    },
    session: withErrorBoundary(createSessionRoute(deps)),
    start: withErrorBoundary(createStartRoute(deps)),
    callback: withErrorBoundary(createCallbackRoute({ ...deps, fetchImpl, getKeySet: localKeySet })),
    logout: withErrorBoundary(createLogoutRoute(deps)),
  };
}

/** Bootstrap a pre-login CSRF binding the way the sign-in page does. */
async function bootstrap(app) {
  const response = await app.session(browserRequest("/api/hosted/session"));
  return cookieValue(setCookies(response).get(LOGIN_COOKIE));
}

/** Start one authorization and return the binding, state and nonce. */
async function start(app, { destination, cookies = {}, form = {} } = {}) {
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      cookies: { ...cookies, [LOGIN_COOKIE]: login },
      form: destination === undefined ? form : { ...form, destination },
    }),
  );
  if (response.status !== 303) return { response, binding: null, state: null, nonce: null };
  const location = new URL(response.headers.get("location"));
  return {
    response,
    binding: cookieValue(setCookies(response).get(OAUTH_COOKIE)),
    state: location.searchParams.get("state"),
    nonce: location.searchParams.get("nonce"),
  };
}

/** Point the token endpoint at an ID token signed for this transaction's nonce. */
async function armProvider(app, started, { claims = CLAIMS_GOOGLE, sign = {} } = {}) {
  const idToken = await signIdToken(claims, { nonce: started.nonce, ...sign });
  app.providerRef.impl = auth0Provider({ idToken });
}

/** Drive one whole sign-in and return the session cookie the browser is left with. */
async function signIn(app, { destination, cookies = {}, claims = CLAIMS_GOOGLE } = {}) {
  const started = await start(app, { destination, cookies });
  assert.equal(started.response.status, 303);
  await armProvider(app, started, { claims });
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=fixture-code`, {
      cookies: { ...cookies, [OAUTH_COOKIE]: started.binding },
    }),
  );
  return {
    started: started.response,
    landed,
    state: started.state,
    binding: started.binding,
    nonce: started.nonce,
    token: cookieValue(setCookies(landed).get(SESSION_COOKIE)),
  };
}

/* ------------------------------------------------------------------ */
/* GET /api/hosted/session                                             */
/* ------------------------------------------------------------------ */

test("the signed-out session body is exactly the frozen shape", async () => {
  const app = deployment();
  const response = await app.session(browserRequest("/api/hosted/session"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { v: 1, authenticated: false });
});

test("the signed-out response issues the pre-login binding and nothing else", async () => {
  const app = deployment();
  const response = await app.session(browserRequest("/api/hosted/session"));
  const cookies = setCookies(response);
  assert.deepEqual([...cookies.keys()], [LOGIN_COOKIE], "the other two cookies must not be touched");
  assert.match(
    cookies.get(LOGIN_COOKIE),
    /^__Host-archon_login=[A-Za-z0-9_-]+; Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=\/$/,
  );
  assert.ok(!/domain=/i.test(cookies.get(LOGIN_COOKIE)));
});

test("an anonymous GET writes only the login binding it issues", async () => {
  const app = deployment();
  for (let i = 0; i < 5; i += 1) await app.session(browserRequest("/api/hosted/session"));
  const keys = app.blobs.keys();
  assert.equal(keys.length, 5, "one issued binding record per bootstrap and nothing else");
  assert.ok(keys.every((key) => key.startsWith("auth/login/")), keys.join(", "));
  assert.deepEqual(
    keys.filter((key) => key.startsWith("sessions/")),
    [],
    "an unauthenticated read must never touch the session namespace",
  );
});

test("a signed-in visitor is issued a usable pre-login binding too", async () => {
  const app = deployment();
  const { token } = await signIn(app);

  const response = await app.session(
    browserRequest("/api/hosted/session", { cookies: { [SESSION_COOKIE]: token } }),
  );
  const body = await response.json();
  assert.equal(body.authenticated, true);
  const login = cookieValue(setCookies(response).get(LOGIN_COOKIE));
  assert.match(login ?? "", /^[A-Za-z0-9_-]{32,}$/, "the authenticated branch must issue one");

  const started = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token, [LOGIN_COOKIE]: login },
      form: {},
    }),
  );
  assert.equal(started.status, 303);
  assert.ok(started.headers.get("location").startsWith(`${AUTHORIZE_ORIGIN}/authorize`));
});

test("a dead session cookie is cleared by the signed-out answer", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  await app.store.revokeSession(token);

  const response = await app.session(
    browserRequest("/api/hosted/session", { cookies: { [SESSION_COOKIE]: token } }),
  );
  assert.deepEqual(await response.json(), { v: 1, authenticated: false });
  const cleared = setCookies(response).get(SESSION_COOKIE);
  assert.equal(cookieValue(cleared), "", "a revoked token must not stay in the browser");
  assert.match(cleared, /Max-Age=0/);
});

test("a bootstrap does not consume an existing OAuth state or publication binding", async () => {
  const app = deployment();
  const binding = await createPendingBinding(app.store, { operation: "b".repeat(43) });
  const bindingToken = cookieValue(binding.setCookie);
  const oauth = await app.store.createTransient("oauth", {
    codeVerifier: "v",
    destination: "/publish/authorize",
    nonce: "n",
  });

  await app.session(
    browserRequest("/api/hosted/session", {
      cookies: { [BINDING_COOKIE]: bindingToken, [OAUTH_COOKIE]: oauth.token },
    }),
  );
  assert.notEqual(await app.store.readTransient("binding", bindingToken), null);
  assert.notEqual(await app.store.readTransient("oauth", oauth.token), null);
});

test("the signed-in session body names the account and carries no secret material", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const response = await app.session(
    browserRequest("/api/hosted/session", { cookies: { [SESSION_COOKIE]: token } }),
  );
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), [
    "accountId",
    "authenticated",
    "csrfToken",
    "email",
    "emailVerified",
    "login",
    "v",
  ]);
  assert.equal(body.accountId, PRINCIPAL_GOOGLE.accountId);
  assert.equal(body.login, PRINCIPAL_GOOGLE.login);
  assert.equal(body.email, "ann@example.com");
  assert.equal(body.emailVerified, true);
  assert.equal(body.csrfToken, deriveCsrfToken(token));

  const rendered = JSON.stringify(body);
  assert.ok(!rendered.includes(token), "the raw session cookie must never reach the body");
  assert.ok(!rendered.includes("fixture-provider-access-token"), "no provider token, ever");
  for (const key of app.blobs.keys()) {
    assert.ok(!rendered.includes(key.split("/").at(-1)), `storage hash ${key} leaked into the body`);
  }
});

test("the session route answers GET only", async () => {
  const app = deployment();
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await app.session(browserRequest("/api/hosted/session", { method }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET");
  }
});

test("every auth response is uncacheable and framed nowhere", async () => {
  const app = deployment();
  for (const response of [
    await app.session(browserRequest("/api/hosted/session")),
    await app.logout(browserRequest("/api/hosted/auth/logout", { method: "POST" })),
  ]) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  }
});

/* ------------------------------------------------------------------ */
/* POST /api/hosted/auth/start                                         */
/* ------------------------------------------------------------------ */

test("a start redirects to Auth0 with the OIDC parameters and the state in the cookie", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
  );
  assert.equal(response.status, 303);

  const url = new URL(response.headers.get("location"));
  assert.equal(url.origin + url.pathname, `${AUTHORIZE_ORIGIN}/authorize`);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("nonce"), "the authorize URL carries a nonce");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://app.archon.example.com/api/hosted/auth/callback",
  );

  const cookies = setCookies(response);
  const binding = cookieValue(cookies.get(OAUTH_COOKIE));
  assert.notEqual(
    binding,
    url.searchParams.get("state"),
    "the cookie and the wire state must be two different secrets",
  );
  assert.notEqual(binding, url.searchParams.get("nonce"), "the nonce is a third distinct secret");
  assert.match(cookies.get(OAUTH_COOKIE), /Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=\/$/);
  assert.equal(cookieValue(cookies.get(LOGIN_COOKIE)), "", "the consumed binding is cleared");

  /* Neither the binding cookie nor the nonce is recoverable from the URL: the
     record stores the binding's hash and the nonce, and only `state` travels. */
  const record = app.blobs.entries.get(`auth/oauth/${hashToken(url.searchParams.get("state"))}`);
  assert.equal(record.data.payload.bindingHash, hashToken(binding));
  assert.equal(record.data.payload.nonce, url.searchParams.get("nonce"));
  assert.ok(!response.headers.get("location").includes(binding));
});

test("knowing the callback URL is not enough to redeem the code", async () => {
  const app = deployment();
  const started = await start(app);
  await armProvider(app, started);

  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: "an-attacker-supplied-binding-value" },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
  assert.equal(app.providerCalls.length, 0, "the code must not be redeemed");

  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
  assert.equal(landed.headers.get("location"), "/publish/authorize");
  assert.ok(setCookies(landed).has(SESSION_COOKIE));
});

test("an unbound callback clears no cookie", async () => {
  const app = deployment();
  const started = await start(app);
  for (const cookies of [{}, { [OAUTH_COOKIE]: "not-the-binding" }]) {
    const response = await app.callback(
      browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, { cookies }),
    );
    assert.equal(
      setCookies(response).size,
      0,
      "clearing here would let any page cancel a victim's in-flight sign-in",
    );
  }
});

test("a start from the wrong origin, or with no origin, is refused before anything is written", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  for (const origin of [null, "https://evil.example.com"]) {
    const api = await app.start(
      browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {}, origin }),
    );
    assert.equal(api.status, 403);
    assert.equal((await api.json()).error.code, "forbidden");

    const page = await app.start(
      browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {}, origin }),
    );
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/login/?status=expired");
  }
  assert.deepEqual(
    app.blobs.keys().filter((key) => !key.startsWith("auth/login/")),
    [],
    "a refused start writes no transaction; the untouched binding is still live",
  );
  assert.notEqual(await app.store.readTransient("login", login), null, "and was not consumed");
});

test("a start with no binding cookie, or a replayed one, is refused", async () => {
  const app = deployment();
  const bare = await app.start(browserRequest("/api/hosted/auth/start", { method: "POST", json: {} }));
  assert.equal(bare.status, 403);
  assert.equal((await bare.json()).error.code, "csrf_failed");

  const login = await bootstrap(app);
  const first = await app.start(
    browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {} }),
  );
  assert.equal(first.status, 303);
  assert.equal(await app.store.readTransient("login", login), null, "the first use consumes the record");

  const replay = await app.start(
    browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {} }),
  );
  assert.equal(replay.status, 403, "a captured binding must not be replayable");
  assert.equal((await replay.json()).error.code, "csrf_failed");
});

test("a malformed or fabricated binding cookie is refused without writing anything", async () => {
  const app = deployment();
  for (const binding of ["", "short", "not/base64url/at/all", "x".repeat(300), "c".repeat(43)]) {
    const response = await app.start(
      browserRequest("/api/hosted/auth/start", {
        method: "POST",
        cookies: { [LOGIN_COOKIE]: binding },
        json: {},
      }),
    );
    assert.equal(response.status, 403, `binding ${JSON.stringify(binding)}`);
  }
  assert.deepEqual(app.blobs.keys(), []);
});

test("a start accepts the internal destinations, including a collaboration slug", async () => {
  const app = deployment();
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  /* `/admin` joined this list with #227: the admin console is a real page a
     signed-out visitor is redirected to sign in for, so the sign-in flow has to
     be able to return them to it. It was previously in the refused list below as
     an example of a path that was not a destination. */
  for (const destination of ["/publish/authorize", "/admin", docs, "/how-archon-works/"]) {
    const login = await bootstrap(app);
    const response = await app.start(
      browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: { destination } }),
    );
    assert.equal(response.status, 303, `destination ${destination}`);
  }
  for (const destination of [
    "//evil.example.com",
    "https://evil.example.com",
    "/\\evil.example.com",
    "/docs/%2e%2e/x",
    "/publish/authorize?next=x",
    /* One exact string became a destination, and no shape near it did. */
    "/admin/",
    "/admin/x",
    "/adminfoo",
    "%2Fpublish%2Fauthorize",
    "/login/",
    "/api/",
    "/_render/",
    "/how/archon/works/",
  ]) {
    const login = await bootstrap(app);
    const response = await app.start(
      browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: { destination } }),
    );
    assert.equal(response.status, 400, `destination ${destination}`);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
});

test("an empty destination field is the default, not a refusal", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: login },
      form: { destination: "" },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(
    new URL(response.headers.get("location")).origin,
    AUTHORIZE_ORIGIN,
    "a form submits an empty string, not an absent field, and empty means the default",
  );
});

test("the destination never travels to Auth0", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  const response = await app.start(
    browserRequest("/api/hosted/auth/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: { destination: docs } }),
  );
  assert.ok(!response.headers.get("location").includes("docs"));
});

test("the start route answers POST only", async () => {
  const app = deployment();
  const response = await app.start(browserRequest("/api/hosted/auth/start"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

/* ------------------------------------------------------------------ */
/* the different-account action                                        */
/* ------------------------------------------------------------------ */

test("switching accounts revokes the Archon session and asks Auth0 which account", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const binding = await createPendingBinding(app.store, { operation: "b".repeat(43) });
  const bindingToken = cookieValue(binding.setCookie);

  const response = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token, [BINDING_COOKIE]: bindingToken },
      form: { switchAccount: "true", csrfToken: deriveCsrfToken(token) },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("prompt"), "login");

  assert.equal(await app.store.readSession(token), null, "the old Archon session is dead");
  assert.equal(cookieValue(setCookies(response).get(SESSION_COOKIE)), "");
  assert.equal(
    setCookies(response).has(BINDING_COOKIE),
    false,
    "the pending publication binding must survive the switch",
  );
  assert.notEqual(await app.store.readTransient("binding", bindingToken), null);
});

test("an account switch cannot be forged", async () => {
  const app = deployment();
  const { token } = await signIn(app);

  const noCsrf = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      json: { switchAccount: "true" },
    }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf_failed");

  const noSession = await app.start(
    browserRequest("/api/hosted/auth/start", {
      method: "POST",
      json: { switchAccount: "true", csrfToken: deriveCsrfToken(token) },
    }),
  );
  assert.equal(noSession.status, 401);
  assert.equal((await noSession.json()).error.code, "session_required");
  assert.notEqual(await app.store.readSession(token), null, "a refused switch revokes nothing");
});

/* ------------------------------------------------------------------ */
/* GET /api/hosted/auth/callback                                       */
/* ------------------------------------------------------------------ */

test("a whole sign-in lands on the requested destination as the right account", async () => {
  const app = deployment();
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  const { landed, token } = await signIn(app, { destination: docs });
  assert.equal(landed.status, 303);
  assert.equal(landed.headers.get("location"), docs);

  const cookies = setCookies(landed);
  assert.match(
    cookies.get(SESSION_COOKIE),
    /^__Host-archon_session=[A-Za-z0-9_-]+; Max-Age=86400; Secure; HttpOnly; SameSite=Lax; Path=\/$/,
  );
  assert.equal(cookieValue(cookies.get(OAUTH_COOKIE)), "", "the consumed state is cleared");

  const principal = await identifyHosted(
    browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }),
    { store: app.store },
  );
  assert.deepEqual(principal, PRINCIPAL_GOOGLE);
  assert.equal(principal.email, "ann@example.com");
  assert.equal(principal.emailVerified, true);
});

test("a GitHub identity with no email claim is a valid session with email null", async () => {
  const app = deployment();
  const { token } = await signIn(app, { claims: CLAIMS_GITHUB_NO_EMAIL });
  const principal = await identifyHosted(
    browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }),
    { store: app.store },
  );
  assert.deepEqual(principal, PRINCIPAL_GITHUB);
  assert.equal(principal.email, null);
  assert.equal(principal.emailVerified, false);
});

test("the session cookie lifetime is the 24-hour absolute expiry", async () => {
  /* Both numbers are written out rather than read from the modules under test.
     Advancing the clock by the production constant would pass for any value of
     it: a seven-day server record and a 24-hour cookie would look consistent
     here while a copied token outlived the cookie by six days. */
  const ONE_DAY = 86400;
  assert.equal(SESSION_TTL_SECONDS, ONE_DAY, "C1 v2 freezes the record at 24 hours");
  assert.equal(SESSION_COOKIE_MAX_AGE, ONE_DAY, "the cookie may not outlive the record");
  assert.equal(SESSION_COOKIE_MAX_AGE, SESSION_TTL_SECONDS);

  const app = deployment();
  const { token } = await signIn(app);
  app.clock.advanceSeconds(ONE_DAY - 1);
  assert.notEqual(await app.store.readSession(token), null);
  app.clock.advanceSeconds(2);
  assert.equal(await app.store.readSession(token), null, "the session route refuses an aged record");
});

test("a callback with no binding cookie or a mismatched state signs nobody in", async () => {
  const app = deployment();
  const started = await start(app);
  await armProvider(app, started);

  for (const [query, cookies] of [
    [started.state, {}],
    [started.state, { [OAUTH_COOKIE]: "a-different-state" }],
    ["a-different-state", { [OAUTH_COOKIE]: started.state }],
    [null, { [OAUTH_COOKIE]: started.state }],
  ]) {
    const path = query === null
      ? "/api/hosted/auth/callback?code=c"
      : `/api/hosted/auth/callback?state=${query}&code=c`;
    const response = await app.callback(browserRequest(path, { cookies }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login/?status=expired");
    assert.equal(setCookies(response).has(SESSION_COOKIE), false);
  }
  assert.notEqual(await app.store.readTransient("oauth", started.state), null, "a refused callback consumes nothing");
});

test("a replayed state in a cookie-less browser signs nobody in and writes nothing", async () => {
  const app = deployment();
  const { state } = await signIn(app);
  const before = app.blobs.keys().length;
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${state}&code=fixture-code`, {}),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
  assert.equal(app.blobs.keys().length, before, "a cookie-less replay writes nothing");
});

test("a state is consumed once: a replayed callback signs nobody in", async () => {
  const app = deployment();
  const { state, binding } = await signIn(app);
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: binding },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
});

test("two simultaneous callbacks with one state create at most one session", async () => {
  const app = deployment();
  const started = await start(app);
  await armProvider(app, started);
  const request = () =>
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    });

  const [a, b] = await Promise.all([app.callback(request()), app.callback(request())]);
  const issued = [a, b].filter((response) => setCookies(response).has(SESSION_COOKIE));
  assert.equal(issued.length, 1, "an unconditional delete would let both through");
  assert.equal(app.blobs.keys().filter((key) => key.startsWith("sessions/")).length, 1);
});

test("a denied consent is a normal outcome with an actionable retry", async () => {
  const app = deployment();
  const started = await start(app);
  await armProvider(app, started);
  const response = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&error=access_denied&error_description=nope`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
  assert.equal(
    response.headers.get("location"),
    "/login/?status=denied&destination=%2Fpublish%2Fauthorize",
    "a retry must land back where the visitor was going",
  );
  assert.equal(setCookies(response).has(SESSION_COOKIE), false);
  assert.equal(app.providerCalls.length, 0, "a denied consent never redeems a code");

  assert.equal(await app.store.readTransient("oauth", started.state), null, "the state is consumed");
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
  assert.equal(app.providerCalls.length, 0);
});

test("a token endpoint outage is unavailable and a refusal is expired", async () => {
  for (const [provider, status] of [
    [{ body: { error: "server_error" }, status: 500 }, "unavailable"],
    [{ idToken: "timeout" }, "unavailable"],
    [{ body: { error: "invalid_grant" }, status: 400 }, "expired"],
    [{ body: { access_token: "t", token_type: "Bearer" } }, "expired"],
    [{ body: "malformed" }, "expired"],
  ]) {
    const app = deployment();
    const started = await start(app);
    app.providerRef.impl = auth0Provider(provider);
    const response = await app.callback(
      browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
        cookies: { [OAUTH_COOKIE]: started.binding },
      }),
    );
    assert.equal(
      response.headers.get("location"),
      `/login/?status=${status}&destination=%2Fpublish%2Fauthorize`,
      JSON.stringify(provider),
    );
    assert.equal(setCookies(response).has(SESSION_COOKIE), false);
    assert.deepEqual(app.blobs.keys().filter((key) => key.startsWith("sessions/")), []);
  }
});

test("a token that fails verification signs nobody in", async () => {
  for (const label of ["nonce", "audience", "issuer", "alg"]) {
    const app = deployment();
    const started = await start(app);
    let idToken;
    if (label === "nonce") idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: "not-the-minted-nonce" });
    else if (label === "audience") idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: started.nonce, audience: "wrong-client" });
    else if (label === "issuer") idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: started.nonce, issuer: "https://evil.example.com/" });
    else idToken = await signHs256Token(CLAIMS_GOOGLE, { nonce: started.nonce });
    app.providerRef.impl = auth0Provider({ idToken });

    const response = await app.callback(
      browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
        cookies: { [OAUTH_COOKIE]: started.binding },
      }),
    );
    assert.equal(
      response.headers.get("location"),
      "/login/?status=expired&destination=%2Fpublish%2Fauthorize",
      `verification failure: ${label}`,
    );
    assert.equal(setCookies(response).has(SESSION_COOKIE), false, label);
    assert.deepEqual(app.blobs.keys().filter((key) => key.startsWith("sessions/")), [], label);
  }
});

test("signing in over an existing session revokes the old token first", async () => {
  const app = deployment();
  const first = await signIn(app);
  assert.notEqual(await app.store.readSession(first.token), null);

  const started = await start(app, { cookies: { [SESSION_COOKIE]: first.token } });
  await armProvider(app, started, { claims: CLAIMS_GITHUB_NO_EMAIL });
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: started.binding, [SESSION_COOKIE]: first.token },
    }),
  );

  assert.equal(await app.store.readSession(first.token), null, "the rotated-out token is dead");
  const second = cookieValue(setCookies(landed).get(SESSION_COOKIE));
  assert.deepEqual((await app.store.readSession(second)).principal, PRINCIPAL_GITHUB);
});

test("a callback that cannot revoke the old session signs nobody in", async () => {
  const app = deployment();
  const first = await signIn(app);
  const started = await start(app);
  await armProvider(app, started);

  /* The fault is armed on the *old* session's exact key, not on the `sessions/`
     prefix. A prefix fault is consumed by `createSession` instead, which
     produces the same landing and the same live old token whether or not the
     revocation is attempted at all - so the test would pass with the rotation
     deleted. This one fails unless the old session is revoked first. */
  app.blobs.fail(AuthStore.sessionKey(first.token), "write");
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: started.binding, [SESSION_COOKIE]: first.token },
    }),
  );
  assert.equal(
    landed.headers.get("location"),
    "/login/?status=unavailable&destination=%2Fpublish%2Fauthorize",
  );
  assert.equal(setCookies(landed).has(SESSION_COOKIE), false);
  assert.notEqual(await app.store.readSession(first.token), null);
  assert.equal(
    app.blobs.keys().filter((key) => key.startsWith("sessions/")).length,
    1,
    "no new session may exist: the old one dies before the new one is born",
  );
});

test("a corrupted stored destination is a failed sign-in, not an open redirect", async () => {
  const app = deployment();
  const started = await start(app);
  await armProvider(app, started);
  const record = app.blobs.entries.get(`auth/oauth/${hashToken(started.state)}`);
  record.data.payload.destination = "https://evil.example.com/";

  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
  assert.equal(landed.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(landed).has(SESSION_COOKIE), false);
});

test("the callback route answers GET only", async () => {
  const app = deployment();
  const response = await app.callback(browserRequest("/api/hosted/auth/callback", { method: "POST" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

/* ------------------------------------------------------------------ */
/* POST /api/hosted/auth/logout                                        */
/* ------------------------------------------------------------------ */

test("a GET never logs anybody out", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const response = await app.logout(
    browserRequest("/api/hosted/auth/logout", { cookies: { [SESSION_COOKIE]: token } }),
  );
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(setCookies(response).size, 0);
  assert.notEqual(await app.store.readSession(token), null, "the session is untouched");
});

test("a forged logout revokes nothing", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  for (const request of [
    browserRequest("/api/hosted/auth/logout", { method: "POST", cookies: { [SESSION_COOKIE]: token } }),
    browserRequest("/api/hosted/auth/logout", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf: "wrong-token-value" }),
    browserRequest("/api/hosted/auth/logout", { method: "POST", cookies: { [SESSION_COOKIE]: token }, csrf: deriveCsrfToken(token), origin: "https://evil.example.com" }),
  ]) {
    const response = await app.logout(request);
    assert.ok(response.status === 403 || response.status === 401, `status ${response.status}`);
    assert.equal(setCookies(response).size, 0);
    assert.notEqual(await app.store.readSession(token), null);
  }
});

test("a valid logout revokes, clears the cookie, and redirects to the Auth0 logout URL", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const response = await app.logout(
    browserRequest("/api/hosted/auth/logout", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    buildLogoutUrl({
      domain: TENANT_DOMAIN,
      clientId: AUDIENCE,
      returnTo: "https://app.archon.example.com/",
    }),
    "the Auth0 session is ended with the exact allowlisted returnTo",
  );
  assert.equal(cookieValue(setCookies(response).get(SESSION_COOKIE)), "");

  const copied = browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } });
  assert.equal(await identifyHosted(copied, { store: app.store }), null, "a copied old cookie must fail");
});

test("a fetch sign-out revokes server-side and returns the signed-out body, no cross-origin redirect", async () => {
  /* A `fetch` cannot follow a cross-origin redirect, so an in-page sign-out that
     asks for JSON gets the signed-out body and clears its own view; the Archon
     session is still revoked server-side first. */
  const app = deployment();
  const { token } = await signIn(app);
  const response = await app.logout(
    browserRequest("/api/hosted/auth/logout", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
      headers: { accept: "application/json" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { v: 1, authenticated: false });
  assert.equal(response.headers.get("location"), null, "a fetch caller gets no redirect it cannot follow");
  assert.equal(cookieValue(setCookies(response).get(SESSION_COOKIE)), "");
  const copied = browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } });
  assert.equal(await identifyHosted(copied, { store: app.store }), null, "the token is dead server-side");
});

test("a logout that cannot revoke does not redirect or clear the cookie", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  app.blobs.fail("sessions/", "write");
  const response = await app.logout(
    browserRequest("/api/hosted/auth/logout", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
    }),
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "unavailable");
  assert.equal(setCookies(response).size, 0, "clearing here would report a logout that did not happen");
  assert.notEqual(await app.store.readSession(token), null);
});

test("a logout leaves a pending publication binding alone", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const binding = await createPendingBinding(app.store, { operation: "b".repeat(43) });
  const bindingToken = cookieValue(binding.setCookie);
  await app.logout(
    browserRequest("/api/hosted/auth/logout", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token, [BINDING_COOKIE]: bindingToken },
      csrf: deriveCsrfToken(token),
    }),
  );
  assert.notEqual(await app.store.readTransient("binding", bindingToken), null);
});

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

test("an invalid configuration refuses the route without naming the key", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.AUTH0_CLIENT_SECRET;
    process.env.HOSTED_APP_ORIGIN = "https://app.archon.example.com";
    process.env.HOSTED_RENDER_ORIGIN = "https://render.archon.example.net";
    process.env.AUTH0_DOMAIN = "tenant.archon.example.com";
    process.env.AUTH0_CLIENT_ID = "exampleAuth0ClientId0000000000000";
    const response = await startHandler(
      browserRequest("/api/hosted/auth/start", { method: "POST", form: {} }),
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "unavailable");
    assert.ok(!body.error.message.includes("AUTH0_CLIENT_SECRET"));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

/* --- the platform allowlist at sign-in (#227) ------------------------------ */

/**
 * Drive one whole sign-in that is *allowed to be refused*.
 *
 * `signIn` above reads the session cookie off the landing, which is the right
 * shape for a happy path and throws for a refusal. These cases are about the
 * refusal, so the landing is returned as-is.
 */
async function attemptSignIn(app, { claims = CLAIMS_GOOGLE } = {}) {
  const started = await start(app, {});
  assert.equal(started.response.status, 303);
  await armProvider(app, started, { claims });
  return app.callback(
    browserRequest(`/api/hosted/auth/callback?state=${started.state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
}

test("with the gate off, a sign-in reads no allowlist at all", async () => {
  /* An operator who has not turned the gate on pays nothing for it, and - more
     usefully - cannot have sign-in broken by an allowlist store they have never
     configured being unreachable. */
  const app = deployment();
  const { landed } = await signIn(app);
  assert.equal(landed.status, 303);
  assert.notEqual(setCookies(landed).get(SESSION_COOKIE), undefined, "a session was created");
  assert.deepEqual(app.provider.calls, [], "the allowlist store was never opened");
});

test("with the gate on, an address that is not on the list gets no session", async () => {
  const app = deployment({ env: { ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true" } });
  const landed = await attemptSignIn(app);

  assert.equal(landed.status, 303);
  /* The destination is carried through, so a visitor who is later invited
     lands where they were going instead of silently on the default. */
  assert.equal(
    landed.headers.get("location"),
    "/login/?status=not_allowed&destination=%2Fpublish%2Fauthorize",
  );
  assert.equal(setCookies(landed).get(SESSION_COOKIE), undefined, "no session cookie is issued");
});

test("with the gate on, an allowlisted address signs in", async () => {
  const app = deployment({ env: { ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true" } });
  await addAllowlistEntry(
    { value: GOOGLE_EMAIL, actor: "ops@example.com", now: () => new Date() },
    { store: app.allowlist },
  );
  const { landed, token } = await signIn(app);
  assert.equal(landed.status, 303);
  assert.ok(typeof token === "string" && token !== "", "a session cookie is issued");
});

test("a seeded admin signs in under an enforced empty list", async () => {
  /* The recovery path: an operator who enforced an empty list can still get in
     and fix it, without the allowlist store having to be readable. */
  const app = deployment({
    env: { ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true", ARCHON_ADMINS: GOOGLE_EMAIL },
  });
  const { landed } = await signIn(app);
  assert.equal(landed.headers.get("location"), "/publish/authorize");
});

test("an unreadable allowlist is an outage, never 'you are not allowed'", async () => {
  /* `null` is not the empty list. A visitor told they are not allowed acts on it
     by giving up; a visitor told the service is unavailable retries. */
  const app = deployment({ env: { ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true" } });
  app.provider.failNextRead({ throws: true });
  const landed = await attemptSignIn(app);
  assert.equal(
    landed.headers.get("location"),
    "/login/?status=unavailable&destination=%2Fpublish%2Fauthorize",
  );
  assert.equal(setCookies(landed).get(SESSION_COOKIE), undefined);
});

test("every landing word the callback can use is in the closed set", async () => {
  /* The sign-in page renders a fixed message per word and ignores anything else,
     so a word that escaped this set would be a status a visitor never sees. */
  for (const status of ["not_allowed", "verify_email", "unavailable"]) {
    assert.ok(CALLBACK_STATUSES.includes(status), `${status} is announced by the sign-in page`);
  }
});
