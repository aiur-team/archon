/**
 * `POST /api/hosted/publications/<id>/status` - poll an operation, or recover
 * its receipt.
 *
 * Always HTTP 200 on a state the bearer is allowed to see, whatever that state
 * is. Denial and cancellation are outcomes of asking a human, not transport
 * failures, and a client that saw them as 4xx would retry a decision that has
 * already been made.
 *
 * Receipt recovery deliberately does not consult `HOSTED_PUBLISH_ENABLED`: an
 * operator turning publishing off must not strand the receipt for a document
 * that was already published.
 */

import { getStore } from "@netlify/blobs";

import { publicationDependencies, statusPublication } from "../lib/publications.mjs";
import {
  agentSecretFrom,
  browserHeadersRejection,
  errorResponse,
  jsonResponse,
  methodRejection,
  publicationIdFrom,
} from "../lib/publications-http.mjs";

/**
 * The route's whole behaviour, with its dependency set resolved lazily.
 *
 * Split out from the default export so a test drives the real handler against an
 * injected store and clock rather than against a mock of it, and so that reading
 * operator configuration happens inside the `try` - a deploy missing a C6 key
 * answers 503 with no detail instead of throwing out of the function runtime.
 * The transport rejections come first, so a wrong method on a misconfigured
 * deploy is still reported as a wrong method.
 */
export async function handleStatus(request, resolveDependencies) {
  try {
    const wrongMethod = methodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;
    const browser = browserHeadersRejection(request);
    if (browser !== null) return browser;

    const envelope = await statusPublication(
      {
        publicationId: publicationIdFrom(request, "status"),
        agentSecret: agentSecretFrom(request),
      },
      resolveDependencies(),
    );
    return jsonResponse(200, envelope);
  } catch (error) {
    return errorResponse(error);
  }
}

/** The Netlify entry point: the same handler, wired to the real provider. */
export default (request) =>
  handleStatus(request, () => publicationDependencies({ env: process.env, getStore }));

export const config = {
  path: "/api/hosted/publications/:publicationId/status",
  /* C6: three times the start allowance, because this route is the one a
     waiting agent polls. C3 advertises a five-second interval, so a single
     well-behaved operation spends twelve requests a minute here; thirty leaves
     room for a retry and for a second operation from the same machine while
     still bounding a bearer-guessing loop. Like the start rule this is delayed
     best-effort mitigation and not an authorisation check -- `statusPublication`
     verifies the agent bearer on every request regardless, and receipt recovery
     stays available while publishing is disabled. See the start route for why
     the fields are literal integers. */
  rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
