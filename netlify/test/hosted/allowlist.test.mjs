/**
 * The stored allowlist: its record grammar, its compare-and-set discipline, the
 * two edits an admin can make, and the union with the environment seed.
 *
 * The store double is the same `MemoryBlobStore` the auth suites use, so these
 * tests run against the real conditional-write semantics - `onlyIfNew`,
 * `onlyIfMatch`, and the ambiguous answers the real client produces - with no
 * provider and no credential.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALLOWLIST_KEY,
  addAllowlistEntry,
  createAllowlistStore,
  readStoredAllowlist,
  removeAllowlistEntry,
  resolveAllowlist,
  validateAllowlistRecord,
} from "../../lib/hosted/allowlist.mjs";
import { HostedContractError } from "../../lib/hosted/contracts.mjs";
import { PlatformAccessError } from "../../lib/hosted/platform-access.mjs";
import { readHostedConfig } from "../../lib/hosted/config.mjs";
import { HOSTED_ENV } from "./fixtures/auth.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";

const ADMIN = "ops@example.com";
const AT = new Date("2026-09-10T12:00:00.000Z");

/*
 * The provider double the publication-store suite uses, not the auth suites'
 * `MemoryBlobStore`. The difference is load-bearing: this one holds the exact
 * JSON *string* a real `getWithMetadata(key, {type: "text"})` returns, and it
 * refuses an unconditional write outright. A double that handed back a parsed
 * object would let a record store that never serialised anything pass.
 */
function harness({ env = {} } = {}) {
  const provider = createProviderDouble();
  const store = createAllowlistStore({ getStore: provider.getStore });
  const config = readHostedConfig({ ...HOSTED_ENV, ...env });
  return { provider, store, config, now: () => AT };
}

/** The error a promise rejects with, so a test can assert on its fields. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

/* --- the record grammar --------------------------------------------------- */

test("a record is normalised, sorted and stripped of unknown fields", () => {
  const record = validateAllowlistRecord({
    v: 1,
    entries: [
      { kind: "email", value: "Named@Gmail.com", addedBy: "OPS@example.com", addedAt: AT.toISOString() },
      { kind: "domain", value: "ACME.example", addedBy: null, addedAt: null, note: "dropped" },
    ],
    extra: "dropped",
  });
  assert.deepEqual(record, {
    v: 1,
    entries: [
      { kind: "domain", value: "acme.example", addedBy: null, addedAt: null },
      { kind: "email", value: "named@gmail.com", addedBy: ADMIN, addedAt: AT.toISOString() },
    ],
  });
  assert.equal(Object.hasOwn(record, "extra"), false);
});

test("a record whose entry names the wrong kind is refused", () => {
  /* The one field here that is a security decision rather than a label: a record
     claiming `kind: "domain"` for an address would be compared against a
     principal's *domain* and admit everybody at it. */
  assert.throws(
    () => validateAllowlistRecord({ v: 1, entries: [{ kind: "domain", value: "ann@acme.example" }] }),
    HostedContractError,
  );
  assert.throws(
    () => validateAllowlistRecord({ v: 1, entries: [{ kind: "email", value: "acme.example" }] }),
    HostedContractError,
  );
});

test("an unknown schema version, a non-array and a bad entry are all refused", () => {
  for (const bad of [
    { v: 2, entries: [] },
    { v: 1, entries: {} },
    { v: 1 },
    { v: 1, entries: ["acme.example"] },
    { v: 1, entries: [{ kind: "email", value: "not-an-address" }] },
    null,
    [],
  ]) {
    assert.throws(() => validateAllowlistRecord(bad), HostedContractError);
  }
});

test("an unreadable audit field costs the provenance, not the entry", () => {
  /* The entry is the access decision; who added it is bookkeeping. Losing the
     bookkeeping for one entry is a smaller harm than reading the whole allowlist
     as unavailable. */
  const record = validateAllowlistRecord({
    v: 1,
    entries: [{ kind: "domain", value: "acme.example", addedBy: "NOT AN ADDRESS", addedAt: "yesterday" }],
  });
  assert.deepEqual(record.entries, [
    { kind: "domain", value: "acme.example", addedBy: null, addedAt: null },
  ]);
});

/* --- the store ------------------------------------------------------------ */

test("an absent key is the empty list, and an unreadable one is an outage", async () => {
  const { provider, store } = harness();
  assert.deepEqual([...(await readStoredAllowlist(store))], []);

  provider.failNextRead({ throws: true });
  const error = await rejection(readStoredAllowlist(store));
  assert.ok(error instanceof HostedContractError);
  assert.equal(error.code, "unavailable");
  assert.equal(error.retryable, true);
});

test("a stored record this version cannot interpret is an outage, not an empty list", async () => {
  /* Fail closed. Reading a corrupt record as "nobody is allowlisted" is the
     failure that turns a storage problem into a lockout that looks like policy;
     reading it as an outage is retryable and says what is actually wrong. */
  const { provider, store } = harness();
  provider.put(ALLOWLIST_KEY, JSON.stringify({ v: 99, entries: [] }));
  const error = await rejection(readStoredAllowlist(store));
  assert.equal(error.code, "unavailable");
});

test("adding an entry writes it with the admin who added it and when", async () => {
  const { store, now } = harness();
  const result = await addAllowlistEntry({ value: " Named@Gmail.com ", actor: ADMIN, now }, { store });
  assert.deepEqual(result, { added: true, entry: { kind: "email", value: "named@gmail.com" } });
  assert.deepEqual([...(await readStoredAllowlist(store))], [
    { kind: "email", value: "named@gmail.com", addedBy: ADMIN, addedAt: AT.toISOString() },
  ]);
});

test("adding an entry that is already there writes nothing and keeps its provenance", async () => {
  const { provider, store, now } = harness();
  await addAllowlistEntry({ value: "named@gmail.com", actor: ADMIN, now }, { store });
  const writes = provider.calls.filter((call) => call.op === "set").length;

  const again = await addAllowlistEntry(
    { value: "named@gmail.com", actor: "second@example.com", now: () => new Date("2027-01-01T00:00:00.000Z") },
    { store },
  );
  assert.equal(again.added, false);
  assert.equal(
    provider.calls.filter((call) => call.op === "set").length,
    writes,
    "an idempotent add costs no write",
  );
  const [held] = await readStoredAllowlist(store);
  assert.equal(held.addedBy, ADMIN, "the admin who actually added it keeps the attribution");
});

test("removing an entry removes exactly it", async () => {
  const { store, config, now } = harness();
  await addAllowlistEntry({ value: "named@gmail.com", actor: ADMIN, now }, { store });
  await addAllowlistEntry({ value: "acme.example", actor: ADMIN, now }, { store });

  const result = await removeAllowlistEntry({ value: "named@gmail.com" }, { store, config });
  assert.equal(result.removed, true);
  assert.deepEqual(
    (await readStoredAllowlist(store)).map((held) => held.value),
    ["acme.example"],
  );
});

test("removing an entry that is not there is not an error and not an oracle", async () => {
  /* Reporting "no such entry" would make this route answer differently for an
     address that is on the list and one that is not. */
  const { store, config } = harness();
  const result = await removeAllowlistEntry({ value: "stranger@example.com" }, { store, config });
  assert.deepEqual(result, { removed: false, entry: { kind: "email", value: "stranger@example.com" } });
});

test("a seeded entry cannot be removed from the page, and says where it lives", async () => {
  /* The page cannot write to the environment, so a removal it accepted would be
     undone by the next request reading the seed again. */
  const { store, config } = harness({ env: { ARCHON_PLATFORM_ALLOWLIST: "acme.example" } });
  const error = await rejection(removeAllowlistEntry({ value: "acme.example" }, { store, config }));
  assert.ok(error instanceof HostedContractError);
  assert.equal(error.code, "invalid_request");
  assert.match(error.message, /ARCHON_PLATFORM_ALLOWLIST/);
});

test("a value that is neither an address nor a domain never reaches the store", async () => {
  const { provider, store, config, now } = harness();
  await assert.rejects(
    () => addAllowlistEntry({ value: "not a domain", actor: ADMIN, now }, { store }),
    PlatformAccessError,
  );
  await assert.rejects(
    () => removeAllowlistEntry({ value: "not a domain" }, { store, config }),
    PlatformAccessError,
  );
  assert.deepEqual(
    provider.calls.filter((call) => call.op === "set"),
    [],
    "nothing was written",
  );
});

test("two admins adding at the same moment both land", async () => {
  /* The compare-and-set is re-derived against what is actually stored rather
     than replayed, so the loser of a race adds its entry to the winner's list
     instead of overwriting it. */
  const { provider, store, now } = harness();
  await addAllowlistEntry({ value: "first@example.com", actor: ADMIN, now }, { store });
  /* Another admin commits between this call's read and its write, so the
     compare-and-set is refused and the transform has to run again against what
     they left behind. */
  provider.beforeWrite(() => {
    provider.applyDirectly(ALLOWLIST_KEY, {
      v: 1,
      entries: [
        { kind: "email", value: "first@example.com", addedBy: ADMIN, addedAt: AT.toISOString() },
        { kind: "email", value: "third@example.com", addedBy: ADMIN, addedAt: AT.toISOString() },
      ],
    });
  });
  await addAllowlistEntry({ value: "second@example.com", actor: ADMIN, now }, { store });

  assert.deepEqual(
    (await readStoredAllowlist(store)).map((held) => held.value),
    ["first@example.com", "second@example.com", "third@example.com"],
    "the loser adds to the winner's list rather than overwriting it",
  );
});

test("a write whose response was lost is resolved by reading, not guessed at", async () => {
  /* `@netlify/blobs` reports `{modified: true, etag: ""}` for a conditional
     write answered with a status it did not expect. Believing it would leave the
     adapter unable to build the next conditional write. */
  const { provider, store, now } = harness();
  provider.failNextWrite({ result: { modified: true, etag: "" } });
  await addAllowlistEntry({ value: "named@gmail.com", actor: ADMIN, now }, { store });
  assert.deepEqual(
    (await readStoredAllowlist(store)).map((held) => held.value),
    ["named@gmail.com"],
  );
});

test("the allowlist owns one key and shares the store with the publications", async () => {
  const { provider, store, now } = harness();
  await addAllowlistEntry({ value: "acme.example", actor: ADMIN, now }, { store });
  assert.deepEqual(provider.keys(), [ALLOWLIST_KEY]);
  assert.match(ALLOWLIST_KEY, /^access\//, "a namespace the publications do not use");
});

/* --- the union with the seed ---------------------------------------------- */

test("the resolved list is the seed and the store together, with the seed marked", async () => {
  const { store, config, now } = harness({
    env: { ARCHON_PLATFORM_ALLOWLIST: "seeded.example, seeded@gmail.com" },
  });
  await addAllowlistEntry({ value: "added@gmail.com", actor: ADMIN, now }, { store });

  const entries = await resolveAllowlist({ config, store });
  assert.deepEqual(
    entries.map((held) => [held.value, held.source]),
    [
      ["seeded.example", "environment"],
      ["added@gmail.com", "store"],
      ["seeded@gmail.com", "environment"],
    ],
  );
});

test("an entry in both the seed and the store appears once, marked as seeded", async () => {
  const { store, config, now } = harness({ env: { ARCHON_PLATFORM_ALLOWLIST: "acme.example" } });
  await addAllowlistEntry({ value: "acme.example", actor: ADMIN, now }, { store });
  const entries = await resolveAllowlist({ config, store });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "environment", "the page must not offer a remove button for it");
});
