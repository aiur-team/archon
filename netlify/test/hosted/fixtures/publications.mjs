/**
 * Immutable publication fixtures for this ticket's suites and for AHU-007 and
 * AHU-008.
 *
 * These build on `netlify/test/hosted/contract-fixtures.mjs` rather than restating it.
 * Every record here is run through the same `validatePublication` production
 * uses, at module load, so a fixture that stopped being a legal record fails the
 * import instead of quietly teaching a consumer the wrong shape - which is the
 * whole reason a consumer is asked to use these instead of writing its own.
 */

import {
  HOSTED_LIMITS,
  validatePublication,
} from "../../../lib/hosted/contracts.mjs";
import { PUBLICATION_KEY_PREFIX } from "../../../lib/hosted/publication-store.mjs";
import {
  FIXTURE_AGENT_SECRET_HASH,
  FIXTURE_AGENT_SECRET_PREIMAGE,
  FIXTURE_APP_ORIGIN,
  FIXTURE_BROWSER_SECRET_HASH,
  FIXTURE_BROWSER_SECRET_PREIMAGE,
  FIXTURE_HTML,
  FIXTURE_ANONYMOUS_PRINCIPAL,
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OTHER_PRINCIPAL,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_UNVERIFIED_PRINCIPAL,
  PUBLICATION_FIXTURES,
  VALID_DESCRIPTOR,
} from "../contract-fixtures.mjs";

/**
 * The plaintext capabilities behind the fixture records' stored hashes.
 *
 * They are named `*_PREIMAGE` in the producer and re-exported under the names a
 * consumer actually uses them by, because these are what a test presents at an
 * API boundary. Neither is a credential: both are literal strings in a tracked
 * file whose digests are the only thing any record holds.
 */
export const FIXTURE_RECORD_AGENT_SECRET = FIXTURE_AGENT_SECRET_PREIMAGE;
export const FIXTURE_RECORD_BROWSER_SECRET = FIXTURE_BROWSER_SECRET_PREIMAGE;

export {
  FIXTURE_AGENT_SECRET_HASH,
  FIXTURE_APP_ORIGIN,
  FIXTURE_BROWSER_SECRET_HASH,
  FIXTURE_HTML,
  FIXTURE_OTHER_ACCOUNT_ID,
  FIXTURE_OWNER_ACCOUNT_ID,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  VALID_DESCRIPTOR,
};

/** The environment a hosted deployment with publishing on is configured with. */
export const PUBLISHING_ENV = Object.freeze({
  HOSTED_APP_ORIGIN: FIXTURE_APP_ORIGIN,
  HOSTED_RENDER_ORIGIN: "https://render.archon.example.net",
  AUTH0_DOMAIN: "tenant.archon.example.com",
  AUTH0_CLIENT_ID: "exampleAuth0ClientId0000000000000",
  AUTH0_CLIENT_SECRET: "fixture-client-secret-not-a-real-credential",
  HOSTED_PUBLISH_ENABLED: "true",
});

/**
 * The second account, as a full principal, for every owner-mismatch case.
 *
 * Re-exported from the contract fixtures rather than assembled here. Under C1 v2
 * `accountId` is a one-way digest of the subject, so a principal cannot be
 * reconstructed from an account identifier at all - the subject has to come from
 * the producer that derived the identifier from it.
 */
export const OTHER_PRINCIPAL = FIXTURE_OTHER_PRINCIPAL;

/**
 * An approver whose address the tenant has not verified, and one with no address
 * at all. Both must leave `ownerEmail` null, and only the first can tell an
 * unconditional stamp from a verified one.
 */
export const UNVERIFIED_PRINCIPAL = FIXTURE_UNVERIFIED_PRINCIPAL;
export const NO_EMAIL_PRINCIPAL = FIXTURE_ANONYMOUS_PRINCIPAL;

/** The store key the fixture records live at. */
export const FIXTURE_KEY = `${PUBLICATION_KEY_PREFIX}${FIXTURE_PUBLICATION_ID}`;

/**
 * One valid, frozen record per state, validated at load.
 *
 * `PUBLICATION_FIXTURES` from AHU-001 is already exactly this, so it is
 * re-validated and re-exported rather than copied: a second table would be a
 * second thing to keep in step with C2.
 */
export const RECORDS = Object.freeze(
  Object.fromEntries(
    Object.entries(PUBLICATION_FIXTURES).map(([state, record]) => [
      state,
      validatePublication(record),
    ]),
  ),
);

/** The receipt a completed fixture projects, for a consumer asserting a body. */
export const FIXTURE_RESULT = Object.freeze({
  documentId: FIXTURE_PUBLICATION_ID,
  url: `${FIXTURE_APP_ORIGIN}${HOSTED_LIMITS.DOCUMENT_PATH_PREFIX}${FIXTURE_PUBLICATION_ID}`,
  ownerAccountId: FIXTURE_OWNER_ACCOUNT_ID,
  contentSha256: VALID_DESCRIPTOR.contentSha256,
  contentBytes: VALID_DESCRIPTOR.contentBytes,
});

/** The instant the fixture records were created at, for a clock to start from. */
export const FIXTURE_NOW = RECORDS.pending.createdAt;
