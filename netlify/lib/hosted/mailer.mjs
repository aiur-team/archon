/**
 * The transactional email transport, and the one message this deployment sends.
 *
 * Before this module the notifier was Slack-only (`netlify/lib/notify.mjs`), and
 * the hosted tree had no way to reach a person at all. The access-request form a
 * turned-away sign-in lands on needs one, so this is it - deliberately the
 * smallest thing that is a real transport rather than a general mail library.
 *
 * ## What is and is not configured here
 *
 * Four keys, read by this module and named by `MAILER_CONFIG_KEYS`. They are not
 * part of `readHostedConfig`'s set on purpose: every key that reader validates is
 * one a deployment cannot serve *any* hosted request without, and email is not
 * that. A deployment with no mail configuration serves everything else normally
 * and answers the access-request route with "not enabled", which is a far better
 * failure than a site that refuses to sign anybody in because nobody set a
 * sender address.
 *
 * The API key is behind a call rather than a property, exactly as
 * `AUTH0_CLIENT_SECRET` is, and for the reason that module's note gives: a
 * function does not print its closure, so no combination of `JSON.stringify`,
 * `util.inspect` with `{showHidden: true, getters: true}`, spread or template
 * interpolation can render it.
 *
 * ## One provider, named exactly
 *
 * `ARCHON_EMAIL_PROVIDER` must be the literal `resend`, and the endpoint is a
 * constant in this file. That is the whole point of naming it: the alternative
 * shape - a configurable endpoint URL - is a server-side request forgery
 * primitive behind a name that reads like a setting, and this route can be
 * reached by an anonymous visitor. Adding a second provider is a diff here,
 * where the request shape and the endpoint are next to each other.
 *
 * **No account is registered by this code and no key is committed.** An operator
 * who wants invite emails signs up, sets four variables, and the route starts
 * working; until then it reports itself unavailable.
 */

import { normalizeEmailOrNull } from "./email.mjs";

/** The environment variables this module reads, and nothing else. */
export const MAILER_CONFIG_KEYS = Object.freeze([
  "ARCHON_EMAIL_PROVIDER",
  "ARCHON_EMAIL_API_KEY",
  "ARCHON_EMAIL_SENDER",
  "ARCHON_EMAIL_RECIPIENT",
]);

/** The only provider this version speaks. */
export const SUPPORTED_PROVIDERS = Object.freeze(["resend"]);

/** The provider's send endpoint. A constant, never configuration. */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** What a secret renders as everywhere it could be rendered. */
export const REDACTED = "[redacted]";

/** How long one send may take before it is abandoned as an outage. */
export const SEND_TIMEOUT_MS = 10_000;

/** A mail configuration fault, naming the variable but never its value. */
export class MailerConfigError extends Error {
  constructor(key, rule) {
    super(`${key} ${rule}`);
    this.name = "MailerConfigError";
    this.code = "invalid_configuration";
    this.key = key;
  }
}

/** A send that did not happen. Always retryable; never carries a provider body. */
export class MailerSendError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailerSendError";
    this.code = "unavailable";
  }
}

/**
 * The mail configuration, `null` when the feature is not configured, or a fault.
 *
 * All four keys or none. A partial configuration is a fault rather than a
 * silent "not enabled", because it is the state an operator reaches *while
 * setting this up*, and the failure they need to see is "you have not set the
 * sender" rather than a form that keeps accepting submissions and mailing
 * nobody.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Readonly<{provider: string, sender: string, recipient: string, readApiKey: () => string}> | null}
 */
export function readMailerConfig(env) {
  if (env === null || typeof env !== "object") {
    throw new MailerConfigError("env", "must be an object of environment variables");
  }
  const present = MAILER_CONFIG_KEYS.filter(
    (key) => typeof env[key] === "string" && env[key] !== "",
  );
  if (present.length === 0) return null;
  if (present.length !== MAILER_CONFIG_KEYS.length) {
    const missing = MAILER_CONFIG_KEYS.filter((key) => !present.includes(key));
    throw new MailerConfigError(missing[0], "is required once any ARCHON_EMAIL_* key is set");
  }

  const provider = env.ARCHON_EMAIL_PROVIDER;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new MailerConfigError(
      "ARCHON_EMAIL_PROVIDER",
      `must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }

  const apiKey = env.ARCHON_EMAIL_API_KEY;
  if (apiKey.length < 16 || /\s/.test(apiKey)) {
    throw new MailerConfigError(
      "ARCHON_EMAIL_API_KEY",
      "must be at least 16 characters with no whitespace",
    );
  }

  /* Both addresses go through the deployment's one address grammar. A sender the
     provider will reject is a configuration error worth finding at startup, and
     a recipient that is not an address is an invite request that goes nowhere
     while the form keeps saying "thanks". */
  const sender = normalizeEmailOrNull(env.ARCHON_EMAIL_SENDER);
  if (sender === null) throw new MailerConfigError("ARCHON_EMAIL_SENDER", "must be an email address");
  const recipient = normalizeEmailOrNull(env.ARCHON_EMAIL_RECIPIENT);
  if (recipient === null) {
    throw new MailerConfigError("ARCHON_EMAIL_RECIPIENT", "must be an email address");
  }

  const redactedView = () => ({ provider, sender, recipient, apiKey: REDACTED });
  const mailer = {};
  Object.defineProperties(mailer, {
    provider: { value: provider, enumerable: true },
    sender: { value: sender, enumerable: true },
    recipient: { value: recipient, enumerable: true },
    readApiKey: { value: () => apiKey, enumerable: false },
    toJSON: { value: redactedView, enumerable: false },
    toString: {
      value: () => `Mailer(${provider}, ${sender}, ${recipient}, ${REDACTED})`,
      enumerable: false,
    },
  });
  return Object.freeze(mailer);
}

/**
 * Send one message through the configured provider.
 *
 * `fetchImpl` is injected so the tests drive the real request-building code
 * against a double: what is being verified is the headers, the body and how a
 * provider failure is reported, and none of that needs a network.
 *
 * A non-2xx answer and a transport throw are one outcome - `MailerSendError` -
 * and the provider's response body is deliberately discarded. It is the least
 * controlled string available here and it reaches a route an anonymous visitor
 * calls; the caller already knows which message failed.
 *
 * @throws {MailerSendError}
 */
export async function sendMail({ mailer, subject, text }, { fetchImpl = fetch } = {}) {
  if (mailer === null || mailer === undefined) {
    throw new MailerSendError("email is not configured for this deployment");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mailer.readApiKey()}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        from: mailer.sender,
        to: [mailer.recipient],
        subject,
        text,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new MailerSendError("the email provider could not be reached");
  } finally {
    clearTimeout(timer);
  }
  if (response === null || typeof response !== "object" || typeof response.status !== "number") {
    throw new MailerSendError("the email provider returned an unusable response");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new MailerSendError("the email provider refused the message");
  }
  return Object.freeze({ sent: true });
}
