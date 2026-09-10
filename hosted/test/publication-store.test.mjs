/**
 * Regressions for the provider adapter in `../lib/publication-store.mjs`.
 *
 * Each test below names one guarded condition in that module, and is written so
 * that removing the guard makes it fail: the assertions are about *effects* -
 * what ended up stored, which call was made with which options, what a second
 * caller then observed - rather than about a constant or an error string that
 * would survive the guard's deletion.
 *
 * The ambiguity cases are the reason this suite exists at all. A store double
 * that can only succeed or only fail cannot express "the write committed and
 * then the response was lost", which is precisely the case the readback logic
 * handles and precisely the case that, handled wrongly, publishes a document
 * twice or reports a published document as a failure.
 *
 *   node --test hosted/test/publication-store.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostedContractError, validatePublication } from "../lib/contracts.mjs";
import {
  createPublicationStore,
  MAX_WRITE_ATTEMPTS,
  PUBLICATION_KEY_PREFIX,
  PUBLICATION_STORE_NAME,
  publicationKey,
} from "../lib/publication-store.mjs";
import { FIXTURE_KEY, FIXTURE_PUBLICATION_ID, RECORDS } from "./fixtures/publications.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";

/** A store adapter over a fresh double, plus the double for inspection. */
function harness() {
  const provider = createProviderDouble();
  const store = createPublicationStore({ getStore: provider.getStore });
  return { provider, store };
}

/** Assert `promise` rejects with a `HostedContractError` carrying `code`. */
async function rejects(promise, code) {
  const error = await promise.then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error !== null, `expected a rejection with code ${code}`);
  assert.ok(error instanceof HostedContractError, `expected HostedContractError, got ${error}`);
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return error;
}

/* ------------------------------------------------------------------ */
/* keys                                                                */
/* ------------------------------------------------------------------ */

test("the key is the publication id under one namespace", () => {
  assert.equal(publicationKey(FIXTURE_PUBLICATION_ID), FIXTURE_KEY);
  assert.ok(FIXTURE_KEY.startsWith(PUBLICATION_KEY_PREFIX));
});

test("a legacy six-hex document id is not a publication key", () => {
  for (const rejected of ["a1b2c3", "", "0F1E2D3C4B5A69788796A5B4C3D2E1F0", "../secrets", 42, null]) {
    assert.throws(
      () => publicationKey(rejected),
      (error) => error instanceof HostedContractError && error.code === "invalid_request",
      `expected ${JSON.stringify(rejected)} to be refused as a key`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* opening the store                                                   */
/* ------------------------------------------------------------------ */

test("the store is opened site-wide and strongly consistent, and only on use", async () => {
  const { provider, store } = harness();
  assert.deepEqual(provider.opened, [], "constructing the adapter must contact nothing");

  await store.read(FIXTURE_PUBLICATION_ID);
  assert.deepEqual(provider.opened, [{ name: PUBLICATION_STORE_NAME, consistency: "strong" }]);
});

test("every read asks for strong consistency", async () => {
  const { provider, store } = harness();
  await store.create(RECORDS.pending);
  await store.read(FIXTURE_PUBLICATION_ID);
  const gets = provider.calls.filter((call) => call.op === "get");
  assert.ok(gets.length > 0);
  for (const get of gets) assert.equal(get.options.consistency, "strong");
});

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

test("an absent key reads as null, not as an error", async () => {
  const { store } = harness();
  assert.equal(await store.read(FIXTURE_PUBLICATION_ID), null);
});

test("a stored record that is not JSON is unavailable, never absent", async () => {
  const { provider, store } = harness();
  provider.put(FIXTURE_KEY, "{not json");
  await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
});

test("an unknown state name is unavailable, never coerced to pending", async () => {
  const { provider, store } = harness();
  provider.put(FIXTURE_KEY, JSON.stringify({ ...RECORDS.pending, state: "publishing" }));
  await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
});

test("an unknown schema version is unavailable, never read as v1", async () => {
  const { provider, store } = harness();
  provider.put(FIXTURE_KEY, JSON.stringify({ ...RECORDS.complete, v: 2 }));
  await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
});

test("a hit with no ETag is unavailable, because no conditional write could follow", async () => {
  const { provider, store } = harness();
  await store.create(RECORDS.pending);
  provider.failNextRead({ omitEtag: true });
  await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
});

test("a provider read failure is unavailable and carries no provider detail", async () => {
  const { provider, store } = harness();
  provider.failNextRead({ throws: true });
  const error = await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
  assert.doesNotMatch(error.message, /provider read failure/);
});

/* ------------------------------------------------------------------ */
/* create-only                                                         */
/* ------------------------------------------------------------------ */

test("creating writes with onlyIfNew and never unconditionally", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);

  assert.equal(created.outcome, "created");
  assert.ok(created.etag.length > 0);
  const sets = provider.calls.filter((call) => call.op === "set");
  assert.deepEqual(sets.map((call) => call.options), [{ onlyIfNew: true }]);
  assert.deepEqual(provider.keys(), [FIXTURE_KEY]);
});

test("a colliding create preserves the original record and reports exists", async () => {
  const { provider, store } = harness();
  await store.create(RECORDS.pending);
  const original = provider.raw(FIXTURE_KEY);

  /* A different record at the same id: a second caller that somehow proposed
     this id must not overwrite the first and must not be told it created it. */
  const collider = validatePublication({
    ...RECORDS.pending,
    userCode: "ZZZZ-9999",
    agentSecretHash: "b".repeat(64),
  });
  const second = await store.create(collider);

  assert.equal(second.outcome, "exists");
  assert.equal(second.record, undefined, "the loser must learn nothing about the winner");
  assert.deepEqual(provider.raw(FIXTURE_KEY), original);
});

test("a create that commits and then throws is resolved by readback as created", async () => {
  const { provider, store } = harness();
  provider.failNextWrite({ throwsAfterCommit: true });

  const created = await store.create(RECORDS.pending);
  assert.equal(created.outcome, "created");
  assert.deepEqual(JSON.parse(provider.raw(FIXTURE_KEY).data), RECORDS.pending);
});

test("a create that throws before committing reports neither created nor exists", async () => {
  const { provider, store } = harness();
  provider.failNextWrite({ throwsBeforeCommit: true });

  await rejects(store.create(RECORDS.pending), "unavailable");
  assert.deepEqual(provider.keys(), [], "nothing may be stored for a write that never happened");
});

test("a malformed create result is read back rather than believed", async () => {
  const { provider, store } = harness();
  /* The shape `@netlify/blobs` returns for a conditional write it got an
     unexpected status for: modified, but with no ETag to follow up on. */
  provider.failNextWrite({ result: { modified: true, etag: "" } });

  const created = await store.create(RECORDS.pending);
  assert.equal(created.outcome, "created");
  assert.ok(created.etag.length > 0, "the readback must supply the ETag the write did not");
});

test("an ambiguous create whose readback also fails stays uncertain and retryable", async () => {
  const { provider, store } = harness();
  provider.failNextWrite({ throwsAfterCommit: true });
  provider.failNextRead({ throws: true });

  const error = await rejects(store.create(RECORDS.pending), "unavailable");
  assert.equal(error.retryable, true);
  assert.equal(provider.raw(FIXTURE_KEY) !== null, true, "the committed record is still there");
});

/* ------------------------------------------------------------------ */
/* conditional update                                                  */
/* ------------------------------------------------------------------ */

test("updating writes with the observed ETag, passed through opaquely", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);

  const committed = await store.update(RECORDS.approved, created.etag);
  assert.equal(committed.outcome, "committed");

  const sets = provider.calls.filter((call) => call.op === "set");
  assert.deepEqual(sets.at(-1).options, { onlyIfMatch: created.etag });
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "approved");
});

test("an update against a stale ETag is refused and changes nothing", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  await store.update(RECORDS.approved, created.etag);
  const afterFirst = provider.raw(FIXTURE_KEY);

  const stale = await store.update(RECORDS.cancelled, created.etag);
  assert.equal(stale.outcome, "refused");
  assert.deepEqual(provider.raw(FIXTURE_KEY), afterFirst);
});

test("an update with no ETag is a programming error, not an unconditional write", async () => {
  const { provider, store } = harness();
  await store.create(RECORDS.pending);
  await assert.rejects(() => store.update(RECORDS.approved, ""), TypeError);
  await assert.rejects(() => store.update(RECORDS.approved, undefined), TypeError);
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "pending");
});

test("an update that commits and then throws reads back as observed, not committed", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  provider.failNextWrite({ throwsAfterCommit: true });

  const written = await store.update(RECORDS.complete, created.etag);
  /* The stored state is the intended state, but the provider never confirmed
     this call wrote it - so it is `observed`, and a caller that must know
     whether it created the document has to treat that differently. */
  assert.equal(written.outcome, "observed");
  assert.ok(written.etag.length > 0);
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "complete");
  provider.assertFaultsConsumed();
});

test("a refused update is read back, because a 412 is not proof that no write happened", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);

  /* The exact shape `@netlify/blobs` produces when a conditional PUT commits and
     then loses its response: the client re-sends the same `If-Match`, a server
     that has already applied it answers 412, and `setJSON` resolves
     `modified: false`. Believing that would report a successful write as a
     conflict. */
  provider.beforeWrite(async () => {
    provider.applyDirectly(FIXTURE_KEY, RECORDS.complete);
  });
  const written = await store.update(RECORDS.complete, created.etag);

  assert.equal(written.outcome, "observed");
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "complete");
  const ops = provider.calls.map((call) => call.op);
  assert.equal(ops.at(-1), "get", "a refused write must be read back before it is believed");
});

test("a refused create is read back, so a lost response does not abandon its own record", async () => {
  const { provider, store } = harness();

  provider.beforeWrite(async () => {
    provider.applyDirectly(FIXTURE_KEY, RECORDS.pending);
  });
  const created = await store.create(RECORDS.pending);

  assert.equal(created.outcome, "created", "the record at the key is this call's own record");
  assert.ok(created.etag.length > 0);
  assert.equal(provider.keys().length, 1, "no orphan record is left behind");
});

test("a malformed update result is read back rather than believed", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  /* The real package returns this for any conditional-write status that is
     neither 200 nor 412 - including a success whose response carried no ETag
     header - so it is the likeliest ambiguous shape to reach `update`. */
  provider.failNextWrite({ result: { modified: true, etag: "" } });

  const written = await store.update(RECORDS.approved, created.etag);
  assert.equal(written.outcome, "observed");
  assert.ok(written.etag.length > 0, "the readback must supply the ETag the write did not");
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "approved");
  provider.assertFaultsConsumed();
});

test("a hit whose ETag header is absent is unavailable, in either spelling", async () => {
  for (const fault of [{ omitEtag: true }, { emptyEtag: true }]) {
    const { provider, store } = harness();
    await store.create(RECORDS.pending);
    provider.failNextRead(fault);
    await rejects(store.read(FIXTURE_PUBLICATION_ID), "unavailable");
    provider.assertFaultsConsumed();
  }
});

test("an update that throws before committing is refused, and readback precedes the answer", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  const before = provider.calls.length;
  provider.failNextWrite({ throwsBeforeCommit: true });

  const written = await store.update(RECORDS.complete, created.etag);
  assert.equal(written.outcome, "refused");
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "pending");
  const after = provider.calls.slice(before);
  assert.equal(after.at(-1).op, "get", "the adapter must read back before deciding");
});

test("an ambiguous update whose readback fails leaves the outcome unknown", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  provider.failNextWrite({ throwsAfterCommit: true });
  provider.failNextRead({ throws: true });

  await rejects(store.update(RECORDS.complete, created.etag), "unavailable");
  assert.equal(
    JSON.parse(provider.raw(FIXTURE_KEY).data).state,
    "complete",
    "the write did commit; the adapter simply must not claim to know",
  );
});

test("an update whose readback shows somebody else's record is refused, not overwritten", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);

  /* A cancellation lands between our read and our write. The write is refused,
     the readback shows a record that is not ours, and the caller is sent back to
     re-evaluate rather than told either that it won or that nothing happened. */
  provider.beforeWrite(async () => {
    await store.update(RECORDS.cancelled, provider.raw(FIXTURE_KEY).etag);
  });
  const before = provider.calls.length;
  const written = await store.update(RECORDS.complete, created.etag);

  assert.equal(written.outcome, "refused");
  assert.equal(JSON.parse(provider.raw(FIXTURE_KEY).data).state, "cancelled");
  assert.equal(
    provider.calls.slice(before).at(-1).op,
    "get",
    "the refusal must be reached through a readback",
  );
});

test("the adapter never issues an unconditional write", async () => {
  const { provider, store } = harness();
  const created = await store.create(RECORDS.pending);
  await store.update(RECORDS.approved, created.etag);
  for (const call of provider.calls.filter((entry) => entry.op === "set")) {
    assert.ok(
      call.options.onlyIfNew === true || typeof call.options.onlyIfMatch === "string",
      `an unconditional write reached the provider: ${JSON.stringify(call.options)}`,
    );
  }
});

test("the adapter exposes no delete", () => {
  const { store } = harness();
  assert.deepEqual(Object.keys(store).sort(), ["create", "read", "update"]);
  assert.ok(Object.isFrozen(store));
});

test("the attempt bound is a fixed small number", () => {
  assert.equal(MAX_WRITE_ATTEMPTS, 6);
});
