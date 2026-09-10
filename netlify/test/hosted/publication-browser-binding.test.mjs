/**
 * Regressions for the opaque pending-publication binding.
 *
 * The module is small, and every one of these tests is about a property that is
 * invisible in the code and expensive to lose: that the cookie carries nothing
 * but a random token, that a binding is scoped to one browser and one
 * publication, that expiry is enforced on use rather than only on issue, and
 * that releasing it revokes the record rather than merely un-setting a cookie.
 *
 *   node --test netlify/test/hosted/publication-browser-binding.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthStore, TRANSIENT_TTL_SECONDS } from "../../lib/hosted/auth-store.mjs";
import { HostedContractError } from "../../lib/hosted/contracts.mjs";
import { BINDING_COOKIE } from "../../lib/hosted/identity.mjs";
import {
  decodeOperation,
  encodeOperation,
  issueBrowserBinding,
  releaseBrowserBinding,
  requireBrowserBinding,
} from "../../lib/hosted/publication-browser-binding.mjs";
import { MemoryBlobStore, fixedClock, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_BROWSER_SECRET_HASH,
  FIXTURE_PUBLICATION_ID,
} from "./fixtures/publications.mjs";

const BINDING = Object.freeze({
  publicationId: FIXTURE_PUBLICATION_ID,
  browserSecretHash: FIXTURE_BROWSER_SECRET_HASH,
});

const OTHER_ID = "1234567890abcdef1234567890abcdef";

/** A request carrying one binding cookie, as a browser would send it. */
function withCookie(value) {
  const headers = value === null ? {} : { cookie: `${BINDING_COOKIE}=${value}` };
  return new Request("https://app.archon.example.com/api/hosted/publications/x/review", { headers });
}

/** The value a `Set-Cookie` assigns. */
function valueOf(setCookie) {
  return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

async function refuses(promise) {
  const error = await promise.then(
    () => null,
    (thrown) => thrown,
  );
  assert.ok(error instanceof HostedContractError, "expected a typed contract refusal");
  assert.equal(error.code, "approval_required");
  assert.equal(error.status, 403);
  return error;
}

test("an operation encodes exactly the id and the digest, and round-trips", () => {
  const operation = encodeOperation(BINDING);
  assert.equal(operation, `${FIXTURE_PUBLICATION_ID}${FIXTURE_BROWSER_SECRET_HASH}`);
  assert.equal(operation.length, 96);
  assert.deepEqual(decodeOperation(operation), BINDING);
});

test("a binding this service did not produce cannot be encoded", () => {
  for (const bad of [
    undefined,
    null,
    {},
    { publicationId: FIXTURE_PUBLICATION_ID },
    { publicationId: FIXTURE_PUBLICATION_ID, browserSecretHash: "short" },
    { publicationId: FIXTURE_PUBLICATION_ID.toUpperCase(), browserSecretHash: FIXTURE_BROWSER_SECRET_HASH },
    { publicationId: `${FIXTURE_PUBLICATION_ID}0`, browserSecretHash: FIXTURE_BROWSER_SECRET_HASH },
  ]) {
    assert.throws(() => encodeOperation(bad), TypeError);
  }
});

test("an operation that is not two lower-hex fields decodes to nothing", () => {
  for (const bad of [
    undefined,
    null,
    "",
    "z".repeat(96),
    `${FIXTURE_PUBLICATION_ID}${FIXTURE_BROWSER_SECRET_HASH}0`,
    `${FIXTURE_PUBLICATION_ID}.${FIXTURE_BROWSER_SECRET_HASH}`,
    `${FIXTURE_PUBLICATION_ID}${FIXTURE_BROWSER_SECRET_HASH}`.toUpperCase(),
  ]) {
    assert.equal(decodeOperation(bad), null);
  }
});

test("the cookie carries a random token and never the operation itself", async () => {
  const { store } = memoryAuthStore();
  const issued = await issueBrowserBinding(store, BINDING);

  assert.ok(issued.setCookie.startsWith(`${BINDING_COOKIE}=`));
  for (const attribute of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) {
    assert.ok(issued.setCookie.includes(attribute), `missing ${attribute}`);
  }
  assert.ok(!/;\s*Domain=/i.test(issued.setCookie), "a __Host- cookie carries no Domain");
  assert.match(issued.setCookie, new RegExp(`Max-Age=${TRANSIENT_TTL_SECONDS}\\b`));

  const value = valueOf(issued.setCookie);
  assert.ok(!value.includes(FIXTURE_PUBLICATION_ID));
  assert.ok(!value.includes(FIXTURE_BROWSER_SECRET_HASH));
});

test("the binding comes back for the publication it was issued for", async () => {
  const { store } = memoryAuthStore();
  const issued = await issueBrowserBinding(store, BINDING);
  const read = await requireBrowserBinding(store, withCookie(valueOf(issued.setCookie)), FIXTURE_PUBLICATION_ID);
  assert.deepEqual(read, BINDING);
});

test("reading the binding does not consume it, so an account switch survives", async () => {
  const { store } = memoryAuthStore();
  const issued = await issueBrowserBinding(store, BINDING);
  const request = withCookie(valueOf(issued.setCookie));
  await requireBrowserBinding(store, request, FIXTURE_PUBLICATION_ID);
  await requireBrowserBinding(store, request, FIXTURE_PUBLICATION_ID);
  const again = await requireBrowserBinding(store, request, FIXTURE_PUBLICATION_ID);
  assert.deepEqual(again, BINDING);
});

test("a browser with no cookie, or a fabricated one, is simply not bound", async () => {
  const { store } = memoryAuthStore();
  await issueBrowserBinding(store, BINDING);
  await refuses(requireBrowserBinding(store, withCookie(null), FIXTURE_PUBLICATION_ID));
  await refuses(requireBrowserBinding(store, withCookie("not-a-token"), FIXTURE_PUBLICATION_ID));
});

test("one browser's binding is not readable with another browser's cookie", async () => {
  const { store } = memoryAuthStore();
  const mine = await issueBrowserBinding(store, BINDING);
  const theirs = await issueBrowserBinding(store, { ...BINDING, publicationId: OTHER_ID });

  assert.notEqual(valueOf(mine.setCookie), valueOf(theirs.setCookie));
  const read = await requireBrowserBinding(store, withCookie(valueOf(theirs.setCookie)), OTHER_ID);
  assert.equal(read.publicationId, OTHER_ID);
  await refuses(requireBrowserBinding(store, withCookie(valueOf(theirs.setCookie)), FIXTURE_PUBLICATION_ID));
});

test("a binding for one publication does not authorise another", async () => {
  const { store } = memoryAuthStore();
  const issued = await issueBrowserBinding(store, BINDING);
  await refuses(requireBrowserBinding(store, withCookie(valueOf(issued.setCookie)), OTHER_ID));
});

test("expiry is enforced when the binding is used, not only when it is issued", async () => {
  const clock = fixedClock();
  const { store } = memoryAuthStore(clock);
  const issued = await issueBrowserBinding(store, BINDING);
  const request = withCookie(valueOf(issued.setCookie));

  clock.advanceSeconds(TRANSIENT_TTL_SECONDS - 1);
  assert.deepEqual(await requireBrowserBinding(store, request, FIXTURE_PUBLICATION_ID), BINDING);

  clock.advanceSeconds(2);
  await refuses(requireBrowserBinding(store, request, FIXTURE_PUBLICATION_ID));
});

test("a stored record tampered into another shape is not a binding", async () => {
  const clock = fixedClock();
  const blobs = new MemoryBlobStore();
  const { store } = memoryAuthStore(clock, blobs);
  const issued = await issueBrowserBinding(store, BINDING);
  const token = valueOf(issued.setCookie);
  const key = AuthStore.transientKey("binding", token);

  const planted = structuredClone((await blobs.getWithMetadata(key)).data);
  planted.payload = { operation: { publicationId: FIXTURE_PUBLICATION_ID } };
  await blobs.setJSON(key, planted, {});

  await refuses(requireBrowserBinding(store, withCookie(token), FIXTURE_PUBLICATION_ID));
});

test("releasing revokes the record, so a copied cookie stops working too", async () => {
  const { store } = memoryAuthStore();
  const issued = await issueBrowserBinding(store, BINDING);
  const token = valueOf(issued.setCookie);

  const released = await releaseBrowserBinding(store, withCookie(token));
  assert.equal(released.cleared, true);
  assert.equal(valueOf(released.setCookie), "");
  assert.match(released.setCookie, /Max-Age=0\b/);

  await refuses(requireBrowserBinding(store, withCookie(token), FIXTURE_PUBLICATION_ID));
});

test("releasing without a cookie is a no-op that still clears the browser", async () => {
  const { store } = memoryAuthStore();
  const released = await releaseBrowserBinding(store, withCookie(null));
  assert.equal(released.cleared, false);
  assert.match(released.setCookie, /Max-Age=0\b/);
});
