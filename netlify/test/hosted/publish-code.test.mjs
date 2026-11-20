/**
 * archon#253: the publish code a signed-in person copies into their agent.
 *
 * Every guard the ticket names has a test here: one-publication binding,
 * one-hour expiry, revocation, minting superseding the previous code, hashed storage, the
 * terminal refusal, and the three things the code must never do - read a
 * document, reach the admin surface, or stand in for a session.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PUBLISH_CODE_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
import { AuthUnavailableError } from "../../lib/hosted/auth-errors.mjs";
import { deriveCsrfToken, SESSION_COOKIE } from "../../lib/hosted/identity.mjs";
import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import { readPublication } from "../../lib/hosted/publications.mjs";
import { createAdminDocumentsRoute } from "../../functions/hosted-admin-documents.mjs";
import { createDocumentReadRoutes } from "../../functions/hosted-document-read.mjs";
import { handleStart } from "../../functions/hosted-publications-start.mjs";
import { createPublishCodeRoute } from "../../functions/hosted-publish-code.mjs";
import { createSessionRoute } from "../../functions/hosted-session.mjs";
import { browserRequest, fixedClock, hostedConfig, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  OTHER_PRINCIPAL,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

const START_URL = "https://hosted.example.test/api/hosted/publications";
const CODE_PATH = "/api/hosted/publish-code";

function harness({ publishEnabled = true } = {}) {
  const auth = memoryAuthStore(fixedClock(Date.parse(FIXTURE_NOW)));
  const provider = createProviderDouble();
  provider.put(FIXTURE_KEY, JSON.stringify(RECORDS.complete));
  const publications = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled,
    now: createClock(FIXTURE_NOW).now,
    randomBytes: sequentialRandomBytes(),
  };
  const config = hostedConfig();
  return {
    auth,
    provider,
    publications,
    codeRoute: createPublishCodeRoute(() => ({ config, store: auth.store, publications })),
    start: (headers = {}, descriptor = VALID_DESCRIPTOR) =>
      handleStart(
        new Request(START_URL, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(descriptor),
        }),
        () => ({ ...publications, authStore: auth.store }),
      ),
    config,
  };
}

const bearer = (code) => ({ authorization: `Bearer ${code}` });

async function assertRefused(response, code) {
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "invalid_capability");
  assert.equal(body.error.retryable, false);
  assert.ok(!JSON.stringify(body).includes(code), "a refusal must not echo the code");
}

/* ------------------------------------------------------------------ */
/* the store                                                           */
/* ------------------------------------------------------------------ */

test("a minted code resolves to the principal it was issued to", async () => {
  const { store } = memoryAuthStore();
  const { code, expiresAt } = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.deepEqual(await store.readPublishCode(FIXTURE_PRINCIPAL.accountId), { expiresAt });
  assert.equal((await store.resolvePublishCode(code)).principal.accountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal((await store.resolvePublishCode(code)).principal.accountId, FIXTURE_PRINCIPAL.accountId);
});

test("a code expires one hour after it was minted", async () => {
  const { store, clock } = memoryAuthStore();
  const { code } = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal(PUBLISH_CODE_TTL_SECONDS, 3600);
  clock.advanceSeconds(PUBLISH_CODE_TTL_SECONDS);
  assert.equal(await store.resolvePublishCode(code), null);
  assert.equal(await store.readPublishCode(FIXTURE_PRINCIPAL.accountId), null);
});

test("revoking kills the code at once", async () => {
  const { store } = memoryAuthStore();
  const { code } = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal(await store.revokePublishCode(FIXTURE_PRINCIPAL.accountId), true);
  assert.equal(await store.resolvePublishCode(code), null);
  assert.equal(await store.revokePublishCode(FIXTURE_PRINCIPAL.accountId), false);
});

test("minting a new code invalidates the previous one, and only that account's", async () => {
  const { store } = memoryAuthStore();
  const first = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  const other = await store.mintPublishCode(OTHER_PRINCIPAL);
  const second = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal(await store.resolvePublishCode(first.code), null);
  assert.equal((await store.resolvePublishCode(second.code)).principal.accountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal((await store.resolvePublishCode(other.code)).principal.accountId, OTHER_PRINCIPAL.accountId);
});

test("minting fails when the account pointer write is refused", async () => {
  const { store, blobs } = memoryAuthStore();
  const first = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  blobs.fail("publish-code-accounts/", "refuse");

  await assert.rejects(() => store.mintPublishCode(FIXTURE_PRINCIPAL), AuthUnavailableError);
  assert.deepEqual(await store.readPublishCode(FIXTURE_PRINCIPAL.accountId), { expiresAt: first.expiresAt });
  assert.equal((await store.resolvePublishCode(first.code)).principal.accountId, FIXTURE_PRINCIPAL.accountId);
});

test("a code is stored only as a hash, and the account only as a hash in keys", async () => {
  const { store, blobs } = memoryAuthStore();
  const { code } = await store.mintPublishCode(FIXTURE_PRINCIPAL);
  const everything = JSON.stringify([...blobs.entries]);
  assert.ok(!everything.includes(code), "the raw code must not be stored");
  for (const key of blobs.keys()) assert.ok(!key.includes(FIXTURE_PRINCIPAL.accountId));
});

test("resolving compares the stored code hash in constant time", () => {
  const source = readFileSync(new URL("../../lib/hosted/auth-store.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /if \(!constantTimeEqual\(pointer\.data\.codeHash, hashToken\(code\)\)\) return null;/,
  );
});

test("retry capabilities derive from the request code, not the stored digest", () => {
  const source = readFileSync(new URL("../../lib/hosted/publications.mjs", import.meta.url), "utf8");
  assert.match(source, /createHmac\("sha256", code\)/);
});

/* ------------------------------------------------------------------ */
/* scope: the code is not a session and reads nothing                  */
/* ------------------------------------------------------------------ */

test("a code cannot be presented or exchanged as a session", async () => {
  const { auth, config, publications } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal(await auth.store.readSession(code), null);

  const session = createSessionRoute({ store: auth.store });
  const answer = await session(browserRequest("/api/hosted/session", { cookies: { [SESSION_COOKIE]: code } }));
  assert.equal((await answer.json()).authenticated, false);

  const mint = createPublishCodeRoute(() => ({ config, store: auth.store, publications }));
  const minted = await mint(
    browserRequest(CODE_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: code },
      csrf: deriveCsrfToken(code),
    }),
  );
  assert.equal(minted.status, 401, "a code must not mint further codes");
});

test("a code cannot read the owner's documents", async () => {
  const { auth, publications } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  const read = createDocumentReadRoutes({ store: auth.store, publications });
  for (const headers of [bearer(code), { cookie: `${SESSION_COOKIE}=${code}` }]) {
    const response = await read(
      new Request(`${FIXTURE_APP_ORIGIN}/api/hosted/docs/${FIXTURE_PUBLICATION_ID}/content`, { headers }),
    );
    assert.equal(response.status, 401, "a code is no session, so the read is refused as signed out");
  }
  /* The control: the owner's own session does read it, so the 404 above is the code being refused. */
  const { token } = await auth.store.createSession(FIXTURE_PRINCIPAL);
  const owned = await read(
    new Request(`${FIXTURE_APP_ORIGIN}/api/hosted/docs/${FIXTURE_PUBLICATION_ID}`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
  );
  assert.equal(owned.status, 200);
});

test("a code cannot reach the admin surface", async () => {
  const { auth, publications } = harness();
  const admin = { ...FIXTURE_PRINCIPAL };
  const config = hostedConfig({ ARCHON_ADMINS: admin.email });
  const { code } = await auth.store.mintPublishCode(admin);
  const route = createAdminDocumentsRoute(() => ({ config, store: auth.store, publications: publications.store }));
  for (const headers of [bearer(code), { cookie: `${SESSION_COOKIE}=${code}` }]) {
    const response = await route(new Request(`${FIXTURE_APP_ORIGIN}/api/hosted/admin/documents`, { headers }));
    assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
  }
});

/* ------------------------------------------------------------------ */
/* the browser route                                                   */
/* ------------------------------------------------------------------ */

test("the route mints, reports and revokes for the signed-in account only", async () => {
  const { auth, codeRoute } = harness();
  assert.equal((await codeRoute(browserRequest(CODE_PATH))).status, 401);

  const { token } = await auth.store.createSession(FIXTURE_PRINCIPAL);
  const cookies = { [SESSION_COOKIE]: token };
  const noCsrf = await codeRoute(browserRequest(CODE_PATH, { method: "POST", cookies }));
  assert.equal(noCsrf.status, 403, "minting needs the CSRF header");

  const csrf = deriveCsrfToken(token);
  const minted = await codeRoute(browserRequest(CODE_PATH, { method: "POST", cookies, csrf }));
  assert.equal(minted.status, 201);
  const { code, expiresAt } = await minted.json();
  assert.equal(typeof code, "string");

  const status = await (await codeRoute(browserRequest(CODE_PATH, { cookies }))).json();
  assert.deepEqual(status, { v: 1, active: true, expiresAt });
  assert.ok(!JSON.stringify(status).includes(code), "status must never return the code");

  const revoked = await codeRoute(browserRequest(CODE_PATH, { method: "DELETE", cookies, csrf }));
  assert.deepEqual(await revoked.json(), { v: 1, active: false, expiresAt: null });
  assert.equal(await auth.store.resolvePublishCode(code), null);
});

/* ------------------------------------------------------------------ */
/* the start route                                                     */
/* ------------------------------------------------------------------ */

test("start with a code creates an approved publication owned by the issuer", async () => {
  const { auth, publications, start } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);

  const response = await start(bearer(code));
  assert.equal(response.status, 201);
  const body = await response.json();
  const record = await readPublication(body.publicationId, publications);
  assert.equal(record.state, "approved", "no human approval step exists for a code");
  assert.equal(record.ownerAccountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal(body.expiresAt, record.uploadExpiresAt);
});

test("retrying the same code and descriptor returns the same publication", async () => {
  const { auth, start } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);

  const first = await start(bearer(code));
  const firstBody = await first.json();
  const retry = await start(bearer(code));
  const retryBody = await retry.json();

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.equal(retryBody.publicationId, firstBody.publicationId);
  assert.equal(retryBody.agentSecret, firstBody.agentSecret);
  assert.equal(retryBody.verificationUriComplete, firstBody.verificationUriComplete);
});

test("concurrent starts with one code converge on the same publication", async () => {
  const { auth, start } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  const [left, right] = await Promise.all([start(bearer(code)), start(bearer(code))]);
  const leftBody = await left.json();
  const rightBody = await right.json();

  assert.equal(left.status, 201);
  assert.equal(right.status, 201);
  assert.equal(leftBody.publicationId, rightBody.publicationId);
  assert.equal(leftBody.agentSecret, rightBody.agentSecret);
});

test("a publish code cannot bind itself to a second descriptor", async () => {
  const { auth, start } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal((await start(bearer(code))).status, 201);

  await assertRefused(await start(bearer(code), { ...VALID_DESCRIPTOR, title: "Another title" }), code);
});

test("a storage failure before publication creation leaves the code retryable", async () => {
  const { auth, provider, start } = harness();
  const { code } = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  provider.failNextWrite({ throwsBeforeCommit: true });

  const failed = await start(bearer(code));
  assert.equal(failed.status, 503);
  const succeeded = await start(bearer(code));
  assert.equal(succeeded.status, 201);
  assert.equal((await start(bearer(code))).status, 201);
});

test("start without a code is unchanged: pending and ownerless", async () => {
  const { publications, start } = harness();
  const body = await (await start()).json();
  const record = await readPublication(body.publicationId, publications);
  assert.equal(record.state, "pending");
  assert.equal(record.ownerAccountId, null);
});

test("start refuses an unknown, revoked or superseded code with a terminal error", async () => {
  const { auth, start } = harness();
  await assertRefused(await start(bearer("x".repeat(43))), "x".repeat(43));

  const revoked = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  await auth.store.revokePublishCode(FIXTURE_PRINCIPAL.accountId);
  await assertRefused(await start(bearer(revoked.code)), revoked.code);

  const old = await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  await auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  await assertRefused(await start(bearer(old.code)), old.code);
});

test("a rejected start does not bind a code to a publication", async () => {
  const disabled = harness({ publishEnabled: false });
  const { code } = await disabled.auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal((await disabled.start(bearer(code))).status, 503);
  assert.notEqual(await disabled.auth.store.readPublishCode(FIXTURE_PRINCIPAL.accountId), null);

  const bad = harness();
  const minted = await bad.auth.store.mintPublishCode(FIXTURE_PRINCIPAL);
  assert.equal((await bad.start(bearer(minted.code), { title: "" })).status, 400);
  assert.notEqual(await bad.auth.store.readPublishCode(FIXTURE_PRINCIPAL.accountId), null);
});
