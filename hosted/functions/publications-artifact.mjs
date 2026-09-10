/**
 * `PUT /api/hosted/publications/<id>/artifact` - commit the approved bytes.
 *
 * This is the only hosted route that turns an authorisation into a document, and
 * almost none of that decision is made here. `publications.mjs` owns the state
 * machine, the owner binding, the deadline and the compare-and-set;
 * `artifact-body.mjs` owns the bytes. What is left - and what this file is - is
 * the order those two are consulted in.
 *
 * That order matters for one reason: the body is up to 2 MiB and takes real time
 * to arrive. So the bearer is authenticated and the state is inspected *before*
 * a byte is read, which is what stops an unapproved, denied, cancelled or
 * expired publication from being a free upload endpoint. The preflight is
 * advisory, though, not authoritative: by the time the last chunk lands the
 * answer may have changed, and `completePublication` re-checks state, owner,
 * digest and deadline on every attempt it makes. The preflight can only ever
 * make this route refuse *earlier*, never accept something completion would
 * have refused.
 *
 * The completed-record case is deliberately not short-circuited. C3 says an
 * identical retry gets HTTP 200 and the same receipt - but "identical" is a
 * claim about bytes, so the body is still read and still validated, and a retry
 * carrying different bytes is a 409 rather than a success. A publication that
 * has already completed is also the one case that survives publishing being
 * switched off: an operator disabling new publications must not strand the
 * receipt for a document that already exists.
 */

import { getStore } from "@netlify/blobs";

import { HostedContractError } from "../lib/contracts.mjs";
import { readArtifactBody } from "../lib/artifact-body.mjs";
import {
  completePublication,
  publicationDependencies,
  statusPublication,
} from "../lib/publications.mjs";
import {
  agentSecretFrom,
  browserHeadersRejection,
  errorResponse,
  jsonResponse,
  methodRejection,
  publicationIdFrom,
} from "../lib/publications-http.mjs";

/**
 * Reject a state that cannot accept an upload, in C3's vocabulary.
 *
 * The messages match the ones `completePublication` raises for the same states,
 * because a caller that loses the race between this check and the write should
 * not be able to tell which of the two answered it.
 */
function stateRejection(state) {
  if (state === "approved" || state === "complete") return null;
  if (state === "pending") {
    return new HostedContractError("approval_required", "this publication has not been approved yet", {
      field: "state",
    });
  }
  if (state === "expired") {
    return new HostedContractError(
      "authorization_expired",
      "the upload window for this publication has closed",
      { field: "state" },
    );
  }
  return new HostedContractError("state_conflict", `publication is ${state}`, { field: "state" });
}

/**
 * How many times the post-commit envelope read is attempted.
 *
 * Two, not one, and not a general retry policy: this read happens *after* the
 * document is durably stored, so a single transient provider fault would
 * otherwise turn a committed upload into a reported failure. Two, not more,
 * because the caller's own retry is the real recovery path - it answers 200 with
 * the same receipt - and a handler that kept trying would only spend the
 * caller's request budget getting there.
 */
const ENVELOPE_READ_ATTEMPTS = 2;

/**
 * The status envelope for a publication that has just committed.
 *
 * Only a storage fault is retried. A contract answer - a receipt that expired
 * between the write and the read, say - is the record's own verdict and repeats
 * identically, so retrying one would just read twice to print the same thing.
 */
async function envelopeAfterCommit(capability, dependencies) {
  let lastError = null;
  for (let attempt = 0; attempt < ENVELOPE_READ_ATTEMPTS; attempt += 1) {
    try {
      return await statusPublication(capability, dependencies);
    } catch (error) {
      if (!(error instanceof HostedContractError) || error.code !== "unavailable") throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * The route's whole behaviour, with its dependency set resolved lazily.
 *
 * Split out from the default export so a test drives the real handler against an
 * injected store and clock rather than against a mock of it, and so that reading
 * operator configuration happens inside the `try` - a deploy missing a C6 key
 * answers 503 with no detail instead of throwing out of the function runtime.
 * The transport rejections come first, so a wrong method on a misconfigured
 * deploy is still reported as a wrong method.
 */
export async function handleArtifact(request, resolveDependencies) {
  try {
    const wrongMethod = methodRejection(request, "PUT");
    if (wrongMethod !== null) return wrongMethod;
    const browser = browserHeadersRejection(request);
    if (browser !== null) return browser;

    const publicationId = publicationIdFrom(request, "artifact");
    const agentSecret = agentSecretFrom(request);
    const dependencies = resolveDependencies();

    /* The preflight authenticates the bearer and reports the state without
       touching storage for a write and without exposing a private field: the
       status envelope is the same projection the poll route returns. */
    const preflight = await statusPublication({ publicationId, agentSecret }, dependencies);
    const rejected = stateRejection(preflight.state);
    if (rejected !== null) return errorResponse(rejected);

    /* Recovery of an existing receipt is not a new publication, so it is the one
       path a disabled deployment still serves. A new completion is not.

       Like the state gate above, this is advisory: `completePublication` checks
       the same flag from below its own already-complete branch, so removing this
       block would change when the 503 arrives and nothing about which requests
       get one. It is here so a disabled deployment does not spend 2 MiB finding
       out. */
    if (preflight.state !== "complete" && dependencies.publishEnabled !== true) {
      return errorResponse(
        new HostedContractError(
          "publishing_disabled",
          "hosted publishing is disabled on this deployment",
        ),
      );
    }

    const { html, contentSha256, contentBytes } = await readArtifactBody(request);
    const { created } = await completePublication(
      { publicationId, agentSecret, html, contentSha256, contentBytes },
      dependencies,
    );

    /* C3 asks for the status shape, and the receipt deadline that shape carries
       is only known to the record - so the envelope is re-read rather than
       assembled here from a `result` and a guess. It is one strongly consistent
       read of a record that has just committed, and it keeps this route from
       owning a second opinion about what a complete publication looks like. The
       document exists by this point, so the read is the one place in the handler
       that retries: see `envelopeAfterCommit`. */
    const envelope = await envelopeAfterCommit({ publicationId, agentSecret }, dependencies);
    return jsonResponse(created ? 201 : 200, envelope);
  } catch (error) {
    return errorResponse(error);
  }
}

/** The Netlify entry point: the same handler, wired to the real provider. */
export default (request) =>
  handleArtifact(request, () => publicationDependencies({ env: process.env, getStore }));

export const config = { path: "/api/hosted/publications/:publicationId/artifact" };
