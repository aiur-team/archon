/**
 * Regressions for `GET|PUT /api/hosted/publications/<id>/access`.
 *
 * The write half of the shared `fixtures/domain-access.mjs` table runs through
 * the real exported handler here, over a real auth store and the real
 * publication adapter on the conditional-write provider double. That is the
 * point of the shared table: the same rows the evaluator suite proves against
 * `normalizeDomainList` are proved again through HTTP, so the write path and
 * the read path cannot come to disagree about what `Example.COM ` means.
 *
 * What this file adds beyond the table is everything that is about the *route*:
 * the owner-only rule and its non-disclosing refusal, the CSRF and `Origin`
 * checks on the mutation, the replace-not-merge semantics, and the guarded
 * re-read that keeps a policy write from carrying a stale lifecycle back over a
 * concurrent transition.
 *
 *   node --test netlify/test/hosted/publications-access.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { validateWireError } from "../../lib/hosted/contracts.mjs";
import { CSRF_HEADER, SESSION_COOKIE, deriveCsrfToken } from "../../lib/hosted/identity.mjs";
import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import accessHandler, {
  createAccessRoute,
  config as accessConfig,
} from "../../functions/hosted-publications-access.mjs";
import { MemoryBlobStore, fixedClock, hostedConfig, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  OTHER_PRINCIPAL,
  RECORDS,
} from "./fixtures/publications.mjs";
import { LISTED_DOMAIN, LISTED_DOMAINS, SECOND_LISTED_DOMAIN, WRITE_CASES } from "./fixtures/domain-access.mjs";
import { createClock, createProviderDouble } from "./helpers/publication-store.mjs";

const PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/access`;
const OTHER_ID = "1234567890abcdef1234567890abcdef";

/** One harness over a real auth store and the real publication adapter. */
function harness({ seed = "complete", allowPublicMailboxes = false, allowedDomains = null } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) {
    const record = allowedDomains === null ? RECORDS[seed] : { ...RECORDS[seed], allowedDomains };
    provider.put(FIXTURE_KEY, JSON.stringify(record));
  }
  const authClock = fixedClock(Date.parse(FIXTURE_NOW));
  const { store } = memoryAuthStore(authClock, new MemoryBlobStore());

  const dependencies = {
    config: hostedConfig(),
    store,
    publications: {
      store: createPublicationStore({ getStore: provider.getStore }),
      appOrigin: FIXTURE_APP_ORIGIN,
      production: true,
      publishEnabled: true,
      allowPublicMailboxes,
      now: createClock(FIXTURE_NOW).now,
    },
  };

  return {
    provider,
    store,
    dependencies,
    access: createAccessRoute(() => dependencies),
    record() {
      const raw = provider.raw(FIXTURE_KEY);
      return raw === null ? null : JSON.parse(raw.data);
    },
    async session(principal = FIXTURE_PRINCIPAL) {
      return (await store.createSession(principal)).token;
    },
  };
}

/** A browser request to this route, with the CSRF token derived by default. */
function request(
  path,
  { method = "GET", token = null, origin = FIXTURE_APP_ORIGIN, csrf, json, contentType } = {},
) {
  const headers = new Headers();
  if (token !== null) headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  if (origin !== null) headers.set("origin", origin);
  /* Undefined means "the token this session really has", which is what a real
     page sends; null means "send none", which is the forgery case. */
  const presented = csrf === undefined ? (token === null ? null : deriveCsrfToken(token)) : csrf;
  if (presented !== null) headers.set(CSRF_HEADER, presented);
  let body;
  if (json !== undefined) {
    headers.set("content-type", contentType ?? "application/json");
    body = typeof json === "string" ? json : JSON.stringify(json);
  } else if (contentType !== undefined) {
    headers.set("content-type", contentType);
  }
  return new Request(new URL(path, FIXTURE_APP_ORIGIN), { method, headers, body });
}

/** A `PUT` of `allowedDomains` as the signed-in owner. */
function put(token, allowedDomains, options = {}) {
  return request(PATH, { method: "PUT", token, json: { v: 1, allowedDomains }, ...options });
}

async function refusal(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  validateWireError(body);
  assert.equal(body.error.code, code);
  return body;
}

/* ------------------------------------------------------------------ */
/* routing                                                             */
/* ------------------------------------------------------------------ */

test("the route is declared under the hosted API namespace", () => {
  assert.equal(accessConfig.path, "/api/hosted/publications/:publicationId/access");
  assert.equal(typeof accessHandler, "function");
});

test("only GET and PUT are answered, and the refusal says so", async () => {
  const h = harness();
  const token = await h.session();
  for (const method of ["POST", "PATCH", "DELETE", "HEAD"]) {
    const response = await h.access(request(PATH, { method, token }));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "GET, PUT");
  }
});

test("a wrong method is refused before any store is touched", async () => {
  /* The method check runs outside the dependency thunk, so a deployment missing
     a configuration key still reports a wrong method as a wrong method - and a
     request that was never going to be answered costs no store read. */
  const h = harness();
  const before = h.provider.calls.length;
  await h.access(request(PATH, { method: "DELETE", token: await h.session() }));
  assert.equal(h.provider.calls.length, before);
});

/* ------------------------------------------------------------------ */
/* who may read the policy                                             */
/* ------------------------------------------------------------------ */

test("the owner reads the list, the flag and the id", async () => {
  const h = harness({ allowedDomains: [...LISTED_DOMAINS] });
  const response = await h.access(request(PATH, { token: await h.session() }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    v: 1,
    publicationId: FIXTURE_PUBLICATION_ID,
    allowedDomains: [...LISTED_DOMAINS],
    allowPublicMailboxes: false,
  });
});

test("a document with no list reads as an empty list, not as an error", async () => {
  const h = harness();
  const body = await (await h.access(request(PATH, { token: await h.session() }))).json();
  assert.deepEqual(body.allowedDomains, []);
});

test("the site-wide override is reported so a page can explain itself", async () => {
  const h = harness({ allowPublicMailboxes: true });
  const body = await (await h.access(request(PATH, { token: await h.session() }))).json();
  assert.equal(body.allowPublicMailboxes, true);
});

test("a signed-out reader is asked to sign in, for any id", async () => {
  const h = harness();
  await refusal(await h.access(request(PATH)), 401, "session_required");
  await refusal(
    await h.access(request(`/api/hosted/publications/${OTHER_ID}/access`)),
    401,
    "session_required",
  );
});

test("another account is refused exactly as an unknown id is", async () => {
  const h = harness();
  const stranger = await h.access(request(PATH, { token: await h.session(OTHER_PRINCIPAL) }));
  const unknown = await h.access(
    request(`/api/hosted/publications/${OTHER_ID}/access`, { token: await h.session() }),
  );

  assert.equal(stranger.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await stranger.json(), await unknown.json());
});

test("a reader admitted by a listed domain still may not read the policy", async () => {
  /* Being on a list does not entitle you to enumerate it. This account would
     read the *document* through the domain rule; the policy is the owner's. */
  const h = harness({ allowedDomains: [...LISTED_DOMAINS] });
  const reader = {
    ...OTHER_PRINCIPAL,
    email: `ann@${LISTED_DOMAIN}`,
    emailVerified: true,
  };
  await refusal(await h.access(request(PATH, { token: await h.session(reader) })), 404, "not_found");
});

test("a record that is not complete is refused with the same body", async () => {
  for (const seed of ["pending", "approved", "denied", "cancelled", "expired"]) {
    const h = harness({ seed });
    const response = await h.access(request(PATH, { token: await h.session() }));
    assert.equal(response.status, 404, seed);
    assert.equal((await response.json()).error.code, "not_found", seed);
  }
});

/* ------------------------------------------------------------------ */
/* the mutation's own authorisation                                    */
/* ------------------------------------------------------------------ */

test("a PUT with no CSRF token is refused, and writes nothing", async () => {
  const h = harness();
  const token = await h.session();
  await refusal(await h.access(put(token, [LISTED_DOMAIN], { csrf: null })), 403, "csrf_failed");
  assert.deepEqual(h.record().allowedDomains, []);
});

test("a PUT with a forged CSRF token is refused", async () => {
  const h = harness();
  const token = await h.session();
  const forged = deriveCsrfToken(`${token}x`);
  await refusal(await h.access(put(token, [LISTED_DOMAIN], { csrf: forged })), 403, "csrf_failed");
  assert.deepEqual(h.record().allowedDomains, []);
});

test("a PUT from another origin is refused before the session is read", async () => {
  const h = harness();
  const token = await h.session();
  const response = await h.access(put(token, [LISTED_DOMAIN], { origin: "https://evil.example" }));
  assert.equal(response.status, 403);
  assert.deepEqual(h.record().allowedDomains, []);
});

test("a signed-out PUT is refused even with a well-formed body", async () => {
  const h = harness();
  await refusal(await h.access(put(null, [LISTED_DOMAIN])), 401, "session_required");
  assert.deepEqual(h.record().allowedDomains, []);
});

test("a PUT by another account writes nothing and says not_found", async () => {
  const h = harness();
  const token = await h.session(OTHER_PRINCIPAL);
  await refusal(await h.access(put(token, [LISTED_DOMAIN])), 404, "not_found");
  assert.deepEqual(h.record().allowedDomains, []);
});

test("the body must be JSON and must be version 1", async () => {
  const h = harness();
  const token = await h.session();
  await refusal(
    await h.access(put(token, [LISTED_DOMAIN], { contentType: "text/plain" })),
    415,
    "unsupported_media_type",
  );
  await refusal(
    await h.access(request(PATH, { method: "PUT", token, json: { v: 2, allowedDomains: [] } })),
    400,
    "invalid_request",
  );
  await refusal(
    await h.access(request(PATH, { method: "PUT", token, json: "not json at all" })),
    400,
    "invalid_request",
  );
});

/* ------------------------------------------------------------------ */
/* the shared table, through HTTP                                      */
/* ------------------------------------------------------------------ */

test("every write row in the shared table answers the same way over HTTP", async () => {
  for (const row of WRITE_CASES) {
    const h = harness();
    const token = await h.session();
    const response = await h.access(put(token, row.input));

    if (row.expect !== undefined) {
      assert.equal(response.status, 200, row.name);
      const body = await response.json();
      assert.deepEqual(body.allowedDomains, row.expect, row.name);
      /* Stored, not merely echoed. A route that answered the normalized list
         without writing it would pass a body-only assertion. */
      assert.deepEqual(h.record().allowedDomains, row.expect, `${row.name}: stored`);
      continue;
    }

    const body = await refusal(response, 400, row.reason);
    if (row.domain !== undefined) {
      assert.match(body.error.message, new RegExp(row.domain.replaceAll(".", "\\.")), row.name);
    }
    /* A refused list changes nothing. */
    assert.deepEqual(h.record().allowedDomains, [], `${row.name}: stored nothing`);
  }
});

test("the override lets an operator list a mailbox provider on purpose", async () => {
  const h = harness({ allowPublicMailboxes: true });
  const token = await h.session();
  const response = await h.access(put(token, ["gmail.com"]));
  assert.equal(response.status, 200);
  assert.deepEqual(h.record().allowedDomains, ["gmail.com"]);
});

test("a list stored under the override stays readable after it is turned off", async () => {
  /* The reason the denylist is a write-time rule and not a record rule: an
     operator who turns the flag back off must not thereby make every document
     written while it was on unreadable, which the store would report as an
     outage on a perfectly intact record. */
  const h = harness({ allowPublicMailboxes: false, allowedDomains: ["gmail.com"] });
  const body = await (await h.access(request(PATH, { token: await h.session() }))).json();
  assert.deepEqual(body.allowedDomains, ["gmail.com"]);
});

/* ------------------------------------------------------------------ */
/* replace, and the guarded write                                      */
/* ------------------------------------------------------------------ */

test("a PUT replaces the whole list rather than adding to it", async () => {
  const h = harness({ allowedDomains: [...LISTED_DOMAINS] });
  const token = await h.session();
  const body = await (await h.access(put(token, ["only.example.net"]))).json();
  assert.deepEqual(body.allowedDomains, ["only.example.net"]);
  assert.deepEqual(h.record().allowedDomains, ["only.example.net"]);
});

test("an empty list is how a policy is cleared", async () => {
  const h = harness({ allowedDomains: [...LISTED_DOMAINS] });
  const token = await h.session();
  assert.deepEqual((await (await h.access(put(token, []))).json()).allowedDomains, []);
  assert.deepEqual(h.record().allowedDomains, []);
});

test("writing the same list twice is a success both times", async () => {
  const h = harness();
  const token = await h.session();
  assert.equal((await h.access(put(token, [LISTED_DOMAIN]))).status, 200);
  const again = await h.access(put(token, [` ${LISTED_DOMAIN.toUpperCase()} `]));
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).allowedDomains, [LISTED_DOMAIN]);
});

test("the GET and the PUT answer the same shape", async () => {
  const h = harness();
  const token = await h.session();
  const written = await (await h.access(put(token, [SECOND_LISTED_DOMAIN]))).json();
  const read = await (await h.access(request(PATH, { token }))).json();
  assert.deepEqual(written, read);
});

test("the write changes the list and nothing else about the record", async () => {
  /* A policy write that carried anything else back - a state, a timestamp, an
     owner - would be a lifecycle transition nobody asked for. */
  const h = harness();
  const before = h.record();
  await h.access(put(await h.session(), [LISTED_DOMAIN]));
  const after = h.record();

  assert.deepEqual(after.allowedDomains, [LISTED_DOMAIN]);
  assert.deepEqual({ ...after, allowedDomains: null }, { ...before, allowedDomains: null });
});

test("a concurrent transition is not overwritten by a policy write", async () => {
  /* The reason this is a read-merge-write loop under the store's compare-and-
     set rather than a write. The record moves between this call's read and its
     write; the conditional write is refused, and the retry re-reads and
     re-checks against what is actually stored - so the cancellation survives
     and the caller is told the truth. */
  const h = harness();
  const token = await h.session();
  h.provider.beforeWrite(() => {
    h.provider.beforeWrite(null);
    h.provider.put(FIXTURE_KEY, JSON.stringify(RECORDS.cancelled));
  });

  const response = await h.access(put(token, [LISTED_DOMAIN]));
  await refusal(response, 404, "not_found");
  assert.equal(h.record().state, "cancelled");
});

test("a storage outage is a retryable 503, never a denial", async () => {
  const h = harness();
  const token = await h.session();
  h.provider.failNextRead({ throws: true });
  const body = await refusal(await h.access(request(PATH, { token })), 503, "unavailable");
  assert.equal(body.error.retryable, true);
});

test("no response from this route carries a CORS grant", async () => {
  const h = harness();
  const token = await h.session();
  for (const response of [
    await h.access(request(PATH, { token })),
    await h.access(put(token, [LISTED_DOMAIN])),
    await h.access(request(PATH, { token: null })),
  ]) {
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vary"), "Cookie");
  }
});
