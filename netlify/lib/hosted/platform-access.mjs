/**
 * Who may use this deployment at all, and who administers it.
 *
 * The per-document rule already has an evaluator: `domain-access.mjs` decides
 * whether a signed-in reader may open one document. This module answers the
 * question one level above that - *may this person be a user of the platform in
 * the first place* - and it exists because the two answers have different
 * inputs, different lifetimes and different failure modes, and a single function
 * that returned both would have to fail closed on the strictest of them.
 *
 * Like `domain-access.mjs` it is plain data in, plain data out: no storage, no
 * configuration reading, no I/O and one import, so the store adapter, the HTTP
 * routes and the tests all reason about the same function.
 *
 * ## Admin is an operator identity, not a role
 *
 * Operator decision 3: admins are seeded from `ARCHON_ADMINS` and there is no
 * path that grants the capability to anybody else. That is the whole design and
 * it is worth being explicit about why it is not a `resolveRole` extension - a
 * grantable admin needs a grant record, a revocation path, an audit of both, and
 * a rule for what happens when the last admin revokes themselves. A seeded
 * identity has none of those, and the recovery story for "we lost the admin" is
 * an environment variable an operator already controls.
 *
 * An admin is admitted by a **verified** address, exactly as `evaluateAccess`
 * admits a domain reader. An unverified address is a string the visitor typed;
 * treating it as an admin claim would make the whole capability a matter of
 * typing the right thing into an identity provider's sign-up form. Note that
 * this is deliberately *stricter* than the owner rule one module over, which
 * admits on a stored `ownerAccountId` before any email logic: an owner's claim
 * is a key that was written when they approved their publication, while an
 * admin's claim is an address an operator typed into configuration, so the
 * address is the only thing there is to check and it has to be one the provider
 * stands behind.
 *
 * ## The allowlist is additive to sign-in, and orthogonal to the domain lists
 *
 * Operator decisions 1 and 2. An entry - an individual address or a whole domain
 * - says its holder may sign in and be a user. It says nothing about which
 * documents they may open: per-document sharing still governs that, so an
 * allowlisted address with no document shared to it signs in and sees nothing,
 * which is the correct outcome and not a bug.
 *
 * It is also **not** a per-document domain list and is not held to
 * `PUBLIC_MAILBOX_DOMAINS`. That refusal exists because listing `gmail.com` on a
 * *document* admits everyone on earth to that document. Listing an individual
 * `someone@gmail.com` here admits one mailbox to the platform, which is the
 * thing the ticket is for, so `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` stays `false`
 * and is not consulted from this module at all. A whole-domain entry here is a
 * deliberate operator act with the same blast radius as the env seed it can also
 * come from, and the admin page says so at the point of the write.
 *
 * ## Why enforcement is a separate flag rather than "a non-empty list is a gate"
 *
 * `enforced` comes from `ARCHON_PLATFORM_ALLOWLIST_ENFORCED` and is off unless
 * an operator spells it. The tempting alternative - treat a non-empty list as
 * the gate and an empty one as "no gate" - makes the platform's admission rule
 * change *silently*, in both directions: the deploy that first seeds one address
 * locks out every other identity that could sign in the day before, and an admin
 * who removes the last entry from the page reopens the platform to the world
 * without being told that is what the button did. An explicit flag makes turning
 * the gate on an operator's decision and makes an empty enforced list mean
 * exactly what it says, which is "nobody but an admin".
 */

import { emailDomain, normalizeDomainOrNull, normalizeEmailOrNull } from "./email.mjs";

/** The bounds on the stored list. A list, not a policy language. */
export const ALLOWLIST_LIMITS = Object.freeze({
  /**
   * Enough for an early-access cohort, small enough that the admin page renders
   * it in one request and the record stays a single small blob. A limit exists
   * because the record is read, rewritten and compare-and-set on every admin
   * edit, and an unbounded list turns each edit into an unbounded write.
   */
  MAX_ENTRIES: 500,
  /** The widest entry either kind can be: an address is the longer of the two. */
  MAX_ENTRY_LENGTH: 254,
});

/** The two things an allowlist entry can be. */
export const ENTRY_KINDS = Object.freeze(["email", "domain"]);

/**
 * Every reason `evaluatePlatformAccess` may refuse with.
 *
 * Exported so a caller can exhaust the set rather than guess at it, and pinned
 * against the evaluator by the test table for the same reason the domain
 * evaluator's is: a hand-kept copy of a function's outputs drifts the first time
 * somebody adds a fourth reason.
 */
export const PLATFORM_REFUSAL_REASONS = Object.freeze([
  "session_required",
  "email_unverified",
  "not_allowlisted",
  "allowlist_unavailable",
]);

/** A rejected entry or admin address, naming the reason and the offending value. */
export class PlatformAccessError extends Error {
  constructor(reason, message, { entry = null } = {}) {
    super(message);
    this.name = "PlatformAccessError";
    this.reason = reason;
    this.entry = entry;
  }
}

/**
 * One allowlist entry, normalised, or `null`.
 *
 * An address first, then a domain. The order is not a preference: `@` is legal
 * in neither domain grammar, so the two are disjoint and the order only decides
 * which check runs first. What matters is that both spellings go through the
 * *same* normalisers the rest of the deployment uses - a homoglyph domain, a
 * trailing dot and an uppercase address are all refused here because they are
 * refused in `email.mjs`, and an entry stored in a spelling no identity
 * provider will ever assert is an entry that admits nobody while looking like it
 * admits someone.
 *
 * @param {unknown} value
 * @returns {Readonly<{kind: "email" | "domain", value: string}> | null}
 */
export function normalizeAllowlistEntryOrNull(value) {
  if (typeof value !== "string" || value.length > ALLOWLIST_LIMITS.MAX_ENTRY_LENGTH * 2) return null;
  const email = normalizeEmailOrNull(value);
  if (email !== null) return Object.freeze({ kind: "email", value: email });
  const domain = normalizeDomainOrNull(value);
  if (domain !== null) return Object.freeze({ kind: "domain", value: domain });
  return null;
}

/**
 * One allowlist entry, normalised, or a typed refusal naming what was wrong.
 *
 * The admin page needs the offending text back to render a usable message, and
 * the value is the admin's own input, so it is echoed - bounded and stripped to
 * the characters either grammar could legitimately contain first, because it
 * reaches an HTTP body.
 *
 * @throws {PlatformAccessError}
 */
export function normalizeAllowlistEntry(value) {
  const entry = normalizeAllowlistEntryOrNull(value);
  if (entry !== null) return entry;
  const named = boundedForMessage(value);
  throw new PlatformAccessError(
    "invalid_entry",
    named === null
      ? "an allowlist entry must be an email address or a domain"
      : `${named} is neither an email address nor a domain`,
    { entry: named },
  );
}

/** A rejected entry, rendered short and printable enough to name back. */
function boundedForMessage(value) {
  if (typeof value !== "string") return null;
  const printable = [...value].filter((c) => /[A-Za-z0-9.@!#$%&'*+=?^_`{|}~-]/.test(c)).join("");
  return printable === "" ? null : printable.slice(0, ALLOWLIST_LIMITS.MAX_ENTRY_LENGTH);
}

/**
 * A list of entries, normalised, de-duplicated and sorted, or a typed refusal.
 *
 * Sorted for the reason `normalizeDomainList` is sorted: the record is written
 * through a compare-and-set against a canonical rendering, so a list whose order
 * followed whatever an admin typed would make two identical policies two
 * different records. Sorted by value within kind, so the rendered page groups
 * domains and addresses without the caller re-sorting.
 *
 * @param {unknown} list
 * @returns {Readonly<{kind: string, value: string}>[]}
 * @throws {PlatformAccessError}
 */
export function normalizeAllowlist(list) {
  if (!Array.isArray(list)) {
    throw new PlatformAccessError("invalid_entry", "the allowlist must be an array of entries");
  }
  /* Counted before normalisation, so a caller cannot spend this function's time
     on ten thousand entries by making most of them duplicates. */
  if (list.length > ALLOWLIST_LIMITS.MAX_ENTRIES) {
    throw new PlatformAccessError(
      "too_many_entries",
      `the allowlist may hold at most ${ALLOWLIST_LIMITS.MAX_ENTRIES} entries`,
    );
  }
  const seen = new Map();
  for (const value of list) {
    const entry = normalizeAllowlistEntry(value);
    seen.set(`${entry.kind}:${entry.value}`, entry);
  }
  return [...seen.values()].sort(compareEntries);
}

/** Domains first, then addresses, each alphabetically. A stable rendering. */
export function compareEntries(left, right) {
  if (left.kind !== right.kind) return left.kind === "domain" ? -1 : 1;
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

/**
 * Whether a principal holds the admin capability.
 *
 * A verified address matching a seeded one exactly. `admins` is the normalised,
 * frozen list `readHostedConfig` produced, so no normalisation happens here and
 * a caller that passed raw environment text gets `false` rather than a match
 * against an unnormalised string.
 *
 * @param {object | null} principal
 * @param {readonly string[]} admins
 * @returns {boolean}
 */
export function isAdmin(principal, admins) {
  if (principal === null || principal === undefined) return false;
  if (!Array.isArray(admins) || admins.length === 0) return false;
  /* The boolean, exactly. `"true"`, `1` and an absent claim are all unverified,
     and an unverified address is a string the visitor chose. */
  if (principal.emailVerified !== true) return false;
  return typeof principal.email === "string" && admins.includes(principal.email);
}

/**
 * The platform-access decision for one principal.
 *
 * @param {{
 *   principal: object | null,
 *   admins?: readonly string[],
 *   allowlist?: readonly {kind: string, value: string}[] | null,
 *   enforced?: boolean,
 * }} input
 *   `allowlist` is the resolved union of the env seed and the stored list, or
 *   `null` when the store could not be read. `null` is not the empty list: an
 *   empty list is a policy that admits nobody, and a `null` is a fact we do not
 *   know, which under an enforced gate refuses with its own retryable reason so
 *   an outage is never reported to a visitor as "you are not on the list".
 * @returns {Readonly<{allowed: boolean, admin: boolean, reason: string | null}>}
 */
export function evaluatePlatformAccess({
  principal = null,
  admins = [],
  allowlist = null,
  enforced = false,
} = {}) {
  if (principal === null || principal === undefined) return refuse("session_required");

  /* An admin is admitted before the gate is consulted, and before any store
     read has to have succeeded. That ordering is the recovery path: an operator
     whose allowlist store is unreadable, or who has enforced an empty list, can
     still reach `/admin` and fix it. */
  if (isAdmin(principal, admins)) return Object.freeze({ allowed: true, admin: true, reason: null });

  /* The flag, exactly. Off unless an operator spelled it, so a deployment that
     has never heard of this feature keeps the admission rule it had. */
  if (enforced !== true) return Object.freeze({ allowed: true, admin: false, reason: null });

  if (allowlist === null || allowlist === undefined) return refuse("allowlist_unavailable");

  /* Under the gate a verified address is required before the list is consulted,
     which is the opposite of the ordering in `evaluateAccess` and deliberately
     so. There, answering `email_unverified` for a listed domain is a usability
     choice paid for with a bounded disclosure about one document the caller
     already had an id for. Here the list *is* the membership record for the
     whole deployment, so checking it first would turn this route into an oracle
     over it: a stranger could learn whether any address or domain is on the
     platform allowlist by signing up with it. Verification first makes every
     unverified answer identical regardless of the list. */
  if (principal.emailVerified !== true) return refuse("email_unverified");

  const email = normalizeEmailOrNull(principal.email);
  if (email === null) return refuse("not_allowlisted");
  const domain = emailDomain(email);

  for (const entry of allowlist) {
    if (entry === null || typeof entry !== "object") continue;
    /* Full-string equality on both kinds, never `endsWith`. Listing
       `example.com` must not admit `notexample.com`, and it must not admit a
       subdomain either: a shared suffix is a domain anybody can register under. */
    if (entry.kind === "email" && entry.value === email) return admitted();
    if (entry.kind === "domain" && domain !== null && entry.value === domain) return admitted();
  }
  return refuse("not_allowlisted");
}

function admitted() {
  return Object.freeze({ allowed: true, admin: false, reason: null });
}

function refuse(reason) {
  return Object.freeze({ allowed: false, admin: false, reason });
}
