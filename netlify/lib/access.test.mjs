/**
 * Role precedence after the organisation tier, over an in-memory store.
 *
 * ACN-006 changed two things about who `resolveRole()` thinks somebody is: the
 * identity it accepts carries `emailVerified` where it used to carry `isOrg`,
 * and the `orgDefault`-for-members tier that read `isOrg` is gone. This suite
 * holds the consequences that matter — an invitation is satisfied only by a
 * proven address, an identity with no address is refused rather than crashed,
 * and a grant keyed on a subject the old identity provider issued resolves to
 * nothing rather than to its former owner.
 *
 * The store is injected, so nothing here reaches a provider or a credential.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  accessDocumentKey,
  accessGrantKey,
  accessInvitationKey,
  resolveRole,
} from "./access.mjs";

const DOC = "abc123";
const NOW = "2026-09-10T12:00:00.000Z";
/** Exactly the 30-day invitation lifetime after `NOW`, as the record demands. */
const LATER = "2026-10-10T12:00:00.000Z";

const OWNER = `a0_${"1".repeat(32)}`;
const READER = `a0_${"2".repeat(32)}`;

/** A Netlify Identity subject, as every grant written before ACN-006 is keyed. */
const LEGACY_SUB = "u_2f8c1d0e9b7a4653";

/**
 * The three store methods `netlify/lib/access.mjs` uses, over a `Map`.
 *
 * `etag` is the stringified write counter rather than a digest: the library
 * only ever compares one to another, so any value that changes on every write
 * is a faithful stand-in and a hash would be a second thing to get wrong.
 */
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

function document(overrides = {}) {
  return {
    v: 1,
    docId: DOC,
    ownerSub: OWNER,
    ownerEmail: "owner@example.com",
    orgDefault: "commenter",
    boundAt: "2026-01-01T00:00:00.000Z",
    boundFrom: "env:DOC_OWNERS",
    ...overrides,
  };
}

function invitation(overrides = {}) {
  return {
    v: 1,
    docId: DOC,
    email: "invitee@example.com",
    role: "editor",
    invitedBy: { sub: OWNER, name: "Owner", email: "owner@example.com" },
    invitedAt: NOW,
    expiresAt: LATER,
    accountCreated: false,
    ...overrides,
  };
}

function user(overrides = {}) {
  return { sub: READER, email: "invitee@example.com", emailVerified: true, name: "Invitee", ...overrides };
}

/** `resolveRole` with the tests' fixed clock, no `DOC_OWNERS`, one store. */
function resolve(store, caller, options = {}) {
  return resolveRole(DOC, caller, { store, now: NOW, docOwners: "", ...options });
}

/* -------------------------------------------------------------------------- */

test("the identity shape is the four ACN-006 fields, and isOrg is not one", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: document() });

  await assert.rejects(
    () => resolve(store, { sub: READER, email: "a@example.com", isOrg: false, name: "A" }),
    (error) => {
      assert.equal(error.code, "invalid-user", "a caller carrying the old field is refused");
      return true;
    },
  );
  await assert.rejects(
    () => resolve(store, { sub: READER, email: "a@example.com", emailVerified: "yes", name: "A" }),
    (error) => {
      assert.equal(error.code, "invalid-user", "and emailVerified is a strict boolean");
      return true;
    },
  );
});

test("an invited address signing in verified resolves the invited role and consumes the invitation", async () => {
  const key = await accessInvitationKey(DOC, "invitee@example.com");
  const store = memoryStore({ [accessDocumentKey(DOC)]: document(), [key]: invitation() });

  const access = await resolve(store, user(), { consumeInvitation: true });
  assert.equal(access.role, "editor");
  assert.equal(access.canEdit, true);
  assert.equal(store.values.has(key), false, "the invitation is consumed");

  const grant = store.values.get(accessGrantKey(DOC, READER));
  assert.equal(grant.role, "editor", "and becomes a grant keyed on the v2 accountId");
  assert.equal(grant.sub, READER);
});

test("the same address unverified resolves none and consumes nothing", async () => {
  const key = await accessInvitationKey(DOC, "invitee@example.com");
  const store = memoryStore({ [accessDocumentKey(DOC)]: document(), [key]: invitation() });

  const access = await resolve(store, user({ emailVerified: false }), { consumeInvitation: true });
  assert.equal(access.role, "none", "an unproven address is not the invited one");
  assert.equal(access.canRead, false);
  assert.deepEqual(store.values.get(key), invitation(), "the invitation is untouched");
  assert.equal(store.values.has(accessGrantKey(DOC, READER)), false, "and no grant is written");
});

test("an identity with no address at all resolves none and does not throw", async () => {
  const key = await accessInvitationKey(DOC, "invitee@example.com");
  const store = memoryStore({ [accessDocumentKey(DOC)]: document(), [key]: invitation() });

  const access = await resolve(
    store,
    user({ email: "", emailVerified: false }),
    { consumeInvitation: true },
  );
  assert.equal(access.role, "none");
  assert.ok(store.values.has(key), "and matches no invitation");
});

test("a grant keyed on a subject the old identity provider issued resolves none", async () => {
  // T13: every collaboration grant written before ACN-006 is keyed on a Netlify
  // Identity subject. Those subjects can never be issued again, so the row is
  // unreachable -- and the refusal must be an ordinary denial rather than a
  // crash or, far worse, a silent match.
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document(),
    [accessGrantKey(DOC, LEGACY_SUB)]: {
      v: 1,
      docId: DOC,
      sub: LEGACY_SUB,
      email: "invitee@example.com",
      name: "Invitee",
      role: "owner",
      grantedBy: { sub: OWNER, name: "Owner", email: "owner@example.com" },
      grantedAt: "2026-01-02T00:00:00.000Z",
      fromInvitation: null,
    },
  });

  const access = await resolve(store, user());
  assert.equal(access.role, "none", "the stale row is not reachable by the new subject");
  assert.equal(access.canRead, false);
  assert.equal(access.shared, true, "the document itself is still a shared one");
});

test("a document bound to an old owner subject no longer resolves owner", async () => {
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ ownerSub: LEGACY_SUB, ownerEmail: "invitee@example.com" }),
  });
  const access = await resolve(store, user());
  assert.equal(access.role, "none", "ownership is by subject, and that subject is gone");
});

test("the organisation tier is gone: a matching mailbox is no longer a member", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: document({ orgDefault: "commenter" }) });
  const access = await resolve(store, user({ email: "someone@example.com" }));
  assert.equal(access.role, "none", "orgDefault grants nobody anything by address");
  assert.equal(access.canRead, false);
});

test("an explicit orgDefault of none still suppresses the public default", async () => {
  // The field stays on the record and stays load-bearing until ACN-008 removes
  // it: "none" is a deliberate denial and must not be widened by the public tier.
  const store = memoryStore({ [accessDocumentKey(DOC)]: document({ orgDefault: "none" }) });
  const saved = process.env.PUBLIC_DEFAULT_ROLE;
  process.env.PUBLIC_DEFAULT_ROLE = "viewer";
  try {
    const denied = await resolve(store, user({ email: "someone@example.com" }));
    assert.equal(denied.role, "none");

    const open = memoryStore({ [accessDocumentKey(DOC)]: document({ orgDefault: "commenter" }) });
    const allowed = await resolve(open, user({ email: "someone@example.com" }));
    assert.equal(allowed.role, "viewer", "and the public tier is otherwise untouched");
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_DEFAULT_ROLE;
    else process.env.PUBLIC_DEFAULT_ROLE = saved;
  }
});

test("the bound owner still outranks everything, by subject", async () => {
  const key = await accessInvitationKey(DOC, "owner@example.com");
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document(),
    [key]: invitation({ email: "owner@example.com", role: "viewer" }),
  });
  const access = await resolve(
    store,
    user({ sub: OWNER, email: "owner@example.com" }),
    { consumeInvitation: true },
  );
  assert.equal(access.role, "owner");
  assert.ok(store.values.has(key), "and the owner path reads no invitation to consume");
});
