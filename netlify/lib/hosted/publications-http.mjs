/**
 * The HTTP shell the three agent endpoints share: method, headers, bearer,
 * body, and turning a thrown contract error into a C3 envelope.
 *
 * The handlers themselves are meant to be boring, and this module is what keeps
 * them that way. None of them writes storage, none of them opens a store, and
 * none of them re-decides anything `publications.mjs` decided - a handler that
 * did would be a second state machine with a slightly different opinion about
 * who owns a document.
 *
 * Three rules do most of the work here:
 *
 *  1. **An agent endpoint refuses a browser.** A request carrying `Cookie` or
 *     `Origin` is rejected before anything else happens, including before the
 *     bearer is read. These routes authenticate a capability the CLI holds; a
 *     cookie on one of them means a browser was persuaded to make the request,
 *     and ambient credentials plus a capability is the confused-deputy shape the
 *     two-origin split exists to prevent. There is no CORS grant anywhere in the
 *     hosted API, so a legitimate browser has no reason to reach one either.
 *  2. **Every response carries the private-response headers.** Netlify does not
 *     apply `netlify.toml` headers to function output, so a header that is not
 *     set here is not set at all - on the success path and on the error path
 *     alike. An error carrying a capability-bearing URL into a shared cache is
 *     as bad as a success doing it.
 *  3. **An unexpected throw is a bounded 503, never a stack.** Anything that is
 *     not a `HostedContractError` is a fault this code did not anticipate, and
 *     the safe thing to say about it is that the service is unavailable. Its
 *     message never reaches the client, because the messages that would be
 *     worth reading are exactly the ones carrying a key, a URL or a record.
 */

import { HostedContractError } from "./contracts.mjs";

/**
 * The headers C3 puts on every auth, operation, error and private response.
 *
 * `frame-ancestors` is absent deliberately: it belongs on the app's HTML
 * surfaces, and these routes return JSON that no browser frames.
 */
export const PRIVATE_RESPONSE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** A JSON response with the private headers and nothing else on it. */
export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PRIVATE_RESPONSE_HEADERS, ...extraHeaders },
  });
}

/**
 * The C3 error envelope for a thrown error, with its documented status.
 *
 * A `HostedContractError` has already sanitised and bounded its own message, so
 * it is safe to return; anything else is replaced wholesale rather than
 * inspected, because deciding case by case which unexpected error is safe to
 * echo is a decision that gets made wrongly once.
 */
export function errorResponse(error) {
  const known =
    error instanceof HostedContractError
      ? error
      : new HostedContractError("unavailable", "publication service is unavailable");
  return jsonResponse(known.status, known.toWire());
}

/**
 * Reject a request that arrived with browser ambient authority.
 *
 * Returns a `Response` to send, or `null` when the request is acceptable.
 */
export function browserHeadersRejection(request) {
  for (const header of ["cookie", "origin"]) {
    if (request.headers.get(header) !== null) {
      return errorResponse(
        new HostedContractError(
          "forbidden",
          "agent endpoints do not accept browser credentials",
          { field: header },
        ),
      );
    }
  }
  return null;
}

/**
 * Reject anything but `method`, advertising what is allowed.
 *
 * 405 is the one status here that C3's code table does not name, because C3
 * enumerates the statuses its *error codes* map to and never contemplates a
 * wrong method. The envelope is still exactly C3's, with `invalid_request` in
 * it; only the transport status says the more accurate thing, and it carries the
 * `Allow` header that makes 405 meaningful rather than merely different.
 */
export function methodRejection(request, method) {
  if (request.method === method) return null;
  const known = new HostedContractError("invalid_request", `only ${method} is supported`, {
    field: "method",
  });
  return jsonResponse(405, known.toWire(), { Allow: method });
}

/**
 * The agent bearer from an `Authorization` header.
 *
 * Exactly one scheme is accepted, spelled exactly one way apart from the case
 * of `Bearer` itself, and the token is never trimmed or unquoted: a token that
 * needed repairing to match is not the token that was issued.
 */
export function agentSecretFrom(request) {
  const header = request.headers.get("authorization");
  if (header === null) {
    throw new HostedContractError("invalid_capability", "an agent bearer is required", {
      field: "authorization",
    });
  }
  const match = /^Bearer (\S+)$/i.exec(header);
  if (match === null) {
    throw new HostedContractError("invalid_capability", "authorization must be a bearer token", {
      field: "authorization",
    });
  }
  return match[1];
}

/**
 * The publication id from a `/api/hosted/publications/<id>/<verb>` path.
 *
 * Read off the URL rather than out of a framework-provided parameter map, so
 * the handlers depend on the request and nothing else and a test can drive them
 * with a plain `Request`. The id is validated by the adapter it is handed to;
 * this only has to find it.
 */
export function publicationIdFrom(request, verb) {
  const { pathname } = new URL(request.url);
  const match = new RegExp(`^/api/hosted/publications/([^/]*)/${verb}/?$`).exec(pathname);
  if (match === null) {
    throw new HostedContractError("not_found", "unknown publication route", { field: "path" });
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    /* `decodeURIComponent` throws `URIError` on a malformed escape such as
       `%zz`, and a `URIError` is not a `HostedContractError` - so without this
       it would be replaced wholesale by `errorResponse` with a *retryable* 503,
       and a conforming client would loop forever on a request that can never
       succeed. A malformed id is the caller's mistake, and it is a 400. */
    throw new HostedContractError("invalid_request", "publicationId is not a valid path segment", {
      field: "publicationId",
    });
  }
}

/**
 * The JSON body of a request, or a typed rejection.
 *
 * The media type is checked before the body is read: `unsupported_media_type` is
 * a cheaper and more accurate answer than a parse failure, and a body that was
 * never JSON should not be spent being parsed.
 */
export async function jsonBody(request) {
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
  try {
    return JSON.parse(text);
  } catch {
    throw new HostedContractError("invalid_request", "request body must be JSON", { field: "body" });
  }
}
