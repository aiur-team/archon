/**
 * `GET /api/hosted/session` - the browser's only source of account identity.
 *
 * C1 freezes the two bodies exactly:
 *
 *   {v: 1, authenticated: false}
 *   {v: 1, authenticated: true, accountId, login, csrfToken}
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
 * The signed-out response also **issues the pre-login CSRF binding**. That is
 * this route's second job and the reason the sign-in page needs no other
 * endpoint: the static login page has no way to be handed a value, and C1
 * freezes both the body above and the `HttpOnly` attribute on every transient
 * cookie, so a bootstrap that fetches this route is the only conformant way for
 * a not-yet-signed-in browser to acquire a binding at all.
 *
 * It issues **only** that one. The OAuth-state and publication-binding cookies
 * are neither read nor cleared here, which is C1's "do not consume all three
 * cookies on the first bootstrap request" stated as code: a bootstrap that
 * touched the publication binding would destroy the pending approval the
 * visitor is in the middle of.
 */

import { jsonResponse, methodNotAllowed, serve } from "../lib/http.mjs";
import { validateSessionResponse } from "../lib/contracts.mjs";
import { TRANSIENT_TTL_SECONDS } from "../lib/auth-store.mjs";
import {
  LOGIN_COOKIE,
  SESSION_COOKIE,
  deriveCsrfToken,
  identifyHosted,
  readCookie,
  serializeCookie,
} from "../lib/identity.mjs";

export const config = { path: "/api/hosted/session" };

/** The route, over injected dependencies. Exported so tests need no environment. */
export function createSessionRoute({ store }) {
  return async function sessionRoute(request) {
    if (request.method !== "GET") return methodNotAllowed("GET");

    const principal = await identifyHosted(request, { store });
    if (principal !== null) {
      const token = readCookie(request, SESSION_COOKIE);
      return jsonResponse(
        validateSessionResponse({
          v: 1,
          authenticated: true,
          accountId: principal.accountId,
          login: principal.login,
          csrfToken: deriveCsrfToken(token),
        }),
      );
    }

    const binding = await store.createTransient("login");
    return jsonResponse(validateSessionResponse({ v: 1, authenticated: false }), {
      cookies: [
        serializeCookie(LOGIN_COOKIE, binding.token, { maxAgeSeconds: TRANSIENT_TTL_SECONDS }),
      ],
    });
  };
}

export default serve(createSessionRoute);
