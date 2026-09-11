/**
 * The response shapes every hosted auth route uses, and the one place its
 * production dependencies are assembled.
 *
 * Netlify does not apply the static `netlify.toml` headers to a function's
 * response, so a hosted function that does not set its own security headers
 * serves them nowhere. Every helper here sets the full set on every path -
 * success, redirect and error alike - because the error path is the one a
 * hand-written `new Response` gets wrong, and it is also the path an attacker
 * has the easiest time reaching.
 *
 * `Cache-Control: private, no-store` is the load-bearing one. Every response
 * from these routes is either a session-scoped answer or a `Set-Cookie`, and a
 * shared cache that retained either would hand one visitor's session to the
 * next. `Vary: Cookie` says the same thing again for a cache that honours only
 * one of the two.
 */

import { getStore } from "@netlify/blobs";

import { HostedContractError } from "./contracts.mjs";
import { readHostedConfig } from "./config.mjs";
import { openAuthStore } from "./auth-store.mjs";
import { createAllowlistStore } from "./allowlist.mjs";
import { createSignupAttemptsStore } from "./signup-attempts.mjs";

/** Applied to every response this tree emits. */
export const SECURITY_HEADERS = Object.freeze({
  "cache-control": "private, no-store",
  vary: "Cookie",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

/** A `Headers` carrying the security set plus any `Set-Cookie` values. */
function baseHeaders(cookies) {
  const headers = new Headers(SECURITY_HEADERS);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return headers;
}

/** A JSON body with the hosted header set. */
export function jsonResponse(body, { status = 200, cookies = [] } = {}) {
  const headers = baseHeaders(cookies);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A redirect with the hosted header set.
 *
 * 303 by default: the routes that redirect after a mutation are POSTs, and 303
 * is the status that tells the browser to follow with a GET rather than
 * replaying the POST at the new location.
 */
export function redirectResponse(location, { status = 303, cookies = [] } = {}) {
  const headers = baseHeaders(cookies);
  headers.set("location", location);
  return new Response(null, { status, headers });
}

/**
 * The C3 wire envelope for a thrown value.
 *
 * A typed contract error becomes its own code and status. Anything else becomes
 * a bare `unavailable`, with the thrown value's message deliberately discarded:
 * an unexpected exception's message is the least controlled string in the
 * process and can carry a URL, a body or a token, and this is the one function
 * that decides what an unauthenticated caller is allowed to read.
 */
export function errorResponse(error, { cookies = [] } = {}) {
  if (error instanceof HostedContractError) {
    return jsonResponse(error.toWire(), { status: error.status, cookies });
  }
  const generic = new HostedContractError("unavailable", "the service is temporarily unavailable");
  return jsonResponse(generic.toWire(), { status: generic.status, cookies });
}

/** The refusal for a method a route does not implement, naming what it does. */
export function methodNotAllowed(allow) {
  const error = new HostedContractError("invalid_request", `this route accepts ${allow} only`);
  const response = jsonResponse(error.toWire(), { status: 405 });
  response.headers.set("allow", allow);
  return response;
}

/**
 * Wrap a route in its production dependencies and its error boundary.
 *
 * `build` receives `{config, store, allowlist}` and returns the actual handler. It is a
 * factory rather than a module-level constant so that nothing is read from the
 * environment and no store is opened while the module is merely being *loaded* -
 * which is what `scripts/check-function-modules.mjs` does to every file in this
 * tree, with no credential present and no store to reach.
 *
 * Configuration is read per request and a `HostedConfigError` becomes a 503
 * before the route runs. That is the "reject invalid configuration before
 * serving auth mutations" rule: a deployment missing its client secret refuses
 * every auth request rather than reaching the provider with a partial
 * credential, and the refusal names nothing, because the fault carries an
 * environment variable name and an operator's log is not an anonymous caller's
 * business.
 */
export function serve(build) {
  return withErrorBoundary(async (request) => {
    /* Read per request, and inside the boundary, so a deployment missing its
       client secret answers every auth request with a 503 instead of reaching
       the provider with a partial credential. The refusal names nothing: the
       fault carries an environment variable name, and an operator's log is not
       an anonymous caller's business. */
    const deps = {
      config: readHostedConfig(process.env),
      store: openAuthStore(),
      /* The platform allowlist, for the one auth route that consults it. It is
         assembled for every route rather than only the callback because
         constructing it contacts nothing - the provider handle is opened on
         first use - so a route that never reads it pays nothing for holding it,
         and the alternative is a second `serve` with one extra dependency. */
      allowlist: createAllowlistStore({ getStore }),
      /* The turned-away sign-in audit, for the one auth route that appends to it.
         Assembled for every route for the same reason the allowlist is:
         constructing it opens no store, so a route that never records an attempt
         pays nothing for holding it. */
      signupAttempts: createSignupAttemptsStore({ getStore }),
    };
    return build(deps)(request);
  });
}

/**
 * The error boundary every hosted route runs inside.
 *
 * Exported separately from `serve` so a test can put a route behind exactly the
 * production boundary while supplying its own dependencies. That is a narrow
 * injected dependency rather than a bypass: there is no environment value that
 * selects it, and the code path being exercised is the same one that runs in
 * production - only the store and the configuration differ.
 */
export function withErrorBoundary(handler) {
  return async function boundary(request) {
    try {
      return await handler(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}
