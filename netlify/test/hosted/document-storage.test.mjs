/**
 * The S3-compatible document-bytes port, and the two routes that use it.
 *
 * The signer is pinned to AWS's own published Signature Version 4 examples, so
 * the in-memory S3 double below - which verifies every request and every
 * presigned URL with that same signer - is checking against a known-correct
 * implementation rather than against itself. What the double then proves is
 * behaviour: an expired or tampered URL is refused, history is bounded, the
 * endpoint is configuration, and no URL is minted before authorisation.
 *
 *   node --test netlify/test/hosted/document-storage.test.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  DOCUMENT_HISTORY_PRIOR,
  DOCUMENT_STORAGE_CONFIG_KEYS,
  DocumentStorageError,
  SIGNED_URL_TTL_SECONDS,
  createDocumentStorage,
  documentObjectKey,
  presignGet,
  readDocumentStorageConfig,
  signHeaders,
} from "../../lib/hosted/document-storage.mjs";
import { encodeArtifactBytes } from "../../lib/hosted/contracts.mjs";
import { viewerCsp } from "../../lib/hosted/documents.mjs";
import { SESSION_COOKIE } from "../../lib/hosted/identity.mjs";
import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import { createDocumentReadRoutes } from "../../functions/hosted-document-read.mjs";
import { handleArtifact } from "../../functions/hosted-publications-artifact.mjs";
import { APP_ORIGIN, fixedClock, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_HTML,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  FIXTURE_RECORD_AGENT_SECRET,
  OTHER_PRINCIPAL,
  RECORDS,
  VALID_DESCRIPTOR,
} from "./fixtures/publications.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

/* Synthetic credentials only. */
const R2_ENV = Object.freeze({
  ARCHON_STORAGE_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.example",
  ARCHON_STORAGE_REGION: "auto",
  ARCHON_STORAGE_BUCKET: "archon-docs",
  ARCHON_STORAGE_ACCESS_KEY_ID: "SYNTHETICKEYID0001",
  ARCHON_STORAGE_SECRET_ACCESS_KEY: "synthetic-secret-value-0001",
});
const MINIO_ENV = Object.freeze({
  ...R2_ENV,
  ARCHON_STORAGE_ENDPOINT: "http://127.0.0.1:9000",
  ARCHON_STORAGE_REGION: "us-east-1",
});

const DOC = "a".repeat(32);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const parseAmzDate = (value) =>
  Date.parse(value.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));

/**
 * An in-memory S3: verifies every header signature, stores objects with a
 * `LastModified`, answers ListObjectsV2, and serves presigned GETs the way a
 * private bucket does - refusing anything unsigned, expired or altered.
 */
function fakeS3(config, clock) {
  const objects = new Map();
  const secret = config.readSecretAccessKey();
  const sign = { region: config.region, accessKeyId: config.accessKeyId, secret };
  const bucketPath = `/${config.bucket}`;

  async function fetch(url, init) {
    assert.ok(url.startsWith(`${config.endpoint}/`), "every call goes to the configured endpoint");
    const { authorization, ...sent } = init.headers;
    const { "x-amz-date": date, "x-amz-content-sha256": payloadHash, ...extra } = sent;
    const expected = signHeaders({ method: init.method, url, headers: extra, payloadHash, ...sign, now: parseAmzDate(date) });
    if (expected.authorization !== authorization) return new Response(null, { status: 403 });
    if (init.body !== undefined && sha(init.body) !== payloadHash) return new Response(null, { status: 400 });

    const target = new URL(url);
    if (target.pathname === bucketPath && init.method === "GET") {
      const prefix = target.searchParams.get("prefix");
      const entries = [...objects]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, { lastModified }]) => `<Contents><Key>${key}</Key><LastModified>${lastModified}</LastModified></Contents>`);
      return new Response(`<ListBucketResult>${entries.join("")}</ListBucketResult>`, { status: 200 });
    }
    const key = target.pathname.slice(bucketPath.length + 1);
    if (init.method === "PUT") {
      objects.set(key, { bytes: Buffer.from(init.body), lastModified: new Date(clock.now()).toISOString() });
      return new Response(null, { status: 200 });
    }
    if (init.method === "HEAD") return new Response(null, { status: objects.has(key) ? 200 : 404 });
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }

  /** What the storage origin answers a browser following a presigned URL. */
  function serve(presigned, atMs) {
    const target = new URL(presigned);
    const date = target.searchParams.get("X-Amz-Date");
    const expires = Number(target.searchParams.get("X-Amz-Expires"));
    if (date === null || !Number.isInteger(expires)) return { status: 403 };
    const recomputed = presignGet({
      url: `${target.origin}${target.pathname}`,
      ...sign,
      now: parseAmzDate(date),
      expiresSeconds: expires,
    });
    if (recomputed !== presigned) return { status: 403 };
    if (atMs > parseAmzDate(date) + expires * 1000) return { status: 403 };
    const object = objects.get(target.pathname.slice(bucketPath.length + 1));
    return object === undefined ? { status: 404 } : { status: 200, bytes: object.bytes };
  }

  return { fetch, serve, objects };
}

function storageOver(env) {
  const config = readDocumentStorageConfig(env);
  const clock = { ms: Date.parse("2026-11-19T12:00:00Z"), now: () => clock.ms };
  const s3 = fakeS3(config, clock);
  return { storage: createDocumentStorage({ config, fetch: s3.fetch, now: clock.now }), s3, clock };
}

/* ------------------------------------------------------------------ */
/* the signer, pinned to AWS's published examples                      */
/* ------------------------------------------------------------------ */

const AWS = {
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  now: Date.parse("2013-05-24T00:00:00Z"),
};

test("a presigned GET matches the AWS SigV4 query-string example", () => {
  const url = presignGet({ url: "https://examplebucket.s3.amazonaws.com/test.txt", ...AWS, expiresSeconds: 86400 });
  assert.equal(
    new URL(url).searchParams.get("X-Amz-Signature"),
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("a header-signed GET matches the AWS SigV4 GET Object example", () => {
  const headers = signHeaders({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: sha(""),
    ...AWS,
  });
  assert.match(headers.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

test("storage is off with no keys, and all-or-nothing with some", () => {
  assert.equal(readDocumentStorageConfig({}), null);
  for (const key of DOCUMENT_STORAGE_CONFIG_KEYS) {
    const partial = { ...R2_ENV, [key]: "" };
    assert.throws(() => readDocumentStorageConfig(partial), (error) => error.key === key);
  }
});

test("the secret is never a property, never serialised and never in an error", () => {
  const config = readDocumentStorageConfig(R2_ENV);
  const secret = R2_ENV.ARCHON_STORAGE_SECRET_ACCESS_KEY;
  assert.ok(!JSON.stringify(config).includes(secret));
  assert.ok(!Object.values(config).includes(secret));
  try {
    readDocumentStorageConfig({ ...R2_ENV, ARCHON_STORAGE_SECRET_ACCESS_KEY: `${secret} x` });
    assert.fail("a whitespace secret is refused");
  } catch (error) {
    assert.ok(!error.message.includes(secret) && !JSON.stringify(error).includes(secret));
  }
});

test("a plaintext endpoint is refused except on loopback", () => {
  assert.throws(
    () => readDocumentStorageConfig({ ...R2_ENV, ARCHON_STORAGE_ENDPOINT: "http://storage.example" }),
    (error) => error.key === "ARCHON_STORAGE_ENDPOINT",
  );
  assert.throws(
    () => readDocumentStorageConfig({ ...R2_ENV, ARCHON_STORAGE_ENDPOINT: "https://storage.example/path" }),
    (error) => error.key === "ARCHON_STORAGE_ENDPOINT",
  );
  assert.equal(readDocumentStorageConfig(MINIO_ENV).endpoint, "http://127.0.0.1:9000");
});

/* ------------------------------------------------------------------ */
/* the port                                                            */
/* ------------------------------------------------------------------ */

for (const [name, env] of [["R2-style", R2_ENV], ["MinIO-style", MINIO_ENV]]) {
  test(`${name}: stored bytes come back through a signed URL, with no code change`, async () => {
    const { storage, s3, clock } = storageOver(env);
    const bytes = encodeArtifactBytes(FIXTURE_HTML);
    await storage.put(DOC, sha(bytes), bytes);
    assert.equal(await storage.exists(DOC, sha(bytes)), true);

    const url = storage.signRead(DOC, sha(bytes));
    assert.ok(url.startsWith(`${env.ARCHON_STORAGE_ENDPOINT}/${env.ARCHON_STORAGE_BUCKET}/documents/${DOC}/`));
    assert.equal(new URL(url).searchParams.get("X-Amz-Expires"), String(SIGNED_URL_TTL_SECONDS));
    const served = s3.serve(url, clock.ms);
    assert.equal(served.status, 200);
    assert.deepEqual(new Uint8Array(served.bytes), bytes);
  });
}

test("the read URL lives single-digit minutes, and storage refuses it after", async () => {
  assert.ok(SIGNED_URL_TTL_SECONDS >= 60 && SIGNED_URL_TTL_SECONDS < 600);
  const { storage, s3, clock } = storageOver(R2_ENV);
  const bytes = encodeArtifactBytes(FIXTURE_HTML);
  await storage.put(DOC, sha(bytes), bytes);
  const url = storage.signRead(DOC, sha(bytes));
  assert.equal(s3.serve(url, clock.ms + SIGNED_URL_TTL_SECONDS * 1000).status, 200);
  assert.equal(s3.serve(url, clock.ms + SIGNED_URL_TTL_SECONDS * 1000 + 1).status, 403);
});

test("a tampered or unsigned URL is refused by storage", async () => {
  const { storage, s3, clock } = storageOver(R2_ENV);
  const bytes = encodeArtifactBytes(FIXTURE_HTML);
  await storage.put(DOC, sha(bytes), bytes);
  const url = storage.signRead(DOC, sha(bytes));
  const otherKey = url.replace(`/documents/${DOC}/`, `/documents/${"b".repeat(32)}/`);
  const longer = url.replace(`X-Amz-Expires=${SIGNED_URL_TTL_SECONDS}`, "X-Amz-Expires=604800");
  for (const forged of [otherKey, longer, url.split("?")[0], url.replace(/.$/, (c) => (c === "0" ? "1" : "0"))]) {
    assert.equal(s3.serve(forged, clock.ms).status, 403, forged.slice(0, 80));
  }
});

test("history keeps the latest plus the bounded prior versions and prunes the rest", async () => {
  const { storage, s3, clock } = storageOver(R2_ENV);
  const written = [];
  for (let version = 0; version < DOCUMENT_HISTORY_PRIOR + 3; version += 1) {
    clock.ms += 60_000;
    const bytes = encodeArtifactBytes(`${FIXTURE_HTML}<!-- v${version} -->`);
    await storage.put(DOC, sha(bytes), bytes);
    written.push(documentObjectKey(DOC, sha(bytes)));
  }
  const kept = (await storage.versions(DOC)).map(({ key }) => key);
  assert.deepEqual(kept, written.slice(-(DOCUMENT_HISTORY_PRIOR + 1)).reverse());
  assert.equal(s3.objects.size, DOCUMENT_HISTORY_PRIOR + 1);
});

test("an unreachable store fails closed with a message that names nothing", async () => {
  const config = readDocumentStorageConfig(R2_ENV);
  const storage = createDocumentStorage({
    config,
    fetch: async (url) => {
      throw new Error(`connect failed: ${url}`);
    },
  });
  await assert.rejects(storage.exists(DOC, sha("x")), (error) => {
    assert.ok(error instanceof DocumentStorageError);
    assert.equal(error.message, "document storage is unavailable");
    return true;
  });
  const refusing = createDocumentStorage({ config, fetch: async () => new Response(null, { status: 500 }) });
  await assert.rejects(refusing.put(DOC, sha("x"), encodeArtifactBytes("x")), DocumentStorageError);
});

/* ------------------------------------------------------------------ */
/* the routes                                                          */
/* ------------------------------------------------------------------ */

/** A storage port that records calls, for ordering assertions. */
function spyStorage({ exists = true, fail = false } = {}) {
  const calls = [];
  const step = (op) => (...args) => {
    calls.push([op, ...args]);
    if (fail) throw new DocumentStorageError();
  };
  return {
    calls,
    exists: async (...args) => (step("exists")(...args), exists),
    put: async (...args) => step("put")(...args),
    signRead: async (...args) => (step("signRead")(...args), "https://storage.example/signed?X-Amz-Signature=sig"),
  };
}

async function readHarness(storage) {
  const auth = memoryAuthStore(fixedClock(Date.parse(FIXTURE_NOW)));
  const provider = createProviderDouble();
  provider.put(FIXTURE_KEY, JSON.stringify(RECORDS.complete));
  const publications = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled: true,
    now: createClock(FIXTURE_NOW).now,
  };
  const read = createDocumentReadRoutes({ store: auth.store, publications, storage });
  const request = async (principal, method = "GET") => {
    const { token } = await auth.store.createSession(principal);
    const headers = { cookie: `${SESSION_COOKIE}=${token}` };
    return read(new Request(new URL(`/api/hosted/docs/${FIXTURE_PUBLICATION_ID}/content`, APP_ORIGIN), { method, headers }));
  };
  return { request };
}

test("a reader with no entitlement never causes a URL to be minted", async () => {
  const storage = spyStorage();
  const { request } = await readHarness(storage);
  const response = await request(OTHER_PRINCIPAL);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("location"), null);
  assert.deepEqual(storage.calls, [], "storage is not touched before authorisation");
});

test("an entitled reader is redirected to a signed URL, minted after authorisation", async () => {
  for (const method of ["GET", "HEAD"]) {
    const storage = spyStorage();
    const { request } = await readHarness(storage);
    const response = await request(FIXTURE_PRINCIPAL, method);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://storage.example/signed?X-Amz-Signature=sig");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.deepEqual(storage.calls.map(([op]) => op), ["exists", "signRead"]);
    assert.deepEqual(storage.calls[1].slice(1), [FIXTURE_PUBLICATION_ID, VALID_DESCRIPTOR.contentSha256]);
  }
});

test("a record stored before storage was configured is copied on first read", async () => {
  const storage = spyStorage({ exists: false });
  const { request } = await readHarness(storage);
  assert.equal((await request(FIXTURE_PRINCIPAL)).status, 302);
  const [op, id, digest, bytes] = storage.calls[1];
  assert.deepEqual([op, id, digest], ["put", FIXTURE_PUBLICATION_ID, VALID_DESCRIPTOR.contentSha256]);
  assert.deepEqual(bytes, encodeArtifactBytes(FIXTURE_HTML));
});

test("a storage outage refuses the read instead of falling back", async () => {
  const { request } = await readHarness(spyStorage({ fail: true }));
  const response = await request(FIXTURE_PRINCIPAL);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("location"), null);
  const body = await response.text();
  assert.ok(!body.includes(FIXTURE_HTML.slice(0, 40)), "the bytes are not proxied as a fallback");
  assert.ok(!body.includes("storage.example"));
});

test("the viewer may follow the redirect to the storage origin and nowhere else", () => {
  assert.match(viewerCsp("https://render.example"), /connect-src 'self';/);
  assert.match(
    viewerCsp("https://render.example", R2_ENV.ARCHON_STORAGE_ENDPOINT),
    new RegExp(`connect-src 'self' ${R2_ENV.ARCHON_STORAGE_ENDPOINT.replaceAll(".", "\\.")};`),
  );
});

function artifactHarness(storage) {
  const provider = createProviderDouble();
  provider.put(FIXTURE_KEY, JSON.stringify(RECORDS.approved));
  const dependencies = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: FIXTURE_APP_ORIGIN,
    production: true,
    publishEnabled: true,
    now: createClock(FIXTURE_NOW).now,
    randomBytes: sequentialRandomBytes(),
  };
  const upload = () =>
    handleArtifact(
      new Request(`https://hosted.example.test/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/artifact`, {
        method: "PUT",
        headers: { authorization: `Bearer ${FIXTURE_RECORD_AGENT_SECRET}`, "content-type": "text/html; charset=utf-8" },
        body: FIXTURE_HTML,
      }),
      () => dependencies,
      () => storage,
    );
  const stateAt = () => JSON.parse(provider.raw(FIXTURE_KEY).data).state;
  return { upload, stateAt };
}

test("a published document is written through the port, after the record commits", async () => {
  const states = [];
  const storage = spyStorage();
  const { upload, stateAt } = artifactHarness({
    ...storage,
    put: async (...args) => {
      states.push(stateAt());
      return storage.put(...args);
    },
  });
  assert.equal((await upload()).status, 201);
  assert.deepEqual(states, ["complete"]);
  const [, id, digest, bytes] = storage.calls[0];
  assert.deepEqual([id, digest], [FIXTURE_PUBLICATION_ID, VALID_DESCRIPTOR.contentSha256]);
  assert.deepEqual(bytes, encodeArtifactBytes(FIXTURE_HTML));
});

test("a failed storage write is a 503 that an identical retry repairs", async () => {
  let fail = true;
  const storage = spyStorage();
  const { upload } = artifactHarness({
    ...storage,
    put: async (...args) => {
      if (fail) throw new DocumentStorageError();
      return storage.put(...args);
    },
  });
  assert.equal((await upload()).status, 503);
  fail = false;
  assert.equal((await upload()).status, 200);
  assert.equal(storage.calls.length, 1);
});
