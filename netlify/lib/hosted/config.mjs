/**
 * Operator configuration for the hosted deployment (contract C6).
 *
 * Everything this service is allowed to talk to is named here, and nothing is
 * guessed. Four properties are the whole design:
 *
 *  - **No defaults that point somewhere.** There is no fallback origin, no
 *    "derive it from the request Host header", no marketing hostname baked into
 *    the source. An unset origin is a configuration error, because the
 *    alternative - a service that invents its own trusted origin - is exactly
 *    the confused-deputy shape the two-origin split exists to prevent.
 *  - **Fail closed.** Malformed configuration throws. Publishing is disabled
 *    unless an operator has spelled `HOSTED_PUBLISH_ENABLED=true`, so the
 *    skeleton deploy this ticket lands refuses to start a publication even if a
 *    route were added under it by accident.
 *  - **The relaxed mode is not reachable from an environment.** Loopback-only
 *    local testing is selected by an *argument* to `readHostedConfig`, never by
 *    an environment variable. That is the difference between a test affordance
 *    and a production bypass: no value an operator can set on a Netlify site -
 *    deliberately, by accident, or "temporarily on a preview" - can turn off the
 *    HTTPS requirement or the two-site separation. This module reads exactly the
 *    keys listed below and nothing else.
 *  - **Secrets are unformattable.** `AUTH0_CLIENT_SECRET` is reachable only by
 *    calling `config.auth0.readClientSecret()`. It is not a property, so no
 *    combination of `JSON.stringify`, `util.inspect` (including
 *    `{showHidden: true, getters: true, customInspect: false}`), spread,
 *    `structuredClone` or template interpolation can render it - an inspector
 *    that walks properties finds a function, and a function does not print its
 *    closure. A getter would have been readable under that one inspect
 *    combination, which is the difference between "usually redacted" and
 *    "cannot be printed".
 */

import { inspect } from "node:util";

import { isLoopbackOrigin, registrableSite, validateOrigin, HostedContractError } from "./contracts.mjs";

/** What a secret renders as everywhere it could be rendered. */
export const REDACTED = "[redacted]";

/**
 * The environment variables this module reads: C6's keys plus ACN-007's
 * public-mailbox override, and nothing else - the local-test mode is an
 * argument, not one more key.
 */
export const HOSTED_CONFIG_KEYS = Object.freeze([
  "HOSTED_APP_ORIGIN",
  "HOSTED_RENDER_ORIGIN",
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "HOSTED_PUBLISH_ENABLED",
  "ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS",
]);

/**
 * The two deployment modes, selected by argument.
 *
 * `production` is the default, and the default is the strict one. `local-test`
 * means what the ticket says it means: an explicitly injected, loopback-only
 * configuration. Both origins must be loopback hosts, so the mode cannot
 * describe a real deployment even if a caller passed it by mistake - which is
 * what keeps "relaxed scheme rules" from also meaning "no site separation".
 */
export const PRODUCTION = "production";
export const LOCAL_TEST = "local-test";
const HOSTED_MODES = Object.freeze([PRODUCTION, LOCAL_TEST]);

/**
 * A configuration fault, naming the environment variable but never its value.
 *
 * The value is the one thing that must not appear: half of these keys carry a
 * credential, and a startup exception is copied into logs, alerts and issue
 * comments without anybody rereading it first.
 */
export class HostedConfigError extends Error {
  constructor(key, rule, { cause } = {}) {
    super(`${key} ${rule}`);
    this.name = "HostedConfigError";
    this.code = "invalid_configuration";
    this.key = key;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A present, non-empty environment value, or a configuration error.
 *
 * Absent and empty are one condition rather than two because they are one
 * situation: an operator who has not set a key and an operator who has set it
 * to the empty string have both not configured it. The check has to happen
 * here, before any per-key format rule, because a missing value coerces
 * treacherously - `/^[A-Za-z0-9._-]{8,128}$/.test(undefined)` tests the string
 * `"undefined"` and passes, so an unset `AUTH0_CLIENT_ID` would otherwise be
 * accepted as a nine-character client id.
 */
function requiredValue(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value === "") {
    throw new HostedConfigError(key, "is required");
  }
  return value;
}

/**
 * An origin from the environment.
 *
 * `validateOrigin` throws a `HostedContractError` whose message names a field
 * path; it is re-thrown as a configuration error naming the environment
 * variable, because "descriptor.title must be lowercase" is not a useful thing
 * to read in a deploy log. The original is kept as `cause` and carries a rule,
 * never a value.
 */
function requiredOrigin(env, key, production) {
  const value = requiredValue(env, key);
  try {
    return validateOrigin(value, { production, field: key });
  } catch (error) {
    if (error instanceof HostedContractError) {
      throw new HostedConfigError(key, error.message.slice(key.length + 1), { cause: error });
    }
    throw error;
  }
}

/**
 * A strictly spelled boolean.
 *
 * Only `true` and `false` are accepted, and anything else is a fault rather
 * than a falsy default. `HOSTED_PUBLISH_ENABLED=1` silently meaning "disabled"
 * is the failure mode an operator discovers from a support ticket; unset
 * meaning disabled is the failure mode they intended.
 */
function optionalBoolean(env, key) {
  const value = env[key];
  if (value === undefined || value === null || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HostedConfigError(key, 'must be exactly "true" or "false" when set');
}

/**
 * The Auth0 OIDC credential, with the secret behind a call rather than a
 * property.
 *
 * The secret lives in this closure and is never a property of anything, so
 * there is no descriptor for an inspector to find and no getter for
 * `{getters: true}` to invoke. `readClientSecret()` is deliberately a verb: the
 * one call site that performs the code exchange says out loud that it is
 * reading a secret, and every other reader gets `[redacted]`. `domain` and
 * `clientId` are public - they appear in the authorize URL a browser is
 * redirected to - so they are ordinary enumerable properties.
 */
function buildAuth0Credential(domain, clientId, clientSecret) {
  const redactedView = () => ({ domain, clientId, clientSecret: REDACTED });
  const credential = {};
  Object.defineProperties(credential, {
    domain: { value: domain, enumerable: true },
    clientId: { value: clientId, enumerable: true },
    readClientSecret: { value: () => clientSecret, enumerable: false },
    toJSON: { value: redactedView, enumerable: false },
    [inspect.custom]: { value: redactedView, enumerable: false },
    toString: {
      value: () => `Auth0Credential(${domain}, ${clientId}, ${REDACTED})`,
      enumerable: false,
    },
  });
  return Object.freeze(credential);
}

/**
 * Read and validate the hosted deployment's configuration.
 *
 * @param {Record<string, string | undefined>} env the environment to read.
 *   Passed in rather than read from the ambient process environment, so a test can inject a
 *   complete fixture; the fixture is held to every rule a deploy is held to.
 * @param {{mode?: "production" | "local-test"}} [options] `local-test` is the
 *   loopback-only mode. It is an argument on purpose: nothing an operator can
 *   set on a deployed site can select it.
 * @returns {Readonly<{
 *   mode: "production" | "local-test",
 *   production: boolean,
 *   appOrigin: string,
 *   renderOrigin: string,
 *   appSite: string | null,
 *   renderSite: string | null,
 *   publishEnabled: boolean,
 *   allowPublicMailboxes: boolean,
 *   auth0: Readonly<{domain: string, clientId: string, readClientSecret: () => string}>,
 * }>}
 * @throws {HostedConfigError} naming the offending key, never its value
 */
export function readHostedConfig(env, { mode = PRODUCTION } = {}) {
  if (env === null || typeof env !== "object") {
    throw new HostedConfigError("env", "must be an object of environment variables");
  }
  if (!HOSTED_MODES.includes(mode)) {
    throw new HostedConfigError("mode", `must be one of: ${HOSTED_MODES.join(", ")}`);
  }
  const production = mode === PRODUCTION;

  const appOrigin = requiredOrigin(env, "HOSTED_APP_ORIGIN", production);
  const renderOrigin = requiredOrigin(env, "HOSTED_RENDER_ORIGIN", production);

  if (appOrigin === renderOrigin) {
    throw new HostedConfigError(
      "HOSTED_RENDER_ORIGIN",
      "must not be the same origin as HOSTED_APP_ORIGIN",
    );
  }

  let appSite = null;
  let renderSite = null;
  if (production) {
    /* C1/C6: "two origins" means two registrable sites, not two hostnames under
       one. Sibling subdomains share cookies and share a site for SameSite
       purposes, so a renderer at `render.example.com` beside an app at
       `app.example.com` is not the cookie-free origin the design depends on.
       The comparison uses the public-suffix list through pinned `tldts` with
       private suffixes enabled; comparing the last two labels would call
       `a.pages.dev` and `b.pages.dev` one site and get this exactly wrong. */
    appSite = registrableSite(appOrigin, { field: "HOSTED_APP_ORIGIN" });
    renderSite = registrableSite(renderOrigin, { field: "HOSTED_RENDER_ORIGIN" });
    if (appSite === renderSite) {
      throw new HostedConfigError(
        "HOSTED_RENDER_ORIGIN",
        "must be a different registrable site from HOSTED_APP_ORIGIN in production",
      );
    }
  } else {
    /* Loopback hosts have no registrable site to compare, so the separation
       rule above cannot run in local-test mode. Requiring both origins to *be*
       loopback is what stops that from becoming a hole: a caller who passed
       `local-test` by mistake cannot thereby configure two real sibling
       subdomains with the site check silently skipped. */
    for (const [key, origin] of [
      ["HOSTED_APP_ORIGIN", appOrigin],
      ["HOSTED_RENDER_ORIGIN", renderOrigin],
    ]) {
      if (!isLoopbackOrigin(origin)) {
        throw new HostedConfigError(key, "must be a loopback origin in local-test mode");
      }
    }
  }

  const domain = requiredValue(env, "AUTH0_DOMAIN");
  /* A host and nothing else: no scheme, no path, no port, no trailing slash. The
     authorize, token, JWKS and logout URLs are all built by prefixing `https://`
     and suffixing a fixed path, so a domain carrying a scheme or a path would be
     a redirect-to-anywhere primitive behind a name that reads like a setting.
     Labels are lowercase `[a-z0-9-]`, no leading or trailing hyphen, at least
     two of them, which admits both `tenant.us.auth0.com` and a custom domain. */
  if (
    domain.length > 253 ||
    !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    throw new HostedConfigError(
      "AUTH0_DOMAIN",
      "must be a bare lowercase host of at least two DNS labels, with no scheme, port, path or trailing slash",
    );
  }

  const clientId = requiredValue(env, "AUTH0_CLIENT_ID");
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) {
    throw new HostedConfigError("AUTH0_CLIENT_ID", "must be 8-128 characters of [A-Za-z0-9._-]");
  }
  const clientSecret = requiredValue(env, "AUTH0_CLIENT_SECRET");
  if (clientSecret.length < 16 || /\s/.test(clientSecret)) {
    throw new HostedConfigError(
      "AUTH0_CLIENT_SECRET",
      "must be at least 16 characters with no whitespace",
    );
  }
  if (clientSecret === clientId) {
    throw new HostedConfigError("AUTH0_CLIENT_SECRET", "must not equal AUTH0_CLIENT_ID");
  }

  const publishEnabled = optionalBoolean(env, "HOSTED_PUBLISH_ENABLED");

  /* ACN-007's one escape hatch, read through this validated reader rather than
     out of the ambient environment at the point of use, so that a value which
     is neither "true" nor "false" is a configuration error the deployment
     refuses rather than a truthy string that quietly opens every document to a
     mailbox provider. Off unless an operator spells it exactly, like every
     other flag here. */
  const allowPublicMailboxes = optionalBoolean(env, "ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS");

  const auth0 = buildAuth0Credential(domain, clientId, clientSecret);
  const redactedView = () => ({
    mode,
    production,
    appOrigin,
    renderOrigin,
    appSite,
    renderSite,
    publishEnabled,
    allowPublicMailboxes,
    auth0: { domain, clientId, clientSecret: REDACTED },
  });

  const config = {
    mode,
    production,
    appOrigin,
    renderOrigin,
    appSite,
    renderSite,
    publishEnabled,
    allowPublicMailboxes,
    auth0,
  };
  Object.defineProperties(config, {
    toJSON: { value: redactedView, enumerable: false },
    [inspect.custom]: { value: redactedView, enumerable: false },
  });
  return Object.freeze(config);
}

/**
 * A one-line, log-safe rendering of a configuration.
 *
 * Deliberately built field by field rather than by serialising the object: a
 * formatter that starts from "everything except the secrets" acquires a leak
 * the next time a field is added, while one that starts from nothing acquires
 * at worst a missing field.
 *
 * @param {ReturnType<typeof readHostedConfig>} config
 * @returns {string}
 */
export function formatHostedConfig(config) {
  return [
    `mode=${config.mode}`,
    `app=${config.appOrigin}`,
    `render=${config.renderOrigin}`,
    `publish=${config.publishEnabled ? "enabled" : "disabled"}`,
    `publicMailboxDomains=${config.allowPublicMailboxes ? "allowed" : "refused"}`,
    `auth0Domain=${config.auth0.domain}`,
    `auth0ClientId=${config.auth0.clientId}`,
    `auth0ClientSecret=${REDACTED}`,
  ].join(" ");
}
