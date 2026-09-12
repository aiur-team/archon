/**
 * `POST /api/hosted/publications/claim` - the signed-in way to reach an
 * approval, for a person who no longer has the agent's link.
 *
 * ## Why this route exists
 *
 * Until it did, the capability to approve a publication reached a person
 * through exactly one channel: the fragment URL in the agent's message. During
 * a live run the operator came back three times saying he had not been sent the
 * link, while the agent had in fact sent it repeatedly, and the fifteen-minute
 * window was running down the whole time. Better prose makes that relay more
 * reliable; it does not remove it. This route removes it, by letting the person
 * present the pairing code they were also given - or nothing at all, once the
 * publication is already theirs - and get back the same browser binding the
 * link would have produced.
 *
 * ## What it is not
 *
 * It is not a second way to approve, and it does not loosen the first one.
 * `hosted-publications-decision.mjs` is untouched: a decision still needs the
 * exact configured `Origin`, a live session, the session-bound CSRF token and
 * the `__Host-archon_publish` binding, and the owner it writes is still the
 * session's own account. All this route does is issue that binding to somebody
 * who proved, with a capability, that the pending publication is theirs.
 *
 * The proofs `claimPublication` accepts are the pairing code, the binding this
 * browser already holds from the link, and a claim this same account made
 * earlier. A bare publication id is *not* a proof: ids are in document URLs and
 * in agent receipts, and accepting one would turn every signed-in account into
 * a potential owner of every pending publication whose id it could see.
 *
 * ## Why every failure is the same failure
 *
 * A code that matches nothing, a code that matches something already decided, a
 * code somebody else claimed first, and an id this caller cannot prove anything
 * about all come back as one `not_found`. A typeable code page that answered
 * those differently would be an existence oracle for other people's
 * publications, reachable by anyone with an account and a keyboard. The
 * platform rate limit below is the second half of that: the same shape the
 * anonymous start route carries, for the same reason.
 *
 * ## The cookie is replaced, not added to
 *
 * A browser holds one pending approval at a time - that is what a single
 * `__Host-` cookie can express - so any binding this browser was already
 * holding is revoked server-side before the new one is issued, exactly as the
 * bind route does it. The release happens only after the claim succeeds: a
 * refused claim must leave a visitor who is mid-approval on a *different*
 * publication exactly where they were.
 */

import { readPendingBinding, requireBrowserMutation } from "../lib/hosted/identity.mjs";
import {
  decodeOperation,
  issueBrowserBinding,
  releaseBrowserBinding,
} from "../lib/hosted/publication-browser-binding.mjs";
import { claimPublication } from "../lib/hosted/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserJsonBody,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = {
  path: "/api/hosted/publications/claim",
  /* A signed-in caller can ask this route to test one pairing code per request,
     and a code is the one capability in this flow a person can type. Ten a
     minute per client IP is the same bound the anonymous start route carries,
     spelled the same way and for the same reason: it is delayed and
     best-effort, it bounds a sustained guessing run rather than a burst, and
     nothing downstream treats it as an authorisation check - `claimPublication`
     refuses every unproved claim whether or not a rule ever fired.

     The literal integers are deliberate. An invalid rule is dropped by the
     platform without failing the deploy, so a computed value that did not parse
     would leave this route silently unprotected. */
  rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

/** The route, over injected dependencies. */
export function createClaimRoute(resolveDependencies) {
  return async function claimRoute(request) {
    const wrongMethod = browserMethodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;

    try {
      const { config: hostedConfig, store, publications } = resolveDependencies();

      /* Origin, session and CSRF first, so an unauthenticated caller never
         reaches the census a code lookup runs. */
      const { principal } = await requireBrowserMutation(request, {
        store,
        config: hostedConfig,
      });

      const body = await browserJsonBody(request);

      /* The binding this browser already holds, if any, offered to the adapter
         as one of the three proofs. It is read rather than required: the
         typed-code path has no binding yet, and that is the ordinary case here.
         A cookie that decodes to nothing is simply not a proof. */
      const held = await readPendingBinding(store, request);
      const browserBinding = held === null ? null : decodeOperation(held.operation);

      const claimed = await claimPublication(
        {
          publicationId: body.publicationId,
          userCode: body.userCode,
          browserBinding,
          principal,
        },
        publications,
      );

      /* A browser that is already holding exactly this publication keeps the
         binding it has. That is the approval page's own call - it claims the
         operation once the visitor has signed in, so that the same publication
         is reachable later from `/publish/pending` on any device - and
         revoking a live binding to mint an identical one would put a
         re-issue in the middle of a flow that was working. Every other caller
         gets a fresh binding, replacing whatever this browser held, because one
         `__Host-` cookie can express one pending approval. */
      const cookies = [];
      const alreadyHeld =
        browserBinding !== null && browserBinding.publicationId === claimed.publicationId;
      if (!alreadyHeld) {
        await releaseBrowserBinding(store, request);
        const issued = await issueBrowserBinding(store, claimed.binding);
        cookies.push(issued.setCookie);
      }

      /* The publication id and the approval deadline, and nothing else. The
         descriptor belongs to the review route, which the approval page reaches
         with the binding this response just handed it - so there is exactly one
         projection of a publication for a browser, and it is behind the
         binding. */
      return browserJson(
        200,
        {
          v: 1,
          publicationId: claimed.publicationId,
          expiresAt: claimed.expiresAt,
        },
        { cookies },
      );
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createClaimRoute(() => browserDependencies(process.env));
