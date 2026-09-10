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
 * So the binding is not an echo. It is a server-issued, single-use secret held
 * in a cookie, and it rests on three independent properties:
 *
 *  - **Provenance.** `GET /api/hosted/session` mints the value with
 *    `createTransient("login")` and stores only its hash. This route consumes
 *    the presented cookie against that record, so a cookie a client simply made
 *    up is refused. An earlier version accepted any well-formed value on the
 *    grounds that the two properties below carried the defence; they do, but "a
 *    captured binding cannot be replayed" was then not true of a *fabricated*
 *    one, and a presence check is not the "separate transient CSRF binding" C1
 *    asks for.
 *  - **`SameSite=Lax` withholds the cookie from a cross-site POST entirely.** A
 *    form on another origin that posts here carries no `__Host-archon_login` at
 *    all, so "the cookie is present" is by itself a statement that the request
 *    came from this site.
 *  - **The `Origin` header must equal the one configured app origin exactly.**
 *    Browsers send it on every form POST and every state-changing fetch.
 *
 * And it is single-use: consumption is a compare-and-set on the issued record,
 * so a captured value cannot be replayed and every sign-in attempt is a fresh
 * transaction. A retry therefore starts a new transaction rather than replaying
 * a consumed one, which is what C1 asks of a login retry.
 *
 * ## Failures are pages, not envelopes
 *
 * The sign-in page submits a real `<form method="post">`, so this route's
 * response *is* what the visitor looks at. A visitor whose tab sat open past the
 * binding's fifteen minutes would otherwise be shown a raw JSON error envelope
 * with no way back. A form submission therefore lands on `/login/?status=<word>`
 * with a word from the same closed set the callback uses, while a JSON caller
 * still gets the C3 envelope. Whatever cookies the route had already decided to
 * set - notably the cleared session on the different-account path, where the
 * revocation has already happened - ride along on that failure response.
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

import { AuthUnavailableError, CsrfFailedError } from "../lib/hosted/auth-errors.mjs";
import { TRANSIENT_TTL_SECONDS } from "../lib/hosted/auth-store.mjs";
import { HOSTED_LIMITS } from "../lib/hosted/contracts.mjs";
import { buildAuthorizeUrl, callbackUri, createPkcePair } from "../lib/hosted/github-oauth.mjs";
import { errorResponse, methodNotAllowed, redirectResponse, serve } from "../lib/hosted/http.mjs";
import { hashToken, randomToken } from "../lib/hosted/secrets.mjs";
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
} from "../lib/hosted/identity.mjs";

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

/** Whether this request is a browser form navigation rather than a JSON call. */
function isFormNavigation(request) {
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return type === "application/x-www-form-urlencoded";
}

/** Where a form-posted failure lands, carrying any cookies already decided. */
function failedPage(error, cookies) {
  const status = error instanceof AuthUnavailableError ? "unavailable" : "expired";
  return redirectResponse(`/login/?status=${status}`, { status: 303, cookies });
}

/** The route, over injected dependencies. */
export function createStartRoute({ store, config: hostedConfig }) {
  return async function startRoute(request) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const asPage = isFormNavigation(request);
    const cookies = [];
    try {
      return await run(request, cookies);
    } catch (error) {
      return asPage ? failedPage(error, cookies) : errorResponse(error, { cookies });
    }
  };

  async function run(request, cookies) {
    /* `formNavigation`: the sign-in page submits a real `<form method="post">`,
       and C3's mandatory `Referrer-Policy: no-referrer` makes Fetch send
       `Origin: null` on a navigation. `requireExactOrigin` accepts that only
       alongside `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Mode: navigate`,
       and only where a caller asks for it - which is here and nowhere else. */
    requireExactOrigin(request, hostedConfig, { formNavigation: true });
    const field = await readFields(request);

    const switching = field("switchAccount") === "true";

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
        /* The different-account control is a form too, so it arrives with the
           same `Origin: null` a navigation always carries here. */
        formNavigation: true,
      });
      await store.revokeSession(sessionToken);
      cookies.push(clearCookie(SESSION_COOKIE));
    } else {
      /* The binding must be one this service *issued*, not merely one that is
         well-formed. `consumeTransient` answers both halves at once: it finds
         the record `GET /api/hosted/session` minted for this browser, and wins
         the compare-and-set that makes it single-use. Absent, malformed,
         fabricated, expired and already-redeemed all come back as the same
         null, which is the same answer to the caller and deliberately gives a
         racing attacker nothing to tell them apart by. */
      const binding = readCookie(request, LOGIN_COOKIE);
      if ((await store.consumeTransient("login", binding)) === null) throw new CsrfFailedError();
      cookies.push(clearCookie(LOGIN_COOKIE));
    }

    /* The destination is validated here, at the edge, and then stored
       server-side. It never travels to GitHub and never rides in the `state`
       parameter, so the value the callback redirects to is one this service
       accepted rather than one the round trip carried back. */
    /* `||` rather than `??`: a form that submits `destination=` sends an empty
       string, not an absent field, and an empty string is the visitor asking for
       the default rather than for a destination this route must refuse. */
    const destination = validateDestination(field("destination") || HOSTED_LIMITS.AUTHORIZE_PATH);

    /* The `state` GitHub carries and the cookie this browser holds are two
       different secrets. Making them one value looked like a double submit and
       was not: the `__Host-` prefix is enforced by browsers, and the server only
       reads a `Cookie` header, so anyone who learned the callback URL - a
       function access log, an APM trace, a synced history entry - knew both
       halves and could redeem the code with `curl`. Only the browser that
       started the transaction holds `binding`, and only its SHA-256 is stored. */
    const binding = randomToken();
    const pkce = createPkcePair();
    const transaction = await store.createTransient("oauth", {
      codeVerifier: pkce.verifier,
      destination,
      bindingHash: hashToken(binding),
    });
    cookies.push(serializeCookie(OAUTH_COOKIE, binding, { maxAgeSeconds: TRANSIENT_TTL_SECONDS }));

    const authorizeUrl = buildAuthorizeUrl({
      clientId: hostedConfig.github.clientId,
      redirectUri: callbackUri(hostedConfig.appOrigin),
      state: transaction.token,
      codeChallenge: pkce.challenge,
      selectAccount: switching,
    });
    return redirectResponse(authorizeUrl, { status: 303, cookies });
  }
}

export default serve(createStartRoute);
