/**
 * The one address grammar this repository has.
 *
 * There were two trees and one rule, which is the arrangement that produces two
 * rules. `netlify/lib/access.mjs` owned the collaboration normalizer and the
 * hosted tree could not call it: rule H0 in `scripts/check-function-modules.mjs`
 * refuses a relative import out of `netlify/lib/hosted/`, and names
 * `import ... from "../access.mjs"` as the exact import it exists to stop. So
 * the grammar moves here, inside the hosted subtree, and the collaboration
 * module calls *in*. That direction is the one the deploy boundary allows and
 * it is also the direction ACN-008 already takes to reach `evaluateAccess`.
 *
 * ## Why this module imports nothing at all
 *
 * Two callers make that a requirement rather than a preference.
 * `netlify/edge-functions/gate.ts` reaches `netlify/lib/access.mjs` from Deno,
 * where a `node:` builtin is not free; and `domain-access.mjs` is the evaluator
 * ACN-008 imports into the collaboration tree, which the ticket requires to be
 * plain-data and I/O-free. A module with no imports satisfies both without
 * anyone having to check.
 *
 * ## Why the failure is `null` rather than a throw
 *
 * The two callers want opposite things. `access.mjs` throws `invalid-email`,
 * the hosted validators throw a `HostedContractError`, and the domain list
 * needs the offending value back so it can name it. A shared function that
 * threw would have to invent a third error type for both to catch and
 * translate, so it returns the answer instead and each caller raises its own.
 *
 * ## What the grammar refuses, and why each one is on the list
 *
 * Bounded ASCII, lower-cased, with a domain of at least two DNS labels. The
 * refusals are the T5/T6 threat rows, not defensive habit:
 *
 *  - **Any non-ASCII scalar.** This is the homoglyph defence and it is the
 *    reason the check is on the whole string rather than on the domain: a
 *    Cyrillic `а` in `exаmple.com` is a different domain that reads identically,
 *    and no amount of exact matching downstream helps if both spellings get
 *    here.
 *  - **A trailing dot.** `example.com.` is the same name to DNS and a different
 *    string to `===`. It splits to a final empty label, which no label pattern
 *    matches, so it is refused rather than silently stripped - stripping would
 *    make this function a normalizer of two spellings into one, and the whole
 *    design is that there is one spelling.
 *  - **A second `@`.** The domain is the substring after *the* `@`, and a value
 *    with two of them has no single answer to that question.
 *  - **A single-label domain.** `ann@localhost` has no registrable site to
 *    compare and is never an address a domain list should admit.
 *
 * Case folding is a plain `toLowerCase()` on an already-ASCII string, which is
 * therefore a per-character map with no locale in it. `İ` would fold to two
 * scalars in Turkish; it is refused as non-ASCII one line earlier.
 */

/** The widest address, matching C1's `EMAIL_MAX_LENGTH` and RFC 5321's path. */
export const EMAIL_MAX_LENGTH = 254;

/** The widest domain, per RFC 1035's 255-octet name minus the length framing. */
export const DOMAIN_MAX_LENGTH = 253;

/** ASCII whitespace at either end, which is presentation rather than address. */
const EDGE_WHITESPACE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;

/** The unquoted RFC 5322 atom set, lower-cased. A quoted local part is refused. */
const LOCAL_PATTERN = /^[a-z0-9.!#$%&'*+=?^_`{|}~-]{1,64}$/;

/** One DNS label: alphanumeric at both ends, hyphens inside, at most 63. */
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Any scalar outside 7-bit ASCII. The homoglyph and punycode-payload gate. */
const NON_ASCII = /[^\x00-\x7f]/;

/**
 * The normalized address, or `null`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeEmailOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(EDGE_WHITESPACE, "");
  if (NON_ASCII.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0 || normalized.length > EMAIL_MAX_LENGTH) return null;

  const at = normalized.indexOf("@");
  if (at === -1 || normalized.indexOf("@", at + 1) !== -1) return null;
  if (!LOCAL_PATTERN.test(normalized.slice(0, at))) return null;

  /* The domain must already *be* its own normalized form, not merely normalize
     to something legal. `normalizeDomainOrNull` trims its own input, so asking
     it only "is this a domain?" would accept `ann@ example.com` - the domain
     trims to `example.com` and passes - and then return the address with the
     space still in it. That is a wider grammar than the one this function
     replaced, and the damage is silent rather than loud: a grant stored under
     `ann@ example.com` never matches the `ann@example.com` an identity provider
     asserts, so an owner adds a collaborator who simply never gets in, and a
     `DOC_OWNERS` entry with a stray space locks the seed owner out of their own
     document instead of failing as invalid configuration. */
  const domain = normalized.slice(at + 1);
  if (normalizeDomainOrNull(domain) !== domain) return null;
  return normalized;
}

/**
 * The normalized domain, or `null`.
 *
 * The same grammar as an address's right-hand side, exported separately because
 * an owner's allow-list entry is a domain that was never part of an address and
 * would otherwise have to be checked by pasting a local part onto it.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeDomainOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(EDGE_WHITESPACE, "");
  if (NON_ASCII.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  if (normalized.length === 0 || normalized.length > DOMAIN_MAX_LENGTH) return null;
  const labels = normalized.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL_PATTERN.test(label))) return null;
  return normalized;
}

/**
 * The domain of an **already-normalized** address, or `null`.
 *
 * The contract word is deliberate: this does not normalize, because a function
 * that both normalized and extracted would let a caller skip the normalizer and
 * still get a plausible-looking answer for `ANN@Example.COM`. It re-derives the
 * `@` position and re-checks the domain, so a caller that did skip gets `null`
 * rather than an unnormalized domain that a later `===` would silently miss.
 *
 * @param {unknown} email
 * @returns {string | null}
 */
export function emailDomain(email) {
  if (typeof email !== "string") return null;
  const at = email.indexOf("@");
  if (at === -1 || email.indexOf("@", at + 1) !== -1) return null;
  const domain = email.slice(at + 1);
  return normalizeDomainOrNull(domain) === domain ? domain : null;
}
