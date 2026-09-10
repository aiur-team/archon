/**
 * Role precedence, over an in-memory store.
 *
 * ACN-006 changed two things about who `resolveRole()` thinks somebody is: the
 * identity it accepts carries `emailVerified` where it used to carry `isOrg`,
 * and the site-wide organisation tier that read `isOrg` is gone. ACN-008
 * finishes the job — the public default goes with it, and a per-document
 * `allowedDomains` list takes their place — so this suite holds both halves:
 * an invitation is satisfied only by a proven address, a grant keyed on a
 * subject the old identity provider issued resolves to nothing, and a listed
 * domain admits a verified reader as `viewer` and nobody else.
 *
 * The domain rows are not written here. They are ACN-007's shared table in
 * `netlify/test/hosted/fixtures/domain-access.mjs`, replayed through
 * `resolveRole()`, so a threat this deployment is held to on a hosted document
 * is the same threat it is held to on a collaboration document. A fork of that
 * table would be the exact defect the shared file exists to prevent, and the
 * import is asserted below so one fails CI.
 *
 * The store is injected, so nothing here reaches a provider or a credential.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OWNER_ACCOUNT_ID,
} from "../test/hosted/contract-fixtures.mjs";
import {
  LISTED_DOMAIN,
  LISTED_DOMAINS,
  READ_CASES,
  SECOND_LISTED_DOMAIN,
} from "../test/hosted/fixtures/domain-access.mjs";
import {
  accessDocumentKey,
  accessGrantKey,
  accessInvitationKey,
  resolveRole,
} from "./access.mjs";
import { StoreError } from "./store.mjs";

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

/** The current stored shape: version 2, carrying a domain list. */
function document(overrides = {}) {
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

/** The shape written before ACN-008, which a live deployment still holds. */
function legacyDocument(overrides = {}) {
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

function grant(overrides = {}) {
  return {
    v: 1,
    docId: DOC,
    sub: READER,
    email: `ann@${LISTED_DOMAIN}`,
    name: "Ann",
    role: "editor",
    grantedBy: { sub: OWNER, name: "Owner", email: "owner@example.com" },
    grantedAt: "2026-01-02T00:00:00.000Z",
    fromInvitation: null,
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

/**
 * Run `body` with `PUBLIC_DEFAULT_ROLE` set, and restore the environment after.
 *
 * The variable is meaningless to this module now, and proving that is the whole
 * reason these rows set it: an operator upgrading a running deployment does not
 * unset their site variables first, so the retired tier has to be inert while
 * its configuration is still present rather than merely absent from the code.
 */
async function withPublicDefaultRole(value, body) {
  const had = Object.hasOwn(process.env, "PUBLIC_DEFAULT_ROLE");
  const saved = process.env.PUBLIC_DEFAULT_ROLE;
  process.env.PUBLIC_DEFAULT_ROLE = value;
  try {
    await body();
  } finally {
    if (had) process.env.PUBLIC_DEFAULT_ROLE = saved;
    else delete process.env.PUBLIC_DEFAULT_ROLE;
  }
}

/* -------------------------------------------------------------------------- */
/* ACN-006: identity, invitations and stale subjects                           */
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

  const converted = store.values.get(accessGrantKey(DOC, READER));
  assert.equal(converted.role, "editor", "and becomes a grant keyed on the v2 accountId");
  assert.equal(converted.sub, READER);
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
    [accessGrantKey(DOC, LEGACY_SUB)]: grant({
      sub: LEGACY_SUB,
      email: "invitee@example.com",
      name: "Invitee",
      role: "owner",
    }),
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

/* -------------------------------------------------------------------------- */
/* ACN-008: the retired default tiers                                          */
/* -------------------------------------------------------------------------- */

test("a signed-in stranger resolves none while PUBLIC_DEFAULT_ROLE still says viewer", async () => {
  // AE4. The variable is the danger the ticket names: sign-in is open to anyone
  // with a Google or GitHub account, so "any other authenticated caller" is the
  // internet. The tier is removed rather than defaulted off, which means a
  // deployment that still carries the variable admits nobody by it.
  await withPublicDefaultRole("viewer", async () => {
    const store = memoryStore({ [accessDocumentKey(DOC)]: document() });
    const access = await resolve(store, user({ email: "someone@stranger.example" }));
    assert.equal(access.role, "none");
    assert.equal(access.canRead, false);
    assert.equal(access.shared, true, "the document is shared; this caller is simply not on it");
  });
});

test("a v:1 record reads as an empty domain list and its orgDefault admits nobody", async () => {
  // Both readable organisation defaults, and the explicit denial, now mean the
  // same thing: nothing. A stored `viewer` must not become a domain-shaped
  // admission on the way through the migration.
  await withPublicDefaultRole("viewer", async () => {
    for (const orgDefault of ["commenter", "viewer", "none"]) {
      const store = memoryStore({ [accessDocumentKey(DOC)]: legacyDocument({ orgDefault }) });
      const access = await resolve(store, user({ email: `ann@${LISTED_DOMAIN}` }));
      assert.equal(access.role, "none", `orgDefault ${orgDefault} grants nobody anything`);
    }
  });
});

test("a v:1 record still lets its owner in, and the next write stores v:2 without orgDefault", async () => {
  const store = memoryStore({ [accessDocumentKey(DOC)]: legacyDocument() });
  const access = await resolve(store, user({ sub: OWNER, email: "owner@example.com" }));
  assert.equal(access.role, "owner", "a migration must not lock an owner out");

  // The library performs no write on a read, so the record on the way out of the
  // store is untouched; the migrated shape is what a caller sees and what the
  // write surface stores next. Both halves are asserted: the stored bytes are
  // still v:1, and the seed path below writes the new shape directly.
  assert.equal(store.values.get(accessDocumentKey(DOC)).v, 1, "reading migrates nothing");

  const seeded = memoryStore();
  const bound = await resolveRole(DOC, user({ sub: READER, email: "seed@example.com" }), {
    store: seeded,
    now: NOW,
    docOwners: `${DOC}:seed@example.com`,
  });
  assert.equal(bound.role, "owner");
  const written = seeded.values.get(accessDocumentKey(DOC));
  assert.equal(written.v, 2, "a document bound today is written at the current version");
  assert.deepEqual(written.allowedDomains, []);
  assert.equal(Object.hasOwn(written, "orgDefault"), false, "and carries no retired key");
});

test("the version-2 shape is the document's alone: a v:2 grant is still refused", async () => {
  // The store's version gate takes the accepted set from its caller precisely so
  // that this widening does not leak. A grant is version 1 and stays version 1.
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document(),
    [accessGrantKey(DOC, READER)]: grant({ v: 2 }),
  });
  await assert.rejects(
    () => resolve(store, user()),
    (error) => {
      assert.ok(error instanceof StoreError);
      assert.equal(error.code, "unsupported-version");
      return true;
    },
  );
});

/* -------------------------------------------------------------------------- */
/* ACN-008: the domain tier                                                    */
/* -------------------------------------------------------------------------- */

test("the shared ACN-007 fixture table is the source of the domain rows", () => {
  // Asserting the import rather than restating the payloads: if somebody forks
  // the table into this file, these identities stop being the shared ones and
  // this fails before any behaviour does.
  assert.deepEqual([...LISTED_DOMAINS], [LISTED_DOMAIN, SECOND_LISTED_DOMAIN]);
  assert.ok(READ_CASES.length > 0, "the shared read table is non-empty");
  assert.ok(
    READ_CASES.some((row) => row.role === "reader"),
    "and still carries admitted rows, so a table gone empty cannot pass silently",
  );
});

/**
 * The shared read table, replayed through `resolveRole()`.
 *
 * `evaluatorOnly` rows are skipped for the same reason the hosted read-path
 * suite skips them: their principals are ones no session store would hold — an
 * unnormalized address, an `emailVerified` that is not a boolean — and the
 * collaboration identity boundary refuses them earlier and harder than the
 * evaluator does. `invalid-user` for a non-boolean `emailVerified` is asserted
 * directly above; the case-insensitivity those rows would otherwise cover is
 * asserted below, where an address the identity layer *does* normalize is shown
 * to match.
 *
 * `reader` is the hosted vocabulary for the role a domain yields. Here it is
 * `viewer`, which is the same decision in this tree's role names; every refusal
 * reason, whatever it discloses to a hosted caller, is `none`.
 */
for (const row of READ_CASES) {
  if (row.evaluatorOnly === true) continue;
  const expected = row.role === undefined ? "none" : row.role === "reader" ? "viewer" : row.role;
  test(`domain table: ${row.name} -> ${expected}`, async () => {
    const allowedDomains = row.allowedDomains === undefined
      ? [...LISTED_DOMAINS]
      : [...row.allowedDomains];
    const store = memoryStore({
      [accessDocumentKey(DOC)]: document({
        ownerSub: FIXTURE_OWNER_ACCOUNT_ID,
        allowedDomains,
      }),
    });
    const caller = row.principal === null ? null : {
      sub: row.principal.accountId,
      email: row.principal.email ?? "",
      emailVerified: row.principal.emailVerified,
      name: "Fixture Reader",
    };
    const access = await resolve(store, caller);
    assert.equal(access.role, expected);
    assert.equal(access.canRead, expected !== "none");
    if (expected === "viewer") {
      assert.equal(access.canComment, false, "a domain never yields more than a read");
      assert.equal(access.canEdit, false);
      assert.equal(access.canShare, false);
    }
  });
}

test("matching is case-insensitive on an address the identity layer normalized (AE3)", async () => {
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ allowedDomains: [...LISTED_DOMAINS] }),
  });
  const access = await resolve(store, user({ email: `Bob@${LISTED_DOMAIN.toUpperCase()}` }));
  assert.equal(access.role, "viewer");
});

test("an explicit grant outranks the domain list", async () => {
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ allowedDomains: [...LISTED_DOMAINS] }),
    [accessGrantKey(DOC, READER)]: grant({ role: "editor" }),
  });
  const access = await resolve(store, user({ email: `ann@${LISTED_DOMAIN}` }));
  assert.equal(access.role, "editor", "a decision about this person beats one about their domain");
  assert.equal(access.canEdit, true);
});

test("a live invitation outranks the domain list", async () => {
  const key = await accessInvitationKey(DOC, `ann@${LISTED_DOMAIN}`);
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ allowedDomains: [...LISTED_DOMAINS] }),
    [key]: invitation({ email: `ann@${LISTED_DOMAIN}`, role: "commenter" }),
  });
  const access = await resolve(store, user({ email: `ann@${LISTED_DOMAIN}` }));
  assert.equal(access.role, "commenter");
  assert.ok(store.values.has(key), "and the read-only call consumed nothing");
});

test("an expired invitation falls through to the domain list rather than past it", async () => {
  // The order matters in both directions: an invitation that is no longer live
  // must not deny a reader the domain list would admit.
  const key = await accessInvitationKey(DOC, `ann@${LISTED_DOMAIN}`);
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ allowedDomains: [...LISTED_DOMAINS] }),
    [key]: invitation({
      email: `ann@${LISTED_DOMAIN}`,
      role: "editor",
      invitedAt: "2026-01-01T12:00:00.000Z",
      expiresAt: "2026-01-31T12:00:00.000Z",
    }),
  });
  const access = await resolve(store, user({ email: `ann@${LISTED_DOMAIN}` }));
  assert.equal(access.role, "viewer");
});

test("no grant row is written when a domain admits a reader", async () => {
  const store = memoryStore({
    [accessDocumentKey(DOC)]: document({ allowedDomains: [...LISTED_DOMAINS] }),
  });
  const access = await resolve(store, user({ email: `ann@${LISTED_DOMAIN}` }), {
    consumeInvitation: true,
  });
  assert.equal(access.role, "viewer");
  assert.equal(store.values.has(accessGrantKey(DOC, READER)), false,
    "the decision is recomputed per request, so there is nothing to leave behind");
});

test("clearing the list denies the same reader on the very next request (R21)", async () => {
  const key = accessDocumentKey(DOC);
  const store = memoryStore({ [key]: document({ allowedDomains: [...LISTED_DOMAINS] }) });
  const caller = user({ email: `ann@${LISTED_DOMAIN}` });

  assert.equal((await resolve(store, caller)).role, "viewer");
  store.values.set(key, document({ allowedDomains: [] }));
  const after = await resolve(store, caller);
  assert.equal(after.role, "none", "no sign-out is needed for a removal to take effect");
  assert.equal(after.canRead, false);
});

test("a stored domain list that is not the canonical normalized form is a corrupt record", async () => {
  // Read rather than repaired. A list this module cannot recognise is state
  // nobody wrote through the one write surface, and guessing at it is how an
  // unnormalized entry ends up compared against a normalized address.
  for (const allowedDomains of [[`  ${LISTED_DOMAIN}`], ["Example.COM"], [SECOND_LISTED_DOMAIN, LISTED_DOMAIN], [42]]) {
    const store = memoryStore({ [accessDocumentKey(DOC)]: document({ allowedDomains }) });
    await assert.rejects(
      () => resolve(store, user({ email: `ann@${LISTED_DOMAIN}` })),
      (error) => {
        assert.equal(error.code, "invalid-record");
        return true;
      },
      `a stored list of ${JSON.stringify(allowedDomains)} is refused`,
    );
  }
});
