/**
 * `GET|HEAD /admin` - the admin console shell.
 *
 * A page route rather than an API route, and one of the two exceptions
 * `scripts/check-function-modules.mjs` allows to the `/api/hosted/` namespace
 * rule. It earns that for the same reason `/docs/<id>` does: it is a stable
 * address a person types and bookmarks, not a URL this deployment is free to
 * move.
 *
 * The shell carries no document data and no allowlist - `admin.js` fetches both
 * through routes that authorise independently - so what this route actually
 * decides is one thing: whether the caller may see the console at all.
 *
 * ## Three answers, and why each is the status it is
 *
 * A signed-out visitor is redirected to sign in, because that is an action they
 * can take and a 401 page is not. A signed-in non-admin gets a 403 page: the
 * request was understood, the identity is known, the capability is missing, and
 * `/admin` is not a secret worth a 404 - it exists on every deployment of this
 * software. A storage outage is a 503, never a 403, because telling an admin
 * they are not an admin during an outage is the failure they would act on by
 * filing a bug against their own account.
 */

import { adminPage, forbiddenPage } from "../lib/hosted/admin.mjs";
import { adminDependencies } from "../lib/hosted/admin-http.mjs";
import { unavailablePage } from "../lib/hosted/documents.mjs";
import { identifyHosted } from "../lib/hosted/identity.mjs";
import { isAdmin } from "../lib/hosted/platform-access.mjs";
import { methodNotAllowed, redirectResponse } from "../lib/hosted/http.mjs";

export const config = { path: "/admin" };

/** Where a signed-out visitor is sent, and where they come back to. */
export const ADMIN_SIGN_IN = "/login/?destination=%2Fadmin";

/** The route, over injected dependencies. */
export function createAdminPageRoute(resolveDependencies) {
  return async function adminPageRoute(request) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return methodNotAllowed("GET, HEAD");
    }
    try {
      const { config: hostedConfig, store } = resolveDependencies();
      const principal = await identifyHosted(request, { store });
      if (principal === null) {
        /* A redirect rather than the 403 page: a visitor who has not signed in
           has not been refused anything yet. */
        return redirectResponse(ADMIN_SIGN_IN, { status: 303 });
      }
      if (!isAdmin(principal, hostedConfig.admins)) return forbiddenPage(request.method);
      return adminPage(principal.email, request.method);
    } catch {
      /* Every failure this route can reach is an outage, and it answers as one.
         `identifyHosted` throws `AuthUnavailableError` for a session store it
         could not read, `resolveDependencies` throws a configuration fault for a
         deployment missing a key, and an unexpected throw is not something to
         translate into a decision about who is an admin. Answering 403 on any of
         them would tell an admin they are not one, which is the failure they
         would act on by filing a bug against their own account. */
      return unavailablePage(request.method);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAdminPageRoute(() => adminDependencies(process.env));
