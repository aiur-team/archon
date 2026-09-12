/**
 * `GET /api/hosted/publications/pending` - the publications this person is
 * waiting to approve.
 *
 * The safety net under the agent relay. A person who signed in from the agent's
 * link - often creating their Archon account in that same minute - and then
 * lost the tab, changed device, or simply could not find the message again has,
 * until this route existed, nothing at all: the fragment was the only address
 * of their approval and it is deliberately removed from the URL on first load.
 * Here they sign in, land on `/publish/pending`, and the thing that is waiting
 * for them is on the screen.
 *
 * ## Scoped to the claimant, in the adapter, by equality
 *
 * `listClaimedPendingPublications` filters on `claimantAccountId` equal to the
 * session's account and projects nothing else, so there is no shape in which
 * another person's title, pairing code or publication id reaches this response.
 * The filter lives there rather than here on purpose: a route handed unfiltered
 * records could ship one by projecting the wrong variable, and nothing in the
 * adapter would fail when it did.
 *
 * A publication nobody has claimed is nobody's here, including the deployment
 * operator's. The operator census is `/api/hosted/admin/documents`, it is behind
 * `ARCHON_ADMINS`, and this route has no admin branch to widen.
 *
 * ## Why a session is enough, and why there is no `Origin` check
 *
 * This reads and changes nothing, exactly like the review and access `GET`s.
 * Browsers send no `Origin` on a same-origin `GET`, so demanding one would
 * refuse every legitimate request and no hostile one; what keeps the body away
 * from a hostile page is that the hosted API issues no CORS grant anywhere, so a
 * cross-origin `fetch` cannot read this response even when the browser attached
 * the cookies. `Cache-Control: private, no-store` and `Vary: Cookie` come from
 * the shared browser response headers, which is what stops one person's list
 * being handed to the next visitor by a shared cache.
 */

import { SessionRequiredError } from "../lib/hosted/auth-errors.mjs";
import { identifyHosted } from "../lib/hosted/identity.mjs";
import { listClaimedPendingPublications } from "../lib/hosted/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = {
  path: "/api/hosted/publications/pending",
  /* One request enumerates the publication census, so this is the one read in
     the hosted API whose cost is a function of how much the deployment holds.
     The same delayed, best-effort bound the other publish routes carry keeps a
     signed-in caller from turning that into a loop. It is not an authorisation
     check: the account filter in the adapter is. */
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

/** The route, over injected dependencies. */
export function createPendingRoute(resolveDependencies) {
  return async function pendingRoute(request) {
    const wrongMethod = browserMethodRejection(request, "GET");
    if (wrongMethod !== null) return wrongMethod;

    try {
      const { store, publications } = resolveDependencies();

      /* `identifyHosted` throws rather than returning null when the store is
         unreachable, so a storage outage is a 503 here and never an empty list
         - which would read as "nothing is waiting for you" to the one person
         for whom something is. */
      const principal = await identifyHosted(request, { store });
      if (principal === null) throw new SessionRequiredError();

      return browserJson(200, await listClaimedPendingPublications({ principal }, publications));
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createPendingRoute(() => browserDependencies(process.env));
