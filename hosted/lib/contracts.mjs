/**
 * Executable form of the hosted upload contracts v1 (blocks C2, C3, C6).
 *
 * Every later hosted trust boundary — identity (AHU-003), publication state
 * (AHU-004), the renderer (AHU-005), the CLI (AHU-006) and browser approval
 * (AHU-007) — reads the same record shapes off the wire. Written out once per
 * consumer, "the same shape" lasts exactly as long as nobody edits one copy, so
 * the shapes live here and are imported rather than restated.
 *
 * Three rules hold this module honest, and the tests in `contracts.test.mjs`
 * assert each of them directly:
 *
 *  1. **A validator returns a validated value or throws.** There is no third
 *     answer. In particular there is no "could not check" result: a caller that
 *     cannot reach a backing service has not validated anything, and must not be
 *     able to spell that outcome as success. Every throw here is a
 *     `HostedContractError` whose `code` is an invalid-input code from C3 —
 *     never `unavailable`.
 *  2. **Validators are pure.** No network, no clock, no process-global
 *     mutation, no ambient configuration. `validateOrigin` is the only function
 *     that consults a data table (the public-suffix list, statically bundled by
 *     `tldts`), and it still reads nothing from the environment. This is what
 *     lets `scripts/check-hosted-modules.mjs` import the module at CI time
 *     without a credential, and what lets a handler validate before it decides
 *     whether it is allowed to do anything at all.
 *  3. **Unknown fields are rejected.** An accepted-but-ignored field is how an
 *     owner claim smuggles itself past a boundary: the descriptor a caller
 *     supplies is untrusted, and `ownerAccountId` is set by the server from an
 *     approved browser session, never by an uploader. Rejecting the key is a
 *     cheaper guarantee than remembering to ignore it at every call site.
 *
 * Error messages name the field and the rule and never the value, because these
 * messages are returned to unauthenticated callers over C3's error envelope.
 */

import { createHash } from "node:crypto";
import { parse as parseHost } from "tldts";

/** U+0000. Spelled as an escape so this file stays free of control characters. */
const NUL = "\u0000";
/** U+FEFF, the optional leading byte-order mark C2 preserves rather than strips. */
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * The numeric and lexical bounds of contract C2, plus the C3 constants a
 * consumer would otherwise hard-code. Exported as one frozen table so a change
 * is a single reviewable diff rather than a grep across five hosted tickets.
 */
export const HOSTED_LIMITS = Object.freeze({
  /** C2: the only artifact format v1 accepts. Not ZIP, not a URL, not a manifest. */
  ARTIFACT_FORMAT: "html",
  /** C3: the exact request media type of `PUT .../artifact`. */
  ARTIFACT_MEDIA_TYPE: "text/html; charset=utf-8",
  /** C2: title bounds, counted in Unicode scalar values rather than UTF-16 units. */
  TITLE_MIN_SCALARS: 1,
  TITLE_MAX_SCALARS: 160,
  /** C2: raw artifact byte bounds, BOM included. 2 MiB. */
  HTML_MIN_BYTES: 1,
  HTML_MAX_BYTES: 2097152,
  /** Lowercase-hex field widths. */
  SHA256_HEX_LENGTH: 64,
  SECRET_HASH_HEX_LENGTH: 64,
  PUBLICATION_ID_HEX_LENGTH: 32,
  /** C1: `accountId` is the GitHub numeric ID behind a provider prefix. */
  ACCOUNT_ID_PREFIX: "gh_",
  /** C4: the owner-facing document path the C3 result URL must address. */
  DOCUMENT_PATH_PREFIX: "/docs/",
  /** C3: the poll interval the server advertises, and the floor a client honours. */
  POLL_INTERVAL_SECONDS: 5,
  /** C2 lifetimes, in seconds. Enforced on use; not a cleanup schedule. */
  PENDING_TTL_SECONDS: 900,
  UPLOAD_TTL_SECONDS: 600,
  RECEIPT_TTL_SECONDS: 86400,
  /** C3: error messages are bounded so an error cannot become a data channel. */
  ERROR_MESSAGE_MAX_LENGTH: 200,
  /**
   * The user-visible pairing code. Two groups of four from a vowel-free,
   * unambiguous alphabet: no accidental words, and no 0/O or 1/I/L to read back
   * incorrectly over a shoulder. It is a pairing check only — C3 states plainly
   * that no short-code lookup endpoint exists, so this is display grammar, not
   * a credential.
   */
  USER_CODE_PATTERN: /^[BCDFGHJKMNPQRSTVWXZ23456789]{4}-[BCDFGHJKMNPQRSTVWXZ23456789]{4}$/,
});

/** C2: every state a publication record may be in. Order is not significant. */
export const PUBLICATION_STATES = Object.freeze([
  "pending",
  "approved",
  "complete",
  "denied",
  "cancelled",
  "expired",
]);

/** C2: the states that are terminal — no further transition is legal from here. */
export const TERMINAL_PUBLICATION_STATES = Object.freeze([
  "complete",
  "denied",
  "cancelled",
  "expired",
]);

/**
 * C3's error codes and the HTTP status each is returned with. `retryable` is a
 * property of the code, not of the moment: a client that retries a
 * `descriptor_mismatch` is retrying a request that cannot start succeeding.
 */
export const ERROR_CODES = Object.freeze({
  invalid_request: Object.freeze({ status: 400, retryable: false }),
  invalid_capability: Object.freeze({ status: 401, retryable: false }),
  session_required: Object.freeze({ status: 401, retryable: false }),
  approval_required: Object.freeze({ status: 403, retryable: false }),
  forbidden: Object.freeze({ status: 403, retryable: false }),
  csrf_failed: Object.freeze({ status: 403, retryable: false }),
  not_found: Object.freeze({ status: 404, retryable: false }),
  descriptor_mismatch: Object.freeze({ status: 409, retryable: false }),
  state_conflict: Object.freeze({ status: 409, retryable: false }),
  authorization_expired: Object.freeze({ status: 410, retryable: false }),
  receipt_expired: Object.freeze({ status: 410, retryable: false }),
  artifact_too_large: Object.freeze({ status: 413, retryable: false }),
  unsupported_media_type: Object.freeze({ status: 415, retryable: false }),
  rate_limited: Object.freeze({ status: 429, retryable: true }),
  unavailable: Object.freeze({ status: 503, retryable: true }),
  publishing_disabled: Object.freeze({ status: 503, retryable: false }),
});

/**
 * The codes a validator in this module is allowed to raise. A backing service
 * that is unreachable is not a malformed request, and the reverse matters more:
 * `unavailable` must never be reachable from a validation path, because a
 * caller that treats "we could not check" as "checked" has no boundary at all.
 */
const VALIDATION_CODES = Object.freeze([
  "invalid_request",
  "artifact_too_large",
  "descriptor_mismatch",
]);

/**
 * A typed invalid-input error carrying its C3 wire code.
 *
 * The message is deliberately built from a field path and a rule, never from
 * the offending value: C3 returns these messages to unauthenticated callers, so
 * echoing input back would turn a 400 into a reflection gadget.
 */
export class HostedContractError extends Error {
  constructor(code, message, { field = null } = {}) {
    super(message);
    this.name = "HostedContractError";
    if (!Object.hasOwn(ERROR_CODES, code)) {
      throw new Error(`unknown hosted error code: ${code}`);
    }
    this.code = code;
    this.field = field;
    this.retryable = ERROR_CODES[code].retryable;
    this.status = ERROR_CODES[code].status;
  }

  /** The C3 wire envelope for this error. Frozen so a handler cannot decorate it. */
  toWire() {
    return Object.freeze({
      v: 1,
      error: Object.freeze({ code: this.code, message: this.message, retryable: this.retryable }),
    });
  }
}

/** Raise an invalid-input error. `code` is checked against the validation subset. */
function invalid(field, rule, code = "invalid_request") {
  if (!VALIDATION_CODES.includes(code)) {
    throw new Error(`validators may not raise ${code}`);
  }
  return new HostedContractError(code, `${field} ${rule}`, { field });
}

/* ------------------------------------------------------------------ */
/* primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * A record literal, and nothing that merely resembles one. Arrays, `null`, class
 * instances and objects carrying a non-`Object` prototype are all rejected: a
 * JSON body is a plain record, and anything else arrived by a route that a wire
 * validator has no business trusting.
 */
function requireRecord(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(field, "must be a JSON object");
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw invalid(field, "must be a plain JSON object");
  }
  return value;
}

/**
 * Exactly `required`: no key missing, no key extra. Reported one class at a
 * time so a caller sees the whole reason, and unknown keys are named because
 * the key name is a caller's own spelling rather than a value.
 */
function requireExactKeys(value, required, field) {
  const present = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw invalid(field, `is missing required field(s): ${missing.join(", ")}`);
  }
  const unknown = present.filter((key) => !required.includes(key));
  if (unknown.length > 0) {
    throw invalid(field, `has unknown field(s): ${unknown.join(", ")}`);
  }
}

/** A string with no lone surrogate — i.e. one that survives a UTF-8 round trip. */
function requireWellFormedString(value, field) {
  if (typeof value !== "string") throw invalid(field, "must be a string");
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw invalid(field, "is not well-formed UTF-8 text");
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw invalid(field, "is not well-formed UTF-8 text");
    }
  }
  return value;
}

/** `length` lowercase hex digits, exactly. Uppercase is a different string. */
function requireLowerHex(value, length, field) {
  requireWellFormedString(value, field);
  if (value.length !== length) throw invalid(field, `must be ${length} characters`);
  if (!/^[0-9a-f]+$/.test(value)) throw invalid(field, "must be lowercase hexadecimal");
  return value;
}

/** A safe integer within an inclusive range. `1.0` is an integer; `"1"` is not. */
function requireInteger(value, min, max, field, code = "invalid_request") {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalid(field, "must be an integer");
  }
  if (value < min) throw invalid(field, `must be at least ${min}`);
  if (value > max) throw invalid(field, `must be at most ${max}`, code);
  return value;
}

/**
 * An ISO-8601 UTC instant with millisecond precision, spelled exactly one way.
 *
 * One spelling is the point. Two records that mean the same moment must compare
 * equal as strings, because C2's ordering rules and AHU-004's conditional
 * writes both compare stored text, not parsed dates. Parsing is used only to
 * reject a syntactically well-formed impossibility such as `2026-02-30`.
 */
function requireTimestamp(value, field) {
  requireWellFormedString(value, field);
  const parsed = new Date(value);
  /* The invalid-date check is not redundant with the round trip below it:
     `toISOString()` throws a `RangeError` on an invalid date, and a `RangeError`
     escaping a validator is an uncaught 500 rather than a 400. */
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(field, "must be an ISO-8601 UTC instant with milliseconds");
  }
  /* One spelling, decided by round trip rather than by a pattern. A regular
     expression would accept `2026-02-30` and reject nothing this does not. */
  if (parsed.toISOString() !== value) {
    throw invalid(field, "must be an ISO-8601 UTC instant with milliseconds, spelled canonically");
  }
  return value;
}

/** `requireTimestamp`, or `null` when the state legitimately has no such instant. */
function requireNullableTimestamp(value, field) {
  return value === null ? null : requireTimestamp(value, field);
}

/** Assert `earlier <= later`, comparing the one canonical timestamp spelling. */
function requireOrder(earlier, later, earlierField, laterField) {
  if (Date.parse(later) < Date.parse(earlier)) {
    throw invalid(laterField, `must not precede ${earlierField}`);
  }
}

/**
 * C1: an account ID is the provider prefix and the GitHub numeric ID in
 * decimal. Usernames and email addresses are not ownership keys and cannot be
 * spelled here at all, which is the point of validating the shape rather than
 * only its presence.
 */
function requireAccountId(value, field) {
  requireWellFormedString(value, field);
  const { ACCOUNT_ID_PREFIX } = HOSTED_LIMITS;
  if (!value.startsWith(ACCOUNT_ID_PREFIX)) {
    throw invalid(field, `must begin with ${ACCOUNT_ID_PREFIX}`);
  }
  const digits = value.slice(ACCOUNT_ID_PREFIX.length);
  if (!/^[1-9][0-9]{0,19}$/.test(digits)) {
    throw invalid(field, "must carry a decimal provider user id with no leading zero");
  }
  return value;
}

/** Display text: well-formed, bounded in scalar values, and free of controls. */
function requireDisplayText(value, min, max, field) {
  requireWellFormedString(value, field);
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) {
      throw invalid(field, "must not contain control characters");
    }
  }
  const scalars = [...value].length;
  if (scalars < min) throw invalid(field, `must be at least ${min} character(s)`);
  if (scalars > max) throw invalid(field, `must be at most ${max} character(s)`);
  return value;
}

/* ------------------------------------------------------------------ */
/* C2: artifact descriptor                                             */
/* ------------------------------------------------------------------ */

const DESCRIPTOR_KEYS = Object.freeze([
  "v",
  "title",
  "contentSha256",
  "contentBytes",
  "artifactFormat",
]);

/**
 * Validate the artifact descriptor a publishing agent submits, returning a
 * frozen copy.
 *
 * The descriptor is the whole of what a human approves: the title they read and
 * the digest and length of the bytes they are agreeing to publish. Nothing else
 * belongs in it, and in particular no owner field does — the owner is fixed from
 * the approving browser session, so an `ownerAccountId` here is an injection
 * attempt and is refused by the unknown-key rule rather than ignored.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<{v: 1, title: string, contentSha256: string, contentBytes: number, artifactFormat: "html"}>}
 * @throws {HostedContractError} `invalid_request`, or `artifact_too_large` when
 *   the declared length exceeds the C2 limit.
 */
export function validateDescriptor(value, { field = "descriptor" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, DESCRIPTOR_KEYS, field);

  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  requireDisplayText(
    value.title,
    HOSTED_LIMITS.TITLE_MIN_SCALARS,
    HOSTED_LIMITS.TITLE_MAX_SCALARS,
    `${field}.title`,
  );
  requireLowerHex(value.contentSha256, HOSTED_LIMITS.SHA256_HEX_LENGTH, `${field}.contentSha256`);
  requireInteger(
    value.contentBytes,
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    `${field}.contentBytes`,
    "artifact_too_large",
  );
  if (value.artifactFormat !== HOSTED_LIMITS.ARTIFACT_FORMAT) {
    throw invalid(`${field}.artifactFormat`, `must be "${HOSTED_LIMITS.ARTIFACT_FORMAT}"`);
  }

  return Object.freeze({
    v: 1,
    title: value.title,
    contentSha256: value.contentSha256,
    contentBytes: value.contentBytes,
    artifactFormat: value.artifactFormat,
  });
}

/**
 * The artifact body, checked against the descriptor the owner approved.
 *
 * Digest and length are re-derived here rather than trusted, because the whole
 * value of the approval step is that the bytes published are the bytes
 * described. An optional UTF-8 BOM is preserved verbatim and counted, so the
 * bytes an owner later downloads hash to the digest they approved.
 */
function requireArtifactHtml(html, descriptor, field) {
  requireWellFormedString(html, field);
  if (html.includes(NUL)) throw invalid(field, "must not contain a NUL character");

  const bytes = Buffer.byteLength(html, "utf8");
  requireInteger(
    bytes,
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    field,
    "artifact_too_large",
  );

  const body = html.startsWith(BYTE_ORDER_MARK) ? html.slice(1) : html;
  if (!/<html[\s>]/i.test(body)) throw invalid(field, "must contain an HTML document element");

  if (bytes !== descriptor.contentBytes) {
    throw new HostedContractError(
      "descriptor_mismatch",
      `${field} byte length does not match the approved descriptor`,
      { field },
    );
  }
  const digest = createHash("sha256").update(Buffer.from(html, "utf8")).digest("hex");
  if (digest !== descriptor.contentSha256) {
    throw new HostedContractError(
      "descriptor_mismatch",
      `${field} digest does not match the approved descriptor`,
      { field },
    );
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* C2: publication record                                              */
/* ------------------------------------------------------------------ */

const PUBLICATION_KEYS = Object.freeze([
  "v",
  "id",
  "descriptor",
  "state",
  "agentSecretHash",
  "browserSecretHash",
  "userCode",
  "createdAt",
  "pendingExpiresAt",
  "ownerAccountId",
  "uploadExpiresAt",
  "completedAt",
  "receiptExpiresAt",
  "html",
]);

/**
 * Validate a stored publication record, returning a frozen copy.
 *
 * The state-dependent nullability rules are the reason this exists as code
 * rather than prose. C2 permits a null only where the state prescribes it, and
 * the two dangerous directions are opposite: a `pending` record carrying `html`
 * or an owner is bytes or an ownership claim that no human approved, and a
 * `complete` record missing its owner or HTML is a document that reads as
 * published while being unreadable or unowned. Both are rejected here, so no
 * handler has to remember the matrix.
 *
 * AHU-004 owns the transitions between these states; this function only decides
 * whether a record is a legal member of the state it claims.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<object>} the validated record, with its descriptor frozen
 * @throws {HostedContractError}
 */
export function validatePublication(value, { field = "publication" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, PUBLICATION_KEYS, field);

  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  requireLowerHex(value.id, HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH, `${field}.id`);
  const descriptor = validateDescriptor(value.descriptor, { field: `${field}.descriptor` });

  if (typeof value.state !== "string" || !PUBLICATION_STATES.includes(value.state)) {
    throw invalid(`${field}.state`, `must be one of: ${PUBLICATION_STATES.join(", ")}`);
  }
  const state = value.state;

  requireLowerHex(
    value.agentSecretHash,
    HOSTED_LIMITS.SECRET_HASH_HEX_LENGTH,
    `${field}.agentSecretHash`,
  );
  requireLowerHex(
    value.browserSecretHash,
    HOSTED_LIMITS.SECRET_HASH_HEX_LENGTH,
    `${field}.browserSecretHash`,
  );

  requireWellFormedString(value.userCode, `${field}.userCode`);
  if (!HOSTED_LIMITS.USER_CODE_PATTERN.test(value.userCode)) {
    throw invalid(
      `${field}.userCode`,
      "must be two four-character groups from the pairing alphabet",
    );
  }

  requireTimestamp(value.createdAt, `${field}.createdAt`);
  requireTimestamp(value.pendingExpiresAt, `${field}.pendingExpiresAt`);
  requireOrder(
    value.createdAt,
    value.pendingExpiresAt,
    `${field}.createdAt`,
    `${field}.pendingExpiresAt`,
  );

  const ownerAccountId =
    value.ownerAccountId === null
      ? null
      : requireAccountId(value.ownerAccountId, `${field}.ownerAccountId`);
  const uploadExpiresAt = requireNullableTimestamp(value.uploadExpiresAt, `${field}.uploadExpiresAt`);
  const completedAt = requireNullableTimestamp(value.completedAt, `${field}.completedAt`);
  const receiptExpiresAt = requireNullableTimestamp(
    value.receiptExpiresAt,
    `${field}.receiptExpiresAt`,
  );

  /* The state matrix. Each `absent`/`present` line below is a guard with a
     named test; removing any one of them makes a specific regression in
     `contracts.test.mjs` fail. */
  const absent = (name, actual) => {
    if (actual !== null) throw invalid(`${field}.${name}`, `must be null while state is "${state}"`);
  };
  const present = (name, actual) => {
    if (actual === null) throw invalid(`${field}.${name}`, `is required while state is "${state}"`);
  };

  if (state === "pending") {
    absent("ownerAccountId", ownerAccountId);
    absent("uploadExpiresAt", uploadExpiresAt);
    absent("completedAt", completedAt);
    absent("receiptExpiresAt", receiptExpiresAt);
    absent("html", value.html);
  } else if (state === "approved") {
    present("ownerAccountId", ownerAccountId);
    present("uploadExpiresAt", uploadExpiresAt);
    absent("completedAt", completedAt);
    absent("receiptExpiresAt", receiptExpiresAt);
    absent("html", value.html);
  } else if (state === "complete") {
    present("ownerAccountId", ownerAccountId);
    present("uploadExpiresAt", uploadExpiresAt);
    present("completedAt", completedAt);
    present("receiptExpiresAt", receiptExpiresAt);
    present("html", value.html);
  } else {
    /* denied, cancelled and expired are terminal without bytes. C2 fixes the
       owner only on approval, so these may or may not carry one depending on
       how far the operation got; what they may never carry is a document. */
    absent("completedAt", completedAt);
    absent("receiptExpiresAt", receiptExpiresAt);
    absent("html", value.html);
  }

  if (uploadExpiresAt !== null) {
    requireOrder(value.createdAt, uploadExpiresAt, `${field}.createdAt`, `${field}.uploadExpiresAt`);
  }
  if (completedAt !== null) {
    requireOrder(value.createdAt, completedAt, `${field}.createdAt`, `${field}.completedAt`);
    requireOrder(completedAt, receiptExpiresAt, `${field}.completedAt`, `${field}.receiptExpiresAt`);
  }
  if (value.html !== null) requireArtifactHtml(value.html, descriptor, `${field}.html`);

  return Object.freeze({
    v: 1,
    id: value.id,
    descriptor,
    state,
    agentSecretHash: value.agentSecretHash,
    browserSecretHash: value.browserSecretHash,
    userCode: value.userCode,
    createdAt: value.createdAt,
    pendingExpiresAt: value.pendingExpiresAt,
    ownerAccountId,
    uploadExpiresAt,
    completedAt,
    receiptExpiresAt,
    html: value.html,
  });
}

/* ------------------------------------------------------------------ */
/* C1/C6: origins                                                      */
/* ------------------------------------------------------------------ */

const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Whether a parsed host sits under a suffix the public-suffix list actually
 * knows, and therefore has a registrable site that can be compared.
 *
 * Both conditions carry their own weight, and each has a host that only it
 * refuses:
 *
 *  - `co.uk` is a public suffix with nothing registered in front of it. `tldts`
 *    reports `isIcann` and no `domain`, so the first line is what rejects it.
 *  - `app.internal` sits under an unlisted TLD, for which `tldts` falls back to
 *    a wildcard rule and returns a plausible-looking `domain` of `app.internal`
 *    with neither flag set. The second line is what rejects that.
 *
 * IP literals and `localhost` fail the first line, because neither has a
 * registrable domain at all. Accepting any of these would mean the app/renderer
 * site comparison was being made against a guess.
 */
function isDeterminateSite(host) {
  if (typeof host.domain !== "string" || host.domain === "") return false;
  return host.isIcann === true || host.isPrivate === true;
}

/**
 * Validate one configured origin, returning its canonical serialization.
 *
 * `URL.origin` is the comparison this service performs at every mutation
 * boundary, so the accepted spelling is exactly that serialization: a trailing
 * slash, a path, a query, credentials or an explicit default port are all
 * rejected rather than normalized away. Two strings that must compare equal are
 * easier to reason about than two strings that must compare equal *after* a
 * normalization step somebody could forget to apply.
 *
 * In production the origin must be HTTPS and must resolve to a determinate
 * registrable domain under the public-suffix list. IP literals and hosts whose
 * suffix cannot be determined are refused: `readHostedConfig` compares the app
 * and renderer *registrable sites*, and a comparison it cannot perform must not
 * silently pass.
 *
 * @param {unknown} value
 * @param {{production?: boolean, field?: string}} [options] `production: false`
 *   is the explicit loopback-only test mode. It never relaxes exactness — it
 *   only permits `http` on a loopback host.
 * @returns {string} the canonical origin
 * @throws {HostedContractError} `invalid_request`
 */
export function validateOrigin(value, { production = true, field = "origin" } = {}) {
  requireWellFormedString(value, field);

  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid(field, "must be an absolute URL");
  }
  /* One comparison does the work of several. `new URL` lowercases the scheme
     and host, trims surrounding whitespace, drops a default port and moves
     everything else into a path, query, fragment or credential -- so requiring
     the input to equal its own origin serialization rejects all of those
     spellings at once, and rejects them rather than quietly accepting a
     normalized version of what the operator actually wrote. */
  if (url.origin === "null" || url.origin !== value) {
    throw invalid(
      field,
      "must be exactly a lowercase scheme://host[:port] origin with no path, query or credentials",
    );
  }

  if (production) {
    if (url.protocol !== "https:") throw invalid(field, "must use https in production");
    if (!isDeterminateSite(parseHost(url.hostname, { allowPrivateDomains: true }))) {
      /* IP literals, `localhost` and unlisted suffixes all land here: none of
         them has a registrable site, so none of them can be compared against
         the other configured origin. */
      throw invalid(field, "must be a named host under a listed public suffix in production");
    }
  } else if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.includes(url.hostname)) {
      throw invalid(field, "may only use http on a loopback host in local-test mode");
    }
  } else if (url.protocol !== "https:") {
    throw invalid(field, "must use http or https");
  }

  return url.origin;
}

/**
 * The registrable site of a production origin — the unit C6 means by "different
 * registrable sites".
 *
 * The public-suffix list is consulted through pinned `tldts` with private
 * suffixes enabled, so `a.pages.dev` and `b.pages.dev` are correctly two sites
 * rather than one. Comparing the last two labels would call them the same site
 * and hand the renderer the app's cookies.
 *
 * @param {string} origin a canonical origin already accepted by `validateOrigin`
 * @param {{field?: string}} [options]
 * @returns {string} the registrable domain
 */
export function registrableSite(origin, { field = "origin" } = {}) {
  const host = parseHost(new URL(origin).hostname, { allowPrivateDomains: true });
  if (!isDeterminateSite(host)) {
    throw invalid(field, "must resolve to a determinate registrable domain");
  }
  return host.domain;
}

/* ------------------------------------------------------------------ */
/* C3: wire envelopes                                                  */
/* ------------------------------------------------------------------ */

const RESULT_KEYS = Object.freeze([
  "documentId",
  "url",
  "ownerAccountId",
  "contentSha256",
  "contentBytes",
]);
const ENVELOPE_KEYS = Object.freeze(["v", "state", "expiresAt", "intervalSeconds"]);

/**
 * Validate the C3 status / completion envelope, returning a frozen copy.
 *
 * The load-bearing rule is that `result` is present exactly when the state is
 * `complete`. A receipt attached to any other state is a success claim for a
 * document that does not exist, which is the one failure C3 names twice: denial
 * and cancellation are normal terminal states, not transport failures, and an
 * unknown state is a protocol error rather than success.
 *
 * An error envelope is refused explicitly rather than by the generic
 * unknown-key path, because "the error envelope cannot pass result validation"
 * is an acceptance criterion and deserves a message that says so.
 *
 * @param {unknown} value
 * @param {{production?: boolean, field?: string}} [options]
 * @returns {Readonly<object>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validateResult(value, { production = true, field = "result" } = {}) {
  requireRecord(value, field);
  if (Object.hasOwn(value, "error")) {
    throw invalid(field, "must not be an error envelope");
  }

  const hasResult = Object.hasOwn(value, "result");
  requireExactKeys(value, hasResult ? [...ENVELOPE_KEYS, "result"] : ENVELOPE_KEYS, field);

  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  if (typeof value.state !== "string" || !PUBLICATION_STATES.includes(value.state)) {
    throw invalid(`${field}.state`, `must be one of: ${PUBLICATION_STATES.join(", ")}`);
  }
  requireTimestamp(value.expiresAt, `${field}.expiresAt`);
  if (value.intervalSeconds !== HOSTED_LIMITS.POLL_INTERVAL_SECONDS) {
    throw invalid(`${field}.intervalSeconds`, `must be ${HOSTED_LIMITS.POLL_INTERVAL_SECONDS}`);
  }

  if (value.state === "complete" && !hasResult) {
    throw invalid(`${field}.result`, 'is required while state is "complete"');
  }
  if (value.state !== "complete" && hasResult) {
    throw invalid(`${field}.result`, 'is only permitted while state is "complete"');
  }
  if (!hasResult) {
    return Object.freeze({
      v: 1,
      state: value.state,
      expiresAt: value.expiresAt,
      intervalSeconds: value.intervalSeconds,
    });
  }

  const result = value.result;
  requireRecord(result, `${field}.result`);
  requireExactKeys(result, RESULT_KEYS, `${field}.result`);
  requireLowerHex(
    result.documentId,
    HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH,
    `${field}.result.documentId`,
  );
  requireAccountId(result.ownerAccountId, `${field}.result.ownerAccountId`);
  requireLowerHex(result.contentSha256, HOSTED_LIMITS.SHA256_HEX_LENGTH, `${field}.result.contentSha256`);
  requireInteger(
    result.contentBytes,
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    `${field}.result.contentBytes`,
    "artifact_too_large",
  );

  /* C5 forbids a guessed URL: the receipt the client prints has to be the one
     the server committed, addressing this exact document on a configured
     origin. Deriving the expected string and comparing is the only check that
     rejects a receipt pointing somewhere else entirely. */
  requireWellFormedString(result.url, `${field}.result.url`);
  let resultUrl;
  try {
    resultUrl = new URL(result.url);
  } catch {
    throw invalid(`${field}.result.url`, "must be an absolute URL");
  }
  const origin = validateOrigin(resultUrl.origin, { production, field: `${field}.result.url` });
  if (result.url !== `${origin}${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}${result.documentId}`) {
    throw invalid(
      `${field}.result.url`,
      `must be the document's own ${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}<documentId> path on its service origin`,
    );
  }

  return Object.freeze({
    v: 1,
    state: value.state,
    expiresAt: value.expiresAt,
    intervalSeconds: value.intervalSeconds,
    result: Object.freeze({
      documentId: result.documentId,
      url: result.url,
      ownerAccountId: result.ownerAccountId,
      contentSha256: result.contentSha256,
      contentBytes: result.contentBytes,
    }),
  });
}

/**
 * Validate the C3 error envelope, returning a frozen copy.
 *
 * `retryable` is derived from the code rather than believed, so a service that
 * marks `descriptor_mismatch` retryable cannot talk a client into a retry loop
 * against a request that can never succeed. The message bound keeps an error
 * from becoming a data channel back to an unauthenticated caller.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<{v: 1, error: Readonly<{code: string, message: string, retryable: boolean}>}>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validateWireError(value, { field = "errorEnvelope" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, ["v", "error"], field);
  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");

  const error = value.error;
  requireRecord(error, `${field}.error`);
  requireExactKeys(error, ["code", "message", "retryable"], `${field}.error`);

  requireWellFormedString(error.code, `${field}.error.code`);
  if (!Object.hasOwn(ERROR_CODES, error.code)) {
    throw invalid(`${field}.error.code`, "must be a contract error code");
  }
  requireDisplayText(error.message, 1, HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH, `${field}.error.message`);
  if (typeof error.retryable !== "boolean") throw invalid(`${field}.error.retryable`, "must be a boolean");
  if (error.retryable !== ERROR_CODES[error.code].retryable) {
    throw invalid(`${field}.error.retryable`, "must match the retryability of its code");
  }

  return Object.freeze({
    v: 1,
    error: Object.freeze({ code: error.code, message: error.message, retryable: error.retryable }),
  });
}
