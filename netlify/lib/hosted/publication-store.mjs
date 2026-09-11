/**
 * The one place that talks to the blob provider about publication records.
 *
 * Everything provider-shaped lives here: the store name, the key namespace,
 * strong consistency, the conditional-write options, the opaque ETag, and the
 * three answers a conditional write can actually give. `publications.mjs` above
 * it reasons about states and deadlines and never sees a `WriteResult`, and no
 * HTTP handler calls `getStore` at all.
 *
 * Three properties are the whole design, and each exists because the obvious
 * alternative loses a document or invents one:
 *
 *  1. **No write result is trusted without a readback except an unambiguous
 *     success.** Only `modified: true` with a non-empty ETag is taken at face
 *     value. Everything else - a throw, a result that is not the documented
 *     shape, a `modified: true` with no ETag, *and a resolved `modified: false`*
 *     - goes to the readback.
 *
 *     That last one is the subtle case and it was wrong in an earlier draft of
 *     this module. `modified: false` looks like positive proof that nothing was
 *     written, and it is not: `@netlify/blobs` retries the *same* conditional
 *     PUT up to five times on a network error or a 5xx
 *     (`fetchAndRetry` in its `chunk-*.js`). So a write that commits and then
 *     loses its response is re-sent with the same `If-Match`, answered 412 by a
 *     server that has already applied it, and surfaces here as
 *     `modified: false`. Believing it told the human whose approval had in fact
 *     succeeded that their approval conflicted, and left `create` abandoning a
 *     record it had just written and that nothing can ever delete.
 *  2. **Ambiguity is resolved by reading, not by guessing.** `@netlify/blobs`
 *     also resolves a conditional `setJSON` as `{modified: true, etag: ""}` for
 *     any status that is neither 200 nor 412 - so a 500 that changed nothing and
 *     a 201 that changed everything arrive here looking similar. The adapter
 *     reads the key back with strong consistency and compares it to the exact
 *     record it tried to write.
 *
 *     A match means the stored state is the state the caller wanted. When the
 *     provider also said `modified: true` that is a `committed`; otherwise it is
 *     an `observed` - the intent is satisfied, but this call cannot prove it was
 *     the writer, and a caller that needs to distinguish "I created this" from
 *     "this is what I wanted" must treat the two differently. A different record
 *     is `refused`, and so is an absent one. Only a readback that *also* fails
 *     leaves the outcome unknown, and that is the one case that surfaces as
 *     retryable `unavailable` with the uncertainty intact.
 *  3. **A stored record is validated before anybody sees it.** A malformed
 *     envelope, an unknown state name and an unknown schema version are read
 *     failures, not a record in some default state. `validatePublication` throws
 *     an invalid-input error on those, which would be a 400 to whoever asked;
 *     this module converts it to `unavailable`, because the caller's request was
 *     fine and the *storage* is what cannot be believed.
 *
 * A note on what is deliberately absent. There is no `delete`. Netlify's blob
 * API offers no conditional delete, so a delete here could only be an
 * unconditional one racing a completion, and C2 says a committed document is
 * never removed as expired authorisation state. Expiry in this design is
 * logical and evaluated on use; physical removal belongs to an operator census.
 */

import {
  HOSTED_LIMITS,
  HostedContractError,
  validatePublication,
} from "./contracts.mjs";

/**
 * The one site-wide store publication records live in.
 *
 * Site-wide rather than deploy-scoped: a deploy store is discarded when the
 * deploy that made it is superseded, which would silently delete every
 * in-flight publication on the next `netlify deploy`.
 */
export const PUBLICATION_STORE_NAME = "archon-hosted-v1";

/** The key namespace. Nothing else in this store shares the prefix. */
export const PUBLICATION_KEY_PREFIX = "publications/";

/**
 * How many conditional-write attempts one transition may make.
 *
 * Six, matching the discipline the legacy store settled on. The number is a
 * bound on a live race between a small number of parties - an agent uploading,
 * a browser deciding, a second tab cancelling - rather than a throughput knob,
 * and a caller that loses six consecutive CAS rounds against that field is
 * looking at a fault rather than at contention.
 */
export const MAX_WRITE_ATTEMPTS = 6;

/**
 * How many publications one census may enumerate.
 *
 * A bound exists because `list` reads each record individually, so an
 * unbounded enumeration is an unbounded number of provider reads inside one
 * request, on a route a person is waiting on. Five hundred is far above what
 * this deployment holds and far below anything that would time out; a census
 * that hits it says so through `truncated` rather than silently returning a
 * prefix, because a partial list an admin reads as complete is worse than a
 * short one they know is short.
 */
export const MAX_LIST_RECORDS = 500;

/** Storage is what failed, not the request. Always retryable, never detailed. */
function unavailable(reason) {
  return new HostedContractError("unavailable", `publication storage ${reason}`, {
    field: "publication",
  });
}

/**
 * The store key for a publication id.
 *
 * The id is re-checked here even though every caller validated it, because this
 * function turns a caller-controlled string into a storage key and a key is the
 * one place where "probably already checked" becomes a traversal. A legacy
 * six-hex document id fails this by length, which is the point: the hosted
 * deployment shares no identifier space with the self-hosted product.
 */
export function publicationKey(id) {
  if (
    typeof id !== "string" ||
    !new RegExp(`^[0-9a-f]{${HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH}}$`).test(id)
  ) {
    throw new HostedContractError(
      "invalid_request",
      `publicationId must be ${HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH} lowercase hex characters`,
      { field: "publicationId" },
    );
  }
  return `${PUBLICATION_KEY_PREFIX}${id}`;
}

/**
 * Whether two validated records are the same record.
 *
 * Used only to decide whether an ambiguous write committed, so it has to be a
 * value comparison rather than an identity one and it has to be insensitive to
 * key order - the record that comes back has been through `JSON.stringify` and
 * `JSON.parse` since we built it. Both sides are already frozen output of
 * `validatePublication`, which normalises every field to a JSON scalar, so a
 * canonical re-serialisation is exact here in a way it would not be for
 * arbitrary objects.
 */
function sameRecord(left, right) {
  return canonical(left) === canonical(right);
}

/** A key-ordered JSON rendering, for the equality above and nothing else. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/**
 * Whether a provider write result is the documented `WriteResult` shape.
 *
 * `modified` must be an own data property holding a boolean, and a `modified:
 * true` must carry a non-empty ETag. The ETag matters because the next
 * transition needs it to build its `onlyIfMatch`, and a write we cannot follow
 * up on is a write we cannot claim - `@netlify/blobs` returns exactly this
 * shape, `{modified: true, etag: ""}`, for a conditional write that got a status
 * it did not expect.
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
 * A publication store bound to one provider store handle.
 *
 * `getStore` is injected rather than imported and called here so that loading
 * this module contacts nothing: `scripts/check-function-modules.mjs` imports every
 * hosted module at CI time with no credential, and a store opened at module
 * scope would turn that gate into a network call. Production passes
 * `@netlify/blobs`'s `getStore`; tests pass a deterministic double.
 *
 * @param {{
 *   getStore: (options: object) => object,
 *   name?: string,
 * }} dependencies
 * @returns {Readonly<{
 *   read: (id: string) => Promise<{record: object, etag: string} | null>,
 *   create: (record: object) => Promise<{outcome: "created"|"exists", record?: object, etag?: string}>,
 *   update: (record: object, etag: string) => Promise<{outcome: "committed"|"observed"|"refused", record?: object, etag?: string}>,
 *   list: (options?: {limit?: number}) => Promise<{records: object[], unreadable: string[], truncated: boolean}>,
 * }>}
 */
export function createPublicationStore({ getStore, name = PUBLICATION_STORE_NAME } = {}) {
  if (typeof getStore !== "function") {
    throw new TypeError("createPublicationStore requires a getStore function");
  }

  /* Opened once per adapter rather than once per call, and opened lazily so
     that constructing the adapter is still free of provider contact. */
  let store = null;
  const handle = () => {
    if (store === null) {
      /* Strong consistency is not an optimisation here, it is the invariant:
         the whole design is a compare-and-set against an ETag we just read, and
         an eventually consistent read can hand back a stale ETag whose write
         then succeeds against a record that no longer exists in that form. */
      store = getStore({ name, consistency: "strong" });
    }
    return store;
  };

  /**
   * Read and validate the record at `id`, with its ETag.
   *
   * Returns `null` only for a key that genuinely is not there. Every other
   * unhappy answer - a provider throw, a body that is not JSON, a JSON document
   * that is not a legal publication, a hit with no ETag - is `unavailable`,
   * because none of them is "no publication" and reporting them as absence is
   * how a missing record becomes a 404 for a document that exists.
   */
  async function read(id) {
    const key = publicationKey(id);
    let entry;
    try {
      entry = await handle().getWithMetadata(key, { type: "text", consistency: "strong" });
    } catch {
      /* The provider's own error is not propagated and not logged: it carries
         URLs, keys and occasionally response bodies, and this path runs on
         unauthenticated requests. */
      throw unavailable("could not be read");
    }
    if (entry === null || entry === undefined) return null;
    if (typeof entry !== "object" || typeof entry.data !== "string") {
      throw unavailable("returned an unusable read result");
    }
    if (typeof entry.etag !== "string" || entry.etag.length === 0) {
      /* Without an ETag no conditional write is possible, so a caller that
         proceeded would have to fall back to an unconditional one - which is
         precisely the overwrite this module exists to prevent. */
      throw unavailable("returned a record with no ETag");
    }

    let parsed;
    try {
      parsed = JSON.parse(entry.data);
    } catch {
      throw unavailable("holds a record that is not JSON");
    }
    let record;
    try {
      record = validatePublication(parsed);
    } catch {
      /* An unknown state name or schema version lands here. It is deliberately
         not coerced into `pending` or `complete`: a record we cannot read is a
         record we must not act on. */
      throw unavailable("holds a record this version cannot interpret");
    }
    return { record, etag: entry.etag };
  }

  /**
   * Read a key back after a write this call cannot vouch for, and say what is
   * actually stored relative to what was intended.
   *
   * A readback that itself fails re-throws `unavailable`, which is the honest
   * answer: the write may or may not have landed and we still do not know.
   */
  async function readBack(intended) {
    const observed = await read(intended.id);
    if (observed === null) return { matches: false, observed: null };
    return { matches: sameRecord(observed.record, intended), observed };
  }

  /**
   * Create the pending record, and only ever create it.
   *
   * `onlyIfNew` is the entire concurrency story for this call: two requests that
   * somehow chose the same id produce exactly one winner, and the loser is told
   * `exists` and is given nothing about the record that beat it. Returning the
   * existing record here would let a colliding caller read another operation's
   * user code and expiry, and in the shape this API has it would read as "you
   * created this".
   *
   * A `modified: false` is *not* short-circuited to `exists`. The record found
   * at the key may be the one this very call wrote a moment ago and lost the
   * response to, and treating that as a collision made `createPublication`
   * abandon its own freshly written record - and its minted secrets with it -
   * leaving a durable pending publication that nobody holds a capability for and
   * that nothing in this design can ever delete.
   */
  async function create(record) {
    const validated = validatePublication(record);
    const key = publicationKey(validated.id);

    let result;
    try {
      result = await handle().setJSON(key, validated, { onlyIfNew: true });
    } catch {
      return resolveCreate(validated);
    }

    if (!isWellFormedWriteResult(result)) return resolveCreate(validated);
    if (result.modified === false) return resolveCreate(validated);
    return { outcome: "created", record: validated, etag: result.etag };
  }

  async function resolveCreate(intended) {
    const { matches, observed } = await readBack(intended);
    if (matches) return { outcome: "created", record: observed.record, etag: observed.etag };
    if (observed !== null) return { outcome: "exists" };
    throw unavailable("could not confirm whether the record was created");
  }

  /**
   * Replace the record at `record.id`, but only if it still carries `etag`.
   *
   * Three outcomes, and the middle one is the reason this is not a boolean:
   *
   *  - `committed` - the provider reported an unambiguous success. This call
   *    wrote the record.
   *  - `observed` - the stored record is exactly the record that was intended,
   *    but the provider's answer did not prove this call wrote it. A caller
   *    whose only question is "is the state I wanted the state that is stored"
   *    can treat this as success; a caller that must distinguish creating a
   *    document from finding one already there must not.
   *  - `refused` - the stored record is something else, or the key is absent.
   *    The caller's next act is to re-evaluate its whole transition against what
   *    is actually stored, not to assume its write lost.
   */
  async function update(record, etag) {
    if (typeof etag !== "string" || etag.length === 0) {
      throw new TypeError("update requires the observed ETag of the record being replaced");
    }
    const validated = validatePublication(record);
    const key = publicationKey(validated.id);

    let result;
    try {
      /* The ETag is passed through exactly as the provider gave it, quotes,
         weakness prefix and all. It is opaque; normalising it here would be
         inventing a format the provider never promised. */
      result = await handle().setJSON(key, validated, { onlyIfMatch: etag });
    } catch {
      return resolveUpdate(validated);
    }

    if (!isWellFormedWriteResult(result)) return resolveUpdate(validated);
    if (result.modified === false) return resolveUpdate(validated);
    return { outcome: "committed", record: validated, etag: result.etag };
  }

  async function resolveUpdate(intended) {
    const { matches, observed } = await readBack(intended);
    if (matches) return { outcome: "observed", record: observed.record, etag: observed.etag };
    return { outcome: "refused" };
  }

  /**
   * Every publication in the store, for the admin census and nothing else.
   *
   * Three properties are deliberate.
   *
   * **It reports what it could not read rather than omitting it.** A record this
   * version cannot interpret is the one an operator most needs to know exists,
   * and a census that quietly dropped it would show an admin a shorter list than
   * the truth and give them no way to notice. So a per-record read failure lands
   * in `unreadable` as an id, and only a failure to enumerate the keys at all -
   * where there is no list to be partial about - is an outage.
   *
   * **It reads each record through `read`.** The same validation, the same
   * strong consistency and the same refusals as every other reader, so the
   * census cannot become a second, laxer interpretation of a stored record.
   *
   * **It returns records, not a projection.** Deciding which fields an admin may
   * see is an access decision and belongs to the route that made it, not to the
   * storage adapter - this module has no idea who is asking.
   */
  async function list({ limit = MAX_LIST_RECORDS } = {}) {
    let listing;
    try {
      listing = await handle().list({ prefix: PUBLICATION_KEY_PREFIX });
    } catch {
      throw unavailable("could not be enumerated");
    }
    const blobs = listing === null || typeof listing !== "object" ? null : listing.blobs;
    if (!Array.isArray(blobs)) throw unavailable("returned an unusable listing");

    const ids = blobs
      .map((blob) => (typeof blob?.key === "string" ? blob.key.slice(PUBLICATION_KEY_PREFIX.length) : ""))
      .filter((id) => id !== "")
      .sort();
    const truncated = ids.length > limit;

    const records = [];
    const unreadable = [];
    for (const id of ids.slice(0, limit)) {
      let entry;
      try {
        entry = await read(id);
      } catch {
        /* One unreadable record is a fact about that record, not an outage of
           the census. The id is safe to report here and nowhere else: this
           result reaches an admin and never an anonymous caller. */
        unreadable.push(id);
        continue;
      }
      /* A key that vanished between the listing and the read. Neither present
         nor unreadable, so it is simply not in the census. */
      if (entry === null) continue;
      records.push(entry.record);
    }
    return { records, unreadable, truncated };
  }

  return Object.freeze({ read, create, update, list });
}
