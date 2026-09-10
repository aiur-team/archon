/**
 * `GET /api/hosted/session` - the browser's only source of account identity.
 *
 * C1 freezes the two bodies exactly:
 *
 *   {v: 1, authenticated: false}
 *   {v: 1, authenticated: true, accountId, login, email, emailVerified, csrfToken}
 *
 * and this route validates its own response against `validateSessionResponse`
 * before sending it. Checking one's own output looks redundant until you
 * consider what the alternative failure looks like: a field added here that the
 * frozen shape does not carry, shipped to a consumer that trusts the contract,
 * with nothing failing anywhere.
 *
 * Two things are deliberately absent from the signed-in body: the raw session
 * cookie, and any storage hash. The `csrfToken` is derived from the cookie the
 * browser already holds, so this response tells the page nothing it could not
 * already act on - it just tells it in a form JavaScript can read, which the
 * `HttpOnly` cookie is not.
 *
 * **Both responses issue the pre-login CSRF binding.** That is this route's
 * second job and the reason the sign-in page needs no other endpoint: the static
 * login page has no way to be handed a value, and C1 freezes both the body above
 * and the `HttpOnly` attribute on every transient cookie, so a bootstrap that
 * fetches this route is the only conformant way for a browser to acquire a
 * binding at all. The signed-in branch issues one too, because a signed-in
 * visitor on the sign-in page can still press the primary button: withholding it
 * there sent that visitor to the start route with no binding and bounced them
 * back to `/login/?status=expired` with nothing to act on.
 *
 * **Issuing it writes a record.** `createTransient` is what gives the binding
 * *provenance*: the start route consumes the presented value against a live,
 * unconsumed record this service minted, so a fabricated cookie is refused
 * rather than accepted for being well-formed. An earlier version wrote nothing
 * and let the start route claim any 32-256 character token once; that made the
 * binding a presence check, and `SameSite=Lax` plus the exact `Origin` was
 * carrying the whole defence alone. The cost is one small record per bootstrap,
 * bounded by the fifteen-minute transient window and by nothing else - see the
 * retention note in `README.md`.
 *
 * It issues **only** that one. The OAuth-state and publication-binding cookies
 * are neither read nor cleared here, which is C1's "do not consume all three
 * cookies on the first bootstrap request" stated as code: a bootstrap that
 * touched the publication binding would destroy the pending approval the
 * visitor is in the middle of.
 */

import { jsonResponse, methodNotAllowed, serve } from "../lib/hosted/http.mjs";
import { validateSessionResponse } from "../lib/hosted/contracts.mjs";
import { TRANSIENT_TTL_SECONDS } from "../lib/hosted/auth-store.mjs";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  deriveCsrfToken,
  identifyHosted,
  readCookie,
  serializeCookie,
} from "../lib/hosted/identity.mjs";

export const config = { path: "/api/hosted/session" };

/** The route, over injected dependencies. Exported so tests need no environment. */
export function createSessionRoute({ store }) {
  return async function sessionRoute(request) {
    if (request.method !== "GET") return methodNotAllowed("GET");

    const principal = await identifyHosted(request, { store });

    /* Minted for both answers. The record behind it is what the start route
       checks the presented cookie against, so this is the only place a valid
       pre-login binding can come from. */
    const login = await store.createTransient("login");
    const cookies = [
      serializeCookie(LOGIN_COOKIE, login.token, { maxAgeSeconds: TRANSIENT_TTL_SECONDS }),
    ];

    if (principal !== null) {
      const token = readCookie(request, SESSION_COOKIE);
      return jsonResponse(
        validateSessionResponse({
          v: 1,
          authenticated: true,
          accountId: principal.accountId,
          login: principal.login,
          email: principal.email,
          emailVerified: principal.emailVerified,
          csrfToken: deriveCsrfToken(token),
        }),
        { cookies },
      );
    }

    /* A browser that still holds a session cookie and is told it is signed out
       is holding a dead value: expired, or revoked from another tab. Leaving it
       set means every later request carries a credential this deployment has
       already refused, and the visitor's browser keeps a token whose only
       remaining use is being copied. */
    if (readCookie(request, SESSION_COOKIE) !== null) cookies.push(clearCookie(SESSION_COOKIE));

    return jsonResponse(validateSessionResponse({ v: 1, authenticated: false }), { cookies });
  };
}

export default serve(createSessionRoute);
