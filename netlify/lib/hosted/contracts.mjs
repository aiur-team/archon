/**
 * Executable form of the hosted upload contracts (blocks C1-C6), with identity
 * at C1 v2.
 *
 * ## `accountId` is tenant-scoped, and `ownerEmail` is how ownership is recovered
 *
 * An `accountId` is a digest of the identity tenant's subject. Subjects are the
 * tenant's to issue, so a tenant that is recreated - a new Auth0 domain, a
 * restored-from-nothing directory - issues different subjects to the same
 * people, and every previously stored owner key becomes unmatchable. Nothing in
 * this module can prevent that, and pretending otherwise by linking identities
 * would be worse: two providers reaching one person are two identities here, on
 * purpose, and are documented as such rather than merged.
 *
 * What the contract does instead is keep the approver's verified email on the
 * publication record beside the owner key, as `ownerEmail`. It is recovery
 * metadata for an operator, is never consulted for access, and is the reason a
 * document is not orphaned by a tenant migration.
 *
 * Every later hosted trust boundary - identity (AHU-003), publication state
 * (AHU-004), the renderer (AHU-005), the CLI (AHU-006), browser approval
 * (AHU-007) and the owner viewer (AHU-009) - reads the same record shapes off
 * the same wire. Written out once per consumer, "the same shape" lasts exactly
 * as long as nobody edits one copy, so the shapes live here and are imported
 * rather than restated.
 *
 * Four rules hold this module honest, and the tests in
 * `netlify/test/hosted/contracts.test.mjs` assert each of them directly:
 *
 *  1. **A validator returns a validated value or throws.** There is no third
 *     answer. In particular there is no "could not check" result: a caller that
 *     cannot reach a backing service has not validated anything, and must not be
 *     able to spell that outcome as success. Every rejection here is a
 *     `HostedContractError` whose `code` is an invalid-input code from C3 -
 *     never `unavailable`.
 *  2. **Validators are pure.** No network, no clock, no process-global
 *     mutation, no ambient configuration. `validateOrigin` is the only function
 *     that consults a data table (the public-suffix list, statically bundled by
 *     `tldts`), and it still reads nothing from the environment. This is what
 *     lets `scripts/check-function-modules.mjs` import the module at CI time
 *     without a credential, and what lets a handler validate before it decides
 *     whether it is allowed to do anything at all.
 *  3. **Unknown fields are rejected.** An accepted-but-ignored field is how an
 *     owner claim smuggles itself past a boundary: the descriptor a caller
 *     supplies is untrusted, and `ownerAccountId` is set by the server from an
 *     approved browser session, never by an uploader. Rejecting the key is a
 *     cheaper guarantee than remembering to ignore it at every call site.
 *  4. **An error message is always a legal C3 message.** Messages are built
 *     from a field path and a rule rather than from the offending value, and
 *     `HostedContractError` additionally sanitizes and bounds whatever it is
 *     handed. That belt-and-braces matters because these messages are returned
 *     to unauthenticated callers: a validator that could emit an envelope
 *     `validateWireError` would reject is a validator that can be turned into a
 *     reflection channel by an attacker-chosen field name.
 *
 * Static imports only. `scripts/check-function-modules.mjs` observes what Node
 * actually resolves for every module in the hosted deploy tree, which is exact
 * for a static import and impossible for a dynamic one inside a function body -
 * so dynamic import is refused outright in this tree.
 */

import { createHash } from "node:crypto";
import { parse as parseHost } from "tldts";

/** U+0000. Spelled as an escape so this file stays free of control characters. */
const NUL = "\u0000";
/** U+FEFF, the optional leading byte-order mark C2 preserves rather than strips. */
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * The sniff that separates an HTML artifact from bytes that are not markup.
 *
 * Markup, not a document element. An artifact is a *fragment*:
 * `docbuild`'s `layout.html` opens at `<meta name="doc-id">` and emits no
 * doctype and no `<html>` element, because `renderer/public/renderer.js`
 * supplies the document element itself and places the stored bytes inside a
 * sandboxed `srcdoc` body. Requiring `<html>` here rejected every artifact the
 * builder can produce, and rejected it *after* an owner had approved the
 * descriptor \u2014 the worst point in the flow to discover a disagreement about
 * shape. What the rule is for is refusing a PDF, a JSON dump or a page of
 * notes, and the rule below still refuses all three.
 *
 * `templates/docbuild/src/publish.ts` applies the identical rule locally,
 * before anything is sent, so the two never disagree about the same bytes.
 *
 * A *closing* tag rather than any start tag, because "looks like a tag" is not
 * a property prose lacks: `a<b and c>d` satisfies a start-tag pattern and is
 * plainly not markup. Requiring `</name>` (or a doctype, or a self-closing
 * element) costs a real document nothing -- an artifact with no closing tag
 * anywhere is not a document -- and refuses the notes file somebody pointed
 * `--file` at by mistake.
 */
const HTML_MARKUP = /<!doctype\s+html|<\/[a-z][a-z0-9-]*\s*>|<[a-z][a-z0-9-]*(\s[^<>]*)?\/>/i;

/**
 * Characters that must never appear in text a human reads to make a decision.
 *
 * `Cc`/`Cf` are the control and format categories, `Zl`/`Zp` the line and
 * paragraph separators. Rejecting the whole of `Cf` is deliberate and slightly
 * blunt: it covers the bidirectional overrides and isolates (U+202A-202E,
 * U+2066-2069) that turn a title of `Invoice` + U+202E + `gpj.exe` into one that
 * renders as `Invoice exe.jpg`,
 * the zero-width characters that let a title display as empty while satisfying
 * a one-character minimum, and the soft hyphen. The approval screen is where a
 * person decides whether to publish a document; text that renders differently
 * from its bytes there is a way to steer that decision, and no legitimate title
 * needs a format character to be readable.
 */
const UNSAFE_DISPLAY = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/**
 * The numeric and lexical bounds of contracts C1-C3, plus the constants a
 * consumer would otherwise hard-code. Exported as one frozen table so a change
 * is a single reviewable diff rather than a grep across nine hosted tickets.
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
  /** C1 v2: `accountId` is a truncated digest of the subject behind this prefix. */
  ACCOUNT_ID_PREFIX: "a0_",
  /** C1 v2: the only identity provider the hosted tree accepts. */
  IDENTITY_PROVIDER: "auth0",
  /** C1 v2: the widest subject the identity tenant may hand us. */
  SUBJECT_MAX_LENGTH: 256,
  /**
   * C1 v2: how much of the subject digest `accountId` carries.
   *
   * Fixed, not tunable. Shortening it widens the space in which two subjects
   * share one ownership key; lengthening it renames every stored owner. The
   * derivation is asserted against a literal worked example in
   * `netlify/test/hosted/contracts.test.mjs`, so a change here fails there first.
   */
  ACCOUNT_ID_HASH_HEX_LENGTH: 32,
  /** C1 v2: the widest stored email, matching the collaboration layer's bound. */
  EMAIL_MAX_LENGTH: 254,
  /** C1/C4: the two app paths a contract record may address. */
  DOCUMENT_PATH_PREFIX: "/docs/",
  AUTHORIZE_PATH: "/publish/authorize",
  /** C3: the poll interval the server advertises, and the floor a client honours. */
  POLL_INTERVAL_SECONDS: 5,
  /** C2 lifetimes, in seconds. Enforced on use; not a cleanup schedule. */
  PENDING_TTL_SECONDS: 900,
  UPLOAD_TTL_SECONDS: 600,
  RECEIPT_TTL_SECONDS: 86400,
  /** C3: error messages are bounded so an error cannot become a data channel. */
  ERROR_MESSAGE_MAX_LENGTH: 200,
  /** Bounds for opaque bearer/CSRF material carried on the wire (base64url-ish). */
  OPAQUE_TOKEN_MIN_LENGTH: 32,
  OPAQUE_TOKEN_MAX_LENGTH: 256,
  /** C1 v2: the display-name bound on `login`, which is display text only. */
  LOGIN_MAX_LENGTH: 39,
  /**
   * The pairing-code grammar this producer recommends AHU-004 mint: two groups
   * of four from a vowel-free, unambiguous alphabet, so there are no accidental
   * words and no 0/O or 1/I/L to read back incorrectly over a shoulder.
   *
   * It is **advice, not a validation rule**. C2 says `userCode: string` and
   * nothing more, so `validatePublication` enforces only that - a shared
   * validator that demanded this alphabet would silently amend the frozen
   * contract for every sibling that mints or projects a code.
   */
  RECOMMENDED_USER_CODE_PATTERN: /^[BCDFGHJKMNPQRSTVWXZ23456789]{4}-[BCDFGHJKMNPQRSTVWXZ23456789]{4}$/,
  /** C2: the user code is display text; this is the only bound the contract implies. */
  USER_CODE_MAX_SCALARS: 40,
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

/** C2: the states that are terminal - no further transition is legal from here. */
export const TERMINAL_PUBLICATION_STATES = Object.freeze([
  "complete",
  "denied",
  "cancelled",
  "expired",
]);

/** C4: the only two message types that cross the app/renderer origin boundary. */
export const RENDER_MESSAGE_TYPES = Object.freeze({
  READY: "archon:ready",
  RENDER: "archon:render",
});

/**
 * C3's error codes with the HTTP status each is returned with and whether a
 * client may retry.
 *
 * C3 fixes the codes and statuses; it does not say which are retryable, but the
 * envelope carries a `retryable` field, so somebody has to decide. Deciding it
 * once here beats deciding it separately in the CLI, the handlers and the
 * runbook - and it makes retryability a property of the code rather than of the
 * moment, so a client that retries a `descriptor_mismatch` is retrying a request
 * that cannot start succeeding.
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
 * A message that is guaranteed to be a legal C3 message, whatever it was built
 * from.
 *
 * Every call site here already builds messages out of field paths and rules
 * rather than values, but one of those paths interpolates a key name the caller
 * chose, and a caller-chosen key can be three hundred characters long or carry
 * a control character. That would let this module emit an envelope
 * `validateWireError` rejects - an inconsistency in its own contract, on the
 * one path that reaches an unauthenticated client. Sanitizing unconditionally
 * here means no future message site has to remember.
 */
function safeMessage(text) {
  const cleaned = String(text).replace(new RegExp(UNSAFE_DISPLAY, "gu"), " ").trim();
  if (cleaned === "") return "invalid request";
  const scalars = [...cleaned];
  if (scalars.length <= HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH) return cleaned;
  return `${scalars.slice(0, HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH - 1).join("").trim()}…`;
}

/**
 * A typed invalid-input error carrying its C3 wire code, HTTP status and
 * retryability.
 */
export class HostedContractError extends Error {
  constructor(code, message, { field = null } = {}) {
    super(safeMessage(message));
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

/** Build an invalid-input error naming a field and the rule it broke. */
function invalid(field, rule, code = "invalid_request") {
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
 * A bounded, printable rendering of caller-supplied key names.
 *
 * The key name is the one part of a rejection message that comes from the
 * caller, so it is the one part that has to be defanged: at most three keys, at
 * most 32 characters each, and only characters a JavaScript identifier or JSON
 * key would legitimately use.
 */
function safeKeyNames(keys) {
  const shown = keys.slice(0, 3).map((key) => {
    const printable = [...String(key)].filter((c) => /[A-Za-z0-9_.-]/.test(c)).join("");
    return printable === "" ? "<unprintable>" : printable.slice(0, 32);
  });
  return keys.length > 3 ? `${shown.join(", ")} and ${keys.length - 3} more` : shown.join(", ");
}

/**
 * Exactly `required`: no key missing, no key extra. Reported one class at a
 * time so a caller sees the whole reason.
 */
function requireExactKeys(value, required, field) {
  const present = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    throw invalid(field, `is missing required field(s): ${safeKeyNames(missing)}`);
  }
  const unknown = present.filter((key) => !required.includes(key));
  if (unknown.length > 0) {
    throw invalid(field, `has unknown field(s): ${safeKeyNames(unknown)}`);
  }
}

/** A string with no lone surrogate - i.e. one that survives a UTF-8 round trip. */
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
 * writes both compare stored text, not parsed dates. Anything `Date#toISOString`
 * would render differently is refused rather than normalized.
 */
function requireTimestamp(value, field) {
  requireWellFormedString(value, field);
  const parsed = new Date(value);
  /* Not redundant with the round trip below: `toISOString()` throws a
     `RangeError` on an invalid date, and a `RangeError` escaping a validator is
     an uncaught 500 rather than a 400. */
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
 * C1 v2: the raw identity-tenant subject, `<connection>|<id>`.
 *
 * The subject is carried verbatim rather than split: the connection half and the
 * id half only mean anything together, and a rule that parsed them would invite
 * a caller to key on one of them. It is not an ownership key on its own - the
 * digest below is - and it is never a display value.
 *
 * An email address in this position has no `|` and is refused by the pattern,
 * which matters because an email is the one value a careless producer is most
 * likely to put here.
 */
function requireProviderUserId(value, field) {
  requireWellFormedString(value, field);
  if (value !== value.trim()) throw invalid(field, "must not begin or end with whitespace");
  if (value.length > HOSTED_LIMITS.SUBJECT_MAX_LENGTH) {
    throw invalid(field, `must be at most ${HOSTED_LIMITS.SUBJECT_MAX_LENGTH} characters`);
  }
  if (!/^[a-z0-9-]+\|.+$/.test(value)) {
    throw invalid(field, "must be a provider subject spelled <connection>|<id>");
  }
  return value;
}

/**
 * The one derivation of an account identifier from a subject.
 *
 * Exported so the identity adapters construct the ownership key by calling this
 * rather than by restating it. A second spelling of the hash anywhere else is a
 * second derivation, and the cross-reference in `validatePrincipal` exists
 * precisely because there must only be one.
 *
 * @param {string} providerUserId a subject that has passed `requireProviderUserId`
 * @returns {string} `a0_` followed by 32 lowercase hex characters
 */
export function deriveAccountId(providerUserId) {
  requireProviderUserId(providerUserId, "providerUserId");
  const digest = createHash("sha256").update(Buffer.from(providerUserId, "utf8")).digest("hex");
  return `${HOSTED_LIMITS.ACCOUNT_ID_PREFIX}${digest.slice(0, HOSTED_LIMITS.ACCOUNT_ID_HASH_HEX_LENGTH)}`;
}

/**
 * C1 v2: an account ID is the provider prefix and a fixed-width lowercase hex
 * digest of the subject. Logins, display names and email addresses cannot be
 * spelled here at all, which is the point of validating the shape rather than
 * only its presence.
 *
 * Shape only. Whether the digest is the digest *of this record's own subject* is
 * a cross-reference, and `validatePrincipal` owns it: this function is also
 * called where no subject is present - a stored owner, a receipt result - and
 * there is nothing to recompute from at those call sites.
 */
function requireAccountId(value, field) {
  requireWellFormedString(value, field);
  const { ACCOUNT_ID_PREFIX, ACCOUNT_ID_HASH_HEX_LENGTH } = HOSTED_LIMITS;
  if (!value.startsWith(ACCOUNT_ID_PREFIX)) {
    throw invalid(field, `must begin with ${ACCOUNT_ID_PREFIX}`);
  }
  requireLowerHex(value.slice(ACCOUNT_ID_PREFIX.length), ACCOUNT_ID_HASH_HEX_LENGTH, field);
  return value;
}

/**
 * C1 v2: a stored email address, in the one normalized spelling.
 *
 * This validates the *stored form* and normalizes nothing: a caller handing over
 * `Ann@Example.COM` has not normalized it, and silently lowercasing it here
 * would make two spellings of one address both valid at this boundary and
 * different everywhere downstream. The grammar is the collaboration layer's,
 * restated as a check rather than copied as a transform - bounded ASCII, a
 * 1-64 character unquoted local part, exactly one `@`, and a domain of at least
 * two DNS labels. ACN-007 owns the shared normalizer both trees will call; until
 * then this tree only ever receives an already-normalized value.
 */
function requireNormalizedEmail(value, field) {
  requireWellFormedString(value, field);
  if (/[^\x20-\x7e]/.test(value)) throw invalid(field, "must be printable ASCII");
  if (value !== value.toLowerCase()) throw invalid(field, "must be lowercase");
  if (value.length === 0 || value.length > HOSTED_LIMITS.EMAIL_MAX_LENGTH) {
    throw invalid(field, `must be 1-${HOSTED_LIMITS.EMAIL_MAX_LENGTH} characters`);
  }
  const at = value.indexOf("@");
  if (at === -1 || value.indexOf("@", at + 1) !== -1) {
    throw invalid(field, "must contain exactly one @");
  }
  if (!/^[a-z0-9.!#$%&'*+=?^_`{|}~-]{1,64}$/.test(value.slice(0, at))) {
    throw invalid(field, "must have an unquoted ASCII local part");
  }
  const labels = value.slice(at + 1).split(".");
  if (labels.length < 2 || !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw invalid(field, "must have a domain of at least two DNS labels");
  }
  return value;
}

/** `requireNormalizedEmail`, or `null` where the identity carries no address. */
function requireNullableEmail(value, field) {
  return value === null ? null : requireNormalizedEmail(value, field);
}

/**
 * Display text: well-formed, bounded in scalar values, free of anything that
 * renders differently from its bytes, and already trimmed.
 *
 * Trimming is checked rather than performed, in keeping with the rest of this
 * module: a value the caller has to fix is better than a value that silently
 * became a different value. It also subsumes the "a title of nothing but
 * spaces" case, because `String#trim` removes every Unicode separator.
 */
function requireDisplayText(value, min, max, field) {
  requireWellFormedString(value, field);
  if (UNSAFE_DISPLAY.test(value)) {
    throw invalid(field, "must not contain control, format or separator characters");
  }
  if (value !== value.trim()) throw invalid(field, "must not begin or end with whitespace");
  const scalars = [...value].length;
  if (scalars < min) throw invalid(field, `must be at least ${min} character(s)`);
  if (scalars > max) throw invalid(field, `must be at most ${max} character(s)`);
  return value;
}

/**
 * An opaque bearer or CSRF token as it appears on the wire.
 *
 * Only the shape is checked, and deliberately so: this module never sees the
 * server-side hash it would have to compare against, and a validator that
 * appeared to authenticate something would be worse than one that plainly does
 * not. The alphabet is base64url so a token cannot smuggle a delimiter into a
 * log line or a URL.
 */
function requireOpaqueToken(value, field) {
  requireWellFormedString(value, field);
  const { OPAQUE_TOKEN_MIN_LENGTH, OPAQUE_TOKEN_MAX_LENGTH } = HOSTED_LIMITS;
  if (value.length < OPAQUE_TOKEN_MIN_LENGTH || value.length > OPAQUE_TOKEN_MAX_LENGTH) {
    throw invalid(
      field,
      `must be ${OPAQUE_TOKEN_MIN_LENGTH}-${OPAQUE_TOKEN_MAX_LENGTH} characters`,
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(field, "must be base64url characters");
  return value;
}

/* ------------------------------------------------------------------ */
/* C1: identity                                                        */
/* ------------------------------------------------------------------ */

const PRINCIPAL_KEYS = Object.freeze([
  "accountId",
  "provider",
  "providerUserId",
  "login",
  "email",
  "emailVerified",
]);

/**
 * Validate a `HostedPrincipal` (v2), returning a frozen copy.
 *
 * The load-bearing check is the cross-reference: `accountId` must be the digest
 * this module derives from `providerUserId`, recomputed here rather than
 * inspected for shape. C1 v2 defines it as a derived value, and a record where
 * the two disagree is a record where the ownership key and the identity it
 * claims to encode are two different subjects - which is the whole failure this
 * identity model exists to prevent. A shape check would accept any well-formed
 * `a0_` value, which is to say any caller-chosen owner.
 *
 * `login` is carried for display only. `email` is what later domain decisions
 * read and is never an ownership key. `emailVerified` is a strict boolean: a
 * string `"true"` is a refusal, because "not verified" must never arrive spelled
 * as something truthy.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<{accountId: string, provider: string, providerUserId: string, login: string, email: string | null, emailVerified: boolean}>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validatePrincipal(value, { field = "principal" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, PRINCIPAL_KEYS, field);

  if (value.provider !== HOSTED_LIMITS.IDENTITY_PROVIDER) {
    throw invalid(`${field}.provider`, `must be "${HOSTED_LIMITS.IDENTITY_PROVIDER}"`);
  }
  requireProviderUserId(value.providerUserId, `${field}.providerUserId`);
  requireAccountId(value.accountId, `${field}.accountId`);
  if (value.accountId !== deriveAccountId(value.providerUserId)) {
    throw invalid(`${field}.accountId`, "must be the derived account id of providerUserId");
  }

  requireDisplayText(value.login, 1, HOSTED_LIMITS.LOGIN_MAX_LENGTH, `${field}.login`);
  if (value.login.includes("@")) {
    throw invalid(`${field}.login`, "must be a display name, not an email address");
  }

  const email = requireNullableEmail(value.email, `${field}.email`);
  if (typeof value.emailVerified !== "boolean") {
    throw invalid(`${field}.emailVerified`, "must be a boolean");
  }
  /* The other direction is legal: an identity with no address is not verified,
     and that is the ordinary case for a connection that publishes no email. */
  if (value.emailVerified && email === null) {
    throw invalid(`${field}.email`, "is required while emailVerified is true");
  }

  return Object.freeze({
    accountId: value.accountId,
    provider: value.provider,
    providerUserId: value.providerUserId,
    login: value.login,
    email,
    emailVerified: value.emailVerified,
  });
}

/**
 * Validate the C1 v2 session-endpoint body, returning a frozen copy.
 *
 * The authenticated body reports `email` and `emailVerified` because every later
 * domain decision reads them, and a page that had to infer a verified address
 * from a display name would infer it wrongly.
 *
 * The two shapes are disjoint on purpose: a signed-out body carries no account
 * fields at all, so a consumer cannot read `accountId` off a response that never
 * authenticated anybody. `csrfToken` is browser-only and must never reach
 * artifact or agent output - this validator does not and cannot enforce that,
 * but the field is named here so a reviewer can see where it is allowed to go.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<object>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validateSessionResponse(value, { field = "session" } = {}) {
  requireRecord(value, field);
  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  if (typeof value.authenticated !== "boolean") {
    throw invalid(`${field}.authenticated`, "must be a boolean");
  }

  if (!value.authenticated) {
    requireExactKeys(value, ["v", "authenticated"], field);
    return Object.freeze({ v: 1, authenticated: false });
  }

  requireExactKeys(
    value,
    ["v", "authenticated", "accountId", "login", "email", "emailVerified", "csrfToken"],
    field,
  );
  /* Each field is checked against the principal's own rule, and the subject is
     not reconstructed from `accountId`: the v2 derivation is a one-way digest, so
     there is nothing to slice off and no subject to invent. The fields the body
     shares with a principal are therefore validated with the same helpers, and
     the fields it does not carry are simply absent rather than faked. */
  requireAccountId(value.accountId, `${field}.accountId`);
  requireDisplayText(value.login, 1, HOSTED_LIMITS.LOGIN_MAX_LENGTH, `${field}.login`);
  if (value.login.includes("@")) {
    throw invalid(`${field}.login`, "must be a display name, not an email address");
  }
  const email = requireNullableEmail(value.email, `${field}.email`);
  if (typeof value.emailVerified !== "boolean") {
    throw invalid(`${field}.emailVerified`, "must be a boolean");
  }
  if (value.emailVerified && email === null) {
    throw invalid(`${field}.email`, "is required while emailVerified is true");
  }
  requireOpaqueToken(value.csrfToken, `${field}.csrfToken`);

  return Object.freeze({
    v: 1,
    authenticated: true,
    accountId: value.accountId,
    login: value.login,
    email,
    emailVerified: value.emailVerified,
    csrfToken: value.csrfToken,
  });
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
 * belongs in it, and in particular no owner field does - the owner is fixed from
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
 * Decode raw artifact bytes to the string the rest of this module works with,
 * preserving an optional UTF-8 BOM.
 *
 * C3 requires "BOM-preserving decoding and exact re-encoding", which is the
 * difference between an owner downloading the bytes they approved and
 * downloading bytes with a different digest. `ignoreBOM: true` is the option
 * that *keeps* the BOM as U+FEFF instead of stripping it - the name reads
 * backwards, which is exactly why this belongs in one shared function rather
 * than in each of AHU-004's and AHU-006's decoders.
 *
 * `fatal: true` is the strict-UTF-8 requirement: an invalid sequence throws
 * rather than becoming U+FFFD, because a replacement character would change the
 * bytes while still producing a plausible-looking document.
 *
 * @param {Uint8Array} bytes
 * @param {{field?: string}} [options]
 * @returns {string}
 * @throws {HostedContractError} `invalid_request` / `artifact_too_large`
 */
export function decodeArtifactBytes(bytes, { field = "artifact" } = {}) {
  if (!ArrayBuffer.isView(bytes) || !(bytes instanceof Uint8Array)) {
    throw invalid(field, "must be raw bytes");
  }
  requireInteger(
    bytes.byteLength,
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    field,
    "artifact_too_large",
  );
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid(field, "must be strict UTF-8");
  }
}

/**
 * Re-encode a decoded artifact to the exact bytes it came from.
 *
 * The pair `decodeArtifactBytes` / `encodeArtifactBytes` is a round trip, and
 * the test asserts it byte for byte on a BOM-carrying document. Without that
 * guarantee the digest an owner approved and the digest of what they download
 * are two different numbers.
 *
 * @param {string} html
 * @returns {Uint8Array}
 */
export function encodeArtifactBytes(html) {
  return new TextEncoder().encode(html);
}

/**
 * The artifact body, checked against the descriptor the owner approved.
 *
 * Digest and length are re-derived here rather than trusted, because the whole
 * value of the approval step is that the bytes published are the bytes
 * described.
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
  if (!HTML_MARKUP.test(body)) throw invalid(field, "must be HTML");

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
  "ownerEmail",
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

  /* C2 says `userCode: string` and nothing else, so this is the only rule that
     applies. The recommended minting grammar lives in `HOSTED_LIMITS` as advice
     for AHU-004; enforcing it here would amend the contract for every sibling
     that mints or projects a code. */
  requireDisplayText(value.userCode, 1, HOSTED_LIMITS.USER_CODE_MAX_SCALARS, `${field}.userCode`);

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
  /* Recovery metadata, never an access key: `accountId` is scoped to the identity
     tenant, so a tenant recreated from scratch issues new subjects and therefore
     new owner keys. The approver's verified address is what an operator matches
     a stored document back to a person by. It is `null` whenever there is no
     owner, and may also be `null` for an owner who had no address. */
  const ownerEmail = requireNullableEmail(value.ownerEmail, `${field}.ownerEmail`);
  if (ownerAccountId === null && ownerEmail !== null) {
    throw invalid(`${field}.ownerEmail`, "must be null while there is no owner");
  }
  const uploadExpiresAt = requireNullableTimestamp(value.uploadExpiresAt, `${field}.uploadExpiresAt`);
  const completedAt = requireNullableTimestamp(value.completedAt, `${field}.completedAt`);
  const receiptExpiresAt = requireNullableTimestamp(
    value.receiptExpiresAt,
    `${field}.receiptExpiresAt`,
  );

  /* The state matrix, exactly as C2 words it. Each `absent`/`present` line is a
     guard with its own named test. */
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
    /* C2 names owner, HTML, completion and receipt timestamps for this state -
       and not `uploadExpiresAt`, so a completion write that clears the upload
       deadline is legal and must not be rejected here. */
    present("ownerAccountId", ownerAccountId);
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
    ownerEmail,
    uploadExpiresAt,
    completedAt,
    receiptExpiresAt,
    html: value.html,
  });
}

/* ------------------------------------------------------------------ */
/* C1/C6: origins                                                      */
/* ------------------------------------------------------------------ */

/** The only hosts a loopback-only local test configuration may name. */
export const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1", "[::1]"]);

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

/** Whether a canonical origin names one of the loopback hosts. */
export function isLoopbackOrigin(origin) {
  return LOOPBACK_HOSTS.includes(new URL(origin).hostname);
}

/**
 * Validate one configured origin, returning its canonical serialization.
 *
 * `URL.origin` is the comparison this service performs at every mutation
 * boundary, so the accepted spelling is exactly that serialization. One
 * comparison does the work of several: `new URL` lowercases the scheme and
 * host, trims surrounding whitespace, drops a default port, punycodes an IDN
 * and moves everything else into a path, query, fragment or credential - so
 * requiring the input to equal its own origin serialization rejects all of
 * those spellings at once, and rejects them rather than quietly accepting a
 * normalized version of what the operator actually wrote.
 *
 * In production the origin must additionally be HTTPS and resolve to a
 * determinate registrable domain under the public-suffix list. IP literals,
 * loopback names and unlisted suffixes have no registrable site, so a
 * comparison against the other configured origin could not be performed - and a
 * comparison that cannot be performed must not silently pass.
 *
 * @param {unknown} value
 * @param {{production?: boolean, field?: string}} [options] `production: false`
 *   is the loopback-only local test mode. It relaxes the scheme and the
 *   registrable-site requirement, and `readHostedConfig` pairs it with a rule
 *   that both origins must then be loopback - so it can never describe a real
 *   deployment.
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
  if (url.origin !== value) {
    throw invalid(
      field,
      "must be exactly a lowercase scheme://host[:port] origin with no path, query or credentials",
    );
  }
  /* A fully-qualified trailing dot survives `URL.origin`, resolves to the same
     host, and never string-equals the `Origin` header a browser sends. Every
     later CSRF and origin comparison in this service is an exact string
     comparison, so accepting both spellings would be an outage waiting for the
     operator who happens to type the dot. */
  if (url.hostname.endsWith(".")) {
    throw invalid(field, "must not end with a trailing dot");
  }

  if (production) {
    if (url.protocol !== "https:") throw invalid(field, "must use https in production");
    if (!isDeterminateSite(parseHost(url.hostname, { allowPrivateDomains: true }))) {
      throw invalid(field, "must be a named host under a listed public suffix in production");
    }
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalid(field, "must use http or https");
  }

  return url.origin;
}

/**
 * The registrable site of a production origin - the unit C6 means by "different
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

const START_KEYS = Object.freeze([
  "v",
  "publicationId",
  "verificationUriComplete",
  "userCode",
  "agentSecret",
  "expiresAt",
  "intervalSeconds",
]);
const RESULT_KEYS = Object.freeze([
  "documentId",
  "url",
  "ownerAccountId",
  "contentSha256",
  "contentBytes",
]);
const ENVELOPE_KEYS = Object.freeze(["v", "state", "expiresAt", "intervalSeconds"]);

/**
 * Require and validate a caller-supplied expected app origin.
 *
 * A missing `appOrigin` is a programming error, not a malformed message, so it
 * raises a `TypeError` rather than a wire error: the caller has not been
 * attacked, it has forgotten to say what it trusts. Making the omission throw
 * is the whole point - a default would make "validate this receipt against
 * nothing in particular" the easiest call to write, and that call is what lets a
 * hostile responder hand a client somebody else's URL.
 */
function requireExpectedOrigin(appOrigin, production, what) {
  if (typeof appOrigin !== "string" || appOrigin === "") {
    throw new TypeError(
      `${what} cannot be validated without the appOrigin it must belong to; pass { appOrigin } from readHostedConfig()`,
    );
  }
  return validateOrigin(appOrigin, { production, field: "appOrigin" });
}

/** The two halves of a verification fragment, separated by the one character
 * that appears in neither of them. */
const VERIFICATION_FRAGMENT_SEPARATOR = ".";

/**
 * The `#<publicationId>.<browserSecret>` fragment of a verification URL.
 *
 * The fragment has to be self-sufficient, and that is a consequence of the rest
 * of C3 rather than a preference. `/publish/authorize` is one fixed path with no
 * query string permitted above; there is no short-code lookup endpoint and no
 * lookup by browser secret either; and `bindPublication` is frozen to take
 * `{publicationId, browserSecret}`. So the only channel that can tell the
 * trusted bootstrap *which* operation it is holding a secret for is the
 * fragment, and a fragment carrying the secret alone would leave the page unable
 * to bind anything at all.
 *
 * The id in it must be this response's own id. A fragment naming some other
 * publication would walk the visitor into approving an operation the agent that
 * printed the URL is not waiting on - and since the fragment is the half a URL
 * shortener, a chat client or a copy-paste is most likely to mangle, checking it
 * here is what turns that into a start-response fault rather than a confusing
 * approval page.
 *
 * A fragment stays out of the request line, so neither half reaches a server
 * access log by being visited; the browser secret is exchanged for a server-side
 * binding by the bootstrap and the page removes the fragment before anything
 * else can read it.
 */
function requireVerificationFragment(hash, publicationId, field) {
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const at = fragment.indexOf(VERIFICATION_FRAGMENT_SEPARATOR);
  if (at < 1) {
    throw invalid(field, "must carry <publicationId>.<browserSecret> in its fragment");
  }
  if (fragment.slice(0, at) !== publicationId) {
    throw invalid(field, "fragment must name this response's publicationId");
  }
  requireOpaqueToken(fragment.slice(at + 1), field);
  return fragment;
}

/**
 * Validate the C3 start response - the 201 body of `POST /api/hosted/publications`.
 *
 * Two checks earn this function its place. The browser URL must live on the
 * configured app origin at the authorization path, because a start response is
 * the first thing a CLI prints and the human is about to visit it; and the
 * fragment must carry this publication's id and its *browser* secret and nothing
 * else, because putting the agent bearer in a URL would hand the upload
 * capability to anything that sees a referrer, a history entry or a shoulder.
 *
 * @param {unknown} value
 * @param {{appOrigin: string, production?: boolean, field?: string}} options
 * @returns {Readonly<object>}
 * @throws {TypeError} when `appOrigin` is omitted
 * @throws {HostedContractError} `invalid_request`
 */
export function validateStartResponse(value, { appOrigin, production = true, field = "start" } = {}) {
  const expected = requireExpectedOrigin(appOrigin, production, "a start response");

  requireRecord(value, field);
  requireExactKeys(value, START_KEYS, field);
  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  requireLowerHex(
    value.publicationId,
    HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH,
    `${field}.publicationId`,
  );
  requireDisplayText(value.userCode, 1, HOSTED_LIMITS.USER_CODE_MAX_SCALARS, `${field}.userCode`);
  requireOpaqueToken(value.agentSecret, `${field}.agentSecret`);
  requireTimestamp(value.expiresAt, `${field}.expiresAt`);
  if (value.intervalSeconds !== HOSTED_LIMITS.POLL_INTERVAL_SECONDS) {
    throw invalid(`${field}.intervalSeconds`, `must be ${HOSTED_LIMITS.POLL_INTERVAL_SECONDS}`);
  }

  requireWellFormedString(value.verificationUriComplete, `${field}.verificationUriComplete`);
  let uri;
  try {
    uri = new URL(value.verificationUriComplete);
  } catch {
    throw invalid(`${field}.verificationUriComplete`, "must be an absolute URL");
  }
  if (uri.origin !== expected) {
    throw invalid(`${field}.verificationUriComplete`, "must be on the configured app origin");
  }
  if (uri.pathname !== HOSTED_LIMITS.AUTHORIZE_PATH || uri.search !== "") {
    throw invalid(
      `${field}.verificationUriComplete`,
      `must be ${HOSTED_LIMITS.AUTHORIZE_PATH} with no query string`,
    );
  }
  if (uri.hash.includes(value.agentSecret)) {
    throw invalid(`${field}.verificationUriComplete`, "must not carry the agent secret");
  }
  requireVerificationFragment(uri.hash, value.publicationId, `${field}.verificationUriComplete`);

  return Object.freeze({
    v: 1,
    publicationId: value.publicationId,
    verificationUriComplete: value.verificationUriComplete,
    userCode: value.userCode,
    agentSecret: value.agentSecret,
    expiresAt: value.expiresAt,
    intervalSeconds: value.intervalSeconds,
  });
}

/**
 * Validate the C3 status / completion envelope, returning a frozen copy.
 *
 * Two rules are load-bearing. `result` is present exactly when the state is
 * `complete`: a receipt attached to any other state is a success claim for a
 * document that does not exist, and C3 says twice that denial and cancellation
 * are normal terminal states rather than transport failures. And the receipt
 * URL must be this document's own path **on the configured app origin** - a
 * self-consistent URL is not enough, because a hostile responder can be
 * perfectly self-consistent about `https://evil.example.net/docs/<id>` and the
 * CLI would print it as the user's published document.
 *
 * @param {unknown} value
 * @param {{appOrigin?: string, production?: boolean, field?: string}} [options]
 *   `appOrigin` is required whenever the envelope is `complete`.
 * @returns {Readonly<object>}
 * @throws {TypeError} when a complete envelope is validated without `appOrigin`
 * @throws {HostedContractError} `invalid_request`
 */
export function validateResult(value, { appOrigin, production = true, field = "result" } = {}) {
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

  const expected = requireExpectedOrigin(appOrigin, production, "a completion receipt");
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

  requireWellFormedString(result.url, `${field}.result.url`);
  if (result.url !== `${expected}${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}${result.documentId}`) {
    throw invalid(
      `${field}.result.url`,
      `must be this document's ${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}<documentId> path on the configured app origin`,
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
  /* One comparison covers both the type and the value: a non-boolean can never
     be strictly equal to the boolean this code carries, so a separate
     `typeof` check would be a guard no input could reach on its own. */
  if (error.retryable !== ERROR_CODES[error.code].retryable) {
    throw invalid(`${field}.error.retryable`, "must be the retryability of its code");
  }

  return Object.freeze({
    v: 1,
    error: Object.freeze({ code: error.code, message: error.message, retryable: error.retryable }),
  });
}

/* ------------------------------------------------------------------ */
/* C4: private read and renderer messages                              */
/* ------------------------------------------------------------------ */

const DOCUMENT_METADATA_KEYS = Object.freeze([
  "v",
  "documentId",
  "title",
  "ownerAccountId",
  "contentSha256",
  "contentBytes",
  "createdAt",
]);

/**
 * Validate the C4 owner document-metadata body, returning a frozen copy.
 *
 * Note what is absent: no HTML, and no bearer of any kind. C4 serves bytes from
 * a separate content route that repeats the owner check, so metadata that
 * carried the document would make the second check decorative.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<object>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validateDocumentMetadata(value, { field = "document" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, DOCUMENT_METADATA_KEYS, field);

  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  requireLowerHex(value.documentId, HOSTED_LIMITS.PUBLICATION_ID_HEX_LENGTH, `${field}.documentId`);
  requireDisplayText(
    value.title,
    HOSTED_LIMITS.TITLE_MIN_SCALARS,
    HOSTED_LIMITS.TITLE_MAX_SCALARS,
    `${field}.title`,
  );
  requireAccountId(value.ownerAccountId, `${field}.ownerAccountId`);
  requireLowerHex(value.contentSha256, HOSTED_LIMITS.SHA256_HEX_LENGTH, `${field}.contentSha256`);
  requireInteger(
    value.contentBytes,
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    `${field}.contentBytes`,
    "artifact_too_large",
  );
  requireTimestamp(value.createdAt, `${field}.createdAt`);

  return Object.freeze({
    v: 1,
    documentId: value.documentId,
    title: value.title,
    ownerAccountId: value.ownerAccountId,
    contentSha256: value.contentSha256,
    contentBytes: value.contentBytes,
    createdAt: value.createdAt,
  });
}

/**
 * Validate the renderer's `archon:ready` handshake, returning a frozen copy.
 *
 * Exact keys matter more here than anywhere else in this module: the trusted
 * viewer sends a private document in reply to this message, so a handshake that
 * tolerated extra fields would be a channel from the renderer back into the
 * account origin's decision about what to send.
 *
 * Validating the shape is not the security boundary. AHU-005 and AHU-009 must
 * still check `event.origin` against the configured renderer origin and
 * `event.source` against the exact frame window before this function is even
 * called; a well-formed message from the wrong window is still an attack.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<{type: string, v: 1}>}
 * @throws {HostedContractError} `invalid_request`
 */
export function validateReadyMessage(value, { field = "readyMessage" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, ["type", "v"], field);
  if (value.type !== RENDER_MESSAGE_TYPES.READY) {
    throw invalid(`${field}.type`, `must be "${RENDER_MESSAGE_TYPES.READY}"`);
  }
  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");
  return Object.freeze({ type: value.type, v: 1 });
}

/**
 * Validate an `archon:render` message, returning a frozen copy.
 *
 * The byte cap is re-applied on the receiving side because C4 requires it: the
 * renderer is a separate origin and must not trust that whoever sent the message
 * already checked. No descriptor is available here, so this is a bounds and
 * shape check rather than a digest check - the digest belongs to the owner-facing
 * metadata the viewer already fetched.
 *
 * @param {unknown} value
 * @param {{field?: string}} [options]
 * @returns {Readonly<{type: string, v: 1, html: string}>}
 * @throws {HostedContractError} `invalid_request` / `artifact_too_large`
 */
export function validateRenderMessage(value, { field = "renderMessage" } = {}) {
  requireRecord(value, field);
  requireExactKeys(value, ["type", "v", "html"], field);
  if (value.type !== RENDER_MESSAGE_TYPES.RENDER) {
    throw invalid(`${field}.type`, `must be "${RENDER_MESSAGE_TYPES.RENDER}"`);
  }
  if (value.v !== 1) throw invalid(`${field}.v`, "must be 1");

  requireWellFormedString(value.html, `${field}.html`);
  if (value.html.includes(NUL)) throw invalid(`${field}.html`, "must not contain a NUL character");
  requireInteger(
    Buffer.byteLength(value.html, "utf8"),
    HOSTED_LIMITS.HTML_MIN_BYTES,
    HOSTED_LIMITS.HTML_MAX_BYTES,
    `${field}.html`,
    "artifact_too_large",
  );

  return Object.freeze({ type: value.type, v: 1, html: value.html });
}
