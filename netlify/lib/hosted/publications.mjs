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
  PUBLICATION_RECORD_VERSION,
  validateDescriptor,
  validateOrigin,
  validatePrincipal,
  validatePublication,
  validateResult,
  validateStartResponse,
} from "./contracts.mjs";
import { DomainAccessError, evaluateAccess, normalizeDomainList } from "./domain-access.mjs";
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
  const {
    store,
    appOrigin,
    publishEnabled = false,
    production = true,
    allowPublicMailboxes = false,
  } = dependencies;
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
    allowPublicMailboxes,
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

/**
 * The completed document, for its owner **or for a listed domain reader**.
 *
 * This is `readOwnedPublication` with one predicate swapped, and the swap is
 * deliberately the only difference: same `not_found` for every refused case,
 * same absence of a receipt-expiry check, same single answer for "missing",
 * "not complete" and "not yours". What it adds is `evaluateAccess`, which is the
 * one place in this repository that decides whether a domain admits a reader -
 * so the viewer page, the metadata route and the content route reach the same
 * verdict for the same principal by construction rather than by three handlers
 * agreeing.
 *
 * The one refusal that is *not* collapsed is `email_unverified`. It reaches the
 * caller as its own code because a reader whose own domain is listed has an
 * action to take, and `evaluateAccess` only answers it when the domain really is
 * on this document's list - so it says no more about the document than the
 * reader's own claimed address already did.
 *
 * @returns {Promise<{record: object, role: string}>}
 */
export async function readAccessiblePublication(
  { publicationId, principal, explicitRole = null } = {},
  dependencies,
) {
  const { store } = requireDependencies(dependencies);
  const reader = validatePrincipal(principal);
  const found = await store.read(publicationId);

  /* A missing record still goes through the evaluator rather than short-
     circuiting, so that "no such document" and "a document you may not read"
     leave this function through one line and cannot acquire different
     behaviour later. */
  const decision = evaluateAccess({
    record: found === null ? null : found.record,
    principal: reader,
    explicitRole,
  });
  if (!decision.allowed) {
    if (decision.reason === "email_unverified") {
      throw fail("email_unverified", "verify your email address to read this document");
    }
    throw fail("not_found", "publication not found", "publicationId");
  }
  return { record: found.record, role: decision.role };
}

/**
 * The owner's view of a document's domain list.
 *
 * Owner-only, and refused as `not_found` for anybody else - including for an
 * account that would be admitted to *read* the document by one of the domains
 * on this very list. Reading the policy is an owner's act; a reader admitted by
 * it has no business enumerating who else is.
 */
export async function readPublicationAccess({ publicationId, principal } = {}, dependencies) {
  const { allowPublicMailboxes } = requireDependencies(dependencies);
  const record = await readOwnedPublication({ publicationId, principal }, dependencies);
  return Object.freeze({
    v: 1,
    publicationId: record.id,
    allowedDomains: [...record.allowedDomains],
    allowPublicMailboxes,
  });
}

/**
 * Replace a document's domain list, as its owner.
 *
 * ## Why this is a read-merge-write loop rather than a write
 *
 * The record carries a lifecycle that other requests move. A blind
 * `store.update` built from a record read a moment ago would carry that stale
 * lifecycle back over a concurrent transition - a cancellation, an expiry - and
 * the compare-and-set would not catch it, because the ETag it was built against
 * is the one it would present. So the loop re-reads on every attempt, re-checks
 * ownership and completeness against what is *now* stored, and changes exactly
 * one field. `refused` means somebody else wrote in between, and the answer to
 * that is to look again rather than to insist.
 *
 * ## Why the list is normalized before the loop
 *
 * The caller's list is bad or good independently of what is in the store, so
 * rejecting it costs no store round trip - and an owner who sent `gmail.com`
 * gets that answer rather than a retry storm.
 */
export async function replacePublicationAccess(
  { publicationId, principal, allowedDomains } = {},
  dependencies,
) {
  const { store, allowPublicMailboxes } = requireDependencies(dependencies);
  const owner = validatePrincipal(principal);
  const normalized = normalizeAccessList(allowedDomains, allowPublicMailboxes);

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const found = await store.read(publicationId);
    if (found === null) throw fail("not_found", "publication not found", "publicationId");
    const { record, etag } = found;
    if (record.state !== "complete" || record.ownerAccountId !== owner.accountId) {
      throw fail("not_found", "publication not found", "publicationId");
    }

    /* Nothing to write is still a success, and skipping the write is not an
       optimisation: a conditional write of an identical record is a real race
       an idempotent caller should not be able to lose. */
    if (sameDomains(record.allowedDomains, normalized)) {
      return accessProjection(record, allowPublicMailboxes);
    }

    const next = validatePublication({ ...record, allowedDomains: normalized });
    const written = await store.update(next, etag);
    if (written.outcome === "committed" || written.outcome === "observed") {
      return accessProjection(written.record, allowPublicMailboxes);
    }
  }
  throw unavailable("could not be updated");
}

/** The `GET` shape, which the `PUT` answers with so both agree by construction. */
function accessProjection(record, allowPublicMailboxes) {
  return Object.freeze({
    v: 1,
    publicationId: record.id,
    allowedDomains: [...record.allowedDomains],
    allowPublicMailboxes,
  });
}

/** Two stored lists, both already sorted and unique, holding the same policy. */
function sameDomains(left, right) {
  return left.length === right.length && left.every((domain, index) => domain === right[index]);
}

/**
 * The caller's list as a stored list, or this module's typed refusal.
 *
 * `DomainAccessError` is translated here rather than at the route, so that every
 * caller of the adapter - the route, a future CLI, a test - gets the same C3
 * code for the same bad list. The evaluator's `reason` is already a C3 code and
 * its message already names the offending domain, which is where the domain has
 * to live: the C3 envelope has no field of its own for it, and the value has
 * already been bounded and stripped to domain characters before it got here.
 */
function normalizeAccessList(allowedDomains, allowPublicMailboxes) {
  try {
    return normalizeDomainList(allowedDomains, { allowPublicMailboxes });
  } catch (error) {
    if (!(error instanceof DomainAccessError)) throw error;
    throw fail(error.reason, error.message, "allowedDomains");
  }
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
      v: PUBLICATION_RECORD_VERSION,
      id,
      descriptor: validated,
      state: "pending",
      agentSecretHash: sha256Hex(agentSecret),
      browserSecretHash: sha256Hex(browserSecret),
      userCode: mintUserCode(randomBytes),
      createdAt,
      pendingExpiresAt,
      /* Nobody has claimed the approval yet. `start` is anonymous by
         construction - it mints the capability rather than checking one - so
         there is no account to record here, and the first person to present the
         link or the pairing code from a signed-in browser becomes the claimant.
         See `claimPublication`. */
      claimantAccountId: null,
      ownerAccountId: null,
      /* No owner yet, and therefore no owner email. Both are set once, by the
         approval below, from the session that authorized it. */
      ownerEmail: null,
      /* Nobody may read a document that has not been approved yet, so an empty
         list is the only legal starting policy. The owner sets one afterwards
         through the access route. */
      allowedDomains: [],
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
        /* Both halves, because the approval page has no other way to learn which
           operation the secret belongs to: C3 permits no query string on this
           path, no short-code lookup and no lookup by browser secret, and
           `bindPublication` needs the id. `validateStartResponse` holds this
           exact shape. */
        verificationUriComplete: `${appOrigin}${HOSTED_LIMITS.AUTHORIZE_PATH}#${record.id}.${browserSecret}`,
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
 * The recovery address to stamp beside an owner key, or `null`.
 *
 * Only a verified address is stored. An unverified one identifies nobody - it is
 * a string the account holder typed - and recording it would offer an operator a
 * match that is not evidence of anything. `null` is the honest answer for an
 * approver whose identity carries no verified address.
 */
function ownerEmailOf(approver) {
  return approver.emailVerified ? approver.email : null;
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
            ownerEmail: ownerEmailOf(approver),
            uploadExpiresAt: isoAfter(nowMs, HOSTED_LIMITS.UPLOAD_TTL_SECONDS),
          }
        : {
            ...record,
            state: "denied",
            ownerAccountId: approver.accountId,
            ownerEmail: ownerEmailOf(approver),
          },
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
/* self-serve: claiming an approval and listing what is waiting        */
/* ------------------------------------------------------------------ */

/**
 * The one refusal every self-serve failure is spelled with.
 *
 * A code that names nothing, a code that names something terminal, a code
 * somebody else already claimed, and an id this caller has no capability for
 * all answer with this identical error. That is the whole anti-oracle property
 * of `/publish/approve`: a person typing codes learns only whether *they* can
 * approve something, never whether a publication exists.
 *
 * `not_found` rather than `invalid_capability` for the same reason - the second
 * one would confirm that the thing being named is real.
 */
function noPendingMatch() {
  return fail("not_found", "no pending publication matches", "publication");
}

/**
 * A typed pairing code in the shape the minter produces, or null.
 *
 * People type a code off a screen, so spaces, lower case and a missing dash are
 * ordinary rather than hostile and are all normalised away. Anything that is
 * still not the recommended grammar afterwards is refused before a single store
 * read: the grammar is public, so failing early leaks nothing, and it keeps a
 * stream of junk from turning into a stream of enumerations.
 */
export function normalizeUserCode(value) {
  if (typeof value !== "string" || value.length > HOSTED_LIMITS.USER_CODE_MAX_SCALARS) return null;
  const bare = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  if (bare.length !== 8) return null;
  const code = `${bare.slice(0, 4)}-${bare.slice(4)}`;
  return HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN.test(code) ? code : null;
}

/** Constant-time equality of two same-shaped display strings. */
function codeMatches(presented, stored) {
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(stored, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** The store adapter's census, or a clear programming fault. */
function requireCensus(store) {
  if (typeof store.list !== "function") {
    throw new TypeError("this operation requires a publication store with a census");
  }
  return store.list;
}

/**
 * The pending record a typed pairing code names, with its ETag, or a refusal.
 *
 * A linear census, because the store is keyed by publication id and a code is
 * not a key. That is affordable precisely because it is bounded on both sides:
 * `list` reads at most `MAX_LIST_RECORDS` records, and the route above this one
 * is rate limited the same way the anonymous start route is. It is not a design
 * that would survive a hundred thousand documents, and the honest place to fix
 * that is a code-to-id index rather than a laxer refusal here.
 *
 * Records that are not pending are skipped rather than matched and then
 * refused, so a code that was recycled by a later minting cannot be shadowed by
 * a terminal record holding the same value.
 */
async function findPendingByUserCode(store, code, nowMs) {
  const census = requireCensus(store);
  const { records } = await census.call(store);
  for (const record of records) {
    if (effectiveState(record, nowMs) !== "pending") continue;
    if (codeMatches(code, record.userCode)) return record.id;
  }
  return null;
}

/**
 * Bind a signed-in person to a pending publication they can prove they were
 * sent, and hand back the browser binding that reaches its approval.
 *
 * ## What this does not do
 *
 * It does not approve anything and it does not fix an owner. `decidePublication`
 * is untouched: it still demands the exact `Origin`, a live session, the
 * session-bound CSRF token and the `__Host-archon_publish` binding, and the
 * owner it writes is still the session's account. This call is a *way to reach*
 * that gate for a person who has the capability but has lost the page, which is
 * the whole of #254: during a live run the operator could not find the link the
 * agent had sent several times, and the approval window was expiring.
 *
 * ## The three proofs, and why each one is a capability
 *
 *  - **the pairing code**, typed on `/publish/approve`. The code is minted from
 *    128 bits of rejection-sampled randomness, travels only to the person the
 *    agent is talking to, and is exactly the value C2 already asks them to check
 *    against their agent's output. Presenting it proves the same thing
 *    presenting the link does.
 *  - **the browser binding**, held by the approval page after it exchanged the
 *    link's secret. This is the claim the ordinary flow makes: the person opened
 *    the link and then signed in, and from that moment the operation is theirs
 *    on any device that account signs in on, not merely in that tab.
 *  - **an existing claim by this same account**, which is how the pending list's
 *    Approve button re-issues a binding whose fifteen minutes ran out while the
 *    person was reading their email.
 *
 * Nothing else is accepted. In particular a bare publication id is not a proof:
 * ids appear in document URLs and in receipts, and treating one as sufficient
 * would let any signed-in account take over any pending publication whose id it
 * could see or guess.
 *
 * ## First claim wins, permanently
 *
 * A record already claimed by another account refuses with the same
 * `not_found` every other failure uses, *including* to a caller presenting the
 * correct pairing code. Two people cannot hold one approval, and telling the
 * second one that the code was right would turn a refusal into a confirmation.
 *
 * @returns {Promise<Readonly<{publicationId: string, binding: {publicationId: string, browserSecretHash: string}, expiresAt: string}>>}
 */
export async function claimPublication(
  { publicationId, userCode, browserBinding, principal } = {},
  dependencies,
) {
  const { store, now } = requireDependencies(dependencies);
  const claimant = validatePrincipal(principal);

  /* The code path resolves an id first, so from here both paths are the same
     code. A caller that sends both is answered on the code, which is the
     stronger of the two proofs. */
  let targetId = publicationId;
  let provedByCode = false;
  if (userCode !== undefined && userCode !== null) {
    const code = normalizeUserCode(userCode);
    if (code === null) throw noPendingMatch();
    const found = await findPendingByUserCode(store, code, now());
    if (found === null) throw noPendingMatch();
    targetId = found;
    provedByCode = true;
  }
  if (typeof targetId !== "string") throw noPendingMatch();

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const found = await store.read(targetId).catch((error) => {
      /* A malformed id is the caller naming something that cannot exist, and
         that is the same answer as naming something that does not. A storage
         failure is not, and is re-thrown. */
      if (error instanceof HostedContractError && error.code === "invalid_request") {
        throw noPendingMatch();
      }
      throw error;
    });
    if (found === null) throw noPendingMatch();
    const { record, etag } = found;

    /* Ordered so that a caller with no capability learns nothing about the
       record's state: every branch below is the same refusal. */
    const proved =
      provedByCode ||
      (browserBinding !== undefined &&
        browserBinding !== null &&
        bindingMatches(browserBinding, record)) ||
      (record.claimantAccountId !== null && record.claimantAccountId === claimant.accountId);
    if (!proved) throw noPendingMatch();
    if (effectiveState(record, now()) !== "pending") throw noPendingMatch();
    if (record.claimantAccountId !== null && record.claimantAccountId !== claimant.accountId) {
      throw noPendingMatch();
    }

    const binding = Object.freeze({
      publicationId: record.id,
      browserSecretHash: record.browserSecretHash,
    });
    if (record.claimantAccountId === claimant.accountId) {
      /* Already this person's. Re-issuing the binding is the whole point of the
         repeat call and there is nothing to write. */
      return Object.freeze({
        publicationId: record.id,
        binding,
        expiresAt: record.pendingExpiresAt,
      });
    }

    const next = validatePublication({ ...record, claimantAccountId: claimant.accountId });
    const written = await store.update(next, etag);
    if (written.outcome === "committed" || written.outcome === "observed") {
      return Object.freeze({
        publicationId: record.id,
        binding,
        expiresAt: record.pendingExpiresAt,
      });
    }
    /* `refused` means somebody else wrote the record between the read and the
       write - most plausibly the other half of a double-click, or the agent
       cancelling. The loop re-reads and re-judges, and a claim that now belongs
       to another account is refused on the next pass rather than overwritten. */
  }

  throw unavailable("could not record the claim");
}

/** Whether a presented binding is the one this record's link would produce. */
function bindingMatches(browserBinding, record) {
  return (
    typeof browserBinding === "object" &&
    browserBinding.publicationId === record.id &&
    typeof browserBinding.browserSecretHash === "string" &&
    secretMatchesHash(browserBinding.browserSecretHash, record.browserSecretHash)
  );
}

/**
 * The fields the pending list may show for one waiting publication.
 *
 * The same bound as the review projection, minus the account: neither secret
 * hash, no HTML, and nothing about any record this person did not claim. The
 * pairing code is here because it is what lets somebody with two agents running
 * tell the two rows apart, and because the person is already entitled to it -
 * they proved they hold it, or they followed the link that carries it.
 */
function pendingProjection(record) {
  return Object.freeze({
    publicationId: record.id,
    title: record.descriptor.title,
    contentBytes: record.descriptor.contentBytes,
    userCode: record.userCode,
    createdAt: record.createdAt,
    expiresAt: record.pendingExpiresAt,
  });
}

/**
 * Every pending publication this account has claimed, and nothing else.
 *
 * The filter is an equality against `claimantAccountId` and it is applied here,
 * in the only place that reads the census, rather than in the route: a route
 * that received unfiltered records could ship one by projecting the wrong
 * variable, and there would be nothing in this module to fail when it did.
 *
 * A record that is not claimed by exactly this account is not merely omitted
 * from the body - it is never projected at all, so there is no shape in which
 * another person's title, code or id can reach this caller. An unreadable
 * record is skipped for the same reason: the census cannot say whose it is, and
 * an operator census (`/api/hosted/admin/documents`) is where an unreadable
 * record is meant to surface.
 *
 * @returns {Promise<Readonly<{v: 1, publications: object[], truncated: boolean}>>}
 */
export async function listClaimedPendingPublications({ principal } = {}, dependencies) {
  const { store, now } = requireDependencies(dependencies);
  const viewer = validatePrincipal(principal);
  const census = requireCensus(store);
  const { records, truncated } = await census.call(store);
  const nowMs = now();

  const mine = records
    .filter(
      (record) =>
        record.claimantAccountId !== null &&
        record.claimantAccountId === viewer.accountId &&
        effectiveState(record, nowMs) === "pending",
    )
    .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))
    .map(pendingProjection);

  return Object.freeze({ v: 1, publications: mine, truncated });
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
    readAccessiblePublication: bind(readAccessiblePublication),
    readPublicationAccess: bind(readPublicationAccess),
    replacePublicationAccess: bind(replacePublicationAccess),
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
    allowPublicMailboxes: config.allowPublicMailboxes,
  });
}
