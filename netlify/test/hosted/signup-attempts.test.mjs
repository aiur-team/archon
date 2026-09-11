/**
 * The turned-away sign-in census: the stored record, its validation, and the
 * two operations on it.
 *
 * It runs against the publication suite's provider double, so the compare-and-set
 * discipline and the read-failure behaviour are exercised against real
 * conditional writes. Nothing here needs a credential or a network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostedContractError } from "../../lib/hosted/contracts.mjs";
import {
  SIGNUP_ATTEMPTS_KEY,
  SIGNUP_ATTEMPTS_LIMITS,
  createSignupAttemptsStore,
  readSignupAttempts,
  recordSignupAttempt,
  validateSignupAttemptsRecord,
} from "../../lib/hosted/signup-attempts.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";

const AT = new Date("2026-09-10T12:00:00.000Z");

function harness() {
  const provider = createProviderDouble();
  return { provider, store: createSignupAttemptsStore({ getStore: provider.getStore }) };
}

function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

test("an empty store reads as no attempts, and one key holds them all", async () => {
  const { provider, store } = harness();
  assert.deepEqual(await readSignupAttempts(store), []);
  await recordSignupAttempt({ email: "ann@example.com", now: () => AT }, { store });
  assert.deepEqual(provider.keys(), [SIGNUP_ATTEMPTS_KEY], "one record, forever");
});

test("a recorded address is normalised and read back", async () => {
  const { store } = harness();
  const result = await recordSignupAttempt({ email: " Ann@Example.COM ", now: () => AT }, { store });
  assert.equal(result.recorded, true);
  assert.equal(result.email, "ann@example.com");
  const attempts = await readSignupAttempts(store);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].email, "ann@example.com");
  assert.equal(attempts[0].count, 1);
  assert.equal(attempts[0].firstAt, AT.toISOString());
  assert.equal(attempts[0].lastAt, AT.toISOString());
});

test("a repeated address bumps the count and moves last-seen, keeping first-seen", async () => {
  const { store } = harness();
  const later = new Date(AT.getTime() + 60_000);
  await recordSignupAttempt({ email: "ann@example.com", now: () => AT }, { store });
  await recordSignupAttempt({ email: "ann@example.com", now: () => later }, { store });
  const attempts = await readSignupAttempts(store);
  assert.equal(attempts.length, 1, "one address is one row");
  assert.equal(attempts[0].count, 2);
  assert.equal(attempts[0].firstAt, AT.toISOString());
  assert.equal(attempts[0].lastAt, later.toISOString());
});

test("the list is ordered most-recently-seen first", async () => {
  const { store } = harness();
  await recordSignupAttempt({ email: "first@example.com", now: () => AT }, { store });
  await recordSignupAttempt(
    { email: "second@example.com", now: () => new Date(AT.getTime() + 60_000) },
    { store },
  );
  const attempts = await readSignupAttempts(store);
  assert.deepEqual(attempts.map((a) => a.email), ["second@example.com", "first@example.com"]);
});

test("a malformed address is refused and records nothing", async () => {
  const { store } = harness();
  await assert.rejects(
    () => recordSignupAttempt({ email: "not-an-address", now: () => AT }, { store }),
    (error) => error instanceof HostedContractError && error.code === "invalid_request",
  );
  assert.deepEqual(await readSignupAttempts(store), []);
});

test("a store that cannot be read refuses the append, fail-closed", async () => {
  const { provider, store } = harness();
  provider.failNextRead({ throws: true });
  await assert.rejects(
    () => recordSignupAttempt({ email: "ann@example.com", now: () => AT }, { store }),
    (error) => error instanceof HostedContractError && error.code === "unavailable",
  );
});

test("a full list evicts the least-recently-seen when a new address arrives", async () => {
  const { store } = harness();
  const max = SIGNUP_ATTEMPTS_LIMITS.MAX_ENTRIES;
  for (let i = 0; i < max; i += 1) {
    await recordSignupAttempt(
      { email: `person${i}@example.com`, now: () => new Date(AT.getTime() + i * 1000) },
      { store },
    );
  }
  let attempts = await readSignupAttempts(store);
  assert.equal(attempts.length, max);

  /* One more distinct address: the oldest (person0) is evicted, the newcomer is
     kept, and the total stays at the cap. */
  await recordSignupAttempt(
    { email: "newcomer@example.com", now: () => new Date(AT.getTime() + max * 1000) },
    { store },
  );
  attempts = await readSignupAttempts(store);
  assert.equal(attempts.length, max, "the record never grows past its cap");
  const emails = attempts.map((a) => a.email);
  assert.ok(emails.includes("newcomer@example.com"), "the newest address is kept");
  assert.ok(!emails.includes("person0@example.com"), "the least-recently-seen was evicted");
});

test("a record this version cannot interpret is refused, not coerced to empty", () => {
  assert.throws(() => validateSignupAttemptsRecord({ v: 99, attempts: [] }), HostedContractError);
  assert.throws(
    () => validateSignupAttemptsRecord({ v: 1, attempts: [{ email: "bad", firstAt: "x", lastAt: "y", count: 1 }] }),
    HostedContractError,
  );
  const error = thrown(() =>
    validateSignupAttemptsRecord({ v: 1, attempts: [{ email: "ann@example.com", firstAt: AT.toISOString(), lastAt: AT.toISOString(), count: 0 }] }),
  );
  assert.ok(error instanceof HostedContractError, "a non-positive count is refused");
});
