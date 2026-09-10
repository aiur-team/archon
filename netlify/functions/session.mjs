import { identify } from "../lib/identity.mjs";
import {
  assertIdentitySub, capabilitiesFor, resolveRole, validateAccessRow,
} from "../lib/access.mjs";
import { StoreError } from "../lib/store.mjs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const IDENTITY_KEYS = Object.freeze(["sub", "email", "emailVerified", "name"]);
const DOC_ID_PATTERN = /^[0-9a-f]{6}$/;

function ownDataDescriptor(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true) {
    return null;
  }
  return descriptor;
}

function isExactPlainDataObject(value, keys, requireMutable) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0) {
    return false;
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== keys.length || !keys.every((key, index) => names[index] === key)) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = ownDataDescriptor(value, key);
    return descriptor !== null && (!requireMutable ||
      (descriptor.writable === true && descriptor.configurable === true));
  });
}

function validateIdentity(value) {
  if (!isExactPlainDataObject(value, IDENTITY_KEYS, true)) {
    throw new TypeError("Invalid identity");
  }
  const sub = ownDataDescriptor(value, "sub").value;
  const email = ownDataDescriptor(value, "email").value;
  const emailVerified = ownDataDescriptor(value, "emailVerified").value;
  const name = ownDataDescriptor(value, "name").value;
  /* The cross-check that used to sit here re-derived `isOrg` from the address
     with `isOrgEmail(email)` and refused an identity whose two fields
     disagreed. There is nothing to re-derive now: `emailVerified` is the
     provider's claim, carried through the session record, and this tree has no
     independent way to compute it. What remains is the shape. */
  if (typeof sub !== "string" || typeof email !== "string" ||
      typeof emailVerified !== "boolean" || typeof name !== "string" ||
      assertIdentitySub(sub) !== sub) {
    throw new TypeError("Invalid identity");
  }
  return value;
}

/** The shared check, mapped onto this handler's blanket 500. */
function validateAccess(value) {
  if (!validateAccessRow(value, capabilitiesFor)) {
    throw new TypeError("Invalid access result");
  }
  return value;
}

function isUnavailable(error) {
  try {
    if (!(error instanceof StoreError)) return false;
    const name = ownDataDescriptor(error, "name");
    const code = ownDataDescriptor(error, "code");
    const status = ownDataDescriptor(error, "status");
    return name !== null && code !== null && status !== null &&
      name.value === "StoreError" && code.value === "unavailable" && status.value === 503;
  } catch {
    return false;
  }
}

function emptyResponse(status, headers = NO_STORE) {
  return new Response(null, { status, headers });
}

/**
 * The route, over its two seams.
 *
 * Both default to the production import and neither is selectable by request
 * data, so this is a test seam rather than a bypass: the code path a test drives
 * is the one that runs, and only the identity and the store differ. It exists
 * because `identify()` reaches the hosted session store, and the two answers
 * this route must tell apart — "nobody is signed in" and "the store could not
 * be read" — are only distinguishable if a test can make the second one happen.
 *
 * @param {{identifyFn?: Function, resolveRoleFn?: Function}} [dependencies]
 * @returns {(req: Request) => Promise<Response>}
 */
export function createSessionHandler({ identifyFn = identify, resolveRoleFn = resolveRole } = {}) {
  return async function sessionRoute(req) {
    return handle(req, identifyFn, resolveRoleFn);
  };
}

async function handle(req, identifyFn, resolveRoleFn) {
  if (req.method !== "GET") {
    return emptyResponse(405, { Allow: "GET", ...NO_STORE });
  }
  try {
    const identified = await identifyFn(req);
    if (identified === null) return emptyResponse(401);
    const user = validateIdentity(identified);
    const documents = new URL(req.url).searchParams.getAll("doc");
    if (documents.length !== 1 || !DOC_ID_PATTERN.test(documents[0])) {
      return emptyResponse(400);
    }
    const docId = documents[0];
    const access = validateAccess(await resolveRoleFn(docId, user, { consumeInvitation: true }));
    const body = {
      sub: user.sub,
      email: user.email,
      name: user.name,
      canComment: access.canComment,
      canEdit: access.canEdit,
      doc: docId,
      role: access.role,
      shared: access.shared,
      canSuggest: access.canSuggest,
      canAccept: access.canAccept,
      canShare: access.canShare,
      canSeeMembers: access.canSeeMembers,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE },
    });
  } catch (error) {
    /* The one distinction this handler owes the rest of the design: a store
       outage is a retryable 503 and a bug is a 500. `identify()` translates the
       hosted tree's `AuthUnavailableError` into this same `StoreError` shape,
       so both the identity read and the access read land here spelled alike. */
    return emptyResponse(isUnavailable(error) ? 503 : 500);
  }
}

export default createSessionHandler();

export const config = { path: "/api/session" };
