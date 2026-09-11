/**
 * `GET /api/hosted/admin/documents` - every document this deployment stores.
 *
 * The census an operator needs and the one thing the ticket is careful to bound:
 * title, id, owner, created date and access rules, and never a document's
 * content. `documentCensusOf` is where that bound lives, and there is no content
 * route in the admin namespace at all - `/api/hosted/docs/<id>/content` remains
 * the only path to a document's bytes and it authorises through
 * `readOwnedPublication`, which has no admin branch in it.
 *
 * ## A record this version cannot read is reported, not dropped
 *
 * The adapter's `list` separates records it read from ids it could not, and both
 * reach the page. An operator census that silently omitted an unreadable record
 * would show a shorter list than the truth with no way to notice, and the
 * unreadable record is the one most worth knowing about.
 *
 * ## Why there is no `Origin` check
 *
 * A read needs a session and nothing more, exactly as the publication access
 * route's `GET` does. There is nothing to forge: a cross-site `fetch` of this
 * route cannot read the answer without a CORS grant this deployment never
 * issues, and refusing the request would only turn a body nobody can read into a
 * status nobody can read.
 */

import {
  ADMIN_DOCUMENTS_PATH,
  adminEnvelope,
  documentCensusOf,
  requireAdmin,
  unreadableCensusOf,
} from "../lib/hosted/admin.mjs";
import { adminDependencies } from "../lib/hosted/admin-http.mjs";
import { identifyHosted } from "../lib/hosted/identity.mjs";
import {
  browserError,
  browserJson,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: ADMIN_DOCUMENTS_PATH };

/** The route, over injected dependencies. */
export function createAdminDocumentsRoute(resolveDependencies) {
  return async function adminDocumentsRoute(request) {
    const rejection = browserMethodRejection(request, "GET");
    if (rejection !== null) return rejection;

    try {
      const { config: hostedConfig, store, publications } = resolveDependencies();
      const principal = await identifyHosted(request, { store });
      requireAdmin(principal, hostedConfig);

      const { records, unreadable, truncated } = await publications.list();
      return browserJson(
        200,
        adminEnvelope({
          documents: [...records.map(documentCensusOf), ...unreadable.map(unreadableCensusOf)],
          truncated,
        }),
      );
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAdminDocumentsRoute(() => adminDependencies(process.env));
