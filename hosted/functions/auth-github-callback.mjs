/**
 * `GET /api/hosted/auth/github/callback` - complete one authorization, exactly
 * once.
 *
 * ## The order of operations is the security property
 *
 *  1. The transaction is looked up by the URL's `state`, **without consuming
 *     it**, and the `__Host-archon_oauth` cookie must hash to the binding the
 *     record stores. Cookie and `state` are two different secrets: the cookie
 *     never leaves the browser, only its SHA-256 is stored, and `state` is the
 *     only half that travels through GitHub and into logs and history. So a
 *     stolen callback URL is not enough to redeem the code, and - because
 *     nothing is written before this check passes - a stranger who guesses at
 *     the endpoint cannot burn a victim's in-flight transaction either.
 *  2. Only then is the record *consumed* through the store's compare-and-set.
 *     Two callbacks arriving with the same state race on that one write, and
 *     exactly one can win. The loser is told nothing was there.
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
 * The OAuth cookie is cleared on every path that got past the binding check -
 * success or failure - and on no path before it. Clearing it earlier was a
 * drive-by denial of sign-in: any page could link a victim to this route with a
 * junk `state`, and the mismatch would clear the cookie the real callback was
 * about to need.
 *
 * The publication binding cookie is not touched at all. It has to survive to
 * `/publish/authorize`, which is the entire reason it is a separate cookie.
 */

import { AuthUnavailableError } from "../lib/auth-errors.mjs";
import { exchangeCodeForIdentity } from "../lib/github-oauth.mjs";
import { methodNotAllowed, redirectResponse, serve } from "../lib/http.mjs";
import { constantTimeEqual, hashToken } from "../lib/secrets.mjs";
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

/** The route, over injected dependencies. */
export function createCallbackRoute({ store, config: hostedConfig, fetchImpl }) {
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
      return failed(error instanceof AuthUnavailableError ? "unavailable" : "expired", {
        destination,
      });
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
