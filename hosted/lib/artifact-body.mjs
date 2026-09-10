/**
 * The artifact request body: the one place raw HTTP bytes become facts about a
 * document.
 *
 * The upload route is the only hosted endpoint whose body is not JSON, and it is
 * the only one where the body is large enough that reading it carelessly is
 * itself the vulnerability. Three rules shape this module:
 *
 *  1. **The media type is checked before a single byte is read.** C3 freezes the
 *     request type as `text/html; charset=utf-8`, and a body that was never
 *     going to be accepted should not be spent being received. A bare
 *     `text/html` is refused too: the charset is not decoration here, it is the
 *     caller stating the encoding this module is about to enforce strictly.
 *  2. **The read is bounded as it happens, not after.** `request.arrayBuffer()`
 *     would buffer whatever arrives and only then let anything measure it, so a
 *     caller could make the function hold far more than C2's 2 MiB before being
 *     told 413. Reading the stream chunk by chunk and stopping at the first
 *     chunk that crosses the bound turns "too large" into a cheap answer.
 *     `Content-Length`, when present, short-circuits even that - but it is a
 *     hint from the caller, so it can only make the rejection *earlier*, never
 *     let a longer body through.
 *  3. **Every fact returned is derived from the bytes received.** The digest and
 *     the length are computed here, over the exact octets, and are never read
 *     out of a header or a descriptor. That is the whole point of the upload
 *     step: the approval covered a specific document, and the only way to know
 *     whether these bytes are that document is to measure them. Comparing the
 *     measurement against the approved descriptor is `completePublication`'s
 *     job, on every compare-and-set attempt, and is deliberately not repeated
 *     here - a second opinion about the descriptor is a second state machine.
 */

import { createHash } from "node:crypto";

import { HOSTED_LIMITS, HostedContractError, decodeArtifactBytes } from "./contracts.mjs";

/**
 * The exact request media type, spelled loosely enough to survive a client's
 * whitespace and casing and nothing else.
 *
 * A `charset` other than UTF-8 is not silently transcoded: C2's artifact is
 * UTF-8 bytes, and a caller announcing something else has sent a different
 * document than the one it thinks it sent.
 */
const ARTIFACT_MEDIA_TYPE = /^text\/html\s*;\s*charset\s*=\s*"?utf-8"?\s*$/i;

/** A C3 failure, with the field a caller would need to fix. */
function fail(code, message, field) {
  return new HostedContractError(code, message, { field });
}

/**
 * Reject a request whose body cannot be the approved artifact by its type alone.
 *
 * Split out so the handler's rejection order stays readable and so a test can
 * assert the media-type rule without constructing a body.
 */
function requireArtifactMediaType(request) {
  const type = request.headers.get("content-type");
  if (type === null || !ARTIFACT_MEDIA_TYPE.test(type)) {
    throw fail(
      "unsupported_media_type",
      `body must be ${HOSTED_LIMITS.ARTIFACT_MEDIA_TYPE}`,
      "content-type",
    );
  }
}

/**
 * The declared length, when the caller declared a usable one.
 *
 * A missing, malformed or negative `Content-Length` returns `null` rather than
 * throwing: the streaming bound below is the authority, and refusing a request
 * over a header the caller may legitimately have omitted (a chunked upload has
 * none) would reject correct clients for no safety gain.
 */
function declaredLength(request) {
  const header = request.headers.get("content-length");
  if (header === null) return null;
  if (!/^\d+$/.test(header.trim())) return null;
  return Number(header.trim());
}

/**
 * Read the whole body, refusing at the first byte past C2's ceiling.
 *
 * The chunks are kept and concatenated only once the total is known to be
 * legal, so the peak held is the body plus one chunk rather than twice the
 * body.
 */
async function readBoundedBody(request) {
  const stream = request.body;
  if (stream === null || stream === undefined) {
    throw fail("invalid_request", "an artifact body is required", "body");
  }

  const chunks = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > HOSTED_LIMITS.HTML_MAX_BYTES) {
        throw fail(
          "artifact_too_large",
          `artifact must be at most ${HOSTED_LIMITS.HTML_MAX_BYTES} bytes`,
          "body",
        );
      }
      chunks.push(chunk);
    }
  } catch (error) {
    /* A bound we imposed is the answer; anything else is a body that did not
       finish arriving, which is the caller's transport problem and not a fault
       worth reporting as an unavailable service. */
    if (error instanceof HostedContractError) throw error;
    throw fail("invalid_request", "the artifact body could not be read", "body");
  } finally {
    /* Releasing the lock lets the runtime discard the rest of a body we refused
       instead of holding a half-consumed stream for the life of the request. */
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The artifact body of an upload request, as bytes this server has measured.
 *
 * @param {Request} request the upload request, body unread
 * @returns {Promise<Readonly<{html: string, contentSha256: string, contentBytes: number}>>}
 * @throws {HostedContractError} `unsupported_media_type`, `artifact_too_large`
 *   or `invalid_request`
 */
export async function readArtifactBody(request) {
  requireArtifactMediaType(request);

  const declared = declaredLength(request);
  if (declared !== null && declared > HOSTED_LIMITS.HTML_MAX_BYTES) {
    throw fail(
      "artifact_too_large",
      `artifact must be at most ${HOSTED_LIMITS.HTML_MAX_BYTES} bytes`,
      "content-length",
    );
  }

  const bytes = await readBoundedBody(request);
  /* Bounds and strict, BOM-preserving UTF-8 are AHU-001's rules, applied here
     rather than restated: an empty body is `artifact_too_large`'s lower bound
     and an invalid sequence is `invalid_request`, both from one shared decoder
     that the owner's download path uses in reverse. */
  const html = decodeArtifactBytes(bytes, { field: "artifact" });

  return Object.freeze({
    html,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    contentBytes: bytes.byteLength,
  });
}
