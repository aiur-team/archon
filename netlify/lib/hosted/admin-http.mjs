/**
 * The dependency set the three admin routes share.
 *
 * Separate from `publications-browser-http.mjs` because the admin routes need
 * two things that module does not assemble - the allowlist record store and the
 * publication store *directly*, rather than through the publication state
 * machine. Reaching the adapter directly is correct here and worth saying out
 * loud: the census enumerates records and decides nothing about them, so routing
 * it through `publications.mjs` would mean adding a list operation to the state
 * machine that has no state to transition.
 *
 * Everything else is deliberately reused rather than restated: the response
 * envelope, the error translation, the JSON body parser and the no-CORS
 * property all come from the browser shell, so an admin route tells a caller the
 * same thing in the same shape as every other browser-facing route.
 */

import { getStore } from "@netlify/blobs";

import { createAllowlistStore } from "./allowlist.mjs";
import { openAuthStore } from "./auth-store.mjs";
import { readHostedConfig } from "./config.mjs";
import { createPublicationStore } from "./publication-store.mjs";
import { createSignupAttemptsStore } from "./signup-attempts.mjs";

/**
 * The production dependency set for an admin route.
 *
 * Assembled per request inside the route's own `try`, never at module load, for
 * the reason every hosted route assembles its own: the module gate imports every
 * file in this tree with no credential present, and a deployment missing a
 * configuration key must answer 503 rather than throw out of the function
 * runtime at cold start.
 */
export function adminDependencies(env = process.env) {
  return Object.freeze({
    config: readHostedConfig(env),
    store: openAuthStore(),
    allowlist: createAllowlistStore({ getStore }),
    publications: createPublicationStore({ getStore }),
    signupAttempts: createSignupAttemptsStore({ getStore }),
  });
}
