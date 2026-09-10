/**
 * The four cryptographic primitives the hosted auth tree is built from.
 *
 * They live in one module rather than beside their callers because every one of
 * them is a place where a plausible, ordinary-looking mistake is silently fatal:
 * a token minted from `Math.random`, a lookup key that is the token itself, a
 * comparison that returns early on the first differing byte. Collecting them
 * here means each rule is written once, reviewed once, and tested once.
 *
 * Two properties are worth stating out loud, because they are what the rest of
 * the tree assumes:
 *
 *  - **A secret is never a storage key.** Everything stored is keyed by
 *    `hashToken()` of the secret the browser holds. A dump of the store - a
 *    backup, a support export, an operator's console - therefore yields no
 *    usable credential, because SHA-256 is one-way and the preimage is 256 bits
 *    of entropy rather than a guessable string.
 *  - **Comparisons do not leak length.** `constantTimeEqual` digests both sides
 *    to a fixed 32 bytes before comparing, so it can be handed strings of
 *    different lengths - which `crypto.timingSafeEqual` refuses outright - and
 *    reveals neither how long the expected value is nor where the first
 *    difference lies.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The entropy behind every opaque token this service mints.
 *
 * C1 fixes the browser session at 256 bits and there is no reason for the
 * transient tokens to be weaker: they are all single-use lookup keys with the
 * same "guessing one is game over" property, and 32 bytes is not expensive.
 */
export const TOKEN_BYTES = 32;

/** The one encoding tokens are rendered in: base64url, unpadded. */
function base64url(buffer) {
  return buffer.toString("base64url");
}

/**
 * A fresh opaque token: 256 bits from the CSPRNG, base64url.
 *
 * 43 characters, which sits inside the 32-256 window `contracts.mjs` enforces
 * for an opaque token on the wire, and carries no character that could smuggle
 * a delimiter into a `Set-Cookie` header, a URL or a log line.
 */
export function randomToken() {
  return base64url(randomBytes(TOKEN_BYTES));
}

/**
 * The storage key for a token: its SHA-256 digest, lowercase hex.
 *
 * Hex rather than base64url because a key ends up in a blob path, and a
 * single-case alphabet with no `-` or `_` is the spelling least likely to
 * collide with a store's own key grammar.
 */
export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

/** SHA-256 of `text`, base64url - the spelling PKCE and the CSRF derivation use. */
export function sha256Base64Url(text) {
  return base64url(createHash("sha256").update(String(text), "utf8").digest());
}

/**
 * Whether two secrets are equal, in time that does not depend on how they
 * differ.
 *
 * Both sides are digested first. That is not belt-and-braces: `timingSafeEqual`
 * throws on a length mismatch, so a caller comparing a 43-character expected
 * value against attacker-supplied input would have to branch on length before
 * calling it - and that branch is itself the length oracle the function exists
 * to remove. Digesting makes both sides 32 bytes whatever arrived, so the
 * comparison is total and the only thing observable is "equal or not".
 *
 * A non-string is `false` rather than a throw, because the inputs are request
 * data and an absent header is the commonest way to reach here.
 */
export function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}
