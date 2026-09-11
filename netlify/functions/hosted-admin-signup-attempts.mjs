/**
 * `GET /api/hosted/admin/signup-attempts` - the verified addresses that signed
 * in and were turned away.
 *
 * The operator's view of who tried to use the deployment and was refused,
 * recorded by the callback at the moment of refusal so it exists whether or not
 * the person went on to submit the request-access form. One authorisation rule,
 * the same as the other admin reads: an admin, and nobody else. An address that
 * is *on* the list of the turned-away is refused here exactly as a stranger is -
 * having been refused sign-in does not entitle you to enumerate who else was.
 *
 * ## Why there is no `Origin` check
 *
 * A read needs a session and admin and nothing more, exactly as the document
 * census does. A cross-site `fetch` of this route cannot read the answer without
 * a CORS grant this deployment never issues, so refusing the request would only
 * turn a body nobody can read into a status nobody can read.
 */

import {
  ADMIN_SIGNUP_ATTEMPTS_PATH,
  adminEnvelope,
  requireAdmin,
  signupAttemptView,
} from "../lib/hosted/admin.mjs";
import { adminDependencies } from "../lib/hosted/admin-http.mjs";
import { identifyHosted } from "../lib/hosted/identity.mjs";
import { readSignupAttempts } from "../lib/hosted/signup-attempts.mjs";
import {
  browserError,
  browserJson,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: ADMIN_SIGNUP_ATTEMPTS_PATH };

/** The route, over injected dependencies. */
export function createAdminSignupAttemptsRoute(resolveDependencies) {
  return async function adminSignupAttemptsRoute(request) {
    const rejection = browserMethodRejection(request, "GET");
    if (rejection !== null) return rejection;

    try {
      const { config: hostedConfig, store, signupAttempts } = resolveDependencies();
      const principal = await identifyHosted(request, { store });
      requireAdmin(principal, hostedConfig);

      const attempts = await readSignupAttempts(signupAttempts);
      return browserJson(200, adminEnvelope({ attempts: attempts.map(signupAttemptView) }));
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAdminSignupAttemptsRoute(() => adminDependencies(process.env));
