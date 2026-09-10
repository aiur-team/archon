/**
 * The one domain-access evaluator in this repository.
 *
 * A hosted document is owner-only until its owner lists email domains on it.
 * From then on a signed-in reader holding a *verified* address at a listed
 * domain reads it, and everybody else is refused without learning it exists.
 * This module makes that decision, and it makes the matching decision at write
 * time about which domains an owner may list at all.
 *
 * ## Why one module rather than one per document kind
 *
 * ACN-008 applies the same rule to collaboration documents. Two evaluators
 * would be two answers to "is `ann@partner.example.org` allowed here", and the
 * one that drifts is the one nobody is reading during a review. So this module
 * takes plain data - a record-shaped object, a principal-shaped object, an
 * optional already-resolved explicit role - performs no I/O, imports no
 * storage, and is therefore callable from either tree.
 *
 * That constraint is why the errors here are a local class rather than
 * `HostedContractError`: `contracts.mjs` reaches `node:crypto` and `Buffer`,
 * and requiring the collaboration tree to link those to ask a question about a
 * string would make this seam expensive enough to copy instead. Each caller
 * translates `DomainAccessError` into its own wire vocabulary.
 *
 * ## The decision order, and why it is this order
 *
 * Owner, then explicit grant or live invitation, then the domain list, then
 * refuse.
 *
 * **The owner is admitted before any email logic runs** - before the verified
 * check, and even when `email` is `null`. The owner's claim is the stored
 * `ownerAccountId`, which was written when they approved the publication; their
 * address is recovery metadata that was never the key. An identity provider
 * that stops asserting `email_verified`, or a person who removes the address
 * from their account, must not thereby be locked out of a document they own.
 *
 * **`emailVerified` must be the boolean `true`.** The string `"true"` is not
 * true here, and an absent claim is not true here. An unverified address is a
 * claim the reader typed, so treating a truthy-looking value as verification is
 * the whole T7 threat in one `if`.
 *
 * **Matching is full-string equality on the normalized domain.** Never
 * `endsWith`, never a suffix, never a subdomain expansion. The site-wide
 * organisation rule in `netlify/lib/identity.mjs` is a suffix test and is the
 * anti-pattern this rule is written against: with `endsWith`, listing
 * `example.com` admits `notexample.com`, and listing `.example.com` admits
 * every subdomain anybody can register under a shared suffix.
 *
 * ## Nothing is stored when a domain admits a reader
 *
 * The decision is recomputed from the session's current verified email on every
 * request. A grant written at admission time would outlive the fact that
 * produced it: an employee who leaves and loses the address would keep the
 * grant. A session lasts at most 24 hours, so a changed or removed address
 * costs access within a day, which is R21 and is the reason there is no
 * bookkeeping here at all.
 *
 * ## What a refusal is allowed to say
 *
 * Three reasons leave this module. `session_required` for a caller with no
 * principal, which discloses nothing because every id answers it the same way.
 * `not_found` for everything else, which is the same answer a document that
 * does not exist gives.
 *
 * `email_unverified` is the third, and it is the one refusal that tells the
 * caller something. Be precise about what: it is returned only when the domain
 * of the address on the principal matches this document's list - and at that
 * point the address is, by definition, one the provider has *not* verified. So
 * the domain is **claimed, not held**. A caller who already has a document id
 * and is willing to sign up with an address at a guessed domain can therefore
 * distinguish `403` from `404` and learn that the document exists and lists
 * that domain, one guess at a time, up to the twenty entries a list may hold.
 *
 * That is the accepted cost of the message, not an oversight. The alternative -
 * checking `emailVerified` before the domain at all - renders every such reader
 * a flat `not_found`, which a person with a perfectly good corporate address
 * reads as a broken link and escalates to the document's owner rather than to
 * their identity provider. The disclosure is bounded by needing an unguessable
 * 128-bit document id first, and it never reaches a document whose list the
 * caller did not name. Do not widen it further: returning this reason for a
 * document that does not list the domain, or for one that does not exist, would
 * turn it into an oracle over the whole id space rather than over one id the
 * caller already had.
 */

import { emailDomain, normalizeDomainOrNull } from "./email.mjs";

export { emailDomain };

/**
 * The mailbox providers a domain list may not name.
 *
 * Listing one is not a policy choice, it is an accident: `gmail.com` on a
 * document's allow-list admits every person on earth who can sign up for an
 * address, which is the same thing as publishing the document while believing
 * it is private. The list is refused at *write* time rather than at read time so
 * the owner is told at the moment they are wrong, and so a document's stored
 * list is never a thing that looks private and is not.
 *
 * A code constant rather than configuration, because it is a fact about the
 * world rather than an operator's preference, and sorted so that a diff adding
 * one is a one-line diff. The escape hatch is site-wide and deliberately blunt:
 * `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS=true` for an operator who runs a deployment
 * where these really are corporate mailboxes.
 *
 * **This list is exact, and it is not every free provider.** Membership is
 * `includes`, like the matching rule itself, so `hotmail.co.uk`, `me.com`,
 * `gmx.de`, `yandex.com` and any number of others are listable today - the
 * twelve names here are the ones ACN-007 froze, not a claim to completeness.
 * Read the guard as "the most common way to publish a document by accident is
 * caught", never as "a domain the guard accepted is therefore a private one".
 * Widening it is a contract change, because a domain that stops being listable
 * strands owners who already listed it.
 */
export const PUBLIC_MAILBOX_DOMAINS = Object.freeze([
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

/** The bounds on a stored list. A list, not a policy language. */
export const DOMAIN_LIST_LIMITS = Object.freeze({
  /** Enough for a company and its partners; small enough to read in a page. */
  MAX_DOMAINS: 20,
  /** RFC 1035's name length, restated here so a caller need not import two modules. */
  MAX_DOMAIN_LENGTH: 253,
});

/** The roles a hosted document has. There is no role vocabulary beyond these. */
export const HOSTED_ROLES = Object.freeze(["owner", "reader"]);

/** The refusal reasons `evaluateAccess` may answer with. */
export const REFUSAL_REASONS = Object.freeze(["session_required", "email_unverified", "not_found"]);

/**
 * A rejected domain list, naming the reason and the value that caused it.
 *
 * `domain` is the offending entry and is safe to show the owner: they typed it,
 * it is at most 253 characters, and it passed an ASCII grammar or is being
 * reported *because* it did not - in which case the caller bounds it before it
 * reaches a wire message.
 */
export class DomainAccessError extends Error {
  constructor(reason, message, { domain = null } = {}) {
    super(message);
    this.name = "DomainAccessError";
    this.reason = reason;
    this.domain = domain;
  }
}

/**
 * Whether a normalized domain is a public mailbox provider.
 *
 * Exact membership, like the matching rule itself. `mail.google.com` is not
 * `gmail.com` and is not on this list; a caller who wants that relationship is
 * asking for a suffix rule, which this module does not have.
 *
 * @param {unknown} domain a domain already through `normalizeDomainOrNull`
 * @returns {boolean}
 */
export function isPublicMailbox(domain) {
  return typeof domain === "string" && PUBLIC_MAILBOX_DOMAINS.includes(domain);
}

/**
 * The normalized, sorted, de-duplicated domain list, or a `DomainAccessError`.
 *
 * Sorted because the stored form is compared as a value: the record goes
 * through a compare-and-set against a canonical JSON rendering, and a list whose
 * order followed whatever the owner typed would make two identical policies two
 * different records. Order carries no meaning here - the matching rule is
 * membership - so fixing it costs nothing and buys a stable diff.
 *
 * The empty array is legal and is how a list is cleared.
 *
 * @param {unknown} list
 * @param {{allowPublicMailboxes?: boolean}} [options]
 * @returns {string[]} a fresh, sorted array
 * @throws {DomainAccessError}
 */
export function normalizeDomainList(list, { allowPublicMailboxes = false } = {}) {
  if (!Array.isArray(list)) {
    throw new DomainAccessError("invalid_domain", "allowedDomains must be an array of domains");
  }
  /* Counted before normalisation, so a caller cannot spend this function's time
     on a thousand entries by making most of them duplicates. */
  if (list.length > DOMAIN_LIST_LIMITS.MAX_DOMAINS) {
    throw new DomainAccessError(
      "too_many_domains",
      `allowedDomains may name at most ${DOMAIN_LIST_LIMITS.MAX_DOMAINS} domains`,
    );
  }

  const seen = new Set();
  for (const entry of list) {
    const domain = normalizeDomainOrNull(entry);
    if (domain === null) {
      const named = boundedForMessage(entry);
      throw new DomainAccessError(
        "invalid_domain",
        named === null
          ? "allowedDomains holds a value that is not a domain"
          : `${named} is not a domain`,
        { domain: named },
      );
    }
    /* The boolean, exactly, for the same reason `emailVerified` is: this option
       comes from an environment variable, and a truthy string that read as "on"
       would open every document to a mailbox provider. */
    if (allowPublicMailboxes !== true && isPublicMailbox(domain)) {
      throw new DomainAccessError(
        "public_mailbox_domain",
        `${domain} is a public mailbox provider, so listing it would admit anyone.`,
        { domain },
      );
    }
    seen.add(domain);
  }
  return [...seen].sort();
}

/**
 * A rejected entry, rendered short and printable enough to name back.
 *
 * The entry that reaches here is the one the grammar refused, so it may be a
 * number, an object, or 4000 characters of anything. It is the owner's own
 * input and naming it is the difference between a usable message and "one of
 * your domains is wrong", but it reaches an HTTP body, so it is bounded and
 * stripped to characters a domain could legitimately contain first.
 */
function boundedForMessage(value) {
  if (typeof value !== "string") return null;
  const printable = [...value].filter((c) => /[A-Za-z0-9.-]/.test(c)).join("");
  return printable === "" ? null : printable.slice(0, DOMAIN_LIST_LIMITS.MAX_DOMAIN_LENGTH);
}

/**
 * The list stored on a record, defaulted.
 *
 * A record written before this field existed has no `allowedDomains`, and the
 * honest reading of that absence is "no domains are listed" rather than "this
 * record is broken". Anything that is not an array of strings is also read as
 * the empty list: this function is the last thing standing between stored data
 * and an access decision, and the fail-closed answer to "I cannot tell what
 * this list says" is to admit nobody by it.
 */
function storedDomains(record) {
  const list = record?.allowedDomains;
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => typeof entry === "string");
}

/**
 * The access decision for one principal against one record.
 *
 * @param {{
 *   record: object | null,
 *   principal: object | null,
 *   explicitRole?: string | null,
 * }} input
 *   `record` is a publication-shaped object; `principal` is a
 *   `validatePrincipal` result or `null` for a signed-out caller; `explicitRole`
 *   is a role a *collaboration* document already resolved from a grant or a live
 *   invitation, and is always `null` for a hosted publication, which has no
 *   per-person roles.
 * @returns {Readonly<{allowed: boolean, role: string | null, reason: string | null}>}
 */
export function evaluateAccess({ record = null, principal = null, explicitRole = null } = {}) {
  /* First, because a signed-out caller gets this answer for every id and so it
     tells them nothing - and because the checks below would otherwise have to
     each handle a null principal. */
  if (principal === null || principal === undefined) return refuse("session_required");

  if (record === null || record === undefined) return refuse("not_found");
  /* A record that is not `complete` is not a document yet. Its owner does not
     get an early read of it either: the bytes are not there. */
  if (record.state !== "complete") return refuse("not_found");

  /* The owner, before any email logic. See the module note: their claim is the
     stored account id, and an identity provider that stops asserting a verified
     address must not lock them out of their own document. */
  if (
    typeof record.ownerAccountId === "string" &&
    record.ownerAccountId === principal.accountId
  ) {
    return admit("owner");
  }

  /* The ACN-008 seam. A hosted publication passes nothing here; a collaboration
     document passes the role it already resolved from a stored grant or a live
     invitation, and that role outranks the domain list because it was decided
     about this person rather than about a class of people. */
  if (typeof explicitRole === "string" && explicitRole !== "" && explicitRole !== "none") {
    return admit(explicitRole);
  }

  const allowed = storedDomains(record);
  if (allowed.length === 0) return refuse("not_found");

  /* `principal.email` is already normalized - `validatePrincipal` refuses a
     stored address that is not - and `emailDomain` re-checks rather than
     re-normalises, so a caller that skipped normalisation gets `null` here
     instead of a domain that a later `===` would silently fail to match. */
  const domain = emailDomain(principal.email);
  if (domain === null) return refuse("not_found");
  if (!allowed.includes(domain)) return refuse("not_found");

  /* The boolean, exactly. `"true"`, `1` and an absent claim are all unverified,
     and an unverified address is a string the reader chose. */
  if (principal.emailVerified !== true) return refuse("email_unverified");

  return admit("reader");
}

function admit(role) {
  return Object.freeze({ allowed: true, role, reason: null });
}

function refuse(reason) {
  return Object.freeze({ allowed: false, role: null, reason });
}
