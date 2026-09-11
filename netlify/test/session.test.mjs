/**
 * `GET /api/session`, the route the collaboration page asks who it is talking to.
 *
 * ACN-006 changed two things here. The response no longer reports an
 * organisation role — the `roles` field is removed rather than emptied, because
 * a field that is always `["guest"]` is a claim a client will eventually believe.
 * And the identity it validates is the four-field ACN-006 shape, so a session
 * store outage on the identity path has to arrive as a 503 rather than as a 401
 * or a 500.
 *
 * `resolveRole` is the real one, over an in-memory store, so the role and the
 * capabilities in the body are resolved by the platform's one role authority
 * rather than asserted by a stub.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  accessDocumentKey,
  accessGrantKey,
  accessInvitationKey,
  resolveRole,
} from "../lib/access.mjs";
import { StoreError } from "../lib/store.mjs";
import { LISTED_DOMAIN } from "./hosted/fixtures/domain-access.mjs";
import { createSessionHandler } from "../functions/session.mjs";

const DOC = "abc123";
const NOW = "2026-09-10T12:00:00.000Z";
const EXPIRES = "2026-10-10T12:00:00.000Z";
const OWNER = `a0_${"1".repeat(32)}`;
const READER = `a0_${"2".repeat(32)}`;

function memoryStore(seed = {}) {
  const values = new Map(Object.entries(seed));
  let version = 0;
  return {
    values,
    async getWithMetadata(key) {
      if (!values.has(key)) return null;
      return { data: structuredClone(values.get(key)), etag: `v${version}` };
    },
    async setJSON(key, value, options = {}) {
      if (options.onlyIfNew === true && values.has(key)) return { modified: false };
      version += 1;
      values.set(key, structuredClone(value));
      return { modified: true, etag: `v${version}` };
    },
    async delete(key) {
      values.delete(key);
    },
  };
}

function documentRecord(overrides = {}) {
  return {
    v: 2,
    docId: DOC,
    ownerSub: OWNER,
    ownerEmail: "owner@example.com",
    allowedDomains: [],
    boundAt: "2026-01-01T00:00:00.000Z",
    boundFrom: "env:DOC_OWNERS",
    ...overrides,
  };
}

function invitationRecord(overrides = {}) {
  return {
    v: 1,
    docId: DOC,
    email: "invitee@example.com",
    role: "editor",
    invitedBy: { sub: OWNER, name: "Owner", email: "owner@example.com" },
    invitedAt: NOW,
    expiresAt: EXPIRES,
    accountCreated: false,
    ...overrides,
  };
}

function identity(overrides = {}) {
  return { sub: READER, email: "invitee@example.com", emailVerified: true, name: "Invitee", ...overrides };
}

/** The route, with a fixed clock and one injected store behind the real roles. */
function route({ identifyFn, store }) {
  return createSessionHandler({
    identifyFn,
    resolveRoleFn: (docId, user, options) =>
      resolveRole(docId, user, { ...options, store, now: NOW, docOwners: "" }),
  });
}

function get(query = `?doc=${DOC}`) {
  return new Request(`https://app.example.com/api/session${query}`);
}

/* -------------------------------------------------------------------------- */

test("a signed-in principal gets the resolved role, its capabilities and no roles field", async () => {
  const key = await accessInvitationKey(DOC, "invitee@example.com");
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord(), [key]: invitationRecord() });
  const response = await route({ identifyFn: async () => identity(), store })(get());

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  const body = await response.json();

  assert.deepEqual(Object.keys(body).sort(), [
    "canAccept", "canComment", "canEdit", "canSeeMembers", "canShare", "canSuggest",
    "doc", "email", "name", "role", "shared", "sub",
  ]);
  assert.equal("roles" in body, false, "the organisation report is removed, not emptied");
  assert.equal("emailVerified" in body, false, "and the verification claim is not projected");
  assert.equal(body.sub, READER, "the v2 accountId is what the page is told it is");
  assert.equal(body.email, "invitee@example.com");
  assert.equal(body.name, "Invitee");
  assert.equal(body.doc, DOC);
  assert.equal(body.role, "editor", "the invitation was resolved");
  assert.equal(body.shared, true);
  assert.equal(body.canEdit, true);
  assert.equal(body.canComment, true);

  assert.equal(store.values.has(key), false, "and consumed, because this route consumes");
  assert.equal(store.values.get(accessGrantKey(DOC, READER)).role, "editor");
});

test("an unverified address resolves none and consumes nothing", async () => {
  const key = await accessInvitationKey(DOC, "invitee@example.com");
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord(), [key]: invitationRecord() });
  const response = await route({
    identifyFn: async () => identity({ emailVerified: false }),
    store,
  })(get());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, "none");
  assert.equal(body.canEdit, false);
  assert.equal(body.canComment, false);
  assert.ok(store.values.has(key), "the invitation survives an unproven match");
});

test("a visitor with no session is 401 with no body", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  const response = await route({ identifyFn: async () => null, store })(get());
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "");
});

test("a session-store outage on the identity path is a 503, never a 401", async () => {
  // T12. `identify()` translates the hosted `AuthUnavailableError` into this
  // shape precisely so the outage arrives here distinguishable from a signed-out
  // visitor; reporting 401 would tell a page to send somebody to sign in again
  // during an incident, and 500 would say a retry is pointless.
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  const response = await route({
    identifyFn: async () => {
      throw new StoreError("unavailable", 503, "State store unavailable");
    },
    store,
  })(get());
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "");
});

test("a store outage on the access path is a 503 too", async () => {
  const failing = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  failing.getWithMetadata = async () => {
    throw new Error("blobs is down");
  };
  const response = await route({ identifyFn: async () => identity(), store: failing })(get());
  assert.equal(response.status, 503);
});

test("a bug is a 500 and is not laundered into a retryable outage", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  const response = await route({
    identifyFn: async () => {
      throw new TypeError("a bug");
    },
    store,
  })(get());
  assert.equal(response.status, 500);
});

test("an identity carrying the removed organisation field is refused as malformed", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  for (const bad of [
    { sub: READER, email: "a@example.com", name: "A", isOrg: false },
    { sub: READER, email: "a@example.com", emailVerified: "yes", name: "A" },
    { sub: "not a subject", email: "a@example.com", emailVerified: true, name: "A" },
  ]) {
    const response = await route({ identifyFn: async () => bad, store })(get());
    assert.equal(response.status, 500, `${JSON.stringify(bad)} is not an identity`);
  }
});

test("the document parameter is still exactly one well-formed id", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  const handler = route({ identifyFn: async () => identity(), store });
  for (const query of ["", "?doc=", "?doc=zzzzzz", "?doc=abc123&doc=abc124", "?doc=ABC123"]) {
    assert.equal((await handler(get(query))).status, 400, `${query || "(none)"} is refused`);
  }
});

test("only GET is answered", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
  const handler = route({ identifyFn: async () => identity(), store });
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await handler(
      new Request(`https://app.example.com/api/session?doc=${DOC}`, { method }),
    );
    assert.equal(response.status, 405, `${method} is refused`);
    assert.equal(response.headers.get("Allow"), "GET");
  }
});

test("the route is declared exactly once, at /api/session", async () => {
  const module = await import("../functions/session.mjs");
  assert.deepEqual(module.config, { path: "/api/session" });
  assert.equal(typeof module.default, "function");
});

test("a domain reader is reported as viewer, with a read-only capability row (ACN-008)", async () => {
  // The same `resolveRole()` the edge gate calls, so the role this route reports
  // and the role the gate enforced for the same request are one decision.
  const store = memoryStore({
    [accessDocumentKey(DOC)]: documentRecord({ allowedDomains: [LISTED_DOMAIN] }),
  });
  const reader = identity({ email: `ann@${LISTED_DOMAIN}` });
  const response = await route({ identifyFn: async () => reader, store })(get());

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.role, "viewer");
  assert.equal(body.shared, true);
  assert.equal(body.canComment, false, "a domain never yields more than a read");
  assert.equal(body.canEdit, false);
  assert.equal(body.canShare, false);
  assert.equal(body.canSeeMembers, false);
});

test("clearing the list denies the same session on its next call, with no sign-out (R21)", async () => {
  const key = accessDocumentKey(DOC);
  const store = memoryStore({ [key]: documentRecord({ allowedDomains: [LISTED_DOMAIN] }) });
  const reader = identity({ email: `ann@${LISTED_DOMAIN}` });
  const handler = route({ identifyFn: async () => reader, store });

  assert.equal((await (await handler(get())).json()).role, "viewer");
  store.values.set(key, documentRecord({ allowedDomains: [] }));
  assert.equal((await (await handler(get())).json()).role, "none");
});

test("a signed-in stranger is none while PUBLIC_DEFAULT_ROLE still says viewer (AE4)", async () => {
  const had = Object.hasOwn(process.env, "PUBLIC_DEFAULT_ROLE");
  const saved = process.env.PUBLIC_DEFAULT_ROLE;
  process.env.PUBLIC_DEFAULT_ROLE = "viewer";
  try {
    const store = memoryStore({ [accessDocumentKey(DOC)]: documentRecord() });
    const stranger = identity({ email: "ann@stranger.example" });
    const body = await (await route({ identifyFn: async () => stranger, store })(get())).json();
    assert.equal(body.role, "none");
    assert.equal(body.canComment, false);
  } finally {
    if (had) process.env.PUBLIC_DEFAULT_ROLE = saved;
    else delete process.env.PUBLIC_DEFAULT_ROLE;
  }
});
