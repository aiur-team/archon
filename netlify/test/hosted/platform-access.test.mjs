/**
 * The platform-access evaluator, the admin capability, and the configuration
 * that seeds both.
 *
 * Every guard this suite covers is one a `git revert` of a single condition
 * would open, and each test is written so that reverting its condition fails
 * *this* assertion rather than some downstream one. The revert proofs are
 * recorded in the pull request; what is here is the standing regression.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { HostedConfigError, readHostedConfig } from "../../lib/hosted/config.mjs";
import {
  ALLOWLIST_LIMITS,
  PLATFORM_REFUSAL_REASONS,
  PlatformAccessError,
  evaluatePlatformAccess,
  isAdmin,
  normalizeAllowlist,
  normalizeAllowlistEntry,
  normalizeAllowlistEntryOrNull,
} from "../../lib/hosted/platform-access.mjs";
import { HOSTED_ENV } from "./fixtures/auth.mjs";

const ADMIN = "ops@example.com";

/** A principal at `email`, verified. */
function personAt(email, emailVerified = true) {
  return {
    accountId: "a0_3777bcebd9749d2c4d90673f61930f78",
    provider: "auth0",
    providerUserId: "github|1010",
    login: "someone",
    email,
    emailVerified,
  };
}

const entry = (kind, value) => ({ kind, value });

/** The error a call throws, which `assert.throws` does not hand back. */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

/* --- the entry grammar ---------------------------------------------------- */

test("an entry is an address or a domain, in one normalised spelling", () => {
  assert.deepEqual(normalizeAllowlistEntryOrNull("  Named@Gmail.COM "), {
    kind: "email",
    value: "named@gmail.com",
  });
  assert.deepEqual(normalizeAllowlistEntryOrNull("ACME.example "), {
    kind: "domain",
    value: "acme.example",
  });
});

test("an entry no identity provider could ever assert is refused, not stored", () => {
  /* Each of these is a spelling that would sit in the store looking like a
     policy and matching nobody: a homoglyph domain, a trailing dot that is the
     same name to DNS and a different string to `===`, a single-label host, two
     `@`, and a value that is not text at all. */
  for (const bad of [
    "ann@exаmple.com",
    "example.com.",
    "ann@localhost",
    "a@b@example.com",
    "",
    "   ",
    42,
    null,
    ["acme.example"],
  ]) {
    assert.equal(normalizeAllowlistEntryOrNull(bad), null, `${String(bad)} is not an entry`);
    assert.throws(() => normalizeAllowlistEntry(bad), PlatformAccessError);
  }
});

test("a refused entry is named back, bounded and stripped", () => {
  const error = thrown(() => normalizeAllowlistEntry("not a domain!!<script>"));
  assert.ok(error instanceof PlatformAccessError);
  assert.equal(error.reason, "invalid_entry");
  assert.ok(!error.entry.includes("<"), "the echo cannot carry markup");
  assert.ok(error.entry.length <= ALLOWLIST_LIMITS.MAX_ENTRY_LENGTH);
});

test("a list is de-duplicated, sorted and bounded", () => {
  assert.deepEqual(normalizeAllowlist(["b@x.example", "acme.example", "B@X.example"]), [
    entry("domain", "acme.example"),
    entry("email", "b@x.example"),
  ]);
  const tooMany = Array.from(
    { length: ALLOWLIST_LIMITS.MAX_ENTRIES + 1 },
    (_, index) => `p${index}@x.example`,
  );
  const error = thrown(() => normalizeAllowlist(tooMany));
  assert.ok(error instanceof PlatformAccessError);
  assert.equal(error.reason, "too_many_entries");
  assert.throws(() => normalizeAllowlist("acme.example"), PlatformAccessError);
});

/* --- the admin capability ------------------------------------------------- */

test("an admin is a verified address that matches a seeded one exactly", () => {
  assert.equal(isAdmin(personAt(ADMIN), [ADMIN]), true);
  assert.equal(isAdmin(personAt("someone@example.com"), [ADMIN]), false);
  assert.equal(isAdmin(null, [ADMIN]), false);
  assert.equal(isAdmin(personAt(ADMIN), []), false);
});

test("an unverified address is never an admin, however truthy the claim looks", () => {
  /* The boolean, exactly. This is the guard that keeps the whole capability
     from being a matter of typing the right thing into a sign-up form. */
  const verified = personAt(ADMIN);
  for (const claim of [false, "true", 1, null, {}]) {
    assert.equal(
      isAdmin({ ...verified, emailVerified: claim }, [ADMIN]),
      false,
      `emailVerified=${String(claim)} is not verification`,
    );
  }
  /* Spread rather than an argument, and the absent key rather than an explicit
     `undefined`: a provider that stops asserting the claim omits it, and a
     helper with a default would have quietly turned that row into a verified
     principal. */
  const { emailVerified, ...withoutClaim } = verified;
  assert.equal(isAdmin(withoutClaim, [ADMIN]), false, "an absent claim is not verification");
});

test("an unnormalised seeded address matches nobody rather than everybody", () => {
  /* `admins` is `readHostedConfig`'s normalised output. A caller that passed raw
     environment text must get `false`, not a match against a string no provider
     will assert. */
  assert.equal(isAdmin(personAt(ADMIN), ["OPS@Example.com"]), false);
});

/* --- the gate ------------------------------------------------------------- */

test("with the gate off, anybody who signed in is admitted", () => {
  const decision = evaluatePlatformAccess({
    principal: personAt("stranger@nowhere.example"),
    admins: [ADMIN],
    allowlist: [],
    enforced: false,
  });
  assert.deepEqual(decision, { allowed: true, admin: false, reason: null });
});

test("with the gate on, a named address on a refused public domain is admitted", () => {
  /* The ticket's central case: gmail is a public mailbox provider and is refused
     as a bulk domain rule, and one named gmail address is still a person this
     deployment wants. */
  const admitted = evaluatePlatformAccess({
    principal: personAt("named@gmail.com"),
    admins: [ADMIN],
    allowlist: [entry("email", "named@gmail.com")],
    enforced: true,
  });
  assert.deepEqual(admitted, { allowed: true, admin: false, reason: null });

  const refused = evaluatePlatformAccess({
    principal: personAt("other@gmail.com"),
    admins: [ADMIN],
    allowlist: [entry("email", "named@gmail.com")],
    enforced: true,
  });
  assert.deepEqual(refused, { allowed: false, admin: false, reason: "not_allowlisted" });
});

test("a domain entry admits every address at that domain and no other", () => {
  const allowlist = [entry("domain", "acme.example")];
  const call = (email) =>
    evaluatePlatformAccess({ principal: personAt(email), admins: [], allowlist, enforced: true });

  assert.equal(call("anyone@acme.example").allowed, true);
  assert.equal(call("someone.else@acme.example").allowed, true);
  /* Full-string equality, never `endsWith`. A suffix rule would admit both of
     these, and either is a domain anybody can register. */
  assert.equal(call("attacker@notacme.example").allowed, false);
  assert.equal(call("attacker@sub.acme.example").allowed, false);
  assert.equal(call("attacker@acme.example.evil").allowed, false);
});

test("an email entry does not admit the rest of its domain", () => {
  const allowlist = [entry("email", "named@gmail.com")];
  assert.equal(
    evaluatePlatformAccess({ principal: personAt("someone@gmail.com"), allowlist, enforced: true })
      .allowed,
    false,
  );
});

test("a stored entry whose kind disagrees with its value admits by the kind it claims", () => {
  /* The evaluator trusts `kind`, which is why `validateAllowlistRecord` refuses
     a record where the two disagree. This test pins the division of labour: if
     the evaluator ever starts re-deriving the kind, the storage guard would look
     redundant and be removed. */
  const allowlist = [entry("domain", "gmail.com")];
  assert.equal(
    evaluatePlatformAccess({ principal: personAt("anyone@gmail.com"), allowlist, enforced: true })
      .allowed,
    true,
  );
});

test("an admin is admitted under an enforced empty list and an unreadable store", () => {
  /* The recovery path. An operator who enforced an empty list, or whose
     allowlist store is unreachable, can still reach `/admin` and fix it. */
  for (const allowlist of [[], null]) {
    const decision = evaluatePlatformAccess({
      principal: personAt(ADMIN),
      admins: [ADMIN],
      allowlist,
      enforced: true,
    });
    assert.deepEqual(decision, { allowed: true, admin: true, reason: null });
  }
});

test("an unreadable list refuses everybody else with its own retryable reason", () => {
  /* `null` is not the empty list. An outage must never land a visitor on "you
     are not allowed to use this", which is a message they act on by giving up. */
  const decision = evaluatePlatformAccess({
    principal: personAt("named@gmail.com"),
    admins: [ADMIN],
    allowlist: null,
    enforced: true,
  });
  assert.deepEqual(decision, { allowed: false, admin: false, reason: "allowlist_unavailable" });
});

test("under the gate, verification is decided before the list is consulted", () => {
  /* The ordering is the anti-oracle guard: an unverified caller gets the same
     answer whether or not their address is on the list, so nobody can learn who
     is on the platform allowlist by signing up as them. */
  const listed = evaluatePlatformAccess({
    principal: personAt("named@gmail.com", false),
    allowlist: [entry("email", "named@gmail.com")],
    enforced: true,
  });
  const unlisted = evaluatePlatformAccess({
    principal: personAt("stranger@gmail.com", false),
    allowlist: [entry("email", "named@gmail.com")],
    enforced: true,
  });
  assert.deepEqual(listed, unlisted);
  assert.equal(listed.reason, "email_unverified");
});

test("a signed-out caller is refused before anything else runs", () => {
  for (const principal of [null, undefined]) {
    assert.deepEqual(evaluatePlatformAccess({ principal, enforced: true }), {
      allowed: false,
      admin: false,
      reason: "session_required",
    });
  }
});

test("the gate is off unless it is spelled exactly", () => {
  /* A truthy-looking value must not turn the platform's admission rule on: this
     comes from an environment variable, and the failure would be a deployment
     that locks out everybody it did not seed. */
  for (const enforced of [undefined, false, "true", 1, {}]) {
    assert.equal(
      evaluatePlatformAccess({
        principal: personAt("stranger@nowhere.example"),
        allowlist: [],
        enforced,
      }).allowed,
      true,
      `enforced=${String(enforced)} does not enforce`,
    );
  }
});

test("a malformed entry in the list is skipped, not thrown on", () => {
  /* A stored list is validated on read, so this cannot normally happen. It is
     checked because the alternative failure - an exception out of an access
     decision - is a 503 on every sign-in until somebody edits storage by hand. */
  const decision = evaluatePlatformAccess({
    principal: personAt("named@gmail.com"),
    allowlist: [null, "acme.example", entry("email", "named@gmail.com")],
    enforced: true,
  });
  assert.equal(decision.allowed, true);
});

test("every reason the evaluator returns is in the exported set", () => {
  const produced = new Set();
  const cases = [
    { principal: null, enforced: true },
    { principal: personAt("x@y.example"), allowlist: null, enforced: true },
    { principal: personAt("x@y.example", false), allowlist: [], enforced: true },
    { principal: personAt("x@y.example"), allowlist: [], enforced: true },
  ];
  for (const input of cases) {
    const { reason } = evaluatePlatformAccess(input);
    if (reason !== null) produced.add(reason);
  }
  assert.deepEqual([...produced].sort(), [...PLATFORM_REFUSAL_REASONS].sort());
});

/* --- the configuration that seeds it -------------------------------------- */

test("the admin list is normalised, de-duplicated and sorted", () => {
  const config = readHostedConfig({
    ...HOSTED_ENV,
    ARCHON_ADMINS: " Its.Everdred@Gmail.com , second@example.com ,ITS.EVERDRED@gmail.com,",
  });
  assert.deepEqual([...config.admins], ["its.everdred@gmail.com", "second@example.com"]);
});

test("a mistyped admin address is a configuration error, not an empty list", () => {
  /* Silently dropping it would be discovered only when somebody needs the
     console, and the person who needs it is locked out at that moment. */
  const error = thrown(() =>
    readHostedConfig({ ...HOSTED_ENV, ARCHON_ADMINS: "ops@example.com,not-an-address" }),
  );
  assert.ok(error instanceof HostedConfigError);
  assert.equal(error.key, "ARCHON_ADMINS");
  assert.ok(!error.message.includes("not-an-address"), "the fault names the position, not the value");
});

test("the allowlist seed accepts addresses and domains together", () => {
  const config = readHostedConfig({
    ...HOSTED_ENV,
    ARCHON_PLATFORM_ALLOWLIST: "acme.example, Named@Gmail.com",
  });
  assert.deepEqual(
    config.platformAllowlistSeed.map((held) => `${held.kind}:${held.value}`),
    ["domain:acme.example", "email:named@gmail.com"],
  );
});

test("a malformed seed is a configuration error that does not echo the value", () => {
  const error = thrown(() =>
    readHostedConfig({ ...HOSTED_ENV, ARCHON_PLATFORM_ALLOWLIST: "someone@example.com, @@" }),
  );
  assert.ok(error instanceof HostedConfigError);
  assert.equal(error.key, "ARCHON_PLATFORM_ALLOWLIST");
  assert.ok(!error.message.includes("someone@example.com"), "no address reaches a deploy log");
});

test("the enforcement flag is exactly true or false when set", () => {
  assert.equal(readHostedConfig(HOSTED_ENV).platformAllowlistEnforced, false);
  assert.equal(
    readHostedConfig({ ...HOSTED_ENV, ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true" })
      .platformAllowlistEnforced,
    true,
  );
  for (const value of ["1", "yes", "TRUE", "on"]) {
    assert.throws(
      () => readHostedConfig({ ...HOSTED_ENV, ARCHON_PLATFORM_ALLOWLIST_ENFORCED: value }),
      (error) =>
        error instanceof HostedConfigError && error.key === "ARCHON_PLATFORM_ALLOWLIST_ENFORCED",
    );
  }
});

test("the admin list is bounded", () => {
  const many = Array.from({ length: 11 }, (_, index) => `admin${index}@example.com`).join(",");
  assert.throws(
    () => readHostedConfig({ ...HOSTED_ENV, ARCHON_ADMINS: many }),
    (error) => error instanceof HostedConfigError && error.key === "ARCHON_ADMINS",
  );
});
