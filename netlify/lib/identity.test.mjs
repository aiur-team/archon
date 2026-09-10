/**
 * The collaboration layer's identity boundary, over an injected session store.
 *
 * Every test here drives `identify()` with a store object rather than a
 * provider, which is what the `{store}` parameter exists for: the single seam
 * ACN-006 left in this module. A fault-injected read is the only honest way to
 * prove the outage path, because the property under test is that "the store
 * could not be read" and "nobody is signed in" never become the same answer.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AuthUnavailableError } from "./hosted/auth-errors.mjs";
import { SESSION_COOKIE } from "./hosted/identity.mjs";
import { identify, requireOrigin } from "./identity.mjs";
import { StoreError } from "./store.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/* Two real registrable sites, because production configuration insists on two:
   a renderer beside the application under one parent would share cookies with
   it. `.test` and `.invalid` are not listed public suffixes, so the reserved
   example domains are what a valid pair has to be spelled with. */
const APP_ORIGIN = "https://app.example.com";
const RENDER_ORIGIN = "https://render.example.net";

/** A C1 v2 account id: the `a0_` prefix and 32 lower-case hex characters. */
const ACCOUNT = `a0_${"9f2c1b7d4e5a6083c1d2e3f4a5b6c7d8"}`;

/** The principal shape `identifyHosted` hands back, with one field varied. */
function principal(overrides = {}) {
  return Object.freeze({
    accountId: ACCOUNT,
    provider: "auth0",
    providerUserId: "google-oauth2|10293847566",
    login: "Ann Example",
    email: "ann@example.com",
    emailVerified: true,
    ...overrides,
  });
}

/**
 * A session store that answers one token and nothing else.
 *
 * `fault` makes the read throw the unavailable error the real adapter throws,
 * which is the whole point of the seam: nothing else in the process has to be
 * broken to exercise the branch that must not fail open.
 */
function storeFor({ token = "opaque-session-token", session = null, fault = false } = {}) {
  return {
    async readSession(presented) {
      if (fault) throw new AuthUnavailableError("storage");
      return presented === token && session !== null ? { principal: session } : null;
    },
  };
}

function requestWith(cookie, headers = {}) {
  return new Request(`${APP_ORIGIN}/api/session?doc=abcdef`, {
    headers: cookie === null ? headers : { cookie, ...headers },
  });
}

/** The hosted configuration `requireOrigin` reads, installed for one call. */
function withHostedConfig(env, run) {
  const keys = [
    "HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN",
    "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET",
  ];
  const saved = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const CONFIGURED = Object.freeze({
  HOSTED_APP_ORIGIN: APP_ORIGIN,
  HOSTED_RENDER_ORIGIN: RENDER_ORIGIN,
  AUTH0_DOMAIN: "tenant.eu.auth0.com",
  AUTH0_CLIENT_ID: "abcd1234efgh5678",
  AUTH0_CLIENT_SECRET: "a-client-secret-of-sufficient-length",
});

/* -------------------------------------------------------------------------- */
/* identify                                                                    */
/* -------------------------------------------------------------------------- */

test("a request with no session cookie is nobody", async () => {
  const store = storeFor({ session: principal() });
  assert.equal(await identify(requestWith(null), { store }), null);
});

test("a cookie the store does not know is nobody", async () => {
  const store = storeFor({ session: principal() });
  const result = await identify(requestWith(`${SESSION_COOKIE}=some-other-token`), { store });
  assert.equal(result, null);
});

test("a live session is the four-field collaboration identity", async () => {
  const store = storeFor({ session: principal() });
  const result = await identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store });

  assert.deepEqual(Object.keys(result), ["sub", "email", "emailVerified", "name"]);
  assert.equal(result.sub, ACCOUNT, "the v2 accountId is the only grant key");
  assert.equal(result.email, "ann@example.com");
  assert.equal(result.emailVerified, true);
  assert.equal(result.name, "Ann Example", "the display login is the name");
  assert.equal("isOrg" in result, false, "there is no organisation field to read");
});

test("the address is normalized on the way in, once", async () => {
  const store = storeFor({ session: principal({ email: " Ann@Example.COM " }) });
  const result = await identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store });
  assert.equal(result.email, "ann@example.com");
  assert.equal(result.emailVerified, true);
});

test("an identity with no address is a valid session carrying none", async () => {
  // A GitHub account with no public address. It signs in, and matches no
  // invitation -- but it is signed in, and must not be an error.
  const store = storeFor({ session: principal({ email: null, emailVerified: false }) });
  const result = await identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store });
  assert.equal(result.sub, ACCOUNT);
  assert.equal(result.email, "");
  assert.equal(result.emailVerified, false);
});

test("an unverified address is carried but never marked verified", async () => {
  const store = storeFor({ session: principal({ emailVerified: false }) });
  const result = await identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store });
  assert.equal(result.email, "ann@example.com", "the address is still reported");
  assert.equal(result.emailVerified, false, "and is never matched against an invitation");
});

test("an address this repository's grammar refuses degrades to none", async () => {
  for (const email of ["ann@localhost", "ann@exam ple.com", "annexample.com", "аnn@example.com"]) {
    const store = storeFor({ session: principal({ email }) });
    const result = await identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store });
    assert.equal(result.email, "", `${email} is not a usable address`);
    assert.equal(result.emailVerified, false, `${email} cannot be a verified one either`);
    assert.equal(result.sub, ACCOUNT, `${email} still leaves a signed-in visitor`);
  }
});

test("a store outage throws rather than reporting a signed-out visitor", async () => {
  const store = storeFor({ session: principal(), fault: true });
  await assert.rejects(
    () => identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store }),
    (error) => {
      // The collaboration layer's own 503 vocabulary, so `/api/session`'s
      // `isUnavailable(error) ? 503 : 500` maps it without learning a new shape.
      assert.ok(error instanceof StoreError);
      assert.equal(error.name, "StoreError");
      assert.equal(error.code, "unavailable");
      assert.equal(error.status, 503);
      assert.ok(error.cause instanceof AuthUnavailableError, "the hosted fault is preserved as the cause");
      return true;
    },
  );
});

test("an unexpected store failure is not laundered into an outage", async () => {
  const store = {
    async readSession() {
      throw new TypeError("a bug, not an outage");
    },
  };
  await assert.rejects(
    () => identify(requestWith(`${SESSION_COOKIE}=opaque-session-token`), { store }),
    (error) => {
      assert.ok(error instanceof TypeError);
      assert.equal(error instanceof StoreError, false, "a bug stays a 500, not a retryable 503");
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* requireOrigin                                                               */
/* -------------------------------------------------------------------------- */

test("requireOrigin admits exactly the configured application origin", () => {
  withHostedConfig(CONFIGURED, () => {
    assert.doesNotThrow(() =>
      requireOrigin(requestWith(null, { origin: APP_ORIGIN })));
  });
});

test("requireOrigin refuses every other origin, and absence too", () => {
  const refused = [
    undefined,
    "null",
    "https://app.example.test.evil.test",
    "https://evil.test",
    APP_ORIGIN.toUpperCase(),
    `${APP_ORIGIN}/`,
    RENDER_ORIGIN,
  ];
  withHostedConfig(CONFIGURED, () => {
    for (const origin of refused) {
      const req = requestWith(null, origin === undefined ? {} : { origin });
      let thrown = null;
      try {
        requireOrigin(req);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof Response, `${origin ?? "(absent)"} is refused`);
      assert.equal(thrown.status, 403);
      assert.equal(thrown.headers.get("Content-Type"), "text/plain; charset=utf-8");
    }
  });
});

test("requireOrigin refuses when the deployment has no configured origin", () => {
  // A `scripts/connect.mjs` consumer that never configured Auth0. There is no
  // origin to compare against, so a mutation is refused rather than admitted.
  withHostedConfig({}, () => {
    let thrown = null;
    try {
      requireOrigin(requestWith(null, { origin: APP_ORIGIN }));
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Response);
    assert.equal(thrown.status, 403);
  });
});

test("the refusal discloses nothing about the configuration", async () => {
  await withHostedConfig(CONFIGURED, async () => {
    let thrown = null;
    try {
      requireOrigin(requestWith(null, { origin: "https://evil.test" }));
    } catch (error) {
      thrown = error;
    }
    const body = await thrown.text();
    assert.equal(body, "Bad origin");
    assert.equal(body.includes(APP_ORIGIN), false);
    assert.equal(body.includes("auth0"), false);
  });
});

/* -------------------------------------------------------------------------- */
/* what is gone                                                                */
/* -------------------------------------------------------------------------- */

test("the module names no organisation setting and no legacy provider", async () => {
  const source = await readFile(resolve(ROOT, "netlify/lib/identity.mjs"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const gone of ["ORG_EMAIL_DOMAIN", "isOrgEmail", "getUser", "verifyRequestOrigin", "@netlify/identity"]) {
    assert.equal(code.includes(gone), false, `${gone} is gone from the identity module`);
  }
});

test("the module exports exactly identify and requireOrigin", async () => {
  const module = await import("./identity.mjs");
  assert.deepEqual(Object.keys(module).sort(), ["identify", "requireOrigin"]);
});
