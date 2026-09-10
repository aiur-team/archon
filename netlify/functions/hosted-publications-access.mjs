/**
 * `GET|PUT /api/hosted/publications/<id>/access` - the document's domain list.
 *
 * One address, two verbs, one authorisation rule: the owner of a completed
 * publication, and nobody else. A reader who is admitted to the document by one
 * of these domains is refused here exactly as a stranger is, because reading the
 * policy is an owner's act - being on a list does not entitle you to enumerate
 * it.
 *
 * ## The two verbs are not two authorisations
 *
 * `GET` needs a session; `PUT` needs a session, an exact `Origin` and the
 * session-derived CSRF token, which is `requireBrowserMutation` and is the same
 * mechanism the approval decision route uses. There is deliberately no second
 * CSRF scheme here and no form-navigation affordance: this route is called by
 * `fetch` from the app's own pages, so the strictest of the three checks costs
 * nothing to keep.
 *
 * ## The `PUT` replaces, it does not merge
 *
 * The body carries the whole list and the stored list becomes exactly it, with
 * `[]` as the way to clear it. An add/remove API would need the client to know
 * what it was editing, and two tabs doing that against one document produce a
 * list neither of them asked for; replacing means the last writer's intent is a
 * list somebody actually looked at.
 *
 * ## What a refusal says
 *
 * `not_found` for a non-owner, an unknown id and a record that is not complete -
 * one answer, so this route is not an oracle for which publication ids exist.
 * `csrf_failed` for a missing or forged token. The three domain-list refusals
 * are distinct because the owner acts differently on each, and they name the
 * offending domain in the message: it is a value the owner just typed, and
 * "one of your domains is invalid" is not a message anybody can act on.
 */

import { SessionRequiredError } from "../lib/hosted/auth-errors.mjs";
import { HostedContractError } from "../lib/hosted/contracts.mjs";
import { identifyHosted, requireBrowserMutation } from "../lib/hosted/identity.mjs";
import { readPublicationAccess, replacePublicationAccess } from "../lib/hosted/publications.mjs";
import {
  browserDependencies,
  browserError,
  browserJson,
  browserJsonBody,
  browserPublicationId,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: "/api/hosted/publications/:publicationId/access" };

/** The allowed methods, advertised on the refusal. */
const ALLOW = "GET, PUT";

/**
 * The route, over injected dependencies.
 *
 * `resolveDependencies` is a thunk rather than a value for the reason every
 * hosted route uses one: reading operator configuration happens inside the
 * `try`, so a deployment missing a C6 key answers 503 with no detail instead of
 * throwing out of the function runtime at cold start.
 */
export function createAccessRoute(resolveDependencies) {
  return async function accessRoute(request) {
    if (request.method !== "GET" && request.method !== "PUT") {
      const refusal = new HostedContractError("invalid_request", `only ${ALLOW} are supported`, {
        field: "method",
      });
      const response = browserJson(405, refusal.toWire());
      response.headers.set("allow", ALLOW);
      return response;
    }

    try {
      const { config: hostedConfig, store, publications } = resolveDependencies();
      const publicationId = browserPublicationId(request, "access");

      if (request.method === "GET") {
        /* A read needs a session and nothing more. There is no `Origin` check
           here because there is nothing to forge: a cross-site `fetch` of this
           route cannot read the answer without a CORS grant this deployment
           never issues, and a check that refused the request would only turn a
           body nobody can read into a status nobody can read. */
        const principal = await identifyHosted(request, { store });
        if (principal === null) throw new SessionRequiredError("sign in to read this document");
        return browserJson(200, await readPublicationAccess({ publicationId, principal }, publications));
      }

      /* Origin, then session, then the session-derived token, in that order and
         before the body is read: spending a store read and a parse on a request
         already known to be cross-site is work done on behalf of an attacker. */
      const { principal } = await requireBrowserMutation(request, {
        store,
        config: hostedConfig,
      });
      const body = await browserJsonBody(request);
      requireRequestVersion(body);
      const answer = await replacePublicationAccess(
        { publicationId, principal, allowedDomains: body.allowedDomains },
        publications,
      );
      return browserJson(200, answer);
    } catch (error) {
      return browserError(error);
    }
  };
}

/**
 * The request envelope's version, checked before anything reads its payload.
 *
 * `v` is not decoration: a client that starts sending a different shape under
 * the same key is the situation the field exists to catch, and catching it as
 * "1 or refuse" is cheaper than discovering it as a list that means something
 * else. `allowedDomains` itself is left to `normalizeDomainList`, which is the
 * one place a caller's list becomes a stored list.
 */
function requireRequestVersion(body) {
  if (body.v !== 1) {
    throw new HostedContractError("invalid_request", "v must be 1", { field: "v" });
  }
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAccessRoute(() => browserDependencies(process.env));
