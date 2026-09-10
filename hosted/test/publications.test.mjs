/**
 * Regressions for the publication state machine in `../lib/publications.mjs`.
 *
 * The suite is organised around the races and the deadlines rather than around
 * the exported functions, because those are where a single-record design either
 * holds or quietly loses a document. Every concurrency test drives *two real
 * transitions* interleaved through the store double's `beforeWrite` hook - the
 * second one runs inside the first one's write, against the same key and the
 * same ETag - so what is being asserted is the compare-and-set actually
 * arbitrating, not a simulation of one.
 *
 * Each test names one guarded condition and asserts the effect of removing it:
 * which record survived, whose account is on it, whether bytes are readable,
 * which of two callers was told it created something. An assertion about an
 * error code alone would survive most of the mutations this suite exists to
 * catch, so where an error is asserted the stored record is asserted with it.
 *
 *   node --test hosted/test/publications.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED_LIMITS, HostedContractError, validatePublication } from "../lib/contracts.mjs";
import { createPublicationStore } from "../lib/publication-store.mjs";
import {
  bindPublication,
  cancelPublication,
  completePublication,
  createPublication,
  createPublications,
  decidePublication,
  readOwnedPublication,
  readPublication,
  reviewPublication,
  statusPublication,
} from "../lib/publications.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_AGENT_SECRET,
  FIXTURE_RECORD_BROWSER_SECRET,
  FIXTURE_RESULT,
  OTHER_PRINCIPAL,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import {
  collidingIdRandomBytes,
  createClock,
  createProviderDouble,
  sequentialRandomBytes,
} from "./helpers/publication-store.mjs";

/** The bytes an approved upload is allowed to commit, and the facts about them. */
const APPROVED_UPLOAD = Object.freeze({
  html: FIXTURE_HTML,
  contentSha256: VALID_DESCRIPTOR.contentSha256,
  contentBytes: VALID_DESCRIPTOR.contentBytes,
});

/**
 * A live adapter over a fresh store double, optionally seeded with one fixture
 * record, with a clock the test moves by hand.
 */
function harness({ seed = null, at = FIXTURE_NOW, publishEnabled = true, randomBytes } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) provider.put(FIXTURE_KEY, JSON.stringify(RECORDS[seed]));
  const clock = createClock(at);
  const dependencies = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled,
    now: clock.now,
    randomBytes: randomBytes ?? sequentialRandomBytes(),
  };
  return {
    provider,
    clock,
    dependencies,
    publications: createPublications(dependencies),
    /**
     * The one record this store holds right now.
     *
     * Keyed off whatever key exists rather than off the fixture id, because a
     * started publication gets a freshly minted id - and asserting that there is
     * exactly one key is itself part of "completion writes one record, not two".
     */
    stored: () => {
      const keys = provider.keys();
      assert.ok(keys.length <= 1, `expected at most one publication record, got ${keys.length}`);
      if (keys.length === 0) return null;
      return JSON.parse(provider.raw(keys[0]).data);
    },
  };
}

/** The agent bearer arguments for the seeded fixture record. */
const AGENT = {
  publicationId: FIXTURE_PUBLICATION_ID,
  agentSecret: FIXTURE_RECORD_AGENT_SECRET,
};

/** A verified browser binding for the seeded fixture record. */
const BINDING = Object.freeze({
  publicationId: FIXTURE_PUBLICATION_ID,
  browserSecretHash: RECORDS.pending.browserSecretHash,
});

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

/** Every string anywhere inside a value, for the "carries no secret" checks. */
function stringsIn(value, found = []) {
  if (typeof value === "string") found.push(value);
  else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) stringsIn(nested, found);
  }
  return found;
}

function assertCarriesNoSecret(projection) {
  const strings = stringsIn(projection);
  for (const secret of [
    RECORDS.pending.agentSecretHash,
    RECORDS.pending.browserSecretHash,
    FIXTURE_RECORD_AGENT_SECRET,
    FIXTURE_RECORD_BROWSER_SECRET,
    FIXTURE_HTML,
  ]) {
    assert.ok(!strings.includes(secret), `projection leaked ${secret.slice(0, 16)}…`);
  }
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

test("starting stores a pending record and returns each secret exactly once", async () => {
  const { publications, stored } = harness();
  const started = await publications.createPublication(VALID_DESCRIPTOR);

  const record = stored();
  assert.equal(record.state, "pending");
  assert.equal(record.id, started.publicationId);
  assert.equal(record.ownerAccountId, null);
  assert.equal(record.html, null);

  /* Only digests are stored, and the two capabilities are independent. */
  assert.notEqual(record.agentSecretHash, record.browserSecretHash);
  const stringsStored = stringsIn(record);
  assert.ok(!stringsStored.includes(started.agentSecret), "the agent secret must not be stored");
  const browserSecret = new URL(started.verificationUriComplete).hash.slice(1);
  assert.ok(!stringsStored.includes(browserSecret), "the browser secret must not be stored");
  assert.notEqual(browserSecret, started.agentSecret);

  assert.equal(started.expiresAt, record.pendingExpiresAt);
  assert.equal(
    Date.parse(record.pendingExpiresAt) - Date.parse(record.createdAt),
    HOSTED_LIMITS.PENDING_TTL_SECONDS * 1000,
  );
  assert.equal(started.intervalSeconds, HOSTED_LIMITS.POLL_INTERVAL_SECONDS);
});

test("the browser URL carries the browser secret and never the agent secret", async () => {
  const { publications } = harness();
  const started = await publications.createPublication(VALID_DESCRIPTOR);
  const url = new URL(started.verificationUriComplete);

  assert.equal(url.origin, FIXTURE_APP_ORIGIN);
  assert.equal(url.pathname, HOSTED_LIMITS.AUTHORIZE_PATH);
  assert.equal(url.search, "");
  assert.ok(!started.verificationUriComplete.includes(started.agentSecret));
});

test("the minted user code uses the unambiguous pairing alphabet", async () => {
  const { publications } = harness();
  for (let run = 0; run < 5; run += 1) {
    const started = await publications.createPublication(VALID_DESCRIPTOR);
    assert.match(started.userCode, HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN);
  }
});

test("starting is refused when the operator has not enabled publishing", async () => {
  const { publications, provider } = harness({ publishEnabled: false });
  const error = await rejects(publications.createPublication(VALID_DESCRIPTOR), "publishing_disabled");
  assert.equal(error.retryable, false);
  assert.deepEqual(provider.keys(), [], "a disabled deployment stores nothing");
});

test("a descriptor carrying an owner claim is refused before anything is stored", async () => {
  const { publications, provider } = harness();
  await rejects(
    publications.createPublication({ ...VALID_DESCRIPTOR, ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID }),
    "invalid_request",
  );
  assert.deepEqual(provider.keys(), []);
});

test("a create that collides on every attempt fails and preserves the original record", async () => {
  /* A constant random source proposes the same id every time, so the store's
     create-only refusal is exercised for real. */
  const { publications, provider, stored } = harness({ randomBytes: collidingIdRandomBytes() });
  const first = await publications.createPublication(VALID_DESCRIPTOR);
  const original = stored();

  const error = await rejects(publications.createPublication(VALID_DESCRIPTOR), "unavailable");
  assert.equal(error.retryable, true);
  assert.doesNotMatch(error.message, new RegExp(first.agentSecret.slice(0, 12)));
  assert.deepEqual(stored(), original, "the winning record is untouched");
  assert.equal(provider.keys().length, 1, "a collision never creates a second document");
});

/* ------------------------------------------------------------------ */
/* browser binding and review                                          */
/* ------------------------------------------------------------------ */

test("binding verifies the browser secret and returns no capability", async () => {
  const { publications } = harness({ seed: "pending" });
  const binding = await publications.bindPublication({
    publicationId: FIXTURE_PUBLICATION_ID,
    browserSecret: FIXTURE_RECORD_BROWSER_SECRET,
  });

  assert.deepEqual({ ...binding }, { ...BINDING });
  assertCarriesNoSecret({ ...binding, browserSecretHash: undefined });
});

test("binding refuses the agent secret and any other value", async () => {
  const { publications } = harness({ seed: "pending" });
  for (const wrong of [FIXTURE_RECORD_AGENT_SECRET, "", "not-the-secret", null, 7]) {
    await rejects(
      publications.bindPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        browserSecret: wrong,
      }),
      "invalid_capability",
    );
  }
});

test("review shows the descriptor and state, and never a hash or the document", async () => {
  for (const state of Object.keys(RECORDS)) {
    const { publications } = harness({ seed: state });
    const review = await publications.reviewPublication({
      publicationId: FIXTURE_PUBLICATION_ID,
      browserBinding: BINDING,
      principal: FIXTURE_PRINCIPAL,
    });
    assert.deepEqual(review.descriptor, VALID_DESCRIPTOR);
    assert.equal(review.userCode, RECORDS.pending.userCode);
    assert.equal(review.currentAccountId, FIXTURE_PRINCIPAL.accountId);
    assert.equal(review.state, state);
    assertCarriesNoSecret(review);
  }
});

test("review refuses a binding that was not produced by the server verifier", async () => {
  const { publications } = harness({ seed: "pending" });
  for (const forged of [
    null,
    { publicationId: FIXTURE_PUBLICATION_ID, browserSecretHash: "0".repeat(64) },
    { publicationId: "f".repeat(32), browserSecretHash: BINDING.browserSecretHash },
    { publicationId: FIXTURE_PUBLICATION_ID },
  ]) {
    await rejects(
      publications.reviewPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        browserBinding: forged,
        principal: FIXTURE_PRINCIPAL,
      }),
      "invalid_capability",
    );
  }
});

/* ------------------------------------------------------------------ */
/* approval                                                            */
/* ------------------------------------------------------------------ */

test("approving fixes the owner from the session and opens the upload window", async () => {
  const { publications, clock, stored } = harness({ seed: "pending" });
  const decided = await publications.decidePublication({
    publicationId: FIXTURE_PUBLICATION_ID,
    browserBinding: BINDING,
    principal: FIXTURE_PRINCIPAL,
    decision: "approve",
    displayedAccountId: FIXTURE_PRINCIPAL.accountId,
  });

  const record = stored();
  assert.equal(record.state, "approved");
  assert.equal(record.ownerAccountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal(
    Date.parse(record.uploadExpiresAt) - clock.now(),
    HOSTED_LIMITS.UPLOAD_TTL_SECONDS * 1000,
  );
  assert.equal(decided.state, "approved");
  assertCarriesNoSecret(decided);
});

test("a decision whose displayed account is not the session account is refused", async () => {
  const { publications, stored } = harness({ seed: "pending" });
  await rejects(
    publications.decidePublication({
      publicationId: FIXTURE_PUBLICATION_ID,
      browserBinding: BINDING,
      principal: FIXTURE_PRINCIPAL,
      decision: "approve",
      displayedAccountId: OTHER_PRINCIPAL.accountId,
    }),
    "csrf_failed",
  );
  assert.equal(stored().state, "pending", "a refused decision changes nothing");
  assert.equal(stored().ownerAccountId, null);
});

test("two accounts approving from the same observed ETag leave exactly one owner", async () => {
  const { publications, provider, stored } = harness({ seed: "pending" });
  const approveAs = (principal) =>
    publications.decidePublication({
      publicationId: FIXTURE_PUBLICATION_ID,
      browserBinding: BINDING,
      principal,
      decision: "approve",
      displayedAccountId: principal.accountId,
    });

  /* The second approval runs inside the first one's write, against the record
     and ETag the first one read. Exactly one compare-and-set can win. */
  let second = null;
  provider.beforeWrite(async () => {
    second = await approveAs(OTHER_PRINCIPAL).then(
      (value) => ({ ok: value }),
      (error) => ({ error }),
    );
  });
  const first = await approveAs(FIXTURE_PRINCIPAL).then(
    (value) => ({ ok: value }),
    (error) => ({ error }),
  );

  const record = stored();
  assert.equal(record.state, "approved");
  const winners = [first, second].filter((outcome) => outcome.ok !== undefined);
  assert.equal(winners.length, 1, "exactly one approval may succeed");
  assert.equal(record.ownerAccountId, winners[0].ok.ownerAccountId);
  const loser = [first, second].find((outcome) => outcome.error !== undefined);
  assert.equal(loser.error.code, "state_conflict");
});

test("approval cannot revive a terminal record", async () => {
  /* `expired` answers 410 rather than 409 because it is the same condition the
     deadline check reports: the authorisation window is over. The other three
     are decisions that were already made, which is a conflict. */
  for (const [terminal, code] of [
    ["denied", "state_conflict"],
    ["cancelled", "state_conflict"],
    ["complete", "state_conflict"],
    ["expired", "authorization_expired"],
  ]) {
    const { publications, stored } = harness({ seed: terminal });
    const before = stored();
    await rejects(
      publications.decidePublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        browserBinding: BINDING,
        principal: OTHER_PRINCIPAL,
        decision: "approve",
        displayedAccountId: OTHER_PRINCIPAL.accountId,
      }),
      code,
    );
    assert.deepEqual(stored(), before, `${terminal} must survive an approval attempt`);
  }
});

test("approval after the pending deadline is refused without any write", async () => {
  const { publications, clock, stored } = harness({ seed: "pending" });
  clock.setIso(RECORDS.pending.pendingExpiresAt);

  await rejects(
    publications.decidePublication({
      publicationId: FIXTURE_PUBLICATION_ID,
      browserBinding: BINDING,
      principal: FIXTURE_PRINCIPAL,
      decision: "approve",
      displayedAccountId: FIXTURE_PRINCIPAL.accountId,
    }),
    "authorization_expired",
  );
  assert.equal(stored().state, "pending");
  assert.equal(stored().ownerAccountId, null);
});

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

test("status authenticates only the agent bearer", async () => {
  const { publications } = harness({ seed: "pending" });
  for (const wrong of [FIXTURE_RECORD_BROWSER_SECRET, "", "guess", null]) {
    await rejects(
      publications.statusPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        agentSecret: wrong,
      }),
      "invalid_capability",
    );
  }
});

test("status reports denial and cancellation as states, never as failures", async () => {
  for (const terminal of ["denied", "cancelled", "expired"]) {
    const { publications } = harness({ seed: terminal });
    const envelope = await publications.statusPublication(AGENT);
    assert.equal(envelope.state, terminal);
    assert.equal(envelope.result, undefined, "no receipt for a publication that did not publish");
    assertCarriesNoSecret(envelope);
  }
});

test("status reports logical expiry even though nothing ever deletes a record", async () => {
  const pending = harness({ seed: "pending" });
  pending.clock.setIso(RECORDS.pending.pendingExpiresAt);
  assert.equal((await pending.publications.statusPublication(AGENT)).state, "expired");
  assert.equal(pending.stored().state, "pending", "expiry writes nothing; cleanup is disabled");

  const approved = harness({ seed: "approved" });
  approved.clock.setIso(RECORDS.approved.uploadExpiresAt);
  const envelope = await approved.publications.statusPublication(AGENT);
  assert.equal(envelope.state, "expired");
  assert.equal(envelope.expiresAt, RECORDS.approved.uploadExpiresAt);
  assert.equal(approved.stored().state, "approved");
});

test("status one millisecond before each deadline is still live", async () => {
  const pending = harness({ seed: "pending" });
  pending.clock.setIso(RECORDS.pending.pendingExpiresAt);
  pending.clock.advanceSeconds(-0.001);
  assert.equal((await pending.publications.statusPublication(AGENT)).state, "pending");

  const approved = harness({ seed: "approved" });
  approved.clock.setIso(RECORDS.approved.uploadExpiresAt);
  approved.clock.advanceSeconds(-0.001);
  assert.equal((await approved.publications.statusPublication(AGENT)).state, "approved");
});

test("a completed receipt is recoverable after the upload deadline, until the receipt deadline", async () => {
  const { publications, clock } = harness({ seed: "complete" });

  clock.setIso(RECORDS.complete.uploadExpiresAt);
  clock.advanceSeconds(1);
  const afterUpload = await publications.statusPublication(AGENT);
  assert.equal(afterUpload.state, "complete");
  assert.deepEqual({ ...afterUpload.result }, { ...FIXTURE_RESULT });
  assertCarriesNoSecret(afterUpload);

  clock.setIso(RECORDS.complete.receiptExpiresAt);
  clock.advanceSeconds(-0.001);
  assert.equal((await publications.statusPublication(AGENT)).state, "complete");

  clock.advanceSeconds(0.001);
  await rejects(publications.statusPublication(AGENT), "receipt_expired");
});

test("the owner keeps the document after the receipt deadline", async () => {
  const { publications, clock } = harness({ seed: "complete" });
  clock.setIso(RECORDS.complete.receiptExpiresAt);
  clock.advanceSeconds(3600);

  await rejects(publications.statusPublication(AGENT), "receipt_expired");
  const owned = await publications.readOwnedPublication({
    publicationId: FIXTURE_PUBLICATION_ID,
    principal: FIXTURE_PRINCIPAL,
  });
  assert.equal(owned.html, FIXTURE_HTML);
  assert.equal(owned.ownerAccountId, FIXTURE_OWNER_ACCOUNT_ID);
});

test("only the owner of a complete record can read it", async () => {
  const complete = harness({ seed: "complete" });
  await rejects(
    complete.publications.readOwnedPublication({
      publicationId: FIXTURE_PUBLICATION_ID,
      principal: OTHER_PRINCIPAL,
    }),
    "not_found",
  );

  for (const state of ["pending", "approved", "denied", "cancelled", "expired"]) {
    const { publications } = harness({ seed: state });
    await rejects(
      publications.readOwnedPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        principal: FIXTURE_PRINCIPAL,
      }),
      "not_found",
    );
  }
});

/* ------------------------------------------------------------------ */
/* completion                                                          */
/* ------------------------------------------------------------------ */

test("completing an approved record commits the bytes into the same document", async () => {
  const { publications, clock, provider, stored } = harness({ seed: "approved" });
  const committed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });

  assert.equal(committed.created, true);
  assert.deepEqual({ ...committed.result }, { ...FIXTURE_RESULT });

  const record = stored();
  assert.equal(record.state, "complete");
  assert.equal(record.html, FIXTURE_HTML);
  assert.equal(record.ownerAccountId, FIXTURE_OWNER_ACCOUNT_ID);
  assert.equal(record.completedAt, new Date(clock.now()).toISOString());
  assert.equal(
    Date.parse(record.receiptExpiresAt) - clock.now(),
    HOSTED_LIMITS.RECEIPT_TTL_SECONDS * 1000,
  );
  assert.equal(provider.keys().length, 1, "completion writes one record, not two");
});

test("completion requires approval, and a pending record says so", async () => {
  const { publications, stored } = harness({ seed: "pending" });
  await rejects(
    publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }),
    "approval_required",
  );
  assert.equal(stored().state, "pending");
  assert.equal(stored().html, null);
});

test("completion is refused against every terminal state that is not complete", async () => {
  for (const [terminal, code] of [
    ["denied", "state_conflict"],
    ["cancelled", "state_conflict"],
    ["expired", "authorization_expired"],
  ]) {
    const { publications, stored } = harness({ seed: terminal });
    const before = stored();
    await rejects(publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }), code);
    assert.deepEqual(stored(), before);
  }
});

test("a rejected upload does not consume the approval", async () => {
  const { publications, stored } = harness({ seed: "approved" });

  await rejects(
    publications.completePublication({
      ...AGENT,
      html: FIXTURE_HTML,
      contentSha256: "0".repeat(64),
      contentBytes: VALID_DESCRIPTOR.contentBytes,
    }),
    "descriptor_mismatch",
  );
  await rejects(
    publications.completePublication({
      ...AGENT,
      html: FIXTURE_HTML,
      contentSha256: VALID_DESCRIPTOR.contentSha256,
      contentBytes: VALID_DESCRIPTOR.contentBytes + 1,
    }),
    "descriptor_mismatch",
  );
  assert.deepEqual(stored(), RECORDS.approved, "the approval is untouched");

  /* The originally approved bytes still commit afterwards. */
  const committed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  assert.equal(committed.created, true);
});

test("bytes that do not hash to the claimed digest cannot be attached", async () => {
  const { publications, stored } = harness({ seed: "approved" });
  await rejects(
    publications.completePublication({
      ...AGENT,
      html: `${FIXTURE_HTML}<!-- different -->`,
      contentSha256: VALID_DESCRIPTOR.contentSha256,
      contentBytes: VALID_DESCRIPTOR.contentBytes,
    }),
    "descriptor_mismatch",
  );
  assert.equal(stored().state, "approved");
  assert.equal(stored().html, null);
});

test("an identical retry returns the same receipt without writing again", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });
  const first = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  const committed = stored();
  const writes = provider.calls.filter((call) => call.op === "set").length;

  const retry = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  assert.equal(first.created, true);
  assert.equal(retry.created, false, "201 and 200 must be distinguishable");
  assert.deepEqual({ ...retry.result }, { ...first.result });
  assert.equal(retry.result.documentId, FIXTURE_PUBLICATION_ID);
  assert.deepEqual(stored(), committed, "a retry writes nothing");
  assert.equal(provider.calls.filter((call) => call.op === "set").length, writes);
});

test("a retry with different bytes cannot replace a completed document", async () => {
  const { publications, stored } = harness({ seed: "complete" });
  const before = stored();
  await rejects(
    publications.completePublication({
      ...AGENT,
      html: "<html><body>replacement</body></html>",
      contentSha256: "1".repeat(64),
      contentBytes: 38,
    }),
    "descriptor_mismatch",
  );
  assert.deepEqual(stored(), before);
});

test("no new upload attempt starts after the deadline", async () => {
  const { publications, provider, clock, stored } = harness({ seed: "approved" });
  clock.setIso(RECORDS.approved.uploadExpiresAt);
  const writes = provider.calls.filter((call) => call.op === "set").length;

  await rejects(
    publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }),
    "authorization_expired",
  );
  assert.equal(
    provider.calls.filter((call) => call.op === "set").length,
    writes,
    "an expired upload must submit no compare-and-set at all",
  );
  assert.equal(stored().state, "approved");
});

test("the deadline is re-checked between conflict attempts, not only at entry", async () => {
  const { publications, provider, clock, stored } = harness({ seed: "approved" });

  /* The first attempt loses its compare-and-set to a no-op rewrite of the same
     approved record, and time crosses the upload deadline while it does. The
     retry must not start. */
  provider.beforeWrite(async () => {
    const raw = provider.raw(FIXTURE_KEY);
    provider.put(FIXTURE_KEY, raw.data);
    clock.setIso(RECORDS.approved.uploadExpiresAt);
  });

  await rejects(
    publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }),
    "authorization_expired",
  );
  assert.equal(stored().state, "approved", "no document was committed after the deadline");
});

test("a compare-and-set submitted before the deadline is kept when it lands after it", async () => {
  const { publications, clock, provider, stored } = harness({ seed: "approved" });

  /* Authorised when it started; the clock crosses the deadline while the write
     is in flight. C2 says such a write may finish, and its record is retained. */
  provider.beforeWrite(async () => {
    clock.setIso(RECORDS.approved.uploadExpiresAt);
    clock.advanceSeconds(30);
  });
  const committed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });

  assert.equal(committed.created, true);
  assert.equal(stored().state, "complete");
  assert.equal(stored().html, FIXTURE_HTML);
});

/* ------------------------------------------------------------------ */
/* completion races                                                    */
/* ------------------------------------------------------------------ */

test("a cancellation that lands first wins, and the upload commits no bytes", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });

  let cancelled = null;
  provider.beforeWrite(async () => {
    cancelled = await publications.cancelPublication(AGENT);
  });
  await rejects(publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }), "state_conflict");

  assert.equal(cancelled.state, "cancelled");
  const record = stored();
  assert.equal(record.state, "cancelled");
  assert.equal(record.html, null, "a cancelled record never holds bytes");
  assert.equal(provider.keys().length, 1);
});

test("a completion that lands first wins, and the cancellation returns the receipt", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });

  let completed = null;
  provider.beforeWrite(async () => {
    completed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  });
  const envelope = await publications.cancelPublication(AGENT);

  assert.equal(completed.created, true);
  assert.equal(envelope.state, "complete");
  assert.deepEqual({ ...envelope.result }, { ...FIXTURE_RESULT });
  assert.equal(stored().state, "complete");
  assert.equal(stored().html, FIXTURE_HTML);
  assert.equal(provider.keys().length, 1);
});

test("cancelling a completed publication returns its receipt rather than deleting it", async () => {
  const { publications, stored } = harness({ seed: "complete" });
  const before = stored();

  const envelope = await publications.cancelPublication(AGENT);
  assert.equal(envelope.state, "complete");
  assert.deepEqual({ ...envelope.result }, { ...FIXTURE_RESULT });
  assert.deepEqual(stored(), before, "a completed document is never removed");
});

test("cancelling reports an already-terminal operation without writing", async () => {
  for (const terminal of ["denied", "cancelled", "expired"]) {
    const { publications, stored } = harness({ seed: terminal });
    const before = stored();
    const envelope = await publications.cancelPublication(AGENT);
    assert.equal(envelope.state, terminal);
    assert.deepEqual(stored(), before);
  }
});

test("two identical completions produce one record and one document id", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });

  let second = null;
  provider.beforeWrite(async () => {
    second = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  });
  const first = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });

  assert.equal(provider.keys().length, 1);
  assert.equal(stored().state, "complete");
  assert.deepEqual({ ...first.result }, { ...second.result });
  assert.equal(first.result.documentId, second.result.documentId);
  /* Exactly one of the two is the write that created the document. */
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
});

/* ------------------------------------------------------------------ */
/* ambiguous provider responses                                        */
/* ------------------------------------------------------------------ */

test("a completion that commits and then loses its response returns the committed receipt", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });
  provider.failNextWrite({ throwsAfterCommit: true });

  const committed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  assert.equal(committed.created, true);
  assert.deepEqual({ ...committed.result }, { ...FIXTURE_RESULT });
  assert.equal(stored().state, "complete");
  assert.equal(provider.keys().length, 1, "the lost response must not allocate a second id");
});

test("a completion that never committed reads back and retries within the deadline", async () => {
  const { publications, provider, stored } = harness({ seed: "approved" });
  provider.failNextWrite({ throwsBeforeCommit: true });

  const committed = await publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD });
  assert.equal(committed.created, true);
  assert.equal(stored().state, "complete");

  const sets = provider.calls.map((call) => call.op).join(",");
  assert.match(sets, /set,get,get,set/, "the retry must be preceded by a readback and a fresh read");
});

test("an ambiguous completion whose readback fails is retryable and claims nothing", async () => {
  const { publications, provider } = harness({ seed: "approved" });
  provider.failNextWrite({ throwsAfterCommit: true });
  provider.failNextRead({ throws: true });

  const error = await rejects(
    publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }),
    "unavailable",
  );
  assert.equal(error.retryable, true);
  assert.equal(error.status, 503);
});

test("a storage read failure is unavailable on every operation, and leaks nothing", async () => {
  for (const operation of [
    (publications) => publications.statusPublication(AGENT),
    (publications) => publications.cancelPublication(AGENT),
    (publications) => publications.completePublication({ ...AGENT, ...APPROVED_UPLOAD }),
    (publications) =>
      publications.reviewPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        browserBinding: BINDING,
        principal: FIXTURE_PRINCIPAL,
      }),
    (publications) =>
      publications.readOwnedPublication({
        publicationId: FIXTURE_PUBLICATION_ID,
        principal: FIXTURE_PRINCIPAL,
      }),
  ]) {
    const { publications, provider } = harness({ seed: "approved" });
    provider.failNextRead({ throws: true });
    const error = await rejects(operation(publications), "unavailable");
    assertCarriesNoSecret(error.toWire());
  }
});

/* ------------------------------------------------------------------ */
/* record and identifier validation                                    */
/* ------------------------------------------------------------------ */

test("a legacy six-hex identifier reaches no operation", async () => {
  const { publications } = harness({ seed: "pending" });
  for (const legacy of ["a1b2c3", "0f1e2d3c4b5a69788796a5b4c3d2e1f", ""]) {
    await rejects(
      publications.statusPublication({ publicationId: legacy, agentSecret: FIXTURE_RECORD_AGENT_SECRET }),
      "invalid_request",
    );
  }
});

test("a stored record with a malformed secret hash is unavailable, not usable", async () => {
  const { provider, publications } = harness();
  provider.put(
    FIXTURE_KEY,
    JSON.stringify({ ...RECORDS.pending, agentSecretHash: "not-a-hash" }),
  );
  await rejects(publications.statusPublication(AGENT), "unavailable");
});

test("readPublication is server-internal and hands back the whole record", async () => {
  const { publications } = harness({ seed: "complete" });
  const record = await publications.readPublication(FIXTURE_PUBLICATION_ID);
  assert.equal(record.html, FIXTURE_HTML);
  assert.equal(record.agentSecretHash, RECORDS.complete.agentSecretHash);
  assert.equal(await publications.readPublication("f".repeat(32)), null);
});

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

test("the adapter exposes exactly the nine frozen operations", () => {
  const { publications } = harness();
  assert.deepEqual(Object.keys(publications).sort(), [
    "bindPublication",
    "cancelPublication",
    "completePublication",
    "createPublication",
    "decidePublication",
    "readOwnedPublication",
    "readPublication",
    "reviewPublication",
    "statusPublication",
  ]);
  assert.ok(Object.isFrozen(publications));
});

test("the module-level functions are the same operations with the dependencies passed", async () => {
  const { dependencies } = harness({ seed: "approved" });
  const envelope = await statusPublication(AGENT, dependencies);
  assert.equal(envelope.state, "approved");

  for (const operation of [
    bindPublication,
    cancelPublication,
    completePublication,
    createPublication,
    decidePublication,
    readOwnedPublication,
    readPublication,
    reviewPublication,
    statusPublication,
  ]) {
    assert.equal(typeof operation, "function");
    await assert.rejects(() => operation({}), TypeError, `${operation.name} must require dependencies`);
  }
});

test("a dependency set without a real store adapter is refused", () => {
  assert.throws(() => createPublications({ appOrigin: FIXTURE_APP_ORIGIN }), TypeError);
  assert.throws(() => createPublications({ store: {}, appOrigin: FIXTURE_APP_ORIGIN }), TypeError);
  assert.throws(() => createPublications(null), TypeError);
});

test("the fixture records are exactly the contract's records", () => {
  for (const [state, record] of Object.entries(RECORDS)) {
    assert.deepEqual(validatePublication(record), record);
    assert.equal(record.state, state);
    assert.ok(Object.isFrozen(record));
  }
});
