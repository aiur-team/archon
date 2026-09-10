/**
 * `POST /api/hosted/publications/<id>/cancel` - stop an operation the agent no
 * longer wants.
 *
 * Cancellation is a state rather than a deletion, so the response is the same
 * status envelope the poll route returns. A completed publication comes back
 * complete, with its unchanged receipt: the document exists, and an agent
 * cancelling after the fact has lost a race that C2 says completion wins.
 */

import { getStore } from "@netlify/blobs";

import { cancelPublication, publicationDependencies } from "../lib/publications.mjs";
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
export async function handleCancel(request, resolveDependencies) {
  try {
    const wrongMethod = methodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;
    const browser = browserHeadersRejection(request);
    if (browser !== null) return browser;

    const envelope = await cancelPublication(
      {
        publicationId: publicationIdFrom(request, "cancel"),
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
  handleCancel(request, () => publicationDependencies({ env: process.env, getStore }));

export const config = { path: "/api/hosted/publications/:publicationId/cancel" };
