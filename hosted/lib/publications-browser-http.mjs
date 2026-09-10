/**
 * The HTTP shell the three browser-facing publication routes share.
 *
 * `publications-http.mjs` is the agent shell and stays that way: its first rule
 * is that a request carrying `Cookie` or `Origin` is refused outright, which is
 * precisely inverted here. These three routes exist *for* a browser, and every
 * one of them is meaningless without the ambient credentials that module
 * rejects. Two shells with opposite entry rules is the honest arrangement; one
 * shell with a flag would be one edit away from an agent endpoint that accepts a
 * cookie.
 *
 * What is shared with the agent shell is deliberate and narrow: the C3 error
 * envelope and its status table, via `HostedContractError`. A handler here
 * throws exactly the same typed errors the adapter throws, so the browser and
 * the CLI are told the same thing about the same operation in the same shape.
 *
 * Three properties every response out of this module has:
 *
 *  1. **`Cache-Control: private, no-store`, plus `Vary: Cookie`.** Each of these
 *     bodies is scoped to one browser's session and one browser's pending
 *     binding, and two of the three also carry a `Set-Cookie`. A shared cache
 *     that retained either would hand one visitor's pending approval to the
 *     next. Netlify does not apply the static `netlify.toml` headers to function
 *     output, so a header not set here is not set at all.
 *  2. **No CORS grant, ever.** There is no `Access-Control-Allow-Origin` in this
 *     file and no route that emits one. Combined with the exact-`Origin` check
 *     on both mutations, that is what keeps these endpoints reachable only from
 *     the app's own pages.
 *  3. **An unexpected throw is a bounded 503.** Same reasoning as the agent
 *     shell: the messages worth reading are the ones carrying a key, a URL or a
 *     record.
 */

import { getStore } from "@netlify/blobs";

import { openAuthStore } from "./auth-store.mjs";
import { readHostedConfig } from "./config.mjs";
import { HostedContractError } from "./contracts.mjs";
import { publicationDependencies } from "./publications.mjs";

/** C3's private-response headers, plus the `Vary` a cookie-scoped body needs. */
export const BROWSER_RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/**
 * A JSON response carrying the browser header set and any `Set-Cookie` values.
 *
 * `cookies` is a list rather than a single value because a route may both clear
 * one cookie and set another in the same answer, and `Set-Cookie` is the one
 * header that must be repeated rather than joined.
 */
export function browserJson(status, body, { cookies = [] } = {}) {
  const headers = new Headers(BROWSER_RESPONSE_HEADERS);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The C3 error envelope for a thrown value, with whatever cookies the route had
 * already decided to send.
 *
 * The cookies ride along on failure on purpose. A decision route that revoked a
 * binding and then failed must still tell the browser the cookie is gone;
 * withholding it would leave a cookie whose record no longer exists, and the
 * visitor would be told they are mid-approval for as long as it survived.
 */
export function browserError(error, { cookies = [] } = {}) {
  const known =
    error instanceof HostedContractError
      ? error
      : new HostedContractError("unavailable", "publication service is unavailable");
  return browserJson(known.status, known.toWire(), { cookies });
}

/** Reject anything but `method`, advertising what this route does accept. */
export function browserMethodRejection(request, method) {
  if (request.method === method) return null;
  const known = new HostedContractError("invalid_request", `only ${method} is supported`, {
    field: "method",
  });
  const response = browserJson(405, known.toWire());
  response.headers.set("allow", method);
  return response;
}

/**
 * The publication id out of a `/api/hosted/publications/<id>/<verb>` path.
 *
 * Read off the URL rather than out of a framework parameter map, so a handler
 * depends on the `Request` and nothing else and a test can drive it with a plain
 * one. A malformed escape is the caller's 400 rather than an untyped `URIError`
 * that would be flattened into a *retryable* 503 and looped on forever.
 */
export function browserPublicationId(request, verb) {
  const { pathname } = new URL(request.url);
  const match = new RegExp(`^/api/hosted/publications/([^/]*)/${verb}/?$`).exec(pathname);
  if (match === null) {
    throw new HostedContractError("not_found", "unknown publication route", { field: "path" });
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HostedContractError("invalid_request", "publicationId is not a valid path segment", {
      field: "publicationId",
    });
  }
}

/**
 * A JSON request body, or a typed rejection.
 *
 * The media type is checked before the body is read, and only
 * `application/json` is accepted. That second part is load-bearing rather than
 * fussy: `application/x-www-form-urlencoded`, `multipart/form-data` and
 * `text/plain` are the three types a cross-origin `<form>` can send without a
 * preflight, so refusing them means a decision request that reached this handler
 * was made by `fetch` from a page the browser let read this origin - and the
 * exact-`Origin` check then says which page.
 */
export async function browserJsonBody(request) {
  const type = request.headers.get("content-type");
  if (type === null || !/^application\/json\s*(;|$)/i.test(type)) {
    throw new HostedContractError("unsupported_media_type", "body must be application/json", {
      field: "content-type",
    });
  }
  let text;
  try {
    text = await request.text();
  } catch {
    throw new HostedContractError("invalid_request", "request body could not be read", {
      field: "body",
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostedContractError("invalid_request", "request body must be JSON", { field: "body" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HostedContractError("invalid_request", "request body must be a JSON object", {
      field: "body",
    });
  }
  return parsed;
}

/**
 * The production dependency set for a browser publication route.
 *
 * Assembled per request inside the route's own `try`, never at module load: the
 * hosted module gate imports every file in this tree with no credential present
 * and no store to reach, and a deployment missing a C6 key must answer 503
 * rather than throw out of the function runtime.
 */
export function browserDependencies(env = process.env) {
  return Object.freeze({
    config: readHostedConfig(env),
    store: openAuthStore(),
    publications: publicationDependencies({ env, getStore }),
  });
}
