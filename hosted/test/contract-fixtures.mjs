/**
 * Deterministic, non-secret fixtures for the hosted contracts.
 *
 * Every value here is derived from a constant that is published in this file,
 * so nothing in it is a credential and nothing in it is a snapshot of a real
 * account, document or provider response. The `*SecretHash` fields are real
 * SHA-256 digests of the literal strings a few lines above them: a hash whose
 * preimage is printed next to it authenticates nobody, which is the property
 * that makes it safe to commit. The `agentSecret` and `csrfToken` fixtures are
 * obvious literals padded to a legal length, not generated tokens.
 *
 * Digests, byte lengths **and lifetimes** are computed, never transcribed. A
 * fixture whose `contentSha256` was pasted in by hand asserts that somebody once
 * ran a hash correctly; a fixture that hashes its own bytes asserts the
 * invariant the server enforces. The timestamps are derived from
 * `HOSTED_LIMITS`, because a hand-written `18:12:00` once drifted to 720 seconds
 * against a declared 600-second upload TTL and nothing noticed - a fixture that
 * contradicts the constant it illustrates is worse than no fixture.
 *
 * The malformed variants are built by mutating a valid fixture through
 * `without` / `replacing`, for the same reason: a malformed case written out
 * longhand drifts away from the valid one it is supposed to differ from in
 * exactly one respect.
 *
 * **These fixtures are test data and nothing else.** They must never reach a
 * deployed code path, and that is enforced mechanically rather than promised:
 * `scripts/check-hosted-modules.mjs` fails if any module in the hosted deploy
 * tree resolves an import into `hosted/test/`. There is no "fixture mode" flag
 * for a handler to be switched into, because a flag that fakes success is the
 * failure this rule exists to prevent.
 */

import { createHash } from "node:crypto";

import { HOSTED_LIMITS } from "../lib/contracts.mjs";

/** Hash helper. Also what the fixtures assert the production digest rule is. */
function sha256(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** `base` advanced by `seconds`, in the one canonical timestamp spelling. */
function after(base, seconds) {
  return new Date(Date.parse(base) + seconds * 1000).toISOString();
}

/* ------------------------------------------------------------------ */
/* artifacts                                                           */
/* ------------------------------------------------------------------ */

/** A small, self-contained document: inline style, no external subresource. */
export const FIXTURE_HTML =
  '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Fixture</title>' +
  "<style>body{font-family:system-ui}</style></head>\n" +
  "<body><h1>Fixture document</h1><p>Deterministic bytes.</p></body>\n</html>\n";

/** The same document behind an optional UTF-8 BOM, which C2 preserves verbatim. */
export const FIXTURE_HTML_WITH_BOM = `\uFEFF${FIXTURE_HTML}`;

/**
 * A document of exactly `bytes` UTF-8 bytes, padded inside a comment.
 *
 * Used for the two C2 boundaries. The padding is ASCII so byte count and
 * character count coincide, and the caller gets an exception rather than a
 * silently shorter document if the frame alone already exceeds the target.
 */
export function htmlOfExactBytes(bytes) {
  const head = '<!doctype html>\n<html lang="en"><body><h1>Boundary</h1><!--';
  const tail = "--></body></html>\n";
  const padding = bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  if (padding < 0) throw new Error(`cannot build an HTML document of ${bytes} bytes`);
  return `${head}${"p".repeat(padding)}${tail}`;
}

/** The descriptor that truthfully describes `html`. */
export function descriptorFor(html, title = "Fixture document") {
  return {
    v: 1,
    title,
    contentSha256: sha256(html),
    contentBytes: Buffer.byteLength(html, "utf8"),
    artifactFormat: "html",
  };
}

export const VALID_DESCRIPTOR = Object.freeze(descriptorFor(FIXTURE_HTML));

/* ------------------------------------------------------------------ */
/* identities and secrets (synthetic)                                  */
/* ------------------------------------------------------------------ */

/** A synthetic GitHub numeric ID. Not a real account. */
export const FIXTURE_PROVIDER_USER_ID = "10000042";
export const FIXTURE_OWNER_ACCOUNT_ID = `gh_${FIXTURE_PROVIDER_USER_ID}`;
/** A second synthetic identity, for the "other account is denied" cases. */
export const FIXTURE_OTHER_ACCOUNT_ID = "gh_10000043";
export const FIXTURE_LOGIN = "archon-fixture-user";

export const FIXTURE_PRINCIPAL = Object.freeze({
  accountId: FIXTURE_OWNER_ACCOUNT_ID,
  provider: "github.com",
  providerUserId: FIXTURE_PROVIDER_USER_ID,
  login: FIXTURE_LOGIN,
});

/** Published preimages: hashing these proves the field shape, not a capability. */
export const FIXTURE_AGENT_SECRET_PREIMAGE = "archon-fixture-agent-secret-not-a-credential";
export const FIXTURE_BROWSER_SECRET_PREIMAGE = "archon-fixture-browser-secret-not-a-credential";

export const FIXTURE_AGENT_SECRET_HASH = sha256(FIXTURE_AGENT_SECRET_PREIMAGE);
export const FIXTURE_BROWSER_SECRET_HASH = sha256(FIXTURE_BROWSER_SECRET_PREIMAGE);

/** Wire-shaped opaque tokens. Literal words, padded to a legal length. */
export const FIXTURE_AGENT_SECRET = "fixture-agent-secret-not-a-real-capability-0";
export const FIXTURE_BROWSER_SECRET = "fixture-browser-secret-not-a-real-capability";
export const FIXTURE_CSRF_TOKEN = "fixture-csrf-token-not-a-real-capability-000";

export const FIXTURE_PUBLICATION_ID = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
export const FIXTURE_USER_CODE = "BCDF-2345";

/* ------------------------------------------------------------------ */
/* origins and configuration                                           */
/* ------------------------------------------------------------------ */

/**
 * Origins under the IANA-reserved `example.com` / `example.net` names, which
 * belong to nobody and resolve to nothing. They are also under a suffix the
 * public-suffix list actually lists, which the app/render site comparison
 * requires: `.example` is a reserved TLD but is *not* in the PSL, so an origin
 * under it has no registrable site to compare and is refused in production.
 */
export const FIXTURE_APP_ORIGIN = "https://app.archon.example.com";
export const FIXTURE_RENDER_ORIGIN = "https://render.archon.example.net";
/** A renderer sharing the app's registrable site - the C6 misconfiguration. */
export const FIXTURE_SIBLING_RENDER_ORIGIN = "https://render.archon.example.com";
/**
 * Two origins under a *private* PSL suffix. They differ only in their first
 * label, so comparing the last two hostname labels would call them one site;
 * the public-suffix list correctly calls them two. Both spellings appear in the
 * tests so the right answer is asserted rather than assumed.
 */
export const FIXTURE_PRIVATE_SUFFIX_APP_ORIGIN = "https://archon-app.pages.dev";
export const FIXTURE_PRIVATE_SUFFIX_RENDER_ORIGIN = "https://archon-render.pages.dev";
/** A host under a TLD the public-suffix list does not list. Indeterminate. */
export const FIXTURE_UNLISTED_SUFFIX_ORIGIN = "https://app.archon-hosted.example";

export const FIXTURE_LOCAL_APP_ORIGIN = "http://127.0.0.1:8888";
export const FIXTURE_LOCAL_RENDER_ORIGIN = "http://localhost:8899";

/** A complete, valid production environment. Credentials are obvious fakes. */
export const FIXTURE_ENV = Object.freeze({
  HOSTED_APP_ORIGIN: FIXTURE_APP_ORIGIN,
  HOSTED_RENDER_ORIGIN: FIXTURE_RENDER_ORIGIN,
  GITHUB_CLIENT_ID: "Iv1.fixtureclientid",
  GITHUB_CLIENT_SECRET: "fixture-client-secret-value-not-real",
  HOSTED_PUBLISH_ENABLED: "false",
});

/** The loopback-only environment, paired with `{ mode: "local-test" }`. */
export const FIXTURE_LOCAL_ENV = Object.freeze({
  ...FIXTURE_ENV,
  HOSTED_APP_ORIGIN: FIXTURE_LOCAL_APP_ORIGIN,
  HOSTED_RENDER_ORIGIN: FIXTURE_LOCAL_RENDER_ORIGIN,
});

/* ------------------------------------------------------------------ */
/* publication records - one per allowed state                         */
/* ------------------------------------------------------------------ */

const CREATED_AT = "2026-09-09T18:00:00.000Z";
/** Derived from the contract, so a fixture can never disagree with a limit. */
export const PENDING_EXPIRES_AT = after(CREATED_AT, HOSTED_LIMITS.PENDING_TTL_SECONDS);
const APPROVED_AT = after(CREATED_AT, 120);
export const UPLOAD_EXPIRES_AT = after(APPROVED_AT, HOSTED_LIMITS.UPLOAD_TTL_SECONDS);
export const COMPLETED_AT = after(APPROVED_AT, 60);
export const RECEIPT_EXPIRES_AT = after(COMPLETED_AT, HOSTED_LIMITS.RECEIPT_TTL_SECONDS);
export const FIXTURE_CREATED_AT = CREATED_AT;
export const FIXTURE_APPROVED_AT = APPROVED_AT;

const PUBLICATION_BASE = {
  v: 1,
  id: FIXTURE_PUBLICATION_ID,
  descriptor: VALID_DESCRIPTOR,
  state: "pending",
  agentSecretHash: FIXTURE_AGENT_SECRET_HASH,
  browserSecretHash: FIXTURE_BROWSER_SECRET_HASH,
  userCode: FIXTURE_USER_CODE,
  createdAt: CREATED_AT,
  pendingExpiresAt: PENDING_EXPIRES_AT,
  ownerAccountId: null,
  uploadExpiresAt: null,
  completedAt: null,
  receiptExpiresAt: null,
  html: null,
};

/**
 * One valid record for every state in `PUBLICATION_STATES`.
 *
 * The test that walks this map also asserts it covers the exported state list
 * exactly, so a seventh state added to the contract cannot land with no fixture
 * behind it.
 */
export const PUBLICATION_FIXTURES = Object.freeze({
  pending: Object.freeze({ ...PUBLICATION_BASE }),
  approved: Object.freeze({
    ...PUBLICATION_BASE,
    state: "approved",
    ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
    uploadExpiresAt: UPLOAD_EXPIRES_AT,
  }),
  complete: Object.freeze({
    ...PUBLICATION_BASE,
    state: "complete",
    ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
    uploadExpiresAt: UPLOAD_EXPIRES_AT,
    completedAt: COMPLETED_AT,
    receiptExpiresAt: RECEIPT_EXPIRES_AT,
    html: FIXTURE_HTML,
  }),
  denied: Object.freeze({
    ...PUBLICATION_BASE,
    state: "denied",
    ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
    uploadExpiresAt: null,
  }),
  cancelled: Object.freeze({ ...PUBLICATION_BASE, state: "cancelled" }),
  expired: Object.freeze({ ...PUBLICATION_BASE, state: "expired" }),
});

/* ------------------------------------------------------------------ */
/* wire envelopes                                                      */
/* ------------------------------------------------------------------ */

export const START_RESPONSE = Object.freeze({
  v: 1,
  publicationId: FIXTURE_PUBLICATION_ID,
  verificationUriComplete: `${FIXTURE_APP_ORIGIN}/publish/authorize#${FIXTURE_BROWSER_SECRET}`,
  userCode: FIXTURE_USER_CODE,
  agentSecret: FIXTURE_AGENT_SECRET,
  expiresAt: PENDING_EXPIRES_AT,
  intervalSeconds: 5,
});

export const PENDING_RESULT_ENVELOPE = Object.freeze({
  v: 1,
  state: "pending",
  expiresAt: PENDING_EXPIRES_AT,
  intervalSeconds: 5,
});

export const COMPLETE_RESULT_ENVELOPE = Object.freeze({
  v: 1,
  state: "complete",
  expiresAt: RECEIPT_EXPIRES_AT,
  intervalSeconds: 5,
  result: Object.freeze({
    documentId: FIXTURE_PUBLICATION_ID,
    url: `${FIXTURE_APP_ORIGIN}/docs/${FIXTURE_PUBLICATION_ID}`,
    ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
    contentSha256: VALID_DESCRIPTOR.contentSha256,
    contentBytes: VALID_DESCRIPTOR.contentBytes,
  }),
});

export const ERROR_ENVELOPE = Object.freeze({
  v: 1,
  error: Object.freeze({
    code: "state_conflict",
    message: "publication is no longer pending",
    retryable: false,
  }),
});

/* ------------------------------------------------------------------ */
/* identity and viewer bodies                                          */
/* ------------------------------------------------------------------ */

export const SIGNED_OUT_SESSION = Object.freeze({ v: 1, authenticated: false });

export const SIGNED_IN_SESSION = Object.freeze({
  v: 1,
  authenticated: true,
  accountId: FIXTURE_OWNER_ACCOUNT_ID,
  login: FIXTURE_LOGIN,
  csrfToken: FIXTURE_CSRF_TOKEN,
});

export const DOCUMENT_METADATA = Object.freeze({
  v: 1,
  documentId: FIXTURE_PUBLICATION_ID,
  title: VALID_DESCRIPTOR.title,
  ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
  contentSha256: VALID_DESCRIPTOR.contentSha256,
  contentBytes: VALID_DESCRIPTOR.contentBytes,
  createdAt: CREATED_AT,
});

export const READY_MESSAGE = Object.freeze({ type: "archon:ready", v: 1 });

export const RENDER_MESSAGE = Object.freeze({
  type: "archon:render",
  v: 1,
  html: FIXTURE_HTML,
});

/* ------------------------------------------------------------------ */
/* mutation helpers                                                    */
/* ------------------------------------------------------------------ */

/** A shallow copy of `record` with `key` removed. */
export function without(record, key) {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

/** A shallow copy of `record` with `patch` applied. */
export function replacing(record, patch) {
  return { ...record, ...patch };
}
