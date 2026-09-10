/**
 * `GET /api/hosted/publications/<id>/review` - what the approval page is allowed
 * to show.
 *
 * Two credentials, both required, and they answer different questions. The
 * `__Host-archon_publish` binding says *which* pending publication this browser
 * is holding, and it can only have been issued by the bind route to a browser
 * that presented the link's secret. The session says *who* is looking, and it is
 * the account that will become owner if they approve. Neither substitutes for
 * the other: a link without a session must not reveal a document title, and a
 * session without a link must not be able to name an operation it was never
 * handed.
 *
 * The body is `reviewPublication`'s projection and nothing more - descriptor,
 * pairing code, effective state, the current account, the deadline. No secret
 * hash and no HTML appears in any state, including `complete`, where the
 * document exists but this browser has not proved it owns it.
 *
 * ## Why this is a GET, and why it is still safe
 *
 * C1 is explicit that GET never approves anything, and this route reads. It
 * therefore does not demand an `Origin` header: browsers do not send one on a
 * same-origin GET, so requiring it would refuse every legitimate request while
 * refusing nothing else. What keeps the body from a hostile page is that there
 * is no CORS grant anywhere in the hosted API, so a cross-origin `fetch` cannot
 * read this response even though the browser may have sent the cookies.
 *
 * ## Why the binding is checked before the session
 *
 * The page needs the two failures to be distinguishable, because they lead to
 * opposite instructions: `session_required` means "sign in and come back here",
 * `approval_required` means "this browser is not holding a pending publication
 * any more - open the link from your terminal again". Checking the binding first
 * also means a signed-in visitor who wandered to a guessed URL learns nothing
 * about whether that publication exists.
 */

import { SessionRequiredError } from "../lib/auth-errors.mjs";
import { identifyHosted } from "../lib/identity.mjs";
import { requireBrowserBinding } from "../lib/publication-browser-binding.mjs";
import { reviewPublication } from "../lib/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserMethodRejection,
  browserPublicationId,
} from "../lib/publications-browser-http.mjs";

export const config = { path: "/api/hosted/publications/:publicationId/review" };

/** The route, over injected dependencies. */
export function createReviewRoute(resolveDependencies) {
  return async function reviewRoute(request) {
    const wrongMethod = browserMethodRejection(request, "GET");
    if (wrongMethod !== null) return wrongMethod;

    try {
      const { store, publications } = resolveDependencies();
      const publicationId = browserPublicationId(request, "review");
      const browserBinding = await requireBrowserBinding(store, request, publicationId);

      /* `identifyHosted` throws rather than returning null when the store is
         unreachable, so a storage outage is a 503 here and never a signed-out
         visitor being told to sign in again. */
      const principal = await identifyHosted(request, { store });
      if (principal === null) throw new SessionRequiredError();

      return browserJson(
        200,
        await reviewPublication({ publicationId, browserBinding, principal }, publications),
      );
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createReviewRoute(() => browserDependencies(process.env));
