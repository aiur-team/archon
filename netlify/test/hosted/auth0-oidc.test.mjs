/**
 * Regressions for `../../lib/hosted/auth0-oidc.mjs`.
 *
 * No test here contacts Auth0. The token endpoint is a fake `fetch`, and every
 * ID token is a genuine RS256 JWT minted by the fixture and verified against a
 * local JWKS, which is the only way to exercise the answers that matter most - a
 * mismatched nonce, a wrong audience, a wrong issuer, an `alg: HS256` token -
 * none of which a live tenant can be asked to produce on demand.
 *
 * The suite asserts actual claims and principal values rather than "sign-in
 * succeeded", and it asserts absences as hard as presences: no client secret in
 * the request query, `email: null` when the claim is absent, `emailVerified`
 * false for a string `"true"`.
 *
 *   node --test netlify/test/hosted/auth0-oidc.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuthRequestError, AuthUnavailableError } from "../../lib/hosted/auth-errors.mjs";
import {
  CALLBACK_PATH,
  SCOPE,
  authorizeEndpoint,
  buildAuthorizeUrl,
  buildLogoutUrl,
  callbackUri,
  createNonce,
  createPkcePair,
  exchangeCodeForIdToken,
  issuerUrl,
  jwksUri,
  principalFromClaims,
  tokenEndpoint,
  verifyIdToken,
} from "../../lib/hosted/auth0-oidc.mjs";
import { deriveAccountId, validatePrincipal } from "../../lib/hosted/contracts.mjs";
import {
  AUDIENCE,
  CLAIMS_GITHUB_NO_EMAIL,
  CLAIMS_GOOGLE,
  ISSUER,
  TENANT_DOMAIN,
  TOKEN_ENDPOINT,
  auth0Provider,
  hostedConfig,
  localKeySet,
  signHs256Token,
  signIdToken,
} from "./fixtures/auth.mjs";

const CONFIG = hostedConfig();

/** Exchange one code against the fake token endpoint. */
function exchange(provider, { code = "fixture-code", codeVerifier = "fixture-verifier" } = {}) {
  return exchangeCodeForIdToken({ code, codeVerifier, config: CONFIG }, { fetchImpl: provider });
}

/** Verify one token against the local JWKS, with the seam injected. */
function verify(idToken, nonce) {
  return verifyIdToken({ idToken, nonce, config: CONFIG }, { getKeySet: localKeySet });
}

/* ------------------------------------------------------------------ */
/* endpoints and the authorize URL                                     */
/* ------------------------------------------------------------------ */

test("every endpoint is derived from the one configured domain", () => {
  assert.equal(CALLBACK_PATH, "/api/hosted/auth/callback");
  assert.equal(authorizeEndpoint(TENANT_DOMAIN), `https://${TENANT_DOMAIN}/authorize`);
  assert.equal(tokenEndpoint(TENANT_DOMAIN), `https://${TENANT_DOMAIN}/oauth/token`);
  assert.equal(jwksUri(TENANT_DOMAIN), `https://${TENANT_DOMAIN}/.well-known/jwks.json`);
  assert.equal(issuerUrl(TENANT_DOMAIN), `https://${TENANT_DOMAIN}/`);
  assert.equal(
    callbackUri("https://app.archon.example.com"),
    "https://app.archon.example.com/api/hosted/auth/callback",
  );
});

test("PKCE is S256 over an unreserved verifier", () => {
  const { verifier, challenge } = createPkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, createHash("sha256").update(verifier, "utf8").digest("base64url"));
  assert.notEqual(challenge, verifier, "a plain challenge would put the verifier in the URL");
  assert.notEqual(createPkcePair().verifier, verifier);
});

test("each nonce is fresh, opaque entropy", () => {
  assert.match(createNonce(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(createNonce(), createNonce());
});

test("the authorize URL carries the OIDC parameters and only the requested scope", () => {
  const url = new URL(
    buildAuthorizeUrl({
      domain: TENANT_DOMAIN,
      clientId: AUDIENCE,
      redirectUri: callbackUri(CONFIG.appOrigin),
      state: "state-token",
      nonce: "nonce-token",
      codeChallenge: "challenge",
    }),
  );
  assert.equal(url.origin, `https://${TENANT_DOMAIN}`);
  assert.equal(url.pathname, "/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), AUDIENCE);
  assert.equal(url.searchParams.get("scope"), SCOPE);
  assert.equal(url.searchParams.get("state"), "state-token");
  assert.equal(url.searchParams.get("nonce"), "nonce-token");
  assert.equal(url.searchParams.get("code_challenge"), "challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("prompt"), null, "an ordinary sign-in omits prompt");
  assert.equal(url.searchParams.get("audience"), null, "no API audience is ever requested");
  assert.equal(SCOPE, "openid profile email");
  assert.ok(!SCOPE.includes("offline_access"), "no refresh token is ever requested");
});

test("prompt=login appears only on the switch-account path", () => {
  const url = new URL(
    buildAuthorizeUrl({
      domain: TENANT_DOMAIN,
      clientId: AUDIENCE,
      redirectUri: callbackUri(CONFIG.appOrigin),
      state: "s",
      nonce: "n",
      codeChallenge: "c",
      switchAccount: true,
    }),
  );
  assert.equal(url.searchParams.get("prompt"), "login");
});

test("the logout URL carries the client id and an exact returnTo, and no federated flag", () => {
  const url = new URL(
    buildLogoutUrl({ domain: TENANT_DOMAIN, clientId: AUDIENCE, returnTo: `${CONFIG.appOrigin}/` }),
  );
  assert.equal(url.origin, `https://${TENANT_DOMAIN}`);
  assert.equal(url.pathname, "/v2/logout");
  assert.equal(url.searchParams.get("client_id"), AUDIENCE);
  assert.equal(url.searchParams.get("returnTo"), `${CONFIG.appOrigin}/`);
  assert.equal(url.searchParams.get("federated"), null);
});

/* ------------------------------------------------------------------ */
/* the code exchange                                                   */
/* ------------------------------------------------------------------ */

test("the exchange posts client_secret_post form fields and returns only the id token", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: "n" });
  const provider = auth0Provider({ idToken });
  const returned = await exchange(provider, { code: "the-code", codeVerifier: "the-verifier" });
  assert.equal(returned, idToken);

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].url, TOKEN_ENDPOINT);
  const sent = new URLSearchParams(provider.calls[0].request.body);
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("client_id"), CONFIG.auth0.clientId);
  assert.equal(sent.get("client_secret"), CONFIG.auth0.readClientSecret());
  assert.equal(sent.get("code"), "the-code");
  assert.equal(sent.get("code_verifier"), "the-verifier");
  assert.equal(sent.get("redirect_uri"), callbackUri(CONFIG.appOrigin));
});

test("the client secret never reaches the request URL", async () => {
  const provider = auth0Provider({ idToken: await signIdToken(CLAIMS_GOOGLE, { nonce: "n" }) });
  await exchange(provider);
  assert.ok(!provider.calls[0].url.includes(CONFIG.auth0.readClientSecret()));
});

test("a token response with no id_token is a failed sign-in", async () => {
  await assert.rejects(
    exchange(auth0Provider({ body: { access_token: "a", token_type: "Bearer" } })),
    AuthRequestError,
  );
});

test("a token endpoint 5xx is an outage, a 4xx is a bad request", async () => {
  await assert.rejects(
    exchange(auth0Provider({ body: { error: "server_error" }, status: 500 })),
    AuthUnavailableError,
  );
  await assert.rejects(
    exchange(auth0Provider({ body: { error: "invalid_grant" }, status: 400 })),
    AuthRequestError,
  );
});

test("a token endpoint timeout is an outage", async () => {
  await assert.rejects(exchange(auth0Provider({ idToken: "timeout" })), AuthUnavailableError);
});

/* ------------------------------------------------------------------ */
/* ID token verification                                               */
/* ------------------------------------------------------------------ */

test("a well-formed token with the right nonce verifies to its claims", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: "the-nonce" });
  const claims = await verify(idToken, "the-nonce");
  assert.equal(claims.sub, CLAIMS_GOOGLE.sub);
  assert.equal(claims.email, CLAIMS_GOOGLE.email);
});

test("a mismatched nonce is refused with no session", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: "minted-nonce" });
  await assert.rejects(verify(idToken, "a-different-nonce"), AuthRequestError);
});

test("a token carrying no nonce is refused even against an empty expectation", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE);
  await assert.rejects(verify(idToken, "some-nonce"), AuthRequestError);
});

test("a wrong audience is refused", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE, { nonce: "n", audience: "some-other-client" });
  await assert.rejects(verify(idToken, "n"), AuthRequestError);
});

test("a wrong issuer is refused", async () => {
  const idToken = await signIdToken(CLAIMS_GOOGLE, {
    nonce: "n",
    issuer: "https://evil.example.com/",
  });
  await assert.rejects(verify(idToken, "n"), AuthRequestError);
});

test("an HS256 token is refused by the algorithm pin", async () => {
  const idToken = await signHs256Token(CLAIMS_GOOGLE, { nonce: "n" });
  await assert.rejects(verify(idToken, "n"), AuthRequestError);
});

/* ------------------------------------------------------------------ */
/* the principal                                                       */
/* ------------------------------------------------------------------ */

test("a Google identity with a verified email becomes a verified principal", () => {
  const principal = principalFromClaims(CLAIMS_GOOGLE);
  assert.deepEqual(principal, {
    accountId: deriveAccountId(CLAIMS_GOOGLE.sub),
    provider: "auth0",
    providerUserId: CLAIMS_GOOGLE.sub,
    login: "ann",
    email: "ann@example.com",
    emailVerified: true,
  });
});

test("a picture claim from an allowed host becomes the principal's avatar", () => {
  const picture = "https://lh3.googleusercontent.com/a/fixture-avatar=s96-c";
  const principal = principalFromClaims({ ...CLAIMS_GOOGLE, picture });
  assert.equal(principal.avatarUrl, picture);

  /* Every other spelling degrades to no avatar rather than to a failed sign-in.
     A cosmetic claim must never be able to keep somebody out of the product, and
     an origin outside the allowlist must never reach a stored record - the
     landing pages' `img-src` would refuse to render it anyway, so accepting one
     would only produce a broken image and a request to a host nothing here
     chose. */
  for (const bad of [
    undefined,
    null,
    "",
    42,
    "not-a-url",
    "/relative/avatar.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "http://avatars.githubusercontent.com/u/1",
    "https://evil.example/u/1",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://user:pass@avatars.githubusercontent.com/u/1",
    `https://avatars.githubusercontent.com/u/${"9".repeat(600)}`,
  ]) {
    const degraded = principalFromClaims({ ...CLAIMS_GOOGLE, picture: bad });
    assert.equal(degraded.avatarUrl, undefined, `picture refused, sign-in kept: ${bad}`);
    assert.equal(degraded.login, "ann", "and the rest of the identity is untouched");
  }
});

test("an identity with no picture keeps the principal shape it always had", () => {
  /* The avatar key is absent, not null. A session minted before the field
     existed must still read back as a valid principal, and the way that stays
     true is that a principal without a picture is the same six-key record it
     was. */
  const principal = principalFromClaims(CLAIMS_GOOGLE);
  assert.equal(Object.hasOwn(principal, "avatarUrl"), false);
  assert.equal(validatePrincipal(principal).avatarUrl, undefined);
});

test("a GitHub identity with no email is a valid session with no email", () => {
  const principal = principalFromClaims(CLAIMS_GITHUB_NO_EMAIL);
  assert.equal(principal.providerUserId, "github|4815162");
  assert.equal(principal.email, null);
  assert.equal(principal.emailVerified, false);
  assert.equal(principal.login, "octo");
});

test("email is normalised through the one shared grammar", () => {
  const principal = principalFromClaims({ ...CLAIMS_GOOGLE, email: "  Ann@Example.COM " });
  assert.equal(principal.email, "ann@example.com");

  /* Lower-casing is not normalising, and the gap between them is reachable
     from a claim. U+212A KELVIN SIGN lower-cases to an ASCII `k`, so a bare
     `toLowerCase()` turned this claim into a *verified* principal at
     `ann@book.example` - an address the provider never asserted, and one that
     ACN-007's evaluator would exact-match against a document listing
     `book.example`. `validatePrincipal` cannot catch it: by the time it checks
     for printable ASCII, the fold has already produced printable ASCII.
     Refusing non-ASCII before folding is what closes it, and the claim then
     leaves the principal address-less rather than failing the sign-in. */
  const folded = principalFromClaims({
    ...CLAIMS_GOOGLE,
    email: `ann@boo\u212A.example`,
    email_verified: true,
  });
  assert.equal(folded.email, null, "a folding claim became an address");
  assert.equal(folded.emailVerified, false);

  /* And the rest of the grammar applies too, so a claim is held to exactly what
     a stored address is held to. */
  for (const email of ["ann@ example.com", "ann@exaаmple.com", "ann@localhost", "a@@b.com"]) {
    assert.equal(
      principalFromClaims({ ...CLAIMS_GOOGLE, email, email_verified: true }).email,
      null,
      JSON.stringify(email),
    );
  }
});

test("emailVerified is true only for the boolean true", () => {
  const asString = principalFromClaims({ ...CLAIMS_GOOGLE, email_verified: "true" });
  assert.equal(asString.emailVerified, false, 'the string "true" is not verified');
  const asOne = principalFromClaims({ ...CLAIMS_GOOGLE, email_verified: 1 });
  assert.equal(asOne.emailVerified, false);
  const missing = principalFromClaims({ ...CLAIMS_GOOGLE, email_verified: undefined });
  assert.equal(missing.emailVerified, false);
});

test("a verified flag with no email is not carried as verified", () => {
  const principal = principalFromClaims({ ...CLAIMS_GITHUB_NO_EMAIL, email_verified: true });
  assert.equal(principal.email, null);
  assert.equal(principal.emailVerified, false, "verified with no address is a contradiction");
});

test("an empty-string email is treated as absent", () => {
  const principal = principalFromClaims({ ...CLAIMS_GOOGLE, email: "", email_verified: true });
  assert.equal(principal.email, null);
  assert.equal(principal.emailVerified, false);
});

test("a login claimed as an email is reduced to its local part", () => {
  const principal = principalFromClaims({
    sub: "github|9",
    nickname: "cat@example.com",
    email: "cat@example.com",
    email_verified: true,
  });
  assert.ok(!principal.login.includes("@"));
  assert.equal(principal.login, "cat");
});

test("claims with no subject are a failed sign-in", () => {
  assert.throws(() => principalFromClaims({ email: "a@b.co" }), AuthRequestError);
  assert.throws(() => principalFromClaims(null), AuthRequestError);
});
