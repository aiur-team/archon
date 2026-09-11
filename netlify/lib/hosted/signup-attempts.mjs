/**
 * The record of sign-in attempts that were turned away, and the two operations
 * on it: append one, and read the list back for the admin console.
 *
 * When the platform gate refuses a *verified* address - one Auth0 stood behind
 * but this deployment does not admit - the callback records the attempt here
 * before it lands the visitor on the request-access page. The point is the
 * operator's view: an admin can see who tried to sign in and was refused, even
 * if that person never went on to submit the request form.
 *
 * ## The recorded address is always the verified one
 *
 * Every value written here is `principalFromClaims`' `email`, normalised through
 * the deployment's one address grammar, and it is only ever written from the
 * callback after the ID token has been verified. Nothing a form submits reaches
 * this record. A row is therefore a statement that a particular verified
 * identity was refused, not that somebody typed a string into a box.
 *
 * ## Why one bounded record rather than a row per attempt
 *
 * The provider has no expiry and no conditional delete, so a key per attempt
 * would accumulate forever. One record holding a bounded, de-duplicated list -
 * an address, when it was first and last seen, and how many times - has a
 * footprint of exactly one key and answers the operator's question ("who has
 * been turned away, and how persistently") better than a raw log would. When the
 * list is full a new address evicts the least-recently-seen one, so the record
 * always holds the most recent cohort; an address already in the list is updated
 * in place and never evicts anything.
 *
 * ## It fails closed for admission, open for the audit
 *
 * The callback calls `recordSignupAttempt` inside a `try` and treats any throw
 * as "the attempt was not recorded" - it never turns a store outage into a
 * granted session. Losing one audit row is a smaller harm than a refused
 * visitor being admitted because the audit store was unreachable, and the row is
 * bookkeeping while the refusal is the security decision.
 */

import { HostedContractError } from "./contracts.mjs";
import { normalizeEmailOrNull } from "./email.mjs";
import { createRecordStore } from "./record-store.mjs";

/** The store key the record lives at. One key, beside the allowlist's. */
export const SIGNUP_ATTEMPTS_KEY = "access/signup-attempts";

/** The schema version. A record carrying any other is one this version refuses. */
export const SIGNUP_ATTEMPTS_SCHEMA_VERSION = 1;

/** The bounds on the stored list. A list, not a log. */
export const SIGNUP_ATTEMPTS_LIMITS = Object.freeze({
  /**
   * Distinct addresses the record holds. Enough to see a turned-away cohort,
   * small enough that the record stays one small blob the admin page renders in
   * one request. A new address past this limit evicts the oldest.
   */
  MAX_ENTRIES: 500,
});

/** The empty record a store with no attempts in it is read as. */
export const EMPTY_SIGNUP_ATTEMPTS = Object.freeze({
  v: SIGNUP_ATTEMPTS_SCHEMA_VERSION,
  attempts: Object.freeze([]),
});

function invalid(message, field) {
  return new HostedContractError("invalid_request", message, { field });
}

/** An ISO instant this record accepts, or `null`. */
function attemptTimestamp(value) {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * A stored attempts record, validated and canonicalised, or a typed refusal.
 *
 * Each address is held to the deployment's one address grammar in its normalised
 * spelling, because the stored form is what an operator reads and what a later
 * append de-duplicates against: a row in a spelling no identity provider asserts
 * would look like a distinct person on every refusal. A row this version cannot
 * interpret is a refusal rather than a silently dropped entry, so the caller
 * turns it into an outage rather than a shorter list than the truth.
 */
export function validateSignupAttemptsRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("the sign-up attempts record must be an object", "attempts");
  }
  if (value.v !== SIGNUP_ATTEMPTS_SCHEMA_VERSION) {
    throw invalid("the sign-up attempts record carries an unknown schema version", "attempts.v");
  }
  if (!Array.isArray(value.attempts)) {
    throw invalid("the sign-up attempts record must carry an attempts array", "attempts.attempts");
  }
  if (value.attempts.length > SIGNUP_ATTEMPTS_LIMITS.MAX_ENTRIES) {
    throw invalid(
      `the sign-up attempts record may hold at most ${SIGNUP_ATTEMPTS_LIMITS.MAX_ENTRIES} entries`,
      "attempts.attempts",
    );
  }

  const seen = new Map();
  for (const raw of value.attempts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid("a sign-up attempt must be an object", "attempts.attempts");
    }
    const email = normalizeEmailOrNull(raw.email);
    if (email === null) {
      throw invalid("a sign-up attempt must carry an email address", "attempts.attempts");
    }
    const firstAt = attemptTimestamp(raw.firstAt);
    const lastAt = attemptTimestamp(raw.lastAt);
    if (firstAt === null || lastAt === null) {
      throw invalid("a sign-up attempt must carry timestamps", "attempts.attempts");
    }
    const count = raw.count;
    if (!Number.isInteger(count) || count < 1 || count > Number.MAX_SAFE_INTEGER) {
      throw invalid("a sign-up attempt must carry a positive count", "attempts.attempts");
    }
    /* De-duplicated by address, keeping the widest window and the largest count,
       so a record that somehow held the same address twice reads as one row. */
    const held = seen.get(email);
    if (held === undefined) {
      seen.set(email, { email, firstAt, lastAt, count });
    } else {
      seen.set(email, {
        email,
        firstAt: firstAt < held.firstAt ? firstAt : held.firstAt,
        lastAt: lastAt > held.lastAt ? lastAt : held.lastAt,
        count: held.count + count,
      });
    }
  }

  return Object.freeze({
    v: SIGNUP_ATTEMPTS_SCHEMA_VERSION,
    attempts: Object.freeze([...seen.values()].sort(compareAttempts).map(Object.freeze)),
  });
}

/** Most-recently-seen first, then by address so the rendering is stable. */
export function compareAttempts(left, right) {
  if (left.lastAt !== right.lastAt) return left.lastAt < right.lastAt ? 1 : -1;
  return left.email < right.email ? -1 : left.email > right.email ? 1 : 0;
}

/** The attempts record store, over an injected provider. */
export function createSignupAttemptsStore({ getStore, name } = {}) {
  return createRecordStore({
    getStore,
    name,
    key: SIGNUP_ATTEMPTS_KEY,
    label: "sign-up attempts",
    validate: validateSignupAttemptsRecord,
  });
}

/**
 * Record one turned-away verified address.
 *
 * Idempotent per window in the useful sense: a repeated refusal of the same
 * address updates its `lastAt` and bumps its `count` rather than adding a row.
 * A brand-new address past the size limit evicts the least-recently-seen entry,
 * so the record always holds the most recent cohort and never grows unbounded.
 *
 * @param {{email: string, now?: () => Date}} attempt
 * @param {{store: object}} deps
 * @returns {Promise<{recorded: boolean, email: string}>}
 * @throws {HostedContractError} `invalid_request` for an unusable address, or
 *   `unavailable` when the store could not be read or written.
 */
export async function recordSignupAttempt({ email, now = () => new Date() }, { store }) {
  const normalized = normalizeEmailOrNull(email);
  if (normalized === null) {
    throw invalid("a sign-up attempt must carry an email address", "email");
  }
  const at = now().toISOString();

  const result = await store.mutate((current) => {
    const attempts = current === null ? [] : current.attempts;
    const index = attempts.findIndex((held) => held.email === normalized);
    if (index !== -1) {
      const held = attempts[index];
      const updated = {
        email: normalized,
        firstAt: held.firstAt,
        lastAt: at,
        count: held.count + 1,
      };
      const next = [...attempts];
      next[index] = updated;
      return { v: SIGNUP_ATTEMPTS_SCHEMA_VERSION, attempts: next };
    }

    let kept = attempts;
    if (kept.length >= SIGNUP_ATTEMPTS_LIMITS.MAX_ENTRIES) {
      /* Evict the least-recently-seen so a full record holds the newest cohort.
         Unlike the rate counter, this is an audit list and not a budget, so
         keeping the most recent addresses is the useful behaviour rather than a
         way to buy a fresh allowance. */
      let oldest = 0;
      for (let i = 1; i < kept.length; i += 1) {
        if (kept[i].lastAt < kept[oldest].lastAt) oldest = i;
      }
      kept = kept.filter((_, i) => i !== oldest);
    }
    return {
      v: SIGNUP_ATTEMPTS_SCHEMA_VERSION,
      attempts: [...kept, { email: normalized, firstAt: at, lastAt: at, count: 1 }],
    };
  });
  return { recorded: result.changed, email: normalized };
}

/**
 * The attempts, or the empty list when nothing has been recorded yet.
 *
 * An absent key is genuinely the empty list. A store that could not be read is
 * not - `read` throws `unavailable` for that, which the admin route surfaces as
 * an outage rather than as "nobody has been turned away".
 */
export async function readSignupAttempts(store) {
  const current = await store.read();
  return current === null ? EMPTY_SIGNUP_ATTEMPTS.attempts : current.record.attempts;
}
