/**
 * The opaque cookie that says *which* pending publication this browser is
 * approving, and nothing else.
 *
 * ## What this module is, and what it deliberately is not
 *
 * AHU-003 already owns the transport: `createPendingBinding`,
 * `readPendingBinding` and `clearPendingBinding` in `identity.mjs` mint a random
 * `__Host-archon_publish` cookie, keep the payload server-side under the
 * fifteen-minute transient window, preserve it across an account switch and
 * revoke both halves on release. None of that is re-implemented here. A second
 * cookie mechanism beside that one would be a second thing to expire, a second
 * thing to revoke on logout, and a second place for the two to disagree about
 * whether a visitor is still mid-approval.
 *
 * What is left is exactly one question AHU-003 declined to answer, on purpose:
 * what the opaque `operation` string *means*. It means the server-internal
 * binding `bindPublication` returns - `{publicationId, browserSecretHash}` -
 * encoded as the two hex strings it already is.
 *
 * ## Why the binding is safe to hold in a store record
 *
 * Neither half is a capability. The id appears in the review URL the page is
 * about to fetch, and the hash is the digest already stored on the publication
 * record; possession of both proves nothing that reading the record would not.
 * What proves something is *how the browser got them*: the only writer is the
 * bind route, and the only way to reach that route is to present the browser
 * secret from the agent's link, whose preimage this service never stores and
 * this cookie never carries. So a leaked binding does not let anybody approve
 * anything - approval additionally needs the `__Host-` cookie itself, an
 * authenticated session, the exact configured `Origin` and a session-bound CSRF
 * token.
 *
 * The consequence worth stating plainly: the browser secret is exchanged once,
 * at bind time, and is never persisted, never echoed and never sent again. The
 * page removes it from the URL before anything else runs, and from that point on
 * the browser's proof of which operation it holds is a random cookie value.
 *
 * ## Why the encoding is a fixed-width concatenation
 *
 * Both halves are lower-hex of a fixed length, so `<32><64>` is unambiguous
 * without a separator, is 96 characters (inside C1's 32-256 opaque-token bound),
 * and is base64url-clean, which is what `serializeCookie` and AHU-003's
 * operation pattern require. JSON would have been the obvious alternative and is
 * worse here: it invites a decoder that accepts extra keys, and a binding is the
 * one value in this flow that must decode to exactly two fields or not at all.
 */

import { HostedContractError } from "./contracts.mjs";
import {
  clearPendingBinding,
  createPendingBinding,
  readPendingBinding,
} from "./identity.mjs";

/** Hex characters in a publication id. */
const ID_HEX = 32;

/** Hex characters in a stored SHA-256 secret digest. */
const HASH_HEX = 64;

/** The one shape a decoded operation may have. Anchored, lower-hex, exact. */
const OPERATION_PATTERN = new RegExp(`^[0-9a-f]{${ID_HEX + HASH_HEX}}$`);

/** The refusal a route gives a browser that is not mid-approval. */
function notBound() {
  return new HostedContractError(
    "approval_required",
    "this browser is not holding a pending publication",
    { field: "binding" },
  );
}

/**
 * The opaque operation string for a server-internal binding.
 *
 * @param {{publicationId: string, browserSecretHash: string}} binding as
 *   returned by `bindPublication`, and never assembled by hand from a client
 *   value.
 * @returns {string}
 */
export function encodeOperation(binding) {
  const operation = `${binding?.publicationId ?? ""}${binding?.browserSecretHash ?? ""}`;
  if (!OPERATION_PATTERN.test(operation)) {
    /* A `TypeError` rather than a contract error: reaching here means this
       service handed itself a binding it did not get from `bindPublication`,
       which is a programming fault and not something a caller did. */
    throw new TypeError("a browser binding encodes a publication id and a secret digest");
  }
  return operation;
}

/**
 * The binding an operation string encodes, or null when it encodes nothing.
 *
 * Null rather than a throw, because every caller's answer to a malformed
 * operation is the same as its answer to an absent one - and telling those two
 * apart is exactly the kind of distinction an attacker times.
 *
 * @returns {Readonly<{publicationId: string, browserSecretHash: string}> | null}
 */
export function decodeOperation(operation) {
  if (typeof operation !== "string" || !OPERATION_PATTERN.test(operation)) return null;
  return Object.freeze({
    publicationId: operation.slice(0, ID_HEX),
    browserSecretHash: operation.slice(ID_HEX),
  });
}

/**
 * Bind this browser to a verified publication and hand back the `Set-Cookie`.
 *
 * @param {object} store an `AuthStore`.
 * @param {{publicationId: string, browserSecretHash: string}} binding
 * @returns {Promise<Readonly<{setCookie: string, expiresAt: string}>>}
 */
export async function issueBrowserBinding(store, binding) {
  return createPendingBinding(store, { operation: encodeOperation(binding) });
}

/**
 * The binding this browser holds for `publicationId`, or a refusal.
 *
 * The path's id is checked against the bound one here rather than left to the
 * adapter. Both refuse, but they refuse differently: the adapter would report an
 * `invalid_capability` after a store read, which reads as "your secret is wrong"
 * for a browser whose secret was fine and whose *link* was for another
 * publication. That is also a second tab's normal state - one pending approval
 * per browser is what a single `__Host-` cookie can express - and telling that
 * visitor plainly that this browser is holding a different pending publication
 * is the only actionable thing to say.
 *
 * @returns {Promise<Readonly<{publicationId: string, browserSecretHash: string}>>}
 * @throws {HostedContractError} `approval_required`
 */
export async function requireBrowserBinding(store, request, publicationId) {
  const pending = await readPendingBinding(store, request);
  if (pending === null) throw notBound();
  const binding = decodeOperation(pending.operation);
  if (binding === null) throw notBound();
  if (binding.publicationId !== publicationId) throw notBound();
  return binding;
}

/**
 * Revoke the binding server-side and clear its cookie.
 *
 * Called once the operation has a terminal answer, which is the only moment C1
 * allows: a binding cleared any earlier would strand a visitor who had signed in
 * with the wrong account and was about to switch.
 *
 * @returns {Promise<Readonly<{cleared: boolean, setCookie: string}>>}
 */
export async function releaseBrowserBinding(store, request) {
  return clearPendingBinding(store, request);
}
