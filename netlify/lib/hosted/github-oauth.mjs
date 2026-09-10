/**
 * The GitHub half of hosted sign-in: fixed endpoints, S256 PKCE, empty scope,
 * a server-side code exchange, and a principal that is thrown away as soon as it
 * has been read.
 *
 * ## What this module refuses to do
 *
 * It never returns an access token. `exchangeCodeForIdentity` performs the code
 * exchange and the `/user` call inside one function and hands back a validated
 * `HostedPrincipal`, so there is no exported value a caller could accidentally
 * persist, log or hand to a downstream service. C1 says to discard every GitHub
 * access and refresh token after identity validation; the cheapest way to keep
 * that promise is to make the token unreachable rather than to remember to drop
 * it at four call sites.
 *
 * It never asks for a permission. The authorize URL carries no `scope`
 * parameter at all - not an empty one, not `read:user` - so the consent screen
 * a visitor sees says the application is requesting no access to their data.
 * And it *checks*: a token response that reports any granted scope is refused
 * rather than used, because an unexpected scope means the credential in play is
 * not the dedicated, permissionless OAuth app this deployment is configured for.
 *
 * It never invents an endpoint. The three URLs below are constants. A provider
 * host derived from configuration would be a redirect-to-anywhere primitive
 * sitting behind a name that reads like a setting, and GitHub Enterprise Server
 * is explicitly out of scope.
 *
 * ## Why the identity is the numeric ID
 *
 * A GitHub login can be renamed and reused; an email address is optional, can be
 * absent from `/user` entirely, and is not a name GitHub guarantees is unique to
 * an account over time. The numeric `id` is the only durable subject, so it is
 * the only thing that becomes an ownership key. `login` is carried for display
 * and nothing else, and `email` is neither requested nor read.
 *
 * The numeric ID reaches the contract as the C1 v2 subject `github|<id>`, and
 * the ownership key is the digest `deriveAccountId` computes from it. This
 * adapter therefore produces exactly the principal shape ACN-005's Auth0
 * exchange will produce, which is why it can be replaced rather than unpicked.
 *
 * ## Timeouts
 *
 * Both provider calls are bounded. An unbounded `fetch` against a provider
 * having a bad day is a function that occupies its invocation slot until the
 * platform kills it, which turns a provider outage into an outage of the whole
 * hosted deployment. A timeout is reported as `unavailable` with reason
 * `provider`, which is retryable and says nothing about GitHub to the client.
 */

import { AuthRequestError, AuthUnavailableError } from "./auth-errors.mjs";
import { HOSTED_LIMITS, deriveAccountId, validatePrincipal } from "./contracts.mjs";
import { randomToken, sha256Base64Url } from "./secrets.mjs";

/** The fixed provider endpoints. Not configurable, by design. */
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

/** The path GitHub is registered to call back to, under the hosted namespace. */
export const CALLBACK_PATH = "/api/hosted/auth/github/callback";

/** How long either provider call may take before it is an outage. */
export const PROVIDER_TIMEOUT_MS = 10_000;

/** Identifies this deployment to GitHub. Carries no version of anything private. */
const USER_AGENT = "archon-hosted";

/**
 * The exact callback URL, derived from the one configured app origin.
 *
 * Exported because an operator has to paste it into the OAuth app registration,
 * and because GitHub's August 2026 change to multiple redirect URIs makes an
 * exactly-matching callback setting material rather than advisory. Deriving it
 * from `config.appOrigin` rather than from a request Host header is what stops a
 * marketing hostname or an attacker-supplied Host from becoming a callback.
 */
export function callbackUri(appOrigin) {
  return `${appOrigin}${CALLBACK_PATH}`;
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * The verifier is 43 base64url characters, which is inside RFC 7636's 43-128
 * window and made of unreserved characters only. S256 rather than `plain`: the
 * challenge travels in a URL through the user agent, and with `plain` that URL
 * *is* the verifier, so an authorization code intercepted alongside it could be
 * redeemed by whoever saw them.
 */
export function createPkcePair() {
  const verifier = randomToken();
  return Object.freeze({ verifier, challenge: sha256Base64Url(verifier) });
}

/**
 * The provider URL a visitor is sent to.
 *
 * `prompt=select_account` is added only for the deliberate different-account
 * action. It is the difference between "sign in" and "sign in as somebody
 * else": without it GitHub silently reuses the provider session the browser
 * already has, which is correct for an ordinary sign-in and is precisely the
 * bug for an account switch, where the visitor asked to choose.
 *
 * No `scope` parameter is emitted. That is not the same as `scope=`, and the
 * difference is visible on the consent screen.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, selectAccount = false }) {
  for (const [name, value] of Object.entries({ clientId, redirectUri, state, codeChallenge })) {
    if (typeof value !== "string" || value === "") {
      throw new TypeError(`buildAuthorizeUrl requires a non-empty ${name}`);
    }
  }
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (selectAccount) url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** A provider round trip that could not be completed. Never carries a body. */
function providerOutage() {
  return new AuthUnavailableError("provider");
}

/**
 * One bounded provider request, returning parsed JSON.
 *
 * Every failure mode of the transport collapses to one of two answers, and
 * neither of them carries a byte of the response: a malformed or refusing
 * provider is `AuthRequestError` (start again), an unreachable or timed-out one
 * is `AuthUnavailableError` (try again later). The body is deliberately never
 * attached to either - it can contain an authorization code, and an error object
 * is the single most-copied thing in a log pipeline.
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
  /* 5xx is the provider being unwell and is retryable; 4xx is this request being
     wrong and never will be. Collapsing both into one answer would either invite
     a retry loop against a permanently bad request or tell a visitor to start
     over when the right advice was to wait. */
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
 * Redeem an authorization code and read the identity behind it.
 *
 * The access token exists only inside this function. It is used for exactly one
 * request - `GET /user` - and is not returned, stored or logged; any
 * `refresh_token`, `expires_in` or `refresh_token_expires_in` the modern OAuth
 * app response carries is read past and discarded rather than persisted as a new
 * capability this service did not ask for.
 *
 * @param {{code: string, codeVerifier: string, config: object}} params
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<Readonly<{accountId: string, provider: string, providerUserId: string, login: string, email: string | null, emailVerified: boolean}>>}
 */
export async function exchangeCodeForIdentity(
  { code, codeVerifier, config },
  { fetchImpl = fetch, timeoutMs = PROVIDER_TIMEOUT_MS } = {},
) {
  if (typeof code !== "string" || code === "") throw new AuthRequestError();
  if (typeof codeVerifier !== "string" || codeVerifier === "") throw new AuthRequestError();

  const body = new URLSearchParams({
    client_id: config.github.clientId,
    client_secret: config.github.readClientSecret(),
    code,
    code_verifier: codeVerifier,
    redirect_uri: callbackUri(config.appOrigin),
  });

  const token = await providerJson(
    GITHUB_TOKEN_URL,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: body.toString(),
    },
    fetchImpl,
    timeoutMs,
  );

  /* GitHub answers a refused exchange with HTTP 200 and an `error` field, so a
     status check alone accepts a failure as a success. */
  if (typeof token.error === "string" && token.error !== "") throw new AuthRequestError();

  const accessToken = token.access_token;
  if (typeof accessToken !== "string" || accessToken === "") throw new AuthRequestError();
  if (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer") {
    throw new AuthRequestError();
  }
  /* C1: reject unexpected granted scopes. This app requests none, so any scope
     at all means the credential in play is not the one this deployment is
     configured for - a reused client ID from an app with `repo`, say. Using such
     a token would be exercising a permission the visitor's consent screen never
     showed them.
     The condition is "absent, or the empty string" rather than "not a non-empty
     string": a `scope` that arrives as `["repo"]`, or as any other shape this
     code does not understand, is a response whose granted permissions cannot be
     read, and an unreadable answer to "what did you grant?" is not a no. */
  if (token.scope !== undefined && token.scope !== null && token.scope !== "") {
    throw new AuthRequestError();
  }

  const user = await providerJson(
    GITHUB_USER_URL,
    {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": "2022-11-28",
      },
    },
    fetchImpl,
    timeoutMs,
  );

  /* `id` must be a number, not a string that looks like one. `String("0012")`
     and `String(12)` are both accepted by a lenient reading and are two
     different account IDs for one account; and a provider field that arrives as
     an object or a float is a response this service does not understand well
     enough to derive an ownership key from. */
  const id = user.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new AuthRequestError();

  try {
    /* The numeric id is spelled as a C1 v2 subject, `github|<id>`, and the
       ownership key is derived from it by the contracts module rather than
       assembled here. ACN-005 replaces this adapter with the real Auth0 code
       exchange; until then this is what lets one principal shape be produced by
       the identity path that exists.

       `email` is neither requested nor read: it is optional on `/user`, absent
       for most accounts, and is not an ownership key here. An account with no
       address is `email: null` and `emailVerified: false`, which is a legal
       principal and grants no domain access - never a claimed verification this
       adapter cannot substantiate. */
    const providerUserId = `github|${id}`;
    return validatePrincipal({
      accountId: deriveAccountId(providerUserId),
      provider: HOSTED_LIMITS.IDENTITY_PROVIDER,
      providerUserId,
      login: user.login,
      email: null,
      emailVerified: false,
    });
  } catch {
    throw new AuthRequestError();
  }
}
