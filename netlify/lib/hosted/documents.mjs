/**
 * The private document read, and the two response shapes that carry it.
 *
 * Three routes serve one completed publication to the one account that owns it:
 * the trusted viewer page at `/docs/<id>`, the owner metadata at
 * `/api/hosted/docs/<id>` and the raw bytes at `/api/hosted/docs/<id>/content`.
 * This module holds what all three share, and the sharing is the point: the
 * alternative is three handlers each with its own opinion about who may read a
 * document, which is the shape a private-content bug actually takes.
 *
 * ## Three rules, restated as code
 *
 * **The owner predicate is AHU-004's, not this module's.** Every read goes
 * through `readOwnedPublication`, which decides "complete, and owned by this
 * principal" once. Nothing here compares an `ownerAccountId`, and nothing here
 * reads a storage key: a second, subtly different rule -- one that forgot the
 * `complete` check, or matched on `login` instead of the numeric account id --
 * is precisely the regression the single predicate exists to prevent.
 *
 * **A denial says nothing.** Missing, not complete, owned by somebody else and
 * malformed all produce the same fixed body with the same status. C4 requires
 * missing and other-owned to be indistinguishable, and the cheapest way to keep
 * that true through later edits is for there to be exactly one not-found
 * representation, built from no input at all. `NOT_FOUND_PAGE` and the 404
 * envelope are literals for that reason: a body assembled from the request
 * cannot accidentally start carrying a title.
 *
 * **A storage outage is not a denial.** `readOwnedPublication` and
 * `identifyHosted` both distinguish "could not read" from "not there", and this
 * module keeps them apart to the wire: `unavailable` is a retryable 503, and
 * saying 404 instead would tell an owner their document is gone during an
 * outage. That is the failure a reader acts on -- by stopping.
 *
 * ## Why the viewer shell carries no document data
 *
 * The page returned for `/docs/<id>` is byte-identical for every document. It
 * has no title in it, no owner, no digest and not even the id -- `viewer.js`
 * reads that from `location.pathname` and fetches the rest through the two API
 * routes, each of which authorises independently.
 *
 * That is a stronger guarantee than escaping would be. There is no interpolation
 * of user-controlled text into the shell, so there is no escaping to get wrong,
 * no context (attribute, script, comment) to get confused about, and a stored
 * title consisting entirely of executable-looking markup is not a case this file
 * has to handle -- it never reaches this file. The only value interpolated is
 * the operator's configured renderer origin, which `readHostedConfig` has
 * already reduced to a `URL.origin` round trip, and it is escaped anyway.
 *
 * It also makes the shell's authorisation check non-reusable by construction:
 * the page proves nothing to the API routes, so the second and third requests
 * have to prove ownership again, which is what C4 asks for.
 */

import { HOSTED_LIMITS, HostedContractError, validateDocumentMetadata } from "./contracts.mjs";

/** C4: the stable owner-facing address of a document. */
export const DOCUMENT_PAGE_PATH = "/docs/:documentId";

/** C4: the owner metadata projection. */
export const DOCUMENT_METADATA_PATH = "/api/hosted/docs/:documentId";

/** C4: the raw bytes, as an attachment. */
export const DOCUMENT_CONTENT_PATH = "/api/hosted/docs/:documentId/content";

/** The sign-in destination for a signed-out reader, as C1's grammar spells it. */
export function signInDestination(documentId) {
  return `/login/?destination=${encodeURIComponent(`${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}${documentId}`)}`;
}

/**
 * A fixed filename, never the document's title.
 *
 * A title is user-authored text of up to 160 scalar values, and putting one in
 * a `Content-Disposition` means quoting rules, `filename*` encoding and a header
 * a reader's filesystem acts on. None of that is worth the convenience, and the
 * owner already knows which document they opened.
 */
export const CONTENT_DISPOSITION = 'attachment; filename="archon-document.html"';

/**
 * The headers every private response from this tree carries.
 *
 * Netlify does not apply `netlify.toml` headers to function output, so a header
 * absent here is absent in production. `Netlify-CDN-Cache-Control: no-store` is
 * the one that is not merely a repeat of `Cache-Control`: it addresses the
 * platform's own edge cache, which is the copy of a private document nobody
 * would think to look for.
 */
export const PRIVATE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  Vary: "Cookie",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  /* Defence in depth rather than the boundary. Reading these responses
     cross-origin is already refused by the absence of any CORS grant; this
     stops another site *embedding* the raw bytes as a subresource, which is a
     use that needs no read access to be unwelcome. */
  "Cross-Origin-Resource-Policy": "same-origin",
  /* A default policy for the responses that do not set their own. The HTML and
     raw-bytes helpers below override it with something stricter or more
     specific; what this covers is the JSON, which is the one response in this
     module carrying user-authored text (the title) from the account origin.
     `application/json` plus `nosniff` is what actually stops a browser treating
     it as a document -- this is the belt every other hosted JSON route already
     wears, and its absence here was the odd one out. */
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

/**
 * The policy the raw-bytes response runs under.
 *
 * `sandbox` with no tokens is the load-bearing directive and the reason this
 * header exists at all. The response is already `application/octet-stream` with
 * `nosniff` and an attachment disposition, so three separate mechanisms have to
 * fail before a browser treats it as a document -- and if they all do, `sandbox`
 * puts that document in an opaque origin with scripting disabled, on the account
 * origin, holding the reader's session cookie. C4's "the private raw-content
 * endpoint never executes authored HTML on the account origin" is this line.
 */
export const RAW_CONTENT_CSP = "default-src 'none'; sandbox";

/** The policy the inert pages run under: no script source anywhere. */
const INERT_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * The two subresources the viewer shell loads, as the one place they are named.
 *
 * They are a declared constant because two things have to agree about them and
 * neither can see the other's string: the markup below, which references them,
 * and `APP_PASS_THROUGH_PATHS` in `netlify/lib/edge-host.mjs`, which is what
 * keeps the session gate from answering for them. A page whose own stylesheet
 * and module sit behind the sign-in the page exists to complete cannot work for
 * anybody, so the gate test asserts that every path named here is a
 * pass-through rather than trusting the two lists to stay in step.
 *
 * Root paths with a dot in them, deliberately: the collaboration slug grammar
 * admits no dot, so neither spelling can be claimed by a document.
 */
export const VIEWER_ASSET_PATHS = Object.freeze({
  stylesheet: "/viewer.css",
  module: "/viewer.js",
});

/**
 * The policy the viewer shell runs under.
 *
 * `frame-src` names the configured renderer origin exactly and nothing else, so
 * the one frame this page is allowed to open is the one the design depends on.
 * `connect-src 'self'` bounds `viewer.js` to this origin's own API -- the
 * document's bytes are fetched from here and go nowhere. `form-action 'none'`
 * is honest rather than defensive: this page submits no form, and sign-out is a
 * scripted POST carrying the session-bound CSRF header, which a form could not
 * send.
 *
 * `img-src 'self'` is the one grant that is not about the frame. The shell
 * references no image, but a browser asks for `/favicon.ico` on its own for
 * every page it renders, and under `default-src 'none'` that request was
 * refused and reported as a policy violation on every load. The site's favicon
 * is same-origin and already public, so the honest spelling of "this page may
 * have the icon it is being asked for" is `'self'` -- not a wider `img-src`,
 * and not a page that keeps generating a violation it cannot act on. The
 * document itself renders in the cross-origin frame and draws no image here.
 */
export function viewerCsp(renderOrigin) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    `frame-src ${renderOrigin}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * The document id in a path, or a typed refusal.
 *
 * The id is matched against C2's grammar here rather than being handed straight
 * to the adapter, for two reasons that are not about defence in depth. The
 * viewer builds a sign-in redirect out of this value, and C1 allows exactly one
 * shape there; and a malformed id must reach the same generic not-found body as
 * a well-formed one that does not exist, which means it must not reach storage
 * at all.
 *
 * @param {string} pathname the request's path, already separated from its query
 * @param {RegExp} pattern one capturing group holding the raw id segment
 */
export function documentIdFrom(pathname, pattern) {
  const match = pattern.exec(pathname);
  if (match === null) throw notFound();
  let raw;
  try {
    raw = decodeURIComponent(match[1]);
  } catch {
    /* `%zz` throws `URIError`, which is not a `HostedContractError` and would
       otherwise be replaced wholesale by a retryable 503 -- telling a client to
       retry a request that can never succeed. */
    throw notFound();
  }
  if (!new RegExp(`^[0-9a-f]{${HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH}}$`).test(raw)) {
    throw notFound();
  }
  return raw;
}

/** The single not-found refusal these routes have. Built from no input. */
export function notFound() {
  return new HostedContractError("not_found", "document not found", { field: "documentId" });
}

/**
 * Path patterns, anchored, tolerant of one trailing slash and nothing else.
 *
 * The tolerance is defensive, not a promise about the deployed URL space. A
 * Netlify path parameter does not match a trailing slash, so `/docs/<id>/` is
 * routed by `config.path` to nothing and never reaches these handlers on the
 * deployment; what the tolerance buys is that if the platform ever normalises
 * one in, the handler answers rather than 404s. Read the tests that exercise it
 * as "the handler is not confused by a trailing slash", never as "this URL
 * works in production" -- they call the handler directly and cannot see
 * Netlify's route table.
 */
export const PAGE_PATTERN = /^\/docs\/([^/]*)\/?$/;
export const METADATA_PATTERN = /^\/api\/hosted\/docs\/([^/]*)\/?$/;
export const CONTENT_PATTERN = /^\/api\/hosted\/docs\/([^/]*)\/content\/?$/;

/**
 * The C4 owner metadata for a complete record.
 *
 * Built field by field and then validated, rather than by removing the secret
 * fields from the record. A projection that starts from the whole envelope
 * acquires whatever field is added to `Publication` next -- and the fields that
 * would be added next are `agentSecretHash`, `browserSecretHash` and `html`,
 * which are already there. Starting from nothing means the worst case is a
 * missing field, which `validateDocumentMetadata` refuses.
 */
export function documentMetadataOf(record) {
  return validateDocumentMetadata({
    v: 1,
    documentId: record.id,
    title: record.descriptor.title,
    ownerAccountId: record.ownerAccountId,
    contentSha256: record.descriptor.contentSha256,
    contentBytes: record.descriptor.contentBytes,
    createdAt: record.createdAt,
  });
}

/**
 * `&`, `<`, `>`, `"` and `'` as entities.
 *
 * Only ever applied to the operator's configured renderer origin, which
 * `validateOrigin` has already reduced to a value that round-trips through
 * `URL.origin` and therefore cannot contain any of them. It is applied anyway so
 * that a reviewer reading the template does not have to trace a value back
 * through two modules to establish that.
 */
export function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Shared page furniture, so the three pages cannot drift apart visually. */
const PAGE_STYLE = `
      :root { color-scheme: light dark; }
      body {
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        line-height: 1.5;
        margin: 0 auto;
        max-width: 34rem;
        padding: 3rem 1.25rem;
      }
      h1 { font-size: 1.4rem; }`;

/**
 * The body served for every refused read, whatever the reason.
 *
 * A literal, with no interpolation and no `<script>`. Two documents that do not
 * exist, one document that exists and belongs to somebody else, and one id that
 * is not an id all produce these exact bytes, which is what makes "cannot read
 * document metadata" a fact about the response rather than about a comparison
 * somewhere upstream.
 */
export const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Not found — Archon</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <h1>Not found</h1>
    <p>There is no document at this address, or it is not yours to read.</p>
    <p><a href="/">Go to Archon</a></p>
  </body>
</html>
`;

/** The body served when the service could not establish an answer. */
export const UNAVAILABLE_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Unavailable — Archon</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <h1>Archon is unavailable</h1>
    <p>This document could not be opened just now. Reload the page to try again.</p>
  </body>
</html>
`;

/**
 * The body served to a reader whose own domain is listed but whose address the
 * identity provider has not verified.
 *
 * The one page in this module that is not a fixed refusal, and it is worth
 * being clear about what it costs. Every other denial here is byte-identical to
 * every other denial, which is what makes "not yours" indistinguishable from
 * "does not exist". This one is distinguishable: seeing it means the document
 * exists and lists the domain of the address you claimed. That is a real
 * disclosure, and it is the price of the alternative being an actionable state
 * - "verify your email" - rendered as "not found", which a reader with a
 * perfectly good corporate address would read as the link being broken and
 * would escalate to the owner rather than to their identity provider.
 *
 * The disclosure is bounded, but be exact about the bound: `evaluateAccess`
 * answers `email_unverified` only when the domain on the principal is on this
 * document's list - and that address is unverified, so the domain is claimed
 * rather than held. Somebody already holding the link can therefore sign up
 * with an address at a guessed domain and learn from this page that the
 * document lists it. What the page still never does is speak about a document
 * whose list the caller did not name, or about one that does not exist, so it
 * is an oracle over one id the caller already had rather than over the id
 * space. See the note in `domain-access.mjs` for why that trade was taken.
 * Like the other two it is a literal with no interpolation, it carries
 * `noindex`, and it names no document.
 */
export const EMAIL_UNVERIFIED_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Email not verified — Archon</title>
    <style>${PAGE_STYLE}</style>
  </head>
  <body>
    <h1>Verify your email</h1>
    <p>Verify your email address with your sign-in provider, then open this link again.</p>
    <p><a href="/">Go to Archon</a></p>
  </body>
</html>
`;

/**
 * The trusted shell, identical for every document.
 *
 * Read the order of the regions as the contract: the header carrying the title,
 * the owner and sign-out is a sibling of the stage, never inside it, so nothing
 * the artifact renders can overlap, replace or impersonate a trusted control.
 * The artifact's only presence on this page is one cross-origin frame, which
 * cannot reach anything outside itself.
 *
 * The stage is **empty**, and the frame that goes in it is created by
 * `viewer.js`. That is a correctness requirement rather than a preference:
 * `renderer.js` posts its readiness message the instant it mounts, and a frame
 * present in this markup starts loading while the parser is still reading the
 * document -- comfortably before a deferred module has attached a listener. The
 * handshake was then lost on every warm load, and the visible symptom was a
 * readiness deadline firing against a renderer that had been ready for fifteen
 * seconds. Creating the frame after the listener exists removes the race rather
 * than narrowing it.
 *
 * The renderer origin is carried on `body` in two spellings for the same reason
 * -- `viewer.js` needs the frame's URL and the exact `event.origin` string, and
 * deriving one from the other would be a string operation standing between a
 * configured origin and an exact-origin comparison.
 */
export function viewerShell(renderOrigin) {
  /* Two spellings of one value, and the difference matters. `frameSrc` is a URL
     and carries the trailing slash a browser would add anyway; the data
     attribute is the bare `URL.origin`, because that is the exact string
     `event.origin` will equal and `postMessage` will be targeted at. Deriving
     one from the other in `viewer.js` would be one string operation standing
     between a configured origin and an exact-origin comparison. */
  const frameOrigin = escapeAttribute(renderOrigin);
  const frameSrc = escapeAttribute(`${renderOrigin}/`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Document — Archon</title>
    <link rel="stylesheet" href="${VIEWER_ASSET_PATHS.stylesheet}" />
    <script type="module" src="${VIEWER_ASSET_PATHS.module}"></script>
  </head>
  <body data-archon-render-origin="${frameOrigin}" data-archon-render-src="${frameSrc}">
    <header class="chrome">
      <div class="identity">
        <h1 class="doc-title" data-archon-title>Loading…</h1>
        <p class="owner" data-archon-owner></p>
      </div>
      <button type="button" class="signout" data-archon-signout hidden>Sign out</button>
    </header>

    <p class="status" data-archon-status role="status" aria-live="polite">
      Loading your document…
    </p>

    <p class="retry" data-archon-retry hidden>
      <button type="button" data-archon-retry-button>Try again</button>
    </p>

    <noscript>
      <p class="status" data-tone="error">
        JavaScript is required to display a document. Archon renders the document
        in an isolated frame, which needs a script on this page to set up.
      </p>
    </noscript>

    <div class="stage" data-archon-stage hidden></div>
  </body>
</html>
`;
}

/** An HTML response with the private header set and an explicit policy. */
export function htmlResponse(html, { status = 200, csp, method = "GET", headers = {} } = {}) {
  const body = new TextEncoder().encode(html);
  const merged = new Headers({
    ...PRIVATE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "Content-Length": String(body.byteLength),
    ...headers,
  });
  /* A HEAD carries the status and every header a GET would, and no body. That is
     C4's "authorization-equivalent HEAD": a reader who can HEAD a document can
     read it, and a reader who cannot gets the same refusal either way, so HEAD
     is never a cheaper oracle than GET. */
  return new Response(method === "HEAD" ? null : body, { status, headers: merged });
}

/** The inert refusal page, for every reason a read was refused. */
export function notFoundPage(method) {
  return htmlResponse(NOT_FOUND_PAGE, { status: 404, csp: INERT_PAGE_CSP, method });
}

/** The inert outage page. Distinct from a refusal, and retryable. */
export function unavailablePage(method) {
  return htmlResponse(UNAVAILABLE_PAGE, { status: 503, csp: INERT_PAGE_CSP, method });
}

/**
 * The inert verify-your-email page, at the status the API routes use.
 *
 * 403 rather than 404, matching `email_unverified` in the C3 table, so the page
 * and the JSON envelope a reader would get from the metadata route for the same
 * document say the same thing with the same status.
 */
export function emailUnverifiedPage(method) {
  return htmlResponse(EMAIL_UNVERIFIED_PAGE, { status: 403, csp: INERT_PAGE_CSP, method });
}
