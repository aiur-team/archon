/**
 * Regressions for the one domain-access evaluator.
 *
 * The table this runs is `fixtures/domain-access.mjs`, and it is the same table
 * the access-route suite and the document-route suite import. What this file
 * adds on top of the table is the set of properties that are about the *module*
 * rather than about a row: that it reads no clock and no environment, that it
 * never suffix-matches whatever the list says, that its output is frozen, and
 * that the denylist is the twelve domains the contract names and no others.
 *
 *   node --test netlify/test/hosted/domain-access.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOMAIN_LIST_LIMITS,
  DomainAccessError,
  PUBLIC_MAILBOX_DOMAINS,
  emailDomain,
  evaluateAccess,
  isPublicMailbox,
  normalizeDomainList,
} from "../../lib/hosted/domain-access.mjs";
import { emailDomain as emailDomainFromGrammar, normalizeEmailOrNull } from "../../lib/hosted/email.mjs";
import { FIXTURE_OWNER_ACCOUNT_ID } from "./contract-fixtures.mjs";
import { RECORDS } from "./fixtures/publications.mjs";
import { LISTED_DOMAINS, READ_CASES, WRITE_CASES, readerAt } from "./fixtures/domain-access.mjs";

const LIB = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "lib", "hosted");

/** A complete record carrying `allowedDomains`, built from the shared fixture. */
function documentListing(allowedDomains = LISTED_DOMAINS) {
  return { ...RECORDS.complete, allowedDomains: [...allowedDomains] };
}

/**
 * The `DomainAccessError` a call raises, or a failure naming the case.
 *
 * `assert.throws` returns nothing, so a row that asserted on its return value
 * read every refusal as `undefined.reason` - which is a `TypeError`, not a
 * passing test, but is also not the assertion anybody meant to write.
 */
function refusalFrom(run, name) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DomainAccessError, `${name}: threw ${error}`);
    return error;
  }
  assert.fail(`${name}: expected a refusal`);
}

/* ------------------------------------------------------------------ */
/* the shared table                                                    */
/* ------------------------------------------------------------------ */

test("every read row in the shared table decides the way the table says", () => {
  for (const row of READ_CASES) {
    const record = documentListing(row.allowedDomains ?? LISTED_DOMAINS);
    const decision = evaluateAccess({ record, principal: row.principal });

    /* Each row names exactly one of the two outcomes, so a row that named
       neither - or both - would be a row nobody is actually asserting. */
    assert.equal(
      (row.role === undefined) !== (row.reason === undefined),
      true,
      `${row.name}: a row must name a role or a reason, not both`,
    );

    if (row.role !== undefined) {
      assert.deepEqual(decision, { allowed: true, role: row.role, reason: null }, row.name);
    } else {
      assert.deepEqual(decision, { allowed: false, role: null, reason: row.reason }, row.name);
    }
  }
});

test("every write row in the shared table normalizes or refuses the way it says", () => {
  for (const row of WRITE_CASES) {
    if (row.expect !== undefined) {
      assert.deepEqual(normalizeDomainList(row.input), row.expect, row.name);
      continue;
    }
    const error = refusalFrom(() => normalizeDomainList(row.input), row.name);
    assert.equal(error.reason, row.reason, row.name);
    if (row.domain !== undefined) {
      assert.equal(error.domain, row.domain, row.name);
      /* The owner has to be able to see which entry they got wrong. */
      assert.match(error.message, new RegExp(row.domain.replaceAll(".", "\\.")), row.name);
    }
  }
});

test("the table is not vacuous", () => {
  /* A shared table is only worth its indirection if it actually holds the cases,
     and a filter typo that emptied one half would leave both loops above green.
     The numbers are floors rather than exact counts so adding a row is not a
     two-file edit. */
  assert.ok(READ_CASES.filter((row) => row.role !== undefined).length >= 6);
  assert.ok(READ_CASES.filter((row) => row.reason === "not_found").length >= 8);
  assert.ok(READ_CASES.filter((row) => row.reason === "email_unverified").length >= 4);
  assert.ok(WRITE_CASES.filter((row) => row.expect !== undefined).length >= 5);
  assert.ok(WRITE_CASES.filter((row) => row.reason === "public_mailbox_domain").length >= 12);
  assert.ok(WRITE_CASES.filter((row) => row.reason === "invalid_domain").length >= 10);
});

/* ------------------------------------------------------------------ */
/* matching is equality, whatever is on the list                       */
/* ------------------------------------------------------------------ */

test("no listed domain admits a name it is merely a suffix of", () => {
  /* The table covers this for `example.com`. This covers it for every domain
     shape at once, which is the form a suffix rule would survive: a check that
     tested one fixture domain would pass on `endsWith` for the others. */
  for (const listed of ["example.com", "corp.example.net", "a.b.c.example.org"]) {
    const record = documentListing([listed]);
    for (const attacker of [
      `not${listed}`,
      `x.${listed}`,
      `${listed}.evil.example`,
      `${listed}x`,
      listed.slice(1),
    ]) {
      const decision = evaluateAccess({ record, principal: readerAt(`ann@${attacker}`) });
      assert.equal(decision.allowed, false, `${attacker} was admitted by ${listed}`);
      assert.equal(decision.reason, "not_found");
    }
    /* And the exact name still works, so the loop above is not passing by
       refusing everything. */
    assert.equal(evaluateAccess({ record, principal: readerAt(`ann@${listed}`) }).role, "reader");
  }
});

test("a record whose stored list is not a list of strings admits nobody", () => {
  /* Fail closed on data this module cannot read. `validatePublication` would
     have refused each of these, so reaching one means something upstream is
     already wrong - and the safe answer to "I cannot tell what this policy says"
     is to enforce no policy rather than to guess at one. */
  for (const broken of [null, undefined, "example.com", { 0: "example.com" }, 7]) {
    const record = { ...RECORDS.complete, allowedDomains: broken };
    const decision = evaluateAccess({ record, principal: readerAt("ann@example.com") });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "not_found");
  }
  /* An array holding non-strings drops those entries rather than throwing. */
  const mixed = { ...RECORDS.complete, allowedDomains: [null, 1, "example.com"] };
  assert.equal(evaluateAccess({ record: mixed, principal: readerAt("ann@example.com") }).role, "reader");
});

/* ------------------------------------------------------------------ */
/* the record's own state                                              */
/* ------------------------------------------------------------------ */

test("only a complete record is readable, by anyone including its owner", () => {
  const owner = readerAt(null, false, FIXTURE_OWNER_ACCOUNT_ID);
  for (const state of ["pending", "approved", "denied", "cancelled", "expired"]) {
    const record = { ...RECORDS[state], allowedDomains: [...LISTED_DOMAINS] };
    for (const principal of [owner, readerAt("ann@example.com")]) {
      const decision = evaluateAccess({ record, principal });
      assert.equal(decision.allowed, false, `${state} was readable`);
      assert.equal(decision.reason, "not_found");
    }
  }
});

test("a missing record and a listed reader are still not found", () => {
  const decision = evaluateAccess({ record: null, principal: readerAt("ann@example.com") });
  assert.deepEqual(decision, { allowed: false, role: null, reason: "not_found" });
});

test("a null owner key is never matched by a principal", () => {
  /* `ownerAccountId` is null on a record with no owner, and a principal whose
     `accountId` were somehow null must not thereby own every such record. */
  const record = { ...RECORDS.complete, ownerAccountId: null, allowedDomains: [] };
  const decision = evaluateAccess({ record, principal: readerAt(null, false, null) });
  assert.equal(decision.allowed, false);
});

/* ------------------------------------------------------------------ */
/* the ACN-008 seam                                                    */
/* ------------------------------------------------------------------ */

test("an explicit role is honoured, and outranks the domain list", () => {
  /* The seam ACN-008 calls through: a collaboration document resolves a grant
     or a live invitation to a role first, and hands it here. A hosted
     publication passes nothing, which is why every other case in this file
     omits it. */
  const record = documentListing([]);
  const decision = evaluateAccess({
    record,
    principal: readerAt("ann@stranger.example"),
    explicitRole: "commenter",
  });
  assert.deepEqual(decision, { allowed: true, role: "commenter", reason: null });
});

test('an explicit role of "none" or an empty string admits nobody', () => {
  const record = documentListing([]);
  for (const explicitRole of ["none", "", null, undefined, false, 0]) {
    const decision = evaluateAccess({
      record,
      principal: readerAt("ann@stranger.example"),
      explicitRole,
    });
    assert.equal(decision.allowed, false, `explicitRole ${JSON.stringify(explicitRole)} admitted`);
  }
});

test("an explicit role never rescues a signed-out caller or an incomplete record", () => {
  assert.equal(
    evaluateAccess({ record: documentListing(), principal: null, explicitRole: "owner" }).reason,
    "session_required",
  );
  assert.equal(
    evaluateAccess({
      record: { ...RECORDS.pending, allowedDomains: [] },
      principal: readerAt("ann@example.com"),
      explicitRole: "owner",
    }).reason,
    "not_found",
  );
});

/* ------------------------------------------------------------------ */
/* the denylist                                                        */
/* ------------------------------------------------------------------ */

test("the denylist is the twelve domains the contract names, sorted and frozen", () => {
  assert.deepEqual([...PUBLIC_MAILBOX_DOMAINS], [
    "aol.com",
    "gmail.com",
    "googlemail.com",
    "hotmail.com",
    "icloud.com",
    "live.com",
    "mail.ru",
    "outlook.com",
    "pm.me",
    "proton.me",
    "qq.com",
    "yahoo.com",
  ]);
  assert.ok(Object.isFrozen(PUBLIC_MAILBOX_DOMAINS));
  assert.deepEqual([...PUBLIC_MAILBOX_DOMAINS], [...PUBLIC_MAILBOX_DOMAINS].sort());
});

test("membership of the denylist is exact, never a suffix", () => {
  for (const domain of PUBLIC_MAILBOX_DOMAINS) assert.equal(isPublicMailbox(domain), true);
  for (const domain of ["mail.google.com", "gmail.com.evil.example", "notgmail.com", "gmail.co"]) {
    assert.equal(isPublicMailbox(domain), false, domain);
  }
  for (const value of [null, undefined, 7, ["gmail.com"]]) {
    assert.equal(isPublicMailbox(value), false);
  }
});

test("the site-wide override is the only thing that lifts the denylist", () => {
  assert.throws(() => normalizeDomainList(["gmail.com"]), DomainAccessError);
  assert.deepEqual(
    normalizeDomainList(["gmail.com"], { allowPublicMailboxes: true }),
    ["gmail.com"],
  );
  /* And it lifts *only* the denylist: the grammar and the bound still hold. */
  assert.throws(
    () => normalizeDomainList(["localhost"], { allowPublicMailboxes: true }),
    (error) => error.reason === "invalid_domain",
  );
  assert.throws(
    () =>
      normalizeDomainList(
        Array.from({ length: 21 }, (_, index) => `d${index}.example.net`),
        { allowPublicMailboxes: true },
      ),
    (error) => error.reason === "too_many_domains",
  );
});

test("only the boolean true lifts the denylist", () => {
  /* The same strictness `emailVerified` gets, in the other direction: a truthy
     option arriving from a misread environment value must not open the list. */
  for (const value of ["true", 1, {}, "yes"]) {
    assert.throws(
      () => normalizeDomainList(["gmail.com"], { allowPublicMailboxes: value }),
      DomainAccessError,
      `allowPublicMailboxes ${JSON.stringify(value)} lifted the denylist`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* the list normalizer's own shape                                     */
/* ------------------------------------------------------------------ */

test("a non-array list is refused rather than coerced", () => {
  for (const value of [null, undefined, "example.com", { 0: "example.com" }, 7]) {
    assert.throws(
      () => normalizeDomainList(value),
      (error) => error instanceof DomainAccessError && error.reason === "invalid_domain",
    );
  }
});

test("the normalizer returns a fresh array and never the caller's", () => {
  const input = ["b.example.com", "a.example.com"];
  const result = normalizeDomainList(input);
  assert.notEqual(result, input);
  assert.deepEqual(input, ["b.example.com", "a.example.com"]);
  result.push("c.example.com");
  assert.deepEqual(normalizeDomainList(input), ["a.example.com", "b.example.com"]);
});

test("the bounds are the contract's twenty and 253", () => {
  assert.equal(DOMAIN_LIST_LIMITS.MAX_DOMAINS, 20);
  assert.equal(DOMAIN_LIST_LIMITS.MAX_DOMAIN_LENGTH, 253);
});

/* ------------------------------------------------------------------ */
/* the address grammar this depends on                                 */
/* ------------------------------------------------------------------ */

test("emailDomain reads an already-normalized address and refuses anything else", () => {
  assert.equal(emailDomain("ann@example.com"), "example.com");
  assert.equal(emailDomain("ann+tag@sub.example.com"), "sub.example.com");
  /* Not a normalizer: an address that was never normalized answers null rather
     than a domain a later `===` would fail to match anyway. */
  assert.equal(emailDomain("Ann@Example.com"), null);
  assert.equal(emailDomain(" ann@example.com "), null);
  assert.equal(emailDomain("ann@example.com."), null);
  assert.equal(emailDomain("ann@localhost"), null);
  assert.equal(emailDomain("ann@a@example.com"), null);
  assert.equal(emailDomain("example.com"), null);
  for (const value of [null, undefined, 7, {}]) assert.equal(emailDomain(value), null);
  /* One implementation, re-exported rather than reimplemented. */
  assert.equal(emailDomain, emailDomainFromGrammar);
});

test("the grammar is the one the collaboration tree uses", () => {
  /* The whole point of lifting it: `netlify/lib/access.mjs` now calls this, so
     a spelling that one tree admits is a spelling the other admits. These are
     the payloads the domain rules depend on being refused upstream. */
  for (const value of [
    "ann@exаmple.com",
    "ann@example.com.",
    "ann@localhost",
    "a@@b.com",
    "",
    /* U+212A KELVIN SIGN lower-cases to an ASCII `k`, so an address at
       `book.example` would fold into one at `book.example` and exact-match a
       listed domain nobody at that domain issued. This is the case that makes
       "refuse non-ASCII, then lower-case" the right order rather than a
       stylistic one. */
    `ann@boo\u212A.example`,
  ]) {
    assert.equal(normalizeEmailOrNull(value), null, JSON.stringify(value));
  }
  assert.equal(normalizeEmailOrNull("  Ann@Example.COM "), "ann@example.com");
});

/* ------------------------------------------------------------------ */
/* the module's own constraints                                        */
/* ------------------------------------------------------------------ */

test("the evaluator reads no clock, no environment and no storage", () => {
  /* The seam ACN-008 depends on: plain data in, a decision out. A module that
     acquired an I/O dependency would stop being importable from the
     collaboration tree, which is how two evaluators get written. */
  for (const name of ["domain-access.mjs", "email.mjs"]) {
    const source = readFileSync(join(LIB, name), "utf8");
    for (const forbidden of ["Date.now", "process.env", "fetch(", "getStore", "import("]) {
      assert.ok(!source.includes(forbidden), `${name} must not reference ${forbidden}`);
    }
  }
  /* `email.mjs` imports nothing at all, because the Deno edge gate reaches it
     through `netlify/lib/access.mjs`. */
  const grammar = readFileSync(join(LIB, "email.mjs"), "utf8");
  assert.doesNotMatch(grammar, /^import\s/m);
  /* And the evaluator imports only the grammar, so neither drags `node:crypto`
     into the collaboration tree. */
  const evaluator = readFileSync(join(LIB, "domain-access.mjs"), "utf8");
  assert.deepEqual(
    [...evaluator.matchAll(/^import .* from "(.+)";$/gm)].map((match) => match[1]),
    ["./email.mjs"],
  );

  const realNow = Date.now;
  Date.now = () => {
    throw new Error("the evaluator consulted the clock");
  };
  try {
    evaluateAccess({ record: documentListing(), principal: readerAt("ann@example.com") });
    normalizeDomainList(["example.com"]);
  } finally {
    Date.now = realNow;
  }
});

test("a decision is frozen and always carries all three fields", () => {
  for (const row of READ_CASES) {
    const decision = evaluateAccess({
      record: documentListing(row.allowedDomains ?? LISTED_DOMAINS),
      principal: row.principal,
    });
    assert.ok(Object.isFrozen(decision));
    assert.deepEqual(Object.keys(decision).sort(), ["allowed", "reason", "role"]);
  }
});

test("the evaluator called with nothing refuses rather than throwing", () => {
  /* A caller that forgot an argument must get a refusal, not an exception that
     some outer boundary turns into a 503 - or worse, into a success. */
  assert.deepEqual(evaluateAccess(), { allowed: false, role: null, reason: "session_required" });
  assert.deepEqual(evaluateAccess({}), { allowed: false, role: null, reason: "session_required" });
});
