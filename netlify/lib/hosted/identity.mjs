/**
 * Who a hosted request is, whether it may mutate anything, and the cookies that
 * carry both answers.
 *
 * This module is the C1 identity boundary. Everything downstream of AHU-003 -
 * the approval flow, the private document read - asks it two questions and is
 * meant to ask nothing else:
 *
 *   identifyHosted(request, {store})        -> principal | null, or *throws*
 *   requireBrowserMutation(request, {...})  -> {principal, sessionToken}, or throws
 *
 * ## The null that is not a null
 *
 * `identifyHosted` returns null for an absent, expired or revoked session and
 * throws `AuthUnavailableError` when the backing store could not be read. Those
 * must not be the same answer. A store outage that read as "signed out" would be
 * a fail-open at exactly the point where failing open matters most: a later
 * ticket's owner check would be comparing against an identity that was never
 * absent, only unknown, and the visible symptom would be a service that looks
 * like it is working.
 *
 * ## Why the CSRF token is derived rather than stored
 *
 * The browser CSRF token is `SHA-256("archon-hosted-csrf-v1:" + sessionToken)`,
 * base64url. It is never written to the store and never sent to the provider.
 * Three properties follow, and each of them is a bug avoided:
 *
 *  - It is bound to one session by construction. There is no second record that
 *    could drift out of step with the session it belongs to, and a token minted
 *    under one session cannot validate under another.
 *  - It dies exactly when the session dies. Revoking the session revokes the
 *    token, with no second revocation to forget.
 *  - It is one-way. A CSRF token that leaked - into a page, a template, an
 *    agent's output - does not yield the session cookie, because recovering the
 *    cookie from the digest means inverting SHA-256 over 256 bits of entropy.
 *
 * The reverse direction is what makes it safe to hand to JavaScript at all: the
 * session cookie stays `HttpOnly` and unreadable, and the page gets a value that
 * proves it was served by this origin to this session without being able to
 * become the session.
 *
 * ## Why every cookie here is `__Host-`
 *
 * `__Host-` is enforced by the browser rather than promised by the server: the
 * cookie is refused unless it is `Secure`, `Path=/`, and carries no `Domain`.
 * The `Domain` part is the one that matters. A cookie with a `Domain` attribute
 * is writable by every sibling subdomain, so any other host under the same
 * parent - including a stray preview deployment - could overwrite this
 * deployment's session or fix a visitor's OAuth state. The prefix makes that
 * unspellable rather than merely unspelled.
 */

import {
  AuthRequestError,
  CsrfFailedError,
  ForbiddenOriginError,
  SessionRequiredError,
} from "./auth-errors.mjs";
import { AuthStore, TRANSIENT_TTL_SECONDS } from "./auth-store.mjs";
import { HOSTED_LIMITS } from "./contracts.mjs";
import { constantTimeEqual, sha256Base64Url } from "./secrets.mjs";

/** C1: the browser session cookie. 24 hours, opaque, `HttpOnly`. */
export const SESSION_COOKIE = "__Host-archon_session";

/** The single-use OAuth-state binding. Distinct name, distinct lifetime. */
export const OAUTH_COOKIE = "__Host-archon_oauth";

/** The pre-login CSRF binding, issued before anybody is signed in. */
export const LOGIN_COOKIE = "__Host-archon_login";

/**
 * The pending publication binding AHU-007 consumes.
 *
 * Named separately from the other two because C1 requires it to *survive* what
 * destroys them: it is preserved through an account switch, and is cleared only
 * on a decision or at expiry. One cookie doing all three jobs would have to be
 * consumed on the first bootstrap request, which the contract forbids by name.
 */
export const BINDING_COOKIE = "__Host-archon_publish";

/** The header a browser presents its session-bound CSRF token in. */
export const CSRF_HEADER = "x-archon-csrf";

/**
 * C1 (v2)'s session lifetime, in seconds, for the cookie's own `Max-Age`.
 *
 * The cookie mirror of `SESSION_TTL_SECONDS` in `auth-store.mjs`: 24 hours. The
 * store is the authority - it refuses a record older than its own TTL even if
 * the cookie physically survives - but the two are one decision and must stay
 * equal, so the browser is not left holding a cookie the server will not honour.
 */
export const SESSION_COOKIE_MAX_AGE = 24 * 60 * 60;

/** Domain separation for the CSRF derivation, so the digest has one meaning. */
const CSRF_CONTEXT = "archon-hosted-csrf-v1:";

/**
 * The browser-only CSRF token for a session token.
 *
 * Callers pass the raw session token, which only ever exists inside a request
 * that presented the cookie. There is no way to derive a valid token from an
 * account ID, a login or a stored hash, which is what makes an agent-supplied
 * account hint useless here.
 */
export function deriveCsrfToken(sessionToken) {
  if (typeof sessionToken !== "string" || sessionToken === "") {
    throw new TypeError("deriveCsrfToken requires a session token");
  }
  return sha256Base64Url(`${CSRF_CONTEXT}${sessionToken}`);
}

/**
 * The cookies on a request, as a map.
 *
 * Written by hand rather than with a parser dependency because the grammar this
 * needs is tiny and the failure modes of a lenient one are not. Values are taken
 * verbatim - no URL decoding - so a `%2F` in a cookie stays a literal `%2F` and
 * cannot become a separator on the way to a comparison. A repeated name keeps
 * the *first* occurrence: an attacker who can inject a second cookie of the same
 * name should not be able to override the one the browser already had.
 */
export function parseCookies(header) {
  const cookies = new Map();
  if (typeof header !== "string" || header === "") return cookies;
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name === "" || cookies.has(name)) continue;
    cookies.set(name, part.slice(at + 1).trim());
  }
  return cookies;
}

/** One cookie value off a `Request`, or null. */
export function readCookie(request, name) {
  const value = parseCookies(request.headers.get("cookie")).get(name);
  return value === undefined || value === "" ? null : value;
}

/**
 * A `Set-Cookie` value with the hosted attribute set, and no way to weaken it.
 *
 * The attributes are not parameters. `Secure`, `HttpOnly`, `SameSite=Lax`,
 * `Path=/` and the absence of `Domain` are the contract, so the only thing a
 * caller chooses is the name, the value and the lifetime - and the name is
 * checked against the `__Host-` prefix that makes the browser enforce the rest.
 *
 * `SameSite=Lax` rather than `Strict` because the OAuth callback is a top-level
 * cross-site GET navigation back from GitHub, and `Strict` would withhold the
 * binding cookie on exactly that request. `Lax` still withholds every cookie
 * here from a cross-site POST, which is what the pre-login binding relies on.
 */
export function serializeCookie(name, value, { maxAgeSeconds }) {
  if (!name.startsWith("__Host-")) {
    throw new TypeError(`hosted cookies must carry the __Host- prefix: ${name}`);
  }
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new TypeError(`cookie ${name} may only carry base64url characters`);
  }
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TypeError(`cookie ${name} requires a whole-second Max-Age`);
  }
  return `${name}=${value}; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax; Path=/`;
}

/** The `Set-Cookie` that removes one of these cookies from the browser. */
export function clearCookie(name) {
  return serializeCookie(name, "", { maxAgeSeconds: 0 });
}

/**
 * The first path segments a collaboration slug may not be.
 *
 * A one-segment slug that spelled one of these would name a route the product
 * already owns - the sign-in page, the invitation page, the publish and hosted
 * document namespaces, the API, the onboarding page, or the two
 * underscore-prefixed asset trees - and
 * a sign-in that landed a visitor on one of those by way of the destination
 * grammar would be a redirect into machinery rather than into a document.
 * `_assets` and `_render` cannot match the slug shape at all - it forbids `_` -
 * but they are named here so the reserved set is the whole list a reader expects
 * rather than the subset the character class happens to leave reachable.
 *
 * `admin` is here for the same "whole list" reason. No document can claim it -
 * `RESERVED_ROUTES` in `templates/docbuild/src/site.ts` refuses it as a slug at
 * build time - so this entry is not what stops the collision; it stops a
 * *destination* `/admin/` from being accepted as a collaboration slug and landing
 * a signed-in visitor one character away from the console.
 */
export const RESERVED_FIRST_SEGMENTS = Object.freeze([
  "admin",
  "assets",
  "login",
  "invite",
  "publish",
  "docs",
  "api",
  "welcome",
  "_assets",
  "_render",
]);

/**
 * The admin console's address, as a destination.
 *
 * A literal here rather than an import of `admin.mjs`, which would pull the
 * document-page module and its templates into the identity boundary to obtain
 * one string. The two are held equal by a test instead, so they cannot drift
 * without something failing.
 */
const ADMIN_DESTINATION = "/admin";

/** A collaboration document slug: one segment of `[a-z0-9-]`, trailing slash. */
const COLLABORATION_SLUG = /^\/([a-z0-9-]{1,64})\/$/;

/**
 * The internal destinations a callback may return a browser to.
 *
 * An allowlist of five exact shapes, matched against the raw string with no
 * decoding, no normalisation and no `new URL` anywhere near it. That is what
 * makes the whole family of redirect-injection spellings uninteresting rather
 * than individually defended: `//evil.example`, `/\evil.example`,
 * `https://evil.example`, `/docs/%2e%2e/admin`, `/publish/authorize?next=...`
 * and a backslash-separated variant all fail to be one of the five.
 *
 * The five shapes are `/publish/authorize`, `/welcome`, `/admin`,
 * `/docs/<32 hex>`, and a single collaboration document slug
 * `^/[a-z0-9-]{1,64}/$` whose one segment is not a reserved route name.
 * `/welcome` is the ordinary sign-in's default and, like the other two exact
 * paths, is matched with no trailing slash, so it cannot be reached through the
 * slug shape either: `welcome` is a reserved first segment, and `/welcome/` is
 * refused rather than quietly treated as a document named "welcome".
 *
 * The slug is matched on the raw string too: a `%2e%2e`, a
 * second segment, an absent trailing slash, or an uppercase letter all fail the
 * one pattern rather than being decoded into something that then has to be
 * defended. The legacy root login's `safeNext`, which accepted any same-site
 * path, is still not reused: a callback lands in exactly these places.
 */
export function validateDestination(value) {
  if (typeof value !== "string") throw new AuthRequestError("unknown destination");
  if (value === HOSTED_LIMITS.AUTHORIZE_PATH) return value;
  /* The onboarding page an ordinary sign-in defaults to. */
  if (value === HOSTED_LIMITS.WELCOME_PATH) return value;
  /* The admin console. An exact string like the authorize path, and an internal
     absolute path with nothing caller-controlled in it, so it widens the
     allowlist by exactly one destination and by no shape. */
  if (value === ADMIN_DESTINATION) return value;
  if (new RegExp(`^${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}[0-9a-f]{${HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH}}$`).test(value)) {
    return value;
  }
  const slug = COLLABORATION_SLUG.exec(value);
  if (slug !== null && !RESERVED_FIRST_SEGMENTS.includes(slug[1])) return value;
  throw new AuthRequestError("unknown destination");
}

/**
 * The principal behind a request, or null when nobody is signed in.
 *
 * @throws {AuthUnavailableError} when the backing store could not be read. This
 *   is the contract: a storage outage is never spelled as a signed-out visitor.
 */
export async function identifyHosted(request, { store }) {
  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) return null;
  const session = await store.readSession(token);
  return session === null ? null : session.principal;
}

/**
 * The exact configured origin, or a refusal.
 *
 * Exact string equality against `config.appOrigin` - not a suffix, not a
 * hostname, not a regular expression. A missing `Origin` header is a refusal
 * rather than a pass: treating absence as "no evidence against" is how an origin
 * check becomes decorative.
 *
 * ## The one exemption, why it exists, and why it is opt-in
 *
 * A real `<form method="post">` submission is a *navigation*, and Fetch's
 * "append a request `Origin` header" step reads the document's referrer policy
 * for a non-CORS request: under `no-referrer` it appends the literal string
 * `null` instead of the origin. C3 requires `Referrer-Policy: no-referrer` on
 * every hosted response, so **every** form POST in this deployment arrives with
 * `Origin: null` - the sign-in form and the different-account form both. An
 * exact-origin check with no exemption does not merely reject an attacker here;
 * it rejects the only sign-in path the product has, in every browser. This was
 * observed rather than reasoned about: `netlify/test/hosted/approval-browser.test.mjs` drives
 * Chromium against these handlers and the start route answered
 * `/login/?status=expired` on every attempt.
 *
 * Fetch Metadata is the browser's other statement of the same fact, and it is a
 * better one. `Sec-Fetch-Site` is a forbidden header name, so page script cannot
 * set it, and a cross-site form POST arrives as `cross-site` rather than
 * `same-origin` - which is exactly the class the `Origin` check exists to
 * refuse. A sandboxed frame's opaque origin also reports `cross-site`, and so
 * does a request that reached here through a cross-origin redirect.
 *
 * `Sec-Fetch-Mode: navigate` narrows it to a document navigation. That is not a
 * restatement of the `Origin` argument: `fetch` with `mode: "no-cors"` is the
 * *other* request class that gets `Origin: null` under `no-referrer`, and the
 * mode requirement is the only thing that excludes it. A same-origin `fetch`
 * defaults to `mode: "cors"` and appends a real `Origin`, so nothing on the
 * approval page needs the exemption.
 *
 * And it is **off unless a caller asks for it**. Only the two sign-in forms
 * submit by navigation; `publications-bind`, `publications-decision` and
 * `auth-logout` are all `fetch` callers and are held to the exact origin with no
 * escape. Widening the shared check for everyone would have handed the exemption
 * to routes that provably never need it, which is a larger change than the
 * problem.
 *
 * It stays fail-closed. A browser too old to send Fetch Metadata sends neither
 * header and is refused, and so is any request that merely omits `Origin`.
 *
 * @param {{formNavigation?: boolean}} [options] set `formNavigation` only on a
 *   route a real `<form method="post">` submits to.
 */
export function requireExactOrigin(request, config, { formNavigation = false } = {}) {
  const origin = request.headers.get("origin");
  if (origin === config.appOrigin) return origin;

  if (
    formNavigation &&
    origin === "null" &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate"
  ) {
    return config.appOrigin;
  }

  throw new ForbiddenOriginError();
}

/**
 * Establish that a request is a genuine, signed-in browser mutation.
 *
 * Three checks in a fixed order, and the order is the useful part: origin first,
 * because it is free and rejects the whole cross-site class before any store
 * read; then the session, because a CSRF check without one is meaningless; then
 * the token, compared in constant time.
 *
 * The presented token defaults to the `X-Archon-Csrf` header and can be passed
 * explicitly by a handler that parsed it out of a form body instead.
 *
 * @returns {Promise<Readonly<{principal: object, sessionToken: string}>>}
 */
export async function requireBrowserMutation(
  request,
  { store, config, presentedCsrf = null, formNavigation = false },
) {
  requireExactOrigin(request, config, { formNavigation });

  const token = readCookie(request, SESSION_COOKIE);
  if (token === null) throw new SessionRequiredError();
  const session = await store.readSession(token);
  if (session === null) throw new SessionRequiredError();

  const presented = presentedCsrf ?? request.headers.get(CSRF_HEADER);
  if (!constantTimeEqual(deriveCsrfToken(token), presented ?? "")) throw new CsrfFailedError();

  return Object.freeze({ principal: session.principal, sessionToken: token });
}

/* ------------------------------------------------------------------ */
/* the pending publication binding, for AHU-007                        */
/* ------------------------------------------------------------------ */

/**
 * The bounds on a pending operation.
 *
 * The operation is *opaque here*. AHU-003 validates that it is a bounded
 * base64url string, binds it to this browser and hands it back unchanged; it
 * never parses it, never reads an owner out of it and never changes one. That
 * is the seam: this ticket owns transport binding, AHU-007 owns what the
 * operation means.
 */
const OPERATION_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${HOSTED_LIMITS.OPAQUE_TOKEN_MIN_LENGTH},${HOSTED_LIMITS.OPAQUE_TOKEN_MAX_LENGTH}}$`,
);

/**
 * Bind an opaque pending operation to this browser.
 *
 * The operation is stored server-side and the browser receives only a cookie
 * whose value is a fresh random token. The operation therefore never travels in
 * a URL, a referrer or a history entry, and a browser that presents the cookie
 * proves it is the one the binding was issued to without carrying the binding's
 * contents around.
 *
 * @param {AuthStore} store
 * @param {{operation: string}} params opaque, 32-256 base64url characters.
 * @returns {Promise<Readonly<{setCookie: string, expiresAt: string}>>}
 */
export async function createPendingBinding(store, { operation }) {
  if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) {
    throw new AuthRequestError("the pending operation is not a bound operation token");
  }
  const { token, expiresAt } = await store.createTransient("binding", { operation });
  return Object.freeze({
    setCookie: serializeCookie(BINDING_COOKIE, token, { maxAgeSeconds: TRANSIENT_TTL_SECONDS }),
    expiresAt,
  });
}

/**
 * The pending operation bound to this browser, or null.
 *
 * Reading does not consume. C1 requires the binding to survive an account
 * switch - a visitor who realises they are signed in as the wrong account must
 * be able to switch and still land on the same pending approval - so a read that
 * destroyed it would break the one flow it exists for.
 *
 * @returns {Promise<Readonly<{operation: string, expiresAt: string}> | null>}
 */
export async function readPendingBinding(store, request) {
  const token = readCookie(request, BINDING_COOKIE);
  if (token === null) return null;
  const record = await store.readTransient("binding", token);
  if (record === null) return null;
  const operation = record.payload?.operation;
  if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) return null;
  return Object.freeze({ operation, expiresAt: record.expiresAt });
}

/**
 * Revoke the pending binding server-side and clear its cookie.
 *
 * Both halves, always. Clearing the cookie alone would leave a live record a
 * copied cookie could still present, which is the same mistake as a logout that
 * only clears the browser.
 *
 * @returns {Promise<Readonly<{cleared: boolean, setCookie: string}>>}
 */
export async function clearPendingBinding(store, request) {
  const token = readCookie(request, BINDING_COOKIE);
  const cleared = token === null ? false : await store.revokeTransient("binding", token);
  return Object.freeze({ cleared, setCookie: clearCookie(BINDING_COOKIE) });
}

/** Re-exported so a consumer needs one import for the adapter and its boundary. */
export { AuthStore };
