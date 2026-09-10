/**
 * The publication state machine: one authority for approval, ownership,
 * completion and receipt recovery.
 *
 * Every hosted route that changes or reads a publication goes through one of the
 * nine operations below. That is the point of the module rather than a
 * convenience: C2 puts approval, ownership and the published bytes in a single
 * record, and a single record is only safe if exactly one piece of code decides
 * what a legal transition is. A second compare-and-set loop written in a handler
 * would be a second opinion about who owns a document.
 *
 * The rules that shape everything here:
 *
 *  - **Every write is a compare-and-set against an ETag observed in the same
 *    attempt.** There is no unconditional write anywhere in this module. The
 *    pending record is created with `onlyIfNew`; every later state is written
 *    with `onlyIfMatch`. A refused write sends the operation back to the top of
 *    the loop, where the *whole* transition is re-decided against a fresh read
 *    and a fresh clock reading - not just the field that changed. Re-checking
 *    only the conflicting field is how an upload gets committed a
 *    millisecond after its own deadline, or onto a record that was cancelled
 *    while the first attempt was in flight.
 *  - **Expiry is logical and evaluated on use.** Nothing in this design deletes
 *    a record or runs a sweeper, so `pendingExpiresAt` and `uploadExpiresAt` are
 *    read at the moment of the call and compared to the injected clock. A
 *    deployment whose cleanup never runs - which is this deployment, because
 *    Netlify offers no conditional delete to run it safely - behaves identically
 *    to one whose cleanup runs constantly.
 *  - **Terminal is terminal.** `complete`, `denied`, `cancelled` and `expired`
 *    are never written over. A cancel that arrives after a completion returns
 *    the completion; a completion that arrives after a cancel is refused. The
 *    race is decided by the provider's conditional write, and precisely one side
 *    wins it.
 *  - **A capability is bounded by the record it belongs to.** The agent bearer
 *    authorises status, cancel and the upload of the exact approved descriptor.
 *    It is never an account, never a login, and never a permission to read the
 *    document afterwards - that is `readOwnedPublication`, which asks for a
 *    principal and compares it to the owner the browser fixed at approval.
 *  - **A projection carries no secret.** No status, review or error path returns
 *    `agentSecretHash`, `browserSecretHash` or `html`.
 *
 *    The two exceptions are `readPublication` and `readOwnedPublication`, which
 *    C3 freezes as returning the whole stored record - and a stored record
 *    carries both secret hashes as well as, once complete, the document. Those
 *    two are **server-internal reads, not HTTP projections**: a consumer that
 *    serialises what they return, or embeds it in a page, publishes
 *    `browserSecretHash`, and that value is not merely a digest of a capability
 *    - `reviewPublication` and `decidePublication` accept a binding by comparing
 *    the *presented* hash to the stored one, so the stored value is itself
 *    replayable as the browser binding. Project before you serialise.
 *
 * Dependencies are injected. The store, the clock and the random source all
 * arrive through `createPublications`, so a test drives a real transition
 * against a deterministic double rather than against a mock of this module, and
 * so that importing this file opens no store and reads no environment.
 */

import { Buffer } from "node:buffer";
import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import {
  HOSTED_LIMITS,
  HostedContractError,
  validateDescriptor,
  validateOrigin,
  validatePrincipal,
  validatePublication,
  validateResult,
  validateStartResponse,
} from "./contracts.mjs";
import { createPublicationStore, MAX_WRITE_ATTEMPTS } from "./publication-store.mjs";
import { readHostedConfig } from "./config.mjs";

/**
 * The pairing-code alphabet AHU-001 recommends: no vowels, so no accidental
 * word, and no `0`/`O` or `1`/`I`/`L`, so no code that is read back wrongly over
 * a shoulder. Its length is not a power of two, which is why minting rejects
 * biased bytes below rather than taking a remainder.
 */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";

/** Bytes of entropy behind each generated value. */
const ID_BYTES = 16;
const SECRET_BYTES = 32;

/** A C3 failure. Local rather than imported so every throw names its own code. */
function fail(code, message, field = "publication") {
  return new HostedContractError(code, message, { field });
}

function unavailable(reason) {
  return fail("unavailable", `publication storage ${reason}`);
}

/** Lowercase hex SHA-256 of a UTF-8 string, the one hash this module stores. */
function sha256Hex(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Constant-time comparison of a presented secret's digest against a stored one.
 *
 * Both sides are 64 lowercase hex characters, so the lengths always match and
 * `timingSafeEqual` never throws; hashing first is what guarantees that, and is
 * also why a secret of any shape can be compared without a length oracle.
 */
function secretMatches(presented, storedHash) {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const left = Buffer.from(sha256Hex(presented), "utf8");
  const right = Buffer.from(storedHash, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Whether presented bytes are the bytes already stored, compared in constant
 * time over their digests.
 *
 * `presented !== stored` would be a length-then-memcmp against the stored
 * document, and this is the one comparison where an agent bearer touches bytes
 * it is not otherwise allowed to read. Reaching it already requires a matching
 * `contentSha256`, so the residual oracle is narrow - but hashing both sides
 * costs nothing and removes it, and it keeps every comparison in this module
 * constant-time rather than most of them.
 */
function sameDocument(presented, stored) {
  if (typeof presented !== "string" || typeof stored !== "string") return false;
  const left = Buffer.from(sha256Hex(presented), "utf8");
  const right = Buffer.from(sha256Hex(stored), "utf8");
  return timingSafeEqual(left, right);
}

/** An ISO-8601 UTC instant with milliseconds, the only spelling C2 accepts. */
function isoAt(milliseconds) {
  return new Date(milliseconds).toISOString();
}

/** `seconds` after `milliseconds`, as a contract timestamp. */
function isoAfter(milliseconds, seconds) {
  return isoAt(milliseconds + seconds * 1000);
}

/**
 * The state a record is *in right now*, which is not always the state it was
 * stored in.
 *
 * A pending record past its approval deadline and an approved record past its
 * upload deadline are both `expired` to every caller, without anything having
 * been written. That is what makes "expiry is enforced on every use even if
 * physical cleanup never runs" true rather than aspirational, and it is why this
 * function takes the clock as an argument instead of reading it.
 */
function effectiveState(record, nowMs) {
  if (record.state === "pending" && nowMs >= Date.parse(record.pendingExpiresAt)) return "expired";
  if (record.state === "approved" && nowMs >= Date.parse(record.uploadExpiresAt)) return "expired";
  return record.state;
}

/**
 * The deadline a caller should poll against for a record.
 *
 * Keyed off the *stored* state rather than the effective one, so an approved
 * record that has just expired reports the upload deadline it blew rather than
 * the approval deadline it met.
 */
function expiresAtFor(record) {
  if (record.state === "complete") return record.receiptExpiresAt;
  if (record.state === "approved") return record.uploadExpiresAt;
  return record.pendingExpiresAt;
}

/**
 * Mint a user code from `bytes` worth of randomness.
 *
 * Rejection sampling rather than a modulo: 256 is not a multiple of 27, so
 * `byte % 27` would make the first four letters of the alphabet meaningfully
 * likelier than the last. The code is a pairing check a human reads aloud, and
 * a skewed one is a smaller code than it looks.
 */
function mintUserCode(randomBytes) {
  const limit = Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;
  const characters = [];
  /* Bounded so a random source that only ever returns rejected bytes fails
     loudly instead of spinning. A real source clears eight characters in one or
     two draws. */
  for (let draw = 0; draw < 64 && characters.length < 8; draw += 1) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      characters.push(USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
      if (characters.length === 8) break;
    }
  }
  if (characters.length < 8) throw unavailable("could not mint a user code");
  return `${characters.slice(0, 4).join("")}-${characters.slice(4).join("")}`;
}

/** A base64url capability string, 43 characters at `SECRET_BYTES` of entropy. */
function mintSecret(randomBytes) {
  return Buffer.from(randomBytes(SECRET_BYTES)).toString("base64url");
}

/** The receipt C3 hands back for a completed record. */
function resultOf(record, appOrigin) {
  return {
    documentId: record.id,
    url: `${appOrigin}${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}${record.id}`,
    ownerAccountId: record.ownerAccountId,
    contentSha256: record.descriptor.contentSha256,
    contentBytes: record.descriptor.contentBytes,
  };
}

/**
 * The dependency set every operation below is bound to.
 *
 * @param {{
 *   store: {read: Function, create: Function, update: Function},
 *   appOrigin: string,
 *   publishEnabled?: boolean,
 *   production?: boolean,
 *   now?: () => number,
 *   randomBytes?: (size: number) => Uint8Array,
 * }} dependencies
 */
function requireDependencies(dependencies) {
  if (dependencies === null || typeof dependencies !== "object") {
    throw new TypeError("publication operations require an injected dependency set");
  }
  const { store, appOrigin, publishEnabled = false, production = true } = dependencies;
  if (
    store === null ||
    typeof store !== "object" ||
    typeof store.read !== "function" ||
    typeof store.create !== "function" ||
    typeof store.update !== "function"
  ) {
    throw new TypeError("publication operations require a publication store adapter");
  }
  validateOrigin(appOrigin, { production, field: "appOrigin" });
  return {
    store,
    appOrigin,
    publishEnabled,
    production,
    now: dependencies.now ?? Date.now,
    randomBytes: dependencies.randomBytes ?? nodeRandomBytes,
  };
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * The stored record, or `null`.
 *
 * Server-internal and never an HTTP projection: it carries both secret hashes
 * and, once complete, the document itself. Handlers use `statusPublication`,
 * `reviewPublication` or `readOwnedPublication`, each of which returns only what
 * its audience is allowed to see.
 */
export async function readPublication(id, dependencies) {
  const { store } = requireDependencies(dependencies);
  const found = await store.read(id);
  return found === null ? null : found.record;
}

/**
 * The completed document, for its owner.
 *
 * Every failure is `not_found`, including "exists but is not complete" and
 * "exists and belongs to somebody else". Distinguishing them would turn this
 * endpoint into an oracle for which publication ids exist and who owns them,
 * and an authenticated account has no more business learning that than an
 * anonymous one.
 *
 * There is deliberately no receipt-expiry check. The receipt deadline bounds how
 * long the *agent bearer* can recover a result; the owner's access to their own
 * document does not expire in v1.
 */
export async function readOwnedPublication({ publicationId, principal } = {}, dependencies) {
  const { store } = requireDependencies(dependencies);
  const owner = validatePrincipal(principal);
  const found = await store.read(publicationId);
  if (found === null) throw fail("not_found", "publication not found", "publicationId");
  const { record } = found;
  if (record.state !== "complete") throw fail("not_found", "publication not found", "publicationId");
  if (record.ownerAccountId !== owner.accountId) {
    throw fail("not_found", "publication not found", "publicationId");
  }
  return record;
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

/**
 * Create the pending record and return the C3 start body.
 *
 * The two secrets are independent 256-bit values and only their digests are
 * stored, so a reader of the record - including a future operator census - can
 * neither poll the operation nor approve it. This is also the only moment either
 * secret exists in plaintext: the agent secret is returned once, and the browser
 * secret leaves only in the URL fragment, which never reaches the server as part
 * of a request line.
 *
 * `HOSTED_PUBLISH_ENABLED` is checked here rather than in the handler so that no
 * future route can start a publication by forgetting to ask.
 *
 * C6 gates the *upload* on the same flag, so `completePublication` carries the
 * second half of this check; between them they are the whole tap. What the flag
 * still does not do is revoke authorisation: an already-started publication can
 * still be approved, and it can still be cancelled or left to expire. It simply
 * cannot start, and it cannot commit bytes. Receipt recovery for a document that
 * already completed is deliberately outside the tap - see the note on the
 * already-complete branch in `completePublication` - because turning publishing
 * off must not strand a receipt that was already earned.
 */
export async function createPublication(descriptor, dependencies) {
  const { store, appOrigin, production, publishEnabled, now, randomBytes } =
    requireDependencies(dependencies);
  if (!publishEnabled) {
    throw fail("publishing_disabled", "hosted publishing is disabled on this deployment");
  }
  const validated = validateDescriptor(descriptor);

  /* A 128-bit id collides with probability nobody will ever observe, so this
     loop is not really about collisions - it is about never resolving one by
     handing the loser the winner's record. Each attempt draws a *fresh* id, so a
     collision costs one wasted round trip rather than an operation - and a fresh
     clock reading with it, because a record stamped with the time of attempt one
     would give its approver a shorter window than the contract promises. */
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const createdAtMs = now();
    const createdAt = isoAt(createdAtMs);
    const pendingExpiresAt = isoAfter(createdAtMs, HOSTED_LIMITS.PENDING_TTL_SECONDS);
    const id = Buffer.from(randomBytes(ID_BYTES)).toString("hex");
    const agentSecret = mintSecret(randomBytes);
    const browserSecret = mintSecret(randomBytes);

    const record = validatePublication({
      v: 1,
      id,
      descriptor: validated,
      state: "pending",
      agentSecretHash: sha256Hex(agentSecret),
      browserSecretHash: sha256Hex(browserSecret),
      userCode: mintUserCode(randomBytes),
      createdAt,
      pendingExpiresAt,
      ownerAccountId: null,
      uploadExpiresAt: null,
      completedAt: null,
      receiptExpiresAt: null,
      html: null,
    });

    const written = await store.create(record);
    if (written.outcome !== "created") continue;

    return validateStartResponse(
      {
        v: 1,
        publicationId: record.id,
        verificationUriComplete: `${appOrigin}${HOSTED_LIMITS.AUTHORIZE_PATH}#${browserSecret}`,
        userCode: record.userCode,
        agentSecret,
        expiresAt: record.pendingExpiresAt,
        intervalSeconds: HOSTED_LIMITS.POLL_INTERVAL_SECONDS,
      },
      { appOrigin, production },
    );
  }

  /* Every attempt hit an existing key. Whatever is wrong - an exhausted random
     source, a store returning stale answers - it is a server fault and it is
     retryable, and the colliding records stay exactly as they were. */
  throw unavailable("could not allocate a new publication");
}

/* ------------------------------------------------------------------ */
/* browser binding and approval                                        */
/* ------------------------------------------------------------------ */

/**
 * Verify the browser secret and return the server-internal binding.
 *
 * The binding is deliberately not a capability: it is the publication id plus
 * the hash already stored on the record, so a consumer that leaks it leaks
 * nothing a reader of the record did not have. AHU-007 keeps it behind an opaque
 * HttpOnly cookie; `reviewPublication` and `decidePublication` accept it only
 * from that server-side verifier, never from client JSON.
 *
 * No state or deadline is checked here on purpose. Possession of the browser
 * secret is what this call establishes, and a browser that followed the link to
 * a cancelled or expired operation still needs to reach `reviewPublication` to
 * be told so.
 */
export async function bindPublication({ publicationId, browserSecret } = {}, dependencies) {
  const { store } = requireDependencies(dependencies);
  const found = await store.read(publicationId);
  if (found === null) throw fail("not_found", "publication not found", "publicationId");
  if (!secretMatches(browserSecret, found.record.browserSecretHash)) {
    throw fail("invalid_capability", "browser secret does not match this publication");
  }
  return Object.freeze({
    publicationId: found.record.id,
    browserSecretHash: found.record.browserSecretHash,
  });
}

/** The binding a review or decision must present, checked against the record. */
function requireBinding(browserBinding, record) {
  if (
    browserBinding === null ||
    typeof browserBinding !== "object" ||
    browserBinding.publicationId !== record.id ||
    typeof browserBinding.browserSecretHash !== "string" ||
    !secretMatchesHash(browserBinding.browserSecretHash, record.browserSecretHash)
  ) {
    throw fail("invalid_capability", "browser binding does not match this publication");
  }
}

/** Constant-time equality of two stored-shaped hex digests. */
function secretMatchesHash(presentedHash, storedHash) {
  const left = Buffer.from(presentedHash, "utf8");
  const right = Buffer.from(storedHash, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * The fields the approval page may show.
 *
 * The descriptor and the user code are what the human is being asked to check;
 * the state is what tells them whether there is anything left to decide. Neither
 * secret hash and no HTML appears, in any state - including the completed one,
 * where the document exists but this browser has not proved it owns it.
 */
function reviewProjection(record, nowMs, currentAccountId) {
  return Object.freeze({
    v: 1,
    publicationId: record.id,
    descriptor: record.descriptor,
    userCode: record.userCode,
    state: effectiveState(record, nowMs),
    ownerAccountId: record.ownerAccountId,
    currentAccountId,
    expiresAt: expiresAtFor(record),
  });
}

/**
 * What the approval page renders, for an authenticated visitor holding the
 * binding.
 */
export async function reviewPublication({ publicationId, browserBinding, principal } = {}, dependencies) {
  const { store, now } = requireDependencies(dependencies);
  const visitor = validatePrincipal(principal);
  const found = await store.read(publicationId);
  if (found === null) throw fail("not_found", "publication not found", "publicationId");
  requireBinding(browserBinding, found.record);
  return reviewProjection(found.record, now(), visitor.accountId);
}

/**
 * Approve or deny, fixing the owner by compare-and-set.
 *
 * `displayedAccountId` is the account the page told the human they were acting
 * as. Confirming it against the session is what stops a stale tab from
 * publishing a document under an account the person signed out of ten minutes
 * ago - the click was consent to publish *as somebody*, and if that somebody has
 * changed the consent is no longer the one being acted on.
 *
 * The owner set here is permanent. Every later attempt to change it, from any
 * route, fails the state checks below or the compare-and-set that follows them.
 */
export async function decidePublication(
  { publicationId, browserBinding, principal, decision, displayedAccountId } = {},
  dependencies,
) {
  const { store, now } = requireDependencies(dependencies);
  const approver = validatePrincipal(principal);
  if (decision !== "approve" && decision !== "deny") {
    throw fail("invalid_request", 'decision must be "approve" or "deny"', "decision");
  }
  if (displayedAccountId !== approver.accountId) {
    throw fail(
      "csrf_failed",
      "the account shown on the approval page is not the signed-in account",
      "displayedAccountId",
    );
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const found = await store.read(publicationId);
    if (found === null) throw fail("not_found", "publication not found", "publicationId");
    const { record, etag } = found;
    requireBinding(browserBinding, record);

    /* Re-read on every attempt, so a record that reached its deadline or was
       cancelled while the previous attempt was in flight is judged as it is now
       rather than as it was when the loop started. */
    const nowMs = now();
    const current = effectiveState(record, nowMs);
    if (current === "expired") {
      throw fail("authorization_expired", "this publication can no longer be approved");
    }
    if (current !== "pending") {
      throw fail("state_conflict", `publication is already ${current}`);
    }

    const next = validatePublication(
      decision === "approve"
        ? {
            ...record,
            state: "approved",
            ownerAccountId: approver.accountId,
            uploadExpiresAt: isoAfter(nowMs, HOSTED_LIMITS.UPLOAD_TTL_SECONDS),
          }
        : { ...record, state: "denied", ownerAccountId: approver.accountId },
    );

    /* `observed` means the stored record is exactly this decision, without the
       provider having proved this call wrote it - which is what a committed
       write whose response was lost looks like. The approver asked for a state
       and that state is stored; reporting a conflict here would tell somebody
       their successful approval failed. */
    const written = await store.update(next, etag);
    if (written.outcome === "committed" || written.outcome === "observed") {
      return reviewProjection(written.record, now(), approver.accountId);
    }
  }

  throw unavailable("could not record the decision");
}

/* ------------------------------------------------------------------ */
/* agent-authorised operations                                         */
/* ------------------------------------------------------------------ */

/** The record, once the presented agent bearer has been verified against it. */
async function readForAgent(store, publicationId, agentSecret) {
  const found = await store.read(publicationId);
  if (found === null) throw fail("not_found", "publication not found", "publicationId");
  if (!secretMatches(agentSecret, found.record.agentSecretHash)) {
    throw fail("invalid_capability", "bearer does not match this publication");
  }
  return found;
}

/**
 * The C3 status envelope, built from the effective state.
 *
 * A completed record past its receipt deadline is `receipt_expired` rather than
 * a state with no receipt: the bearer's twenty-four hours of recovery are over,
 * and reporting `complete` with the result stripped would read as a publication
 * that succeeded and then lost its document. The owner can still read the
 * document; that is a different call with a different credential.
 */
function statusEnvelope(record, nowMs, { appOrigin, production }) {
  if (record.state === "complete") {
    if (nowMs >= Date.parse(record.receiptExpiresAt)) {
      throw fail("receipt_expired", "this completion receipt is no longer available");
    }
    return validateResult(
      {
        v: 1,
        state: "complete",
        expiresAt: record.receiptExpiresAt,
        intervalSeconds: HOSTED_LIMITS.POLL_INTERVAL_SECONDS,
        result: resultOf(record, appOrigin),
      },
      { appOrigin, production },
    );
  }
  return validateResult(
    {
      v: 1,
      state: effectiveState(record, nowMs),
      expiresAt: expiresAtFor(record),
      intervalSeconds: HOSTED_LIMITS.POLL_INTERVAL_SECONDS,
    },
    { appOrigin, production },
  );
}

/**
 * Poll an operation, or recover its receipt.
 *
 * Denial and cancellation come back as ordinary states here, not as errors: a
 * human declining to publish is a normal outcome of asking them, and a CLI that
 * saw it as a transport failure would retry it.
 *
 * AHU-008 may call this as an upload preflight before reading a request body -
 * it authenticates the bearer and reports the state without touching storage -
 * but `completePublication` re-checks every guard independently, because the
 * body takes time to arrive and the answer can change while it does.
 */
export async function statusPublication({ publicationId, agentSecret } = {}, dependencies) {
  const { store, appOrigin, production, now } = requireDependencies(dependencies);
  const { record } = await readForAgent(store, publicationId, agentSecret);
  return statusEnvelope(record, now(), { appOrigin, production });
}

/**
 * Cancel a pending or approved operation.
 *
 * Cancellation is a state, never a deletion. A completed publication returns its
 * unchanged receipt, because the document exists and the agent asking to cancel
 * has simply lost a race it cannot win; a denied, cancelled or expired operation
 * returns that terminal state, because cancelling something that has already
 * stopped is a no-op rather than an error.
 *
 * The one terminal state that is not a no-op is a completion whose receipt
 * window has closed: it answers `receipt_expired`, exactly as a poll would. The
 * bearer's twenty-four hours of recovery are what bound the receipt, and cancel
 * returns the receipt, so cancel is bounded by them too.
 */
export async function cancelPublication({ publicationId, agentSecret } = {}, dependencies) {
  const { store, appOrigin, production, now } = requireDependencies(dependencies);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { record, etag } = await readForAgent(store, publicationId, agentSecret);
    const nowMs = now();
    const current = effectiveState(record, nowMs);
    /* Anything already terminal - including a record that expired without
       anybody writing to it - is reported as it stands. No write, so no race
       with a completion that is in flight. */
    if (current !== "pending" && current !== "approved") {
      return statusEnvelope(record, nowMs, { appOrigin, production });
    }

    const next = validatePublication({ ...record, state: "cancelled" });
    const written = await store.update(next, etag);
    if (written.outcome === "committed" || written.outcome === "observed") {
      return statusEnvelope(written.record, now(), { appOrigin, production });
    }
  }

  throw unavailable("could not record the cancellation");
}

/**
 * Commit the approved bytes, atomically, into the same record.
 *
 * The digest and length arrive already derived from the request body by the
 * artifact layer, which owns strict UTF-8 and HTML acceptance. This layer owns
 * durable completion: it re-checks them against the *stored* descriptor on every
 * attempt, and `validatePublication` re-derives the digest from the bytes once
 * more before the write, so a caller that reports facts about bytes it did not
 * send cannot attach them to an approved descriptor.
 *
 * The deadline is checked immediately before each compare-and-set. A write
 * already submitted may land after the deadline and is kept - it was authorised
 * when it started - but a new attempt after the deadline never begins.
 *
 * Returns `{created, result}`: `created` is `true` for the write that actually
 * committed and `false` for an identical retry of an already-completed
 * publication, which is what AHU-008 maps to HTTP 201 and 200.
 */
export async function completePublication(
  { publicationId, agentSecret, html, contentSha256, contentBytes } = {},
  dependencies,
) {
  const { store, appOrigin, production, publishEnabled, now } = requireDependencies(dependencies);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { record, etag } = await readForAgent(store, publicationId, agentSecret);
    const nowMs = now();

    if (record.state === "complete") {
      /* An identical retry gets the receipt it already earned; anything else is
         a second document for an approval that covered the first. The stored
         descriptor is the authority for both comparisons, and the bytes are
         compared as well as their digest so a caller cannot claim a digest it
         did not compute. */
      if (
        record.descriptor.contentSha256 !== contentSha256 ||
        record.descriptor.contentBytes !== contentBytes ||
        !sameDocument(html, record.html)
      ) {
        throw fail("descriptor_mismatch", "this publication has already completed with other bytes");
      }
      if (nowMs >= Date.parse(record.receiptExpiresAt)) {
        throw fail("receipt_expired", "this completion receipt is no longer available");
      }
      return Object.freeze({ created: false, result: Object.freeze(resultOf(record, appOrigin)) });
    }

    /* C6's second half of the publish tap: unset or false refuses a new *upload*
       as well as a new start.

       Its position is the whole of its correctness. It sits below the
       already-complete branch above, so receipt recovery for a document that is
       already stored keeps working while publishing is off - C6 requires that
       explicitly, and a gate at the top of this function would have turned an
       earned receipt into a 503. And it sits above the state and digest checks
       below, so a refused upload never depends on how well-formed the body was.

       It is checked here rather than in the artifact handler for the same reason
       the start check lives in `createPublication`: a route cannot commit bytes
       by forgetting to ask. Note that this does not make the flag retroactive
       for an approval already given - the approval stands, and the record can
       still be cancelled or left to expire - it refuses the write itself. */
    if (!publishEnabled) {
      throw fail("publishing_disabled", "hosted publishing is disabled on this deployment");
    }

    const current = effectiveState(record, nowMs);
    if (current === "expired") {
      throw fail("authorization_expired", "the upload window for this publication has closed");
    }
    if (current === "pending") {
      throw fail("approval_required", "this publication has not been approved yet");
    }
    if (current !== "approved") {
      throw fail("state_conflict", `publication is ${current}`);
    }

    if (
      record.descriptor.contentSha256 !== contentSha256 ||
      record.descriptor.contentBytes !== contentBytes
    ) {
      throw fail("descriptor_mismatch", "the uploaded bytes are not the approved descriptor");
    }

    /* `validatePublication` re-derives the digest and byte length from `html`
       itself and re-checks the completed-state matrix, so this is where a
       mismatch between the claimed facts and the actual bytes is caught. */
    const next = validatePublication({
      ...record,
      state: "complete",
      html,
      completedAt: isoAt(nowMs),
      receiptExpiresAt: isoAfter(nowMs, HOSTED_LIMITS.RECEIPT_TTL_SECONDS),
    });

    const written = await store.update(next, etag);
    if (written.outcome === "committed") {
      return Object.freeze({
        created: true,
        result: Object.freeze(resultOf(written.record, appOrigin)),
      });
    }
    /* `observed` is the one place completion has to be stricter than its
       siblings. The document is stored and it is this caller's document, but the
       provider did not prove this call is what wrote it - so the honest answer
       is the one a retry would get. C3 reserves 201 for the write that first
       commits a document, and claiming it on an unproven write would report a
       creation that may have happened one attempt ago. */
    if (written.outcome === "observed") {
      return Object.freeze({
        created: false,
        result: Object.freeze(resultOf(written.record, appOrigin)),
      });
    }
  }

  throw unavailable("could not commit the publication");
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

/**
 * The nine operations, bound to one dependency set.
 *
 * This is the shape consumers use: `publications.statusPublication({...})` with
 * exactly the C3 argument, and no way to reach the store underneath it. The
 * module-level functions above take the same argument plus the dependency set,
 * which is what a test drives directly.
 */
export function createPublications(dependencies) {
  const resolved = requireDependencies(dependencies);
  const bind = (operation) => (argument) => operation(argument, resolved);
  return Object.freeze({
    createPublication: bind(createPublication),
    readPublication: bind(readPublication),
    bindPublication: bind(bindPublication),
    reviewPublication: bind(reviewPublication),
    decidePublication: bind(decidePublication),
    statusPublication: bind(statusPublication),
    cancelPublication: bind(cancelPublication),
    completePublication: bind(completePublication),
    readOwnedPublication: bind(readOwnedPublication),
  });
}

/**
 * The production dependency set: operator configuration plus a site-wide,
 * strongly consistent store.
 *
 * `getStore` is a parameter rather than an import so that this module still
 * links with no provider present - the hosted module gate loads every file here
 * without a credential - and so that a handler wires the provider in exactly one
 * visible place.
 */
export function publicationDependencies({ env, getStore, mode } = {}) {
  const config = readHostedConfig(env, mode === undefined ? undefined : { mode });
  return Object.freeze({
    store: createPublicationStore({ getStore }),
    appOrigin: config.appOrigin,
    production: config.production,
    publishEnabled: config.publishEnabled,
  });
}
