/**
 * Regressions for the hosted contracts and their configuration reader.
 *
 * Every test below names one guarded condition in `../lib/contracts.mjs` or
 * `../lib/config.mjs`. That correspondence is the point rather than a
 * convenience: AHU-001's acceptance requires that removing any one of those
 * conditions makes a test here fail, so a test that would still pass with its
 * guard deleted is a test that is not doing anything.
 *
 * The suite therefore leans on rejection cases far more than on happy paths.
 * The happy paths prove the shapes are usable; the rejections are the contract.
 *
 * Two habits earn their keep and are worth copying into sibling suites. First,
 * a looped input has to exercise the guard its test names - several inputs in
 * an earlier draft were rejected by an unrelated check one line earlier, so the
 * test passed while its guard was dead. Second, an exported constant needs an
 * assertion or a consumer: a frozen list nobody checks can quietly become
 * empty, and `TERMINAL_PUBLICATION_STATES` is the list AHU-004 will use to
 * decide whether a transition is legal at all.
 *
 *   node --test hosted/test/contracts.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  decodeArtifactBytes,
  encodeArtifactBytes,
  ERROR_CODES,
  HOSTED_LIMITS,
  HostedContractError,
  isLoopbackOrigin,
  LOOPBACK_HOSTS,
  PUBLICATION_STATES,
  registrableSite,
  RENDER_MESSAGE_TYPES,
  TERMINAL_PUBLICATION_STATES,
  validateDescriptor,
  validateDocumentMetadata,
  validateOrigin,
  validatePrincipal,
  validatePublication,
  validateReadyMessage,
  validateRenderMessage,
  validateResult,
  validateSessionResponse,
  validateStartResponse,
  validateWireError,
} from "../lib/contracts.mjs";
import {
  formatHostedConfig,
  HostedConfigError,
  HOSTED_CONFIG_KEYS,
  LOCAL_TEST,
  readHostedConfig,
  REDACTED,
} from "../lib/config.mjs";
import {
  COMPLETE_RESULT_ENVELOPE,
  descriptorFor,
  DOCUMENT_METADATA,
  ERROR_ENVELOPE,
  FIXTURE_AGENT_SECRET,
  FIXTURE_APP_ORIGIN,
  FIXTURE_APPROVED_AT,
  FIXTURE_BROWSER_SECRET,
  FIXTURE_CREATED_AT,
  FIXTURE_ENV,
  FIXTURE_HTML,
  FIXTURE_HTML_WITH_BOM,
  FIXTURE_LOCAL_APP_ORIGIN,
  FIXTURE_LOCAL_ENV,
  FIXTURE_LOCAL_RENDER_ORIGIN,
  FIXTURE_LOGIN,
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
  FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN,
  FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN,
  FIXTURE_PROVIDER_USER_ID,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RENDER_ORIGIN,
  FIXTURE_SIBLING_RENDER_ORIGIN,
  FIXTURE_UNLISTED_SUFFIX_ORIGIN,
  htmlOfExactBytes,
  PENDING_RESULT_ENVELOPE,
  PUBLICATION_FIXTURES,
  READY_MESSAGE,
  RENDER_MESSAGE,
  replacing,
  SIGNED_IN_SESSION,
  SIGNED_OUT_SESSION,
  START_RESPONSE,
  UPLOAD_EXPIRES_AT,
  VALID_DESCRIPTOR,
  without,
} from "./contract-fixtures.mjs";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

/** The app origin every receipt and start response in this suite belongs to. */
const APP = { appOrigin: FIXTURE_APP_ORIGIN };

/** Every rejection this suite produces, collected for the whole-corpus checks. */
const observedRejections = [];

/**
 * Assert that `fn` throws a `HostedContractError` with the expected code, and
 * record the error so the corpus-wide checks at the end can inspect it.
 */
function rejects(fn, { code = "invalid_request", field } = {}) {
  let thrown;
  assert.throws(fn, (error) => {
    thrown = error;
    assert.ok(error instanceof HostedContractError, `expected HostedContractError, got ${error}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    if (field !== undefined) assert.equal(error.field, field);
    return true;
  });
  observedRejections.push(thrown);
  return thrown;
}

/* ------------------------------------------------------------------ */
/* the error envelope this module emits about itself                   */
/* ------------------------------------------------------------------ */

test("a rejection message is always a legal C3 message, whatever the key was", () => {
  /* The key name is the one part of a message that comes from the caller, so
     it is the one part that can be weaponised. Without sanitizing, a 300-
     character key produced a 333-character message and a key carrying a BEL
     produced a control character - both of which `validateWireError` rejects,
     so this module could emit an envelope it would itself refuse. */
  const long = rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { ["X".repeat(300)]: 1 })));
  assert.ok([...long.message].length <= HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH);
  assert.deepEqual(validateWireError(long.toWire()).error.code, "invalid_request");

  const controlled = rejects(() =>
    validateDescriptor(replacing(VALID_DESCRIPTOR, { ["a\u0007b\u202Ec"]: 1 })),
  );
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(controlled.message));
  /* The key is *filtered* down to its printable characters rather than merely
     having them replaced with spaces, so the operator reading the log sees the
     key a developer would recognise. */
  assert.match(controlled.message, /unknown field\(s\): abc$/);
  validateWireError(controlled.toWire());

  /* The field path is caller-supplied too, and unlike a key name it is not
     filtered first - so it is what reaches the bound and the sanitizer. */
  const longField = rejects(() => validateDescriptor(null, { field: "f".repeat(400) }));
  assert.ok([...longField.message].length <= HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH);
  validateWireError(longField.toWire());

  const controlField = rejects(() => validateDescriptor(null, { field: "a\u0007b\u2028c" }));
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(controlField.message));
  validateWireError(controlField.toWire());

  /* A message that sanitizes away to nothing still has to be a legal message. */
  const empty = new HostedContractError("invalid_request", "\u0007\u200B");
  assert.equal(empty.message, "invalid request");
  validateWireError(empty.toWire());

  /* Many unknown keys are summarised rather than listed, so the bound is not
     reached by volume either. */
  const many = rejects(() =>
    validateDescriptor(
      replacing(VALID_DESCRIPTOR, Object.fromEntries([...Array(40)].map((_, i) => [`extra${i}`, 1]))),
    ),
  );
  assert.match(many.message, /and 37 more/);
  validateWireError(many.toWire());
});

test("an unknown error code cannot be constructed", () => {
  assert.throws(() => new HostedContractError("teapot", "x"), /unknown hosted error code: teapot/);
  const error = new HostedContractError("rate_limited", "slow down");
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
});

test("the error table pins every C3 code to its status and retryability", () => {
  /* The table is the single source handlers, gateway rules and the CLI's exit
     codes all read. Nothing else in the repository asserts the status column,
     so without this a table of all-200s would ship. */
  assert.deepEqual(
    Object.fromEntries(Object.entries(ERROR_CODES).map(([code, spec]) => [code, spec.status])),
    {
      invalid_request: 400,
      invalid_capability: 401,
      session_required: 401,
      approval_required: 403,
      forbidden: 403,
      csrf_failed: 403,
      not_found: 404,
      descriptor_mismatch: 409,
      state_conflict: 409,
      authorization_expired: 410,
      receipt_expired: 410,
      artifact_too_large: 413,
      unsupported_media_type: 415,
      rate_limited: 429,
      unavailable: 503,
      publishing_disabled: 503,
    },
  );
  assert.deepEqual(
    Object.entries(ERROR_CODES)
      .filter(([, spec]) => spec.retryable)
      .map(([code]) => code)
      .sort(),
    ["rate_limited", "unavailable"],
  );
});

/* ------------------------------------------------------------------ */
/* exported vocabulary                                                 */
/* ------------------------------------------------------------------ */

test("the state vocabulary is exactly the contract's, and terminal is a real subset", () => {
  assert.deepEqual([...PUBLICATION_STATES].sort(), [
    "approved",
    "cancelled",
    "complete",
    "denied",
    "expired",
    "pending",
  ]);
  /* AHU-004 imports this list to decide whether a transition is legal at all,
     so an empty or short list is a state machine that permits a transition out
     of a completed publication. */
  assert.deepEqual([...TERMINAL_PUBLICATION_STATES].sort(), [
    "cancelled",
    "complete",
    "denied",
    "expired",
  ]);
  for (const state of TERMINAL_PUBLICATION_STATES) assert.ok(PUBLICATION_STATES.includes(state));
  for (const state of ["pending", "approved"]) {
    assert.ok(!TERMINAL_PUBLICATION_STATES.includes(state));
  }
});

test("the wire constants siblings hard-code are pinned here", () => {
  assert.equal(HOSTED_LIMITS.ARTIFACT_MEDIA_TYPE, "text/html; charset=utf-8");
  assert.equal(HOSTED_LIMITS.ARTIFACT_FORMAT, "html");
  assert.equal(HOSTED_LIMITS.DOCUMENT_PATH_PREFIX, "/docs/");
  assert.equal(HOSTED_LIMITS.AUTHORIZE_PATH, "/publish/authorize");
  assert.equal(HOSTED_LIMITS.ACCOUNT_ID_PREFIX, "gh_");
  assert.equal(HOSTED_LIMITS.IDENTITY_PROVIDER, "github.com");
  assert.equal(HOSTED_LIMITS.POLL_INTERVAL_SECONDS, 5);
  assert.equal(HOSTED_LIMITS.HTML_MAX_BYTES, 2097152);
  assert.deepEqual(RENDER_MESSAGE_TYPES, { READY: "archon:ready", RENDER: "archon:render" });
  assert.deepEqual([...LOOPBACK_HOSTS], ["localhost", "127.0.0.1", "[::1]"]);
});

test("the contract lifetimes are the contract's, not whatever the fixtures say", () => {
  /* Deriving the fixtures from the constants (below) makes them agree, but it
     also makes the pair circular: change the constant and both sides move. The
     literals are what pin the contract. */
  assert.equal(HOSTED_LIMITS.PENDING_TTL_SECONDS, 900);
  assert.equal(HOSTED_LIMITS.UPLOAD_TTL_SECONDS, 600);
  assert.equal(HOSTED_LIMITS.RECEIPT_TTL_SECONDS, 86400);
  assert.equal(HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH, 200);
  assert.equal(HOSTED_LIMITS.TITLE_MAX_SCALARS, 160);
});

test("the fixture lifetimes are the declared lifetimes", () => {
  /* A hand-written timestamp drifted to 720 seconds against a declared
     600-second upload TTL, so the constants and the fixtures now have to agree
     out loud. */
  const seconds = (from, to) => (Date.parse(to) - Date.parse(from)) / 1000;
  const { pending, approved, complete } = PUBLICATION_FIXTURES;
  assert.equal(
    seconds(pending.createdAt, pending.pendingExpiresAt),
    HOSTED_LIMITS.PENDING_TTL_SECONDS,
  );
  assert.equal(seconds(FIXTURE_APPROVED_AT, approved.uploadExpiresAt), HOSTED_LIMITS.UPLOAD_TTL_SECONDS);
  assert.equal(
    seconds(complete.completedAt, complete.receiptExpiresAt),
    HOSTED_LIMITS.RECEIPT_TTL_SECONDS,
  );
  assert.equal(pending.createdAt, FIXTURE_CREATED_AT);
});

/* ------------------------------------------------------------------ */
/* C1: identity                                                        */
/* ------------------------------------------------------------------ */

test("a principal is accepted and returned frozen", () => {
  const principal = validatePrincipal(FIXTURE_PRINCIPAL);
  assert.deepEqual({ ...principal }, { ...FIXTURE_PRINCIPAL });
  assert.ok(Object.isFrozen(principal));
});

test("a principal whose account id does not encode its provider id is rejected", () => {
  /* The whole identity model is that `accountId` *is* the numeric id behind a
     prefix. A record where the two disagree names two different subjects. */
  rejects(() => validatePrincipal(replacing(FIXTURE_PRINCIPAL, { accountId: FIXTURE_OTHER_ACCOUNT_ID })), {
    field: "principal.accountId",
  });
  rejects(() => validatePrincipal(replacing(FIXTURE_PRINCIPAL, { providerUserId: "10000043" })), {
    field: "principal.accountId",
  });
});

test("a principal must name the one supported provider and a real login", () => {
  for (const provider of ["gitlab.com", "github", "", null]) {
    rejects(() => validatePrincipal(replacing(FIXTURE_PRINCIPAL, { provider })), {
      field: "principal.provider",
    });
  }
  for (const login of ["user@example.com", "-leading", "has space", "a".repeat(40), "", 42]) {
    rejects(() => validatePrincipal(replacing(FIXTURE_PRINCIPAL, { login })), {
      field: "principal.login",
    });
  }
  for (const providerUserId of ["0123", "abc", "", 42]) {
    rejects(() => validatePrincipal(replacing(FIXTURE_PRINCIPAL, { providerUserId })), {
      field: "principal.providerUserId",
    });
  }
});

test("the two session bodies are disjoint, so a signed-out reply carries no account", () => {
  assert.deepEqual({ ...validateSessionResponse(SIGNED_OUT_SESSION) }, { v: 1, authenticated: false });
  const signedIn = validateSessionResponse(SIGNED_IN_SESSION);
  assert.equal(signedIn.accountId, FIXTURE_OWNER_ACCOUNT_ID);
  assert.equal(signedIn.login, FIXTURE_LOGIN);

  /* A signed-out body may not smuggle account fields, and a signed-in one may
     not omit them. */
  rejects(() =>
    validateSessionResponse(replacing(SIGNED_OUT_SESSION, { accountId: FIXTURE_OWNER_ACCOUNT_ID })),
  );
  for (const key of ["accountId", "login", "csrfToken"]) {
    rejects(() => validateSessionResponse(without(SIGNED_IN_SESSION, key)));
  }
  for (const csrfToken of ["short", "has space in it and is long enough", "", 42]) {
    rejects(() => validateSessionResponse(replacing(SIGNED_IN_SESSION, { csrfToken })), {
      field: "session.csrfToken",
    });
  }
  rejects(() => validateSessionResponse(replacing(SIGNED_IN_SESSION, { authenticated: "yes" })), {
    field: "session.authenticated",
  });
});

/* ------------------------------------------------------------------ */
/* C2: descriptor                                                      */
/* ------------------------------------------------------------------ */

test("a valid descriptor is accepted and returned frozen", () => {
  const descriptor = validateDescriptor(VALID_DESCRIPTOR);
  assert.deepEqual({ ...descriptor }, { ...VALID_DESCRIPTOR });
  assert.ok(Object.isFrozen(descriptor));
});

test("both C2 size boundaries are inside the accepted range", () => {
  for (const contentBytes of [HOSTED_LIMITS.HTML_MIN_BYTES, HOSTED_LIMITS.HTML_MAX_BYTES]) {
    const descriptor = validateDescriptor(replacing(VALID_DESCRIPTOR, { contentBytes }));
    assert.equal(descriptor.contentBytes, contentBytes);
  }
});

test("an empty artifact is rejected and an oversized one is too large", () => {
  rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { contentBytes: 0 })), {
    field: "descriptor.contentBytes",
  });
  rejects(
    () => validateDescriptor(replacing(VALID_DESCRIPTOR, { contentBytes: HOSTED_LIMITS.HTML_MAX_BYTES + 1 })),
    { code: "artifact_too_large", field: "descriptor.contentBytes" },
  );
});

test("a non-integer byte count is rejected", () => {
  for (const contentBytes of [1.5, "128", null, Number.NaN, 2 ** 60]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { contentBytes })));
  }
});

test("a malformed content digest is rejected", () => {
  for (const contentSha256 of [
    VALID_DESCRIPTOR.contentSha256.toUpperCase(),
    VALID_DESCRIPTOR.contentSha256.slice(0, 63),
    `${VALID_DESCRIPTOR.contentSha256}0`,
    `g${VALID_DESCRIPTOR.contentSha256.slice(1)}`,
    "",
    12345,
  ]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { contentSha256 })), {
      field: "descriptor.contentSha256",
    });
  }
});

test("a title that renders differently from its bytes is rejected", () => {
  /* The title is the whole of what a human approves, so text that displays as
     something other than what it says is a way to steer that decision:
     U+202E reverses what follows it, U+200B renders as nothing while
     satisfying the one-character minimum, and U+2028 breaks the line. */
  for (const title of [
    "\u202Egpj.exe",
    "Invoice\u202Dpayable",
    "\u200B",
    "\uFEFF",
    "a\u2028b",
    "a\u2029b",
    "line\nbreak",
    "bell\u0007",
    "soft\u00ADhyphen",
    "zero\u200Cwidth",
    "isolate\u2066here",
  ]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { title })), {
      field: "descriptor.title",
    });
  }
});

test("a title outside its bounds, untrimmed, or not text at all is rejected", () => {
  const tooLong = "t".repeat(HOSTED_LIMITS.TITLE_MAX_SCALARS + 1);
  for (const title of [
    "",
    tooLong,
    " leading",
    "trailing ",
    "   ",
    "\uD800leading lone surrogate",
    "trailing lone surrogate\uDC00",
    7,
    null,
  ]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { title })), {
      field: "descriptor.title",
    });
  }
});

test("the title bound counts Unicode scalar values, not UTF-16 code units", () => {
  const astral = "\u{1F5FA}".repeat(HOSTED_LIMITS.TITLE_MAX_SCALARS);
  assert.equal(astral.length, HOSTED_LIMITS.TITLE_MAX_SCALARS * 2);
  assert.equal(validateDescriptor(replacing(VALID_DESCRIPTOR, { title: astral })).title, astral);
  rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { title: `${astral}\u{1F5FA}` })));
});

test("only the html artifact format is accepted", () => {
  for (const artifactFormat of ["zip", "HTML", "", null, "html "]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { artifactFormat })), {
      field: "descriptor.artifactFormat",
    });
  }
});

test("an owner claim in the descriptor is rejected rather than ignored", () => {
  const injected = replacing(VALID_DESCRIPTOR, { ownerAccountId: FIXTURE_OTHER_ACCOUNT_ID });
  const error = rejects(() => validateDescriptor(injected), { field: "descriptor" });
  assert.match(error.message, /unknown field\(s\): ownerAccountId/);
});

test("a missing field, a wrong version and a non-record are all rejected", () => {
  for (const key of ["v", "title", "contentSha256", "contentBytes", "artifactFormat"]) {
    rejects(() => validateDescriptor(without(VALID_DESCRIPTOR, key)), { field: "descriptor" });
  }
  for (const v of [0, 2, "1", null]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { v })), { field: "descriptor.v" });
  }
  for (const value of [null, undefined, [], "descriptor", 1, new Date(), new Map()]) {
    rejects(() => validateDescriptor(value), { field: "descriptor" });
  }
  /* A class instance carrying exactly the right own keys passes every other
     check, so the prototype rule is the only thing that rejects it. A JSON body
     is a plain record; anything else arrived by a route a wire validator has no
     business trusting. */
  class Descriptorish {
    constructor(fields) {
      Object.assign(this, fields);
    }
  }
  rejects(() => validateDescriptor(new Descriptorish(VALID_DESCRIPTOR)), { field: "descriptor" });
  rejects(() => validateDescriptor(Object.assign(Object.create({ inherited: 1 }), VALID_DESCRIPTOR)), {
    field: "descriptor",
  });
});

test("every contract shape pins its version", () => {
  /* Each of these is a separate guard, and each was a surviving mutant until it
     had an input of its own: a v2 body that is otherwise perfect must not be
     read as a v1 one. */
  const cases = [
    [() => validateSessionResponse(replacing(SIGNED_OUT_SESSION, { v: 2 })), "session.v"],
    [() => validateSessionResponse(replacing(SIGNED_IN_SESSION, { v: 2 })), "session.v"],
    [() => validatePublication(replacing(PUBLICATION_FIXTURES.pending, { v: 2 })), "publication.v"],
    [() => validateStartResponse(replacing(START_RESPONSE, { v: 2 }), APP), "start.v"],
    [() => validateResult(replacing(PENDING_RESULT_ENVELOPE, { v: 2 })), "result.v"],
    [() => validateWireError(replacing(ERROR_ENVELOPE, { v: 2 })), "errorEnvelope.v"],
    [() => validateDocumentMetadata(replacing(DOCUMENT_METADATA, { v: 2 })), "document.v"],
    [() => validateReadyMessage(replacing(READY_MESSAGE, { v: 2 })), "readyMessage.v"],
    [() => validateRenderMessage(replacing(RENDER_MESSAGE, { v: 2 })), "renderMessage.v"],
    [() => validateDescriptor(replacing(VALID_DESCRIPTOR, { v: 2 })), "descriptor.v"],
  ];
  for (const [run, field] of cases) rejects(run, { field });
});

test("a caller-supplied field path is used verbatim in the message", () => {
  /* Every validator takes `field` so a nested error says where it happened.
     Without a test, the option can stop being honoured and the only symptom is
     a confusing log line. */
  const error = rejects(() => validateDescriptor(null, { field: "requestBody" }), {
    field: "requestBody",
  });
  assert.match(error.message, /^requestBody must be a JSON object$/);

  const nested = rejects(
    () =>
      validatePublication(
        replacing(PUBLICATION_FIXTURES.pending, {
          descriptor: replacing(VALID_DESCRIPTOR, { title: "" }),
        }),
      ),
    { field: "publication.descriptor.title" },
  );
  assert.match(nested.message, /^publication\.descriptor\.title /);
});

/* ------------------------------------------------------------------ */
/* C2/C3: artifact bytes                                               */
/* ------------------------------------------------------------------ */

test("artifact bytes round-trip exactly, BOM included", () => {
  const bytes = encodeArtifactBytes(FIXTURE_HTML_WITH_BOM);
  assert.equal(bytes[0], 0xef, "the BOM must survive encoding");
  const decoded = decodeArtifactBytes(bytes);
  assert.equal(decoded, FIXTURE_HTML_WITH_BOM);
  assert.deepEqual(encodeArtifactBytes(decoded), bytes);
});

test("artifact bytes must be strict UTF-8 and within the size bounds", () => {
  /* A lone continuation byte would become U+FFFD under a lenient decoder,
     changing the bytes while still producing a plausible document. */
  rejects(() => decodeArtifactBytes(Uint8Array.from([0x3c, 0x68, 0x74, 0x80])));
  rejects(() => decodeArtifactBytes(new Uint8Array(0)));
  rejects(() => decodeArtifactBytes(new Uint8Array(HOSTED_LIMITS.HTML_MAX_BYTES + 1)), {
    code: "artifact_too_large",
  });
  for (const notBytes of ["<html>", null, [60, 104], Buffer.from("x").buffer]) {
    rejects(() => decodeArtifactBytes(notBytes));
  }
});

/* ------------------------------------------------------------------ */
/* C2: publication record                                              */
/* ------------------------------------------------------------------ */

test("there is exactly one fixture for every contract state, and each validates", () => {
  assert.deepEqual(Object.keys(PUBLICATION_FIXTURES).sort(), [...PUBLICATION_STATES].sort());
  for (const [state, fixture] of Object.entries(PUBLICATION_FIXTURES)) {
    const record = validatePublication(fixture);
    assert.equal(record.state, state);
    assert.ok(Object.isFrozen(record));
  }
});

test("a complete record without its owner, bytes or timestamps is rejected", () => {
  for (const key of ["ownerAccountId", "html", "completedAt", "receiptExpiresAt"]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.complete, { [key]: null })), {
      field: `publication.${key}`,
    });
  }
  /* C2 names owner, HTML, completion and receipt timestamps for `complete` and
     not the upload deadline, so a completion write that clears it is legal. */
  const cleared = validatePublication(
    replacing(PUBLICATION_FIXTURES.complete, { uploadExpiresAt: null }),
  );
  assert.equal(cleared.uploadExpiresAt, null);
});

test("an approved record carrying HTML or a receipt is rejected", () => {
  for (const patch of [
    { html: FIXTURE_HTML },
    { completedAt: FIXTURE_APPROVED_AT },
    { receiptExpiresAt: UPLOAD_EXPIRES_AT },
  ]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.approved, patch)));
  }
  for (const key of ["ownerAccountId", "uploadExpiresAt"]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.approved, { [key]: null })), {
      field: `publication.${key}`,
    });
  }
});

test("a pending record carrying an owner, a deadline or HTML is rejected", () => {
  for (const patch of [
    { ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID },
    { uploadExpiresAt: UPLOAD_EXPIRES_AT },
    { html: FIXTURE_HTML },
    { completedAt: FIXTURE_APPROVED_AT },
    { receiptExpiresAt: UPLOAD_EXPIRES_AT },
  ]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.pending, patch)));
  }
});

test("a terminal non-complete record may never carry a document", () => {
  for (const state of ["denied", "cancelled", "expired"]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES[state], { html: FIXTURE_HTML })), {
      field: "publication.html",
    });
  }
});

test("an unknown state is rejected, never treated as pending", () => {
  for (const state of ["published", "PENDING", "", null, "complete "]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.pending, { state })), {
      field: "publication.state",
    });
  }
});

test("stored HTML must hash and measure to the approved descriptor", () => {
  const { complete } = PUBLICATION_FIXTURES;
  /* Same length, different bytes: only the digest check catches this, and it is
     the check that makes the approval meaningful at all. */
  const tampered = FIXTURE_HTML.replace("Deterministic", "Determinist1c");
  assert.equal(Buffer.byteLength(tampered, "utf8"), Buffer.byteLength(FIXTURE_HTML, "utf8"));
  rejects(() => validatePublication(replacing(complete, { html: tampered })), {
    code: "descriptor_mismatch",
    field: "publication.html",
  });

  /* Right digest, wrong declared length: only the length comparison catches
     this, and getting it wrong lets a record claim a size nobody approved. */
  const wrongLength = replacing(descriptorFor(FIXTURE_HTML), {
    contentBytes: Buffer.byteLength(FIXTURE_HTML, "utf8") - 1,
  });
  rejects(() => validatePublication(replacing(complete, { descriptor: wrongLength })), {
    code: "descriptor_mismatch",
    field: "publication.html",
  });
});

test("stored HTML must be a non-empty document, well-formed and free of NUL", () => {
  const { complete } = PUBLICATION_FIXTURES;

  /* An empty body is refused by the body-side bound before the digest is even
     considered, so the guard is not merely a restatement of the descriptor's. */
  rejects(() => validatePublication(replacing(complete, { html: "" })), {
    field: "publication.html",
  });

  /* A fragment is the artifact shape, not a defect. `docbuild` emits no
     doctype and no `<html>` element -- `renderer/public/renderer.js` supplies
     the document element and drops the stored bytes into a sandboxed `srcdoc`
     body -- so a rule that required one refused every artifact the builder can
     make, and refused it after an owner had already approved the descriptor. */
  const fragment = "<p>fragment</p>";
  validatePublication(replacing(complete, { descriptor: descriptorFor(fragment), html: fragment }));

  /* What the rule is actually for: bytes that are not markup at all. */
  /* The unspaced comparison is the case a start-tag sniff gets wrong: `<b ` in
     `a<b and c>d` looks exactly like the opening of an element. */
  for (const notMarkup of [
    "just some words",
    '{"title":"not html"}',
    "a < b and c > d",
    "if a<b and c>d then stop",
  ]) {
    rejects(
      () =>
        validatePublication(
          replacing(complete, { descriptor: descriptorFor(notMarkup), html: notMarkup }),
        ),
      { field: "publication.html" },
    );
  }

  const withNul = FIXTURE_HTML.replace("Fixture document", "Fixture\u0000document");
  rejects(
    () => validatePublication(replacing(complete, { descriptor: descriptorFor(withNul), html: withNul })),
    { field: "publication.html" },
  );

  rejects(() => validatePublication(replacing(complete, { html: `${FIXTURE_HTML}\uD800` })), {
    field: "publication.html",
  });
});

test("an optional UTF-8 BOM is preserved and counted, not stripped", () => {
  const descriptor = descriptorFor(FIXTURE_HTML_WITH_BOM);
  assert.equal(descriptor.contentBytes, Buffer.byteLength(FIXTURE_HTML, "utf8") + 3);
  const record = validatePublication(
    replacing(PUBLICATION_FIXTURES.complete, { descriptor, html: FIXTURE_HTML_WITH_BOM }),
  );
  assert.equal(record.html, FIXTURE_HTML_WITH_BOM);

  /* A server that stripped the BOM before hashing would publish bytes that no
     longer hash to what the owner approved. */
  rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.complete, { descriptor })), {
    code: "descriptor_mismatch",
  });
});

test("a document at the exact 2 MiB limit is storable and one byte more is not", () => {
  const atLimit = htmlOfExactBytes(HOSTED_LIMITS.HTML_MAX_BYTES);
  assert.equal(Buffer.byteLength(atLimit, "utf8"), HOSTED_LIMITS.HTML_MAX_BYTES);
  const record = validatePublication(
    replacing(PUBLICATION_FIXTURES.complete, { descriptor: descriptorFor(atLimit), html: atLimit }),
  );
  assert.equal(record.descriptor.contentBytes, HOSTED_LIMITS.HTML_MAX_BYTES);

  const overLimit = htmlOfExactBytes(HOSTED_LIMITS.HTML_MAX_BYTES + 1);
  rejects(
    () =>
      validatePublication(
        replacing(PUBLICATION_FIXTURES.complete, {
          descriptor: descriptorFor(overLimit),
          html: overLimit,
        }),
      ),
    { code: "artifact_too_large" },
  );
});

test("identifiers and secret hashes are shape-checked", () => {
  const { pending } = PUBLICATION_FIXTURES;
  for (const id of [FIXTURE_PUBLICATION_ID.slice(0, 31), FIXTURE_PUBLICATION_ID.toUpperCase(), "abc123"]) {
    rejects(() => validatePublication(replacing(pending, { id })), { field: "publication.id" });
  }
  for (const key of ["agentSecretHash", "browserSecretHash"]) {
    rejects(() => validatePublication(replacing(pending, { [key]: "deadbeef" })), {
      field: `publication.${key}`,
    });
  }
});

test("the pairing code is display text, and the recommended grammar is advice", () => {
  const { pending } = PUBLICATION_FIXTURES;
  /* C2 says `userCode: string`. Enforcing this producer's minting alphabet in
     the shared validator would silently amend the contract for AHU-004 and
     AHU-007, so a differently-spelled code has to validate. */
  const other = "ABCD-1234";
  assert.ok(!HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN.test(other));
  assert.equal(validatePublication(replacing(pending, { userCode: other })).userCode, other);
  assert.ok(HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN.test(pending.userCode));

  for (const userCode of ["", " BCDF-2345", "a\u0007b", "x".repeat(HOSTED_LIMITS.USER_CODE_MAX_SCALARS + 1)]) {
    rejects(() => validatePublication(replacing(pending, { userCode })), {
      field: "publication.userCode",
    });
  }
});

test("an owner is a provider-scoped numeric id, never a username or an email", () => {
  const { approved } = PUBLICATION_FIXTURES;
  /* `xy_123456` and a bare `1234567890` both survive the digit rule once the
     first three characters are sliced off, so the provider prefix is the only
     thing that rejects them. */
  for (const ownerAccountId of [
    "octocat",
    "gh_",
    "gh_0123",
    "gh_abc",
    "user@example.com",
    "gh_-1",
    "xy_123456",
    "1234567890",
    42,
  ]) {
    rejects(() => validatePublication(replacing(approved, { ownerAccountId })), {
      field: "publication.ownerAccountId",
    });
  }
});

test("timestamps have exactly one legal spelling", () => {
  const { pending } = PUBLICATION_FIXTURES;
  for (const createdAt of [
    "2026-09-09T18:00:00Z",
    "2026-09-09T18:00:00.000+00:00",
    "2026-09-09 18:00:00.000Z",
    "2026-02-30T18:00:00.000Z",
    "2026-09-09T18:00:00.000z",
    "not-a-timestamp",
    "",
    1757440800000,
  ]) {
    rejects(() => validatePublication(replacing(pending, { createdAt })), {
      field: "publication.createdAt",
    });
  }
});

test("no lifetime on a record may run backwards", () => {
  const before = "2026-09-09T17:59:00.000Z";
  rejects(
    () => validatePublication(replacing(PUBLICATION_FIXTURES.pending, { pendingExpiresAt: before })),
    { field: "publication.pendingExpiresAt" },
  );
  /* An upload deadline or a completion before creation is a record claiming it
     finished before it started. */
  rejects(
    () => validatePublication(replacing(PUBLICATION_FIXTURES.approved, { uploadExpiresAt: before })),
    { field: "publication.uploadExpiresAt" },
  );
  rejects(
    () => validatePublication(replacing(PUBLICATION_FIXTURES.complete, { completedAt: before })),
    { field: "publication.completedAt" },
  );
  rejects(
    () =>
      validatePublication(replacing(PUBLICATION_FIXTURES.complete, { receiptExpiresAt: before })),
    { field: "publication.receiptExpiresAt" },
  );
});

test("an unknown field on a stored record is rejected", () => {
  const error = rejects(
    () => validatePublication(replacing(PUBLICATION_FIXTURES.pending, { ownerEmail: "a@example.com" })),
    { field: "publication" },
  );
  assert.match(error.message, /unknown field\(s\): ownerEmail/);
});

/* ------------------------------------------------------------------ */
/* C1/C6: origins                                                      */
/* ------------------------------------------------------------------ */

test("a canonical https origin is accepted and returned as itself", () => {
  assert.equal(validateOrigin(FIXTURE_APP_ORIGIN), FIXTURE_APP_ORIGIN);
  assert.equal(validateOrigin(FIXTURE_RENDER_ORIGIN), FIXTURE_RENDER_ORIGIN);
  assert.equal(validateOrigin("https://app.archon.example.com:8443"), "https://app.archon.example.com:8443");
  assert.equal(
    validateOrigin("https://xn--bcher-kva.example.com"),
    "https://xn--bcher-kva.example.com",
  );
});

test("anything that is not exactly an origin is rejected, not normalized", () => {
  for (const value of [
    `${FIXTURE_APP_ORIGIN}/`,
    `${FIXTURE_APP_ORIGIN}/docs`,
    `${FIXTURE_APP_ORIGIN}?a=1`,
    `${FIXTURE_APP_ORIGIN}#frag`,
    "https://user:pass@app.archon.example.com",
    "https://APP.archon.example.com",
    "HTTPS://app.archon.example.com",
    " https://app.archon.example.com",
    "https://app.archon.example.com:443",
    "https://münchen.example.com",
    "app.archon.example.com",
    "//app.archon.example.com",
    "data:text/html,<h1>x</h1>",
    "",
    null,
  ]) {
    rejects(() => validateOrigin(value));
  }
});

test("a trailing-dot host is refused in both modes", () => {
  /* It survives `URL.origin`, resolves to the same host, and never string-
     equals the Origin header a browser sends - so accepting it would make every
     later exact origin comparison fail for an operator who typed the dot. */
  for (const options of [{}, { production: false }]) {
    rejects(() => validateOrigin("https://app.archon.example.com.", options));
  }
});

test("production origins must be https, named, and under a listed suffix", () => {
  for (const value of [
    "http://app.archon.example.com",
    "https://127.0.0.1",
    "https://127.0.0.1:8888",
    "https://localhost",
    "https://[::1]",
    "https://[2001:db8::1]",
    "https://0.0.0.0",
    FIXTURE_UNLISTED_SUFFIX_ORIGIN,
    "https://app.internal",
    "https://co.uk",
  ]) {
    rejects(() => validateOrigin(value));
  }
});

test("local-test mode relaxes the scheme and nothing else about the spelling", () => {
  const options = { production: false };
  assert.equal(validateOrigin(FIXTURE_LOCAL_APP_ORIGIN, options), FIXTURE_LOCAL_APP_ORIGIN);
  assert.equal(validateOrigin(FIXTURE_LOCAL_RENDER_ORIGIN, options), FIXTURE_LOCAL_RENDER_ORIGIN);
  assert.equal(validateOrigin("http://[::1]:8888", options), "http://[::1]:8888");
  assert.equal(validateOrigin(FIXTURE_APP_ORIGIN, options), FIXTURE_APP_ORIGIN);

  rejects(() => validateOrigin("ftp://127.0.0.1", options));
  rejects(() => validateOrigin(`${FIXTURE_LOCAL_APP_ORIGIN}/`, options));
});

test("loopback origins are recognised as such", () => {
  for (const origin of [FIXTURE_LOCAL_APP_ORIGIN, FIXTURE_LOCAL_RENDER_ORIGIN, "http://[::1]:1"]) {
    assert.ok(isLoopbackOrigin(origin));
  }
  for (const origin of [FIXTURE_APP_ORIGIN, "https://archon-app.pages.dev"]) {
    assert.ok(!isLoopbackOrigin(origin));
  }
});

test("registrable sites come from the public-suffix list, not the last two labels", () => {
  assert.equal(registrableSite(FIXTURE_APP_ORIGIN), "example.com");
  assert.equal(registrableSite(FIXTURE_RENDER_ORIGIN), "example.net");
  assert.equal(registrableSite(FIXTURE_SIBLING_RENDER_ORIGIN), "example.com");

  /* Two hosts under a private suffix differ only in their first label. Last-
     two-labels arithmetic calls them one site; the PSL correctly calls them
     two. */
  assert.notEqual(
    registrableSite(FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN),
    registrableSite(FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN),
  );
  rejects(() => registrableSite(FIXTURE_UNLISTED_SUFFIX_ORIGIN));
  rejects(() => registrableSite("https://co.uk"));
  rejects(() => registrableSite("https://127.0.0.1"));
});

/* ------------------------------------------------------------------ */
/* C3: wire envelopes                                                  */
/* ------------------------------------------------------------------ */

test("a start response is accepted and its browser URL is pinned to the app", () => {
  const start = validateStartResponse(START_RESPONSE, APP);
  assert.equal(start.publicationId, FIXTURE_PUBLICATION_ID);
  assert.ok(Object.isFrozen(start));

  for (const verificationUriComplete of [
    `${FIXTURE_RENDER_ORIGIN}/publish/authorize#${FIXTURE_BROWSER_SECRET}`,
    `https://evil.example.net/publish/authorize#${FIXTURE_BROWSER_SECRET}`,
    `${FIXTURE_APP_ORIGIN}/publish/authorise#${FIXTURE_BROWSER_SECRET}`,
    `${FIXTURE_APP_ORIGIN}/publish/authorize?s=1#${FIXTURE_BROWSER_SECRET}`,
    `${FIXTURE_APP_ORIGIN}/publish/authorize`,
    `${FIXTURE_APP_ORIGIN}/publish/authorize#`,
    "not-a-url",
  ]) {
    rejects(() => validateStartResponse(replacing(START_RESPONSE, { verificationUriComplete }), APP), {
      field: "start.verificationUriComplete",
    });
  }
});

test("a start response may never carry the agent secret in its browser URL", () => {
  /* C3 puts the *browser* secret in the fragment. The agent bearer in a URL is
     the upload capability handed to anything that sees a referrer, a history
     entry or a screen. */
  rejects(
    () =>
      validateStartResponse(
        replacing(START_RESPONSE, {
          verificationUriComplete: `${FIXTURE_APP_ORIGIN}/publish/authorize#${FIXTURE_AGENT_SECRET}`,
        }),
        APP,
      ),
    { field: "start.verificationUriComplete" },
  );
});

test("a start response must carry a well-shaped bearer and the advertised interval", () => {
  for (const agentSecret of ["short", "has space in it and is long enough!!", "", 42]) {
    rejects(() => validateStartResponse(replacing(START_RESPONSE, { agentSecret }), APP), {
      field: "start.agentSecret",
    });
  }
  rejects(() => validateStartResponse(replacing(START_RESPONSE, { intervalSeconds: 1 }), APP), {
    field: "start.intervalSeconds",
  });
  rejects(() => validateStartResponse(without(START_RESPONSE, "userCode"), APP), { field: "start" });
});

test("the pending and complete envelopes are accepted and returned frozen", () => {
  const pending = validateResult(PENDING_RESULT_ENVELOPE);
  assert.equal(pending.state, "pending");
  assert.ok(Object.isFrozen(pending));

  const complete = validateResult(COMPLETE_RESULT_ENVELOPE, APP);
  assert.equal(complete.result.documentId, FIXTURE_PUBLICATION_ID);
  assert.ok(Object.isFrozen(complete.result));
});

test("a completion receipt cannot be validated without the origin it must belong to", () => {
  /* Omitting `appOrigin` is a programming error, not a malformed message, so it
     raises a TypeError. Making the omission throw is the whole point: a default
     would make "validate this receipt against nothing in particular" the
     easiest call to write, and that call is what lets a hostile responder hand
     a client somebody else's URL. */
  assert.throws(() => validateResult(COMPLETE_RESULT_ENVELOPE), TypeError);
  assert.throws(() => validateResult(COMPLETE_RESULT_ENVELOPE, { appOrigin: "" }), TypeError);
  assert.throws(() => validateStartResponse(START_RESPONSE), TypeError);
  /* A non-complete envelope needs no receipt and therefore no origin. */
  assert.equal(validateResult(PENDING_RESULT_ENVELOPE).state, "pending");
});

test("a receipt on someone else's origin is rejected", () => {
  const { result } = COMPLETE_RESULT_ENVELOPE;
  const other = "1111111122222222333333334444444a";
  for (const url of [
    `https://evil.example.net/docs/${result.documentId}`,
    `${FIXTURE_RENDER_ORIGIN}/docs/${result.documentId}`,
    `${FIXTURE_APP_ORIGIN}/docs/${other}`,
    `${FIXTURE_APP_ORIGIN}/documents/${result.documentId}`,
    `${FIXTURE_APP_ORIGIN}/docs/${result.documentId}/`,
    `http://app.archon.example.com/docs/${result.documentId}`,
    `/docs/${result.documentId}`,
    "",
  ]) {
    rejects(
      () => validateResult(replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, url } }), APP),
      { field: "result.result.url" },
    );
  }
});

test("a loopback receipt validates in local-test mode and not in production", () => {
  const documentId = FIXTURE_PUBLICATION_ID;
  const local = replacing(COMPLETE_RESULT_ENVELOPE, {
    result: {
      ...COMPLETE_RESULT_ENVELOPE.result,
      url: `${FIXTURE_LOCAL_APP_ORIGIN}/docs/${documentId}`,
    },
  });
  const validated = validateResult(local, {
    appOrigin: FIXTURE_LOCAL_APP_ORIGIN,
    production: false,
  });
  assert.equal(validated.result.url, `${FIXTURE_LOCAL_APP_ORIGIN}/docs/${documentId}`);
  /* Without the option the same receipt is refused, which is what makes the
     option load-bearing rather than decorative. */
  assert.throws(() => validateResult(local, { appOrigin: FIXTURE_LOCAL_APP_ORIGIN }), (error) => {
    assert.ok(error instanceof HostedContractError);
    return true;
  });
});

test("an error envelope cannot pass result validation", () => {
  const error = rejects(() => validateResult(ERROR_ENVELOPE), { field: "result" });
  assert.match(error.message, /must not be an error envelope/);
  rejects(() => validateResult({ ...PENDING_RESULT_ENVELOPE, error: ERROR_ENVELOPE.error }));
});

test("a receipt exists exactly when the state is complete", () => {
  rejects(() => validateResult(without(COMPLETE_RESULT_ENVELOPE, "result"), APP), {
    field: "result.result",
  });
  for (const state of ["pending", "approved", "denied", "cancelled", "expired"]) {
    rejects(() => validateResult(replacing(COMPLETE_RESULT_ENVELOPE, { state }), APP), {
      field: "result.result",
    });
  }
});

test("an envelope with a wrong version, interval or state is rejected", () => {
  rejects(() => validateResult(replacing(PENDING_RESULT_ENVELOPE, { v: 2 })));
  for (const intervalSeconds of [0, 1, "5", null]) {
    rejects(() => validateResult(replacing(PENDING_RESULT_ENVELOPE, { intervalSeconds })), {
      field: "result.intervalSeconds",
    });
  }
  rejects(() => validateResult(replacing(PENDING_RESULT_ENVELOPE, { state: "published" })), {
    field: "result.state",
  });
});

test("a receipt cannot carry an unknown field or a malformed owner", () => {
  const { result } = COMPLETE_RESULT_ENVELOPE;
  rejects(() =>
    validateResult(
      replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, agentSecret: "leaked" } }),
      APP,
    ),
  );
  rejects(() =>
    validateResult(
      replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, ownerAccountId: "octocat" } }),
      APP,
    ),
  );
});

test("an error envelope's retryability is derived from its code, never believed", () => {
  const envelope = validateWireError(ERROR_ENVELOPE);
  assert.equal(envelope.error.code, "state_conflict");
  assert.equal(envelope.error.retryable, false);

  for (const retryable of [true, "false", 0, null]) {
    rejects(() =>
      validateWireError(replacing(ERROR_ENVELOPE, { error: { ...ERROR_ENVELOPE.error, retryable } })),
      { field: "errorEnvelope.error.retryable" },
    );
  }
  rejects(() =>
    validateWireError(replacing(ERROR_ENVELOPE, { error: { ...ERROR_ENVELOPE.error, code: "teapot" } })),
  );
  rejects(() =>
    validateWireError(
      replacing(ERROR_ENVELOPE, {
        error: { ...ERROR_ENVELOPE.error, message: "m".repeat(HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH + 1) },
      }),
    ),
  );
});

/* ------------------------------------------------------------------ */
/* C4: private read and renderer messages                              */
/* ------------------------------------------------------------------ */

test("document metadata is accepted and carries no bytes and no bearer", () => {
  const metadata = validateDocumentMetadata(DOCUMENT_METADATA);
  assert.equal(metadata.documentId, FIXTURE_PUBLICATION_ID);
  assert.ok(!Object.hasOwn(metadata, "html"));

  for (const patch of [{ html: FIXTURE_HTML }, { csrfToken: "x" }, { agentSecret: "x" }]) {
    rejects(() => validateDocumentMetadata(replacing(DOCUMENT_METADATA, patch)), { field: "document" });
  }
  for (const key of ["documentId", "title", "ownerAccountId", "contentSha256", "contentBytes", "createdAt"]) {
    rejects(() => validateDocumentMetadata(without(DOCUMENT_METADATA, key)), { field: "document" });
  }
  rejects(() => validateDocumentMetadata(replacing(DOCUMENT_METADATA, { ownerAccountId: "octocat" })), {
    field: "document.ownerAccountId",
  });
});

test("the renderer handshake tolerates nothing extra", () => {
  /* The viewer sends a private document in reply to this message, so a
     handshake that accepted extra fields would be a channel from the renderer
     into the account origin's decision about what to send. */
  assert.deepEqual({ ...validateReadyMessage(READY_MESSAGE) }, { type: "archon:ready", v: 1 });
  for (const patch of [{ type: "archon:render" }, { v: 2 }, { html: FIXTURE_HTML }, { origin: "x" }]) {
    rejects(() => validateReadyMessage(replacing(READY_MESSAGE, patch)));
  }
});

test("a render message re-applies the byte cap on the receiving origin", () => {
  const message = validateRenderMessage(RENDER_MESSAGE);
  assert.equal(message.html, FIXTURE_HTML);
  assert.ok(Object.isFrozen(message));

  rejects(
    () =>
      validateRenderMessage(
        replacing(RENDER_MESSAGE, { html: htmlOfExactBytes(HOSTED_LIMITS.HTML_MAX_BYTES + 1) }),
      ),
    { code: "artifact_too_large", field: "renderMessage.html" },
  );
  for (const patch of [{ html: "" }, { html: "<html>a\u0000b</html>" }, { html: 42 }, { type: "archon:ready" }, { v: 0 }]) {
    rejects(() => validateRenderMessage(replacing(RENDER_MESSAGE, patch)));
  }
});

/* ------------------------------------------------------------------ */
/* corpus-wide invariants                                              */
/* ------------------------------------------------------------------ */

test("every raised contract error serializes to a valid wire envelope", () => {
  assert.ok(observedRejections.length > 0, "no rejections were collected");
  for (const error of observedRejections) {
    const wire = validateWireError(error.toWire());
    assert.equal(wire.error.code, error.code);
    assert.equal(ERROR_CODES[error.code].retryable, error.retryable);
    assert.equal(ERROR_CODES[error.code].status, error.status);
  }
});

test("a validator never reports a backing service as the reason", () => {
  /* "Unavailable" is not a validation outcome. If a validator could raise it,
     a caller that cannot reach a store would be one `catch` away from treating
     an outage as a checked input. */
  for (const error of observedRejections) {
    assert.notEqual(error.code, "unavailable");
    assert.ok(
      ["invalid_request", "artifact_too_large", "descriptor_mismatch"].includes(error.code),
      `unexpected validation code ${error.code}`,
    );
    assert.ok([...error.message].length <= HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH);
  }
});

test("neither module reads a clock, an environment or a network", () => {
  for (const name of ["contracts.mjs", "config.mjs"]) {
    const source = readFileSync(join(LIB, name), "utf8");
    for (const forbidden of ["Date.now", "process.env", "fetch(", "getStore", "import("]) {
      assert.ok(!source.includes(forbidden), `${name} must not reference ${forbidden}`);
    }
  }

  /* Belt and braces: with the clock removed entirely, every validator still
     answers. A validator that consulted the time would throw here. */
  const realNow = Date.now;
  Date.now = () => {
    throw new Error("a validator consulted the clock");
  };
  try {
    validateDescriptor(VALID_DESCRIPTOR);
    validatePublication(PUBLICATION_FIXTURES.complete);
    validateResult(COMPLETE_RESULT_ENVELOPE, APP);
    validateStartResponse(START_RESPONSE, APP);
    validateOrigin(FIXTURE_APP_ORIGIN);
    validateWireError(ERROR_ENVELOPE);
    validatePrincipal(FIXTURE_PRINCIPAL);
    validateDocumentMetadata(DOCUMENT_METADATA);
    readHostedConfig(FIXTURE_ENV);
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------------ */
/* C6: configuration                                                   */
/* ------------------------------------------------------------------ */

test("a complete production configuration is accepted, with publishing off", () => {
  const config = readHostedConfig(FIXTURE_ENV);
  assert.equal(config.mode, "production");
  assert.equal(config.production, true);
  assert.equal(config.appOrigin, FIXTURE_APP_ORIGIN);
  assert.equal(config.renderOrigin, FIXTURE_RENDER_ORIGIN);
  assert.equal(config.appSite, "example.com");
  assert.equal(config.renderSite, "example.net");
  assert.equal(config.publishEnabled, false);
  assert.ok(Object.isFrozen(config));
});

test("the reader consults exactly C6's five operator variables", () => {
  assert.deepEqual([...HOSTED_CONFIG_KEYS].sort(), [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "HOSTED_APP_ORIGIN",
    "HOSTED_PUBLISH_ENABLED",
    "HOSTED_RENDER_ORIGIN",
  ]);
  /* An environment carrying nothing but those five is enough, and an extra
     variable changes nothing - in particular there is no environment value
     that selects the relaxed mode. */
  const noisy = { ...FIXTURE_ENV, HOSTED_ENV: "local-test", NODE_ENV: "test", CONTEXT: "dev" };
  assert.equal(readHostedConfig(noisy).production, true);
});

test("publishing is disabled unless an operator spells it exactly", () => {
  assert.equal(readHostedConfig({ ...FIXTURE_ENV, HOSTED_PUBLISH_ENABLED: "true" }).publishEnabled, true);
  assert.equal(readHostedConfig({ ...FIXTURE_ENV, HOSTED_PUBLISH_ENABLED: "false" }).publishEnabled, false);
  assert.equal(readHostedConfig(without(FIXTURE_ENV, "HOSTED_PUBLISH_ENABLED")).publishEnabled, false);
  for (const value of ["1", "yes", "TRUE", "on"]) {
    assert.throws(
      () => readHostedConfig({ ...FIXTURE_ENV, HOSTED_PUBLISH_ENABLED: value }),
      (error) => error instanceof HostedConfigError && error.key === "HOSTED_PUBLISH_ENABLED",
    );
  }
});

test("every required key is required, and the error names the key", () => {
  for (const key of [
    "HOSTED_APP_ORIGIN",
    "HOSTED_RENDER_ORIGIN",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
  ]) {
    assert.throws(
      () => readHostedConfig(without(FIXTURE_ENV, key)),
      (error) => {
        assert.ok(error instanceof HostedConfigError);
        assert.equal(error.key, key);
        assert.equal(error.code, "invalid_configuration");
        return true;
      },
    );
    assert.throws(
      () => readHostedConfig({ ...FIXTURE_ENV, [key]: "" }),
      (error) => error instanceof HostedConfigError && error.key === key,
    );
  }
});

test("a configuration message reads as a sentence about its own key", () => {
  /* The re-word that strips the contract validator's field path is what makes a
     deploy log legible; without a test it can cut at the wrong offset and
     nobody notices until an outage. */
  const error = (() => {
    try {
      readHostedConfig({ ...FIXTURE_ENV, HOSTED_APP_ORIGIN: "http://app.archon.example.com" });
      return null;
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.ok(error instanceof HostedConfigError);
  assert.equal(error.message, "HOSTED_APP_ORIGIN must use https in production");
  assert.ok(error.cause instanceof HostedContractError);
});

test("the app and renderer must be two different registrable sites", () => {
  assert.throws(
    () => readHostedConfig({ ...FIXTURE_ENV, HOSTED_RENDER_ORIGIN: FIXTURE_APP_ORIGIN }),
    (error) => error instanceof HostedConfigError && error.key === "HOSTED_RENDER_ORIGIN",
  );
  assert.throws(
    () => readHostedConfig({ ...FIXTURE_ENV, HOSTED_RENDER_ORIGIN: FIXTURE_SIBLING_RENDER_ORIGIN }),
    (error) => {
      assert.ok(error instanceof HostedConfigError);
      assert.match(error.message, /different registrable site/);
      return true;
    },
  );

  const privateSuffix = readHostedConfig({
    ...FIXTURE_ENV,
    HOSTED_APP_ORIGIN: FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN,
    HOSTED_RENDER_ORIGIN: FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN,
  });
  assert.notEqual(privateSuffix.appSite, privateSuffix.renderSite);
});

test("the relaxed mode is loopback-only and cannot describe a real deployment", () => {
  const local = { mode: LOCAL_TEST };
  const config = readHostedConfig(FIXTURE_LOCAL_ENV, local);
  assert.equal(config.production, false);
  assert.equal(config.appOrigin, FIXTURE_LOCAL_APP_ORIGIN);
  assert.equal(config.appSite, null);

  /* The site-separation rule cannot run on loopback hosts, so requiring both
     origins to *be* loopback is what stops the relaxed mode from becoming a way
     to configure two real sibling subdomains with that rule skipped. */
  for (const key of ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"]) {
    assert.throws(
      () => readHostedConfig({ ...FIXTURE_LOCAL_ENV, [key]: FIXTURE_APP_ORIGIN }, local),
      (error) => error instanceof HostedConfigError && error.key === key,
    );
  }
  /* Two identical loopback origins are still two names for one thing. */
  assert.throws(
    () =>
      readHostedConfig(
        { ...FIXTURE_LOCAL_ENV, HOSTED_RENDER_ORIGIN: FIXTURE_LOCAL_APP_ORIGIN },
        local,
      ),
    (error) => error instanceof HostedConfigError && error.key === "HOSTED_RENDER_ORIGIN",
  );
  /* And it still requires every other key. */
  assert.throws(
    () => readHostedConfig(without(FIXTURE_LOCAL_ENV, "GITHUB_CLIENT_SECRET"), local),
    HostedConfigError,
  );
  /* The loopback environment is refused outright by the default mode. */
  assert.throws(() => readHostedConfig(FIXTURE_LOCAL_ENV), HostedConfigError);
  assert.throws(
    () => readHostedConfig(FIXTURE_ENV, { mode: "preview" }),
    (error) => error instanceof HostedConfigError && error.key === "mode",
  );
  /* Without a shape check the reader would index into a non-object and raise a
     TypeError from somewhere unhelpful instead of a named configuration
     fault. */
  for (const env of [null, undefined, "HOSTED_APP_ORIGIN=x", 42]) {
    assert.throws(
      () => readHostedConfig(env),
      (error) => error instanceof HostedConfigError && error.key === "env",
    );
  }
});

test("a weak or misspelled GitHub credential is refused", () => {
  for (const patch of [
    { GITHUB_CLIENT_ID: "short" },
    { GITHUB_CLIENT_ID: "has space here" },
    { GITHUB_CLIENT_SECRET: "tooshort" },
    { GITHUB_CLIENT_SECRET: "has whitespace in it here" },
    { GITHUB_CLIENT_SECRET: FIXTURE_ENV.GITHUB_CLIENT_ID },
  ]) {
    assert.throws(() => readHostedConfig({ ...FIXTURE_ENV, ...patch }), HostedConfigError);
  }
});

test("the client secret is readable on purpose and unprintable by accident", () => {
  const secret = FIXTURE_ENV.GITHUB_CLIENT_SECRET;
  const config = readHostedConfig(FIXTURE_ENV);

  /* Reachable exactly one way: by calling a verb, at the one call site that
     performs the code exchange. */
  assert.equal(config.github.readClientSecret(), secret);

  const renderings = [
    JSON.stringify(config),
    JSON.stringify(config.github),
    JSON.stringify({ config }),
    inspect(config, { depth: null }),
    inspect(config.github, { depth: null }),
    /* The combination a getter could not survive: an explicit deep dump that
       opts out of custom inspection and invokes accessors. A method has no
       value for it to print. */
    inspect(config, { customInspect: false, showHidden: true, getters: true, depth: 6 }),
    inspect(config.github, { customInspect: false, showHidden: true, getters: true, depth: 6 }),
    formatHostedConfig(config),
    String(config.github),
    `${config.github}`,
    Object.keys(config.github).join(","),
    JSON.stringify({ ...config.github }),
    JSON.stringify(Object.getOwnPropertyDescriptors(config.github)),
    JSON.stringify(structuredClone({ ...config.github })),
  ];
  for (const rendering of renderings) {
    assert.ok(!rendering.includes(secret), `secret leaked into: ${rendering.slice(0, 160)}`);
  }
  assert.ok(JSON.stringify(config).includes(REDACTED));

  /* A configuration exception is copied into logs and issue comments without
     being reread, so it names the key and never the value. */
  const thrown = (() => {
    try {
      readHostedConfig({ ...FIXTURE_ENV, GITHUB_CLIENT_SECRET: "shorty" });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(thrown instanceof HostedConfigError);
  assert.ok(!`${thrown.message}${thrown.stack}`.includes("shorty"));
});

test("the log line names every field an operator needs to read", () => {
  /* Asserting only "does not contain the secret" let a formatter that returned
     the literal string `[redacted]` pass, which loses the one operator-facing
     record of which origins and which publish state a deploy came up with. */
  assert.equal(
    formatHostedConfig(readHostedConfig(FIXTURE_ENV)),
    "mode=production" +
      ` app=${FIXTURE_APP_ORIGIN}` +
      ` render=${FIXTURE_RENDER_ORIGIN}` +
      " publish=disabled" +
      ` githubClientId=${FIXTURE_ENV.GITHUB_CLIENT_ID}` +
      ` githubClientSecret=${REDACTED}`,
  );
  assert.match(
    formatHostedConfig(readHostedConfig({ ...FIXTURE_ENV, HOSTED_PUBLISH_ENABLED: "true" })),
    /publish=enabled/,
  );
});
