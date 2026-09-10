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
 * ## Why `{modified: true}` is not believed
 *
 * `@netlify/blobs@11.0.2` maps **every non-412 status** of a conditional PUT to
 * `{modified: true}` (`dist/main.js`: `res.status === 412 ? {modified:false} :
 * {etag, modified:true}`), and its retry helper returns a 5xx response rather
 * than throwing once the attempts are used up. So a store answering 500 - or 403
 * - reports a guarded write as having succeeded. Believing it would make logout
 * return 200 for a session that is still live, and would let two callbacks
 * replaying one state both observe "I won the compare-and-set".
 *
 * Every write here therefore carries a random `writeId`, and a write counts as
 * having landed only when the record reads back carrying that exact id. The
 * read-back is one extra strongly consistent GET on operations that happen once
 * per sign-in or sign-out, which is a cheap price for the only confirmation that
 * does not depend on how a client library maps HTTP statuses.
 *
 * For the same reason a `onlyIfMatch` write is refused outright when the read
 * carried no ETag: the library applies the condition only when the value is
 * truthy, so `onlyIfMatch: undefined` is silently an *unconditional* write, and
 * the whole single-use property would evaporate without a single error.
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

/**
 * The ETag a compare-and-set needs, or an outage.
 *
 * `Store.getConditions` applies `onlyIfMatch` only when the value is truthy, so
 * an absent ETag turns the guarded write into an unconditional one that reports
 * success. Refusing here is fail-closed: a store that cannot supply the atomic
 * primitive this design rests on must stop the operation, not quietly perform a
 * weaker one.
 */
function requireEtag(etag) {
  if (typeof etag !== "string" || etag === "") throw unavailable();
  return etag;
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
    } catch (error) {
      /* A `TypeError` here is this module calling the store wrongly - mutually
         exclusive conditions, a non-string ETag - and reporting a programming
         error as a storage outage would hide it behind a retryable 503 forever. */
      if (error instanceof TypeError) throw error;
      throw unavailable();
    }
  }

  /**
   * Write `value` and report whether that write actually landed.
   *
   * Three outcomes, and only the first is cheap:
   *
   *  - `modified: false` is the store refusing the condition. That is definite:
   *    the key existed (`onlyIfNew`) or the ETag was stale (`onlyIfMatch`), and
   *    no read-back can change it. This is the only `false` this method returns.
   *  - anything the library calls success is *unconfirmed*, because it calls a
   *    500 and a 403 success too. The record is read back and the write counts
   *    only if it carries this call's `writeId`.
   *  - a throw is ambiguous - a request that timed out may still have been
   *    applied - so it takes the same read-back.
   *
   * A read-back that disagrees is therefore an outage rather than a lost race,
   * because a genuinely lost race is the `modified: false` case above.
   */
  async #applyGuarded(key, value, conditions) {
    try {
      const result = await this.#write(key, value, conditions);
      if (result?.modified !== true) return false;
    } catch (error) {
      if (error instanceof TypeError) throw error;
      /* Ambiguous rather than failed: a request that timed out may still have
         been applied, so the read-back below decides. */
    }
    const after = await this.#read(key);
    if (after !== null && after.data?.writeId === value.writeId) return true;
    /* The store said it wrote, or might have, and the record disagrees. That is
       never a lost race - a genuinely lost compare-and-set is the `modified:
       false` above - so it is an outage, and reporting it as "somebody else got
       there first" would be inventing an explanation. */
    throw unavailable();
  }

  /**
   * Mark a live record dead, and be certain it is dead before saying so.
   *
   * This is the shape C1 demands of logout and of callback rotation: "durably
   * revoke the old session server-side before claiming success". Three outcomes
   * have to be told apart, and only one of them may be reported as success.
   *
   *  - The guarded write lands, confirmed by reading this call's `writeId`
   *    back off the record. The record is dead.
   *  - The guarded write throws. The write is *ambiguous* - a request that
   *    timed out may still have been applied - so the record is read back. If
   *    it now reads dead, the write landed and this is a success; if it reads
   *    live, it did not, and that is an outage rather than a revocation.
   *  - The guarded write is refused, or lands as somebody else's. Somebody else
   *    wrote the key
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

    const etag = requireEtag(existing.etag);
    const dead = { ...existing.data, ...mark, writeId: randomToken() };
    let landed = false;
    try {
      landed = await this.#applyGuarded(key, dead, { onlyIfMatch: etag });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      landed = false;
    }
    if (landed) return true;

    /* This call did not kill the record, but a concurrent logout or callback
       rotation may have. Both are revocations, so a read-back showing the record
       dead is the outcome the caller asked for. Anything else is an outage. */
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
      writeId: randomToken(),
    };
    /* `onlyIfNew` makes a key collision a refusal rather than an overwrite. With
       256 bits of entropy this never fires; what it rules out is the version of
       this bug where a token is not random after all, and one visitor's session
       silently replaces another's. */
    if (!(await this.#applyGuarded(AuthStore.sessionKey(token), record, { onlyIfNew: true }))) {
      throw unavailable();
    }
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
      writeId: randomToken(),
    };
    const landed = await this.#applyGuarded(AuthStore.transientKey(kind, token), record, {
      onlyIfNew: true,
    });
    if (!landed) throw unavailable();
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

    const etag = requireEtag(found.etag);
    const consumed = { ...found.data, consumedAt: isoAt(this.now()), writeId: randomToken() };
    /* Losing the compare-and-set is the whole point of this method: another
       request consumed the record between the read and the write, so this caller
       must be told nothing was there. Reporting an error instead would hand a
       racing attacker a way to distinguish "no such state" from "state you
       nearly had" - while an *ambiguous* write that did not land propagates as
       an outage from `#applyGuarded`, because that is a different question. */
    if (!(await this.#applyGuarded(key, consumed, { onlyIfMatch: etag }))) return null;
    return Object.freeze({
      kind,
      payload: found.data.payload ?? {},
      createdAt: found.data.createdAt,
      expiresAt: found.data.expiresAt,
    });
  }

  /**
   * Record the first use of a browser-supplied transient token.
   *
   * The inverse of `createTransient`: no record exists until the token is
   * *used*, so the issuing response writes nothing at all. That is what keeps an
   * unauthenticated `GET` from being a write amplifier - a client that never
   * returns its cookie would otherwise mint one permanent record per request,
   * and nothing in this design collects them.
   *
   * Single use still holds, because the claim is an `onlyIfNew` write: the first
   * caller creates the marker, every later caller is refused by the store. What
   * is deliberately *not* claimed is provenance. Any well-formed token can be
   * claimed once, and that is sound here because the pre-login binding's CSRF
   * property comes from `SameSite=Lax` plus the exact `Origin` - a cross-site
   * POST carries no cookie at all - rather than from the value having been
   * minted by this service.
   *
   * @returns {Promise<boolean>} true when this call is the token's first use.
   */
  async claimTransient(kind, token, { ttlSeconds = TRANSIENT_TTL_SECONDS } = {}) {
    if (!TRANSIENT_KINDS.includes(kind)) throw new TypeError(`unknown transient kind: ${kind}`);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) return false;
    const at = this.now();
    const record = {
      v: 1,
      kind,
      payload: {},
      createdAt: isoAt(at),
      expiresAt: isoAt(at + ttlSeconds * 1000),
      consumedAt: isoAt(at),
      revokedAt: null,
      writeId: randomToken(),
    };
    return this.#applyGuarded(AuthStore.transientKey(kind, token), record, { onlyIfNew: true });
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
