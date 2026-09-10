/**
 * The auth-state namespaces of `archon-hosted-v1`, and the two write primitives
 * that make them safe.
 *
 * AHU-003 owns exactly two families of record and nothing else:
 *
 *   sessions/<sha256(sessionToken)>   the browser session, seven-day absolute expiry
 *   auth/<kind>/<sha256(token)>       a transient browser transaction, fifteen minutes
 *
 * Publication state is AHU-004's, and this module cannot read or write it. That
 * separation is the reason the key prefixes are constants here rather than
 * strings at each call site: a namespace that is spelled in one place cannot
 * drift into a sibling's.
 *
 * ## Why the reads are strongly consistent
 *
 * The store is opened with `consistency: "strong"`. An eventually consistent read
 * of a session record is a revocation that has not happened yet: logout returns
 * success, the operator believes the session is dead, and a copied cookie keeps
 * working from whichever replica has not caught up. C1 requires the opposite -
 * "a revoked token fails on every subsequent identity read" - so the slower read
 * is the only correct one, on every path.
 *
 * ## Why a failure is never a null
 *
 * Every store call in this file is wrapped, and every exception becomes an
 * `AuthUnavailableError`. A `catch` that returned `null` would turn a storage
 * outage into "nobody is signed in", which reads as a graceful degradation and
 * is in fact a fail-open: the session lookup is the only thing standing between
 * a visitor and somebody else's document. The one thing this module will never
 * do is invent an answer it did not read.
 *
 * ## Why single use is a guarded update rather than a delete
 *
 * An unconditional `delete` is not single-use. Two callbacks arriving with the
 * same state both read a live record, both proceed, and both delete; the second
 * delete succeeds against nothing and the second session is created anyway. What
 * makes consumption atomic is the store's compare-and-set: read the record with
 * its ETag, write it back marked consumed with `onlyIfMatch: <that etag>`, and
 * treat `modified === false` as "somebody else consumed it first". Exactly one
 * of two concurrent callbacks can observe `modified === true`, which is the
 * property C1's "consume OAuth state once" actually needs.
 *
 * The consumed record is left in place rather than removed, so a replay is
 * refused by a record that says why, and expiry is enforced on lookup instead of
 * by a cleanup job. Nothing here schedules anything: physical records outlive
 * their lifetimes and are ignored on read, and bounded retention is an operator
 * maintenance note in the README rather than an assumption about a TTL feature.
 */

import { getStore } from "@netlify/blobs";

import { AuthUnavailableError } from "./auth-errors.mjs";
import { validatePrincipal } from "./contracts.mjs";
import { hashToken, randomToken } from "./secrets.mjs";

/** The private, strongly consistent store this ticket's records live in. */
export const HOSTED_STORE_NAME = "archon-hosted-v1";

/** C1: browser sessions. */
export const SESSION_PREFIX = "sessions/";

/** C1: transient browser-transaction records. */
export const TRANSIENT_PREFIX = "auth/";

/**
 * The transient record kinds, each with its own sub-namespace and its own
 * `__Host-` cookie.
 *
 * They are separate namespaces rather than one bag with a `kind` field because
 * the lookup key is derived from the token: a login-binding token must not be
 * presentable as an OAuth state, and keeping the kind in the key rather than in
 * the value makes that a property of where the record lives rather than of a
 * field somebody has to remember to check.
 */
export const TRANSIENT_KINDS = Object.freeze(["oauth", "login", "binding"]);

/** C1: the browser session's absolute expiry. Seven days, from creation. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** C1: the ceiling on every transient cookie and its record. Fifteen minutes. */
export const TRANSIENT_TTL_SECONDS = 15 * 60;

/** A store operation that failed for any reason at all. Never a null. */
function unavailable() {
  return new AuthUnavailableError("storage");
}

/** ISO-8601 UTC, the one timestamp spelling the hosted contracts use. */
function isoAt(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * Whether a stored record is still live at `epochMs`.
 *
 * Expiry is read from the record and compared against server time, never
 * against anything the browser sent, and it is checked on every lookup rather
 * than trusted to have been cleaned up. A record whose bytes are still present
 * long after its lifetime is the normal case here, not an anomaly.
 */
function isLive(record, epochMs) {
  if (record === null || typeof record !== "object") return false;
  if (record.revokedAt !== null && record.revokedAt !== undefined) return false;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && epochMs < expiresAt;
}

/**
 * The auth-state adapter.
 *
 * Constructed around a store object rather than reaching for one, and around an
 * injected clock rather than `Date.now`. Both are what let the whole of this
 * ticket's behaviour - expiry, single use, revocation, outage - be exercised
 * without a network, a credential or a real elapsed week.
 */
export class AuthStore {
  /**
   * @param {{getWithMetadata: Function, setJSON: Function}} store a
   *   `@netlify/blobs` store, or any object presenting those two methods.
   * @param {{now?: () => number}} [options] `now` returns epoch milliseconds.
   */
  constructor(store, { now = () => Date.now() } = {}) {
    if (store === null || typeof store !== "object") {
      throw new TypeError("AuthStore requires a blob store object");
    }
    if (typeof now !== "function") throw new TypeError("AuthStore requires a clock function");
    this.store = store;
    this.now = now;
  }

  /** The key a transient token lives under, kind included. */
  static transientKey(kind, token) {
    if (!TRANSIENT_KINDS.includes(kind)) throw new TypeError(`unknown transient kind: ${kind}`);
    return `${TRANSIENT_PREFIX}${kind}/${hashToken(token)}`;
  }

  /** The key a session token lives under. */
  static sessionKey(token) {
    return `${SESSION_PREFIX}${hashToken(token)}`;
  }

  /** A strongly consistent read of one record, with its ETag. Never a null on error. */
  async #read(key) {
    try {
      return await this.store.getWithMetadata(key, { type: "json", consistency: "strong" });
    } catch {
      throw unavailable();
    }
  }

  /** A write, conditional or not, reported as the store's `{modified, etag}`. */
  async #write(key, value, conditions) {
    try {
      return await this.store.setJSON(key, value, conditions);
    } catch {
      throw unavailable();
    }
  }

  /**
   * Mark a live record dead, and be certain it is dead before saying so.
   *
   * This is the shape C1 demands of logout and of callback rotation: "durably
   * revoke the old session server-side before claiming success". Three outcomes
   * have to be told apart, and only one of them may be reported as success.
   *
   *  - The guarded write reports `modified: true`. The record is dead.
   *  - The guarded write throws. The write is *ambiguous* - a request that
   *    timed out may still have been applied - so the record is read back. If
   *    it now reads dead, the write landed and this is a success; if it reads
   *    live, it did not, and that is an outage rather than a revocation.
   *  - The guarded write reports `modified: false`. Somebody else wrote the key
   *    between the read and the write. That is not automatically a failure: a
   *    concurrent logout and callback rotation both revoke, so a read-back that
   *    shows the record dead is the outcome the caller asked for. Anything else
   *    is an outage.
   *
   * The one answer never produced is "revoked" without having observed it.
   */
  async #revoke(key, mark) {
    const existing = await this.#read(key);
    if (existing === null) return false;
    if (!isLive(existing.data, this.now())) return false;

    const dead = { ...existing.data, ...mark };
    let result;
    try {
      result = await this.#write(key, dead, { onlyIfMatch: existing.etag });
    } catch {
      const after = await this.#read(key);
      if (after !== null && !isLive(after.data, this.now())) return true;
      throw unavailable();
    }
    if (result?.modified === true) return true;

    const after = await this.#read(key);
    if (after !== null && !isLive(after.data, this.now())) return true;
    throw unavailable();
  }

  /* ---------------------------------------------------------------- */
  /* sessions                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Mint a browser session for `principal`.
   *
   * The principal is revalidated on the way in even though the caller has just
   * built it from a provider response. This is the last point at which a
   * malformed identity can be stopped from becoming a durable ownership key,
   * and the check costs nothing: a record written here is what every later
   * owner comparison reads back.
   *
   * @returns {Promise<{token: string, expiresAt: string}>} the raw token, which
   *   is returned exactly once and never stored.
   */
  async createSession(principal) {
    const checked = validatePrincipal(principal);
    const at = this.now();
    const token = randomToken();
    const record = {
      v: 1,
      principal: checked,
      createdAt: isoAt(at),
      expiresAt: isoAt(at + SESSION_TTL_SECONDS * 1000),
      revokedAt: null,
    };
    /* `onlyIfNew` makes a key collision a refusal rather than an overwrite. With
       256 bits of entropy this never fires; what it rules out is the version of
       this bug where a token is not random after all, and one visitor's session
       silently replaces another's. */
    const result = await this.#write(AuthStore.sessionKey(token), record, { onlyIfNew: true });
    if (result?.modified !== true) throw unavailable();
    return { token, expiresAt: record.expiresAt };
  }

  /**
   * The principal behind a session token, or null.
   *
   * Null means absent, expired or revoked - three conditions that are one answer
   * to a caller, because a client that could tell them apart could probe for
   * which tokens have ever existed. A storage failure is not among them and
   * throws instead.
   */
  async readSession(token) {
    if (typeof token !== "string" || token === "") return null;
    const found = await this.#read(AuthStore.sessionKey(token));
    if (found === null) return null;
    if (!isLive(found.data, this.now())) return null;
    let principal;
    try {
      principal = validatePrincipal(found.data.principal);
    } catch {
      /* A stored record that no longer satisfies C1 is not an identity. Refusing
         it here means a record corrupted or hand-edited into a wider shape
         cannot become a principal, which is the one thing a malformed value in
         this position must never be able to do. */
      return null;
    }
    return Object.freeze({
      principal,
      createdAt: found.data.createdAt,
      expiresAt: found.data.expiresAt,
    });
  }

  /**
   * Revoke a session server-side. `true` when this call killed a live session,
   * `false` when there was nothing live to kill, and an unavailable error when
   * it could not be established either way.
   */
  async revokeSession(token) {
    if (typeof token !== "string" || token === "") return false;
    return this.#revoke(AuthStore.sessionKey(token), { revokedAt: isoAt(this.now()) });
  }

  /* ---------------------------------------------------------------- */
  /* transient browser transactions                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Mint a transient record of `kind` carrying `payload`.
   *
   * `payload` is whatever the transaction needs to survive a round trip through
   * the provider and nothing more: a PKCE verifier and a validated destination
   * for `oauth`, an opaque operation for `binding`, nothing at all for `login`.
   * It is stored server-side precisely so none of it has to travel in a URL.
   *
   * @returns {Promise<{token: string, expiresAt: string}>}
   */
  async createTransient(kind, payload = {}, { ttlSeconds = TRANSIENT_TTL_SECONDS } = {}) {
    if (!TRANSIENT_KINDS.includes(kind)) throw new TypeError(`unknown transient kind: ${kind}`);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > TRANSIENT_TTL_SECONDS) {
      throw new TypeError(`ttlSeconds must be 1-${TRANSIENT_TTL_SECONDS}`);
    }
    const at = this.now();
    const token = randomToken();
    const record = {
      v: 1,
      kind,
      payload,
      createdAt: isoAt(at),
      expiresAt: isoAt(at + ttlSeconds * 1000),
      consumedAt: null,
      revokedAt: null,
    };
    const result = await this.#write(AuthStore.transientKey(kind, token), record, {
      onlyIfNew: true,
    });
    if (result?.modified !== true) throw unavailable();
    return { token, expiresAt: record.expiresAt };
  }

  /**
   * Look at a transient record without consuming it.
   *
   * This exists for the publication binding, which C1 requires be *preserved*
   * through account switching until a decision or expiry. A read that consumed
   * would destroy the binding on the first bootstrap request, which is exactly
   * the failure the contract calls out by name.
   */
  async readTransient(kind, token) {
    if (typeof token !== "string" || token === "") return null;
    const found = await this.#read(AuthStore.transientKey(kind, token));
    if (found === null) return null;
    if (found.data?.consumedAt) return null;
    if (!isLive(found.data, this.now())) return null;
    return Object.freeze({
      kind,
      payload: found.data.payload ?? {},
      createdAt: found.data.createdAt,
      expiresAt: found.data.expiresAt,
    });
  }

  /**
   * Consume a transient record, at most once, ever.
   *
   * Returns the record on the one call that wins, and null on every other -
   * absent, expired, already consumed, or beaten to the compare-and-set by a
   * concurrent request. A caller cannot tell those apart, and does not need to:
   * all of them mean "this transaction is not yours to complete".
   */
  async consumeTransient(kind, token) {
    if (typeof token !== "string" || token === "") return null;
    const key = AuthStore.transientKey(kind, token);
    const found = await this.#read(key);
    if (found === null) return null;
    if (found.data?.consumedAt) return null;
    if (!isLive(found.data, this.now())) return null;

    const consumed = { ...found.data, consumedAt: isoAt(this.now()) };
    const result = await this.#write(key, consumed, { onlyIfMatch: found.etag });
    /* `modified: false` is the whole point of this method: another request
       consumed the record between the read and the write, so this caller lost
       and must be told nothing was there. Reporting an error instead would hand
       a racing attacker a way to distinguish "no such state" from "state you
       nearly had". */
    if (result?.modified !== true) return null;
    return Object.freeze({
      kind,
      payload: found.data.payload ?? {},
      createdAt: found.data.createdAt,
      expiresAt: found.data.expiresAt,
    });
  }

  /** Kill a transient record without consuming it, e.g. clearing a binding. */
  async revokeTransient(kind, token) {
    if (typeof token !== "string" || token === "") return false;
    return this.#revoke(AuthStore.transientKey(kind, token), { revokedAt: isoAt(this.now()) });
  }
}

/**
 * The production adapter: a strongly consistent, private, site-scoped store.
 *
 * Site-scoped rather than deploy-scoped, deliberately. A deploy-scoped store is
 * a different store per deploy, so every deploy would sign every visitor out and
 * - much worse - a revocation written against one deploy would not be visible to
 * another, which is a revoked token that keeps working. C1 says the revocation
 * store is never a public or deploy-scoped one.
 *
 * The factory is injectable so a test can drive the adapter without credentials;
 * it is a parameter of this one function rather than an environment variable,
 * so there is no value an operator can set that swaps production storage for
 * something else.
 */
export function openAuthStore({ storeFactory = getStore, now } = {}) {
  const store = storeFactory(HOSTED_STORE_NAME, { consistency: "strong" });
  return new AuthStore(store, now === undefined ? {} : { now });
}
