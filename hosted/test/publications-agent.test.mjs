/**
 * Regressions for the three agent HTTP endpoints.
 *
 * The handlers are meant to be thin, so this suite is mostly about the things a
 * thin handler still has to get right and that no other suite covers: the method
 * and header rejections, the bearer grammar, the status a state maps to, and the
 * private-response headers that Netlify will not add for a function.
 *
 * Each handler is driven through its real exported implementation with an
 * injected dependency set, so what is under test is the same code the deploy
 * runs, one lazy call away from the provider.
 *
 *   node --test hosted/test/publications-agent.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED_LIMITS, validateWireError } from "../lib/contracts.mjs";
import { createPublicationStore } from "../lib/publication-store.mjs";
import { PRIVATE_RESPONSE_HEADERS } from "../lib/publications-http.mjs";
import startHandler, { handleStart, config as startConfig } from "../functions/publications-start.mjs";
import statusHandler, {
  handleStatus,
  config as statusConfig,
} from "../functions/publications-status.mjs";
import cancelHandler, {
  handleCancel,
  config as cancelConfig,
} from "../functions/publications-cancel.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_AGENT_SECRET,
  FIXTURE_RECORD_BROWSER_SECRET,
  FIXTURE_RESULT,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import {
  createClock,
  createProviderDouble,
  sequentialRandomBytes,
} from "./helpers/publication-store.mjs";

const BASE = "https://hosted.example.test";
const START_PATH = "/api/hosted/publications";
const STATUS_PATH = `${START_PATH}/${FIXTURE_PUBLICATION_ID}/status`;
const CANCEL_PATH = `${START_PATH}/${FIXTURE_PUBLICATION_ID}/cancel`;

function harness({ seed = null, publishEnabled = true } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) provider.put(FIXTURE_KEY, JSON.stringify(RECORDS[seed]));
  const clock = createClock(FIXTURE_NOW);
  const dependencies = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled,
    now: clock.now,
    randomBytes: sequentialRandomBytes(),
  };
  let resolved = 0;
  return {
    provider,
    clock,
    resolve: () => {
      resolved += 1;
      return dependencies;
    },
    resolvedCount: () => resolved,
  };
}

function request(path, { method = "POST", headers = {}, body } = {}) {
  return new Request(`${BASE}${path}`, { method, headers, body });
}

const bearer = (secret = FIXTURE_RECORD_AGENT_SECRET) => ({ authorization: `Bearer ${secret}` });
const json = (value) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

/* The header values C3 freezes, written out rather than imported: asserting a
   response against the production constant only proves the handler used the
   constant, so deleting a header from it would keep every route green. */
const C3_PRIVATE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** The parsed body of a response, plus a check of the headers C3 requires. */
async function read(response) {
  for (const [header, value] of Object.entries(C3_PRIVATE_HEADERS)) {
    assert.equal(response.headers.get(header), value, `missing or wrong ${header}`);
  }
  return response.json();
}

/** Assert an error response: correct status, and a legal C3 envelope. */
async function assertError(response, status, code) {
  const body = await read(response);
  assert.equal(response.status, status, `expected ${status}, got ${response.status}`);
  assert.deepEqual(validateWireError(body), body, "the envelope must be a legal C3 error");
  assert.equal(body.error.code, code, `expected ${code}, got ${body.error.code}`);
  return body;
}

const ROUTES = [
  { name: "start", handle: handleStart, path: START_PATH, extra: json(VALID_DESCRIPTOR) },
  { name: "status", handle: handleStatus, path: STATUS_PATH, extra: { headers: bearer() } },
  { name: "cancel", handle: handleCancel, path: CANCEL_PATH, extra: { headers: bearer() } },
];

/* ------------------------------------------------------------------ */
/* routing and entry-point shape                                       */
/* ------------------------------------------------------------------ */

test("the private-header constant carries exactly the four C3 headers", () => {
  assert.deepEqual({ ...PRIVATE_RESPONSE_HEADERS }, { ...C3_PRIVATE_HEADERS });
});

test("each route is declared once, under the hosted API namespace", () => {
  assert.deepEqual(
    [startConfig.path, statusConfig.path, cancelConfig.path],
    [
      "/api/hosted/publications",
      "/api/hosted/publications/:publicationId/status",
      "/api/hosted/publications/:publicationId/cancel",
    ],
  );
  for (const handler of [startHandler, statusHandler, cancelHandler]) {
    assert.equal(typeof handler, "function");
  }
});

/* ------------------------------------------------------------------ */
/* transport rejections, on every route                                */
/* ------------------------------------------------------------------ */

for (const route of ROUTES) {
  test(`${route.name} refuses any method but POST`, async () => {
    const { resolve, resolvedCount } = harness({ seed: "pending" });
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const response = await route.handle(request(route.path, { method }), resolve);
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("Allow"), "POST");
      if (method !== "HEAD") await assertError(response, 405, "invalid_request");
    }
    assert.equal(resolvedCount(), 0, "a wrong method must not reach configuration or storage");
  });

  test(`${route.name} refuses a request carrying browser credentials`, async () => {
    const { resolve, resolvedCount, provider } = harness({ seed: "pending" });
    for (const header of [{ cookie: "session=abc" }, { origin: FIXTURE_APP_ORIGIN }]) {
      const response = await route.handle(
        request(route.path, { ...route.extra, headers: { ...route.extra.headers, ...header } }),
        resolve,
      );
      await assertError(response, 403, "forbidden");
    }
    assert.equal(resolvedCount(), 0, "a browser request must not reach storage");
    assert.deepEqual(
      provider.calls,
      [],
      "no read or write may happen for a rejected browser request",
    );
  });

  test(`${route.name} reports an unexpected fault as a bounded 503`, async () => {
    const response = await route.handle(request(route.path, route.extra), () => {
      throw new Error("secret configuration detail: /home/someone/.netlify/state.json");
    });
    const body = await assertError(response, 503, "unavailable");
    assert.doesNotMatch(body.error.message, /netlify|home|state\.json/i);
    assert.equal(body.error.retryable, true);
  });
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

test("start returns 201 and the C3 start body", async () => {
  const { resolve, provider } = harness();
  const response = await handleStart(request(START_PATH, json(VALID_DESCRIPTOR)), resolve);
  const body = await read(response);

  assert.equal(response.status, 201);
  assert.equal(body.v, 1);
  assert.equal(body.intervalSeconds, HOSTED_LIMITS.POLL_INTERVAL_SECONDS);
  assert.match(body.publicationId, /^[0-9a-f]{32}$/);
  assert.ok(new URL(body.verificationUriComplete).hash.length > 1);
  assert.equal(provider.keys().length, 1);
});

test("start refuses a descriptor that is not one", async () => {
  for (const bad of [
    { ...VALID_DESCRIPTOR, ownerAccountId: "gh_1" },
    { ...VALID_DESCRIPTOR, title: "" },
    { ...VALID_DESCRIPTOR, contentSha256: "nope" },
    { ...VALID_DESCRIPTOR, artifactFormat: "zip" },
    { v: 1 },
    [],
    "a descriptor",
  ]) {
    const { resolve, provider } = harness();
    const response = await handleStart(request(START_PATH, json(bad)), resolve);
    await assertError(response, 400, "invalid_request");
    assert.deepEqual(provider.keys(), [], "a refused descriptor stores nothing");
  }
});

test("start refuses a body that is not JSON", async () => {
  const { resolve } = harness();
  const wrongType = await handleStart(
    request(START_PATH, { headers: { "content-type": "text/html" }, body: "<html></html>" }),
    resolve,
  );
  await assertError(wrongType, 415, "unsupported_media_type");

  const notJson = await handleStart(
    request(START_PATH, { headers: { "content-type": "application/json" }, body: "{" }),
    resolve,
  );
  await assertError(notJson, 400, "invalid_request");
});

test("start is 503 publishing_disabled when the operator has not enabled it", async () => {
  const { resolve, provider } = harness({ publishEnabled: false });
  const response = await handleStart(request(START_PATH, json(VALID_DESCRIPTOR)), resolve);
  const body = await assertError(response, 503, "publishing_disabled");
  assert.equal(body.error.retryable, false);
  assert.deepEqual(provider.keys(), []);
});

/* ------------------------------------------------------------------ */
/* status and cancel                                                   */
/* ------------------------------------------------------------------ */

test("status returns 200 with the state envelope", async () => {
  const { resolve } = harness({ seed: "approved" });
  const response = await handleStatus(request(STATUS_PATH, { headers: bearer() }), resolve);
  const body = await read(response);

  assert.equal(response.status, 200);
  assert.equal(body.state, "approved");
  assert.equal(body.result, undefined);
});

test("status returns the receipt for a completed publication and no bytes", async () => {
  const { resolve } = harness({ seed: "complete" });
  const body = await read(
    await handleStatus(request(STATUS_PATH, { headers: bearer() }), resolve),
  );
  assert.deepEqual(body.result, { ...FIXTURE_RESULT });
  assert.ok(!JSON.stringify(body).includes(FIXTURE_HTML));
  assert.ok(!JSON.stringify(body).includes(RECORDS.complete.agentSecretHash));
});

test("status is 200 for a denied publication, not a transport failure", async () => {
  const { resolve } = harness({ seed: "denied" });
  const response = await handleStatus(request(STATUS_PATH, { headers: bearer() }), resolve);
  assert.equal(response.status, 200);
  assert.equal((await read(response)).state, "denied");
});

test("cancel returns 200 and the cancelled state", async () => {
  const { resolve, provider } = harness({ seed: "pending" });
  const response = await handleCancel(request(CANCEL_PATH, { headers: bearer() }), resolve);

  assert.equal(response.status, 200);
  assert.equal((await read(response)).state, "cancelled");
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "cancelled");
});

for (const route of [
  { name: "status", handle: handleStatus, path: STATUS_PATH },
  { name: "cancel", handle: handleCancel, path: CANCEL_PATH },
]) {
  test(`${route.name} refuses a missing or malformed bearer`, async () => {
    const { resolve, provider } = harness({ seed: "pending" });
    for (const headers of [
      {},
      { authorization: FIXTURE_RECORD_AGENT_SECRET },
      { authorization: `Basic ${FIXTURE_RECORD_AGENT_SECRET}` },
      { authorization: "Bearer" },
      { authorization: "Bearer " },
    ]) {
      const response = await route.handle(request(route.path, { headers }), resolve);
      await assertError(response, 401, "invalid_capability");
    }
    assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "pending");
  });

  test(`${route.name} refuses the wrong capability`, async () => {
    const { resolve, provider } = harness({ seed: "pending" });
    const response = await route.handle(
      request(route.path, { headers: bearer(FIXTURE_RECORD_BROWSER_SECRET) }),
      resolve,
    );
    await assertError(response, 401, "invalid_capability");
    assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "pending");
  });

  test(`${route.name} is 404 for an unknown publication and 400 for a legacy id`, async () => {
    const { resolve } = harness();
    const unknown = await route.handle(
      request(route.path, { headers: bearer() }),
      resolve,
    );
    await assertError(unknown, 404, "not_found");

    const legacy = await route.handle(
      request(`${START_PATH}/a1b2c3/${route.name}`, { headers: bearer() }),
      resolve,
    );
    await assertError(legacy, 400, "invalid_request");
  });

  test(`${route.name} answers a malformed percent-escape with a final 400`, async () => {
    const { resolve } = harness({ seed: "pending" });
    /* `decodeURIComponent("%zz")` throws a `URIError`, which is not a typed
       contract error. Without the handler's own translation it would fall
       through to the catch-all and come back as a *retryable* 503, and a
       conforming client would poll forever on a request that can never
       succeed. It is the caller's mistake, so it must be a terminal 400. */
    const response = await route.handle(
      request(`${START_PATH}/%zz/${route.name}`, { headers: bearer() }),
      resolve,
    );
    const body = await assertError(response, 400, "invalid_request");
    assert.equal(body.error.retryable, false);
  });

  test(`${route.name} does not answer for a path it does not own`, async () => {
    const { resolve } = harness({ seed: "pending" });
    const response = await route.handle(
      request(`${START_PATH}/${FIXTURE_PUBLICATION_ID}/artifact`, { headers: bearer() }),
      resolve,
    );
    await assertError(response, 404, "not_found");
  });
}
