/**
 * The mutable platform allowlist: the stored record, its audit, and the two
 * edits an admin can make to it.
 *
 * `platform-access.mjs` decides what an allowlist *means*; this module is where
 * one lives. The split is the same one `domain-access.mjs` keeps from
 * `publications.mjs`: the evaluator takes plain data and performs no I/O, so the
 * rule is testable without a store and cannot acquire a storage dependency by
 * accident.
 *
 * ## Why the list is in the store and not only in the environment
 *
 * Part 3 of the ticket is an admin editing it at runtime, and an environment
 * variable cannot be edited at runtime: changing one is a redeploy, which the
 * acceptance criteria rule out ("changes take effect without a redeploy"). So
 * the store holds the list and the environment holds a *seed*, and the two are
 * unioned on read.
 *
 * A seeded entry is deliberately **not removable from the admin page**. The page
 * cannot write to the environment, so a removal it accepted would be undone by
 * the next request reading the seed again - a control that appears to work and
 * does not. `removeEntry` refuses it by name and says where the entry actually
 * lives.
 *
 * ## What the audit is, and what it is not
 *
 * Each stored entry carries `addedBy` - the admin address that wrote it - and
 * `addedAt`. That is the "who/when if cheap" the ticket asks for, and it is
 * cheap because it rides on the record that has to be written anyway.
 *
 * It is not a log. A removal deletes the entry and its provenance with it, so
 * this record answers "who admitted this address" and never "who removed one".
 * A deployment that needs the second answer needs an append-only log, which is a
 * different record with a different retention story; saying so here is cheaper
 * than letting somebody discover it during an incident.
 */

import { HostedContractError } from "./contracts.mjs";
import { normalizeEmailOrNull } from "./email.mjs";
import {
  ALLOWLIST_LIMITS,
  PlatformAccessError,
  compareEntries,
  normalizeAllowlistEntry,
} from "./platform-access.mjs";
import { createRecordStore } from "./record-store.mjs";

/**
 * The store key. A namespace nothing else shares, beside `publications/` in the
 * same site-wide store, so one census lists both.
 */
export const ALLOWLIST_KEY = "access/platform-allowlist";

/** The schema version. A record carrying any other is one this version refuses. */
export const ALLOWLIST_SCHEMA_VERSION = 1;

/** The record a store with no allowlist in it is read as. */
export const EMPTY_ALLOWLIST = Object.freeze({
  v: ALLOWLIST_SCHEMA_VERSION,
  entries: Object.freeze([]),
});

function invalid(message, field) {
  return new HostedContractError("invalid_request", message, { field });
}

/**
 * A stored allowlist record, validated and canonicalised, or a typed refusal.
 *
 * Held to the same grammar an admin's input is held to, and in the same
 * normalised spelling, because the stored form is what an access decision
 * compares against: an entry that reached storage in a spelling no identity
 * provider will assert is an entry that admits nobody while looking like it
 * admits someone. Unknown fields are dropped rather than preserved, so the
 * record this function returns is the whole record and a later reader cannot
 * find a field nothing wrote.
 */
export function validateAllowlistRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("the allowlist record must be an object", "allowlist");
  }
  if (value.v !== ALLOWLIST_SCHEMA_VERSION) {
    throw invalid("the allowlist record carries an unknown schema version", "allowlist.v");
  }
  if (!Array.isArray(value.entries)) {
    throw invalid("the allowlist record must carry an entries array", "allowlist.entries");
  }
  if (value.entries.length > ALLOWLIST_LIMITS.MAX_ENTRIES) {
    throw invalid(
      `the allowlist may hold at most ${ALLOWLIST_LIMITS.MAX_ENTRIES} entries`,
      "allowlist.entries",
    );
  }

  const seen = new Map();
  for (const raw of value.entries) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid("an allowlist entry must be an object", "allowlist.entries");
    }
    let entry;
    try {
      entry = normalizeAllowlistEntry(raw.value);
    } catch (error) {
      if (error instanceof PlatformAccessError) {
        throw invalid("an allowlist entry is not an email address or a domain", "allowlist.entries");
      }
      throw error;
    }
    /* The stored `kind` is checked against the derived one rather than trusted.
       A record claiming `kind: "domain"` for `ann@example.com` would otherwise
       be compared against a principal's domain and admit an address it should
       not - the one field here that is a security decision rather than a label. */
    if (raw.kind !== entry.kind) {
      throw invalid("an allowlist entry names the wrong kind", "allowlist.entries");
    }
    seen.set(`${entry.kind}:${entry.value}`, {
      kind: entry.kind,
      value: entry.value,
      addedBy: auditAddress(raw.addedBy),
      addedAt: auditTimestamp(raw.addedAt),
    });
  }

  return Object.freeze({
    v: ALLOWLIST_SCHEMA_VERSION,
    entries: Object.freeze([...seen.values()].sort(compareEntries).map(Object.freeze)),
  });
}

/**
 * The audit's actor field: a normalised address, or `null`.
 *
 * `null` rather than a refusal, because an unreadable *audit* field must not
 * make the whole record uninterpretable. The entry is the access decision; the
 * provenance is bookkeeping, and losing the bookkeeping for one entry is a
 * smaller harm than reading the entire allowlist as unavailable.
 */
function auditAddress(value) {
  return value === undefined || value === null ? null : normalizeEmailOrNull(value);
}

/** The audit's timestamp: a millisecond-precision UTC instant, or `null`. */
function auditTimestamp(value) {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** The allowlist record store, over an injected provider. */
export function createAllowlistStore({ getStore, name } = {}) {
  return createRecordStore({
    getStore,
    name,
    key: ALLOWLIST_KEY,
    label: "allowlist",
    validate: validateAllowlistRecord,
  });
}

/**
 * The stored entries, or the empty list when nothing has been written yet.
 *
 * An absent key is genuinely the empty list: nobody has ever added an entry. A
 * store that could not be read is not - `read` throws `unavailable` for that,
 * and the caller turns the throw into the `null` that `evaluatePlatformAccess`
 * refuses on with its own retryable reason.
 */
export async function readStoredAllowlist(store) {
  const current = await store.read();
  return current === null ? EMPTY_ALLOWLIST.entries : current.record.entries;
}

/**
 * The entries an access decision runs against: the environment seed and the
 * stored list, unioned, with the seed marked.
 *
 * The seed wins a collision only in its `source`, never in its value - both
 * spellings are already normalised to the same string, so there is no
 * disagreement to resolve, and marking it is what lets the page explain why an
 * entry has no remove button.
 *
 * @param {{config: object, store: object}} dependencies
 * @returns {Promise<readonly object[]>}
 */
export async function resolveAllowlist({ config, store }) {
  const stored = await readStoredAllowlist(store);
  const merged = new Map();
  for (const entry of stored) {
    merged.set(`${entry.kind}:${entry.value}`, { ...entry, source: "store" });
  }
  for (const entry of config.platformAllowlistSeed) {
    merged.set(`${entry.kind}:${entry.value}`, {
      kind: entry.kind,
      value: entry.value,
      addedBy: null,
      addedAt: null,
      source: "environment",
    });
  }
  return Object.freeze([...merged.values()].sort(compareEntries).map(Object.freeze));
}

/**
 * Add one entry, attributed to the admin who added it.
 *
 * Idempotent: adding an entry that is already stored re-attributes nothing and
 * writes nothing, so a double-submitted form does not rewrite the record and
 * does not overwrite the provenance of the admin who actually added it.
 *
 * @returns {Promise<{added: boolean, entry: object}>}
 */
export async function addAllowlistEntry({ value, actor, now = () => new Date() }, { store }) {
  const entry = normalizeAllowlistEntry(value);
  const addedBy = normalizeEmailOrNull(actor);
  const addedAt = now().toISOString();

  const result = await store.mutate((current) => {
    const entries = current === null ? [] : current.entries;
    if (entries.some((held) => held.kind === entry.kind && held.value === entry.value)) return null;
    if (entries.length >= ALLOWLIST_LIMITS.MAX_ENTRIES) {
      throw invalid(
        `the allowlist may hold at most ${ALLOWLIST_LIMITS.MAX_ENTRIES} entries`,
        "allowlist.entries",
      );
    }
    return {
      v: ALLOWLIST_SCHEMA_VERSION,
      entries: [...entries, { kind: entry.kind, value: entry.value, addedBy, addedAt }],
    };
  });
  return { added: result.changed, entry };
}

/**
 * Remove one entry.
 *
 * Refuses a seeded entry rather than accepting a removal the next request would
 * undo: the seed lives in `ARCHON_PLATFORM_ALLOWLIST` and only a redeploy can
 * change it. Removing an entry that is not there is not an error - the
 * post-condition the caller asked for holds either way, and reporting "no such
 * entry" would make this route a membership oracle for anybody who reached it.
 *
 * @returns {Promise<{removed: boolean, entry: object}>}
 */
export async function removeAllowlistEntry({ value }, { store, config }) {
  const entry = normalizeAllowlistEntry(value);
  const seeded = config.platformAllowlistSeed.some(
    (held) => held.kind === entry.kind && held.value === entry.value,
  );
  if (seeded) {
    throw new HostedContractError(
      "invalid_request",
      `${entry.value} is seeded by ARCHON_PLATFORM_ALLOWLIST and can only be removed there`,
      { field: "entry" },
    );
  }

  const result = await store.mutate((current) => {
    if (current === null) return null;
    const kept = current.entries.filter(
      (held) => !(held.kind === entry.kind && held.value === entry.value),
    );
    if (kept.length === current.entries.length) return null;
    return { v: ALLOWLIST_SCHEMA_VERSION, entries: kept };
  });
  return { removed: result.changed, entry };
}
