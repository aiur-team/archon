/**
 * `GET|HEAD /api/hosted/docs/<id>` and `.../content` - the owner's two reads.
 *
 * One module, two routes, because they must never disagree. Both resolve the id
 * the same way, both call `identifyHosted`, both call `readOwnedPublication`,
 * and both turn every refusal into the same 404. Splitting them into two files
 * would be two copies of an authorisation sequence, and the copy that gets a
 * step dropped is the one that serves bytes.
 *
 * Neither route trusts anything the viewer shell established. C4 is explicit
 * that the shell's earlier check is not reusable authorisation, and the shape of
 * that rule here is that these handlers receive nothing from the shell at all -
 * no token, no signed id, no header. They see a cookie and a path, exactly as
 * they would if the request were typed into an address bar.
 *
 * ## What a denial may not say
 *
 * `readOwnedPublication` collapses "no such record", "not complete yet" and
 * "belongs to another account" into one `not_found`, and this module keeps it
 * that way to the wire: one status, one envelope, no `field` that varies, no
 * header that varies, and identical bytes. An authenticated account learns
 * nothing about which publication ids exist or who owns them, which is the same
 * thing an anonymous one learns.
 *
 * `session_required` is the one denial that is allowed to be distinct, and it is
 * distinct on purpose: a signed-out reader has an action to take, and telling
 * them to sign in reveals nothing, because they get that answer for every id.
 *
 * ## Why the bytes are not a document
 *
 * The content route is `application/octet-stream` with `nosniff`, an attachment
 * disposition, and `Content-Security-Policy: default-src 'none'; sandbox`. That
 * is four independent mechanisms saying the same thing, and the reason for the
 * redundancy is that this is the one endpoint on the account origin that returns
 * authored HTML. If a browser were persuaded past the media type, past `nosniff`
 * and past the disposition, `sandbox` still lands the result in an opaque origin
 * with scripting disabled - so it cannot read the session cookie it was sent
 * with, and cannot call the API that just served it.
 *
 * The bytes themselves are `encodeArtifactBytes(record.html)`, which is the
 * exact inverse of the decode AHU-004 committed, byte-order mark included. An
 * owner's download hashes to the digest they approved; anything else would make
 * the digest in the metadata a number about a different document.
 */

import { getStore } from "@netlify/blobs";

import { SessionRequiredError } from "../lib/auth-errors.mjs";
import { openAuthStore } from "../lib/auth-store.mjs";
import { HostedContractError, encodeArtifactBytes } from "../lib/contracts.mjs";
import { identifyHosted } from "../lib/identity.mjs";
import { publicationDependencies, readOwnedPublication } from "../lib/publications.mjs";
import {
  CONTENT_DISPOSITION,
  CONTENT_PATTERN,
  DOCUMENT_CONTENT_PATH,
  DOCUMENT_METADATA_PATH,
  METADATA_PATTERN,
  PRIVATE_HEADERS,
  RAW_CONTENT_CSP,
  documentIdFrom,
  documentMetadataOf,
  notFound,
} from "../lib/documents.mjs";
import { errorResponse, jsonResponse } from "../lib/publications-http.mjs";

export const config = { path: [DOCUMENT_METADATA_PATH, DOCUMENT_CONTENT_PATH] };

/** The allowed methods. C4 requires HEAD to authorise exactly as GET does. */
const ALLOW = "GET, HEAD";

/**
 * Drop the body of a response, keeping every header and the status.
 *
 * Applied at the end rather than branched on at the start, so a `HEAD` runs the
 * identical authorisation and produces the identical headers - including
 * `Content-Length`, which is the one thing a `HEAD` is actually asked for. A
 * `HEAD` path that returned early would be a second, unauthorised route to the
 * same address.
 */
function withoutBody(response) {
  return new Response(null, { status: response.status, headers: response.headers });
}

/** The owner's record for this request, or a typed refusal. */
async function readForRequest(request, { store, publications, pattern }) {
  const documentId = documentIdFrom(new URL(request.url).pathname, pattern);

  /* `identifyHosted` throws `AuthUnavailableError` on a store outage, which
     `errorResponse` renders as a retryable 503. It is deliberately not caught
     here: an outage that read as "signed out" would tell an owner to sign in
     again, and an outage that read as "not found" would tell them their document
     is gone. */
  const principal = await identifyHosted(request, { store });
  if (principal === null) {
    throw new SessionRequiredError("sign in to read this document");
  }

  /* Every refusal this can throw is already `not_found`. It is re-wrapped rather
     than re-thrown so that a future adapter change which started distinguishing
     "not complete" from "not yours" could not leak that distinction through this
     route without someone editing this line. */
  try {
    return await readOwnedPublication({ publicationId: documentId, principal }, publications);
  } catch (error) {
    if (error instanceof HostedContractError && error.code === "unavailable") throw error;
    throw notFound();
  }
}

/** The two routes, over injected dependencies. */
export function createDocumentReadRoutes({ store, publications }) {
  return async function documentRead(request) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const refusal = new HostedContractError("invalid_request", `only ${ALLOW} are supported`, {
          field: "method",
        });
        return jsonResponse(405, refusal.toWire(), { ...PRIVATE_HEADERS, Allow: ALLOW });
      }

      const { pathname } = new URL(request.url);
      const content = CONTENT_PATTERN.test(pathname);
      if (!content && !METADATA_PATTERN.test(pathname)) throw notFound();

      const record = await readForRequest(request, {
        store,
        publications,
        pattern: content ? CONTENT_PATTERN : METADATA_PATTERN,
      });

      const response = content ? rawContentResponse(record) : metadataResponse(record);
      return request.method === "HEAD" ? withoutBody(response) : response;
    } catch (error) {
      const response = errorResponse(error);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
      const rebuilt = new Response(response.body, { status: response.status, headers });
      return request.method === "HEAD" ? withoutBody(rebuilt) : rebuilt;
    }
  };
}

/** The C4 metadata body: seven fields, and no part of the stored envelope. */
function metadataResponse(record) {
  return jsonResponse(200, documentMetadataOf(record), PRIVATE_HEADERS);
}

/** The stored bytes, exactly, as something a browser will not execute. */
function rawContentResponse(record) {
  const bytes = encodeArtifactBytes(record.html);
  return new Response(bytes, {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": CONTENT_DISPOSITION,
      "Content-Length": String(bytes.byteLength),
      "Content-Security-Policy": RAW_CONTENT_CSP,
    },
  });
}

/** The Netlify entry point: the same routes, wired to the real provider. */
export default async function documentRead(request) {
  try {
    return await createDocumentReadRoutes({
      store: openAuthStore(),
      publications: publicationDependencies({ env: process.env, getStore }),
    })(request);
  } catch (error) {
    return errorResponse(error);
  }
}
