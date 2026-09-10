/**
 * Who a collaboration request is, and whether it came from this application.
 *
 * There is one identity system on this site now. This module used to delegate
 * wholesale to Netlify Identity — `getUser()` for the principal, an
 * `ORG_EMAIL_DOMAIN` suffix test for organisation membership, and
 * `verifyRequestOrigin()` for the CSRF check. All three are gone. The
 * collaboration layer reads exactly the session AHU-003 issues: the opaque
 * `__Host-archon_session` cookie, validated through
 * `netlify/lib/hosted/identity.mjs`, which is also what the hosted document
 * read path and the publication flow ask.
 *
 * ## The null that is not a null, restated in this tree's vocabulary
 *
 * `identifyHosted` answers `null` for an absent, expired or revoked session and
 * *throws* `AuthUnavailableError` when the backing store could not be read. That
 * distinction is the whole point of it, and it has to survive the crossing into
 * this tree: a store outage spelled as "signed out" would send every visitor to
 * the sign-in page during an incident, and — worse — would let an anonymous read
 * be indistinguishable from a real one.
 *
 * So the outage is *translated* rather than re-invented. The collaboration layer
 * already has a word for it: `StoreError` with code `unavailable` and status
 * 503, which `/api/session` maps to a 503 and every other handler already
 * distinguishes from a bug. Re-throwing the hosted error unchanged would have
 * meant teaching a second error shape to nine handlers, each of which would have
 * been one edit away from reading the outage as a 500. One translation here is
 * the smaller and the safer change.
 *
 * ## Why there is no organisation rule left
 *
 * `ORG_EMAIL_DOMAIN` classified an address by `endsWith`, which is the suffix
 * match that calls `member@example.com.evil.com` an organisation mailbox. It was
 * also site-wide: one setting decided membership for every document on the
 * deployment. Per-document domain lists replace it (ACN-008), evaluated by the
 * exact-label evaluator in `netlify/lib/hosted/domain-access.mjs`. Nothing here
 * derives a role from an address any more; `resolveRole()` in
 * `netlify/lib/access.mjs` remains the only role authority in the platform.
 */

import { AuthUnavailableError } from "./hosted/auth-errors.mjs";
import { openAuthStore } from "./hosted/auth-store.mjs";
import { HOSTED_CONFIG_KEYS, readHostedConfig } from "./hosted/config.mjs";
import { normalizeEmailOrNull } from "./hosted/email.mjs";
import { identifyHosted, requireExactOrigin } from "./hosted/identity.mjs";
import { StoreError } from "./store.mjs";

/**
 * The hosted configuration keys, read through the runtime-native narrow
 * environment API on Deno and `process.env` on Node.
 *
 * Named keys rather than a whole environment object: `Netlify.env` exposes a
 * `get` and this module has no business handing the rest of a deployment's
 * environment to anything. A runtime that throws on a read yields an absent
 * value, which `readHostedConfig` refuses — the fail-closed direction.
 *
 * @returns {Record<string, string | undefined>}
 */
function readHostedEnv() {
  const env = {};
  let runtime;
  try {
    runtime = globalThis.Netlify?.env;
  } catch {
    runtime = undefined;
  }
  const useRuntime = runtime !== undefined && runtime !== null && typeof runtime.get === "function";
  for (const key of HOSTED_CONFIG_KEYS) {
    try {
      env[key] = useRuntime ? runtime.get(key) : globalThis.process?.env?.[key];
    } catch {
      env[key] = undefined;
    }
  }
  return env;
}

/** The collaboration layer's existing word for "the store could not be read". */
function unavailable(cause) {
  return new StoreError("unavailable", 503, "State store unavailable", { cause });
}

/**
 * The signed-in caller behind a collaboration request, or `null` when nobody is.
 *
 * `sub` is the C1 version 2 `accountId` and is the only ownership and grant key
 * this platform has. `email` is the normalized address, or the empty string when
 * the identity carries none or carries one this repository's single address
 * grammar refuses — a GitHub identity with no email is a valid session that
 * matches no invitation. `emailVerified` is a strict boolean and is what an
 * invitation is actually satisfied by; `netlify/lib/access.mjs` will not match an
 * address the provider has not proved.
 *
 * The store is a parameter so a test drives this with data rather than a
 * provider. It is opened lazily, per call, because module load must not reach a
 * store: `scripts/check-function-modules.mjs` imports every deployed module with
 * no credential present.
 *
 * @param {Request} req
 * @param {{ store?: object }} [dependencies]
 * @returns {Promise<null | {
 *   sub: string,
 *   email: string,
 *   emailVerified: boolean,
 *   name: string
 * }>}
 * @throws {StoreError} code `unavailable`, status 503, when the session store
 *   could not be read. An outage is never spelled as a signed-out visitor.
 */
export async function identify(req, { store } = {}) {
  let principal;
  try {
    principal = await identifyHosted(req, { store: store ?? openAuthStore() });
  } catch (error) {
    if (error instanceof AuthUnavailableError) throw unavailable(error);
    throw error;
  }
  if (principal === null) {
    return null;
  }

  /* `principal.email` is already the provider's address and is `null` when there
     is none. It is normalized again here rather than trusted, because this is the
     value that becomes an invitation-key hash: one grammar, applied once, on the
     way in. A value the grammar refuses degrades to "no usable address" rather
     than throwing, so a provider that starts emitting an address shape this
     repository does not accept locks nobody out of a document they already own. */
  const email = normalizeEmailOrNull(principal.email) ?? "";

  /* An unverified address is carried but never matched: `emailVerified` is the
     field that decides, and it is the provider's claim rather than ours. */
  const emailVerified = principal.emailVerified === true && email !== "";

  return { sub: principal.accountId, email, emailVerified, name: principal.login };
}

/**
 * The collaboration layer's CSRF check: this request came from this application.
 *
 * Exact string equality against the configured `HOSTED_APP_ORIGIN`, through the
 * same `requireExactOrigin` the hosted routes use — not a suffix, not a
 * hostname, not a regular expression, and a missing `Origin` header is a refusal
 * rather than a pass. The form-navigation exemption the hosted sign-in forms need
 * is deliberately not taken here: every collaboration caller is a `fetch`, which
 * appends a real `Origin` on a same-origin request.
 *
 * A deployment with no hosted configuration refuses rather than admits. That is
 * the settled behaviour for a `scripts/connect.mjs` consumer that never
 * configured Auth0: sign-in returns 503, `identify()` answers `null` for
 * everybody, and a mutation that reached this far is refused for want of an
 * origin to compare against.
 *
 * @param {Request} req
 * @returns {void}
 * @throws {Response} A normalized 403 response when origin verification fails.
 */
export function requireOrigin(req) {
  try {
    requireExactOrigin(req, readHostedConfig(readHostedEnv()));
  } catch {
    throw new Response("Bad origin", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

/**
 * Whether this deployment lets a document list a public mailbox provider.
 *
 * ACN-007's one escape hatch, `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS`, read through
 * the same validated hosted configuration everything else on this boundary uses.
 * It lives here rather than in `netlify/functions/access.mjs` for the reason the
 * rest of this module exists: the collaboration tree asks hosted configuration
 * questions through exactly one seam, so there is one place that knows how a
 * hosted key is spelled and one place a test has to stub.
 *
 * The strictness is the point. `readHostedConfig` refuses a value that is
 * neither `"true"` nor `"false"`, so a deployment that set it to `"yes"` fails
 * loudly instead of quietly letting an owner list `gmail.com` — which would
 * publish a document its owner believes is private.
 *
 * @returns {boolean}
 * @throws {HostedConfigError} when the deployment's hosted configuration is
 *   unreadable. The caller has already passed `requireOrigin()`, which reads the
 *   same configuration, so this is a server fault rather than a bad request.
 */
export function allowPublicMailDomains() {
  return readHostedConfig(readHostedEnv()).allowPublicMailboxes;
}
