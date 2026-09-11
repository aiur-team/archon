/**
 * `POST /api/hosted/invite-request` - the splash page's "request an invite" form.
 *
 * The one route in the hosted tree that an anonymous stranger can reach and that
 * causes this deployment to send email, so the order of its checks is the whole
 * of its abuse story:
 *
 *  1. **Method, then origin.** The form submits by `fetch` from this
 *     deployment's own splash page, so the exact-`Origin` check applies with no
 *     form-navigation exemption. It is not the real control - an attacker sends
 *     whatever headers they like - but it costs nothing and removes the entire
 *     class of other people's pages quietly submitting this form on a visitor's
 *     behalf.
 *  2. **Media type, then body, then the address.** `application/json` only,
 *     which is the one thing a cross-origin `<form>` cannot send without a
 *     preflight. Refusing an unparseable body before the counter is touched
 *     means garbage costs a parse rather than a write.
 *  3. **The rate claim, then the send.** In that order, and the claim is not
 *     released when the send fails. A budget refunded on failure is not a
 *     budget: anyone who can make sends fail gets unlimited attempts at the
 *     provider.
 *
 * ## It answers the same thing to everybody
 *
 * A submission that was accepted gets one fixed body, and this route never
 * consults the allowlist, the session store or the publication store - so there
 * is no query whose result or timing could differ between an address that is
 * already a user and one that is not. The three other answers it can give are
 * about the *request* (malformed, too many, not configured), never about the
 * address.
 *
 * ## No account is registered by this code
 *
 * `readMailerConfig` returns `null` when a deployment has set no `ARCHON_EMAIL_*`
 * keys, and the route answers "not enabled". A deployment that wants invite
 * emails sets four variables; nothing here signs up for anything or carries a
 * key.
 */

import { getStore } from "@netlify/blobs";

import { readHostedConfig } from "../lib/hosted/config.mjs";
import { HostedContractError } from "../lib/hosted/contracts.mjs";
import { requireExactOrigin } from "../lib/hosted/identity.mjs";
import {
  INVITE_SUBJECT,
  claimInviteSubmission,
  createInviteRateStore,
  inviteMessage,
  normalizeMessage,
  normalizeRequesterEmail,
  sourceKeyOf,
} from "../lib/hosted/invite-requests.mjs";
import { MailerSendError, readMailerConfig, sendMail } from "../lib/hosted/mailer.mjs";
import {
  browserError,
  browserJson,
  browserJsonBody,
  browserMethodRejection,
} from "../lib/hosted/publications-browser-http.mjs";

export const config = { path: "/api/hosted/invite-request" };

/**
 * The one body an accepted submission gets.
 *
 * A literal, built from no input at all, for the reason `documents.mjs` gives
 * about its not-found page: a response assembled from the request is one edit
 * away from carrying something about it back to the sender.
 */
export const ACCEPTED = Object.freeze({ v: 1, status: "received" });

/** The route, over injected dependencies. */
export function createInviteRequestRoute(resolveDependencies) {
  return async function inviteRequestRoute(request) {
    const rejection = browserMethodRejection(request, "POST");
    if (rejection !== null) return rejection;

    try {
      const { config: hostedConfig, mailer, rate, fetchImpl, now } = resolveDependencies();
      requireExactOrigin(request, hostedConfig);

      if (mailer === null) {
        throw new HostedContractError(
          "unavailable",
          "invite requests are not enabled on this deployment",
        );
      }

      const body = await browserJsonBody(request);
      requireRequestVersion(body);
      const email = normalizeRequesterEmail(body.email);
      const message = normalizeMessage(body.message);

      await claimInviteSubmission({ source: sourceKeyOf(request), now }, { store: rate });

      const at = now();
      try {
        await sendMail(
          { mailer, subject: INVITE_SUBJECT, text: inviteMessage({ email, message, at }) },
          { fetchImpl },
        );
      } catch (error) {
        /* The provider's own failure is reported as a retryable outage of this
           service, with nothing of the provider's answer in it. The claim above
           stays spent - see the route note. */
        if (error instanceof MailerSendError) {
          throw new HostedContractError("unavailable", "the invite request could not be delivered");
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
export function inviteDependencies(env = process.env) {
  return Object.freeze({
    config: readHostedConfig(env),
    mailer: readMailerConfig(env),
    rate: createInviteRateStore({ getStore }),
    fetchImpl: fetch,
    now: () => new Date(),
  });
}

/** The Netlify entry point: the same route, wired to the real dependencies. */
export default createInviteRequestRoute(() => inviteDependencies(process.env));
