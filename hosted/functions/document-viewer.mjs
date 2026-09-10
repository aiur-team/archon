/**
 * `GET|HEAD /docs/<id>` - the trusted viewer shell.
 *
 * This route answers one question and returns one of four fixed pages. It never
 * reads a document, never touches `readOwnedPublication`, and never puts a
 * title, an owner or a digest into its output; `viewer.js` fetches those from
 * `/api/hosted/docs/<id>`, which authorises the request again from scratch.
 *
 * The four answers, and why each is the answer:
 *
 *  - **Signed in, well-formed id** -> the shell. Note what is *not* checked
 *    here: whether the document exists, and whether this account owns it. The
 *    shell is byte-identical for every id, so serving it discloses nothing, and
 *    checking would be an oracle that answers before the API route gets to give
 *    the same answer properly. A reader who opens somebody else's document id
 *    sees a shell that then reports "not found", exactly as they would for an id
 *    that was never issued.
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
 *  - **The session store could not be read** -> the inert unavailable page, 503.
 *    `identifyHosted` throws rather than returning null for exactly this, and
 *    treating it as signed-out would redirect an owner to sign in during an
 *    outage - sending them through a sign-in that would also fail, to fix a
 *    problem they do not have.
 *
 * `HEAD` is handled as the same decision with the body dropped, rather than as a
 * separate path that could drift. A `HEAD` is never cheaper to get an answer
 * from than a `GET`.
 */

import { openAuthStore } from "../lib/auth-store.mjs";
import { readHostedConfig } from "../lib/config.mjs";
import { identifyHosted } from "../lib/identity.mjs";
import {
  DOCUMENT_PAGE_PATH,
  PAGE_PATTERN,
  documentIdFrom,
  htmlResponse,
  notFoundPage,
  signInDestination,
  unavailablePage,
  viewerCsp,
  viewerShell,
} from "../lib/documents.mjs";

export const config = { path: DOCUMENT_PAGE_PATH };

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
function methodNotAllowedPage(method) {
  const response = notFoundPage(method === "HEAD" ? "HEAD" : "GET");
  const headers = new Headers(response.headers);
  headers.set("Allow", ALLOW);
  return new Response(method === "HEAD" ? null : response.body, { status: 405, headers });
}

/** The route, over injected dependencies. Exported so tests need no environment. */
export function createViewerRoute({ store, config: hostedConfig }) {
  return async function viewerRoute(request) {
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowedPage(request.method);
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
      const headers = new Headers({
        "Cache-Control": "private, no-store",
        "Netlify-CDN-Cache-Control": "no-store",
        Vary: "Cookie",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        Location: signInDestination(documentId),
      });
      return new Response(null, { status: 303, headers });
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
    return await createViewerRoute({ store: openAuthStore(), config: hostedConfig })(request);
  } catch {
    return unavailablePage(request.method === "HEAD" ? "HEAD" : "GET");
  }
}
