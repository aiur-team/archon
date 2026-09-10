/**
 * Regressions for the artifact upload route.
 *
 * The upload is the one hosted request that carries a document, so this suite is
 * about the two things that follow from that: the order in which the route
 * refuses, and whether the bytes that end up stored are the bytes that were
 * approved. Both are asserted against real bytes - the digests here are computed
 * from the fixture documents, never stubbed - because a suite that mocked the
 * digest would pass just as happily against a route that never hashed anything.
 *
 * The handler is driven through its real exported implementation with an
 * injected dependency set and the conditional-write provider double, so what is
 * under test is the same code the deploy runs, sitting on the same compare-and-
 * set semantics the adapter will meet in production.
 *
 *   node --test hosted/test/publications-artifact.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { HOSTED_LIMITS, validateResult, validateWireError } from "../lib/contracts.mjs";
import { completePublication } from "../lib/publications.mjs";
import { createPublicationStore } from "../lib/publication-store.mjs";
import { readArtifactBody } from "../lib/artifact-body.mjs";
import artifactHandler, {
  handleArtifact,
  config as artifactConfig,
} from "../functions/publications-artifact.mjs";
import { handleCancel } from "../functions/publications-cancel.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_AGENT_SECRET,
  FIXTURE_RECORD_BROWSER_SECRET,
  FIXTURE_RESULT,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import { FIXTURE_HTML_WITH_BOM, descriptorFor, htmlOfExactBytes } from "./contract-fixtures.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

const BASE = "https://hosted.example.test";
const ARTIFACT_PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/artifact`;
const MEDIA_TYPE = HOSTED_LIMITS.ARTIFACT_MEDIA_TYPE;

/* The C3 headers, written out rather than imported: asserting a response against
   the production constant only proves the handler used the constant. */
const C3_PRIVATE_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/**
 * A dependency set over a provider double, seeded with one fixture record.
 *
 * `record` overrides let a test bend one field of a fixture - an approval whose
 * descriptor describes a different document, say - without restating a whole
 * legal record and drifting from C2 in the process.
 */
function harness({ seed = "approved", publishEnabled = true, record = null } = {}) {
  const provider = createProviderDouble();
  if (seed !== null) {
    provider.put(FIXTURE_KEY, JSON.stringify(record ?? RECORDS[seed]));
  }
  const clock = createClock(FIXTURE_NOW);
  const dependencies = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled,
    now: clock.now,
    randomBytes: sequentialRandomBytes(),
  };
  return {
    provider,
    clock,
    dependencies,
    resolve: () => dependencies,
    stored: () => {
      const raw = provider.raw(FIXTURE_KEY);
      return raw === null ? null : JSON.parse(raw.data);
    },
    writes: () => provider.calls.filter((call) => call.op === "set"),
  };
}

function upload(body, { method = "PUT", headers = {}, path = ARTIFACT_PATH, bearer = FIXTURE_RECORD_AGENT_SECRET } = {}) {
  const merged = {
    ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    ...(body === undefined ? {} : { "content-type": MEDIA_TYPE }),
    ...headers,
  };
  const init = { method, headers: merged };
  if (body !== undefined) {
    init.body = body;
    if (typeof body !== "string") init.duplex = "half";
  }
  return new Request(`${BASE}${path}`, init);
}

/** A body that arrives in pieces, so the bound is met mid-stream. */
function chunkedBody(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    },
  });
}

/** The parsed body of a response, plus a check of the headers C3 requires. */
async function read(response) {
  for (const [header, value] of Object.entries(C3_PRIVATE_HEADERS)) {
    assert.equal(response.headers.get(header), value, `missing or wrong ${header}`);
  }
  return response.json();
}

async function assertError(response, status, code) {
  const body = await read(response);
  assert.equal(response.status, status, `expected ${status}, got ${response.status}: ${JSON.stringify(body)}`);
  assert.deepEqual(validateWireError(body), body, "the envelope must be a legal C3 error");
  assert.equal(body.error.code, code, `expected ${code}, got ${body.error.code}`);
  return body;
}

/* ------------------------------------------------------------------ */
/* routing and entry-point shape                                       */
/* ------------------------------------------------------------------ */

test("the route is declared once, under the hosted API namespace", () => {
  assert.deepEqual(artifactConfig, {
    path: "/api/hosted/publications/:publicationId/artifact",
  });
  assert.equal(typeof artifactHandler, "function");
  assert.equal(typeof handleArtifact, "function");
});

test("a method other than PUT is 405 with an Allow header, before anything else", async () => {
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const { resolve, provider } = harness();
    const response = await handleArtifact(upload(undefined, { method }), resolve);
    assert.equal(response.status, 405, `${method} should be refused`);
    assert.equal(response.headers.get("Allow"), "PUT");
    const body = await read(response);
    assert.equal(body.error.code, "invalid_request");
    assert.deepEqual(provider.calls, [], `${method} must not touch storage`);
  }
});

test("a browser's ambient credentials are refused before the bearer is read", async () => {
  for (const header of ["cookie", "origin"]) {
    const { resolve, provider } = harness();
    const request = upload(FIXTURE_HTML, {
      bearer: null,
      headers: { [header]: header === "cookie" ? "__Host-archon_session=x" : BASE },
    });
    await assertError(await handleArtifact(request, resolve), 403, "forbidden");
    assert.deepEqual(provider.calls, [], "a browser request must not touch storage");
  }
});

test("a wrong or missing bearer never reveals whether the publication exists", async () => {
  for (const bearer of [null, FIXTURE_RECORD_BROWSER_SECRET, `${FIXTURE_RECORD_AGENT_SECRET}x`]) {
    const { resolve } = harness();
    const response = await handleArtifact(upload(FIXTURE_HTML, { bearer }), resolve);
    await assertError(response, 401, "invalid_capability");
  }
});

test("an unknown publication is 404, with no write attempted", async () => {
  const { resolve, writes } = harness({ seed: null });
  await assertError(await handleArtifact(upload(FIXTURE_HTML), resolve), 404, "not_found");
  assert.deepEqual(writes(), []);
});

/* ------------------------------------------------------------------ */
/* the state gate, applied before the body is read                     */
/* ------------------------------------------------------------------ */

const STATE_REJECTIONS = [
  { seed: "pending", status: 403, code: "approval_required" },
  { seed: "denied", status: 409, code: "state_conflict" },
  { seed: "cancelled", status: 409, code: "state_conflict" },
  { seed: "expired", status: 410, code: "authorization_expired" },
];

for (const { seed, status, code } of STATE_REJECTIONS) {
  test(`a ${seed} publication refuses the upload with ${status} ${code}`, async () => {
    const { resolve, writes } = harness({ seed });
    const request = upload(FIXTURE_HTML);
    await assertError(await handleArtifact(request, resolve), status, code);
    assert.deepEqual(writes(), [], "a refused state must not be written to");
    /* The state is what refuses, and it refuses before the body is spent - which
       is also what distinguishes this route's own gate from the identical answer
       `completePublication` would give after reading 2 MiB. */
    assert.equal(request.bodyUsed, false, `a ${seed} upload must be refused before its body is read`);
  });
}

test("an approved publication past its upload deadline is 410, not a late completion", async () => {
  const { resolve, clock, writes } = harness({ seed: "approved" });
  clock.setIso(RECORDS.approved.uploadExpiresAt);
  const request = upload(FIXTURE_HTML);
  await assertError(await handleArtifact(request, resolve), 410, "authorization_expired");
  assert.deepEqual(writes(), []);
  assert.equal(request.bodyUsed, false);
});

/* ------------------------------------------------------------------ */
/* publishing-disabled semantics                                       */
/* ------------------------------------------------------------------ */

test("a disabled deployment refuses a new completion, before the body", async () => {
  const { resolve, writes } = harness({ seed: "approved", publishEnabled: false });
  const request = upload(FIXTURE_HTML);
  await assertError(await handleArtifact(request, resolve), 503, "publishing_disabled");
  assert.deepEqual(writes(), []);
  assert.equal(request.bodyUsed, false, "a disabled deployment does not spend the body first");
});

test("the disabled answer is the adapter's, not the route's own opinion", async () => {
  /* The route's pre-check is an optimisation over `completePublication`'s own
     flag check, so the two must agree on the answer. Calling the adapter with
     the same disabled dependency set and a body the route never read proves the
     503 survives the route being wrong about it. */
  const { resolve } = harness({ seed: "approved", publishEnabled: false });
  await assert.rejects(
    completePublication(
      {
        publicationId: FIXTURE_PUBLICATION_ID,
        agentSecret: FIXTURE_RECORD_AGENT_SECRET,
        html: FIXTURE_HTML,
        contentSha256: VALID_DESCRIPTOR.contentSha256,
        contentBytes: VALID_DESCRIPTOR.contentBytes,
      },
      resolve(),
    ),
    (error) => {
      assert.equal(error.code, "publishing_disabled");
      assert.equal(error.status, 503);
      return true;
    },
  );
});

test("a disabled deployment still recovers the receipt of a completed publication", async () => {
  const { resolve } = harness({ seed: "complete", publishEnabled: false });
  const response = await handleArtifact(upload(FIXTURE_HTML), resolve);
  assert.equal(response.status, 200);
  const body = await read(response);
  assert.deepEqual(body.result, FIXTURE_RESULT);
});

/* ------------------------------------------------------------------ */
/* the happy path                                                      */
/* ------------------------------------------------------------------ */

test("the approved bytes commit once, as 201 and the status envelope", async () => {
  const { resolve, stored, writes } = harness({ seed: "approved" });
  const response = await handleArtifact(upload(FIXTURE_HTML), resolve);
  const body = await read(response);

  assert.equal(response.status, 201);
  assert.deepEqual(validateResult(body, { appOrigin: FIXTURE_APP_ORIGIN }), body);
  assert.equal(body.state, "complete");
  assert.equal(body.intervalSeconds, HOSTED_LIMITS.POLL_INTERVAL_SECONDS);
  assert.deepEqual(body.result, FIXTURE_RESULT);

  const record = stored();
  assert.equal(record.state, "complete");
  assert.equal(record.html, FIXTURE_HTML, "the stored document is the uploaded document");
  assert.equal(sha256(record.html), VALID_DESCRIPTOR.contentSha256);
  assert.equal(record.ownerAccountId, RECORDS.approved.ownerAccountId, "the owner is unchanged");
  assert.equal(body.expiresAt, record.receiptExpiresAt);
  assert.equal(writes().length, 1, "exactly one conditional write commits the document");
  assert.equal(typeof writes()[0].options.onlyIfMatch, "string", "the write is a compare-and-set");
});

test("no private field of the record reaches the response", async () => {
  const { resolve } = harness({ seed: "approved" });
  const body = await read(await handleArtifact(upload(FIXTURE_HTML), resolve));
  const serialised = JSON.stringify(body);
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "intervalSeconds", "result", "state", "v"]);
  for (const secret of [
    RECORDS.approved.agentSecretHash,
    RECORDS.approved.browserSecretHash,
    FIXTURE_RECORD_AGENT_SECRET,
    FIXTURE_HTML,
  ]) {
    assert.ok(!serialised.includes(secret), "the upload response must not carry a private field");
  }
});

test("a UTF-8 BOM survives the round trip byte for byte", async () => {
  const descriptor = descriptorFor(FIXTURE_HTML_WITH_BOM);
  const { resolve, stored } = harness({
    record: { ...RECORDS.approved, descriptor },
  });
  const response = await handleArtifact(upload(FIXTURE_HTML_WITH_BOM), resolve);
  const body = await read(response);

  assert.equal(response.status, 201);
  assert.equal(body.result.contentSha256, descriptor.contentSha256);
  const record = stored();
  assert.ok(record.html.startsWith("﻿"), "the BOM is preserved, not stripped");
  assert.equal(sha256(record.html), descriptor.contentSha256);
});

test("a body arriving in several chunks is reassembled exactly", async () => {
  const { resolve, stored } = harness({ seed: "approved" });
  const half = Math.floor(FIXTURE_HTML.length / 2);
  const request = upload(chunkedBody([FIXTURE_HTML.slice(0, half), FIXTURE_HTML.slice(half)]));
  const response = await handleArtifact(request, resolve);

  assert.equal(response.status, 201);
  assert.equal(stored().html, FIXTURE_HTML);
});

/* ------------------------------------------------------------------ */
/* retry and recovery                                                  */
/* ------------------------------------------------------------------ */

test("an identical retry is 200 with the same receipt, and writes nothing", async () => {
  const { resolve, stored, writes } = harness({ seed: "approved" });
  const first = await handleArtifact(upload(FIXTURE_HTML), resolve);
  const committed = stored();
  assert.equal(first.status, 201);
  assert.equal(writes().length, 1, "the first upload is the only write");

  const second = await handleArtifact(upload(FIXTURE_HTML), resolve);
  assert.equal(second.status, 200);
  assert.deepEqual(await read(second), await read(first));
  assert.deepEqual(stored(), committed, "a retry never rewrites the record");
  /* The record comparison alone would still pass against a route that rewrote
     the same bytes under a fresh ETag, which is exactly the compare-and-set a
     retry must not spend. */
  assert.equal(writes().length, 1, "a retry issues no conditional write at all");
});

test("a retry carrying different bytes is refused, and the document is untouched", async () => {
  const { resolve, stored } = harness({ seed: "complete" });
  const other = htmlOfExactBytes(VALID_DESCRIPTOR.contentBytes);
  assert.notEqual(sha256(other), VALID_DESCRIPTOR.contentSha256);

  const response = await handleArtifact(upload(other), resolve);
  await assertError(response, 409, "descriptor_mismatch");
  assert.equal(stored().html, FIXTURE_HTML, "the committed document never changes");
});

test("a receipt older than its window is 410, and the body is not read", async () => {
  const { resolve, clock } = harness({ seed: "complete" });
  clock.setIso(RECORDS.complete.receiptExpiresAt);
  const request = upload(FIXTURE_HTML);
  await assertError(await handleArtifact(request, resolve), 410, "receipt_expired");
  assert.equal(request.bodyUsed, false);
});

test("a write the provider committed without proving it is 200, never a second 201", async () => {
  const { resolve, provider, stored } = harness({ seed: "approved" });
  provider.beforeWrite((key, value) => {
    /* The server applied the conditional write and lost the response, so the
       package re-sends it and is told 412. The record is this caller's record. */
    provider.applyDirectly(key, value);
  });

  const response = await handleArtifact(upload(FIXTURE_HTML), resolve);
  assert.equal(response.status, 200, "an unproven write must not claim to have created");
  assert.deepEqual((await read(response)).result, FIXTURE_RESULT);
  assert.equal(stored().html, FIXTURE_HTML);
});

/**
 * The read that builds the response envelope happens *after* the document is
 * stored, so a fault there is not a failed upload - the bytes are committed and
 * owned. These two tests pin the handler's answer on either side of that line.
 */
test("a transient fault reading the receipt does not lose a committed 201", async () => {
  const { resolve, provider, stored, writes } = harness({ seed: "approved" });
  /* Reads: the preflight, `completePublication`'s own read, then the envelope. */
  provider.failNextRead({ skip: 2, throws: true });

  const response = await handleArtifact(upload(FIXTURE_HTML), resolve);
  assert.equal(response.status, 201, "the creation is still the caller's creation");
  const body = await read(response);
  assert.deepEqual(body.result, FIXTURE_RESULT);
  assert.equal(body.expiresAt, stored().receiptExpiresAt);
  assert.equal(writes().length, 1, "the retry re-reads; it never re-writes");
  provider.assertFaultsConsumed();
});

test("a receipt that stays unreadable is a retryable error over a document that exists", async () => {
  const { resolve, provider, stored } = harness({ seed: "approved" });
  provider.failNextRead({ skip: 2, throws: true });
  provider.failNextRead({ throws: true });

  const body = await assertError(await handleArtifact(upload(FIXTURE_HTML), resolve), 503, "unavailable");
  assert.equal(body.error.retryable, true, "the caller's retry is the recovery path");
  /* The document is durably stored regardless, which is what makes that retry
     answer 200 with the same receipt rather than starting anything over. */
  assert.equal(stored().state, "complete");
  assert.equal(stored().html, FIXTURE_HTML);
  provider.assertFaultsConsumed();

  const recovered = await handleArtifact(upload(FIXTURE_HTML), resolve);
  assert.equal(recovered.status, 200);
  assert.deepEqual((await read(recovered)).result, FIXTURE_RESULT);
});

/* ------------------------------------------------------------------ */
/* races between two live requests                                     */
/* ------------------------------------------------------------------ */

/**
 * The library suite already pins these interleavings against
 * `completePublication` directly. They are repeated here through the real route
 * because the acceptance gate asks what *two handler invocations* do to one
 * record: the handler reads a body, runs a preflight and re-reads an envelope
 * around the write, and none of that is exercised by calling the library twice.
 *
 * The interleaving is deterministic rather than timing-dependent. The provider
 * double runs a one-shot hook immediately before it evaluates a conditional
 * write, so the second request is driven to completion *inside* the first
 * request's compare-and-set - the exact window where the first request's ETag
 * goes stale.
 */
test("two concurrent uploads of the approved bytes commit one document", async () => {
  const { resolve, provider, stored, writes } = harness({ seed: "approved" });

  let inner = null;
  provider.beforeWrite(async () => {
    inner = await handleArtifact(upload(FIXTURE_HTML), resolve);
  });
  const outer = await handleArtifact(upload(FIXTURE_HTML), resolve);

  /* The request that reached the store second is the one that created; the
     other discovers the committed document and recovers its receipt. */
  assert.equal(inner.status, 201, "the write that landed is the creation");
  assert.equal(outer.status, 200, "the loser must not claim a second creation");
  const created = await read(inner);
  const recovered = await read(outer);
  assert.deepEqual(recovered, created, "both callers see the same receipt");
  assert.deepEqual(created.result, FIXTURE_RESULT, "one document id, one url, one owner");

  const record = stored();
  assert.equal(record.state, "complete");
  assert.equal(record.html, FIXTURE_HTML);
  assert.equal(record.ownerAccountId, RECORDS.approved.ownerAccountId, "the owner is immutable");
  assert.equal(provider.keys().length, 1, "a race never mints a second record");
  assert.equal(
    writes().filter((call) => call.key === FIXTURE_KEY).length,
    2,
    "both requests attempted the compare-and-set; only one could win",
  );
  assert.equal(
    JSON.parse(provider.raw(FIXTURE_KEY).data).completedAt,
    record.completedAt,
    "the losing attempt left the committed record untouched",
  );
});

test("an upload whose write is delayed cannot resurrect a cancellation that won", async () => {
  const { resolve, provider, stored, writes } = harness({ seed: "approved" });

  let cancelled = null;
  provider.beforeWrite(async () => {
    /* The agent gave up on this operation while its own upload was in flight.
       Cancellation reaches the store first, so the upload's compare-and-set is
       evaluated against a record that is no longer approved. */
    cancelled = await handleCancel(
      new Request(`${BASE}/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/cancel`, {
        method: "POST",
        headers: { authorization: `Bearer ${FIXTURE_RECORD_AGENT_SECRET}` },
      }),
      resolve,
    );
  });
  const response = await handleArtifact(upload(FIXTURE_HTML), resolve);

  assert.equal(cancelled.status, 200);
  assert.equal((await read(cancelled)).state, "cancelled");
  await assertError(response, 409, "state_conflict");

  const record = stored();
  assert.equal(record.state, "cancelled", "the upload cannot re-open a terminal operation");
  assert.equal(record.html, null, "a cancelled record never holds bytes");
  assert.equal(record.completedAt, null);
  assert.equal(provider.keys().length, 1);
  assert.equal(
    writes().filter((call) => call.key === FIXTURE_KEY && call.options.onlyIfMatch !== undefined)
      .length,
    2,
    "the upload's late write was attempted and refused, not skipped",
  );
});

/* ------------------------------------------------------------------ */
/* descriptor and byte validation                                      */
/* ------------------------------------------------------------------ */

test("bytes that are not the approved document are refused", async () => {
  const { resolve, stored, writes } = harness({ seed: "approved" });
  const other = htmlOfExactBytes(VALID_DESCRIPTOR.contentBytes);
  await assertError(await handleArtifact(upload(other), resolve), 409, "descriptor_mismatch");
  assert.deepEqual(writes(), []);
  assert.equal(stored().html, null);
});

test("a document of the approved digest but a different length cannot exist", async () => {
  /* A length that disagrees with the bytes is caught even when the caller's
     digest is right, because both facts are re-derived from the body. */
  const descriptor = { ...VALID_DESCRIPTOR, contentBytes: VALID_DESCRIPTOR.contentBytes + 1 };
  const { resolve, writes } = harness({ record: { ...RECORDS.approved, descriptor } });
  await assertError(await handleArtifact(upload(FIXTURE_HTML), resolve), 409, "descriptor_mismatch");
  assert.deepEqual(writes(), []);
});

test("a body that is not an HTML document is refused", async () => {
  const text = "just some text, long enough to look like a document";
  const { resolve, writes } = harness({ record: { ...RECORDS.approved, descriptor: descriptorFor(text) } });
  await assertError(await handleArtifact(upload(text), resolve), 400, "invalid_request");
  assert.deepEqual(writes(), []);
});

/* ------------------------------------------------------------------ */
/* transport bounds                                                    */
/* ------------------------------------------------------------------ */

test("only the exact artifact media type is accepted", async () => {
  const refused = [
    undefined,
    "application/json",
    "text/html",
    "text/plain; charset=utf-8",
    "text/html; charset=iso-8859-1",
  ];
  for (const type of refused) {
    const { resolve, writes } = harness({ seed: "approved" });
    const request = upload(FIXTURE_HTML, {
      headers: type === undefined ? { "content-type": "" } : { "content-type": type },
    });
    if (type !== undefined) request.headers.set("content-type", type);
    else request.headers.delete("content-type");
    await assertError(await handleArtifact(request, resolve), 415, "unsupported_media_type");
    assert.deepEqual(writes(), []);
  }
});

test("the media type survives a client's spacing and casing", async () => {
  for (const type of ["TEXT/HTML;CHARSET=UTF-8", 'text/html;  charset="utf-8"']) {
    const { resolve } = harness({ seed: "approved" });
    const request = upload(FIXTURE_HTML);
    request.headers.set("content-type", type);
    const response = await handleArtifact(request, resolve);
    assert.equal(response.status, 201, `${type} should be accepted`);
  }
});

test("a body this server would have to decompress is refused, before it is read", async () => {
  for (const encoding of ["gzip", "GZIP", "br", "deflate", "identity, gzip", "gzip, identity"]) {
    const { resolve, writes } = harness({ seed: "approved" });
    const request = upload(FIXTURE_HTML);
    request.headers.set("content-encoding", encoding);
    const body = await assertError(
      await handleArtifact(request, resolve),
      415,
      "unsupported_media_type",
    );
    assert.equal(body.error.retryable, false, `content-encoding: ${encoding} is not worth retrying`);
    /* The digest is computed over the octets that arrive, so a coded body would
       otherwise be measured as a document nobody approved and reported as a
       descriptor mismatch - a 409 blaming the caller's bytes for the server's
       refusal to decode. */
    assert.equal(request.bodyUsed, false, "a coded body is refused before it is spent");
    assert.deepEqual(writes(), []);
  }
});

test("a caller that spells out the absence of a coding is accepted", async () => {
  for (const encoding of ["identity", "IDENTITY", " identity "]) {
    const { resolve, stored } = harness({ seed: "approved" });
    const request = upload(FIXTURE_HTML);
    request.headers.set("content-encoding", encoding);
    const response = await handleArtifact(request, resolve);
    assert.equal(response.status, 201, `content-encoding: "${encoding}" should be accepted`);
    assert.equal(stored().html, FIXTURE_HTML);
  }
});

test("a declared length past the ceiling is refused without reading the body", async () => {
  const { resolve, writes } = harness({ seed: "approved" });
  const request = upload(FIXTURE_HTML);
  request.headers.set("content-length", String(HOSTED_LIMITS.HTML_MAX_BYTES + 1));
  await assertError(await handleArtifact(request, resolve), 413, "artifact_too_large");
  assert.equal(request.bodyUsed, false, "a declared oversize body is refused before it is read");
  assert.deepEqual(writes(), []);
});

test("a body that grows past the ceiling mid-stream is refused, undeclared", async () => {
  const { resolve, writes } = harness({ seed: "approved" });
  const oversize = "p".repeat(HOSTED_LIMITS.HTML_MAX_BYTES + 1);
  const request = upload(oversize);
  request.headers.delete("content-length");
  await assertError(await handleArtifact(request, resolve), 413, "artifact_too_large");
  assert.deepEqual(writes(), []);
});

test("an empty body is refused as under the artifact floor", async () => {
  const { resolve, writes } = harness({ seed: "approved" });
  await assertError(await handleArtifact(upload(""), resolve), 400, "invalid_request");
  assert.deepEqual(writes(), []);
});

test("bytes that are not strict UTF-8 are refused rather than replaced", async () => {
  const { resolve, writes } = harness({ seed: "approved" });
  /* A lone continuation byte inside an otherwise valid document: a lenient
     decoder would turn it into U+FFFD and store a document nobody sent. */
  const bytes = new Uint8Array([...new TextEncoder().encode("<html>"), 0x80, ...new TextEncoder().encode("</html>")]);
  await assertError(await handleArtifact(upload(chunkedBody([bytes])), resolve), 400, "invalid_request");
  assert.deepEqual(writes(), []);
});

test("a document at exactly the ceiling is accepted", async () => {
  const html = htmlOfExactBytes(HOSTED_LIMITS.HTML_MAX_BYTES);
  const { resolve, stored } = harness({ record: { ...RECORDS.approved, descriptor: descriptorFor(html) } });
  const response = await handleArtifact(upload(html), resolve);
  assert.equal(response.status, 201);
  assert.equal(Buffer.byteLength(stored().html, "utf8"), HOSTED_LIMITS.HTML_MAX_BYTES);
});

/* ------------------------------------------------------------------ */
/* the body reader on its own                                          */
/* ------------------------------------------------------------------ */

test("readArtifactBody derives its facts from the bytes, not from a header", async () => {
  const request = new Request(`${BASE}${ARTIFACT_PATH}`, {
    method: "PUT",
    headers: { "content-type": MEDIA_TYPE, "content-length": "1" },
    body: FIXTURE_HTML,
  });
  const body = await readArtifactBody(request);
  assert.equal(body.html, FIXTURE_HTML);
  assert.equal(body.contentBytes, Buffer.byteLength(FIXTURE_HTML, "utf8"));
  assert.equal(body.contentSha256, VALID_DESCRIPTOR.contentSha256);
  assert.ok(Object.isFrozen(body));
});

test("readArtifactBody refuses a request with no body at all", async () => {
  const request = new Request(`${BASE}${ARTIFACT_PATH}`, {
    method: "PUT",
    headers: { "content-type": MEDIA_TYPE },
  });
  await assert.rejects(readArtifactBody(request), (error) => {
    assert.equal(error.code, "invalid_request");
    return true;
  });
});

test("readArtifactBody reports a stream that fails mid-body as the caller's problem", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("connection reset"));
    },
  });
  const request = new Request(`${BASE}${ARTIFACT_PATH}`, {
    method: "PUT",
    headers: { "content-type": MEDIA_TYPE },
    body,
    duplex: "half",
  });
  await assert.rejects(readArtifactBody(request), (error) => {
    assert.equal(error.code, "invalid_request");
    assert.equal(error.status, 400);
    return true;
  });
});

/**
 * The bounded read, against a stream this test still owns.
 *
 * A `Request` constructed in-process has already buffered its body by the time a
 * handler sees it, so the route tests above can only prove the *answer* is 413.
 * `readArtifactBody` reads `headers` and `body` and nothing else, so handing it a
 * stub with a stream that never ends is what proves the read stops at the bound
 * instead of draining whatever arrives - which is the difference between a
 * bounded function and one that merely measures afterwards.
 */
test("readArtifactBody stops at the ceiling instead of draining an endless body", async () => {
  const chunk = new TextEncoder().encode("p".repeat(64 * 1024));
  let delivered = 0;
  const stub = {
    headers: new Headers({ "content-type": MEDIA_TYPE }),
    body: new ReadableStream({
      pull(controller) {
        delivered += 1;
        controller.enqueue(chunk);
      },
    }),
  };

  await assert.rejects(readArtifactBody(stub), (error) => {
    assert.equal(error.code, "artifact_too_large");
    assert.equal(error.status, 413);
    return true;
  });
  const ceilingChunks = Math.ceil(HOSTED_LIMITS.HTML_MAX_BYTES / chunk.byteLength);
  assert.ok(
    delivered <= ceilingChunks + 2,
    `read ${delivered} chunks for a ${ceilingChunks}-chunk ceiling`,
  );
});

test("readArtifactBody cancels a body it refuses rather than only unlocking it", async () => {
  const chunk = new TextEncoder().encode("p".repeat(256 * 1024));
  let cancelled = null;
  const stub = {
    headers: new Headers({ "content-type": MEDIA_TYPE }),
    body: new ReadableStream({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel(reason) {
        cancelled = reason ?? "cancelled";
      },
    }),
  };

  await assert.rejects(readArtifactBody(stub), (error) => {
    assert.equal(error.code, "artifact_too_large");
    return true;
  });
  /* Releasing the lock would leave `cancelled` null and the source still
     enqueueing against this invocation, which is the resource leak the refusal
     is supposed to end. */
  assert.notEqual(cancelled, null, "a refused body must be cancelled, not merely released");
  assert.equal(stub.body.locked, false, "and the lock is released as well");
});

test("a body accepted in full is not cancelled", async () => {
  let cancelled = false;
  const stub = {
    headers: new Headers({ "content-type": MEDIA_TYPE }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(FIXTURE_HTML));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
  };

  const body = await readArtifactBody(stub);
  assert.equal(body.contentSha256, VALID_DESCRIPTOR.contentSha256);
  assert.equal(cancelled, false, "a body that arrived in full has nothing to cancel");
});

test("a content-length that is not a usable number falls through to the streaming bound", async () => {
  /* A chunked upload has no `Content-Length` at all, and a proxy can leave a
     malformed one; neither may reject a body the bytes themselves permit, and
     neither may let an oversize one through. */
  /* `1e9` and `0x400000` are the ones that matter: both are past the ceiling to
     `Number`, and neither is a length any HTTP client meant to declare, so a
     reader that coerced the header instead of parsing it would refuse a legal
     document outright. */
  for (const header of ["", "  ", "not-a-number", "-1", "1.5", "12,13", "1e9", "0x400000"]) {
    const { resolve, stored } = harness({ seed: "approved" });
    const request = upload(FIXTURE_HTML);
    request.headers.set("content-length", header);
    const response = await handleArtifact(request, resolve);
    assert.equal(response.status, 201, `content-length: "${header}" should not decide the answer`);
    assert.equal(stored().html, FIXTURE_HTML);
  }

  const { resolve, writes } = harness({ seed: "approved" });
  const oversize = upload("p".repeat(HOSTED_LIMITS.HTML_MAX_BYTES + 1));
  oversize.headers.set("content-length", "not-a-number");
  await assertError(await handleArtifact(oversize, resolve), 413, "artifact_too_large");
  assert.deepEqual(writes(), [], "an unusable header still leaves the byte bound in charge");
});
