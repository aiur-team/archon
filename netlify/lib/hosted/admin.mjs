/**
 * The admin surface: who may open it, what it is allowed to show, and the shell
 * it is served as.
 *
 * Three routes share this module - the page at `/admin`, the census at
 * `/api/hosted/admin/documents` and the allowlist editor at
 * `/api/hosted/admin/allowlist` - and the sharing is the point, for the reason
 * `documents.mjs` gives about its own three: the alternative is three handlers
 * each with an opinion about who is an admin, and the one that drifts is the one
 * nobody reads during a review.
 *
 * ## The census is metadata, and the projection is why
 *
 * Operator decision 4: an admin sees every document's title, id, owner, created
 * date and access rules, and cannot open document content they were not granted.
 * `documentCensusOf` is how that is enforced rather than promised - it is built
 * field by field from nothing, exactly as `documentMetadataOf` is, so the field
 * added to `Publication` next does not join it. The fields that would be added
 * next are `html`, `agentSecretHash` and `browserSecretHash`, which are already
 * there. A projection that started from the record and deleted three names would
 * be one merge away from serving a document's bytes to a page that lists them.
 *
 * There is deliberately **no** content route here at all. The admin page has no
 * button to open a document's bytes, and there is no endpoint behind such a
 * button: `/api/hosted/docs/<id>/content` is the only path to a document's HTML
 * and it authorises through `readOwnedPublication` with no admin branch in it.
 *
 * ## The page proves nothing to the API
 *
 * The shell is byte-identical for every admin and carries no document data, so
 * `admin.js` fetches the census and the allowlist through routes that each
 * authorise independently. That is the same split `/docs/<id>` keeps and it buys
 * the same thing: there is no interpolation of stored text into the shell, so
 * there is no escaping to get wrong, and an admin page cached anywhere is a page
 * with nothing in it.
 *
 * ## A non-admin gets 403, not 404
 *
 * The rest of this tree answers 404 to hide whether a document exists. `/admin`
 * is not a secret - it is one fixed path that exists on every deployment of this
 * software, and its existence is public in this repository - so hiding it would
 * cost a signed-in non-admin a comprehensible answer and hide nothing. The
 * acceptance criterion says 403 and it is the right status: the request was
 * understood, the identity is known, and the capability is missing.
 */

import { HostedContractError } from "./contracts.mjs";
import { PRIVATE_HEADERS, escapeAttribute, htmlResponse } from "./documents.mjs";
import { isAdmin } from "./platform-access.mjs";

/** The admin page's stable address. */
export const ADMIN_PAGE_PATH = "/admin";

/** The census route. */
export const ADMIN_DOCUMENTS_PATH = "/api/hosted/admin/documents";

/** The allowlist editor route. */
export const ADMIN_ALLOWLIST_PATH = "/api/hosted/admin/allowlist";

/** The two edits the allowlist route accepts. */
export const ALLOWLIST_ACTIONS = Object.freeze(["add", "remove"]);

/**
 * The policy the admin shell runs under.
 *
 * `connect-src 'self'` bounds `admin.js` to this origin's own API. There is no
 * `frame-src`: unlike the viewer, this page renders no document and opens no
 * renderer frame, so naming one would be granting a capability the page does not
 * use. `form-action 'none'` is honest rather than defensive - every edit on this
 * page is a scripted request carrying the session-bound CSRF header, which a
 * form could not send.
 */
export const ADMIN_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Establish that a request is from an admin, or throw the refusal to send.
 *
 * `principal` is `identifyHosted`'s result, so a signed-out caller is `null` and
 * a storage outage has already been thrown as `AuthUnavailableError` by the time
 * this is reached - this function never sees the difference between "signed out"
 * and "we could not tell", which is what stops it from inventing one.
 *
 * @throws {HostedContractError} `session_required` (401) or `forbidden` (403)
 */
export function requireAdmin(principal, config) {
  if (principal === null || principal === undefined) {
    throw new HostedContractError("session_required", "sign in to use the admin console");
  }
  if (!isAdmin(principal, config.admins)) {
    throw new HostedContractError("forbidden", "this account is not an administrator");
  }
  return principal;
}

/**
 * The admin projection of one publication record.
 *
 * Built field by field from nothing, exactly as `documentMetadataOf` is, and for
 * the reason its own note gives: a projection that started from the record and
 * deleted three names would be one merge away from serving a document's bytes to
 * a page that lists them. The fields that would be added to `Publication` next
 * are `html`, `agentSecretHash` and `browserSecretHash`, and they are already
 * there.
 *
 * It is not `documentMetadataOf` plus fields. That projection is C4's owner view
 * and holds `ownerAccountId` to a non-null account id, because an owner reading
 * their own document always has one; a census covers publications that no human
 * has approved yet, which have no owner at all. Reusing it would have made every
 * in-flight publication either an exception or invisible, and invisible is the
 * failure an operator cannot see.
 *
 * `contentSha256` and `contentBytes` are present and are *not* content - they
 * are the digest and the length an operator needs to answer "is this the same
 * document" and "how much is stored", and neither reveals a byte of it.
 */
export function documentCensusOf(record) {
  return Object.freeze({
    documentId: record.id,
    title: record.descriptor.title,
    state: record.state,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    ownerAccountId: record.ownerAccountId,
    /* The approver's verified address, which is the field that makes this list
       usable: an account id answers "who owns this" with a value nobody can act
       on. It is null while there is no owner, and for an owner who had none. */
    ownerEmail: record.ownerEmail,
    contentSha256: record.descriptor.contentSha256,
    contentBytes: record.descriptor.contentBytes,
    /* The access rules the ticket asks the page to show, defaulted here rather
       than trusted: a record written before `allowedDomains` existed has none,
       and the honest reading of that absence is "no domains are listed". */
    allowedDomains: Object.freeze(
      Array.isArray(record.allowedDomains) ? [...record.allowedDomains] : [],
    ),
  });
}

/**
 * The census of a record that could not be interpreted.
 *
 * An id and a flag, and nothing invented. The row exists so an admin can see
 * that the store holds something this version cannot read; filling the other
 * fields with placeholders would make it look like a document with an empty
 * title.
 */
export function unreadableCensusOf(id) {
  return Object.freeze({ documentId: id, unreadable: true });
}

/** The JSON envelope every admin route answers with, matching C3's `v: 1`. */
export function adminEnvelope(body) {
  return Object.freeze({ v: 1, ...body });
}

/**
 * The admin shell.
 *
 * The only value interpolated is the signed-in admin's own address, which
 * `validatePrincipal` has already held to the ASCII address grammar and which is
 * escaped anyway - for the reason `escapeAttribute`'s own note gives, so that a
 * reviewer reading this template does not have to trace the value back through
 * two modules to establish that it is safe.
 */
export function adminShell(adminEmail) {
  const who = escapeAttribute(adminEmail ?? "");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Admin — Archon</title>
    <link rel="stylesheet" href="/admin/admin.css" />
    <script type="module" src="/admin/admin.js"></script>
  </head>
  <body data-archon-admin="${who}">
    <header class="chrome">
      <h1>Archon admin</h1>
      <p class="who">Signed in as ${who}</p>
    </header>

    <section class="panel" aria-labelledby="allowlist-heading">
      <h2 id="allowlist-heading">Platform allowlist</h2>
      <p class="hint">
        An entry admits one address, or every address at one domain, to sign in
        and use this deployment. It does not share any document: which documents
        someone can open is still decided per document.
      </p>
      <form class="add" data-archon-allowlist-form>
        <label for="allowlist-entry">Email address or domain</label>
        <input id="allowlist-entry" name="entry" type="text" autocomplete="off"
               spellcheck="false" required data-archon-allowlist-input />
        <button type="submit" data-archon-allowlist-add>Add</button>
      </form>
      <p class="status" data-archon-allowlist-status role="status" aria-live="polite"></p>
      <ul class="entries" data-archon-allowlist-entries></ul>
    </section>

    <section class="panel" aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents</h2>
      <p class="hint">
        Every document this deployment stores, with its owner and its access
        rules. Titles and metadata only — this page cannot open a document.
      </p>
      <p class="status" data-archon-documents-status role="status" aria-live="polite">
        Loading…
      </p>
      <table class="documents" data-archon-documents hidden>
        <thead>
          <tr>
            <th scope="col">Title</th>
            <th scope="col">Id</th>
            <th scope="col">Owner</th>
            <th scope="col">Created</th>
            <th scope="col">State</th>
            <th scope="col">Access</th>
          </tr>
        </thead>
        <tbody data-archon-documents-body></tbody>
      </table>
    </section>

    <noscript>
      <p class="status" data-tone="error">
        JavaScript is required. This page holds no data of its own: it fetches
        the document census and the allowlist from routes that authorise each
        request separately.
      </p>
    </noscript>
  </body>
</html>
`;
}

/** The admin page, under the private header set and its own policy. */
export function adminPage(adminEmail, method) {
  return htmlResponse(adminShell(adminEmail), { csp: ADMIN_PAGE_CSP, method });
}

/**
 * The inert refusal page a signed-in non-admin gets.
 *
 * No script, no data, and no hint that any document exists. It is a page rather
 * than a JSON envelope because this route is reached by a top-level navigation
 * and its response is something a person looks at.
 */
export const FORBIDDEN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Not available — Archon</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 32rem; padding: 0 1rem; }
    </style>
  </head>
  <body>
    <h1>Not available</h1>
    <p>This account is not an administrator of this deployment.</p>
  </body>
</html>
`;

/** The policy the inert page runs under: no script source anywhere. */
const INERT_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** The 403 page, at the status `requireAdmin` refuses with. */
export function forbiddenPage(method) {
  return htmlResponse(FORBIDDEN_PAGE, { status: 403, csp: INERT_PAGE_CSP, method });
}

/** Re-exported so a route needs one import for the page and its header set. */
export { PRIVATE_HEADERS };
