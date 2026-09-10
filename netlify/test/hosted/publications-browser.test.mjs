/**
 * Regressions for the three browser-facing publication routes: bind, review and
 * decision.
 *
 * Every test drives the real exported handler over an injected dependency set -
 * a real `AuthStore` on a memory blob store, and the real publication adapter on
 * the conditional-write provider double - so what runs here is the code the
 * deploy runs, one lazy call away from the provider. Nothing is mocked at the
 * adapter boundary, because the interesting failures are exactly the ones a mock
 * of `decidePublication` would have agreed to.
 *
 * The suite is organised around what each route must refuse, since that is what
 * a thin handler is for. In particular:
 *
 *  - a bind that does not consume its single-use pre-login binding is a bind
 *    that can be replayed;
 *  - a review that answers before checking the session turns a link into a read
 *    capability for a document title;
 *  - a decision that accepts a binding from anywhere but the server-side cookie,
 *    or that lets `displayedAccountId` choose an owner, is the account-confusion
 *    case this whole flow exists to prevent.
 *
 *   node --test netlify/test/hosted/publications-browser.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TRANSIENT_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
import { HOSTED_LIMITS, validateWireError } from "../../lib/hosted/contracts.mjs";
import { BINDING_COOKIE, CSRF_HEADER, LOGIN_COOKIE, SESSION_COOKIE, deriveCsrfToken } from "../../lib/hosted/identity.mjs";
import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import bindHandler, { createBindRoute, config as bindConfig } from "../../functions/hosted-publications-bind.mjs";
import reviewHandler, {
  createReviewRoute,
  config as reviewConfig,
} from "../../functions/hosted-publications-review.mjs";
import decisionHandler, {
  createDecisionRoute,
  config as decisionConfig,
} from "../../functions/hosted-publications-decision.mjs";
import { MemoryBlobStore, fixedClock, hostedConfig, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_BROWSER_SECRET,
  OTHER_PRINCIPAL,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

const BIND_PATH = "/api/hosted/publications/bind";
const REVIEW_PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/review`;
const DECISION_PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/decision`;
const OTHER_ID = "1234567890abcdef1234567890abcdef";

/* Written out rather than imported from the module under test: asserting a
   response against the production constant only proves the handler used the
   constant, so deleting a header from it would leave every route green. */
const EXPECTED_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  vary: "Cookie",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/**
 * One harness carrying both stores, both clocks and the injected dependency set.
 *
 * The two clocks start at the same instant - the fixture records' creation time
 * - so a test that advances the publication clock past a deadline is looking at
 * the same moment the auth clock reports for the session and the binding.
 */
function harness({ seed = "pending", publishEnabled = true } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) provider.put(FIXTURE_KEY, JSON.stringify(RECORDS[seed]));
  const clock = createClock(FIXTURE_NOW);
  const authClock = fixedClock(Date.parse(FIXTURE_NOW));
  const blobs = new MemoryBlobStore();
  const { store } = memoryAuthStore(authClock, blobs);

  const dependencies = {
    config: hostedConfig(),
    store,
    publications: {
      store: createPublicationStore({ getStore: provider.getStore }),
      appOrigin: FIXTURE_APP_ORIGIN,
      production: true,
      publishEnabled,
      now: clock.now,
      randomBytes: sequentialRandomBytes(),
    },
  };

  return {
    provider,
    blobs,
    clock,
    authClock,
    store,
    dependencies,
    resolve: () => dependencies,
    bind: createBindRoute(() => dependencies),
    review: createReviewRoute(() => dependencies),
    decision: createDecisionRoute(() => dependencies),
    /** The stored record as it is right now, or null. */
    record() {
      const raw = provider.raw(FIXTURE_KEY);
      return raw === null ? null : JSON.parse(raw.data);
    },
    /** A live browser session for `principal`, as its cookie value. */
    async session(principal = FIXTURE_PRINCIPAL) {
      return (await store.createSession(principal)).token;
    },
    /** A live single-use pre-login binding, as its cookie value. */
    async loginBinding() {
      return (await store.createTransient("login")).token;
    },
    /** A live publication binding cookie for `publicationId`. */
    async publishBinding(publicationId = FIXTURE_PUBLICATION_ID) {
      const operation = `${publicationId}${RECORDS.pending.browserSecretHash}`;
      return (await store.createTransient("binding", { operation })).token;
    },
  };
}

/** A `Request` shaped the way a browser sends one to these routes. */
function request(path, { method = "GET", cookies = {}, origin = FIXTURE_APP_ORIGIN, csrf = null, json = null, contentType } = {}) {
  const headers = new Headers();
  const pairs = Object.entries(cookies).filter(([, value]) => value !== undefined && value !== null);
  if (pairs.length > 0) headers.set("cookie", pairs.map(([name, value]) => `${name}=${value}`).join("; "));
  if (origin !== null) headers.set("origin", origin);
  if (csrf !== null) headers.set(CSRF_HEADER, csrf);
  let body;
  if (json !== null) {
    headers.set("content-type", contentType ?? "application/json");
    body = typeof json === "string" ? json : JSON.stringify(json);
  } else if (contentType !== undefined) {
    headers.set("content-type", contentType);
  }
  return new Request(new URL(path, FIXTURE_APP_ORIGIN), { method, headers, body });
}

/** Assert a response is a C3 error envelope with `code`, and return its body. */
async function refusal(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  validateWireError(body);
  assert.equal(body.error.code, code);
  return body;
}

/** Every `Set-Cookie` on a response, by name. */
function setCookies(response) {
  const found = new Map();
  for (const value of response.headers.getSetCookie()) {
    found.set(value.slice(0, value.indexOf("=")), value);
  }
  return found;
}

function assertPrivateHeaders(response) {
  for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
    assert.equal(response.headers.get(name), value, `header ${name}`);
  }
  assert.equal(response.headers.get("access-control-allow-origin"), null);
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

test("the three routes are declared under the hosted API namespace", () => {
  assert.equal(bindConfig.path, "/api/hosted/publications/bind");
  assert.equal(reviewConfig.path, "/api/hosted/publications/:publicationId/review");
  assert.equal(decisionConfig.path, "/api/hosted/publications/:publicationId/decision");
  for (const handler of [bindHandler, reviewHandler, decisionHandler]) {
    assert.equal(typeof handler, "function");
  }
});

/* ------------------------------------------------------------------ */
/* bind                                                                */
/* ------------------------------------------------------------------ */

test("binding exchanges the link secret for an opaque cookie and says nothing else", async () => {
  const context = harness();
  const login = await context.loginBinding();
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: login },
      json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
    }),
  );

  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "publicationId", "v"]);
  assert.equal(body.publicationId, FIXTURE_PUBLICATION_ID);

  /* Nothing the visitor has not authenticated for, and no capability at all. */
  const text = JSON.stringify(body);
  assert.ok(!text.includes(VALID_DESCRIPTOR.title));
  assert.ok(!text.includes(RECORDS.pending.userCode));
  assert.ok(!text.includes(RECORDS.pending.agentSecretHash));
  assert.ok(!text.includes(RECORDS.pending.browserSecretHash));

  const cookies = setCookies(response);
  assert.match(cookies.get(BINDING_COOKIE), /Secure; HttpOnly; SameSite=Lax; Path=\/$/);
  assert.match(cookies.get(BINDING_COOKIE), new RegExp(`Max-Age=${TRANSIENT_TTL_SECONDS}\\b`));
  assert.match(cookies.get(LOGIN_COOKIE), /Max-Age=0\b/);
});

test("the pre-login binding is single-use, so a captured bind cannot be replayed", async () => {
  const context = harness();
  const login = await context.loginBinding();
  const send = () =>
    context.bind(
      request(BIND_PATH, {
        method: "POST",
        cookies: { [LOGIN_COOKIE]: login },
        json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
      }),
    );

  assert.equal((await send()).status, 200);
  const replay = await send();
  await refusal(replay, 403, "csrf_failed");
  assert.equal(setCookies(replay).has(BINDING_COOKIE), false);
});

test("binding without a pre-login binding at all is refused", async () => {
  const context = harness();
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
    }),
  );
  await refusal(response, 403, "csrf_failed");
  assertPrivateHeaders(response);
  assert.equal(setCookies(response).has(BINDING_COOKIE), false);
});

test("binding refuses a foreign or absent Origin before it spends the binding", async () => {
  for (const origin of [null, "https://evil.example.net", `${FIXTURE_APP_ORIGIN}.evil.example.net`]) {
    const context = harness();
    const login = await context.loginBinding();
    const response = await context.bind(
      request(BIND_PATH, {
        method: "POST",
        origin,
        cookies: { [LOGIN_COOKIE]: login },
        json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
      }),
    );
    await refusal(response, 403, "forbidden");
    /* Unspent: the visitor's own next attempt from the real page must work. */
    assert.notEqual(await context.store.readTransient("login", login), null);
  }
});

test("a wrong browser secret binds nothing", async () => {
  const context = harness();
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: await context.loginBinding() },
      json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: "not-the-browser-secret" },
    }),
  );
  await refusal(response, 401, "invalid_capability");
  assert.equal(setCookies(response).has(BINDING_COOKIE), false);
});

test("an unknown publication is a plain not_found", async () => {
  const context = harness({ seed: null });
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: await context.loginBinding() },
      json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
    }),
  );
  await refusal(response, 404, "not_found");
});

test("a terminal operation still binds, so review can say which terminal state it is", async () => {
  for (const seed of ["cancelled", "denied", "expired", "complete"]) {
    const context = harness({ seed });
    const response = await context.bind(
      request(BIND_PATH, {
        method: "POST",
        cookies: { [LOGIN_COOKIE]: await context.loginBinding() },
        json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
      }),
    );
    assert.equal(response.status, 200, `binding a ${seed} record`);
  }
});

test("binding a second link revokes the binding the browser was already holding", async () => {
  const context = harness();
  const first = await context.publishBinding();
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: await context.loginBinding(), [BINDING_COOKIE]: first },
      json: { publicationId: FIXTURE_PUBLICATION_ID, browserSecret: FIXTURE_RECORD_BROWSER_SECRET },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await context.store.readTransient("binding", first), null);

  /* Exactly one binding cookie is emitted. Sending the revocation's clear-cookie
     as well would leave which of two same-named `Set-Cookie` headers wins to the
     browser, and the visitor would sometimes land on the approval page with no
     binding at all. */
  const emitted = response.headers.getSetCookie().filter((value) => value.startsWith(`${BINDING_COOKIE}=`));
  assert.equal(emitted.length, 1);
  assert.doesNotMatch(emitted[0], /Max-Age=0\b/);
});

test("bind accepts only POST, and says so", async () => {
  const context = harness();
  for (const method of ["GET", "PUT", "DELETE"]) {
    const response = await context.bind(request(BIND_PATH, { method }));
    await refusal(response, 405, "invalid_request");
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("bind refuses a body that is not JSON", async () => {
  const context = harness();
  const response = await context.bind(
    request(BIND_PATH, {
      method: "POST",
      cookies: { [LOGIN_COOKIE]: await context.loginBinding() },
      json: "publicationId=x",
      contentType: "application/x-www-form-urlencoded",
    }),
  );
  await refusal(response, 415, "unsupported_media_type");
});

/* ------------------------------------------------------------------ */
/* review                                                              */
/* ------------------------------------------------------------------ */

test("review shows the descriptor, the pairing code and the account that would own it", async () => {
  const context = harness();
  const response = await context.review(
    request(REVIEW_PATH, {
      cookies: {
        [BINDING_COOKIE]: await context.publishBinding(),
        [SESSION_COOKIE]: await context.session(),
      },
    }),
  );

  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  const body = await response.json();
  assert.equal(body.state, "pending");
  assert.equal(body.publicationId, FIXTURE_PUBLICATION_ID);
  assert.deepEqual(body.descriptor, VALID_DESCRIPTOR);
  assert.equal(body.userCode, RECORDS.pending.userCode);
  assert.equal(body.currentAccountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal(body.ownerAccountId, null);
  assert.equal(body.expiresAt, RECORDS.pending.pendingExpiresAt);
});

test("review never carries a secret hash or the document bytes, in any state", async () => {
  for (const seed of ["pending", "approved", "complete", "denied", "cancelled"]) {
    const context = harness({ seed });
    const response = await context.review(
      request(REVIEW_PATH, {
        cookies: {
          [BINDING_COOKIE]: await context.publishBinding(),
          [SESSION_COOKIE]: await context.session(),
        },
      }),
    );
    assert.equal(response.status, 200, seed);
    const body = await response.json();

    /* The exact key set, not a subset: a field added to the projection later is
       a field this assertion has to be changed to allow, which is the point. */
    assert.deepEqual(
      Object.keys(body).sort(),
      [
        "currentAccountId",
        "descriptor",
        "expiresAt",
        "ownerAccountId",
        "publicationId",
        "state",
        "userCode",
        "v",
      ],
      `${seed} projected an unexpected field`,
    );

    const text = JSON.stringify(body);
    assert.ok(!text.includes(RECORDS.pending.agentSecretHash), `${seed} leaked the agent digest`);
    assert.ok(!text.includes(RECORDS.pending.browserSecretHash), `${seed} leaked the browser digest`);
    assert.ok(!text.includes("<!doctype"), `${seed} leaked document bytes`);
  }
});

test("a link without a session reveals nothing, and asks for one", async () => {
  const context = harness();
  const response = await context.review(
    request(REVIEW_PATH, { cookies: { [BINDING_COOKIE]: await context.publishBinding() } }),
  );
  const body = await refusal(response, 401, "session_required");
  assert.ok(!JSON.stringify(body).includes(VALID_DESCRIPTOR.title));
});

test("a session without a link cannot name an operation it was never handed", async () => {
  const context = harness();
  const response = await context.review(
    request(REVIEW_PATH, { cookies: { [SESSION_COOKIE]: await context.session() } }),
  );
  await refusal(response, 403, "approval_required");
});

test("a binding for one publication does not open another one's review", async () => {
  const context = harness();
  const response = await context.review(
    request(REVIEW_PATH, {
      cookies: {
        [BINDING_COOKIE]: await context.publishBinding(OTHER_ID),
        [SESSION_COOKIE]: await context.session(),
      },
    }),
  );
  await refusal(response, 403, "approval_required");
});

test("an expired binding stops opening the review", async () => {
  const context = harness();
  const cookies = {
    [BINDING_COOKIE]: await context.publishBinding(),
    [SESSION_COOKIE]: await context.session(),
  };
  context.authClock.advanceSeconds(TRANSIENT_TTL_SECONDS + 1);
  await refusal(await context.review(request(REVIEW_PATH, { cookies })), 403, "approval_required");
});

test("a pending record past its deadline reviews as expired rather than pending", async () => {
  const context = harness();
  const cookies = {
    [BINDING_COOKIE]: await context.publishBinding(),
    [SESSION_COOKIE]: await context.session(),
  };
  context.clock.advanceSeconds(HOSTED_LIMITS.PENDING_TTL_SECONDS + 1);
  const response = await context.review(request(REVIEW_PATH, { cookies }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "expired");
});

test("a storage outage is a retryable 503, never a signed-out visitor", async () => {
  const context = harness();
  const cookies = {
    [BINDING_COOKIE]: await context.publishBinding(),
    [SESSION_COOKIE]: await context.session(),
  };
  context.blobs.fail("sessions/", "read");
  const body = await refusal(await context.review(request(REVIEW_PATH, { cookies })), 503, "unavailable");
  assert.equal(body.error.retryable, true);
});

test("review does not demand an Origin, because a same-origin GET carries none", async () => {
  /* The one entry rule this route is defined by, and the only test that pins
     it: a browser sends no `Origin` on a same-origin `GET`, so a route that
     called `requireExactOrigin` here would refuse every legitimate request while
     refusing nothing else. Without this case, adding that call leaves the whole
     suite green and only the Chromium matrix notices. */
  const context = harness();
  const response = await context.review(
    request(REVIEW_PATH, {
      origin: null,
      cookies: {
        [BINDING_COOKIE]: await context.publishBinding(),
        [SESSION_COOKIE]: await context.session(),
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "pending");
});

test("a binding-store outage is a 503, not an invitation to re-open the link", async () => {
  /* The sibling of the session-store case below. If the binding read ever
     swallowed a storage error and answered null, every visitor during an outage
     would be told this browser is holding nothing and sent to re-open a link
     that cannot help - one key prefix away from the failure the session test
     exists to prevent. */
  const context = harness();
  const cookies = {
    [BINDING_COOKIE]: await context.publishBinding(),
    [SESSION_COOKIE]: await context.session(),
  };
  context.blobs.fail("auth/binding", "read");
  const body = await refusal(await context.review(request(REVIEW_PATH, { cookies })), 503, "unavailable");
  assert.equal(body.error.retryable, true);
});

test("a path that is not a publication route is a 404, and a malformed one a 400", async () => {
  const context = harness();
  const cookies = {
    [BINDING_COOKIE]: await context.publishBinding(),
    [SESSION_COOKIE]: await context.session(),
  };

  for (const path of [
    "/api/hosted/publications/review",
    `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/extra/review`,
    `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/reviews`,
  ]) {
    await refusal(await context.review(request(path, { cookies })), 404, "not_found");
  }

  /* `%ZZ` throws `URIError`, which is not a `HostedContractError`. Untyped, it
     would be flattened into a *retryable* 503 and a conforming poller would loop
     on a request that can never succeed. It is the caller's mistake, and a 400. */
  const malformed = await context.review(
    request("/api/hosted/publications/%ZZ/review", { cookies }),
  );
  const body = await refusal(malformed, 400, "invalid_request");
  assert.equal(body.error.retryable, false);
});

test("a deploy missing its configuration answers 503, and a wrong method still wins", async () => {
  /* The dependency set is resolved inside each route's `try` precisely so a
     missing C6 key becomes a bounded 503 rather than a throw out of the function
     runtime - and so a wrong method on a broken deploy is still reported as a
     wrong method. */
  const broken = () => {
    throw new Error("HOSTED_APP_ORIGIN is not set");
  };
  for (const [route, path, method] of [
    [createBindRoute(broken), BIND_PATH, "POST"],
    [createReviewRoute(broken), REVIEW_PATH, "GET"],
    [createDecisionRoute(broken), DECISION_PATH, "POST"],
  ]) {
    const body = await refusal(await route(request(path, { method })), 503, "unavailable");
    /* The fault names an environment variable; an anonymous caller never sees it. */
    assert.ok(!body.error.message.includes("HOSTED_APP_ORIGIN"));

    const wrongMethod = await route(request(path, { method: method === "GET" ? "POST" : "GET" }));
    await refusal(wrongMethod, 405, "invalid_request");
  }
});

test("review accepts only GET", async () => {
  const context = harness();
  for (const method of ["POST", "PUT", "DELETE"]) {
    const response = await context.review(request(REVIEW_PATH, { method }));
    await refusal(response, 405, "invalid_request");
    assert.equal(response.headers.get("allow"), "GET");
  }
});

/* ------------------------------------------------------------------ */
/* decision                                                            */
/* ------------------------------------------------------------------ */

/** The four cookies-and-headers a valid decision presents. */
async function decisionRequest(context, { decision = "approve", displayedAccountId, sessionToken, binding, ...rest } = {}) {
  const token = sessionToken ?? (await context.session());
  return request(DECISION_PATH, {
    method: "POST",
    cookies: {
      [SESSION_COOKIE]: token,
      [BINDING_COOKIE]: binding ?? (await context.publishBinding()),
    },
    csrf: deriveCsrfToken(token),
    json: { decision, displayedAccountId: displayedAccountId ?? FIXTURE_PRINCIPAL.accountId },
    ...rest,
  });
}

test("an explicit approval fixes the owner and releases the binding", async () => {
  const context = harness();
  const binding = await context.publishBinding();
  const response = await context.decision(await decisionRequest(context, { binding }));

  assert.equal(response.status, 200);
  assertPrivateHeaders(response);
  const body = await response.json();
  assert.equal(body.state, "approved");
  assert.equal(body.ownerAccountId, FIXTURE_PRINCIPAL.accountId);

  const stored = context.record();
  assert.equal(stored.state, "approved");
  assert.equal(stored.ownerAccountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal(typeof stored.uploadExpiresAt, "string");

  /* Both halves: the cookie is cleared and the record behind it is gone, so a
     copy of the cookie cannot present it either. */
  assert.match(setCookies(response).get(BINDING_COOKIE), /Max-Age=0\b/);
  assert.equal(await context.store.readTransient("binding", binding), null);
});

test("a denial is a normal terminal answer that publishes nothing", async () => {
  const context = harness();
  const response = await context.decision(await decisionRequest(context, { decision: "deny" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, "denied");

  const stored = context.record();
  assert.equal(stored.state, "denied");
  assert.equal(stored.uploadExpiresAt, null);
  assert.equal(stored.html, null);
});

test("the owner is the session's account, never the one the body asks for", async () => {
  const context = harness();
  const response = await context.decision(
    await decisionRequest(context, { displayedAccountId: OTHER_PRINCIPAL.accountId }),
  );
  await refusal(response, 403, "csrf_failed");
  assert.equal(context.record().state, "pending");
  assert.equal(context.record().ownerAccountId, null);
});

test("a decision made while the shown account has since changed is refused", async () => {
  const context = harness();
  /* The tab rendered ALPHA; the browser now holds a session for the other
     account. The click consented to publishing as somebody who is gone. */
  const beta = await context.session(OTHER_PRINCIPAL);
  const response = await context.decision(
    await decisionRequest(context, {
      sessionToken: beta,
      displayedAccountId: FIXTURE_PRINCIPAL.accountId,
    }),
  );
  await refusal(response, 403, "csrf_failed");
  assert.equal(context.record().ownerAccountId, null);
});

test("a decision without the session-bound CSRF token changes nothing", async () => {
  const context = harness();
  const token = await context.session();
  for (const csrf of [null, "not-the-token", deriveCsrfToken("a-different-session-token")]) {
    const response = await context.decision(
      request(DECISION_PATH, {
        method: "POST",
        cookies: { [SESSION_COOKIE]: token, [BINDING_COOKIE]: await context.publishBinding() },
        csrf,
        json: { decision: "approve", displayedAccountId: FIXTURE_PRINCIPAL.accountId },
      }),
    );
    await refusal(response, 403, "csrf_failed");
  }
  assert.equal(context.record().state, "pending");
});

test("a decision from another origin changes nothing", async () => {
  const context = harness();
  const response = await context.decision(
    await decisionRequest(context, { origin: "https://evil.example.net" }),
  );
  await refusal(response, 403, "forbidden");
  assert.equal(context.record().state, "pending");
});

test("a decision with no session changes nothing", async () => {
  const context = harness();
  const response = await context.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [BINDING_COOKIE]: await context.publishBinding() },
      csrf: "anything",
      json: { decision: "approve", displayedAccountId: FIXTURE_PRINCIPAL.accountId },
    }),
  );
  await refusal(response, 401, "session_required");
  assert.equal(context.record().state, "pending");
});

test("a session alone cannot approve an operation this browser never bound", async () => {
  const context = harness();
  const token = await context.session();
  const response = await context.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
      json: { decision: "approve", displayedAccountId: FIXTURE_PRINCIPAL.accountId },
    }),
  );
  await refusal(response, 403, "approval_required");
  assert.equal(context.record().state, "pending");
});

test("a binding presented in the body is not a binding", async () => {
  const context = harness();
  const token = await context.session();
  const response = await context.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: token },
      csrf: deriveCsrfToken(token),
      json: {
        decision: "approve",
        displayedAccountId: FIXTURE_PRINCIPAL.accountId,
        browserBinding: {
          publicationId: FIXTURE_PUBLICATION_ID,
          browserSecretHash: RECORDS.pending.browserSecretHash,
        },
      },
    }),
  );
  await refusal(response, 403, "approval_required");
  assert.equal(context.record().state, "pending");
});

test("only approve and deny are decisions", async () => {
  const context = harness();
  for (const decision of ["approved", "APPROVE", "", null, "cancel"]) {
    const response = await context.decision(await decisionRequest(context, { decision }));
    await refusal(response, 400, "invalid_request");
  }
  assert.equal(context.record().state, "pending");
});

test("an expired pending record cannot be approved, and keeps the binding", async () => {
  const context = harness();
  const binding = await context.publishBinding();
  context.clock.advanceSeconds(HOSTED_LIMITS.PENDING_TTL_SECONDS + 1);
  const response = await context.decision(await decisionRequest(context, { binding }));

  await refusal(response, 410, "authorization_expired");
  assert.equal(context.record().state, "pending");
  /* Left in place: the page's next move is to re-read the review route and tell
     the visitor which terminal state this is. */
  assert.equal(setCookies(response).has(BINDING_COOKIE), false);
  assert.notEqual(await context.store.readTransient("binding", binding), null);
});

test("an operation that already has an answer cannot be re-decided", async () => {
  for (const seed of ["approved", "denied", "cancelled", "complete"]) {
    const context = harness({ seed });
    const response = await context.decision(await decisionRequest(context));
    await refusal(response, 409, "state_conflict");
    assert.equal(context.record().state, seed);
  }
});

test("a GET never approves anything", async () => {
  const context = harness();
  for (const method of ["GET", "HEAD", "PUT"]) {
    const response = await context.decision(request(DECISION_PATH, { method }));
    await refusal(response, 405, "invalid_request");
    assert.equal(response.headers.get("allow"), "POST");
  }
  assert.equal(context.record().state, "pending");
});

test("a decision body must be a JSON object", async () => {
  const context = harness();
  const token = await context.session();
  for (const [json, contentType, status, code] of [
    ["approve", "text/plain", 415, "unsupported_media_type"],
    ['"approve"', "application/json", 400, "invalid_request"],
    ["[]", "application/json", 400, "invalid_request"],
    ["{", "application/json", 400, "invalid_request"],
  ]) {
    const response = await context.decision(
      request(DECISION_PATH, {
        method: "POST",
        cookies: { [SESSION_COOKIE]: token, [BINDING_COOKIE]: await context.publishBinding() },
        csrf: deriveCsrfToken(token),
        json,
        contentType,
      }),
    );
    await refusal(response, status, code);
  }
  assert.equal(context.record().state, "pending");
});
