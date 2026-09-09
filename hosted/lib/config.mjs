/**
 * Operator configuration for the hosted deployment (contract C6).
 *
 * Everything this service is allowed to talk to is named here, and nothing is
 * guessed. Three properties are the whole design:
 *
 *  - **No defaults that point somewhere.** There is no fallback origin, no
 *    "derive it from the request Host header", no marketing hostname baked into
 *    the source. An unset origin is a configuration error, because the
 *    alternative — a service that invents its own trusted origin — is exactly
 *    the confused-deputy shape the two-origin split exists to prevent.
 *  - **Fail closed.** Malformed configuration throws. Publishing is disabled
 *    unless an operator has spelled `HOSTED_PUBLISH_ENABLED=true`, so the
 *    skeleton deploy this ticket lands refuses to start a publication even if a
 *    route were added under it by accident.
 *  - **Secrets are unformattable.** `GITHUB_CLIENT_SECRET` is reachable only
 *    through an explicitly named, non-enumerable getter. `JSON.stringify`,
 *    `util.inspect`, a template string, a thrown configuration error and this
 *    module's own `formatHostedConfig` all render it as `[redacted]`. A secret
 *    that is merely "not usually logged" reaches a log the first time somebody
 *    prints the config object while debugging.
 *
 * `readHostedConfig(env)` takes the environment as an argument rather than
 * reading `process.env`, which is what lets a test inject a complete, explicit
 * fixture configuration. That is not a bypass: a fixture must satisfy every
 * rule a deploy satisfies, and the only thing `HOSTED_ENV=local-test` relaxes
 * is permitting `http` on a loopback host.
 */

import { inspect } from "node:util";

import { registrableSite, validateOrigin, HostedContractError } from "./contracts.mjs";

/** What a secret renders as everywhere it could be rendered. */
export const REDACTED = "[redacted]";

/** The environment variables this module reads. Nothing else is consulted. */
export const HOSTED_CONFIG_KEYS = Object.freeze([
  "HOSTED_ENV",
  "HOSTED_APP_ORIGIN",
  "HOSTED_RENDER_ORIGIN",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "HOSTED_PUBLISH_ENABLED",
]);

/**
 * The two deployment modes.
 *
 * `production` is the default, and the default is the strict one: a missing or
 * unrecognised `HOSTED_ENV` gets production parsing rather than a permissive
 * one. `local-test` is named for what it is so that a deploy preview — a real
 * site on the real internet — cannot silently inherit loopback allowances by
 * being "not production".
 */
const PRODUCTION = "production";
const LOCAL_TEST = "local-test";
const HOSTED_ENVS = Object.freeze([PRODUCTION, LOCAL_TEST]);

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
 * treacherously -- `/^[A-Za-z0-9._-]{8,128}$/.test(undefined)` tests the string
 * `"undefined"` and passes, so an unset `GITHUB_CLIENT_ID` would otherwise be
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
 * to read in a deploy log. The original is kept as `cause` and carries no
 * value, only a rule.
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
 * The GitHub OAuth credential, with the secret behind a named getter.
 *
 * The secret is held in this closure and never becomes an enumerable property,
 * so it is invisible to `JSON.stringify`, to `util.inspect` (which skips
 * non-enumerable properties by default) and to object spread. Reading it is
 * possible and deliberate — `config.github.clientSecret` at the one place that
 * performs the code exchange — but it cannot happen by accident.
 */
function buildGitHubCredential(clientId, clientSecret) {
  const redactedView = () => ({ clientId, clientSecret: REDACTED });
  const credential = {};
  Object.defineProperties(credential, {
    clientId: { value: clientId, enumerable: true },
    clientSecret: {
      get: () => clientSecret,
      enumerable: false,
      configurable: false,
    },
    toJSON: { value: redactedView, enumerable: false },
    [inspect.custom]: { value: redactedView, enumerable: false },
    toString: { value: () => `GitHubCredential(${clientId}, ${REDACTED})`, enumerable: false },
  });
  return Object.freeze(credential);
}

/**
 * Read and validate the hosted deployment's configuration.
 *
 * @param {Record<string, string | undefined>} env the environment to read.
 *   Passed in rather than taken from `process.env` so a test can inject a
 *   complete fixture; the fixture is held to every rule a deploy is held to.
 * @returns {Readonly<{
 *   hostedEnv: "production" | "local-test",
 *   production: boolean,
 *   appOrigin: string,
 *   renderOrigin: string,
 *   appSite: string | null,
 *   renderSite: string | null,
 *   publishEnabled: boolean,
 *   github: Readonly<{clientId: string, clientSecret: string}>,
 * }>}
 * @throws {HostedConfigError} naming the offending key, never its value
 */
export function readHostedConfig(env) {
  if (env === null || typeof env !== "object") {
    throw new HostedConfigError("env", "must be an object of environment variables");
  }

  const hostedEnv = env.HOSTED_ENV === undefined || env.HOSTED_ENV === "" ? PRODUCTION : env.HOSTED_ENV;
  if (!HOSTED_ENVS.includes(hostedEnv)) {
    throw new HostedConfigError("HOSTED_ENV", `must be one of: ${HOSTED_ENVS.join(", ")}`);
  }
  const production = hostedEnv === PRODUCTION;

  const appOrigin = requiredOrigin(env, "HOSTED_APP_ORIGIN", production);
  const renderOrigin = requiredOrigin(env, "HOSTED_RENDER_ORIGIN", production);

  if (appOrigin === renderOrigin) {
    throw new HostedConfigError(
      "HOSTED_RENDER_ORIGIN",
      "must not be the same origin as HOSTED_APP_ORIGIN",
    );
  }

  /* C1/C6: "two origins" means two registrable sites, not two hostnames under
     one. Sibling subdomains share cookies and share a site for SameSite
     purposes, so a renderer at `render.example.com` beside an app at
     `app.example.com` is not the cookie-free origin the design depends on.
     The comparison uses the public-suffix list through pinned `tldts` with
     private suffixes enabled; comparing the last two labels would call
     `a.pages.dev` and `b.pages.dev` one site and get this exactly wrong. */
  let appSite = null;
  let renderSite = null;
  if (production) {
    appSite = registrableSite(appOrigin, { field: "HOSTED_APP_ORIGIN" });
    renderSite = registrableSite(renderOrigin, { field: "HOSTED_RENDER_ORIGIN" });
    if (appSite === renderSite) {
      throw new HostedConfigError(
        "HOSTED_RENDER_ORIGIN",
        "must be a different registrable site from HOSTED_APP_ORIGIN in production",
      );
    }
  }

  const clientId = requiredValue(env, "GITHUB_CLIENT_ID");
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(clientId)) {
    throw new HostedConfigError("GITHUB_CLIENT_ID", "must be 8-128 characters of [A-Za-z0-9._-]");
  }
  const clientSecret = requiredValue(env, "GITHUB_CLIENT_SECRET");
  if (clientSecret.length < 16 || /\s/.test(clientSecret)) {
    throw new HostedConfigError(
      "GITHUB_CLIENT_SECRET",
      "must be at least 16 characters with no whitespace",
    );
  }
  if (clientSecret === clientId) {
    throw new HostedConfigError("GITHUB_CLIENT_SECRET", "must not equal GITHUB_CLIENT_ID");
  }

  const publishEnabled = optionalBoolean(env, "HOSTED_PUBLISH_ENABLED");

  const github = buildGitHubCredential(clientId, clientSecret);
  const redactedView = () => ({
    hostedEnv,
    production,
    appOrigin,
    renderOrigin,
    appSite,
    renderSite,
    publishEnabled,
    github: { clientId, clientSecret: REDACTED },
  });

  const config = {
    hostedEnv,
    production,
    appOrigin,
    renderOrigin,
    appSite,
    renderSite,
    publishEnabled,
    github,
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
    `env=${config.hostedEnv}`,
    `app=${config.appOrigin}`,
    `render=${config.renderOrigin}`,
    `publish=${config.publishEnabled ? "enabled" : "disabled"}`,
    `githubClientId=${config.github.clientId}`,
    `githubClientSecret=${REDACTED}`,
  ].join(" ");
}
