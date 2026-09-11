/**
 * `POST /api/hosted/access-request` - the request-access page's form.
 *
 * Reached only after a sign-in was turned away: the callback landed the visitor
 * on `/request-access/` and, for a verified address it did not admit, left an
 * `access_request` cookie whose one-time token names that verified address in
 * the store. This route is the one place in the hosted tree that an
 * almost-anonymous caller can cause the deployment to send email from, so the
 * order of its checks is the whole of its abuse story:
 *
 *  1. **Method, then origin.** The form submits by `fetch` from this
 *     deployment's own page, so the exact-`Origin` check applies with no
 *     form-navigation exemption. It removes the entire class of other people's
 *     pages submitting this form on a visitor's behalf.
 *  2. **The token, then media type, then body.** The `access_request` cookie is
 *     resolved to the verified address before anything else is read. No token -
 *     a fresh browser, an expired window, a page opened without a refused
 *     sign-in behind it - is `session_required`: sign in again, there is nothing
 *     to attribute a request to. The address is never taken from the body.
 *  3. **The rate claim, then the send.** In that order, and the claim is not
 *     released when the send fails. A budget refunded on failure is not a
 *     budget: anyone who can make sends fail gets unlimited attempts at the
 *     provider.
 *
 * ## It answers the same thing to everybody, and reveals no membership
 *
 * The address is read from the store, not the request, so the form cannot be
 * used to probe whether an arbitrary address is known: a caller can only ever
 * submit their own just-verified one. This route never consults the allowlist,
 * the publication store or the session store, so no query's result or timing
 * differs between an address that is already a user and one that is not.
 *
 * ## No account is registered by this code
 *
 * `readMailerConfig` returns `null` when a deployment has set no `ARCHON_EMAIL_*`
 * keys, and the route answers "not enabled". A deployment that wants these
 * emails sets four variables; nothing here signs up for anything or carries a
 * key. The recipient is the fixed operator address and nothing on the wire can
 * change it.
 */

import { getStore } from "@netlify/blobs";

import {
  ACCESS_REQUEST_SUBJECT,
  accessRequestMessage,
  claimRequestSubmission,
  createRequestRateStore,
  normalizeMessage,
  sourceKeyOf,
} from "../lib/hosted/access-requests.mjs";
import { openAuthStore } from "../lib/hosted/auth-store.mjs";
import { readHostedConfig } from "../lib/hosted/config.mjs";
import { HostedContractError } from "../lib/hosted/contracts.mjs";
import { ACCESS_REQUEST_COOKIE, readCookie, requireExactOrigin } from "../lib/hosted/identity.mjs";
import { MailerSendError, readMailerConfig, sendMail } from "../lib/hosted/mailer.mjs";
import {
  browserError,
  browserJson,
  browserJsonBody,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: "/api/hosted/access-request" };

/**
 * The one body an accepted submission gets.
 *
 * A literal, built from no input at all, for the reason `documents.mjs` gives
 * about its not-found page: a response assembled from the request is one edit
 * away from carrying something about it back to the sender.
 */
export const ACCEPTED = Object.freeze({ v: 1, status: "received" });

/** The route, over injected dependencies. */
export function createAccessRequestRoute(resolveDependencies) {
  return async function accessRequestRoute(request) {
    const rejection = browserMethodRejection(request, "POST");
    if (rejection !== null) return rejection;

    try {
      const { config: hostedConfig, mailer, rate, store, fetchImpl, now } = resolveDependencies();
      requireExactOrigin(request, hostedConfig);

      if (mailer === null) {
        throw new HostedContractError(
          "unavailable",
          "access requests are not enabled on this deployment",
        );
      }

      /* The verified address, from the one-time token and never the body. An
         absent or spent token is `session_required`: the same answer for a fresh
         browser, an expired window and a token minted for someone else, so it
         reveals nothing and cannot be used to probe an address. */
      const token = readCookie(request, ACCESS_REQUEST_COOKIE);
      const pending = token === null ? null : await store.readTransient("access_request", token);
      const email = pending?.payload?.email ?? null;
      if (typeof email !== "string" || email === "") {
        throw new HostedContractError(
          "session_required",
          "sign in again to request access",
        );
      }

      const body = await browserJsonBody(request);
      requireRequestVersion(body);
      const message = normalizeMessage(body.message);

      await claimRequestSubmission({ source: sourceKeyOf(request), now }, { store: rate });

      const at = now();
      try {
        await sendMail(
          { mailer, subject: ACCESS_REQUEST_SUBJECT, text: accessRequestMessage({ email, message, at }) },
          { fetchImpl },
        );
      } catch (error) {
        /* The provider's own failure is reported as a retryable outage of this
           service, with nothing of the provider's answer in it. The claim above
           stays spent - see the route note. */
        if (error instanceof MailerSendError) {
          throw new HostedContractError("unavailable", "the access request could not be delivered");
        }
        throw error;
      }

      /* 202: the request was accepted and the work - a person reading it - has
         not happened yet. */
      return browserJson(202, ACCEPTED);
    } catch (error) {
      return browserError(error);
    }
  };
}

/** The request envelope's version, checked before anything reads its payload. */
function requireRequestVersion(body) {
  if (body.v !== 1) {
    throw new HostedContractError("invalid_request", "v must be 1", { field: "v" });
  }
}

/**
 * The production dependency set.
 *
 * Assembled per request inside the route's own `try`, never at module load, so a
 * deployment with a malformed mail configuration answers this one route with a
 * 503 rather than throwing out of the function runtime at cold start.
 */
export function accessRequestDependencies(env = process.env) {
  return Object.freeze({
    config: readHostedConfig(env),
    mailer: readMailerConfig(env),
    rate: createRequestRateStore({ getStore }),
    store: openAuthStore(),
    fetchImpl: fetch,
    now: () => new Date(),
  });
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createAccessRequestRoute(() => accessRequestDependencies(process.env));
