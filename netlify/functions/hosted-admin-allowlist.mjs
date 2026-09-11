/**
 * `GET|POST /api/hosted/admin/allowlist` - read and edit the platform allowlist.
 *
 * One address, two verbs, one authorisation rule: an admin, and nobody else. An
 * address that is *on* the allowlist is refused here exactly as a stranger is -
 * being admitted to the platform does not entitle you to enumerate who else was.
 *
 * ## The two verbs are not two authorisations
 *
 * `GET` needs a session and admin. `POST` needs both plus an exact `Origin` and
 * the session-derived CSRF token, which is `requireBrowserMutation` - the same
 * mechanism the approval decision and the document access routes use. There is
 * no second CSRF scheme here and no form-navigation affordance: the admin page
 * edits by `fetch`, so the strictest of the three checks costs nothing to keep.
 *
 * Order matters and is deliberate: origin, session and CSRF first, admin second.
 * A cross-site request is rejected before this route spends a store read on
 * deciding whether its author is an admin.
 *
 * ## `POST` adds or removes one entry; it does not replace the list
 *
 * The opposite choice from the per-document domain list, which replaces
 * wholesale, and the difference is the number of writers. A document's list is
 * edited by its one owner, so "the last writer's intent is a list somebody
 * looked at" is the right rule. The platform allowlist is edited by admins over
 * months and seeded from the environment, and a replace there means a stale tab
 * can delete an entry added an hour ago by someone else. One entry at a time,
 * compare-and-set against what is actually stored, so two admins adding two
 * addresses at the same moment both succeed.
 *
 * ## What a refusal says
 *
 * `forbidden` for a signed-in non-admin and `session_required` for a signed-out
 * caller, because this route is only ever reached by a page that already
 * established both and the distinction is the one its reader can act on.
 * `invalid_request` naming the offending entry for a value that is neither an
 * address nor a domain - it is the admin's own typing, and "your entry is
 * invalid" is not a message anybody can act on.
 */

import {
  ADMIN_ALLOWLIST_PATH,
  ALLOWLIST_ACTIONS,
  adminEnvelope,
  requireAdmin,
} from "../lib/hosted/admin.mjs";
import { adminDependencies } from "../lib/hosted/admin-http.mjs";
import {
  addAllowlistEntry,
  removeAllowlistEntry,
  resolveAllowlist,
} from "../lib/hosted/allowlist.mjs";
import { HostedContractError } from "../lib/hosted/contracts.mjs";
import { identifyHosted, requireBrowserMutation } from "../lib/hosted/identity.mjs";
import { PlatformAccessError } from "../lib/hosted/platform-access.mjs";
import {
  browserError,
  browserJson,
  browserJsonBody,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: ADMIN_ALLOWLIST_PATH };

/** The allowed methods, advertised on the refusal. */
const ALLOW = "GET, POST";

/** The route, over injected dependencies. */
export function createAdminAllowlistRoute(resolveDependencies) {
  return async function adminAllowlistRoute(request) {
    if (request.method !== "GET" && request.method !== "POST") {
      const refusal = new HostedContractError("invalid_request", `only ${ALLOW} are supported`, {
        field: "method",
      });
      const response = browserJson(405, refusal.toWire());
      response.headers.set("allow", ALLOW);
      return response;
    }

    try {
      const { config: hostedConfig, store, allowlist } = resolveDependencies();

      if (request.method === "GET") {
        const principal = await identifyHosted(request, { store });
        requireAdmin(principal, hostedConfig);
        return browserJson(200, await currentList({ config: hostedConfig, allowlist }));
      }

      /* Origin, then session, then the session-derived token, before the body is
         read and before admin is decided: spending a store read and a parse on a
         request already known to be cross-site is work done for an attacker. */
      const { principal } = await requireBrowserMutation(request, {
        store,
        config: hostedConfig,
      });
      requireAdmin(principal, hostedConfig);

      const body = await browserJsonBody(request);
      requireRequestVersion(body);
      const action = requireAction(body.action);

      try {
        if (action === "add") {
          await addAllowlistEntry({ value: body.entry, actor: principal.email }, { store: allowlist });
        } else {
          await removeAllowlistEntry({ value: body.entry }, { store: allowlist, config: hostedConfig });
        }
      } catch (error) {
        /* The evaluator's own refusal vocabulary is not the wire's. Translated
           here rather than thrown as-is so an admin reads a bounded message
           naming their entry instead of an untyped error the boundary would
           flatten into a retryable 503 and a page would loop on. */
        if (error instanceof PlatformAccessError) {
          throw new HostedContractError("invalid_request", error.message, { field: "entry" });
        }
        throw error;
      }

      /* The whole list comes back, so a page never has to guess at the result of
         its own edit or hold a local copy that can disagree with the store. */
      return browserJson(200, await currentList({ config: hostedConfig, allowlist }));
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The resolved list - the environment seed and the stored entries, unioned. */
async function currentList({ config: hostedConfig, allowlist }) {
  const entries = await resolveAllowlist({ config: hostedConfig, store: allowlist });
  return adminEnvelope({ entries, enforced: hostedConfig.platformAllowlistEnforced });
}

/**
 * The request envelope's version, checked before anything reads its payload.
 *
 * `v` is not decoration: a client that starts sending a different shape under
 * the same key is the situation the field exists to catch, and catching it as
 * "1 or refuse" is cheaper than discovering it as an entry that means something
 * else.
 */
function requireRequestVersion(body) {
  if (body.v !== 1) {
    throw new HostedContractError("invalid_request", "v must be 1", { field: "v" });
  }
}

/** One of the two edits, or a refusal naming both. */
function requireAction(action) {
  if (typeof action !== "string" || !ALLOWLIST_ACTIONS.includes(action)) {
    throw new HostedContractError(
      "invalid_request",
      `action must be one of: ${ALLOWLIST_ACTIONS.join(", ")}`,
      { field: "action" },
    );
  }
  return action;
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAdminAllowlistRoute(() => adminDependencies(process.env));
