/**
 * The typed errors the hosted auth tree raises, and the one distinction that
 * matters to everything downstream of it.
 *
 * C1 says `identifyHosted` returns a principal or null, and that a backing-store
 * failure throws an unavailable error rather than returning null. That sentence
 * is the whole reason this module exists: "nobody is signed in" and "we could
 * not find out" are the same value in a naive implementation, and collapsing
 * them is a fail-open read - a storage outage would silently present every
 * visitor as signed out, and a later ticket's owner check would compare against
 * a principal that was never absent, only unknown.
 *
 * So the two answers have different types, and the unavailable one is a
 * subclass a consumer can test for by name rather than by string-matching a
 * message. AHU-007 and the private-read ticket both need that distinction to
 * decide between "show the sign-in page" and "show a retry".
 *
 * Every error here extends `HostedContractError`, so it already carries a C3
 * wire code, an HTTP status, a retryability and a `.toWire()` envelope, and a
 * handler can catch one type for the whole family.
 *
 * **Nothing in this module carries a cause.** A store or provider exception's
 * message can contain a URL with a token in it, a response body, or an
 * authorization code, and an error object gets logged, wrapped and serialised by
 * code that never reread this file. What is carried instead is `reason`: a fixed
 * word from a closed set, enough to tell a storage outage from a provider
 * outage in a log without any value from either crossing into it.
 */

import { HostedContractError } from "./contracts.mjs";

/** Where an unavailable answer came from. A closed set, and never free text. */
export const UNAVAILABLE_REASONS = Object.freeze(["storage", "provider"]);

/** Base class for every auth fault, so one `catch` clause covers the family. */
export class HostedAuthError extends HostedContractError {
  constructor(code, message) {
    super(code, message);
    this.name = "HostedAuthError";
  }
}

/**
 * The backing state could not be read or written.
 *
 * This is the error C1 requires instead of a null principal. It is deliberately
 * vague to the client - `unavailable`, retryable, "the service is temporarily
 * unavailable" - while `reason` keeps the internal distinction the failure-case
 * requirement asks for.
 */
export class AuthUnavailableError extends HostedAuthError {
  constructor(reason) {
    super("unavailable", "the service is temporarily unavailable");
    this.name = "AuthUnavailableError";
    if (!UNAVAILABLE_REASONS.includes(reason)) {
      throw new Error(`unknown unavailable reason: ${reason}`);
    }
    this.reason = reason;
  }
}

/** No usable browser session on a request that requires one. */
export class SessionRequiredError extends HostedAuthError {
  constructor(message = "sign in to continue") {
    super("session_required", message);
    this.name = "SessionRequiredError";
  }
}

/** The browser-only CSRF binding was absent, stale or wrong. */
export class CsrfFailedError extends HostedAuthError {
  constructor(message = "this request could not be verified") {
    super("csrf_failed", message);
    this.name = "CsrfFailedError";
  }
}

/** The request did not come from the one origin this deployment trusts. */
export class ForbiddenOriginError extends HostedAuthError {
  constructor(message = "this request did not come from the application") {
    super("forbidden", message);
    this.name = "ForbiddenOriginError";
  }
}

/**
 * The request was malformed, or the provider round trip could not be completed
 * for a reason the visitor can act on by starting again.
 *
 * One code covers "bad state", "bad PKCE", "denied consent" and "unexpected
 * scope" on purpose. Each is a distinct internal condition and each is logged as
 * one, but the visitor is told the same thing - the sign-in did not complete,
 * start again - because a message that distinguished them would tell an attacker
 * probing the callback which half of the transaction they had guessed right.
 */
export class AuthRequestError extends HostedAuthError {
  constructor(message = "the sign-in could not be completed") {
    super("invalid_request", message);
    this.name = "AuthRequestError";
  }
}

/** Whether an unknown thrown value is one of this tree's typed auth errors. */
export function isHostedAuthError(value) {
  return value instanceof HostedAuthError;
}
