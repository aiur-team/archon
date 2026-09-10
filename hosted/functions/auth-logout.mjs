/**
 * `POST /api/hosted/auth/logout` - end a browser session, server-side first.
 *
 * Two rules from C1, and both of them are about what logout must *not* be.
 *
 * **A GET never logs out.** A logout on GET is one image tag away from being
 * triggered by any page on the internet, and while signing somebody out is a
 * mild attack on its own, it is a useful one to chain: it is how you force a
 * victim back through a sign-in flow you control the timing of. `GET` here is a
 * 405 that touches nothing.
 *
 * **Clearing the cookie is not logging out.** A response that only expires the
 * browser's copy leaves the token live on the server, so a cookie captured five
 * minutes ago still authenticates. So the order is: revoke, confirm the
 * revocation, and only then clear. If revocation could not be established -
 * a storage outage, an ambiguous write that read back live - this route returns
 * 503 and *does not* clear the cookie. Reporting a logout that did not happen is
 * strictly worse than reporting a failure the visitor can retry, because the
 * visitor stops looking.
 *
 * The pending publication binding is left alone. Logging out is not a decision
 * on a pending publication, and C1 keeps that binding alive until a decision or
 * expiry.
 */

import { validateSessionResponse } from "../lib/contracts.mjs";
import { jsonResponse, methodNotAllowed, serve } from "../lib/http.mjs";
import { SESSION_COOKIE, clearCookie, requireBrowserMutation } from "../lib/identity.mjs";

export const config = { path: "/api/hosted/auth/logout" };

/** The route, over injected dependencies. */
export function createLogoutRoute({ store, config: hostedConfig }) {
  return async function logoutRoute(request) {
    if (request.method !== "POST") return methodNotAllowed("POST");

    const { sessionToken } = await requireBrowserMutation(request, { store, config: hostedConfig });
    /* Throws `AuthUnavailableError` when it could not establish that the token
       is dead, which `serve` turns into a 503 with no `Set-Cookie` at all. */
    await store.revokeSession(sessionToken);

    return jsonResponse(validateSessionResponse({ v: 1, authenticated: false }), {
      cookies: [clearCookie(SESSION_COOKIE)],
    });
  };
}

export default serve(createLogoutRoute);
