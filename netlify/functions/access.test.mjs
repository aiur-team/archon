/**
 * The owner-only domain-list write on `PATCH /api/access` (ACN-008).
 *
 * The surface has no `op` field, so the operation is named by the field set:
 * `["doc", "allowedDomains"]`, in the slot the retired `["doc", "orgDefault"]`
 * variant held. This suite drives the real handler over an in-memory store and
 * an injected identity, and its accept/refuse rows are ACN-007's shared table in
 * `netlify/test/hosted/fixtures/domain-access.mjs` rather than a second list —
 * a forked table is the exact defect the shared file exists to prevent, so the
 * import is asserted below and a fork fails CI.
 *
 * `scripts/test-p4-j.mjs` remains the coordinator's own suite: leases, epochs,
 * transfer markers and the release-failure ordering are proved there, and are
 * deliberately not restated here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  LISTED_DOMAIN,
  SECOND_LISTED_DOMAIN,
  WRITE_CASES,
} from "../test/hosted/fixtures/domain-access.mjs";
import {
  accessDocumentKey,
  accessGrantKey,
  capabilitiesFor,
} from "../lib/access.mjs";
import { createAccessHandler } from "./access.mjs";

const DOC = "abc123";
const NOW_MS = Date.parse("2026-09-10T12:00:00.000Z");
const OWNER = Object.freeze({
  sub: `a0_${"1".repeat(32)}`,
  email: "owner@example.com",
  emailVerified: true,
  name: "Owner Vale",
});
const STRANGER = Object.freeze({ ...OWNER, sub: `a0_${"2".repeat(32)}`, email: "ann@partner.example.org" });

/** The eight capabilities plus the two identity fields, as the route validates. */
function accessRow(role, shared) {
  return { role, shared, ...capabilitiesFor(role) };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** The store methods this route uses, over a `Map`, with a conditional write. */
function makeStore() {
  const data = new Map();
  let seq = 0;
  return {
    async getWithMetadata(key, options) {
      if (!options || options.type !== "json" || options.consistency !== "strong") {
        throw new Error("read must be strong json");
      }
      if (!data.has(key)) return null;
      const entry = data.get(key);
      return { data: clone(entry.value), etag: entry.etag };
    },
    async setJSON(key, value, options) {
      const exists = data.has(key);
      if (options?.onlyIfNew === true) {
        if (exists) return { modified: false };
      } else if (typeof options?.onlyIfMatch === "string") {
        if (!exists || data.get(key).etag !== options.onlyIfMatch) return { modified: false };
      } else {
        throw new Error("unguarded write");
      }
      seq += 1;
      data.set(key, { value: clone(value), etag: `etag-${seq}` });
      return { modified: true, etag: `etag-${seq}` };
    },
    async delete(key) {
      data.delete(key);
    },
    list(options) {
      const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort();
      return {
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            next() {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({
                done: false,
                value: { blobs: keys.map((key) => ({ key })), directories: [] },
              });
            },
          };
        },
      };
    },
    put(key, value) {
      seq += 1;
      data.set(key, { value: clone(value), etag: `etag-${seq}` });
    },
    peek(key) {
      return data.has(key) ? clone(data.get(key).value) : null;
    },
  };
}

/** The current stored shape. */
function documentRecord(overrides = {}) {
  return {
    v: 2,
    docId: DOC,
    ownerSub: OWNER.sub,
    ownerEmail: OWNER.email,
    allowedDomains: [],
    boundAt: "2026-01-01T00:00:00.000Z",
    boundFrom: "env:DOC_OWNERS",
    ...overrides,
  };
}

/** The shape written before ACN-008, which a live deployment still holds. */
function legacyDocumentRecord(overrides = {}) {
  return {
    v: 1,
    docId: DOC,
    ownerSub: OWNER.sub,
    ownerEmail: OWNER.email,
    orgDefault: "commenter",
    boundAt: "2026-01-01T00:00:00.000Z",
    boundFrom: "env:DOC_OWNERS",
    ...overrides,
  };
}

function seededStore(document = documentRecord()) {
  const store = makeStore();
  store.put(accessDocumentKey(DOC), document);
  return store;
}

/**
 * The handler with every outward dependency injected.
 *
 * `allowPublicMailboxesFn` is the ACN-007 escape hatch. In production it is read
 * through `readHostedConfig`, which refuses anything but exactly `"true"` or
 * `"false"`; here it is a boolean directly, because what these rows are about is
 * what the route does with the answer rather than how the answer is spelled in
 * an environment.
 */
function kitFor(store, overrides = {}) {
  const events = [];
  let randomSeq = 0;
  return {
    events,
    handler: createAccessHandler({
      requireOriginFn() {},
      identifyFn() {
        return { ...OWNER };
      },
      resolveRoleFn() {
        return accessRow("owner", true);
      },
      storeFn() {
        return store;
      },
      appendEventFn(input) {
        events.push(clone({ kind: input.kind, target: input.target, summary: input.summary }));
        return Promise.resolve({ v: 1 });
      },
      randomBytesFn(size) {
        randomSeq += 1;
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index += 1) bytes[index] = (index + randomSeq * 17) & 0xff;
        return bytes;
      },
      nowFn() {
        return NOW_MS;
      },
      allowPublicMailboxesFn() {
        return false;
      },
      ...overrides,
    }),
  };
}

function patch(body) {
  return new Request("https://docs.example.invalid/api/access", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRoster() {
  return new Request(`https://docs.example.invalid/api/access?doc=${DOC}`);
}

/* -------------------------------------------------------------------------- */

test("the shared ACN-007 fixture table is the source of the write rows", () => {
  assert.ok(WRITE_CASES.length > 0, "the shared write table is non-empty");
  assert.ok(
    WRITE_CASES.some((row) => row.expect !== undefined),
    "and still carries accepted rows, so a table gone empty cannot pass silently",
  );
  assert.ok(WRITE_CASES.some((row) => row.reason === "public_mailbox_domain"));
});

/**
 * The shared write table, replayed through the route.
 *
 * An accepted row must answer the normalized list, and the stored record must
 * hold exactly that list — the response and the state agreeing is the property,
 * because an owner reading a normalized answer has to be able to trust it
 * describes their document. A refused row must answer 400 with the shared
 * reason, and must leave the record alone.
 */
for (const row of WRITE_CASES) {
  test(`write table: ${row.name}`, async () => {
    const store = seededStore();
    const kit = kitFor(store);
    const response = await kit.handler(patch({ doc: DOC, allowedDomains: row.input }));
    const body = await response.json();

    if (row.expect !== undefined) {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body, { ok: true, doc: DOC, allowedDomains: row.expect });
      assert.deepEqual(store.peek(accessDocumentKey(DOC)).allowedDomains, row.expect,
        "the answer and the stored record are the same list");
      return;
    }

    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.error, row.reason);
    if (Object.hasOwn(row, "domain")) {
      assert.equal(body.domain ?? null, row.domain, "the offending entry is named back");
    }
    assert.deepEqual(store.peek(accessDocumentKey(DOC)).allowedDomains, [],
      "a refused list changes nothing");
  });
}

test("the public-mailbox denylist is lifted by the site-wide flag, and only by it", async () => {
  // AE6. Off, `gmail.com` is refused with the reason that names it; on, the same
  // request stores the same list. The flag is the deployment's, never an owner's.
  const refusedStore = seededStore();
  const refused = await kitFor(refusedStore).handler(
    patch({ doc: DOC, allowedDomains: ["gmail.com"] }),
  );
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "public_mailbox_domain", domain: "gmail.com" });

  const allowedStore = seededStore();
  const allowed = await kitFor(allowedStore, { allowPublicMailboxesFn: () => true }).handler(
    patch({ doc: DOC, allowedDomains: ["gmail.com"] }),
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { ok: true, doc: DOC, allowedDomains: ["gmail.com"] });
  assert.deepEqual(allowedStore.peek(accessDocumentKey(DOC)).allowedDomains, ["gmail.com"]);
});

test("a truthy-but-not-true answer from the flag does not lift the denylist", async () => {
  // The evaluator takes the boolean exactly. Asserted from this side too, because
  // this is the call site that would be tempted to pass a string through.
  const store = seededStore();
  const response = await kitFor(store, { allowPublicMailboxesFn: () => "true" }).handler(
    patch({ doc: DOC, allowedDomains: ["gmail.com"] }),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "public_mailbox_domain");
});

test("a non-owner is refused by authorize, and learns nothing about the list", async () => {
  const store = seededStore();
  const kit = kitFor(store, {
    identifyFn: () => ({ ...STRANGER }),
    resolveRoleFn: () => accessRow("editor", true),
  });
  const response = await kit.handler(patch({ doc: DOC, allowedDomains: ["gmail.com"] }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden" },
    "the mailbox reason would tell a stranger what this deployment refuses");
  assert.equal(kit.events.length, 0);
});

test("the document's own owner check refuses a caller resolve said was the owner", async () => {
  // The conditional write revalidates `ownerSub` under the lease. A resolver that
  // answered `owner` for somebody the record does not name — a stale read, or a
  // transfer that landed between the two — still writes nothing.
  const store = seededStore(documentRecord({ ownerSub: `a0_${"9".repeat(32)}` }));
  const response = await kitFor(store, { identifyFn: () => ({ ...OWNER }) }).handler(
    patch({ doc: DOC, allowedDomains: [LISTED_DOMAIN] }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(store.peek(accessDocumentKey(DOC)).allowedDomains, []);
});

test("clearing the list is an empty array, and is answered as one", async () => {
  const store = seededStore(documentRecord({ allowedDomains: [LISTED_DOMAIN, SECOND_LISTED_DOMAIN] }));
  const kit = kitFor(store);
  const response = await kit.handler(patch({ doc: DOC, allowedDomains: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, doc: DOC, allowedDomains: [] });
  assert.deepEqual(store.peek(accessDocumentKey(DOC)).allowedDomains, []);
  assert.equal(kit.events[0].kind, "access.change");
});

test("writing the same list again changes nothing and appends no event", async () => {
  const store = seededStore(documentRecord({ allowedDomains: [LISTED_DOMAIN] }));
  const kit = kitFor(store);
  const response = await kit.handler(patch({ doc: DOC, allowedDomains: [` ${LISTED_DOMAIN.toUpperCase()} `] }));
  assert.equal(response.status, 200, "a no-op still answers the list, so a client can trust it");
  assert.deepEqual(await response.json(), { ok: true, doc: DOC, allowedDomains: [LISTED_DOMAIN] });
  assert.equal(kit.events.length, 0, "and an unchanged document is not an audit event");
});

test("a v:1 record is migrated by the write: v:2, no orgDefault, the new list", async () => {
  const store = seededStore(legacyDocumentRecord({ orgDefault: "viewer" }));
  const kit = kitFor(store);
  const response = await kit.handler(patch({ doc: DOC, allowedDomains: ["Example.COM"] }));
  assert.equal(response.status, 200);

  const written = store.peek(accessDocumentKey(DOC));
  assert.equal(written.v, 2);
  assert.equal(Object.hasOwn(written, "orgDefault"), false, "the retired key is not carried forward");
  assert.deepEqual(written.allowedDomains, [LISTED_DOMAIN]);
  assert.equal(written.ownerSub, OWNER.sub, "and nothing else about the record moved");
  assert.equal(written.boundAt, "2026-01-01T00:00:00.000Z");
});

test("clearing an already-empty v:1 list is still the migration write", async () => {
  // Against the *view* of a v:1 record this looks like a no-op, because a v:1
  // record reads as `allowedDomains: []`. The comparison is against the stored
  // bytes for exactly this reason.
  const store = seededStore(legacyDocumentRecord());
  const response = await kitFor(store).handler(patch({ doc: DOC, allowedDomains: [] }));
  assert.equal(response.status, 200);
  assert.equal(store.peek(accessDocumentKey(DOC)).v, 2);
});

test("the retired orgDefault variant is no longer a request body", async () => {
  const store = seededStore();
  for (const body of [
    { doc: DOC, orgDefault: "viewer" },
    { doc: DOC, orgDefault: "none" },
    { doc: DOC, allowedDomains: [LISTED_DOMAIN], orgDefault: "viewer" },
  ]) {
    const response = await kitFor(store).handler(patch(body));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "invalid-request");
  }
});

test("allowedDomains must be an array before anything else looks at it", async () => {
  const store = seededStore();
  for (const allowedDomains of ["example.com", null, 42, { 0: "example.com" }]) {
    const response = await kitFor(store).handler(patch({ doc: DOC, allowedDomains }));
    assert.equal(response.status, 400, JSON.stringify(allowedDomains));
    assert.equal((await response.json()).error, "invalid-request");
  }
});

test("the roster reports the document's domain list where it used to report orgDefault", async () => {
  const store = seededStore(documentRecord({ allowedDomains: [LISTED_DOMAIN, SECOND_LISTED_DOMAIN] }));
  store.put(accessGrantKey(DOC, STRANGER.sub), {
    v: 1,
    docId: DOC,
    sub: STRANGER.sub,
    email: STRANGER.email,
    name: "Ann",
    role: "editor",
    grantedBy: { sub: OWNER.sub, name: OWNER.name, email: OWNER.email },
    grantedAt: "2026-01-02T00:00:00.000Z",
    fromInvitation: null,
  });

  const response = await kitFor(store).handler(getRoster());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal("orgDefault" in body, false, "the retired field is removed, not emptied");
  assert.deepEqual(body.allowedDomains, [LISTED_DOMAIN, SECOND_LISTED_DOMAIN]);
  assert.deepEqual(body.members.map(({ role }) => role), ["owner", "editor"],
    "and the roster itself is unchanged");
});

test("a v:1 record's roster reports an empty list rather than failing to read", async () => {
  const store = seededStore(legacyDocumentRecord({ orgDefault: "commenter" }));
  const body = await (await kitFor(store).handler(getRoster())).json();
  assert.deepEqual(body.allowedDomains, []);
});
