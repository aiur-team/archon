/**
 * `POST /api/hosted/publications` - start a publication.
 *
 * The only unauthenticated route in the hosted API, and the reason it can be is
 * that it *mints* the capability rather than checking one: there is nothing to
 * authenticate yet, and the response is the only thing that can act on the
 * record it creates. It still refuses a browser's ambient credentials, because a
 * cookie here means something other than the CLI is asking.
 *
 * Everything this handler decides is transport. The descriptor is validated,
 * publishing-enabled is checked and the record is written by
 * `publications.mjs`, so there is no path by which changing this file changes
 * what gets stored.
 */

import { getStore } from "@netlify/blobs";

import { createPublication, publicationDependencies } from "../lib/publications.mjs";
import {
  browserHeadersRejection,
  errorResponse,
  jsonBody,
  jsonResponse,
  methodRejection,
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
export async function handleStart(request, resolveDependencies) {
  try {
    const wrongMethod = methodRejection(request, "POST");
    if (wrongMethod !== null) return wrongMethod;
    const browser = browserHeadersRejection(request);
    if (browser !== null) return browser;

    const descriptor = await jsonBody(request);
    const started = await createPublication(descriptor, resolveDependencies());
    return jsonResponse(201, started);
  } catch (error) {
    return errorResponse(error);
  }
}

/** The Netlify entry point: the same handler, wired to the real provider. */
export default (request) =>
  handleStart(request, () => publicationDependencies({ env: process.env, getStore }));

export const config = { path: "/api/hosted/publications" };
