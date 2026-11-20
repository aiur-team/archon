/**
 * `/api/hosted/publish-code` - the signed-in person's publish code (archon#253).
 *
 *  - `GET` reports whether an active code exists and when it expires. It never
 *    returns the code itself, which is shown exactly once, on mint.
 *  - `POST` mints a code, replacing any earlier one.
 *  - `DELETE` revokes the live code.
 *
 * Every method needs a browser session; the two mutations also need the exact
 * Origin and the CSRF header. The code itself is accepted by nothing here: its
 * only consumer is the start route, which turns it into one approved
 * publication owned by this account.
 */

import { SessionRequiredError } from "../lib/hosted/auth-errors.mjs";
import { identifyHosted, requireBrowserMutation } from "../lib/hosted/identity.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

const METHODS = Object.freeze(["GET", "POST", "DELETE"]);

export const config = {
  path: "/api/hosted/publish-code",
  /* Literal integers, like every other hosted rate rule: an invalid rule is
     dropped by the platform without failing the deploy. */
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};

export function createPublishCodeRoute(resolveDependencies) {
  return async function publishCodeRoute(request) {
    if (!METHODS.includes(request.method)) {
      return browserMethodRejection(request, METHODS.join(", "));
    }

    try {
      const { config: hostedConfig, store } = resolveDependencies();

      if (request.method === "GET") {
        const principal = await identifyHosted(request, { store });
        if (principal === null) throw new SessionRequiredError();
        const live = await store.readPublishCode(principal.accountId);
        return browserJson(200, { v: 1, active: live !== null, expiresAt: live?.expiresAt ?? null });
      }

      const { principal } = await requireBrowserMutation(request, { store, config: hostedConfig });
      if (request.method === "DELETE") {
        await store.revokePublishCode(principal.accountId);
        return browserJson(200, { v: 1, active: false, expiresAt: null });
      }
      const minted = await store.mintPublishCode(principal);
      return browserJson(201, { v: 1, code: minted.code, expiresAt: minted.expiresAt });
    } catch (error) {
      return browserError(error);
    }
  };
}

export default createPublishCodeRoute(() => browserDependencies(process.env));
