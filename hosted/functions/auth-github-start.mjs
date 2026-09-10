/**
 * `POST /api/hosted/auth/github/start` - begin a browser-bound GitHub
 * authorization.
 *
 * ## Why this is a POST with a binding, and what stands in for a double submit
 *
 * Starting an authorization is a state-changing request: it writes a
 * transaction record, sets a cookie and - on the different-account path -
 * revokes a live session. A GET that did any of that could be triggered by an
 * image tag.
 *
 * C1 asks the pre-login form to use "a separate transient CSRF binding, not a
 * required authenticated session". The classic spelling of that is a double
 * submit: a token in a cookie, the same token echoed in the form. It is not
 * available here, and the reason is worth writing down because it looks like an
 * oversight otherwise. C1 freezes the session body to `{v:1,
 * authenticated:false}` when nobody is signed in, and freezes every transient
 * cookie as `HttpOnly`. Between them there is no conformant channel that can
 * hand a value to the static sign-in page for it to echo back - the body may not
 * carry it and JavaScript may not read the cookie.
 *
 * So the binding is presence and freshness rather than an echo, and it rests on
 * two independent properties:
 *
 *  - **`SameSite=Lax` withholds the cookie from a cross-site POST entirely.** A
 *    form on another origin that posts here carries no `__Host-archon_login` at
 *    all, so "the cookie is present" is by itself a statement that the request
 *    came from this site.
 *  - **The `Origin` header must equal the one configured app origin exactly.**
 *    Browsers send it on every form POST and every state-changing fetch.
 *
 * And the binding is single-use: it is consumed through the store's
 * compare-and-set, so a captured value cannot be replayed and every sign-in
 * attempt is a fresh transaction. A retry therefore starts a new transaction
 * rather than replaying a consumed one, which is what C1 asks of a login retry.
 *
 * ## The different-account path
 *
 * When the visitor is signed in and asks for a different account, this route is
 * a fully protected mutation - session plus session-bound CSRF - because it
 * revokes their Archon session. It then starts a fresh authorization with
 * `prompt=select_account`, and it deliberately leaves the publication binding
 * cookie alone, so the pending approval survives the switch.
 *
 * Revoking the Archon session does not sign the visitor out of GitHub, and
 * nothing in this flow implies it does; `prompt=select_account` is what makes
 * the provider ask which account, rather than silently reusing the one the
 * browser is already signed into.
 */

import { CsrfFailedError } from "../lib/auth-errors.mjs";
import { TRANSIENT_TTL_SECONDS } from "../lib/auth-store.mjs";
import { HOSTED_LIMITS } from "../lib/contracts.mjs";
import { buildAuthorizeUrl, callbackUri, createPkcePair } from "../lib/github-oauth.mjs";
import { methodNotAllowed, redirectResponse, serve } from "../lib/http.mjs";
import {
  LOGIN_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  readCookie,
  requireBrowserMutation,
  requireExactOrigin,
  serializeCookie,
  validateDestination,
} from "../lib/identity.mjs";

export const config = { path: "/api/hosted/auth/github/start" };

/**
 * The submitted fields, from a form post or a JSON body.
 *
 * A body this route cannot parse yields no fields rather than an exception, so
 * the request is refused by the binding check below - the same refusal an
 * unbound request gets - instead of by a parser error that would tell a prober
 * their body shape was interesting.
 */
async function readFields(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  try {
    if (type === "application/x-www-form-urlencoded") {
      const params = new URLSearchParams(await request.text());
      return (name) => params.get(name);
    }
    if (type === "application/json") {
      const body = await request.json();
      if (body === null || typeof body !== "object" || Array.isArray(body)) return () => null;
      return (name) => (typeof body[name] === "string" ? body[name] : null);
    }
  } catch {
    return () => null;
  }
  return () => null;
}

/** The route, over injected dependencies. */
export function createStartRoute({ store, config: hostedConfig }) {
  return async function startRoute(request) {
    if (request.method !== "POST") return methodNotAllowed("POST");

    requireExactOrigin(request, hostedConfig);
    const field = await readFields(request);

    const switching = field("switchAccount") === "true";
    const cookies = [];

    if (switching) {
      /* Revoking a live session is a protected mutation, so it is held to the
         full authenticated bar - session, exact origin, session-bound CSRF -
         rather than to the pre-login binding. And the revocation is awaited
         before the authorization starts: a switch that redirected first and
         revoked afterwards would leave the old session alive for as long as the
         provider round trip takes. */
      const { sessionToken } = await requireBrowserMutation(request, {
        store,
        config: hostedConfig,
        presentedCsrf: field("csrfToken"),
      });
      await store.revokeSession(sessionToken);
      cookies.push(clearCookie(SESSION_COOKIE));
    } else {
      const binding = readCookie(request, LOGIN_COOKIE);
      if (binding === null) throw new CsrfFailedError();
      if ((await store.consumeTransient("login", binding)) === null) throw new CsrfFailedError();
      cookies.push(clearCookie(LOGIN_COOKIE));
    }

    /* The destination is validated here, at the edge, and then stored
       server-side. It never travels to GitHub and never rides in the `state`
       parameter, so the value the callback redirects to is one this service
       accepted rather than one the round trip carried back. */
    const destination = validateDestination(field("destination") ?? HOSTED_LIMITS.AUTHORIZE_PATH);

    const pkce = createPkcePair();
    const transaction = await store.createTransient("oauth", {
      codeVerifier: pkce.verifier,
      destination,
    });
    cookies.push(
      serializeCookie(OAUTH_COOKIE, transaction.token, { maxAgeSeconds: TRANSIENT_TTL_SECONDS }),
    );

    const authorizeUrl = buildAuthorizeUrl({
      clientId: hostedConfig.github.clientId,
      redirectUri: callbackUri(hostedConfig.appOrigin),
      state: transaction.token,
      codeChallenge: pkce.challenge,
      selectAccount: switching,
    });
    return redirectResponse(authorizeUrl, { status: 303, cookies });
  };
}

export default serve(createStartRoute);
