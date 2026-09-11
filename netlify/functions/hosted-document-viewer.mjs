/**
 * `GET|HEAD /docs/<id>` - the trusted viewer shell.
 *
 * This route answers one question and returns one of five fixed pages. It never
 * puts a title, an owner or a digest into its output; `viewer.js` fetches those
 * from `/api/hosted/docs/<id>`, which authorises the request again from
 * scratch, and the shell it serves is byte-identical for every document.
 *
 * ## Why this page now resolves the record, when it deliberately did not
 *
 * Until ACN-007 a signed-in reader got the shell for any well-formed id and the
 * API route delivered the refusal a moment later. That was the right trade while
 * "may read" had exactly two answers, because the shell disclosed nothing and
 * checking here would have been a second, earlier copy of a decision the API
 * route was about to make properly.
 *
 * Domain access adds a third answer - "your address is not verified" - which is
 * an *actionable* state rather than a refusal, and a page that renders "loading
 * your document…" at a reader who needs to go and verify an email address is
 * telling them the wrong thing for as long as they wait. So the page resolves
 * the record too, through the same `readAccessiblePublication` call the API
 * routes make, and the three surfaces reach one decision for one principal by
 * construction. The disclosure this adds is the one the metadata route already
 * makes to the same reader one request later.
 *
 * The five answers, and why each is the answer:
 *
 *  - **Signed in, and admitted** -> the shell.
 *  - **Signed in, refused for any non-disclosing reason** -> the inert
 *    not-found page. Missing, not complete, owned by somebody else and "your
 *    domain is not on the list" are one answer with one body, exactly as they
 *    are on the API routes.
 *  - **Signed in, domain listed, address unverified** -> the verify-your-email
 *    page. The one page here that says something about the document, bounded to
 *    a reader whose own claimed domain already matched.
 *  - **Signed out, well-formed id** -> a 303 to `/login/?destination=/docs/<id>`.
 *    The destination is server-built from the id this route already validated,
 *    and it is one of the two literals `validateDestination` accepts, so there
 *    is no `next` parameter here for a caller to aim anywhere. Again no lookup:
 *    an anonymous visitor gets a redirect for any well-formed id, so the
 *    redirect is not a probe for which documents exist.
 *  - **Malformed id** -> the inert not-found page. It cannot become a redirect,
 *    because C1's destination grammar would refuse the value; and it must not
 *    become a lookup, because a malformed id has to reach the same body as a
 *    well-formed one that does not exist.
 *  - **Either store could not be read** -> the inert unavailable page, 503, with
 *    no `Set-Cookie` and no redirect. `identifyHosted` throws rather than
 *    returning null for exactly this, and the publication store reports an
 *    outage as `unavailable` rather than as absence. Treating either as
 *    signed-out would redirect an owner to sign in during an outage - sending
 *    them through a sign-in that would also fail, to fix a problem they do not
 *    have - and treating the second as absence would tell them their document
 *    is gone.
 *
 * `HEAD` is handled as the same decision with the body dropped, rather than as a
 * separate path that could drift. A `HEAD` is never cheaper to get an answer
 * from than a `GET`.
 */

import { getStore } from "@netlify/blobs";

import { openAuthStore } from "../lib/hosted/auth-store.mjs";
import { readHostedConfig } from "../lib/hosted/config.mjs";
import { HostedContractError } from "../lib/hosted/contracts.mjs";
import { identifyHosted } from "../lib/hosted/identity.mjs";
import { publicationDependencies, readAccessiblePublication } from "../lib/hosted/publications.mjs";
import {
  PAGE_PATTERN,
  PRIVATE_HEADERS,
  documentIdFrom,
  emailUnverifiedPage,
  htmlResponse,
  notFoundPage,
  signInDestination,
  unavailablePage,
  viewerCsp,
  viewerShell,
} from "../lib/hosted/documents.mjs";

export const config = { path: "/docs/:documentId" };

/** The allowed methods, advertised on the refusal. */
const ALLOW = "GET, HEAD";

/**
 * A 405 that is still an inert HTML page.
 *
 * The other hosted routes answer a wrong method with a JSON envelope, and this
 * one does not, because this address is reached by navigation: a browser handed
 * `{"v":1,...}` would display it, and a JSON body on an HTML surface is how a
 * page ends up rendering something a policy did not expect.
 */
function methodNotAllowedPage() {
  /* Always a GET-shaped body: this is only reached for a method that is neither
     GET nor HEAD, so there is no HEAD case here to handle. An earlier version
     branched on it anyway, which read as if HEAD 405s were possible. */
  const response = notFoundPage("GET");
  const headers = new Headers(response.headers);
  headers.set("Allow", ALLOW);
  return new Response(response.body, { status: 405, headers });
}

/** The route, over injected dependencies. Exported so tests need no environment. */
export function createViewerRoute({ store, config: hostedConfig, publications }) {
  return async function viewerRoute(request) {
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowedPage();
    }

    let documentId;
    try {
      documentId = documentIdFrom(new URL(request.url).pathname, PAGE_PATTERN);
    } catch {
      return notFoundPage(method);
    }

    let principal;
    try {
      principal = await identifyHosted(request, { store });
    } catch {
      /* Every throw is an outage: `identifyHosted` returns null for absent,
         expired and revoked, and throws only when it could not establish which
         of those it was. */
      return unavailablePage(method);
    }

    if (principal === null) {
      /* The shared set, not a copy of it. This was the one response in the new
         code whose headers were enumerated by hand, which meant the next header
         added to `PRIVATE_HEADERS` would silently miss it -- and it was already
         missing `X-Frame-Options` and a policy. */
      const headers = new Headers({
        ...PRIVATE_HEADERS,
        Location: signInDestination(documentId),
      });
      return new Response(null, { status: 303, headers });
    }

    /* The one decision, made by the same adapter call the two API routes make.
       The page cannot answer "loading…" to a reader the metadata route is about
       to refuse, because both ask `evaluateAccess` about the same principal and
       the same record. */
    try {
      await readAccessiblePublication({ publicationId: documentId, principal }, publications);
    } catch (error) {
      /* Only a *typed* refusal may become the not-found page. Anything else -
         a `TypeError` from a mis-wired dependency set, a bug in the adapter -
         is this service failing, and rendering it as absence would tell every
         owner at once that their document is gone: the one thing this module's
         own rule says a failure must never read as. An untyped throw is an
         outage, and it says so. */
      if (!(error instanceof HostedContractError)) return unavailablePage(method);
      if (error.code === "email_unverified") return emailUnverifiedPage(method);
      if (error.code === "unavailable") return unavailablePage(method);
      return notFoundPage(method);
    }

    return htmlResponse(viewerShell(hostedConfig.renderOrigin), {
      csp: viewerCsp(hostedConfig.renderOrigin),
      method,
    });
  };
}

/**
 * The Netlify entry point.
 *
 * Configuration is read per request and inside the boundary, so a deployment
 * missing `HOSTED_RENDER_ORIGIN` serves the inert unavailable page rather than
 * a shell framing nothing - and never names the missing key, which is an
 * operator's business rather than a visitor's.
 */
export default async function viewer(request) {
  try {
    const hostedConfig = readHostedConfig(process.env);
    return await createViewerRoute({
      store: openAuthStore(),
      config: hostedConfig,
      publications: publicationDependencies({ env: process.env, getStore }),
    })(request);
  } catch {
    return unavailablePage(request.method === "HEAD" ? "HEAD" : "GET");
  }
}
