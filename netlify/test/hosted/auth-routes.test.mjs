/**
 * Regressions for the four frozen auth routes, exercised as HTTP.
 *
 * These are real `Request` objects through the real handlers behind the real
 * error boundary, with only the store, the clock and the provider injected. That
 * matters for the cookie assertions in particular: C1's cookie rules are
 * properties of a response header, and a test that inspected a helper's return
 * value instead would pass while the handler forgot to attach it.
 *
 * The suite asserts effects rather than rendered text - which token still works,
 * which record is dead, which cookie was not touched - because "the sign-in page
 * says you are signed in" is exactly the assertion that survives every
 * interesting bug.
 *
 *   node --test netlify/test/hosted/auth-routes.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthStore, SESSION_TTL_SECONDS, TRANSIENT_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
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
import startHandler, { createStartRoute } from "../../functions/hosted-auth-github-start.mjs";
import { createCallbackRoute } from "../../functions/hosted-auth-github-callback.mjs";
import { createLogoutRoute } from "../../functions/hosted-auth-logout.mjs";
import { createSessionRoute } from "../../functions/hosted-session.mjs";
import { hashToken } from "../../lib/hosted/secrets.mjs";
import {
  PRINCIPAL_ALPHA,
  PRINCIPAL_BETA,
  browserRequest,
  cookieValue,
  fixedClock,
  githubProvider,
  hostedConfig,
  memoryAuthStore,
  setCookies,
} from "./fixtures/auth.mjs";

/** One deployment: a store, a clock, a configuration and the four routes. */
function deployment({ clock = fixedClock(), provider = githubProvider() } = {}) {
  const { store, blobs } = memoryAuthStore(clock);
  const config = hostedConfig();
  const deps = { store, config };
  return {
    store,
    blobs,
    clock,
    config,
    provider,
    session: withErrorBoundary(createSessionRoute(deps)),
    start: withErrorBoundary(createStartRoute(deps)),
    callback: withErrorBoundary(createCallbackRoute({ ...deps, fetchImpl: provider })),
    logout: withErrorBoundary(createLogoutRoute(deps)),
  };
}

/** Bootstrap a pre-login CSRF binding the way the sign-in page does. */
async function bootstrap(app) {
  const response = await app.session(browserRequest("/api/hosted/session"));
  return cookieValue(setCookies(response).get(LOGIN_COOKIE));
}

/** Start one authorization and return both halves of the browser binding. */
async function start(app, { destination, cookies = {}, form = {} } = {}) {
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { ...cookies, [LOGIN_COOKIE]: login },
      form: destination === undefined ? form : { ...form, destination },
    }),
  );
  if (response.status !== 303) return { response, binding: null, state: null };
  return {
    response,
    binding: cookieValue(setCookies(response).get(OAUTH_COOKIE)),
    state: new URL(response.headers.get("location")).searchParams.get("state"),
  };
}

/** Drive one whole sign-in and return the session cookie the browser is left with. */
async function signIn(app, { destination, cookies = {} } = {}) {
  const started = await start(app, { destination, cookies });
  assert.equal(started.response.status, 303);
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${started.state}&code=fixture-code`, {
      cookies: { ...cookies, [OAUTH_COOKIE]: started.binding },
    }),
  );
  return {
    started: started.response,
    landed,
    state: started.state,
    binding: started.binding,
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

  /* The whole point: the primary button on the sign-in page is a form POST, and
     for a signed-in visitor it used to arrive with no binding at all and bounce
     off `/login/?status=expired` with nothing to act on. */
  const started = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token, [LOGIN_COOKIE]: login },
      form: {},
    }),
  );
  assert.equal(started.status, 303);
  assert.ok(started.headers.get("location").startsWith("https://github.com/login/oauth/authorize"));
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
  const oauth = await app.store.createTransient("oauth", { codeVerifier: "v", destination: "/publish/authorize" });

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
  assert.deepEqual(Object.keys(body).sort(), ["accountId", "authenticated", "csrfToken", "login", "v"]);
  assert.equal(body.accountId, "gh_1010");
  assert.equal(body.login, "alpha-example");
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
/* POST /api/hosted/auth/github/start                                  */
/* ------------------------------------------------------------------ */

test("a start redirects to GitHub with the state that is in the cookie", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
  );
  assert.equal(response.status, 303);

  const url = new URL(response.headers.get("location"));
  assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.searchParams.has("prompt"), false);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://app.archon.example.com/api/hosted/auth/github/callback",
  );

  const cookies = setCookies(response);
  const binding = cookieValue(cookies.get(OAUTH_COOKIE));
  assert.notEqual(
    binding,
    url.searchParams.get("state"),
    "the cookie and the wire state must be two different secrets",
  );
  assert.match(cookies.get(OAUTH_COOKIE), /Max-Age=900; Secure; HttpOnly; SameSite=Lax; Path=\/$/);
  assert.equal(cookieValue(cookies.get(LOGIN_COOKIE)), "", "the consumed binding is cleared");

  /* Nothing recoverable from the URL alone: neither the cookie nor its stored
     hash appears anywhere GitHub, a log or a history entry will see it. */
  const record = app.blobs.entries.get(`auth/oauth/${hashToken(url.searchParams.get("state"))}`);
  assert.equal(record.data.payload.bindingHash, hashToken(binding));
  assert.ok(!response.headers.get("location").includes(binding));
});

test("knowing the callback URL is not enough to redeem the code", async () => {
  const app = deployment();
  const started = await start(app);

  /* Everything an attacker can learn from a function access log, an APM trace or
     a synced history entry - and nothing the victim's browser holds. */
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${started.state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: "an-attacker-supplied-binding-value" },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
  assert.equal(app.provider.calls.length, 0, "the code must not be redeemed");

  /* And the victim's transaction is untouched: an unbound caller cannot burn it. */
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${started.state}&code=fixture-code`, {
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
      browserRequest(`/api/hosted/auth/github/callback?state=${started.state}&code=c`, { cookies }),
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
    /* A JSON caller gets the C3 envelope... */
    const api = await app.start(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {}, origin }),
    );
    assert.equal(api.status, 403);
    assert.equal((await api.json()).error.code, "forbidden");

    /* ...and a form navigation gets a page, because the response *is* the page
       the visitor is looking at. */
    const page = await app.start(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {}, origin }),
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
  const bare = await app.start(browserRequest("/api/hosted/auth/github/start", { method: "POST", json: {} }));
  assert.equal(bare.status, 403);
  assert.equal((await bare.json()).error.code, "csrf_failed");

  const login = await bootstrap(app);
  const first = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {} }),
  );
  assert.equal(first.status, 303);
  assert.equal(
    await app.store.readTransient("login", login),
    null,
    "the first use consumes the issued record",
  );

  const replay = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: {} }),
  );
  assert.equal(replay.status, 403, "a captured binding must not be replayable");
  assert.equal((await replay.json()).error.code, "csrf_failed");
});

test("a malformed or fabricated binding cookie is refused without writing anything", async () => {
  const app = deployment();
  /* The last one is well-formed and simply was never issued by this deployment:
     the binding is provenance, not a shape check. */
  for (const binding of ["", "short", "not/base64url/at/all", "x".repeat(300), "c".repeat(43)]) {
    const response = await app.start(
      browserRequest("/api/hosted/auth/github/start", {
        method: "POST",
        cookies: { [LOGIN_COOKIE]: binding },
        json: {},
      }),
    );
    assert.equal(response.status, 403, `binding ${JSON.stringify(binding)}`);
  }
  assert.deepEqual(app.blobs.keys(), []);
});

test("a start accepts only the two internal destinations", async () => {
  const app = deployment();
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  for (const destination of ["/publish/authorize", docs]) {
    const login = await bootstrap(app);
    const response = await app.start(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: { destination } }),
    );
    assert.equal(response.status, 303);
  }
  for (const destination of ["//evil.example.com", "https://evil.example.com", "/\\evil.example.com", "/admin", "%2Fpublish%2Fauthorize"]) {
    const login = await bootstrap(app);
    const response = await app.start(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, json: { destination } }),
    );
    assert.equal(response.status, 400, `destination ${destination}`);
    assert.equal((await response.json()).error.code, "invalid_request");
  }
});

test("an empty destination field is the default, not a refusal", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const response = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: login },
      form: { destination: "" },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(
    new URL(response.headers.get("location")).origin,
    "https://github.com",
    "a form submits an empty string, not an absent field, and empty means the default",
  );
});

test("the destination never travels to GitHub", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const docs = `/docs/${"a1b2c3d4".repeat(4)}`;
  const response = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: { destination: docs } }),
  );
  assert.ok(!response.headers.get("location").includes("docs"));
});

test("the start route answers POST only", async () => {
  const app = deployment();
  const response = await app.start(browserRequest("/api/hosted/auth/github/start"));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

/* ------------------------------------------------------------------ */
/* the different-account action                                        */
/* ------------------------------------------------------------------ */

test("switching accounts revokes the Archon session and asks GitHub which account", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const binding = await createPendingBinding(app.store, { operation: "b".repeat(43) });
  const bindingToken = cookieValue(binding.setCookie);

  const response = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token, [BINDING_COOKIE]: bindingToken },
      form: { switchAccount: "true", csrfToken: deriveCsrfToken(token) },
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("location")).searchParams.get("prompt"), "select_account");

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
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      json: { switchAccount: "true" },
    }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, "csrf_failed");

  const noSession = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      json: { switchAccount: "true", csrfToken: deriveCsrfToken(token) },
    }),
  );
  assert.equal(noSession.status, 401);
  assert.equal((await noSession.json()).error.code, "session_required");
  assert.notEqual(await app.store.readSession(token), null, "a refused switch revokes nothing");
});

/* ------------------------------------------------------------------ */
/* GET /api/hosted/auth/github/callback                                */
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
    /^__Host-archon_session=[A-Za-z0-9_-]+; Max-Age=604800; Secure; HttpOnly; SameSite=Lax; Path=\/$/,
  );
  assert.equal(cookieValue(cookies.get(OAUTH_COOKIE)), "", "the consumed state is cleared");

  const principal = await identifyHosted(
    browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } }),
    { store: app.store },
  );
  assert.deepEqual(principal, PRINCIPAL_ALPHA);
});

test("the session cookie lifetime is the seven-day absolute expiry", async () => {
  /* Both numbers are written out rather than read from the modules under
     test. Advancing the clock by the production constant would pass for any
     value of it: a thirty-day server record and a seven-day cookie would look
     consistent here while a copied token outlived the cookie by three weeks. */
  const SEVEN_DAYS = 604800;
  assert.equal(SESSION_TTL_SECONDS, SEVEN_DAYS, "C1 freezes the record at seven days");
  assert.equal(SESSION_COOKIE_MAX_AGE, SEVEN_DAYS, "the cookie may not outlive the record");
  assert.equal(SESSION_COOKIE_MAX_AGE, SESSION_TTL_SECONDS);

  const app = deployment();
  const { token } = await signIn(app);
  app.clock.advanceSeconds(SEVEN_DAYS - 1);
  assert.notEqual(await app.store.readSession(token), null);
  app.clock.advanceSeconds(2);
  assert.equal(await app.store.readSession(token), null);
});

test("a callback with no binding cookie or a mismatched state signs nobody in", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const started = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
  );
  const binding = cookieValue(setCookies(started).get(OAUTH_COOKIE));
  const state = new URL(started.headers.get("location")).searchParams.get("state");

  for (const [query, cookies] of [
    [state, {}],
    [state, { [OAUTH_COOKIE]: "a-different-state" }],
    ["a-different-state", { [OAUTH_COOKIE]: state }],
    [null, { [OAUTH_COOKIE]: state }],
  ]) {
    const path = query === null
      ? "/api/hosted/auth/github/callback?code=c"
      : `/api/hosted/auth/github/callback?state=${query}&code=c`;
    const response = await app.callback(browserRequest(path, { cookies }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/login/?status=expired");
    assert.equal(setCookies(response).has(SESSION_COOKIE), false);
  }
  assert.notEqual(await app.store.readTransient("oauth", state), null, "a refused callback consumes nothing");
});

test("a state is consumed once: a replayed callback signs nobody in", async () => {
  const app = deployment();
  const { state, binding } = await signIn(app);
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: binding },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
});

test("two simultaneous callbacks with one state create at most one session", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const started = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
  );
  const binding = cookieValue(setCookies(started).get(OAUTH_COOKIE));
  const state = new URL(started.headers.get("location")).searchParams.get("state");
  const request = () =>
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=fixture-code`, {
      cookies: { [OAUTH_COOKIE]: binding },
    });

  const [a, b] = await Promise.all([app.callback(request()), app.callback(request())]);
  const issued = [a, b].filter((response) => setCookies(response).has(SESSION_COOKIE));
  assert.equal(issued.length, 1, "an unconditional delete would let both through");
  assert.equal(app.blobs.keys().filter((key) => key.startsWith("sessions/")).length, 1);
});

test("a denied consent is a normal outcome with an actionable retry", async () => {
  const app = deployment();
  const login = await bootstrap(app);
  const started = await app.start(
    browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
  );
  const binding = cookieValue(setCookies(started).get(OAUTH_COOKIE));
  const state = new URL(started.headers.get("location")).searchParams.get("state");
  const response = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&error=access_denied&error_description=nope`, {
      cookies: { [OAUTH_COOKIE]: binding },
    }),
  );
  assert.equal(
    response.headers.get("location"),
    "/login/?status=denied&destination=%2Fpublish%2Fauthorize",
    "a retry must land back where the visitor was going",
  );
  assert.equal(setCookies(response).has(SESSION_COOKIE), false);
  assert.equal(app.provider.calls.length, 0, "a denied consent never redeems a code");

  /* The transaction is over, so the state must be spent. While it stayed live,
     anyone holding a copy of the cookie and the callback URL could redeem it
     with any code for the rest of the fifteen-minute window - and the visitor
     who pressed Cancel is the one person known not to want that. */
  assert.equal(await app.store.readTransient("oauth", state), null, "the state is consumed");
  const replay = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: binding },
    }),
  );
  assert.equal(replay.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(replay).has(SESSION_COOKIE), false);
  assert.equal(app.provider.calls.length, 0);
});

test("a provider that refuses, or misbehaves, signs nobody in", async () => {
  for (const [fixture, status] of [
    [{ token: { error: "bad_verification_code" } }, "expired"],
    [{ token: { access_token: "t", token_type: "bearer", scope: "repo" } }, "expired"],
    [{ token: "malformed" }, "expired"],
    [{ user: { id: "1010", login: "alpha-example" } }, "expired"],
    [{ token: "timeout" }, "unavailable"],
    [{ userStatus: 503, user: {} }, "unavailable"],
  ]) {
    const app = deployment({ provider: githubProvider(fixture) });
    const login = await bootstrap(app);
    const started = await app.start(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", cookies: { [LOGIN_COOKIE]: login }, form: {} }),
    );
    const binding = cookieValue(setCookies(started).get(OAUTH_COOKIE));
  const state = new URL(started.headers.get("location")).searchParams.get("state");
    const response = await app.callback(
      browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=c`, { cookies: { [OAUTH_COOKIE]: binding } }),
    );
    assert.equal(
      response.headers.get("location"),
      `/login/?status=${status}&destination=%2Fpublish%2Fauthorize`,
      JSON.stringify(fixture),
    );
    assert.equal(setCookies(response).has(SESSION_COOKIE), false);
    assert.deepEqual(app.blobs.keys().filter((key) => key.startsWith("sessions/")), []);
  }
});

test("signing in over an existing session revokes the old token first", async () => {
  const app = deployment();
  const first = await signIn(app);
  assert.notEqual(await app.store.readSession(first.token), null);

  app.provider = githubProvider({ user: { id: 2020, login: "alpha-example" } });
  const app2 = { ...app, callback: withErrorBoundary(createCallbackRoute({ store: app.store, config: app.config, fetchImpl: app.provider })) };

  const login = await bootstrap(app);
  const started = await app.start(
    browserRequest("/api/hosted/auth/github/start", {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: login, [SESSION_COOKIE]: first.token },
      form: {},
    }),
  );
  const binding = cookieValue(setCookies(started).get(OAUTH_COOKIE));
  const state = new URL(started.headers.get("location")).searchParams.get("state");
  const landed = await app2.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: binding, [SESSION_COOKIE]: first.token },
    }),
  );

  assert.equal(await app.store.readSession(first.token), null, "the rotated-out token is dead");
  const second = cookieValue(setCookies(landed).get(SESSION_COOKIE));
  assert.deepEqual((await app.store.readSession(second)).principal, PRINCIPAL_BETA);
});

test("a callback that cannot revoke the old session signs nobody in", async () => {
  const app = deployment();
  const first = await signIn(app);
  const started = await start(app);
  const { binding, state } = started;

  /* The fault is armed on the *old* session's exact key, not on the `sessions/`
     prefix. A prefix fault is consumed by `createSession` instead, which
     produces the same landing and the same live old token whether or not the
     revocation is attempted at all - so the test would pass with the rotation
     deleted. This one fails unless the old session is revoked first. */
  app.blobs.fail(AuthStore.sessionKey(first.token), "write");
  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: binding, [SESSION_COOKIE]: first.token },
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
  const record = app.blobs.entries.get(`auth/oauth/${hashToken(started.state)}`);
  record.data.payload.destination = "https://evil.example.com/";

  const landed = await app.callback(
    browserRequest(`/api/hosted/auth/github/callback?state=${started.state}&code=c`, {
      cookies: { [OAUTH_COOKIE]: started.binding },
    }),
  );
  assert.equal(landed.headers.get("location"), "/login/?status=expired");
  assert.equal(setCookies(landed).has(SESSION_COOKIE), false);
});

test("the callback route answers GET only", async () => {
  const app = deployment();
  const response = await app.callback(browserRequest("/api/hosted/auth/github/callback", { method: "POST" }));
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

test("a valid logout makes the prior cookie unusable", async () => {
  const app = deployment();
  const { token } = await signIn(app);
  const response = await app.logout(
    browserRequest("/api/hosted/auth/logout", {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { v: 1, authenticated: false });
  assert.equal(cookieValue(setCookies(response).get(SESSION_COOKIE)), "");

  const copied = browserRequest("/x", { cookies: { [SESSION_COOKIE]: token } });
  assert.equal(await identifyHosted(copied, { store: app.store }), null, "a copied old cookie must fail");
});

test("a logout that cannot revoke does not claim success or clear the cookie", async () => {
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
  assert.equal(setCookies(response).size, 0, "clearing the cookie here would report a logout that did not happen");
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
    delete process.env.GITHUB_CLIENT_SECRET;
    process.env.HOSTED_APP_ORIGIN = "https://app.archon.example.com";
    process.env.HOSTED_RENDER_ORIGIN = "https://render.archon.example.net";
    process.env.GITHUB_CLIENT_ID = "Iv1.fixture0client";
    const response = await startHandler(
      browserRequest("/api/hosted/auth/github/start", { method: "POST", form: {} }),
    );
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, "unavailable");
    assert.ok(!body.error.message.includes("GITHUB_CLIENT_SECRET"));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
