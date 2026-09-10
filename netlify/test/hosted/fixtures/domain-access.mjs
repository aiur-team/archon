/**
 * The one admit/refuse table for domain access, imported by every suite that
 * touches it.
 *
 * The evaluator suite runs it against `evaluateAccess` directly, the route suite
 * runs the *write* half against the access route, and the read-path suite runs
 * the read half through the real handlers. That is the whole reason this file
 * exists rather than three tables: the ticket's risk is a bypass that one suite
 * covers and another does not, and a shared table makes "the write path and the
 * read path disagree about `example.com.`" a thing that cannot be true.
 *
 * The rows are the T5, T6 and T7 threat table, restated as data:
 *
 *  - **T5** - subdomain, suffix, IDN homoglyph, punycode, trailing dot, case.
 *  - **T6** - plus-addressing and other local-part games, which must change
 *    nothing, because the decision is about the domain.
 *  - **T7** - an unverified address admitted, in every spelling of "unverified"
 *    a provider might send.
 *
 * Add a row here rather than a case in one suite. A threat that only one caller
 * is held to is the shape of the bug this ticket is about.
 */

import {
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OTHER_PRINCIPAL,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
} from "../contract-fixtures.mjs";

/** The domain a document lists in every read row below. */
export const LISTED_DOMAIN = "example.com";

/** A second listed domain, so no row can pass by "the list has one entry". */
export const SECOND_LISTED_DOMAIN = "partner.example.org";

/** The list a fixture document carries. Normalized, sorted, unique. */
export const LISTED_DOMAINS = Object.freeze([LISTED_DOMAIN, SECOND_LISTED_DOMAIN]);

/**
 * A principal at `email`, with `emailVerified` exactly as given.
 *
 * Built on the two real fixture identities rather than by overriding an account
 * id on an arbitrary one, because `accountId` is a one-way digest of
 * `providerUserId` and `validatePrincipal` cross-checks the two - a row that
 * changed one without the other is a principal no session store would ever hold,
 * so the read-path suite could not sign it in.
 *
 * `emailVerified` is deliberately *not* coerced: some rows pass the string
 * `"true"` or the number `1`, and the point of those rows is that the evaluator
 * treats them as unverified. A helper that normalized them would test the
 * helper.
 */
export function readerAt(email, emailVerified = true, accountId = FIXTURE_OTHER_ACCOUNT_ID) {
  const base = accountId === FIXTURE_OWNER_ACCOUNT_ID ? FIXTURE_PRINCIPAL : FIXTURE_OTHER_PRINCIPAL;
  return { ...base, accountId, email, emailVerified };
}

/** The same principal with no `emailVerified` key at all, as a provider might send. */
export function withoutVerification(principal) {
  const { emailVerified, ...rest } = principal;
  return rest;
}

/**
 * The read table: one principal, one stored list, one expected outcome.
 *
 * `role` is what an admitted reader gets; `reason` is the refusal code. Exactly
 * one of the two is set on every row, which is asserted rather than assumed.
 *
 * `evaluatorOnly` marks a row whose principal `validatePrincipal` would refuse -
 * an unnormalized address, a non-boolean `emailVerified`. Those rows are the
 * point of the evaluator's own strictness and cannot be signed in, so the
 * read-path suite skips them and the evaluator suite runs them all. Read the
 * flag as "no session store would ever hold this", never as "this case does not
 * matter": the evaluator is the last line, and it is held to them.
 */
export const READ_CASES = Object.freeze([
  /* --- admitted ------------------------------------------------------- */
  {
    name: "a verified address at a listed domain reads",
    principal: readerAt(`ann@${LISTED_DOMAIN}`),
    role: "reader",
  },
  {
    name: "the second listed domain reads too",
    principal: readerAt(`bo@${SECOND_LISTED_DOMAIN}`),
    role: "reader",
  },
  {
    name: "T6: a plus-addressed local part changes nothing",
    principal: readerAt(`ann+archon@${LISTED_DOMAIN}`),
    role: "reader",
  },
  {
    name: "T6: a dotted local part changes nothing",
    principal: readerAt(`a.n.n@${LISTED_DOMAIN}`),
    role: "reader",
  },
  {
    name: "the owner reads their own document",
    principal: readerAt("owner@elsewhere.example", true, FIXTURE_OWNER_ACCOUNT_ID),
    role: "owner",
  },
  {
    name: "the owner reads it with an unverified address",
    /* Settled: the owner is admitted before any email logic. Their claim is the
       stored account id, so a provider that stops asserting verification cannot
       lock them out of a document they published. */
    principal: readerAt("owner@elsewhere.example", false, FIXTURE_OWNER_ACCOUNT_ID),
    role: "owner",
  },
  {
    name: "the owner reads it with no address at all",
    principal: readerAt(null, false, FIXTURE_OWNER_ACCOUNT_ID),
    role: "owner",
  },
  {
    name: "the owner reads it even when the list is empty",
    principal: readerAt("owner@elsewhere.example", true, FIXTURE_OWNER_ACCOUNT_ID),
    allowedDomains: [],
    role: "owner",
  },

  /* --- T5: matching is exact, full-domain equality --------------------- */
  {
    name: "T5: a subdomain of a listed domain is not listed",
    principal: readerAt(`ann@mail.${LISTED_DOMAIN}`),
    reason: "not_found",
  },
  {
    name: "T5: a suffix match is not a match",
    /* The `endsWith` failure, spelled out: `notexample.com` ends with
       `example.com`, and a suffix rule would admit anyone who can register it. */
    principal: readerAt("ann@notexample.com"),
    reason: "not_found",
  },
  {
    name: "T5: a longer registrable name sharing the last two labels is not a match",
    principal: readerAt("ann@example.com.evil.example"),
    reason: "not_found",
  },
  {
    name: "T5: a trailing dot is not the same string",
    principal: readerAt(`ann@${LISTED_DOMAIN}.`),
    reason: "not_found",
    evaluatorOnly: true,
  },
  {
    name: "T5: a homoglyph domain is refused, not folded",
    /* Cyrillic `а` (U+0430) in place of the Latin one. It renders identically
       and is a different name; the normalizer refuses it as non-ASCII. */
    principal: readerAt("ann@exаmple.com"),
    reason: "not_found",
    evaluatorOnly: true,
  },
  {
    name: "T5: the punycode spelling of a homoglyph domain is its own domain",
    principal: readerAt("ann@xn--exmple-4nf.com"),
    reason: "not_found",
  },
  {
    name: "T5: an unnormalized upper-case address does not match",
    /* The principal contract stores a normalized address, so this spelling can
       only arrive from a caller that skipped normalisation. It must not match:
       silently lower-casing here would make the evaluator a second normalizer
       with its own opinion. */
    principal: readerAt(`Ann@${LISTED_DOMAIN.toUpperCase()}`),
    reason: "not_found",
    evaluatorOnly: true,
  },

  /* --- T7: verification is the boolean `true` -------------------------- */
  {
    name: "T7: an unverified address at a listed domain is told to verify",
    principal: readerAt(`ann@${LISTED_DOMAIN}`, false),
    reason: "email_unverified",
  },
  {
    name: 'T7: the string "true" is not verification',
    principal: readerAt(`ann@${LISTED_DOMAIN}`, "true"),
    reason: "email_unverified",
    evaluatorOnly: true,
  },
  {
    name: "T7: the number 1 is not verification",
    principal: readerAt(`ann@${LISTED_DOMAIN}`, 1),
    reason: "email_unverified",
    evaluatorOnly: true,
  },
  {
    name: "T7: an absent verification claim is not verification",
    /* Built by deletion rather than by passing `undefined`, because a helper's
       default parameter would fill it back in and the row would silently
       become "a verified reader reads". */
    principal: withoutVerification(readerAt(`ann@${LISTED_DOMAIN}`)),
    reason: "email_unverified",
    evaluatorOnly: true,
  },
  {
    name: "an unverified address at an unlisted domain learns nothing",
    /* The bound on the one disclosing refusal: a reader who did not match a
       listed domain is refused as if the document were not there, so
       `email_unverified` cannot be used to ask "does this document list X". */
    principal: readerAt("ann@stranger.example", false),
    reason: "not_found",
  },

  /* --- everything else ------------------------------------------------- */
  {
    name: "a stranger with a verified address at an unlisted domain is refused",
    principal: readerAt("ann@stranger.example"),
    reason: "not_found",
  },
  {
    name: "an account with no address is refused",
    principal: readerAt(null, false),
    reason: "not_found",
  },
  {
    name: "an empty list admits nobody but the owner",
    principal: readerAt(`ann@${LISTED_DOMAIN}`),
    allowedDomains: [],
    reason: "not_found",
  },
  {
    name: "a signed-out reader is asked to sign in",
    principal: null,
    reason: "session_required",
  },
]);

/**
 * The write table: what an owner may put on a document.
 *
 * `expect` is the normalized stored list for an accepted row, and `reason` is
 * the C3 code for a refused one. The accepted rows carry the normalisation this
 * ticket promises - trimming, lower-casing, de-duplication and a canonical order
 * - so the route suite is asserting the contract rather than the implementation.
 */
export const WRITE_CASES = Object.freeze([
  { name: "an empty list is how a policy is cleared", input: [], expect: [] },
  {
    name: "a plain list is stored as given, in canonical order",
    input: [SECOND_LISTED_DOMAIN, LISTED_DOMAIN],
    expect: [LISTED_DOMAIN, SECOND_LISTED_DOMAIN],
  },
  {
    name: "case and surrounding whitespace are normalized away",
    input: ["Example.COM", `  ${SECOND_LISTED_DOMAIN} `],
    expect: [LISTED_DOMAIN, SECOND_LISTED_DOMAIN],
  },
  {
    name: "two spellings of one domain are one entry",
    input: ["EXAMPLE.com", "example.com", " example.com "],
    expect: [LISTED_DOMAIN],
  },
  {
    name: "a deep subdomain is a domain in its own right",
    input: ["eu.corp.example.net"],
    expect: ["eu.corp.example.net"],
  },
  {
    name: "the denylist is exact, so a lookalike of one is listable",
    input: ["gmail.com.example.net"],
    expect: ["gmail.com.example.net"],
  },

  /* --- the public-mailbox denylist ------------------------------------- */
  ...[
    "gmail.com",
    "googlemail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "yahoo.com",
    "icloud.com",
    "proton.me",
    "pm.me",
    "aol.com",
    "mail.ru",
    "qq.com",
  ].map((domain) => ({
    name: `${domain} is a public mailbox and is refused`,
    input: [domain],
    reason: "public_mailbox_domain",
    domain,
  })),
  {
    name: "a public mailbox domain is caught however it is spelled",
    input: [" GMail.COM "],
    reason: "public_mailbox_domain",
    domain: "gmail.com",
  },
  {
    name: "one bad entry refuses the whole list",
    input: [LISTED_DOMAIN, "gmail.com"],
    reason: "public_mailbox_domain",
    domain: "gmail.com",
  },

  /* --- the grammar ------------------------------------------------------ */
  { name: "a single label has no registrable site", input: ["localhost"], reason: "invalid_domain" },
  { name: "a trailing dot is refused, not stripped", input: ["example.com."], reason: "invalid_domain" },
  { name: "a leading dot is not a wildcard", input: [".example.com"], reason: "invalid_domain" },
  { name: "a wildcard is not a domain", input: ["*.example.com"], reason: "invalid_domain" },
  { name: "a regular expression is not a domain", input: ["^.*example\\.com$"], reason: "invalid_domain" },
  { name: "an address is not a domain", input: ["ann@example.com"], reason: "invalid_domain" },
  { name: "a URL is not a domain", input: ["https://example.com"], reason: "invalid_domain" },
  { name: "a homoglyph domain is refused", input: ["exаmple.com"], reason: "invalid_domain" },
  { name: "an empty string is not a domain", input: [""], reason: "invalid_domain" },
  { name: "whitespace inside is not a domain", input: ["exa mple.com"], reason: "invalid_domain" },
  { name: "a hyphen may not end a label", input: ["example-.com"], reason: "invalid_domain" },
  { name: "a label may not be empty", input: ["example..com"], reason: "invalid_domain" },
  { name: "a non-string entry is not a domain", input: [42], reason: "invalid_domain" },
  { name: "a null entry is not a domain", input: [null], reason: "invalid_domain" },
  {
    name: "a label above 63 characters is not a domain",
    input: [`${"a".repeat(64)}.com`],
    reason: "invalid_domain",
  },
  {
    name: "a name above 253 characters is not a domain",
    input: [`${`${"a".repeat(60)}.`.repeat(5)}com`],
    reason: "invalid_domain",
  },

  /* --- the bound -------------------------------------------------------- */
  {
    name: "twenty domains is the limit and is accepted",
    input: Array.from({ length: 20 }, (_, index) => `d${index}.example.net`),
    expect: Array.from({ length: 20 }, (_, index) => `d${index}.example.net`).sort(),
  },
  {
    name: "twenty-one domains is over the limit",
    input: Array.from({ length: 21 }, (_, index) => `d${index}.example.net`),
    reason: "too_many_domains",
  },
  {
    name: "the limit counts entries, not distinct domains",
    /* Counted before de-duplication on purpose: otherwise a caller could spend
       the normalizer's time on any number of entries by repeating one. */
    input: Array.from({ length: 21 }, () => LISTED_DOMAIN),
    reason: "too_many_domains",
  },
]);
