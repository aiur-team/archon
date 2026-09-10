/**
 * `GET /api/hosted/auth/github/callback` - complete one authorization, exactly
 * once.
 *
 * ## The order of operations is the security property
 *
 *  1. The `state` in the URL must match the `__Host-archon_oauth` cookie, in
 *     constant time. This is the browser binding: a callback replayed into
 *     somebody else's browser carries no matching cookie, so a stolen callback
 *     URL cannot sign a victim in as the attacker.
 *  2. The state record is *consumed* through the store's compare-and-set. Two
 *     callbacks arriving with the same state race on that one write, and exactly
 *     one can win. The loser is told nothing was there.
 *  3. Only then is the code redeemed, with the PKCE verifier that was stored
 *     server-side at start - never one supplied by the request.
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
 * actionable retry path. Every failure therefore lands back on `/login` with a
 * status word from a closed set - `denied`, `expired`, `unavailable` - which the
 * sign-in page announces. The distinctions a visitor can act on are preserved;
 * everything about *why* the transaction was rejected stays on the server, so a
 * prober cannot use the landing page to tell a bad state from a bad code.
 *
 * The OAuth cookie is cleared on every path out of here, success or failure.
 * Leaving a consumed state's cookie behind is harmless in itself and untidy in
 * the way that eventually becomes a bug.
 *
 * The publication binding cookie is not touched at all. It has to survive to
 * `/publish/authorize`, which is the entire reason it is a separate cookie.
 */

import { AuthUnavailableError } from "../lib/auth-errors.mjs";
import { exchangeCodeForIdentity } from "../lib/github-oauth.mjs";
import { methodNotAllowed, redirectResponse, serve } from "../lib/http.mjs";
import { constantTimeEqual } from "../lib/secrets.mjs";
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_MAX_AGE,
  clearCookie,
  readCookie,
  serializeCookie,
  validateDestination,
} from "../lib/identity.mjs";

export const config = { path: "/api/hosted/auth/github/callback" };

/** Where a failed sign-in lands. A fixed internal path with a closed-set word. */
const SIGN_IN_PATH = "/login/";

/** The only three status words this route will ever put in that URL. */
export const CALLBACK_STATUSES = Object.freeze(["denied", "expired", "unavailable"]);

/** The failure landing, with the OAuth cookie cleared on the way. */
function failed(status) {
  return redirectResponse(`${SIGN_IN_PATH}?status=${status}`, {
    status: 303,
    cookies: [clearCookie(OAUTH_COOKIE)],
  });
}

/** The route, over injected dependencies. */
export function createCallbackRoute({ store, config: hostedConfig, fetchImpl }) {
  return async function callbackRoute(request) {
    if (request.method !== "GET") return methodNotAllowed("GET");

    const url = new URL(request.url);
    const cookieState = readCookie(request, OAUTH_COOKIE);
    const queryState = url.searchParams.get("state");

    /* The binding is checked before anything else is read, so a callback with no
       cookie - a replay into a fresh browser, or a bare URL someone pasted -
       costs one comparison and never reaches the store or the provider. */
    if (cookieState === null || !constantTimeEqual(cookieState, queryState ?? "")) {
      return failed("expired");
    }

    /* A denied consent still arrives with a valid state, so it is checked after
       the binding and before the exchange. It is a normal outcome, not a
       transport failure. */
    if (url.searchParams.get("error") !== null) return failed("denied");

    let transaction;
    try {
      transaction = await store.consumeTransient("oauth", cookieState);
    } catch (error) {
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired");
    }
    if (transaction === null) return failed("expired");

    let principal;
    try {
      principal = await exchangeCodeForIdentity(
        {
          code: url.searchParams.get("code") ?? "",
          codeVerifier: transaction.payload.codeVerifier,
          config: hostedConfig,
        },
        fetchImpl === undefined ? {} : { fetchImpl },
      );
    } catch (error) {
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired");
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
      return failed("unavailable");
    }

    /* Revalidated on the way out. The destination was validated at start and
       stored server-side, so this can only fail if the record was corrupted -
       and a corrupted destination must be a failed sign-in rather than an open
       redirect. */
    let destination;
    try {
      destination = validateDestination(transaction.payload.destination);
    } catch {
      return failed("expired");
    }

    return redirectResponse(destination, {
      status: 303,
      cookies: [
        serializeCookie(SESSION_COOKIE, session.token, { maxAgeSeconds: SESSION_COOKIE_MAX_AGE }),
        clearCookie(OAUTH_COOKIE),
      ],
    });
  };
}

export default serve(createCallbackRoute);
