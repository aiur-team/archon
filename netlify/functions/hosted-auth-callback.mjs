/**
 * `GET /api/hosted/auth/callback` - complete one authorization, exactly once.
 *
 * ## The order of operations is the security property
 *
 *  1. The transaction is looked up by the URL's `state`, **without consuming
 *     it**, and the `__Host-archon_oauth` cookie must hash to the binding the
 *     record stores. Cookie and `state` are two different secrets: the cookie
 *     never leaves the browser, only its SHA-256 is stored, and `state` is the
 *     only half that travels through Auth0 and into logs and history. So a
 *     stolen callback URL is not enough to redeem the code, and - because
 *     nothing is written before this check passes - a stranger who guesses at
 *     the endpoint cannot burn a victim's in-flight transaction either.
 *  2. Only then is the record *consumed* through the store's compare-and-set.
 *     Two callbacks arriving with the same state race on that one write, and
 *     exactly one can win. The loser is told nothing was there.
 *  3. Only then is the code redeemed, with the PKCE verifier that was stored
 *     server-side at start - never one supplied by the request - and the ID
 *     token that comes back is verified against the tenant keys, issuer,
 *     audience, and the nonce the record stored, before any session is created.
 *  4. Any existing session is revoked **before** the new one is created. That is
 *     C1's callback rotation: a visitor signing in over an old session must not
 *     leave the old token usable, and a revocation attempted after the new
 *     cookie is set is a revocation that can fail silently after success has
 *     already been claimed.
 *
 * ## Why failures redirect instead of returning JSON
 *
 * This route is reached by a top-level browser navigation, so its response is a
 * page a person looks at. A JSON error envelope rendered as text is not an
 * actionable retry path. Every failure therefore lands back on the splash at `/`
 * with a status word from a closed set - `denied`, `expired`, `unavailable` -
 * which the splash announces beside its one Sign-in button. The splash is the
 * single sign-in entry, so a failed sign-in returns there rather than
 * dead-ending on the standalone `/login` page with its duplicate button. The
 * distinctions a visitor can act on are preserved; everything about *why* the
 * transaction was rejected stays on the server, so a prober cannot use the
 * landing page to tell a bad state from a bad code.
 *
 * The OAuth cookie is cleared on every path that got past the binding check -
 * success or failure - and on no path before it. Clearing it earlier was a
 * drive-by denial of sign-in: any page could link a victim to this route with a
 * junk `state`, and the mismatch would clear the cookie the real callback was
 * about to need.
 *
 * The publication binding cookie is not touched at all. It has to survive to
 * `/publish/authorize`, which is the entire reason it is a separate cookie.
 */

import { resolveAllowlist } from "../lib/hosted/allowlist.mjs";
import { AuthUnavailableError } from "../lib/hosted/auth-errors.mjs";
import { TRANSIENT_TTL_SECONDS } from "../lib/hosted/auth-store.mjs";
import {
  exchangeCodeForIdToken,
  principalFromClaims,
  verifyIdToken,
} from "../lib/hosted/auth0-oidc.mjs";
import { normalizeEmailOrNull } from "../lib/hosted/email.mjs";
import { methodNotAllowed, redirectResponse, serve } from "../lib/hosted/http.mjs";
import { evaluatePlatformAccess } from "../lib/hosted/platform-access.mjs";
import { constantTimeEqual, hashToken } from "../lib/hosted/secrets.mjs";
import { recordSignupAttempt } from "../lib/hosted/signup-attempts.mjs";
import {
  ACCESS_REQUEST_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  clearCookie,
  readCookie,
  serializeCookie,
  validateDestination,
} from "../lib/hosted/identity.mjs";

export const config = { path: "/api/hosted/auth/callback" };

/** Where a failed sign-in lands: the splash, the single sign-in entry, with a
 * closed-set status word it announces beside its one Sign-in button. */
const SIGN_IN_PATH = "/";

/**
 * Where a verified-but-not-admitted sign-in lands instead of a bare refusal.
 *
 * A trailing slash so it resolves to `netlify/public/request-access/index.html`
 * as a directory index with no `_redirects` rewrite, and so it matches the
 * `/request-access/` pass-through the edge gate serves anonymously - the visitor
 * has no session, so the page has to be reachable without one.
 */
const REQUEST_ACCESS_PATH = "/request-access/";

/**
 * The only status words this route will ever put in that URL.
 *
 * A closed set: the sign-in page renders a fixed message per word and ignores
 * anything else, so the query string can never become a way to put chosen text
 * on a trusted page.
 *
 * `verify_email` is the one enforced-allowlist refusal that still lands on the
 * splash, and it is deliberately its own word. A visitor who has not confirmed
 * their address is told to check their inbox and sign in again - a refusal they
 * can clear themselves, so there is nothing to request. A visitor who *is*
 * verified but is not admitted is a different case entirely: they can do nothing
 * on their own, so instead of a status word they are sent to the request-access
 * page (see `refusedToRequestAccess`). Neither outcome says whether any
 * particular address or domain is on the list - `evaluatePlatformAccess` checks
 * verification *before* the list precisely so that this route is not an oracle
 * over it, and the request page is reached by every unadmitted verified address
 * alike.
 */
export const CALLBACK_STATUSES = Object.freeze([
  "denied",
  "expired",
  "unavailable",
  "verify_email",
]);

/**
 * The landing word for each way the platform gate can refuse *to the splash*.
 *
 * `not_allowlisted` is deliberately absent: a verified address that is not
 * admitted is not returned to the splash with a word at all, it is offered the
 * request-access page. The three that remain are the ones a visitor either can
 * act on themselves (`email_unverified`) or must simply retry (`session_required`,
 * `allowlist_unavailable`).
 */
const PLATFORM_REFUSAL_STATUS = Object.freeze({
  email_unverified: "verify_email",
  allowlist_unavailable: "unavailable",
  session_required: "expired",
});

/**
 * The failure landing.
 *
 * `clear` is false before the browser binding has been proved, so an unbound
 * request cannot destroy a cookie it never demonstrated it holds. `destination`
 * is carried through when it is known, so a visitor who retries after cancelling
 * lands back where they were going instead of silently on the default.
 */
function failed(status, { clear = true, destination = null } = {}) {
  const query = destination === null
    ? `status=${status}`
    : `status=${status}&destination=${encodeURIComponent(destination)}`;
  return redirectResponse(`${SIGN_IN_PATH}?${query}`, {
    status: 303,
    cookies: clear ? [clearCookie(OAUTH_COOKIE)] : [],
  });
}

/**
 * Land a verified-but-not-admitted visitor on the request-access page.
 *
 * This is the one refusal that is not a dead end. The address is the one the ID
 * token was just verified for, and it is used two ways, both of which fail safe:
 *
 *  1. It is recorded in the sign-up-attempts audit so an operator can see who
 *     was turned away even if they never submit the request form.
 *  2. It is stored in a single-use `access_request` transient whose token rides
 *     back in `ACCESS_REQUEST_COOKIE`, so the request form's submit route reads
 *     the *verified* address server-side rather than trusting a form field.
 *
 * Neither write is allowed to change the outcome. A refused visitor is refused
 * regardless: an audit-store outage loses one row, and a transient-store outage
 * loses the cookie (the page still renders and explains that they must sign in
 * again), but neither creates a session and neither throws out of the callback.
 * The `OAUTH_COOKIE` is cleared here exactly as on every other post-binding
 * path.
 */
async function refusedToRequestAccess(principal, { store, signupAttempts }) {
  const email = normalizeEmailOrNull(principal.email);
  const cookies = [clearCookie(OAUTH_COOKIE)];

  /* A verified address that does not normalise is not one we can record or
     attribute a request to. It is vanishingly rare - the gate already refused
     it as `not_allowlisted` for the same reason - so the page is still offered,
     without a cookie, and the visitor is told to sign in again. */
  if (email !== null) {
    try {
      await recordSignupAttempt({ email }, { store: signupAttempts });
    } catch {
      /* The audit is bookkeeping; losing one row must not admit anyone or turn a
         refusal into an error page. */
    }

    try {
      const minted = await store.createTransient("access_request", { email });
      cookies.unshift(
        serializeCookie(ACCESS_REQUEST_COOKIE, minted.token, {
          maxAgeSeconds: TRANSIENT_TTL_SECONDS,
        }),
      );
    } catch {
      /* No token means the request form cannot attribute a message, so it will
         answer "sign in again" rather than mail an unverified address. The
         refusal itself is unaffected. */
    }
  }

  return redirectResponse(REQUEST_ACCESS_PATH, { status: 303, cookies });
}

/** The route, over injected dependencies. */
export function createCallbackRoute({
  store,
  config: hostedConfig,
  allowlist,
  signupAttempts,
  fetchImpl,
  getKeySet,
}) {
  return async function callbackRoute(request) {
    if (request.method !== "GET") return methodNotAllowed("GET");

    const url = new URL(request.url);
    const binding = readCookie(request, OAUTH_COOKIE);
    const state = url.searchParams.get("state");

    /* A callback with no cookie - a replay into a fresh browser, or a bare URL
       someone pasted - costs nothing and never reaches the store or the
       provider. Nothing is cleared and nothing is written on this path. */
    if (binding === null || state === null) return failed("expired", { clear: false });

    let pending;
    try {
      pending = await store.readTransient("oauth", state);
    } catch (error) {
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired", {
        clear: false,
      });
    }
    if (pending === null) return failed("expired", { clear: false });
    if (!constantTimeEqual(hashToken(binding), pending.payload.bindingHash ?? "")) {
      return failed("expired", { clear: false });
    }

    /* Past this line the request has demonstrated it is the browser that started
       the transaction, so clearing its cookie is safe and its destination is
       known. */
    const destination = pending.payload.destination ?? null;

    /* A denied consent still arrives with a valid binding, so it is checked
       after it and before the exchange. It is a normal outcome, not a transport
       failure - but the transaction is over either way, so the state is consumed
       here too. Leaving it live let a captured cookie-and-state pair be redeemed
       with any code for the rest of the fifteen-minute window; the visitor who
       cancelled is the one person we know did not intend that. A consume that
       loses or errors changes nothing about the answer: the visitor still lands
       on the denied page. */
    if (url.searchParams.get("error") !== null) {
      try {
        await store.consumeTransient("oauth", state);
      } catch {
        /* An outage while retiring an already-refused transaction is not worth
           a different page. The record expires on its own within fifteen
           minutes and is checked on every read. */
      }
      return failed("denied", { destination });
    }

    let transaction;
    try {
      transaction = await store.consumeTransient("oauth", state);
    } catch (error) {
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired", {
        destination,
      });
    }
    /* Null here means another callback won the compare-and-set: a replay, or the
       second of two simultaneous arrivals. */
    if (transaction === null) return failed("expired", { destination });

    /* The code is redeemed for an ID token, then the token is verified before it
       becomes an identity. The exchange can be an outage - a tenant 5xx or a
       timeout - and is `unavailable`; a verification failure is never an outage,
       so a bad signature, a wrong issuer or audience, `alg: HS256`, or a nonce
       that does not match the record are all `expired` with nothing written. */
    let principal;
    try {
      const idToken = await exchangeCodeForIdToken(
        {
          code: url.searchParams.get("code") ?? "",
          codeVerifier: transaction.payload.codeVerifier,
          config: hostedConfig,
        },
        fetchImpl === undefined ? {} : { fetchImpl },
      );
      const claims = await verifyIdToken(
        { idToken, nonce: transaction.payload.nonce, config: hostedConfig },
        getKeySet === undefined ? {} : { getKeySet },
      );
      principal = principalFromClaims(claims);
    } catch (error) {
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired", {
        destination,
      });
    }

    /* The platform gate, after the identity is established and before any
       session exists. This is the only place it runs: a session is capped at 24
       hours, so a removed entry costs access within a day, and re-deciding it on
       every request would put a store read in front of every page load to shorten
       that window - the same trade `domain-access.mjs` documents and settles the
       same way.

       The store is read only when the gate is actually enforced. An operator who
       has not turned it on pays nothing, and - more usefully - a deployment that
       has never configured an allowlist cannot have its sign-in broken by the
       allowlist store being unreachable. */
    if (hostedConfig.platformAllowlistEnforced === true) {
      let entries;
      try {
        entries = await resolveAllowlist({ config: hostedConfig, store: allowlist });
      } catch {
        /* `null`, not the empty list. An empty list is a policy that admits
           nobody; a `null` is a fact we do not know, and the evaluator refuses it
           with its own retryable reason so an outage never lands a visitor on
           "you are not allowed to use this". */
        entries = null;
      }
      const decision = evaluatePlatformAccess({
        principal,
        admins: hostedConfig.admins,
        allowlist: entries,
        enforced: true,
      });
      if (!decision.allowed) {
        /* A verified address that simply is not admitted is offered the
           request-access page rather than dead-ended on the splash. Every other
           refusal - an unverified address, an unreadable list, a lost session -
           still lands on the splash with the word its reader can act on. */
        if (decision.reason === "not_allowlisted") {
          return refusedToRequestAccess(principal, { store, signupAttempts });
        }
        return failed(PLATFORM_REFUSAL_STATUS[decision.reason] ?? "expired", { destination });
      }
    }

    let session;
    try {
      /* Rotation: the old session dies before the new one is born. `revokeSession`
         throws rather than returning false when it could not establish that the
         old token is dead, so an outage here is a failed sign-in and not a
         second live session. */
      const previous = readCookie(request, SESSION_COOKIE);
      if (previous !== null) await store.revokeSession(previous);
      session = await store.createSession(principal);
    } catch {
      return failed("unavailable", { destination });
    }

    /* Revalidated on the way out. The destination was validated at start and
       stored server-side, so this can only fail if the record was corrupted -
       and a corrupted destination must be a failed sign-in rather than an open
       redirect. */
    let checked;
    try {
      checked = validateDestination(transaction.payload.destination);
    } catch {
      return failed("expired");
    }

    return redirectResponse(checked, {
      status: 303,
      cookies: [
        serializeCookie(SESSION_COOKIE, session.token, { maxAgeSeconds: SESSION_COOKIE_MAX_AGE }),
        clearCookie(OAUTH_COOKIE),
      ],
    });
  };
}

export default serve(createCallbackRoute);
