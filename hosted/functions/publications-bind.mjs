/**
 * `POST /api/hosted/publications/bind` - exchange the link's browser secret for
 * a server-side binding.
 *
 * This is the first thing the approval page does and the only place the browser
 * secret is ever sent. The agent's link carries it in a fragment; the page strips
 * the fragment before anything else runs and posts the secret here exactly once.
 * From then on the browser's proof of which operation it is holding is an opaque
 * `__Host-` cookie, so the secret is not in the URL, not in history, not in a
 * referrer and not in this deployment's access logs.
 *
 * ## What this route deliberately does not do
 *
 * It does not approve anything, it does not require a session, and it returns no
 * descriptor. A visitor who has not signed in yet has proved possession of a
 * link and nothing more, and showing them the title of a document before they
 * authenticate would make the link itself a read capability. Everything the page
 * displays comes from the review route, behind a session.
 *
 * It also does not check state or deadline. A browser that followed a link to a
 * cancelled, denied or expired operation still needs to reach the review route
 * to be told which of those happened - binding it is what makes that possible,
 * and refusing here would collapse four distinct outcomes into "your link is
 * broken".
 *
 * ## The pre-login CSRF binding
 *
 * The visitor is typically signed out at this point, so C1's session-bound CSRF
 * token does not exist yet and the route uses the same pre-login binding the
 * sign-in form uses: a single-use, server-issued `__Host-archon_login` value
 * minted by `GET /api/hosted/session`. `consumeTransient` answers provenance and
 * single-use in one call - absent, fabricated, expired and already-redeemed all
 * come back as the same null - and it is consumed here, so a captured bind
 * request cannot be replayed. The page fetches the session route again
 * afterwards, which mints the fresh binding the sign-in form then needs.
 *
 * That is layered under, not instead of, the exact `Origin` check and
 * `SameSite=Lax`: a cross-site POST carries no `__Host-archon_login` at all.
 */

import { CsrfFailedError } from "../lib/auth-errors.mjs";
import { LOGIN_COOKIE, clearCookie, readCookie, requireExactOrigin } from "../lib/identity.mjs";
import { issueBrowserBinding, releaseBrowserBinding } from "../lib/publication-browser-binding.mjs";
import { bindPublication } from "../lib/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserJsonBody,
  browserMethodRejection,
} from "../lib/publications-browser-http.mjs";

export const config = { path: "/api/hosted/publications/bind" };

/**
 * The route, over injected dependencies.
 *
 * `resolveDependencies` is a thunk rather than a value so that reading operator
 * configuration happens inside the `try`: a deploy missing a C6 key answers 503
 * with no detail instead of throwing out of the function runtime. The method
 * rejection comes first, so a wrong method on a misconfigured deploy is still
 * reported as a wrong method.
 */
export function createBindRoute(resolveDependencies) {
  return async function bindRoute(request) {
    const wrongMethod = browserMethodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;

    const cookies = [];
    try {
      const { config: hostedConfig, store, publications } = resolveDependencies();
      requireExactOrigin(request, hostedConfig);

      /* Consumed before the body is read. The binding is what establishes that
         this request came from a page this service served to this browser, and
         spending a store read on an unbound caller's body would be work done on
         behalf of a request already known to be refused. */
      const presented = readCookie(request, LOGIN_COOKIE);
      if ((await store.consumeTransient("login", presented)) === null) throw new CsrfFailedError();
      cookies.push(clearCookie(LOGIN_COOKIE));

      const body = await browserJsonBody(request);
      const binding = await bindPublication(
        { publicationId: body.publicationId, browserSecret: body.browserSecret },
        publications,
      );

      /* Any binding this browser was already holding is revoked server-side
         before the new one is issued - one pending approval per browser is what
         a single `__Host-` cookie can express, and leaving the previous record
         live would keep a cookie a copy of which could still be presented. Its
         clear-cookie is discarded rather than sent: the `Set-Cookie` below
         replaces the same name, and emitting both would leave which one wins to
         the browser. */
      await releaseBrowserBinding(store, request);
      const issued = await issueBrowserBinding(store, binding);
      cookies.push(issued.setCookie);

      return browserJson(
        200,
        { v: 1, publicationId: binding.publicationId, expiresAt: issued.expiresAt },
        { cookies },
      );
    } catch (error) {
      return browserError(error, { cookies });
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createBindRoute(() => browserDependencies(process.env));
