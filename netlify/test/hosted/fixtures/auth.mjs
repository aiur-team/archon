/**
 * Deterministic fixtures and adapters for the hosted auth tree.
 *
 * Nothing here is a credential, a captured provider response or a real account.
 * The principals are synthetic subjects, the client secret is a published
 * literal, and every token a test needs is minted by `jose` inside this file
 * against a key pair generated at load - never a network read and never a key
 * committed to the repository.
 *
 * **This file is test data.** `scripts/check-function-modules.mjs` fails the build
 * if any module in `netlify/lib/hosted/` or `netlify/functions/` resolves an import into
 * `netlify/test/hosted/`, so there is no route by which a fixture reaches a deployed
 * path and no "test mode" flag for a handler to be switched into.
 *
 * ## The two adapters, and why AHU-007 can rely on them
 *
 * `MemoryBlobStore` implements the exact two methods `AuthStore` uses from
 * `@netlify/blobs` — `getWithMetadata` and `setJSON` — with the compare-and-set
 * semantics the real store documents: `onlyIfNew` refuses an existing key,
 * `onlyIfMatch` refuses a stale ETag, and both report the refusal as
 * `{modified: false}` rather than as an exception. Everything AHU-003 claims
 * about single use and revocation is a claim about those semantics, so a
 * consumer testing against this fake is testing against the same rules.
 *
 * It also models two behaviours of the real client that a tidier fake would
 * quietly omit, and that are exactly where the interesting bugs live:
 *
 *  - **`"phantom"`** — a conditional write that reports `{modified: true}`
 *    without applying. `@netlify/blobs@11.0.2` maps every non-412 status of a
 *    conditional PUT to `{modified: true}`, and its retry helper returns a 5xx
 *    response rather than throwing, so a store having a bad day reports guarded
 *    writes as successful. A fake that could not produce this would let the
 *    suite "prove" a revocation guarantee the library cannot deliver.
 *  - **`"noetag"`** — a read that carries no ETag. `Store.getConditions` applies
 *    `onlyIfMatch` only when the value is truthy, so an absent ETag silently
 *    downgrades a compare-and-set to an unconditional write.
 *
 * ## The Auth0 provider seam
 *
 * `auth0Provider` is a fake `fetch` for the tenant's token endpoint. It is
 * narrow on purpose: it answers only `/oauth/token` and throws on anything else,
 * so a test that accidentally exercises a third endpoint fails loudly rather
 * than silently receiving a stub. The ID token it returns is a genuine RS256 JWT
 * signed by `signIdToken` against the key pair below, and the callback verifies
 * it against `localKeySet()` - a `jose` local JWKS built from that pair's public
 * half - so the whole verification path runs with no live tenant and no network.
 * The nonce a token must echo is the one the start route minted and put in the
 * authorize URL, so a test threads it from there into the claims it signs.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";

import { readHostedConfig } from "../../../lib/hosted/config.mjs";
import { AuthStore } from "../../../lib/hosted/auth-store.mjs";
import { SCOPE, issuerUrl, tokenEndpoint } from "../../../lib/hosted/auth0-oidc.mjs";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/** A complete, valid operator environment. The secret is a published literal. */
export const HOSTED_ENV = Object.freeze({
  HOSTED_APP_ORIGIN: "https://app.archon.example.com",
  HOSTED_RENDER_ORIGIN: "https://render.archon.example.net",
  AUTH0_DOMAIN: "tenant.archon.example.com",
  AUTH0_CLIENT_ID: "exampleAuth0ClientId0000000000000",
  AUTH0_CLIENT_SECRET: "fixture-client-secret-value",
  HOSTED_PUBLISH_ENABLED: "true",
});

/** The validated configuration every route test runs against. */
export function hostedConfig(overrides = {}) {
  return readHostedConfig({ ...HOSTED_ENV, ...overrides });
}

/** The one origin the hosted deployment trusts, for building requests. */
export const APP_ORIGIN = HOSTED_ENV.HOSTED_APP_ORIGIN;

/** The tenant domain and the OIDC values derived from it, for building tokens. */
export const TENANT_DOMAIN = HOSTED_ENV.AUTH0_DOMAIN;
export const ISSUER = issuerUrl(TENANT_DOMAIN);
export const AUDIENCE = HOSTED_ENV.AUTH0_CLIENT_ID;
export const TOKEN_ENDPOINT = tokenEndpoint(TENANT_DOMAIN);

/* ------------------------------------------------------------------ */
/* principals and the claims that produce them                         */
/* ------------------------------------------------------------------ */

/**
 * The synthetic accounts, as C1 v2 subjects.
 *
 * The account identifiers are literals rather than computed values, because
 * `validatePrincipal` recomputes the digest from the subject and a mistyped
 * literal is therefore a loud failure in every suite that uses it. `ALPHA` and
 * `ALPHA_RENAMED` are one subject seen twice; `BETA` is a second account that
 * has taken over `ALPHA`'s old display name.
 */
export const PRINCIPAL_ALPHA = Object.freeze({
  accountId: "a0_3777bcebd9749d2c4d90673f61930f78",
  provider: "auth0",
  providerUserId: "github|1010",
  login: "alpha-example",
  email: null,
  emailVerified: false,
});

/** A different account that has taken over `alpha-example`'s old login. */
export const PRINCIPAL_BETA = Object.freeze({
  accountId: "a0_405ea0c0e5480a822c0141755db17f80",
  provider: "auth0",
  providerUserId: "github|2020",
  login: "alpha-example",
  email: null,
  emailVerified: false,
});

/** The same account as ALPHA, seen after a rename. Same subject, new login. */
export const PRINCIPAL_ALPHA_RENAMED = Object.freeze({
  accountId: "a0_3777bcebd9749d2c4d90673f61930f78",
  provider: "auth0",
  providerUserId: "github|1010",
  login: "alpha-renamed",
  email: null,
  emailVerified: false,
});

/**
 * The ID-token claims for a Google reader with a verified email.
 *
 * The one happy-path identity: a subject on the Google connection, a verified
 * lower-case email, and a `nickname` the principal carries as its display login.
 */
export const CLAIMS_GOOGLE = Object.freeze({
  sub: "google-oauth2|107654321098765432109",
  nickname: "ann",
  name: "Ann Example",
  email: "ann@example.com",
  email_verified: true,
});

/**
 * The ID-token claims for a GitHub reader with no readable email.
 *
 * The documented GitHub-without-`user:email` case: a valid subject, a display
 * `nickname`, and no `email` claim at all, which yields a session with
 * `email: null` and `emailVerified: false`.
 */
export const CLAIMS_GITHUB_NO_EMAIL = Object.freeze({
  sub: "github|4815162",
  nickname: "octo",
  name: "Octo Cat",
});

/* ------------------------------------------------------------------ */
/* the RS256 signing key, the JWKS, and the token minters              */
/* ------------------------------------------------------------------ */

const KEY_ID = "fixture-key-1";

/* Generated once at module load. Extractable so the public half can be exported
   into a local JWKS; the private half never leaves this file. */
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });

const publicJwk = { ...(await exportJWK(publicKey)), kid: KEY_ID, alg: "RS256", use: "sig" };

/** The JWKS a test verifies against, as `jose`'s local key set. */
export const TEST_JWKS = Object.freeze({ keys: [publicJwk] });

/** A `jose` local JWKS resolver, injected as the callback's `getKeySet`. */
export function localKeySet() {
  return createLocalJWKSet(TEST_JWKS);
}

/**
 * Mint a genuine RS256 ID token from a claim set.
 *
 * `nonce` is a first-class option because it is the one claim a test cannot
 * hard-code: it must equal the nonce the start route minted, which the test
 * reads out of the authorize URL. `issuer` and `audience` default to the tenant
 * and client the config fixture names, and are overridable so a test can forge a
 * wrong-issuer or wrong-audience token.
 */
export async function signIdToken(
  claims,
  { issuer = ISSUER, audience = AUDIENCE, nonce, expirationTime = "1h", kid = KEY_ID } = {},
) {
  const payload = { ...claims };
  if (nonce !== undefined) payload.nonce = nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(expirationTime)
    .sign(privateKey);
}

/**
 * Mint an HS256 token, for the algorithm-confusion refusal.
 *
 * The verifier pins RS256, so this is refused on its header alone whatever the
 * key; the key here is an arbitrary symmetric secret, not anything derived from
 * the tenant.
 */
export async function signHs256Token(
  claims,
  { issuer = ISSUER, audience = AUDIENCE, nonce } = {},
) {
  const payload = { ...claims };
  if (nonce !== undefined) payload.nonce = nonce;
  const secret = new TextEncoder().encode("fixture-hs256-symmetric-secret-key");
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime("1h")
    .sign(secret);
}

/* ------------------------------------------------------------------ */
/* clock                                                               */
/* ------------------------------------------------------------------ */

/** A clock a test moves by hand. Every expiry assertion runs through one. */
export function fixedClock(startMs = Date.parse("2026-09-09T12:00:00.000Z")) {
  let at = startMs;
  return {
    now: () => at,
    advanceSeconds(seconds) {
      at += seconds * 1000;
      return at;
    },
  };
}

/* ------------------------------------------------------------------ */
/* the store adapter                                                   */
/* ------------------------------------------------------------------ */

/**
 * An in-memory stand-in for a `@netlify/blobs` store, with the real conditional
 * write semantics and deliberate fault injection.
 *
 * `faults` is a list of `{match, mode}`. `match` is a substring of the key and
 * `mode` is one of:
 *
 *   "read"      the next matching `getWithMetadata` throws
 *   "write"     the next matching `setJSON` throws *without* applying
 *   "ambiguous" the next matching `setJSON` applies the write and then throws,
 *               which is the outage a naive implementation reports as a failure
 *               even though the record is now dead
 *   "refuse"    the next matching `setJSON` returns `{modified: false}` without
 *               applying, which is what a lost compare-and-set race looks like
 *   "phantom"   the next matching `setJSON` returns `{modified: true, etag: ""}`
 *               without applying, which is what the real client returns for a
 *               conditional PUT answered with 500 or 403
 *   "noetag"    the next matching `getWithMetadata` omits the ETag
 *
 * Each entry fires once and is removed, so a test can say "fail the first write
 * and then behave" without a stateful reset.
 */
export class MemoryBlobStore {
  constructor() {
    this.entries = new Map();
    this.faults = [];
    this.reads = [];
    this.writes = [];
    this.etagCounter = 0;
  }

  /** Arm one fault. Returns the store so a test can chain it into a constructor. */
  fail(match, mode) {
    this.faults.push({ match, mode });
    return this;
  }

  #takeFault(key, kinds) {
    const index = this.faults.findIndex(
      (fault) => key.includes(fault.match) && kinds.includes(fault.mode),
    );
    if (index === -1) return null;
    return this.faults.splice(index, 1)[0].mode;
  }

  async getWithMetadata(key, options = {}) {
    this.reads.push({ key, options });
    const fault = this.#takeFault(key, ["read", "noetag"]);
    if (fault === "read") throw new Error("store read failed");
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (fault === "noetag") return { data: structuredClone(entry.data), metadata: {} };
    return { data: structuredClone(entry.data), etag: entry.etag, metadata: {} };
  }

  async setJSON(key, data, conditions = {}) {
    this.writes.push({ key, conditions });
    const fault = this.#takeFault(key, ["write", "ambiguous", "refuse", "phantom"]);
    if (fault === "write") throw new Error("store write failed");
    if (fault === "refuse") return { modified: false };
    /* Not applied, and still reported as a modification - the shape the real
       client returns when a conditional PUT is answered with 500 or 403. */
    if (fault === "phantom") return { modified: true, etag: "" };

    const existing = this.entries.get(key);
    if (conditions.onlyIfNew === true && existing !== undefined) return { modified: false };
    if (conditions.onlyIfMatch !== undefined) {
      if (existing === undefined || existing.etag !== conditions.onlyIfMatch) {
        return { modified: false };
      }
    }
    this.etagCounter += 1;
    const etag = `etag-${this.etagCounter}`;
    this.entries.set(key, { data: structuredClone(data), etag });
    if (fault === "ambiguous") throw new Error("store write failed after applying");
    return { modified: true, etag };
  }

  /** Every key currently present, sorted. Used to assert namespace ownership. */
  keys() {
    return [...this.entries.keys()].sort();
  }
}

/** An `AuthStore` over a fresh memory store and a hand-driven clock. */
export function memoryAuthStore(clock = fixedClock(), store = new MemoryBlobStore()) {
  return { store: new AuthStore(store, { now: clock.now }), blobs: store, clock };
}

/* ------------------------------------------------------------------ */
/* the provider adapter                                                */
/* ------------------------------------------------------------------ */

/** A `Response` carrying JSON, for the fake provider. */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fake `fetch` for the tenant's token endpoint.
 *
 * Options:
 *   `idToken`   the exact ID token string to return. Pass a value from
 *               `signIdToken` / `signHs256Token`; the commonest use.
 *   `body`      a full token-response body, overriding the default envelope, or
 *               the string `"malformed"` for a non-JSON response.
 *   `status`    the HTTP status the token endpoint answers with (default 200).
 *               `"timeout"` (as `idToken` or `body`) rejects the way an aborted
 *               fetch does.
 *
 * The default envelope carries `access_token` and `expires_in` beside the ID
 * token, because a real response does and the point of the fixture is that those
 * fields reach production code and are read past rather than persisted.
 */
export function auth0Provider({ idToken, body, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, request) => {
    calls.push({ url: String(url), request });
    if (String(url) !== TOKEN_ENDPOINT) {
      throw new Error(`the auth0 fixture does not serve ${url}`);
    }
    if (idToken === "timeout" || body === "timeout") {
      throw new Error("The operation was aborted due to timeout");
    }
    if (body === "malformed") {
      return new Response("<html>not json</html>", {
        status,
        headers: { "content-type": "text/html" },
      });
    }
    if (body !== undefined) return json(body, status);
    return json(
      {
        id_token: idToken,
        access_token: "fixture-provider-access-token",
        token_type: "Bearer",
        scope: SCOPE,
        expires_in: 86400,
      },
      status,
    );
  };
  impl.calls = calls;
  return impl;
}

/* ------------------------------------------------------------------ */
/* requests                                                            */
/* ------------------------------------------------------------------ */

/**
 * A `Request` as a browser would send it to a hosted route.
 *
 * `cookies` is a record of name to value and is serialised into one `Cookie`
 * header, which is how a browser sends them and therefore what the production
 * parser has to handle.
 */
export function browserRequest(
  path,
  { method = "GET", cookies = {}, origin = APP_ORIGIN, csrf = null, form = null, json: body = null, headers = {} } = {},
) {
  const sent = new Headers(headers);
  const pairs = Object.entries(cookies);
  if (pairs.length > 0) sent.set("cookie", pairs.map(([name, value]) => `${name}=${value}`).join("; "));
  if (origin !== null) sent.set("origin", origin);
  if (csrf !== null) sent.set("x-archon-csrf", csrf);

  let payload;
  if (form !== null) {
    sent.set("content-type", "application/x-www-form-urlencoded");
    payload = new URLSearchParams(form).toString();
  } else if (body !== null) {
    sent.set("content-type", "application/json");
    payload = JSON.stringify(body);
  }
  return new Request(new URL(path, APP_ORIGIN), { method, headers: sent, body: payload });
}

/** Every `Set-Cookie` on a response, as a name-to-full-value map. */
export function setCookies(response) {
  const found = new Map();
  for (const value of response.headers.getSetCookie()) {
    found.set(value.slice(0, value.indexOf("=")), value);
  }
  return found;
}

/** The value a `Set-Cookie` assigns, which is `""` for a cleared cookie. */
export function cookieValue(serialized) {
  return serialized.slice(serialized.indexOf("=") + 1, serialized.indexOf(";"));
}
