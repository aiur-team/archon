/**
 * The Auth0 half of hosted sign-in: an OpenID Connect Authorization Code flow
 * with PKCE, a server-side code exchange, and an ID token whose claims become a
 * principal that is thrown away as soon as it has been read.
 *
 * ## What this module refuses to do
 *
 * It never returns an access token. `exchangeCodeForIdToken` performs the code
 * exchange and hands back only the raw ID token string it needs to verify; the
 * `access_token` and any `refresh_token` the response carries are read past and
 * discarded rather than persisted as a new capability this service did not ask
 * for. No `offline_access` scope is requested, so no refresh token is minted in
 * the first place.
 *
 * It never trusts an unverified token. `verifyIdToken` pins the algorithm to
 * RS256, the issuer to the tenant, and the audience to this client, and then
 * checks the nonce it stored server-side against the one echoed in the token.
 * `alg: HS256`, a wrong audience, a wrong issuer, and a missing or mismatched
 * nonce are each a failed sign-in with nothing written. The JWKS is fetched from
 * the tenant's well-known endpoint and cached at module scope, so a warm
 * invocation verifies against keys already in memory.
 *
 * It never invents an endpoint. The authorize, token, JWKS and logout URLs are
 * all derived from the one configured `AUTH0_DOMAIN`, which is a host with no
 * scheme and no path - a domain that arrived with a path would be a
 * redirect-to-anywhere primitive sitting behind a name that reads like a
 * setting, and the config layer refuses it.
 *
 * ## Why the identity is the raw subject
 *
 * An Auth0 subject is `<connection>|<provider-user-id>` - `google-oauth2|...`
 * or `github|...`. It is the only durable identifier: a display name can change,
 * and an email is optional and can be absent from a GitHub connection entirely.
 * The subject becomes the C1 v2 `providerUserId`, and the ownership key is the
 * digest `deriveAccountId` computes from it. A Google subject and a GitHub
 * subject that happen to carry the same address are two subjects and therefore
 * two principals; Auth0 does not link them and neither does this module.
 *
 * `email` is carried only when the ID token presents it as a non-empty string,
 * lower-cased; `emailVerified` is true only when the `email_verified` claim is
 * the boolean `true` *and* an email is present, because "verified" with no
 * address is a contradiction a later domain rule must never read as a yes.
 *
 * ## Timeouts
 *
 * The token exchange is bounded. An unbounded `fetch` against a tenant having a
 * bad day is a function that occupies its invocation slot until the platform
 * kills it, which turns an Auth0 outage into an outage of the whole hosted
 * deployment. A timeout is reported as `unavailable`, which is retryable and
 * says nothing about the tenant to the client.
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

import { AuthRequestError, AuthUnavailableError } from "./auth-errors.mjs";
import {
  AVATAR_IMAGE_ORIGINS,
  HOSTED_LIMITS,
  deriveAccountId,
  validatePrincipal,
} from "./contracts.mjs";
import { normalizeEmailOrNull } from "./email.mjs";
import { constantTimeEqual, randomToken, sha256Base64Url } from "./secrets.mjs";

/** The path Auth0 is registered to call back to, under the hosted namespace. */
export const CALLBACK_PATH = "/api/hosted/auth/callback";

/**
 * The scopes this deployment requests, and never more.
 *
 * `openid` for an ID token, `profile` for a display name, `email` for the one
 * claim later domain rules read. No `offline_access`: the app keeps its own
 * server-side session, so a refresh token would be a stored credential with no
 * caller and every risk.
 */
export const SCOPE = "openid profile email";

/** How long the token exchange may take before it is an outage. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** The signature algorithm the ID token must carry. Pinned, never negotiated. */
const ID_TOKEN_ALG = "RS256";

/**
 * The exact callback URL, derived from the one configured app origin.
 *
 * Exported because an operator has to paste it into the Auth0 application's
 * Allowed Callback URLs. Deriving it from `config.appOrigin` rather than from a
 * request Host header is what stops a marketing hostname or an attacker-supplied
 * Host from becoming a callback.
 */
export function callbackUri(appOrigin) {
  return `${appOrigin}${CALLBACK_PATH}`;
}

/** The tenant's OIDC issuer: the domain as an https origin with a trailing slash. */
export function issuerUrl(domain) {
  return `https://${domain}/`;
}

/** The tenant's authorization endpoint. */
export function authorizeEndpoint(domain) {
  return `https://${domain}/authorize`;
}

/** The tenant's token endpoint. */
export function tokenEndpoint(domain) {
  return `https://${domain}/oauth/token`;
}

/** The tenant's JWKS endpoint. */
export function jwksUri(domain) {
  return `https://${domain}/.well-known/jwks.json`;
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * The verifier is 43 base64url characters, inside RFC 7636's 43-128 window and
 * made of unreserved characters only. S256 rather than `plain`: the challenge
 * travels in a URL through the user agent, and with `plain` that URL *is* the
 * verifier, so an authorization code intercepted alongside it could be redeemed
 * by whoever saw them.
 */
export function createPkcePair() {
  const verifier = randomToken();
  return Object.freeze({ verifier, challenge: sha256Base64Url(verifier) });
}

/**
 * A fresh nonce for one authorization.
 *
 * It is stored server-side in the transient record and echoed back inside the
 * ID token, where `verifyIdToken` checks it in constant time. It is not the
 * `state` and not the PKCE verifier: three independent single-use secrets, each
 * closing a different replay.
 */
export function createNonce() {
  return randomToken();
}

/**
 * The provider URL a visitor is sent to.
 *
 * `prompt=login` is added only for the deliberate different-account action. It
 * is the difference between "sign in" and "sign in as somebody else": without it
 * Auth0 silently reuses the session the browser already has at the tenant, which
 * is correct for an ordinary sign-in and is precisely the bug for an account
 * switch, where the visitor asked to choose. No `audience` is ever sent - this
 * flow wants an ID token, not an API access token - and no `offline_access`.
 */
export function buildAuthorizeUrl({
  domain,
  clientId,
  redirectUri,
  state,
  nonce,
  codeChallenge,
  switchAccount = false,
}) {
  for (const [name, value] of Object.entries({
    domain,
    clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
  })) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`buildAuthorizeUrl requires a non-empty ${name}`);
    }
  }
  const url = new URL(authorizeEndpoint(domain));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (switchAccount) url.searchParams.set("prompt", "login");
  return url.toString();
}

/**
 * The Auth0 logout URL.
 *
 * `returnTo` is built from configuration and never from the request, and is
 * exact including the scheme so it can be allowlisted in the Auth0 application.
 * `federated` is deliberately not sent: the research records it as best-effort
 * and unsupported for GitHub, and sending it would ask the tenant to attempt a
 * provider logout it cannot complete.
 */
export function buildLogoutUrl({ domain, clientId, returnTo }) {
  for (const [name, value] of Object.entries({ domain, clientId, returnTo })) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`buildLogoutUrl requires a non-empty ${name}`);
    }
  }
  const url = new URL(`https://${domain}/v2/logout`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

/** A provider round trip that could not be completed. Never carries a body. */
function providerOutage() {
  return new AuthUnavailableError("provider");
}

/**
 * One bounded provider request, returning parsed JSON.
 *
 * Every failure mode collapses to one of two answers, and neither carries a byte
 * of the response: a malformed or refusing endpoint is `AuthRequestError` (start
 * again), an unreachable or timed-out one is `AuthUnavailableError` (try again
 * later). The body is never attached to either - it can contain an authorization
 * code, and an error object is the single most-copied thing in a log pipeline.
 */
async function providerJson(url, init, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    /* A `TypeError` here is this module calling `fetch` wrongly rather than the
       provider being unreachable, and dressing a programming error as a
       retryable outage would hide it behind a 503 forever. */
    if (error instanceof TypeError) throw error;
    throw providerOutage();
  }
  /* 5xx is the tenant being unwell and is retryable; 4xx is this request being
     wrong and never will be. */
  if (response.status >= 500) throw providerOutage();
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AuthRequestError();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new AuthRequestError();
  }
  if (!response.ok) throw new AuthRequestError();
  return body;
}

/**
 * Redeem an authorization code for the ID token behind it.
 *
 * The secret is read only through `config.auth0.readClientSecret()` and posted
 * with `client_secret_post`; it never reaches a query string, a header this
 * module sets, or a log line. The `access_token` and any `refresh_token` in the
 * response are not read and not returned - only the `id_token` string leaves
 * this function, because it is the only thing the caller verifies.
 *
 * @param {{code: string, codeVerifier: string, config: object}} params
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<string>} the raw ID token
 */
export async function exchangeCodeForIdToken(
  { code, codeVerifier, config },
  { fetchImpl = fetch, timeoutMs = PROVIDER_TIMEOUT_MS } = {},
) {
  if (typeof code !== "string" || code === "") throw new AuthRequestError();
  if (typeof codeVerifier !== "string" || codeVerifier === "") throw new AuthRequestError();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.auth0.clientId,
    client_secret: config.auth0.readClientSecret(),
    code,
    code_verifier: codeVerifier,
    redirect_uri: callbackUri(config.appOrigin),
  });

  const token = await providerJson(
    tokenEndpoint(config.auth0.domain),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    },
    fetchImpl,
    timeoutMs,
  );

  const idToken = token.id_token;
  if (typeof idToken !== "string" || idToken === "") throw new AuthRequestError();
  return idToken;
}

/**
 * The module-scoped JWKS cache.
 *
 * `createRemoteJWKSet` returns a resolver that fetches the tenant's keys once
 * and caches them in memory, so a warm invocation verifies against keys already
 * present. Keyed by domain so a deployment that is somehow reconfigured mid-life
 * does not verify against a stale tenant's keys.
 */
const jwksByDomain = new Map();

function remoteKeySet(domain) {
  let keySet = jwksByDomain.get(domain);
  if (keySet === undefined) {
    keySet = createRemoteJWKSet(new URL(jwksUri(domain)));
    jwksByDomain.set(domain, keySet);
  }
  return keySet;
}

/**
 * Verify an ID token and return its claims.
 *
 * The signature is checked against the tenant JWKS with the algorithm pinned to
 * RS256; the issuer and audience are pinned to the tenant and this client. Then
 * the nonce echoed in the token is compared in constant time against the one the
 * transaction stored server-side. A missing, non-string, or mismatched nonce is
 * a failed sign-in, as is any failure `jose` raises - a wrong signature, a wrong
 * `iss` or `aud`, `alg: HS256`, or an expired token.
 *
 * `getKeySet` is the deterministic seam: production passes nothing and verifies
 * against the cached remote JWKS, and a test injects a local key set built from
 * a key pair it generated, so the whole path runs with no network.
 *
 * @param {{idToken: string, nonce: string, config: object}} params
 * @param {{getKeySet?: (config: object) => unknown}} [options]
 * @returns {Promise<object>} the verified claims
 */
export async function verifyIdToken(
  { idToken, nonce, config },
  { getKeySet = (cfg) => remoteKeySet(cfg.auth0.domain) } = {},
) {
  if (typeof idToken !== "string" || idToken === "") throw new AuthRequestError();
  if (typeof nonce !== "string" || nonce === "") throw new AuthRequestError();

  let claims;
  try {
    const keySet = getKeySet(config);
    const verified = await jwtVerify(idToken, keySet, {
      issuer: issuerUrl(config.auth0.domain),
      audience: config.auth0.clientId,
      algorithms: [ID_TOKEN_ALG],
    });
    claims = verified.payload;
  } catch {
    /* Every verification failure is one answer to the caller. Attaching the
       reason would hand a prober a way to tell a wrong audience from a bad
       signature, and the token can carry claims that should not reach a log. */
    throw new AuthRequestError();
  }

  /* The nonce is not something `jwtVerify` can check: only this process knows
     which nonce it minted for this transaction. A non-string or absent claim is
     refused before the compare so a token with no nonce cannot pass by matching
     an empty expected value. */
  if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, nonce)) {
    throw new AuthRequestError();
  }
  return claims;
}

/**
 * A display login from the ID token's profile claims.
 *
 * `login` is display-only and the contract requires it: a non-empty string, at
 * most 39 scalars, with no `@` and no control, format or separator characters.
 * The GitHub connection's `nickname` is the account handle and the best display
 * value; Google's `nickname` is a given name. An address in any of these claims
 * is reduced to its local part rather than rejected, and an empty result falls
 * back to the id half of the subject, so a principal is always constructible.
 */
function deriveLogin(claims, providerUserId) {
  const candidates = [claims.nickname, claims.name, claims.preferred_username];
  for (const raw of candidates) {
    const cleaned = sanitizeLogin(raw);
    if (cleaned !== "") return cleaned;
  }
  const fromSubject = sanitizeLogin(providerUserId.slice(providerUserId.indexOf("|") + 1));
  return fromSubject === "" ? "member" : fromSubject;
}

/** Reduce a claim to a legal display login, or the empty string if none remains. */
function sanitizeLogin(value) {
  if (typeof value !== "string") return "";
  /* An address is a local part and a domain; the local part is a display value,
     the domain is not, and neither may carry the `@`. */
  const withoutAddress = value.includes("@") ? value.slice(0, value.indexOf("@")) : value;
  const printable = [...withoutAddress]
    .filter((scalar) => !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(scalar))
    .join("")
    .trim();
  return [...printable].slice(0, HOSTED_LIMITS.LOGIN_MAX_LENGTH).join("").trim();
}

/**
 * The avatar URL from the `picture` claim, or null.
 *
 * Degrades rather than refuses, exactly as `sanitizeLogin` does: a claim that is
 * absent, unparseable, over-long or served from a host this deployment does not
 * allow images from answers null, and the person signs in without a picture. The
 * alternative - throwing - would turn a cosmetic claim into a failed sign-in.
 *
 * The origin check is here as well as in `validatePrincipal` on purpose. This one
 * is what keeps a sign-in working; the contract's is what keeps an unvetted URL
 * out of a stored record whatever wrote it.
 */
function deriveAvatarUrl(claims) {
  const raw = claims.picture;
  if (typeof raw !== "string" || raw === "") return null;
  if (raw.length > HOSTED_LIMITS.AVATAR_URL_MAX_LENGTH) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!AVATAR_IMAGE_ORIGINS.includes(url.origin)) return null;
  if (url.username !== "" || url.password !== "") return null;
  return raw;
}

/**
 * Build the C1 v2 principal from verified ID-token claims.
 *
 * `email` is set only when the claim normalizes through the repository's one
 * address grammar; `emailVerified` is true only when `email_verified` is the
 * boolean `true` and an email is present. An address the grammar refuses makes
 * the principal address-less rather than failing the sign-in, which is the
 * right shape: the person is still who the subject says they are, they simply
 * have no address any domain rule may act on. The subject is spelled as the v2 `providerUserId` and the
 * ownership key is derived by the contracts module rather than assembled here.
 * The whole record is handed to `validatePrincipal`, so a claim set this module
 * cannot turn into a legal principal is a failed sign-in, never a partial one.
 */
export function principalFromClaims(claims) {
  if (claims === null || typeof claims !== "object") throw new AuthRequestError();
  const providerUserId = claims.sub;
  if (typeof providerUserId !== "string" || providerUserId === "") throw new AuthRequestError();

  /* Through the one shared grammar rather than `toLowerCase()`, because
     lower-casing is not normalisation and the difference is reachable here.
     U+212A KELVIN SIGN lower-cases to an ASCII `k`, so a claim of
     `ann@booK.example` folded into `ann@book.example` - a *verified* principal
     at a domain the provider never asserted, which ACN-007's evaluator then
     exact-matches against a document listing `book.example`.
     `validatePrincipal` below does not catch it: it checks the value it is
     given for printable ASCII, and by then the fold has already happened.
     `normalizeEmailOrNull` refuses non-ASCII before it folds, so the claim
     answers null and the address is simply absent. */
  const email = normalizeEmailOrNull(claims.email);
  const emailVerified = email !== null && claims.email_verified === true;
  const avatarUrl = deriveAvatarUrl(claims);

  try {
    return validatePrincipal({
      accountId: deriveAccountId(providerUserId),
      provider: HOSTED_LIMITS.IDENTITY_PROVIDER,
      providerUserId,
      login: deriveLogin(claims, providerUserId),
      email,
      emailVerified,
      /* Spread, so a claim set with no usable picture builds the same six-key
         record it always did rather than one carrying an explicit null. */
      ...(avatarUrl === null ? {} : { avatarUrl }),
    });
  } catch {
    throw new AuthRequestError();
  }
}
