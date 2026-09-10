/**
 * Regressions for `../lib/auth-store.mjs`.
 *
 * Every test below names one guarded condition in that module, and the suite is
 * written so that removing the condition makes the test fail rather than merely
 * making it less thorough. The heavy lean is on the three properties a naive
 * implementation gets wrong and nothing notices:
 *
 *  - a storage outage that reads as "signed out",
 *  - "single use" implemented as a delete, which is not single use,
 *  - "revoked" reported for a write that was never observed to land.
 *
 *   node --test netlify/test/hosted/auth-store.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { AuthUnavailableError } from "../../lib/hosted/auth-errors.mjs";
import {
  AuthStore,
  SESSION_TTL_SECONDS,
  TRANSIENT_KINDS,
  TRANSIENT_TTL_SECONDS,
} from "../../lib/hosted/auth-store.mjs";
import { MemoryBlobStore, PRINCIPAL_ALPHA, PRINCIPAL_BETA, fixedClock, memoryAuthStore } from "./fixtures/auth.mjs";

test("every read is strongly consistent", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  await store.readSession(token);
  assert.ok(blobs.reads.length > 0, "expected at least one read");
  for (const read of blobs.reads) {
    assert.equal(
      read.options.consistency,
      "strong",
      "an eventually consistent read of a session record is a revocation that has not happened yet",
    );
  }
});

test("a session is keyed by the hash of its token, never by the token", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  const expected = `sessions/${createHash("sha256").update(token, "utf8").digest("hex")}`;
  assert.deepEqual(blobs.keys(), [expected]);
  const serialised = JSON.stringify([...blobs.entries.values()]);
  assert.ok(!serialised.includes(token), "the raw session token must never be stored");
});

test("a session round trips to its principal", async () => {
  const { store } = memoryAuthStore();
  const { token, expiresAt } = await store.createSession(PRINCIPAL_ALPHA);
  const session = await store.readSession(token);
  assert.deepEqual(session.principal, PRINCIPAL_ALPHA);
  assert.equal(session.expiresAt, expiresAt);
});

test("a malformed principal cannot become a session", async () => {
  const { store } = memoryAuthStore();
  for (const bad of [
    { ...PRINCIPAL_ALPHA, accountId: "alpha-example" },
    { ...PRINCIPAL_ALPHA, accountId: "gh_2020" },
    { ...PRINCIPAL_ALPHA, providerUserId: "01010", accountId: "gh_01010" },
    { ...PRINCIPAL_ALPHA, provider: "gitlab.com" },
    { ...PRINCIPAL_ALPHA, login: "alpha@example.com" },
  ]) {
    await assert.rejects(() => store.createSession(bad), { code: "invalid_request" });
  }
});

test("two accounts sharing a login are two sessions", async () => {
  const { store } = memoryAuthStore();
  const alpha = await store.createSession(PRINCIPAL_ALPHA);
  const beta = await store.createSession(PRINCIPAL_BETA);
  assert.equal(PRINCIPAL_ALPHA.login, PRINCIPAL_BETA.login);
  assert.equal((await store.readSession(alpha.token)).principal.accountId, "gh_1010");
  assert.equal((await store.readSession(beta.token)).principal.accountId, "gh_2020");
});

test("an unknown, expired or revoked session is null", async () => {
  const clock = fixedClock();
  const { store } = memoryAuthStore(clock);
  assert.equal(await store.readSession("no-such-token"), null);

  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  clock.advanceSeconds(SESSION_TTL_SECONDS + 1);
  assert.equal(await store.readSession(token), null, "absolute expiry is enforced on lookup");

  const fresh = fixedClock();
  const live = memoryAuthStore(fresh);
  const created = await live.store.createSession(PRINCIPAL_ALPHA);
  await live.store.revokeSession(created.token);
  assert.equal(await live.store.readSession(created.token), null);
});

test("a storage outage throws unavailable rather than reading as signed out", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  blobs.fail("sessions/", "read");
  await assert.rejects(() => store.readSession(token), (error) => {
    assert.ok(error instanceof AuthUnavailableError);
    assert.equal(error.reason, "storage");
    assert.equal(error.code, "unavailable");
    return true;
  });
});

test("a stored record that no longer satisfies C1 is not a principal", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  const key = blobs.keys()[0];
  const entry = blobs.entries.get(key);
  entry.data.principal = { ...PRINCIPAL_ALPHA, accountId: "gh_9999" };
  assert.equal(await store.readSession(token), null);
});

test("revocation survives an ambiguous write", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  blobs.fail("sessions/", "ambiguous");
  assert.equal(await store.revokeSession(token), true, "the write landed before it threw");
  assert.equal(await store.readSession(token), null);
});

test("revocation that cannot be established is an outage, not a success", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  blobs.fail("sessions/", "write");
  await assert.rejects(() => store.revokeSession(token), AuthUnavailableError);
  assert.notEqual(await store.readSession(token), null, "the session is still live, and says so");

  blobs.fail("sessions/", "refuse");
  await assert.rejects(() => store.revokeSession(token), AuthUnavailableError);
});

test("revoking twice reports the second call as nothing to do", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  assert.equal(await store.revokeSession(token), true);
  assert.equal(await store.revokeSession(token), false);
});

test("a transient record is consumed at most once, ever", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createTransient("oauth", { codeVerifier: "v" });
  const first = await store.consumeTransient("oauth", token);
  assert.equal(first.payload.codeVerifier, "v");
  assert.equal(await store.consumeTransient("oauth", token), null, "a replay finds nothing");
});

test("two simultaneous consumptions of one state: exactly one wins", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createTransient("oauth", { codeVerifier: "v" });
  const results = await Promise.all([
    store.consumeTransient("oauth", token),
    store.consumeTransient("oauth", token),
  ]);
  const winners = results.filter((result) => result !== null);
  assert.equal(winners.length, 1, "an unconditional delete would let both through");
});

test("reading a transient record does not consume it", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createTransient("binding", { operation: "op" });
  assert.equal((await store.readTransient("binding", token)).payload.operation, "op");
  assert.equal((await store.readTransient("binding", token)).payload.operation, "op");
  assert.notEqual(await store.consumeTransient("binding", token), null);
});

test("a transient record expires on lookup", async () => {
  const clock = fixedClock();
  const { store } = memoryAuthStore(clock);
  const { token } = await store.createTransient("login");
  clock.advanceSeconds(TRANSIENT_TTL_SECONDS + 1);
  assert.equal(await store.readTransient("login", token), null);
  assert.equal(await store.consumeTransient("login", token), null);
});

test("a revoked transient record is dead to every later read", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createTransient("binding", { operation: "op" });
  assert.equal(await store.revokeTransient("binding", token), true);
  assert.equal(await store.readTransient("binding", token), null);
  assert.equal(await store.consumeTransient("binding", token), null);
});

test("each transient kind is its own namespace", async () => {
  const { store, blobs } = memoryAuthStore();
  const minted = [];
  for (const kind of TRANSIENT_KINDS) minted.push([kind, (await store.createTransient(kind)).token]);
  for (const [kind, token] of minted) {
    assert.notEqual(await store.readTransient(kind, token), null);
    for (const other of TRANSIENT_KINDS) {
      if (other === kind) continue;
      assert.equal(
        await store.readTransient(other, token),
        null,
        "a token minted for one kind must not be presentable as another",
      );
    }
  }
  assert.ok(blobs.keys().every((key) => key.startsWith("auth/")));
  assert.deepEqual(blobs.keys().map((key) => key.split("/")[1]).sort(), [...TRANSIENT_KINDS].sort());
});

test("an unknown transient kind is a programming error", async () => {
  const { store } = memoryAuthStore();
  await assert.rejects(() => store.createTransient("publications"), TypeError);
  assert.throws(() => AuthStore.transientKey("publications", "t"), TypeError);
});

test("a transient lifetime cannot exceed the fifteen-minute ceiling", async () => {
  const { store } = memoryAuthStore();
  await assert.rejects(
    () => store.createTransient("oauth", {}, { ttlSeconds: TRANSIENT_TTL_SECONDS + 1 }),
    TypeError,
  );
  await assert.rejects(() => store.createTransient("oauth", {}, { ttlSeconds: 0 }), TypeError);
});

test("a store that refuses the create is an outage, not a silent overwrite", async () => {
  const { store, blobs } = memoryAuthStore();
  blobs.fail("sessions/", "refuse");
  await assert.rejects(() => store.createSession(PRINCIPAL_ALPHA), AuthUnavailableError);
});

test("a conditional write that reports success without applying is not a revocation", async () => {
  /* `@netlify/blobs` maps every non-412 status of a conditional PUT to
     `{modified: true}` and returns a 5xx response rather than throwing, so
     believing that flag would make logout answer 200 for a session that is
     still live. */
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  blobs.fail("sessions/", "phantom");
  await assert.rejects(() => store.revokeSession(token), AuthUnavailableError);
  assert.notEqual(await store.readSession(token), null, "the session is still live, and says so");
});

test("a phantom consume does not win the compare-and-set", async () => {
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createTransient("oauth", { codeVerifier: "v" });
  blobs.fail("auth/oauth/", "phantom");
  await assert.rejects(() => store.consumeTransient("oauth", token), AuthUnavailableError);
  assert.notEqual(await store.readTransient("oauth", token), null, "nothing was consumed");
});

test("a phantom create is an outage rather than a session", async () => {
  const { store, blobs } = memoryAuthStore();
  blobs.fail("sessions/", "phantom");
  await assert.rejects(() => store.createSession(PRINCIPAL_ALPHA), AuthUnavailableError);
  assert.deepEqual(blobs.keys(), []);
});

test("a read with no ETag refuses the compare-and-set instead of downgrading it", async () => {
  /* The client applies `onlyIfMatch` only when the value is truthy, so an absent
     ETag would silently turn every guarded write into an unconditional one. */
  const { store, blobs } = memoryAuthStore();
  const { token } = await store.createSession(PRINCIPAL_ALPHA);
  blobs.fail("sessions/", "noetag");
  await assert.rejects(() => store.revokeSession(token), AuthUnavailableError);
  assert.notEqual(await store.readSession(token), null);

  const transient = await store.createTransient("oauth", { codeVerifier: "v" });
  blobs.fail("auth/oauth/", "noetag");
  await assert.rejects(() => store.consumeTransient("oauth", transient.token), AuthUnavailableError);
  assert.notEqual(await store.readTransient("oauth", transient.token), null);
});

test("a login binding is single use and must have been issued here", async () => {
  const { store } = memoryAuthStore();
  const issued = await store.createTransient("login");
  assert.notEqual(await store.consumeTransient("login", issued.token), null);
  assert.equal(await store.consumeTransient("login", issued.token), null, "a replay must lose");
  assert.equal(await store.readTransient("login", issued.token), null);
});

test("a login binding this store never issued is refused", async () => {
  const { store, blobs } = memoryAuthStore();
  /* Well-formed in every respect and simply not ours. An earlier design read
     only the shape of the value, so this fabricated token was accepted once and
     the binding proved nothing beyond `SameSite` and `Origin`. */
  const fabricated = "c".repeat(43);
  assert.equal(await store.consumeTransient("login", fabricated), null);

  for (const token of ["", "short", "has/slash".padEnd(40, "a"), "x".repeat(300), null, 12]) {
    assert.equal(await store.consumeTransient("login", token), null, String(token));
  }
  assert.deepEqual(blobs.keys(), [], "refusing an unissued binding writes nothing");
});

test("reading a consumed transient record finds nothing", async () => {
  const { store } = memoryAuthStore();
  const { token } = await store.createTransient("oauth", { codeVerifier: "v" });
  await store.consumeTransient("oauth", token);
  assert.equal(await store.readTransient("oauth", token), null);
});

test("a programming error is not dressed up as a storage outage", async () => {
  const { store, blobs } = memoryAuthStore();
  blobs.setJSON = async () => {
    throw new TypeError("The 'onlyIfMatch' and 'onlyIfNew' options are mutually exclusive.");
  };
  await assert.rejects(() => store.createSession(PRINCIPAL_ALPHA), TypeError);
});

test("the adapter requires a store and a clock", () => {
  assert.throws(() => new AuthStore(null), TypeError);
  assert.throws(() => new AuthStore(new MemoryBlobStore(), { now: 0 }), TypeError);
});
