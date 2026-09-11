/**
 * `POST /api/hosted/auth/logout` - end both sessions, server-side first.
 *
 * Three rules, and the first two are about what logout must *not* be.
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
 * 503 and *does not* clear the cookie and *does not* redirect. Reporting a
 * logout that did not happen is strictly worse than reporting a failure the
 * visitor can retry, because the visitor stops looking.
 *
 * **A logout that leaves the Auth0 session live is not a logout on a shared
 * machine.** Ending only the Archon session leaves the tenant session in the
 * browser, so the next visitor's "sign in" silently re-enters as the person who
 * just left rather than showing the chooser - AE7. So once the Archon session is
 * revoked and its cookie cleared, a *navigation* sign-out is answered with a 303
 * to the tenant's `/v2/logout`, which ends the Auth0 session and returns to the
 * allowlisted `returnTo`. That `returnTo` is `${appOrigin}/`, built from
 * configuration and never from the request, and exact including the scheme so it
 * can be allowlisted in the Auth0 application. `federated` is not sent: the
 * research records it as best-effort and unsupported for GitHub.
 *
 * **Why the answer is content-negotiated.** A `fetch` caller cannot follow a
 * cross-origin redirect - the browser would need CORS on Auth0's `/v2/logout`,
 * which it does not send - so a 303 handed to `fetch` is an error, not a logout.
 * An in-page sign-out that calls `fetch` therefore gets the JSON body and clears
 * its own view, while a real form navigation gets the 303 that carries the
 * browser out to the tenant. Both revoke the Archon session server-side first;
 * the difference is only how the browser is told, keyed on whether the caller
 * asked for `application/json`. Unifying every surface onto the navigation
 * sign-out is U6's job (one session for the collaboration layer); until then the
 * fetch path keeps the behaviour its callers were built against.
 *
 * **Where the CSRF token may be carried.** A `fetch` caller presents it in the
 * `X-Archon-Csrf` header. A form cannot set a header, so a form-encoded body may
 * carry it as a `csrfToken` field instead - the same shape
 * `/api/hosted/auth/start` already accepts for its different-account control.
 * The token itself is unchanged: still derived from the session cookie, still
 * compared in constant time, still unobtainable without a live session.
 *
 * The pending publication binding is left alone. Logging out is not a decision
 * on a pending publication, and C1 keeps that binding alive until a decision or
 * expiry.
 */

import { validateSessionResponse } from "../lib/hosted/contracts.mjs";
import { buildLogoutUrl } from "../lib/hosted/auth0-oidc.mjs";
import { jsonResponse, methodNotAllowed, redirectResponse, serve } from "../lib/hosted/http.mjs";
import { SESSION_COOKIE, clearCookie, requireBrowserMutation } from "../lib/hosted/identity.mjs";

export const config = { path: "/api/hosted/auth/logout" };

/** Whether the caller asked for a JSON answer rather than a navigation. */
function wantsJson(request) {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("application/json");
}

/**
 * The CSRF token a form navigation submitted, or null for a `fetch` caller.
 *
 * The header this route used to rely on alone is unreachable from a real
 * `<form method="post">` - a form cannot set a request header - so the sign-out
 * control in the signed-in nav had no way to present its binding and was
 * refused. A form-encoded body is therefore read for a `csrfToken` field, and
 * `requireBrowserMutation` still compares it in constant time against the token
 * derived from the session cookie: this widens *where* the token may be carried
 * and not *what* counts as one. A `fetch` caller sends no such body, gets null
 * here, and falls through to the header exactly as before.
 *
 * A body this route cannot parse yields null rather than an exception, so the
 * request is refused by the CSRF check rather than by a parser error that would
 * tell a prober their body shape was interesting.
 */
async function presentedCsrfField(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  try {
    return new URLSearchParams(await request.text()).get("csrfToken");
  } catch {
    return null;
  }
}

/** The route, over injected dependencies. */
export function createLogoutRoute({ store, config: hostedConfig }) {
  return async function logoutRoute(request) {
    if (request.method !== "POST") return methodNotAllowed("POST");

    /* `formNavigation` because the sign-out control may be a real `<form
       method="post">`: the browser has to *navigate* to `/v2/logout` for the
       tenant to end its own session. The check is still fail-closed - exact
       origin, or `Origin: null` alongside `Sec-Fetch-Site: same-origin` and
       `Sec-Fetch-Mode: navigate` - so a cross-site POST is refused, and a
       same-origin `fetch` presents a real `Origin` and its CSRF header. */
    const { sessionToken } = await requireBrowserMutation(request, {
      store,
      config: hostedConfig,
      presentedCsrf: await presentedCsrfField(request),
      formNavigation: true,
    });
    /* Throws `AuthUnavailableError` when it could not establish that the token
       is dead, which `serve` turns into a 503 with no `Set-Cookie`, no body and
       no redirect at all - the same refusal on both branches. */
    await store.revokeSession(sessionToken);

    const cookies = [clearCookie(SESSION_COOKIE)];
    if (wantsJson(request)) {
      return jsonResponse(validateSessionResponse({ v: 1, authenticated: false }), { cookies });
    }
    const logoutUrl = buildLogoutUrl({
      domain: hostedConfig.auth0.domain,
      clientId: hostedConfig.auth0.clientId,
      returnTo: `${hostedConfig.appOrigin}/`,
    });
    return redirectResponse(logoutUrl, { status: 303, cookies });
  };
}

export default serve(createLogoutRoute);
