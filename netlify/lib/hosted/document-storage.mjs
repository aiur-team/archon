/**
 * The document-bytes port, spoken over the S3-compatible API.
 *
 * Publication *records* stay in the publication store; this module holds the
 * published *bytes* behind an API that S3, Cloudflare R2, Backblaze B2 and MinIO
 * all speak, so moving a deployment between them is a change of four variables
 * and no code. The wire protocol is AWS Signature Version 4, implemented here
 * with `node:crypto` rather than through an SDK: the five calls this port makes
 * are small, and a dependency the size of an SDK on a deploy path is more to
 * audit than the signer is.
 *
 * ## Security rules this module carries
 *
 *  - **A signed URL is minted only by `signRead`, and only callers that have
 *    already authorised the reader call it.** This module does not know who is
 *    asking, so it cannot be the authority; `hosted-document-read.mjs` is, and
 *    its test proves the refusal comes before any signing.
 *  - **The bucket is private.** Every request this module makes is signed, and
 *    the only unsigned-looking thing it produces is a presigned GET whose
 *    lifetime is `SIGNED_URL_TTL_SECONDS`. A presigned URL is never logged,
 *    never stored in a record and never part of an error.
 *  - **The secret key is behind a call, never a property**, as
 *    `AUTH0_CLIENT_SECRET` and `ARCHON_EMAIL_API_KEY` are, so no
 *    serialisation of the configuration can render it. Errors from this module
 *    carry a fixed message and no URL, key or provider body.
 *  - **Failure is closed.** Every unexpected status, timeout or throw is a
 *    retryable `unavailable`; nothing here falls back to an unsigned URL.
 *
 * ## Object layout and the bounded history
 *
 * One object per (document, content digest): `documents/<id>/<sha256>`. The
 * digest in the key is the digest C2 already stores in the record, so the
 * record names the exact object it was approved for and a re-upload of the same
 * bytes is an idempotent overwrite rather than a new version. Every write keeps
 * the newest `1 + DOCUMENT_HISTORY_PRIOR` objects under the document's prefix,
 * by the store's own `LastModified`, and deletes the rest; the object just
 * written is never a deletion candidate.
 *
 * Bytes are stored as `application/octet-stream` with an attachment
 * disposition, so the storage origin serves them under the same "not a
 * document" rules the account-origin content route uses.
 */

import { createHash, createHmac } from "node:crypto";

/** The environment variables this module reads, and nothing else. */
export const DOCUMENT_STORAGE_CONFIG_KEYS = Object.freeze([
  "ARCHON_STORAGE_ENDPOINT",
  "ARCHON_STORAGE_REGION",
  "ARCHON_STORAGE_BUCKET",
  "ARCHON_STORAGE_ACCESS_KEY_ID",
  "ARCHON_STORAGE_SECRET_ACCESS_KEY",
]);

/** How long a minted read URL stays valid. Single-digit minutes, by rule. */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Prior versions kept beside the current one; older ones are pruned on write. */
export const DOCUMENT_HISTORY_PRIOR = 3;

/** How long one storage call may take before it is treated as an outage. */
export const STORAGE_TIMEOUT_MS = 10_000;

/** The key namespace. */
export const DOCUMENT_KEY_PREFIX = "documents/";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const HEX64 = /^[0-9a-f]{64}$/;

/** A configuration fault, naming the variable and never its value. */
export class DocumentStorageConfigError extends Error {
  constructor(key, rule) {
    super(`${key} ${rule}`);
    this.name = "DocumentStorageConfigError";
    this.code = "invalid_configuration";
    this.key = key;
  }
}

/** Storage did not answer usefully. Fixed message; never a URL, key or body. */
export class DocumentStorageError extends Error {
  constructor(message = "document storage is unavailable") {
    super(message);
    this.name = "DocumentStorageError";
    this.code = "unavailable";
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The storage configuration, `null` when none of the keys is set, or a fault.
 *
 * All five keys or none, like the mailer: a half-configured store is the state
 * an operator reaches while setting it up, and it must refuse to start rather
 * than quietly keep serving from somewhere else.
 *
 * @returns {Readonly<{endpoint: string, region: string, bucket: string, accessKeyId: string, readSecretAccessKey: () => string}> | null}
 */
export function readDocumentStorageConfig(env) {
  if (env === null || typeof env !== "object") {
    throw new DocumentStorageConfigError("env", "must be an object of environment variables");
  }
  const present = DOCUMENT_STORAGE_CONFIG_KEYS.filter(
    (key) => typeof env[key] === "string" && env[key] !== "",
  );
  if (present.length === 0) return null;
  if (present.length !== DOCUMENT_STORAGE_CONFIG_KEYS.length) {
    const missing = DOCUMENT_STORAGE_CONFIG_KEYS.find((key) => !present.includes(key));
    throw new DocumentStorageConfigError(missing, "is required once any ARCHON_STORAGE_* key is set");
  }

  let url;
  try {
    url = new URL(env.ARCHON_STORAGE_ENDPOINT);
  } catch {
    throw new DocumentStorageConfigError("ARCHON_STORAGE_ENDPOINT", "must be an absolute URL");
  }
  /* An origin and nothing else, and HTTPS except on loopback (a local MinIO).
     A path, query or credentials in the endpoint would all change what gets
     signed in ways the operator did not mean. */
  if (url.origin === "null" || `${url.origin}` !== env.ARCHON_STORAGE_ENDPOINT.replace(/\/$/, "")) {
    throw new DocumentStorageConfigError(
      "ARCHON_STORAGE_ENDPOINT",
      "must be a bare origin with no path, query or credentials",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new DocumentStorageConfigError("ARCHON_STORAGE_ENDPOINT", "must use https");
  }

  const region = env.ARCHON_STORAGE_REGION;
  if (!/^[a-z0-9-]{1,32}$/.test(region)) {
    throw new DocumentStorageConfigError("ARCHON_STORAGE_REGION", "must be 1-32 characters of [a-z0-9-]");
  }
  const bucket = env.ARCHON_STORAGE_BUCKET;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new DocumentStorageConfigError("ARCHON_STORAGE_BUCKET", "must be a valid S3 bucket name");
  }
  const accessKeyId = env.ARCHON_STORAGE_ACCESS_KEY_ID;
  if (!/^[A-Za-z0-9]{3,128}$/.test(accessKeyId)) {
    throw new DocumentStorageConfigError("ARCHON_STORAGE_ACCESS_KEY_ID", "must be 3-128 alphanumeric characters");
  }
  const secret = env.ARCHON_STORAGE_SECRET_ACCESS_KEY;
  if (secret.length < 8 || /\s/.test(secret)) {
    throw new DocumentStorageConfigError(
      "ARCHON_STORAGE_SECRET_ACCESS_KEY",
      "must be at least 8 characters with no whitespace",
    );
  }

  return Object.freeze({
    endpoint: url.origin,
    region,
    bucket,
    accessKeyId,
    readSecretAccessKey: () => secret,
  });
}

/* ------------------------------------------------------------------ */
/* Signature Version 4                                                 */
/* ------------------------------------------------------------------ */

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 encoding, as SigV4 requires: `encodeURIComponent` plus `!'()*`. */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20130524T000000Z` for a millisecond clock reading. */
export function amzDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function canonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeRfc3986(key)}=${encodeRfc3986(params[key])}`)
    .join("&");
}

function signature({ method, path, query, headers, payloadHash, region, date, secret }) {
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    path.split("/").map(encodeRfc3986).join("/"),
    canonicalQuery(query),
    names.map((name) => `${name}:${String(lower[name]).trim()}\n`).join(""),
    signedHeaders,
    payloadHash,
  ].join("\n");
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
  return { signature: createHmac("sha256", key).update(stringToSign).digest("hex"), scope, signedHeaders };
}

/**
 * Header-signed request parts for one call. Exported for the AWS vector test.
 *
 * @returns {Record<string, string>} the headers to send, `authorization` included
 */
export function signHeaders({ method, url, headers = {}, payloadHash, region, accessKeyId, secret, now }) {
  const target = new URL(url);
  const date = amzDate(now);
  const all = { ...headers, host: target.host, "x-amz-content-sha256": payloadHash, "x-amz-date": date };
  const signed = signature({
    method,
    path: decodeURIComponent(target.pathname),
    query: Object.fromEntries(target.searchParams),
    headers: all,
    payloadHash,
    region,
    date,
    secret,
  });
  const { host: _host, ...send } = all;
  return {
    ...send,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${signed.scope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`,
  };
}

/** A presigned GET URL. Exported for the AWS vector test. */
export function presignGet({ url, region, accessKeyId, secret, now, expiresSeconds }) {
  const target = new URL(url);
  const date = amzDate(now);
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${date.slice(0, 8)}/${region}/s3/aws4_request`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const signed = signature({
    method: "GET",
    path: decodeURIComponent(target.pathname),
    query,
    headers: { host: target.host },
    payloadHash: UNSIGNED_PAYLOAD,
    region,
    date,
    secret,
  });
  return `${target.origin}${target.pathname}?${canonicalQuery(query)}&X-Amz-Signature=${signed.signature}`;
}

/* ------------------------------------------------------------------ */
/* the port                                                            */
/* ------------------------------------------------------------------ */

function documentPrefix(documentId) {
  if (typeof documentId !== "string" || !/^[0-9a-f]{32}$/.test(documentId)) {
    throw new TypeError("documentId must be 32 lowercase hex characters");
  }
  return `${DOCUMENT_KEY_PREFIX}${documentId}/`;
}

/** The object key for one version. Both parts are validated hex. */
export function documentObjectKey(documentId, contentSha256) {
  if (typeof contentSha256 !== "string" || !HEX64.test(contentSha256)) {
    throw new TypeError("contentSha256 must be 64 lowercase hex characters");
  }
  return `${documentPrefix(documentId)}${contentSha256}`;
}

/**
 * The storage port over one configuration.
 *
 * `fetch` and `now` are injected so a test drives the real signer against a
 * double that verifies signatures, and so constructing this contacts nothing.
 *
 * @returns {Readonly<{
 *   put: (documentId: string, contentSha256: string, bytes: Uint8Array) => Promise<void>,
 *   exists: (documentId: string, contentSha256: string) => Promise<boolean>,
 *   signRead: (documentId: string, contentSha256: string) => string,
 *   remove: (documentId: string, contentSha256: string) => Promise<void>,
 *   versions: (documentId: string) => Promise<{key: string, lastModified: string}[]>,
 *   origin: string,
 * }>}
 */
export function createDocumentStorage({ config, fetch = globalThis.fetch, now = Date.now } = {}) {
  if (config === null || typeof config !== "object" || typeof config.readSecretAccessKey !== "function") {
    throw new TypeError("createDocumentStorage requires a document storage configuration");
  }
  const { endpoint, region, bucket, accessKeyId } = config;
  const objectUrl = (key) => `${endpoint}/${bucket}/${key}`;

  async function call(method, url, { body, payloadHash = sha256Hex(body ?? ""), headers = {} } = {}) {
    const signed = signHeaders({
      method,
      url,
      headers,
      payloadHash,
      region,
      accessKeyId,
      secret: config.readSecretAccessKey(),
      now: now(),
    });
    try {
      return await fetch(url, {
        method,
        headers: signed,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
      });
    } catch {
      /* The provider's or runtime's error carries the URL; it is not kept. */
      throw new DocumentStorageError();
    }
  }

  async function versions(documentId) {
    const prefix = documentPrefix(documentId);
    const url = `${endpoint}/${bucket}?${canonicalQuery({ "list-type": "2", prefix })}`;
    const response = await call("GET", url);
    if (response.status !== 200) throw new DocumentStorageError();
    const xml = await response.text();
    /* Keys under this prefix are ours and hex-only, so a pattern read of the
       two fields is exact; a page past the first 1000 cannot happen at the
       history bound. */
    return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
      .map(([, entry]) => ({
        key: /<Key>([^<]*)<\/Key>/.exec(entry)?.[1] ?? "",
        lastModified: /<LastModified>([^<]*)<\/LastModified>/.exec(entry)?.[1] ?? "",
      }))
      .filter(({ key }) => key.startsWith(prefix))
      .sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
  }

  async function removeKey(key) {
    const response = await call("DELETE", objectUrl(key));
    if (response.status !== 204 && response.status !== 200) throw new DocumentStorageError();
  }

  async function put(documentId, contentSha256, bytes) {
    const key = documentObjectKey(documentId, contentSha256);
    /* The payload hash is computed from the bytes, not taken from the caller:
       storage then refuses a body whose digest differs from what was signed. */
    const response = await call("PUT", objectUrl(key), {
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="archon-document.html"',
      },
    });
    if (response.status !== 200) throw new DocumentStorageError();

    const stale = (await versions(documentId))
      .filter((version) => version.key !== key)
      .slice(DOCUMENT_HISTORY_PRIOR);
    for (const version of stale) await removeKey(version.key);
  }

  async function exists(documentId, contentSha256) {
    const response = await call("HEAD", objectUrl(documentObjectKey(documentId, contentSha256)));
    if (response.status === 200) return true;
    if (response.status === 404) return false;
    throw new DocumentStorageError();
  }

  function signRead(documentId, contentSha256) {
    return presignGet({
      url: objectUrl(documentObjectKey(documentId, contentSha256)),
      region,
      accessKeyId,
      secret: config.readSecretAccessKey(),
      now: now(),
      expiresSeconds: SIGNED_URL_TTL_SECONDS,
    });
  }

  return Object.freeze({
    put,
    exists,
    signRead,
    remove: (documentId, contentSha256) => removeKey(documentObjectKey(documentId, contentSha256)),
    versions,
    origin: endpoint,
  });
}

/** The production port, or `null` when no `ARCHON_STORAGE_*` key is set. */
export function documentStorageFromEnv(env) {
  const config = readDocumentStorageConfig(env);
  return config === null ? null : createDocumentStorage({ config });
}
