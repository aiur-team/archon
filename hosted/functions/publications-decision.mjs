/**
 * `POST /api/hosted/publications/<id>/decision` - the human's explicit approve
 * or deny.
 *
 * This is the only route in the hosted API that can create an owner, and it is
 * held to the highest bar in it. Four things must all be true, and each one
 * closes a different hole:
 *
 *  - **The exact configured `Origin`.** Not a suffix, not a hostname. Refuses
 *    the whole cross-site class before a store is touched.
 *  - **A live session.** The account that will own the document.
 *  - **The session-bound CSRF token**, in `X-Archon-Csrf`. Derived from the
 *    session cookie, so it cannot be produced by anything that does not already
 *    hold the session, and it dies with it.
 *  - **The `__Host-archon_publish` binding.** Which pending publication this is.
 *    A session alone must never be able to name an operation this browser was
 *    not handed.
 *
 * ## `displayedAccountId` is consent, not routing
 *
 * The page sends back the account it told the visitor they were acting as, and
 * `decidePublication` refuses the decision unless it equals the session's
 * account. It never selects an owner - the owner is the session's account or
 * there is no decision. The case it exists for is a tab left open across an
 * account switch: the button says "publish as @alpha", the session is now
 * @beta, and the click was consent to publish as somebody who is no longer
 * signed in. C1 has no owner selector and no email ownership claim, and this
 * field is not one; it is a confirmation that what was shown is what is true.
 *
 * ## Why the binding is released only on a decision that landed
 *
 * C1 keeps the binding alive through an account switch and clears it "on a
 * decision or at expiry". So a refusal - expired, already terminal, wrong
 * account - leaves it in place, because the page's next move is to re-read the
 * review route and tell the visitor precisely which of those happened, and it
 * needs the binding to do that. A decision that committed is the one moment
 * there is nothing left to approve, and the record is revoked server-side rather
 * than merely un-cookied, so a copied cookie cannot present it either.
 *
 * The success body is the same review projection the page was already
 * rendering, so the outcome is drawn from this response without a second
 * request - which matters precisely because the binding is now gone.
 */

import { requireBrowserMutation } from "../lib/identity.mjs";
import {
  releaseBrowserBinding,
  requireBrowserBinding,
} from "../lib/publication-browser-binding.mjs";
import { decidePublication } from "../lib/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserJsonBody,
  browserMethodRejection,
  browserPublicationId,
} from "../lib/publications-browser-http.mjs";

export const config = { path: "/api/hosted/publications/:publicationId/decision" };

/** The route, over injected dependencies. */
export function createDecisionRoute(resolveDependencies) {
  return async function decisionRoute(request) {
    const wrongMethod = browserMethodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;

    try {
      const { config: hostedConfig, store, publications } = resolveDependencies();

      /* Origin, session and CSRF, in that order, before anything is read from
         the body or the store. */
      const { principal } = await requireBrowserMutation(request, {
        store,
        config: hostedConfig,
      });

      const publicationId = browserPublicationId(request, "decision");
      const browserBinding = await requireBrowserBinding(store, request, publicationId);
      const body = await browserJsonBody(request);

      const decided = await decidePublication(
        {
          publicationId,
          browserBinding,
          principal,
          decision: body.decision,
          displayedAccountId: body.displayedAccountId,
        },
        publications,
      );

      const released = await releaseBrowserBinding(store, request);
      return browserJson(200, decided, { cookies: [released.setCookie] });
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createDecisionRoute(() => browserDependencies(process.env));
