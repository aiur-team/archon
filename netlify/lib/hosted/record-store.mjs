/**
 * The conditional-write discipline for the small singleton records this
 * deployment keeps beside its publications: the platform allowlist, and the
 * invite-request rate-limit counters.
 *
 * ## Its relationship to `publication-store.mjs`
 *
 * That module is the authority for publication state and stays exactly as it
 * is; nothing here reads or writes a `publications/` key, and the publication
 * state machine is not re-expressed. What is shared is the *provider*
 * discipline, and it is shared because getting it wrong is subtle in a way that
 * is worth stating once:
 *
 *  - `@netlify/blobs` retries the same conditional PUT up to five times on a
 *    network error or a 5xx. A write that commits and then loses its response is
 *    re-sent with the same `If-Match`, answered 412 by a server that has already
 *    applied it, and surfaces as `modified: false`. So `modified: false` is not
 *    proof that nothing was written.
 *  - It also resolves a conditional write as `{modified: true, etag: ""}` for
 *    any status that is neither 200 nor 412, so an ETag-less success is not a
 *    success this process can build the next write on.
 *
 * Every ambiguous answer therefore goes to a strongly-consistent readback and is
 * decided against what is actually stored, and only a readback that *also* fails
 * leaves the outcome unknown - which surfaces as a retryable `unavailable` with
 * the uncertainty intact rather than as a guess.
 *
 * This module is generic over the key and the validator rather than being two
 * near-identical adapters, because two copies of the paragraph above is how one
 * of them ends up missing the `modified: false` case.
 *
 * ## Why `mutate` rather than a bare `write`
 *
 * Every caller here is read-modify-write against a record other admins may be
 * editing at the same moment, so every caller would otherwise write the same
 * retry loop. `mutate` takes a function from the current record to the next one
 * and re-runs it against freshly read state when the compare-and-set is refused,
 * so a losing writer re-derives its change from what is actually stored instead
 * of replaying a decision made against a record that no longer exists. A
 * transform that returns `null` means "no change is needed", which is how a
 * removal of an entry that is already gone costs no write at all.
 */

import { HostedContractError } from "./contracts.mjs";

/** The one site-wide store these records share with the publications. */
export const RECORD_STORE_NAME = "archon-hosted-v1";

/**
 * How many compare-and-set attempts one mutation may make.
 *
 * Six, matching `MAX_WRITE_ATTEMPTS` in `publication-store.mjs`. The number
 * bounds a live race between a small number of parties - two admins on the page,
 * a burst of invite requests - rather than throughput, and a caller that loses
 * six consecutive rounds is looking at a fault rather than at contention.
 */
export const MAX_WRITE_ATTEMPTS = 6;

/** Storage is what failed, not the request. Always retryable, never detailed. */
export function storageUnavailable(what, reason) {
  return new HostedContractError("unavailable", `${what} storage ${reason}`, { field: what });
}

/** A key-ordered JSON rendering, for the readback equality and nothing else. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/**
 * Whether a provider write result is the documented `WriteResult` shape.
 *
 * `modified` must be an own data property holding a boolean, and a
 * `modified: true` must carry a non-empty ETag - without one the next
 * conditional write has nothing to match on, and a write we cannot follow up on
 * is a write we cannot claim.
 */
function isWellFormedWriteResult(result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(result, "modified");
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
  if (typeof result.modified !== "boolean") return false;
  if (result.modified === false) return true;
  return typeof result.etag === "string" && result.etag.length > 0;
}

/**
 * A store for one validated singleton record at one key.
 *
 * `getStore` is injected rather than imported and called here so that loading
 * this module contacts nothing: `scripts/check-function-modules.mjs` imports
 * every hosted module with no credential present, and a store opened at module
 * scope would turn that gate into a network call.
 *
 * @param {{
 *   getStore: (options: object) => object,
 *   key: string,
 *   validate: (value: unknown) => object,
 *   label?: string,
 *   name?: string,
 * }} dependencies `validate` throws for a record this version cannot interpret
 *   and returns the canonical, frozen form otherwise; `label` names the record
 *   in an outage message and is the only part of it a caller ever sees.
 */
export function createRecordStore({
  getStore,
  key,
  validate,
  label = "record",
  name = RECORD_STORE_NAME,
} = {}) {
  if (typeof getStore !== "function") {
    throw new TypeError("createRecordStore requires a getStore function");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("createRecordStore requires a store key");
  }
  if (typeof validate !== "function") {
    throw new TypeError("createRecordStore requires a validate function");
  }

  let store = null;
  const handle = () => {
    if (store === null) {
      /* Strong consistency is the invariant, not an optimisation: the whole
         design is a compare-and-set against an ETag we just read, and an
         eventually consistent read hands back a stale one. */
      store = getStore({ name, consistency: "strong" });
    }
    return store;
  };

  /**
   * The stored record with its ETag, or `null` when the key is genuinely absent.
   *
   * Every other unhappy answer - a provider throw, a body that is not JSON, a
   * document this version cannot interpret, a hit with no ETag - is
   * `unavailable`. None of them is "no record", and reporting them as absence is
   * how an unreadable allowlist becomes an empty one that admits nobody while
   * looking like a policy.
   */
  async function read() {
    let entry;
    try {
      entry = await handle().getWithMetadata(key, { type: "text", consistency: "strong" });
    } catch {
      /* The provider's own error carries URLs and occasionally response bodies,
         and this path runs on unauthenticated requests. It is not propagated. */
      throw storageUnavailable(label, "could not be read");
    }
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "object" || typeof entry.data !== "string") {
      throw storageUnavailable(label, "returned an unusable read result");
    }
    if (typeof entry.etag !== "string" || entry.etag.length === 0) {
      throw storageUnavailable(label, "returned a record with no ETag");
    }
    let parsed;
    try {
      parsed = JSON.parse(entry.data);
    } catch {
      throw storageUnavailable(label, "holds a record that is not JSON");
    }
    let record;
    try {
      record = validate(parsed);
    } catch {
      throw storageUnavailable(label, "holds a record this version cannot interpret");
    }
    return { record, etag: entry.etag };
  }

  /** What is stored now, relative to what this call tried to write. */
  async function readBack(intended) {
    const observed = await read();
    if (observed === null) return { matches: false, observed: null };
    return { matches: canonical(observed.record) === canonical(intended), observed };
  }

  /**
   * Write `next` only if the key still carries `etag`, or only if it is absent
   * when `etag` is `null`.
   *
   * @returns {Promise<{outcome: "committed"|"observed"|"refused", record?: object, etag?: string}>}
   *   `observed` means the stored record is exactly the intended one but this
   *   call cannot prove it was the writer - satisfied intent, unproven
   *   authorship. `refused` means something else is stored and the caller must
   *   re-derive its change from that.
   */
  async function write(next, etag) {
    const validated = validate(next);
    const options = etag === null ? { onlyIfNew: true } : { onlyIfMatch: etag };

    let result;
    try {
      result = await handle().setJSON(key, validated, options);
    } catch {
      return resolve(validated);
    }
    if (!isWellFormedWriteResult(result) || result.modified === false) return resolve(validated);
    return { outcome: "committed", record: validated, etag: result.etag };
  }

  async function resolve(intended) {
    const { matches, observed } = await readBack(intended);
    if (matches) return { outcome: "observed", record: observed.record, etag: observed.etag };
    return { outcome: "refused" };
  }

  /**
   * Read the record, derive the next one from it, and commit it against the
   * ETag it was derived from - retrying the derivation, not the write, when
   * somebody else got there first.
   *
   * @param {(current: object | null) => object | null} transform `null` in means
   *   the key is absent; `null` out means no write is needed.
   * @returns {Promise<{changed: boolean, record: object | null}>}
   */
  async function mutate(transform) {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await read();
      const next = transform(current === null ? null : current.record);
      if (next === null) return { changed: false, record: current === null ? null : current.record };

      const result = await write(next, current === null ? null : current.etag);
      /* `observed` counts as success for a mutation: the question a caller asks
         here is "is the state I wanted the state that is stored", and it is. The
         distinction between writing it and finding it matters to a creation, not
         to an edit of a shared list. */
      if (result.outcome !== "refused") return { changed: true, record: result.record };
    }
    throw storageUnavailable(label, "could not be updated without conflicting");
  }

  return Object.freeze({ read, write, mutate });
}
