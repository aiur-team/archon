/**
 * Regressions for `../../lib/hosted/github-oauth.mjs`.
 *
 * No test here contacts GitHub. Every provider answer is a fixture, which is the
 * only way to exercise the responses that matter most - a refusal delivered with
 * HTTP 200, a token carrying a scope nobody asked for, a timeout - none of which
 * a live provider can be asked to produce on demand.
 *
 * The suite asserts actual principal values rather than "sign-in succeeded", and
 * it asserts absences as hard as presences: no access token in the return value,
 * no scope parameter in the authorize URL, no client secret in a query string.
 *
 *   node --test netlify/test/hosted/github-oauth.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuthRequestError, AuthUnavailableError } from "../../lib/hosted/auth-errors.mjs";
import {
  CALLBACK_PATH,
  GITHUB_AUTHORIZE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  buildAuthorizeUrl,
  callbackUri,
  createPkcePair,
  exchangeCodeForIdentity,
} from "../../lib/hosted/github-oauth.mjs";
import { HOSTED_ENV, PRINCIPAL_ALPHA, githubProvider, hostedConfig } from "./fixtures/auth.mjs";

/** The one call under test, with everything but the varying part fixed. */
function exchange(provider, { code = "fixture-code", codeVerifier = "fixture-verifier" } = {}) {
  return exchangeCodeForIdentity(
    { code, codeVerifier, config: hostedConfig() },
    { fetchImpl: provider },
  );
}

test("the provider endpoints are fixed, not configurable", () => {
  assert.equal(GITHUB_AUTHORIZE_URL, "https://github.com/login/oauth/authorize");
  assert.equal(GITHUB_TOKEN_URL, "https://github.com/login/oauth/access_token");
  assert.equal(GITHUB_USER_URL, "https://api.github.com/user");
  assert.equal(CALLBACK_PATH, "/api/hosted/auth/github/callback");
  assert.equal(
    callbackUri("https://app.archon.example.com"),
    "https://app.archon.example.com/api/hosted/auth/github/callback",
  );
});

test("PKCE is S256 over an unreserved verifier", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier, "utf8").digest("base64url"));
  assert.notEqual(challenge, verifier, "a plain challenge would put the verifier in the URL");
  assert.notEqual(createPkcePair().verifier, verifier);
});

test("the authorize URL asks for no permission at all", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "Iv1.fixture0client",
      redirectUri: callbackUri("https://app.archon.example.com"),
      state: "fixture-state",
      codeChallenge: "fixture-challenge",
    }),
  );
  assert.equal(url.origin + url.pathname, GITHUB_AUTHORIZE_URL);
  assert.equal(
    url.searchParams.has("scope"),
    false,
    "an empty scope parameter is not the same as none, and the consent screen shows the difference",
  );
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "fixture-state");
  assert.equal(url.searchParams.has("prompt"), false);
});

test("prompt=select_account appears only for a deliberate account switch", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "Iv1.fixture0client",
      redirectUri: callbackUri("https://app.archon.example.com"),
      state: "fixture-state",
      codeChallenge: "fixture-challenge",
      selectAccount: true,
    }),
  );
  assert.equal(url.searchParams.get("prompt"), "select_account");
});

test("the authorize URL cannot be built from a missing part", () => {
  for (const missing of ["clientId", "redirectUri", "state", "codeChallenge"]) {
    const parts = {
      clientId: "Iv1.fixture0client",
      redirectUri: "https://app.archon.example.com/cb",
      state: "s",
      codeChallenge: "c",
    };
    parts[missing] = "";
    assert.throws(() => buildAuthorizeUrl(parts), TypeError);
  }
});

test("a successful exchange yields a principal and nothing else", async () => {
  const provider = githubProvider();
  const principal = await exchange(provider);
  assert.deepEqual(principal, PRINCIPAL_ALPHA);
  assert.deepEqual(Object.keys(principal).sort(), [
    "accountId",
    "login",
    "provider",
    "providerUserId",
  ]);
  const rendered = JSON.stringify(principal);
  assert.ok(!rendered.includes("fixture-provider-access-token"));
  assert.ok(!rendered.includes("fixture-provider-refresh-token"));
});

test("the credential travels in the body, and the redirect_uri is the configured one", async () => {
  const provider = githubProvider();
  await exchange(provider);
  const [tokenCall, userCall] = provider.calls;
  assert.equal(tokenCall.url, GITHUB_TOKEN_URL);
  assert.ok(!tokenCall.url.includes(HOSTED_ENV.GITHUB_CLIENT_SECRET));
  const sent = new URLSearchParams(tokenCall.request.body);
  assert.equal(sent.get("client_secret"), HOSTED_ENV.GITHUB_CLIENT_SECRET);
  assert.equal(sent.get("code_verifier"), "fixture-verifier");
  assert.equal(sent.get("redirect_uri"), callbackUri(HOSTED_ENV.HOSTED_APP_ORIGIN));
  assert.equal(userCall.request.headers.authorization, "Bearer fixture-provider-access-token");
});

test("an unexpected granted scope is refused rather than used", async () => {
  /* A scope in a shape this code cannot read is not a "no". `["repo"]` is not a
     non-empty string, so a `typeof === "string"` test would wave it through and
     the service would use a token carrying permissions the consent screen never
     showed. */
  for (const scope of ["repo", "read:user", "repo,workflow", ["repo"], { repo: true }, 1]) {
    const provider = githubProvider({
      token: { access_token: "t", token_type: "bearer", scope },
    });
    await assert.rejects(() => exchange(provider), AuthRequestError);
    assert.equal(provider.calls.length, 1, "the identity call must not happen");
  }
});

test("a refusal delivered with HTTP 200 is a refusal", async () => {
  const provider = githubProvider({
    token: { error: "bad_verification_code", error_description: "wrong" },
  });
  await assert.rejects(() => exchange(provider), AuthRequestError);

  /* The interesting shape is a body that carries an error *and* something that
     looks like a usable token. Without the `error` check the rest of this
     response satisfies every other rule, so the exchange would proceed on a
     credential the provider has just said is not valid. */
  const contradictory = githubProvider({
    token: {
      error: "bad_verification_code",
      access_token: "fixture-provider-access-token",
      token_type: "bearer",
      scope: "",
    },
  });
  await assert.rejects(() => exchange(contradictory), AuthRequestError);
  assert.equal(contradictory.calls.length, 1, "the identity call must not happen");
});

test("a token response missing its token, or bearing the wrong type, is refused", async () => {
  for (const token of [
    { token_type: "bearer", scope: "" },
    { access_token: "", token_type: "bearer", scope: "" },
    { access_token: 12, token_type: "bearer", scope: "" },
    { access_token: "t", scope: "" },
    { access_token: "t", token_type: "mac", scope: "" },
  ]) {
    await assert.rejects(() => exchange(githubProvider({ token })), AuthRequestError);
  }
});

test("malformed provider JSON is a refusal, not a crash", async () => {
  await assert.rejects(() => exchange(githubProvider({ token: "malformed" })), AuthRequestError);
  await assert.rejects(() => exchange(githubProvider({ user: "malformed" })), AuthRequestError);
  await assert.rejects(
    () => exchange(githubProvider({ token: ["not", "a", "record"] })),
    AuthRequestError,
  );
});

test("a provider timeout is unavailable, not a failed sign-in", async () => {
  for (const fixture of [{ token: "timeout" }, { user: "timeout" }]) {
    await assert.rejects(() => exchange(githubProvider(fixture)), (error) => {
      assert.ok(error instanceof AuthUnavailableError);
      assert.equal(error.reason, "provider");
      assert.equal(error.retryable, true);
      return true;
    });
  }
});

test("a provider 5xx is unavailable and a 4xx is not", async () => {
  await assert.rejects(
    () => exchange(githubProvider({ tokenStatus: 503, token: { error: "unavailable" } })),
    AuthUnavailableError,
  );
  await assert.rejects(
    () => exchange(githubProvider({ userStatus: 500, user: { id: 1 } })),
    AuthUnavailableError,
  );
  await assert.rejects(
    () => exchange(githubProvider({ userStatus: 401, user: { message: "Bad credentials" } })),
    AuthRequestError,
  );
});

test("the numeric id is the identity, and an unsafe one cannot collide with a valid account", async () => {
  for (const id of ["1010", "0", 0, -5, 1.5, null, undefined, { toString: () => "1010" }, 1e21]) {
    await assert.rejects(
      () => exchange(githubProvider({ user: { id, login: "alpha-example" } })),
      AuthRequestError,
      `provider id ${String(id)} must not become an account`,
    );
  }
});

test("a login that is not a login cannot become a principal", async () => {
  for (const login of ["alpha@example.com", "-leading", "way".repeat(20), "", null, "a b"]) {
    await assert.rejects(
      () => exchange(githubProvider({ user: { id: 1010, login } })),
      AuthRequestError,
    );
  }
});

test("an account with no public email signs in exactly like any other", async () => {
  const withEmail = await exchange(
    githubProvider({ user: { id: 1010, login: "alpha-example", email: "a@example.com" } }),
  );
  const withoutEmail = await exchange(
    githubProvider({ user: { id: 1010, login: "alpha-example", email: null } }),
  );
  assert.deepEqual(withEmail, withoutEmail);
  assert.deepEqual(withEmail, PRINCIPAL_ALPHA);
});

test("one numeric id under two login snapshots is one account", async () => {
  const before = await exchange(githubProvider({ user: { id: 1010, login: "alpha-example" } }));
  const after = await exchange(githubProvider({ user: { id: 1010, login: "alpha-renamed" } }));
  assert.equal(before.accountId, after.accountId);
  assert.notEqual(before.login, after.login);
});

test("two numeric ids sharing one login are two accounts", async () => {
  const alpha = await exchange(githubProvider({ user: { id: 1010, login: "alpha-example" } }));
  const beta = await exchange(githubProvider({ user: { id: 2020, login: "alpha-example" } }));
  assert.equal(alpha.login, beta.login);
  assert.notEqual(alpha.accountId, beta.accountId);
});

test("an empty code or verifier never reaches the provider", async () => {
  const provider = githubProvider();
  await assert.rejects(() => exchange(provider, { code: "" }), AuthRequestError);
  await assert.rejects(() => exchange(provider, { codeVerifier: "" }), AuthRequestError);
  assert.equal(provider.calls.length, 0);
});
