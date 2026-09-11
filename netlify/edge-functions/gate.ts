import { normalizeEmailOrNull } from "../lib/hosted/email.mjs";
import {
  capabilitiesFor,
  resolveRole,
  validateAccessRow,
} from "../lib/access.mjs";
import {
  applicationOrigin,
  authorizationOrigin,
  classifyHost,
  isApplicationPassThrough,
  isApplicationPublic,
  isLandingPage,
  isPublicDocument,
  isRenderPrefix,
  notFoundForeignHost,
  notFoundRenderer,
  rendererHeaders,
  rendererRewriteTarget,
  withApplicationHeaders,
  withDocumentHeaders,
  withFirstPartyPageHeaders,
  withLandingPageHeaders,
} from "../lib/edge-host.mjs";

type GateContext = {
  next(request?: Request): Promise<Response>;
  rewrite(url: string | URL): Promise<Response>;
};

/**
 * The origin keys the gate reads: two to classify a request host, and the
 * identity provider's domain, which a sign-in page must name in `form-action`
 * because the submission redirects to the provider.
 */
const HOST_ENV_KEYS = ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN", "AUTH0_DOMAIN"] as const;

const PLAIN_TEXT = "text/plain; charset=utf-8";
const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_META_LINE_BYTES = 96;

const AUTH_UNAVAILABLE = "Authentication is temporarily unavailable.";
const ACCESS_UNAVAILABLE = "Document access is temporarily unavailable.";
const UNVERIFIED = "Document access could not be verified.";
const DENIED = "You do not have access to this document.";

const IDENTITY_KEYS = ["sub", "email", "emailVerified", "name"];

/** The route the gate asks who a request is. Outside the gate's own gated set. */
const SESSION_ROUTE = "/api/hosted/session";

/**
 * The session cookie's name, restated for one question: is there anything to ask
 * about? It is `netlify/lib/hosted/identity.mjs`'s `SESSION_COOKIE`, copied
 * rather than imported because that module reaches a store and this is an edge
 * function. The name is a constant of the deployment, and a wrong copy fails in
 * the safe direction -- every visitor is asked about, which is the old behaviour.
 */
const SESSION_COOKIE = "__Host-archon_session";

/**
 * The sign-in destination grammar ACN-005 froze, restated here for the one
 * question this file asks of it: is the path we are about to refuse one the
 * sign-in page is allowed to send a visitor back to?
 *
 * It is a copy rather than an import because `netlify/lib/hosted/identity.mjs`
 * *throws* on a rejected destination and reaches a store on the way to the rest
 * of its surface, and this is an edge function that must answer with a plain
 * redirect and no store at all. The authority is still that module: it
 * validates the value again when the callback returns, and a value this pattern
 * admitted but that one refuses is a sign-in that fails closed rather than a
 * redirect that goes somewhere unintended.
 */
const COLLABORATION_SLUG = /^\/([a-z0-9-]{1,64})\/$/;
const RESERVED_FIRST_SEGMENTS = [
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
];
const CONTENT_TYPE_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const CONTENT_TYPE_QUOTED = '"(?:[\\t !#-\\[\\]-~]|\\\\[\\t !-~])*"';
const CONTENT_TYPE_PARAMETER = `;[\\t ]*${CONTENT_TYPE_TOKEN}[\\t ]*=[\\t ]*(?:${CONTENT_TYPE_TOKEN}|${CONTENT_TYPE_QUOTED})[\\t ]*`;
const HTML_CONTENT_TYPE = new RegExp(
  `^[\\t ]*text/html[\\t ]*(?:${CONTENT_TYPE_PARAMETER})*$`,
  "i",
);

function plainResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": PLAIN_TEXT, ...NO_STORE },
  });
}

function exactMutableRecord(
  value: unknown,
  keys: readonly string[],
): null | Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key, index) => typeof key !== "string" || key !== keys[index],
      )
    )
      return null;

    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !descriptor.writable ||
        !descriptor.configurable
      )
        return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function validIdentity(
  value: unknown,
): value is {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
} {
  const record = exactMutableRecord(value, IDENTITY_KEYS);
  return (
    record !== null &&
    typeof record.sub === "string" &&
    typeof record.email === "string" &&
    typeof record.emailVerified === "boolean" &&
    typeof record.name === "string"
  );
}

function validContentType(value: string | null): boolean {
  return value !== null && HTML_CONTENT_TYPE.test(value);
}

/**
 * Finalize the security headers on a static pass-through response.
 *
 * A first-party static HTML page the application host serves directly — the
 * sign-in page under `/login/`, the approval page under `/publish/`, any
 * `text/html` file the deploy publishes — is a trusted document, not an API
 * answer. The application header set's CSP is `default-src 'none'` with no
 * `script-src`, `style-src`, `connect-src` or `form-action`, which freezes such
 * a page: its scripts, inline styles, fetches and form posts all fall back to
 * `'none'`. So a static `text/html` response that carries no CSP of its own
 * gains the first-party page set instead; everything else — the API's JSON, a
 * built asset — keeps the application set, and a response that already owns a
 * CSP keeps it under either applier.
 *
 * This is a header choice only. It reads the pass-through response's
 * `Content-Type` and applies one of two header sets; it changes no routing,
 * no redirect and no session decision, and a `Content-Type` that cannot be
 * read falls to the strict application set.
 */
function finalizePassThrough(response: Response, authOrigin: string | null): Response {
  let isHtml = false;
  try {
    const headers = response.headers;
    if (headers instanceof Headers && !headers.has("Content-Security-Policy")) {
      isHtml = validContentType(headers.get("Content-Type"));
    }
  } catch {
    isHtml = false;
  }
  return isHtml
    ? withFirstPartyPageHeaders(response, authOrigin)
    : withApplicationHeaders(response);
}

/**
 * Finalize a public reference document.
 *
 * It takes the document header set -- the same one a granted reader's copy gets
 * (`withDocumentHeaders` on the gated answer below) -- so publishing a document
 * changes the session check and nothing else about the answer.
 *
 * Any `Set-Cookie` is dropped first. Nothing that answers one of these routes
 * has a session to establish: they are static files the build composed, and the
 * route is on a closed list a build preflight holds equal to the documents that
 * declared themselves public. But this is the one branch whose answer is
 * returned to a caller the gate never identified, so a cookie set here would be
 * handed to whoever asked and, under the site's shared-cache headers, possibly
 * to the next asker too. Dropping it costs nothing today and removes the whole
 * class.
 */
function publicDocumentResponse(response: Response): Response {
  try {
    const headers = response.headers;
    if (headers instanceof Headers) headers.delete("Set-Cookie");
  } catch {
    /* A response whose headers cannot be read cannot be carrying a cookie we
       could drop either; the header applier below fails the same way safely. */
  }
  return withDocumentHeaders(response);
}

function isUnavailableError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  try {
    const name = Object.getOwnPropertyDescriptor(value, "name");
    const code = Object.getOwnPropertyDescriptor(value, "code");
    const status = Object.getOwnPropertyDescriptor(value, "status");
    return (
      name !== undefined &&
      "value" in name &&
      name.value === "StoreError" &&
      code !== undefined &&
      "value" in code &&
      code.value === "unavailable" &&
      status !== undefined &&
      "value" in status &&
      status.value === 503
    );
  } catch {
    return false;
  }
}

async function cancelAndRelease(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cleanup failure must not change the authorization response.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The authorization response remains fail closed if cleanup is inaccessible.
    }
  }
}

async function cancelBody(
  body: ReadableStream<Uint8Array> | null | undefined,
): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // Synthetic HEAD cleanup is best effort and cannot change the response.
  }
}

function replayResponse(
  status: number,
  statusText: string,
  downstreamHeaders: Headers,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  retained: Uint8Array[],
): Response {
  let terminal = false;
  const release = () => {
    if (terminal) return false;
    terminal = true;
    try {
      reader.releaseLock();
    } catch {
      // A terminal stream path cannot be replaced with another response.
    }
    return true;
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of retained) controller.enqueue(chunk);
      retained.length = 0;
    },
    async pull(controller) {
      if (terminal) return;
      try {
        const next = await reader.read();
        if (next.done) {
          if (release()) controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array))
          throw new TypeError("Invalid response stream chunk");
        controller.enqueue(next.value);
      } catch (error) {
        if (release()) controller.error(error);
      }
    },
    async cancel(reason) {
      if (terminal) return;
      try {
        await reader.cancel(reason);
      } catch {
        // Consumer cancellation still settles if upstream cancellation rejects.
      } finally {
        release();
      }
    },
  });

  const headers = new Headers(downstreamHeaders);
  headers.delete("Content-Length");
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  return new Response(body, {
    status,
    statusText,
    headers,
  });
}

/**
 * Read the two host-classification origins through the runtime-native narrow
 * environment API on Deno, falling back to `process.env` where the gate runs
 * transpiled on Node for its test harness.
 */
function readHostEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const netlify = (globalThis as { Netlify?: { env?: { get?(key: string): string | undefined } } }).Netlify;
  const runtime = netlify?.env;
  const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  for (const key of HOST_ENV_KEYS) {
    try {
      if (runtime !== undefined && runtime !== null && typeof runtime.get === "function") {
        env[key] = runtime.get(key);
        continue;
      }
    } catch {
      // A runtime that throws on read is treated as an unset value below.
    }
    try {
      env[key] = node?.env?.[key];
    } catch {
      env[key] = undefined;
    }
  }
  return env;
}

/**
 * The renderer host serves exactly the four shell files under an internal
 * rewrite and refuses everything else. It never resolves a session, never
 * resolves a role, never emits `Set-Cookie` and never emits a body on a
 * refusal, so an artifact-rendering origin holds no identity authority.
 */
async function renderHost(
  url: URL,
  context: GateContext,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const target = rendererRewriteTarget(url.pathname, url.search);
  if (target === null) return notFoundRenderer();
  const appOrigin = applicationOrigin(env);
  /* Without a header-safe application origin there is no `frame-ancestors` to
     name, and serving the shell headerless would leave it framable by anyone.
     Refuse rather than serve a shell the renderer would then refuse to mount. */
  if (appOrigin === null) return notFoundRenderer();

  let response: Response;
  try {
    response = await context.rewrite(target);
    if (!(response instanceof Response))
      return plainResponse(503, ACCESS_UNAVAILABLE);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  try {
    const headers = response.headers;
    if (!(headers instanceof Headers))
      return plainResponse(503, ACCESS_UNAVAILABLE);
    for (const [name, value] of rendererHeaders(appOrigin))
      headers.set(name, value);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  return response;
}

/**
 * The application host serves the collaboration app, the hosted viewer and the
 * APIs. It refuses the renderer shell prefix, serves the public splash page to
 * anybody, passes the API, assets, admin console, sign-in, viewer, publish and
 * invitation paths through with no session check, and applies the existing
 * session and access logic to everything else. Every
 * answer gains the application header set unless it already carries a CSP.
 */
async function applicationHost(
  req: Request,
  url: URL,
  context: GateContext,
  env: Record<string, string | undefined>,
): Promise<Response> {
  /* The renderer shell prefix is never a first-party page on the application
     origin, so it is a not-found before any session check. */
  if (isRenderPrefix(url.pathname)) {
    return withApplicationHeaders(
      new Response(null, {
        status: 404,
        headers: { "Content-Type": PLAIN_TEXT, ...NO_STORE },
      }),
    );
  }

  /* The landing page's own subresources - its images, its favicons - served to
     anybody, because #229 made the page public and did not make what the page
     loads public with it. A deeper path is still gated, so without this the
     splash renders with broken images and an anonymous visitor's browser
     follows a sign-in redirect for each one. They are not HTML and take the
     application header set through the same pass-through as a built asset. */
  /* The paths that used to be `excludedPath` in TOML, decided in code now that
     the gate runs on every path: passed through with no session check. A
     function response keeps its own headers; a static one gains the set. The
     gate's own `/api/hosted/session` subrequest is one of these, so it cannot
     recurse into the session logic.

     The landing pages are public too: the bare root serves the splash and
     `/welcome` serves the onboarding page, both through the same pass-through,
     so an anonymous visitor lands on a page rather than the sign-in redirect.

     The built reference documents join them. They are the product's own
     documentation, so they are read without signing in. They are matched by
     exact full path rather than by prefix, and the list is held equal at build
     time to the documents that declare themselves public, so no private
     collaboration document can fall inside the public set. Only the exact root,
     the onboarding page and the published reference routes are public; every
     other deeper path stays gated. */
  if (
    isLandingPage(url.pathname) ||
    isApplicationPublic(url.pathname) ||
    isPublicDocument(url.pathname) ||
    isApplicationPassThrough(url.pathname)
  ) {
    let passed: Response;
    try {
      passed = await context.next();
      if (!(passed instanceof Response))
        return plainResponse(503, ACCESS_UNAVAILABLE);
    } catch {
      return plainResponse(503, ACCESS_UNAVAILABLE);
    }
    /* The sign-in form lives on a landing page and on the sign-in page, and its
       submission redirects to the identity provider, so both header sets have to
       name that provider in `form-action` or the browser blocks the post before
       it leaves. The origin comes from configuration, never from the request. */
    const authOrigin = authorizationOrigin(env);
    if (isLandingPage(url.pathname)) return withLandingPageHeaders(passed, authOrigin);
    /* A public reference document is the same bytes under the same header set a
       signed-in reader gets today; only the session check is skipped. It does
       not take `finalizePassThrough`'s first-party page set, because that would
       make a document's policy depend on whether it was gated -- and the whole
       point of publishing one is that the answer no longer depends on who
       asked. */
    if (isPublicDocument(url.pathname)) return publicDocumentResponse(passed);
    return finalizePassThrough(passed, authOrigin);
  }

  return withApplicationHeaders(await sessionGate(req, url, context, env));
}

export default async function gate(
  req: Request,
  context: GateContext,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const env = readHostEnv();
  const host = classifyHost(url, env);

  /* A deploy preview or any other hostname is refused before any store read,
     with `X-Robots-Tag: noindex` so it is never indexed. */
  if (host === "other") return notFoundForeignHost();
  if (host === "render") return renderHost(url, context, env);
  return applicationHost(req, url, context, env);
}


/** The three answers the gate's identity step may produce, and nothing else. */
type SessionOutcome =
  | { kind: "principal"; user: { sub: string; email: string; emailVerified: boolean; name: string } }
  | { kind: "anonymous" }
  | { kind: "unavailable" };

/**
 * Who this request is, by asking the hosted session route.
 *
 * The gate cannot validate the session cookie itself. Doing so means reading the
 * session store, and the store adapter is a Node module over `@netlify/blobs`
 * that this Deno edge function neither can nor should link. So the gate asks the
 * one service that already answers the question, over an internal request that
 * forwards the browser's `Cookie` header and nothing else.
 *
 * `/api/hosted/session` is inside the gate's `isApplicationPassThrough` set, so
 * the subrequest reaches the route without re-entering this function's session
 * logic. That is what stops the call from recursing, and it is a property of the
 * route's *address* rather than of a flag somebody has to remember to set.
 *
 * ## The response is read for one thing, and the rest is dropped
 *
 * The route issues a fresh pre-login CSRF binding on every call, signed-in or
 * not, as a `Set-Cookie`. That header belongs to the browser that asked, and
 * this browser did not ask — it asked for a document. So nothing from the
 * subrequest's headers reaches the visitor: the gate reads the JSON body and
 * discards the response. The cost is one abandoned transient record per gated
 * page view, bounded by that record's fifteen-minute lifetime.
 *
 * ## Three outcomes, and the third is the point
 *
 * A store outage must not read as "signed out". `identifyHosted` throws rather
 * than answering null for exactly that reason, and the route turns the throw
 * into a 503; anything that is not a well-formed 200 — a 503, a non-JSON body, a
 * body that does not match the frozen contract, a transport failure — is an
 * outage here too. Failing closed on a malformed answer is deliberate: the only
 * other reading of "I could not understand the reply" is "nobody is signed in",
 * which is the fail-open this whole shape exists to avoid.
 */
async function resolveSession(
  req: Request,
  url: URL,
  env: Record<string, string | undefined>,
): Promise<SessionOutcome> {
  const cookie = req.headers.get("cookie");

  /* A request carrying no session cookie has nothing for the route to validate:
     `identifyHosted` answers null on the absent cookie before it reads anything.
     Asking anyway is not merely wasted -- the route mints a fresh pre-login CSRF
     binding on every call, so each cookieless request would write a record this
     gate then discards, and an unauthenticated flood of gated URLs would be free
     write amplification against the same store every signed-in read depends on.
     The check is presence-only: a cookie that is expired, revoked or forged is
     still resolved by the route, because only the route can tell. */
  if (cookie === null || !cookie.includes(`${SESSION_COOKIE}=`)) {
    return { kind: "anonymous" };
  }

  const headers = new Headers();
  headers.set("cookie", cookie);
  headers.set("accept", "application/json");

  /* The configured origin in preference to the request's own. They are the same
     origin on a configured deployment -- `classifyHost` has already refused every
     other hostname by the time this runs -- but a deployment with no `HOSTED_*`
     configuration classifies every host as the application, and there the
     request's own origin is the only one there is. Preferring the configured
     value means the session cookie is never re-sent to a host the deployment did
     not name whenever it has named one. */
  const configured = applicationOrigin(env);
  const target = new URL(SESSION_ROUTE, configured ?? url.origin).toString();

  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      headers,
      redirect: "manual",
    });
    if (!(response instanceof Response)) return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }

  let body: unknown;
  try {
    if (response.status !== 200) return { kind: "unavailable" };
    body = await response.json();
  } catch {
    return { kind: "unavailable" };
  }

  const record = body as Record<string, unknown> | null;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return { kind: "unavailable" };
  }
  if (record.v !== 1 || typeof record.authenticated !== "boolean") {
    return { kind: "unavailable" };
  }
  if (record.authenticated === false) return { kind: "anonymous" };

  if (
    typeof record.accountId !== "string" ||
    typeof record.login !== "string" ||
    typeof record.emailVerified !== "boolean" ||
    (record.email !== null && typeof record.email !== "string")
  ) {
    return { kind: "unavailable" };
  }

  /* The same projection `netlify/lib/identity.mjs` performs, because the two
     have to agree about who somebody is. One address grammar, applied on the way
     in, so the value that becomes an invitation-key hash is the same value on
     both paths; an address the grammar refuses degrades to "no usable address"
     rather than denying a visitor a document they already own. */
  const email = normalizeEmailOrNull(record.email) ?? "";
  const user = {
    sub: record.accountId,
    email,
    emailVerified: record.emailVerified === true && email !== "",
    name: record.login,
  };
  return { kind: "principal", user };
}

/**
 * The `?destination=` a refused path is worth offering the sign-in page, or
 * `null` when the path is not one ACN-005's grammar accepts.
 *
 * A path that is not expressible is simply not offered. Widening the allowlist
 * to make one fit is the failure this returns `null` instead of: the grammar is
 * the sign-in flow's redirect allowlist, and a gate that could add to it would
 * be a redirect-injection primitive reachable by requesting a URL.
 */
function signInDestination(pathname: string): string | null {
  const slug = COLLABORATION_SLUG.exec(pathname);
  if (slug === null || RESERVED_FIRST_SEGMENTS.includes(slug[1])) return null;
  return pathname;
}

/**
 * The application host's session and access gate. Identity is resolved through
 * the hosted session route, the document's `doc-id` meta line is read from the
 * first bytes of the body, the role is resolved and the response is replayed
 * only when the role can read.
 */
async function sessionGate(
  req: Request,
  url: URL,
  context: GateContext,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const outcome = await resolveSession(req, url, env);

  /* An outage is a plain 503 and never a sign-in redirect. Sending a visitor to
     `/login/` during a store outage would tell them they are signed out, which
     is a claim this gate has no evidence for — and it would put them on a page
     whose own bootstrap reads the same unreachable store. */
  if (outcome.kind === "unavailable") return plainResponse(503, AUTH_UNAVAILABLE);

  if (outcome.kind === "anonymous") {
    /* 303 rather than 302: the answer to "who are you" is a different resource
       from the one that was asked for, and a browser must fetch it with GET
       whatever this request's method was. `HEAD` is a GET for this purpose too. */
    const destination = signInDestination(url.pathname);
    const location =
      destination === null
        ? "/login/"
        : `/login/?destination=${encodeURIComponent(destination)}`;
    return new Response(null, {
      status: 303,
      headers: { Location: location, ...NO_STORE },
    });
  }

  const user: unknown = outcome.user;
  if (!validIdentity(user)) return plainResponse(500, UNVERIFIED);

  const isHead = req.method === "HEAD";
  let downstream: Response;
  try {
    const nextRequest = isHead
      ? new Request(req, { method: "GET", body: null })
      : undefined;
    downstream = await context.next(nextRequest);
    if (!(downstream instanceof Response))
      return plainResponse(503, ACCESS_UNAVAILABLE);
  } catch {
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }

  let status: number;
  let statusText: string;
  let headers: Headers;
  let body: ReadableStream<Uint8Array> | null = null;
  let bodyUsed: boolean;
  let responseType: ResponseType;
  try {
    body = downstream.body;
    status = downstream.status;
    statusText = downstream.statusText;
    headers = downstream.headers;
    bodyUsed = downstream.bodyUsed;
    responseType = downstream.type;
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (status === 0 || responseType === "opaque") {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (
    typeof status !== "number" ||
    typeof statusText !== "string" ||
    !(headers instanceof Headers) ||
    typeof bodyUsed !== "boolean" ||
    (body !== null && !(body instanceof ReadableStream))
  ) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }

  if (
    status === 204 ||
    status === 205 ||
    (status >= 300 && status <= 303) ||
    (status >= 305 && status <= 599)
  ) {
    if (!isHead) return downstream;
    let response: Response;
    try {
      response = new Response(null, {
        status,
        statusText,
        headers,
      });
    } catch {
      await cancelBody(body);
      return plainResponse(503, ACCESS_UNAVAILABLE);
    }
    await cancelBody(body);
    return response;
  }
  if (status !== 200) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  let contentType: string | null;
  let bodyLocked: boolean | undefined;
  let getReader: (() => ReadableStreamDefaultReader<Uint8Array>) | undefined;
  try {
    contentType = headers.get("Content-Type");
    bodyLocked = body?.locked;
    getReader = body?.getReader;
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }
  if (
    !validContentType(contentType) ||
    body === null ||
    bodyUsed !== false ||
    bodyLocked !== false ||
    typeof getReader !== "function"
  ) {
    if (isHead) await cancelBody(body);
    return plainResponse(500, UNVERIFIED);
  }
  try {
    reader = getReader.call(body);
  } catch {
    if (isHead) await cancelBody(body);
    return plainResponse(503, ACCESS_UNAVAILABLE);
  }

  const retained: Uint8Array[] = [];
  const prefix: number[] = [];
  let firstLineFound = false;
  try {
    while (!firstLineFound) {
      const next = await reader.read();
      if (
        next.done ||
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength === 0
      )
        throw new Error();
      retained.push(next.value);
      const inspectLength = Math.min(
        next.value.byteLength,
        MAX_META_LINE_BYTES - prefix.length,
      );
      for (let index = 0; index < inspectLength; index += 1) {
        const byte = next.value[index];
        prefix.push(byte);
        if (byte === 0x0a) {
          firstLineFound = true;
          break;
        }
      }
      if (!firstLineFound && prefix.length === MAX_META_LINE_BYTES)
        throw new Error();
    }

    const line = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Uint8Array.from(prefix));
    const match = /^<meta name="doc-id" content="([0-9a-f]{6})">\n$/.exec(line);
    if (match === null) throw new Error();
    const docId = match[1];

    let resolved: unknown;
    try {
      resolved = await resolveRole(docId, user, { consumeInvitation: false });
    } catch (error) {
      await cancelAndRelease(reader);
      const unavailable = isUnavailableError(error);
      return plainResponse(
        unavailable ? 503 : 500,
        unavailable ? ACCESS_UNAVAILABLE : UNVERIFIED,
      );
    }

    // The eighth hand copy of the access-row check used to live here under a
    // third name, `validResolvedAccess()` (#135). It is the shared
    // `validateAccessRow()` now (#132): one definition, so a weakening lands
    // in one file rather than in whichever copy no gate exercises. The edge
    // path gains the checks the copy lacked -- the role must be a known role,
    // `threadControl` one of the three controls, every capability a boolean --
    // and loses the copy's demand that each own property be writable and
    // configurable, which the shared validator does not make.
    if (!validateAccessRow(resolved, capabilitiesFor)) {
      await cancelAndRelease(reader);
      return plainResponse(500, UNVERIFIED);
    }
    const access = resolved as Record<string, unknown>;
    if (access.canRead !== true) {
      await cancelAndRelease(reader);
      return plainResponse(403, DENIED);
    }

    /* The granted reader's copy of the document, under the document header
       set. `applicationHost` wraps every `sessionGate` answer in
       `withApplicationHeaders`, which leaves a response that already carries a
       CSP alone -- so naming the policy here is what keeps the document set on
       the answer rather than the `default-src 'none'` application set that
       blocks the artifact's own inline style and script (#235). The public
       branch applies the identical set, so the policy a document arrives under
       does not depend on who asked for it. */
    if (isHead) {
      const response = new Response(null, {
        status,
        statusText,
        headers,
      });
      await cancelAndRelease(reader);
      return withDocumentHeaders(response);
    }
    return withDocumentHeaders(
      replayResponse(status, statusText, headers, reader, retained),
    );
  } catch {
    await cancelAndRelease(reader);
    return plainResponse(500, UNVERIFIED);
  }
}
