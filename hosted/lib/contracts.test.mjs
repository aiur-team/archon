/**
 * Regressions for the hosted contracts and their configuration reader.
 *
 * Every test below names one guarded condition in `contracts.mjs` or
 * `config.mjs`. That correspondence is the point rather than a convenience:
 * AHU-001's acceptance requires that removing any one of those conditions makes
 * a test here fail, so a test that would still pass with its guard deleted is a
 * test that is not doing anything.
 *
 * The suite therefore leans on rejection cases far more than on happy paths.
 * The happy paths prove the shapes are usable; the rejections are the contract.
 *
 *   node --test hosted/lib/contracts.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";

import {
  ERROR_CODES,
  HOSTED_LIMITS,
  HostedContractError,
  PUBLICATION_STATES,
  registrableSite,
  validateDescriptor,
  validateOrigin,
  validatePublication,
  validateResult,
  validateWireError,
} from "./contracts.mjs";
import { formatHostedConfig, HostedConfigError, readHostedConfig, REDACTED } from "./config.mjs";
import {
  COMPLETE_RESULT_ENVELOPE,
  descriptorFor,
  ERROR_ENVELOPE,
  FIXTURE_APP_ORIGIN,
  FIXTURE_ENV,
  FIXTURE_HTML,
  FIXTURE_HTML_WITH_BOM,
  FIXTURE_LOCAL_APP_ORIGIN,
  FIXTURE_LOCAL_ENV,
  FIXTURE_LOCAL_RENDER_ORIGIN,
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN,
  FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RENDER_ORIGIN,
  FIXTURE_SIBLING_RENDER_ORIGIN,
  FIXTURE_UNLISTED_SUFFIX_ORIGIN,
  htmlOfExactBytes,
  PENDING_RESULT_ENVELOPE,
  PUBLICATION_FIXTURES,
  replacing,
  VALID_DESCRIPTOR,
  without,
} from "../test/contract-fixtures.mjs";

/** Every rejection this module can produce, collected for the purity check. */
const observedRejections = [];

/**
 * Assert that `fn` throws a `HostedContractError` with the expected code, and
 * record the error so the "validators never report a service outage" test can
 * inspect the whole corpus at the end.
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
  assert.equal(HOSTED_LIMITS.HTML_MAX_BYTES, 2097152);
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

test("a title outside its bounds or carrying control text is rejected", () => {
  const tooLong = "t".repeat(HOSTED_LIMITS.TITLE_MAX_SCALARS + 1);
  for (const title of ["", tooLong, "line\nbreak", "bell\u0007", "\uD800lone surrogate", 7, null]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { title })), {
      field: "descriptor.title",
    });
  }
});

test("the title bound counts Unicode scalar values, not UTF-16 code units", () => {
  /* 160 astral scalars is 320 UTF-16 units. A `.length` bound would reject a
     title the contract allows, which is how an emoji becomes a support ticket. */
  const astral = "\u{1F5FA}".repeat(HOSTED_LIMITS.TITLE_MAX_SCALARS);
  assert.equal(astral.length, HOSTED_LIMITS.TITLE_MAX_SCALARS * 2);
  const descriptor = validateDescriptor(replacing(VALID_DESCRIPTOR, { title: astral }));
  assert.equal(descriptor.title, astral);
  rejects(() =>
    validateDescriptor(replacing(VALID_DESCRIPTOR, { title: `${astral}\u{1F5FA}` })),
  );
});

test("only the html artifact format is accepted", () => {
  for (const artifactFormat of ["zip", "HTML", "", null, "html "]) {
    rejects(() => validateDescriptor(replacing(VALID_DESCRIPTOR, { artifactFormat })), {
      field: "descriptor.artifactFormat",
    });
  }
});

test("an owner claim in the descriptor is rejected rather than ignored", () => {
  /* The owner is fixed from the approving browser session. A descriptor is
     attacker-controlled input, so an owner field in it is an injection attempt
     and must fail the request rather than be silently dropped. */
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
  for (const key of ["ownerAccountId", "html", "completedAt", "receiptExpiresAt", "uploadExpiresAt"]) {
    rejects(() => validatePublication(replacing(PUBLICATION_FIXTURES.complete, { [key]: null })), {
      field: `publication.${key}`,
    });
  }
});

test("an approved record carrying HTML or a receipt is rejected", () => {
  for (const patch of [
    { html: FIXTURE_HTML },
    { completedAt: "2026-09-09T18:06:00.000Z" },
    { receiptExpiresAt: "2026-09-10T18:06:00.000Z" },
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
    { uploadExpiresAt: "2026-09-09T18:12:00.000Z" },
    { html: FIXTURE_HTML },
    { completedAt: "2026-09-09T18:06:00.000Z" },
    { receiptExpiresAt: "2026-09-10T18:06:00.000Z" },
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

  const longer = `${FIXTURE_HTML}<!-- extra -->`;
  rejects(() => validatePublication(replacing(complete, { html: longer })), {
    code: "descriptor_mismatch",
    field: "publication.html",
  });

  /* A descriptor whose digest is right and whose byte count is wrong: only the
     length comparison catches this one, and getting it wrong would let a
     record claim a size the owner never approved. */
  const wrongLength = replacing(descriptorFor(FIXTURE_HTML), {
    contentBytes: Buffer.byteLength(FIXTURE_HTML, "utf8") - 1,
  });
  rejects(() => validatePublication(replacing(complete, { descriptor: wrongLength })), {
    code: "descriptor_mismatch",
    field: "publication.html",
  });
});

test("stored HTML must be a document, must be well-formed and must carry no NUL", () => {
  const { complete } = PUBLICATION_FIXTURES;
  const notADocument = "<p>fragment</p>";
  rejects(
    () =>
      validatePublication(
        replacing(complete, { descriptor: descriptorFor(notADocument), html: notADocument }),
      ),
    { field: "publication.html" },
  );

  const withNul = FIXTURE_HTML.replace("Fixture document", "Fixture\u0000document");
  rejects(
    () => validatePublication(replacing(complete, { descriptor: descriptorFor(withNul), html: withNul })),
    { field: "publication.html" },
  );

  const lone = `${FIXTURE_HTML}\uD800`;
  rejects(() => validatePublication(replacing(complete, { html: lone })), {
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

test("identifiers, secret hashes and the pairing code are shape-checked", () => {
  const { pending } = PUBLICATION_FIXTURES;
  for (const id of [FIXTURE_PUBLICATION_ID.slice(0, 31), FIXTURE_PUBLICATION_ID.toUpperCase(), "abc123"]) {
    rejects(() => validatePublication(replacing(pending, { id })), { field: "publication.id" });
  }
  for (const key of ["agentSecretHash", "browserSecretHash"]) {
    rejects(() => validatePublication(replacing(pending, { [key]: "deadbeef" })), {
      field: `publication.${key}`,
    });
  }
  for (const userCode of ["bcdf-2345", "BCDF2345", "BCDF-234", "AEIO-2345", ""]) {
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

test("a record whose lifetimes run backwards is rejected", () => {
  rejects(
    () =>
      validatePublication(
        replacing(PUBLICATION_FIXTURES.pending, { pendingExpiresAt: "2026-09-09T17:59:00.000Z" }),
      ),
    { field: "publication.pendingExpiresAt" },
  );
  rejects(
    () =>
      validatePublication(
        replacing(PUBLICATION_FIXTURES.complete, { receiptExpiresAt: "2026-09-09T18:05:00.000Z" }),
      ),
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
});

test("anything that is not exactly an origin is rejected, not normalized", () => {
  for (const value of [
    `${FIXTURE_APP_ORIGIN}/`,
    `${FIXTURE_APP_ORIGIN}/docs`,
    `${FIXTURE_APP_ORIGIN}?a=1`,
    `${FIXTURE_APP_ORIGIN}#frag`,
    "https://user:pass@app.archon.example.com",
    "https://APP.archon.example.com",
    " https://app.archon.example.com",
    "https://app.archon.example.com:443",
    "app.archon.example.com",
    "//app.archon.example.com",
    "data:text/html,<h1>x</h1>",
    "",
    null,
  ]) {
    rejects(() => validateOrigin(value));
  }
});

test("production origins must be https, named, and under a listed suffix", () => {
  for (const value of [
    "http://app.archon.example.com",
    "https://127.0.0.1",
    "https://127.0.0.1:8888",
    "https://localhost",
    "https://[::1]",
    FIXTURE_UNLISTED_SUFFIX_ORIGIN,
    "https://app.internal",
    "https://co.uk",
  ]) {
    rejects(() => validateOrigin(value));
  }
});

test("local-test mode permits http only on a loopback host", () => {
  const options = { production: false };
  assert.equal(validateOrigin(FIXTURE_LOCAL_APP_ORIGIN, options), FIXTURE_LOCAL_APP_ORIGIN);
  assert.equal(validateOrigin(FIXTURE_LOCAL_RENDER_ORIGIN, options), FIXTURE_LOCAL_RENDER_ORIGIN);
  assert.equal(validateOrigin("http://[::1]:8888", options), "http://[::1]:8888");
  assert.equal(validateOrigin(FIXTURE_APP_ORIGIN, options), FIXTURE_APP_ORIGIN);

  /* The loopback allowance is the only thing local-test relaxes. */
  rejects(() => validateOrigin("http://app.archon.example.com", options));
  rejects(() => validateOrigin("ftp://127.0.0.1", options));
  rejects(() => validateOrigin(`${FIXTURE_LOCAL_APP_ORIGIN}/`, options));
});

test("registrable sites come from the public-suffix list, not the last two labels", () => {
  assert.equal(registrableSite(FIXTURE_APP_ORIGIN), "example.com");
  assert.equal(registrableSite(FIXTURE_RENDER_ORIGIN), "example.net");
  assert.equal(registrableSite(FIXTURE_SIBLING_RENDER_ORIGIN), "example.com");

  /* Two hosts under a private suffix differ only in their first label. Last-two-
     labels arithmetic calls them one site; the PSL correctly calls them two. */
  assert.notEqual(
    registrableSite(FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN),
    registrableSite(FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN),
  );
  rejects(() => registrableSite(FIXTURE_UNLISTED_SUFFIX_ORIGIN));
});

/* ------------------------------------------------------------------ */
/* C3: wire envelopes                                                  */
/* ------------------------------------------------------------------ */

test("the pending and complete envelopes are accepted and returned frozen", () => {
  const pending = validateResult(PENDING_RESULT_ENVELOPE);
  assert.equal(pending.state, "pending");
  assert.ok(Object.isFrozen(pending));

  const complete = validateResult(COMPLETE_RESULT_ENVELOPE);
  assert.equal(complete.result.documentId, FIXTURE_PUBLICATION_ID);
  assert.ok(Object.isFrozen(complete.result));
});

test("an error envelope cannot pass result validation", () => {
  const error = rejects(() => validateResult(ERROR_ENVELOPE), { field: "result" });
  assert.match(error.message, /must not be an error envelope/);
  rejects(() => validateResult({ ...PENDING_RESULT_ENVELOPE, error: ERROR_ENVELOPE.error }));
});

test("a receipt exists exactly when the state is complete", () => {
  rejects(() => validateResult(without(COMPLETE_RESULT_ENVELOPE, "result")), {
    field: "result.result",
  });
  for (const state of ["pending", "approved", "denied", "cancelled", "expired"]) {
    rejects(() => validateResult(replacing(COMPLETE_RESULT_ENVELOPE, { state })), {
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

test("a receipt URL must address its own document on a valid service origin", () => {
  const { result } = COMPLETE_RESULT_ENVELOPE;
  const other = "1111111122222222333333334444444a";
  for (const url of [
    `${FIXTURE_APP_ORIGIN}/docs/${other}`,
    `${FIXTURE_APP_ORIGIN}/documents/${result.documentId}`,
    `${FIXTURE_APP_ORIGIN}/docs/${result.documentId}/`,
    `http://app.archon.example.com/docs/${result.documentId}`,
    `${FIXTURE_UNLISTED_SUFFIX_ORIGIN}/docs/${result.documentId}`,
    `/docs/${result.documentId}`,
  ]) {
    rejects(() => validateResult(replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, url } })));
  }
});

test("a receipt cannot carry an unknown field or a malformed owner", () => {
  const { result } = COMPLETE_RESULT_ENVELOPE;
  rejects(() =>
    validateResult(
      replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, agentSecret: "leaked" } }),
    ),
  );
  rejects(() =>
    validateResult(replacing(COMPLETE_RESULT_ENVELOPE, { result: { ...result, ownerAccountId: "octocat" } })),
  );
});

test("an error envelope's retryability is derived from its code, never believed", () => {
  const envelope = validateWireError(ERROR_ENVELOPE);
  assert.equal(envelope.error.code, "state_conflict");
  assert.equal(envelope.error.retryable, false);

  rejects(() =>
    validateWireError(
      replacing(ERROR_ENVELOPE, { error: { ...ERROR_ENVELOPE.error, retryable: true } }),
    ),
  );
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

test("every raised contract error serializes to a valid wire envelope", () => {
  assert.ok(observedRejections.length > 0, "no rejections were collected");
  for (const error of observedRejections) {
    const wire = validateWireError(error.toWire());
    assert.equal(wire.error.code, error.code);
    assert.equal(ERROR_CODES[error.code].retryable, error.retryable);
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
    assert.ok(error.message.length <= HOSTED_LIMITS.ERROR_MESSAGE_MAX_LENGTH);
  }
});

/* ------------------------------------------------------------------ */
/* purity                                                              */
/* ------------------------------------------------------------------ */

test("the validators read no clock, no environment and no network", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "contracts.mjs"),
    "utf8",
  );
  for (const forbidden of ["Date.now", "process.env", "fetch(", "globalThis.", "getStore"]) {
    assert.ok(!source.includes(forbidden), `contracts.mjs must not reference ${forbidden}`);
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
    validateResult(COMPLETE_RESULT_ENVELOPE);
    validateOrigin(FIXTURE_APP_ORIGIN);
    validateWireError(ERROR_ENVELOPE);
  } finally {
    Date.now = realNow;
  }
});

/* ------------------------------------------------------------------ */
/* C6: configuration                                                   */
/* ------------------------------------------------------------------ */

test("a complete production configuration is accepted, with publishing off", () => {
  const config = readHostedConfig(FIXTURE_ENV);
  assert.equal(config.hostedEnv, "production");
  assert.equal(config.production, true);
  assert.equal(config.appOrigin, FIXTURE_APP_ORIGIN);
  assert.equal(config.renderOrigin, FIXTURE_RENDER_ORIGIN);
  assert.equal(config.appSite, "example.com");
  assert.equal(config.renderSite, "example.net");
  assert.equal(config.publishEnabled, false);
  assert.ok(Object.isFrozen(config));
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
  }
});

test("the app and renderer must be two different registrable sites", () => {
  assert.throws(
    () => readHostedConfig({ ...FIXTURE_ENV, HOSTED_RENDER_ORIGIN: FIXTURE_APP_ORIGIN }),
    (error) => error instanceof HostedConfigError && error.key === "HOSTED_RENDER_ORIGIN",
  );
  /* Local-test mode skips the registrable-site comparison, so this is the case
     that isolates the plain "these are the same origin" rule. */
  assert.throws(
    () => readHostedConfig({ ...FIXTURE_LOCAL_ENV, HOSTED_RENDER_ORIGIN: FIXTURE_LOCAL_APP_ORIGIN }),
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

test("an unset or unknown HOSTED_ENV gets production parsing, never a looser one", () => {
  for (const env of [without(FIXTURE_LOCAL_ENV, "HOSTED_ENV"), { ...FIXTURE_LOCAL_ENV, HOSTED_ENV: "" }]) {
    assert.throws(
      () => readHostedConfig(env),
      (error) => error instanceof HostedConfigError && error.key === "HOSTED_APP_ORIGIN",
    );
  }
  for (const HOSTED_ENV of ["preview", "deploy-preview", "dev", "PRODUCTION"]) {
    assert.throws(
      () => readHostedConfig({ ...FIXTURE_ENV, HOSTED_ENV }),
      (error) => error instanceof HostedConfigError && error.key === "HOSTED_ENV",
    );
  }
});

test("the loopback test configuration is explicit and complete, not a bypass", () => {
  const config = readHostedConfig(FIXTURE_LOCAL_ENV);
  assert.equal(config.production, false);
  assert.equal(config.appOrigin, FIXTURE_LOCAL_APP_ORIGIN);
  assert.equal(config.appSite, null);

  /* It still requires every other key and still refuses a non-loopback http
     origin, so it cannot be used to point a real deployment somewhere cheap. */
  assert.throws(() => readHostedConfig(without(FIXTURE_LOCAL_ENV, "GITHUB_CLIENT_SECRET")), HostedConfigError);
  assert.throws(
    () => readHostedConfig({ ...FIXTURE_LOCAL_ENV, HOSTED_APP_ORIGIN: "http://app.archon.example.com" }),
    HostedConfigError,
  );
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

  /* Reachable exactly one way, by name, at the one call site that needs it. */
  assert.equal(config.github.clientSecret, secret);

  const renderings = [
    JSON.stringify(config),
    JSON.stringify(config.github),
    JSON.stringify({ config }),
    inspect(config, { depth: null }),
    inspect(config.github, { depth: null }),
    formatHostedConfig(config),
    String(config.github),
    `${config.github}`,
    Object.keys(config.github).join(","),
    JSON.stringify({ ...config.github }),
  ];
  for (const rendering of renderings) {
    assert.ok(!rendering.includes(secret), `secret leaked into: ${rendering.slice(0, 120)}`);
  }
  assert.ok(formatHostedConfig(config).includes(REDACTED));
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
