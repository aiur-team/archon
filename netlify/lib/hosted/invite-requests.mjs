/**
 * The invite-request form's abuse controls, and the message it produces.
 *
 * This is the only route in the hosted tree an anonymous stranger can make the
 * deployment send email from, so the interesting part is not the sending. Four
 * properties carry it, and each is here because the obvious version of this
 * feature does not have it:
 *
 *  1. **It is not an open relay.** The recipient is the configured operator
 *     address and nothing on the wire can change it; the requester's address is
 *     *content* of a message sent to the operator, never a `to`, never a
 *     `reply-to` header, never a `from`. A form that mailed the requester - even
 *     a "thanks, we got it" - would let anybody send mail from this deployment's
 *     domain to any address they can type, which is what a relay is.
 *  2. **It leaks no membership.** Nothing here reads the allowlist, the
 *     publication store or the session store, so there is no query whose timing
 *     or result could differ between a known address and an unknown one. The
 *     answer is one fixed body for every accepted submission.
 *  3. **It is rate limited, and the limit fails closed.** Both per source and in
 *     total, against a stored counter, so the limit survives the stateless
 *     function it runs in. A counter that cannot be read refuses the submission:
 *     a rate limiter that fails open is a rate limiter that an attacker only has
 *     to break once.
 *  4. **The message it sends is bounded and inert.** The requester's note is
 *     capped, stripped of control characters, and sent as `text/plain`. It
 *     arrives in a human's inbox, and an unbounded string that a stranger chose
 *     is the input that becomes a phishing mail wearing this deployment's name.
 *
 * ## Why the counter is one record with a window stamp
 *
 * The alternative - a key per time window - leaves a key behind for every hour
 * the form was ever used, and the provider has no expiry and no conditional
 * delete, so nothing would ever remove them. One record that records which
 * window it counts, and resets itself when the window rolls over, has a bounded
 * footprint of exactly one key forever.
 */

import { HostedContractError } from "./contracts.mjs";
import { normalizeEmailOrNull } from "./email.mjs";
import { createRecordStore } from "./record-store.mjs";
import { sha256Base64Url } from "./secrets.mjs";

/** The store key the counter lives at. One key, forever. */
export const INVITE_RATE_KEY = "access/invite-rate";

/** The schema version. A record carrying any other is one this version refuses. */
export const INVITE_RATE_SCHEMA_VERSION = 1;

/**
 * The bounds on the form.
 *
 * The per-source limit is the one a person notices and is set where a genuine
 * retry - a typo in the address, a second thought about the message - still
 * works. The window total is the one that matters under abuse: it bounds what
 * this deployment can be made to send in an hour no matter how many sources the
 * requests appear to come from, which is the only limit that survives an
 * attacker who can vary their address.
 */
export const INVITE_LIMITS = Object.freeze({
  /** Submissions one source may make in one window. */
  MAX_PER_SOURCE: 3,
  /** Submissions this deployment will send in one window, from all sources. */
  MAX_PER_WINDOW: 60,
  /**
   * Distinct sources one window's record may track. Reaching it refuses further
   * submissions rather than evicting: an eviction policy is a way to get a fresh
   * per-source budget by making enough requests from enough addresses.
   */
  MAX_SOURCES: 500,
  /** The requester's note, in Unicode scalar values. */
  MESSAGE_MAX_SCALARS: 1000,
  /** One hour, in milliseconds. The window everything above is counted per. */
  WINDOW_MS: 60 * 60 * 1000,
});

/** Domain separation for the source digest, so it has one meaning. */
const SOURCE_CONTEXT = "archon-invite-source-v1:";

function invalid(message, field) {
  return new HostedContractError("invalid_request", message, { field });
}

/** The window an instant falls in, as a stable stamp. */
export function windowOf(at) {
  return String(Math.floor(at.getTime() / INVITE_LIMITS.WINDOW_MS));
}

/**
 * The counter record, validated, or a typed refusal.
 *
 * A record this version cannot interpret is not coerced into an empty counter.
 * The caller turns the refusal into an outage, which refuses the submission -
 * the fail-closed direction, and the only one that does not make "corrupt the
 * counter" a way to lift the limit.
 */
export function validateRateRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("the rate record must be an object", "rate");
  }
  if (value.v !== INVITE_RATE_SCHEMA_VERSION) {
    throw invalid("the rate record carries an unknown schema version", "rate.v");
  }
  if (typeof value.window !== "string" || !/^\d{1,15}$/.test(value.window)) {
    throw invalid("the rate record must carry a window stamp", "rate.window");
  }
  if (value.counts === null || typeof value.counts !== "object" || Array.isArray(value.counts)) {
    throw invalid("the rate record must carry a counts object", "rate.counts");
  }
  const counts = {};
  let total = 0;
  for (const [source, count] of Object.entries(value.counts)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(source)) {
      throw invalid("the rate record holds an unusable source key", "rate.counts");
    }
    if (!Number.isInteger(count) || count < 0 || count > Number.MAX_SAFE_INTEGER) {
      throw invalid("the rate record holds an unusable count", "rate.counts");
    }
    counts[source] = count;
    total += count;
  }
  if (Object.keys(counts).length > INVITE_LIMITS.MAX_SOURCES) {
    throw invalid("the rate record tracks more sources than one window may", "rate.counts");
  }
  /* The total is recomputed rather than read. A stored total that disagreed with
     the counts it sums would be the field an attacker wants to write, and
     deriving it means there is nothing to disagree with. */
  return Object.freeze({ v: INVITE_RATE_SCHEMA_VERSION, window: value.window, counts, total });
}

/** The rate-counter store, over an injected provider. */
export function createInviteRateStore({ getStore, name } = {}) {
  return createRecordStore({
    getStore,
    name,
    key: INVITE_RATE_KEY,
    label: "invite rate",
    validate: validateRateRecord,
  });
}

/**
 * The opaque per-source bucket key for a request.
 *
 * A digest, so the stored record holds no IP address: this counter is a
 * spam-control mechanism and has no business being a log of who visited the
 * splash page. `x-nf-client-connection-ip` is the platform's own statement of
 * the connecting address and is the only spelling trusted; `x-forwarded-for` is
 * a request header a client can set, so it is not read at all.
 *
 * A request with no platform header - a local run, a future platform change -
 * falls into one shared `unknown` bucket rather than escaping the limit. That
 * makes the per-source limit strict for everyone in that case, which is the
 * fail-closed direction and is exactly what a `null` source should cost.
 */
export function sourceKeyOf(request) {
  const ip = request.headers.get("x-nf-client-connection-ip");
  if (typeof ip !== "string" || ip === "" || ip.length > 64) return "unknown";
  return sha256Base64Url(`${SOURCE_CONTEXT}${ip}`).slice(0, 32);
}

/**
 * The requester's note: optional, bounded, and stripped of control characters.
 *
 * Counted in Unicode scalar values rather than UTF-16 units, matching how every
 * other display bound in this deployment is counted, so an emoji costs one
 * character rather than two. Control characters go because this string is
 * interpolated into a plain-text mail body: a bare carriage return or an escape
 * sequence there is how a message gets a forged header line or a terminal that
 * renders something other than what arrived.
 */
export function normalizeMessage(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw invalid("message must be text", "message");
  const scalars = [...value];
  if (scalars.length > INVITE_LIMITS.MESSAGE_MAX_SCALARS) {
    throw invalid(
      `message must be at most ${INVITE_LIMITS.MESSAGE_MAX_SCALARS} characters`,
      "message",
    );
  }
  /* Newlines and tabs survive because a note is prose somebody typed into a
     textarea; everything else in the C0 and C1 ranges, plus the Unicode
     direction overrides, does not. */
  return scalars
    .filter((c) => {
      const code = c.codePointAt(0);
      if (c === "\n" || c === "\t") return true;
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
      return !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069);
    })
    .join("")
    .trim();
}

/** The requester's address, normalised, or a typed refusal. */
export function normalizeRequesterEmail(value) {
  const email = normalizeEmailOrNull(value);
  /* The message says what is wrong with the value and nothing about whether the
     address is known here. It is the same answer for an address that has an
     account and one that does not, because this function never looks. */
  if (email === null) throw invalid("email must be an email address", "email");
  return email;
}

/**
 * Claim one submission against the window's budget.
 *
 * The claim happens **before** the mail is sent, and it is not released if the
 * send fails. That is deliberate: a budget that is refunded on failure lets an
 * attacker who can make sends fail - by any means at all - spend an unlimited
 * number of attempts at the provider. A genuine requester who hits a provider
 * outage loses one of three attempts in an hour, which is the cheaper mistake.
 *
 * @returns {Promise<{claimed: true}>}
 * @throws {HostedContractError} `rate_limited` (429), or `unavailable` when the
 *   counter could not be read or written - the fail-closed direction.
 */
export async function claimInviteSubmission({ source, now = () => new Date() }, { store }) {
  const window = windowOf(now());

  await store.mutate((current) => {
    /* A record from an earlier window is not merged, it is replaced. The window
       stamp is what makes the reset happen without anything having to sweep. */
    const counts = current !== null && current.window === window ? { ...current.counts } : {};
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);

    if (total >= INVITE_LIMITS.MAX_PER_WINDOW) throw rateLimited();
    if ((counts[source] ?? 0) >= INVITE_LIMITS.MAX_PER_SOURCE) throw rateLimited();
    if (counts[source] === undefined && Object.keys(counts).length >= INVITE_LIMITS.MAX_SOURCES) {
      throw rateLimited();
    }

    counts[source] = (counts[source] ?? 0) + 1;
    return { v: INVITE_RATE_SCHEMA_VERSION, window, counts };
  });
  return { claimed: true };
}

/**
 * The refusal a rate-limited submission gets.
 *
 * One message for every way the budget can be exhausted - the requester's own
 * three, the window's sixty, and the source table being full. A visitor cannot
 * act on the difference, and telling them which limit they hit tells an attacker
 * whether anybody else is using the form.
 */
function rateLimited() {
  return new HostedContractError(
    "rate_limited",
    "too many invite requests just now; please try again later",
    { field: "email" },
  );
}

/**
 * The message an operator receives.
 *
 * Plain text, and assembled so the requester's own strings can never be mistaken
 * for the deployment's: both are on their own lines under labels, and the note
 * is last so a note containing something that looks like a label cannot appear
 * to precede a field that follows it.
 */
export function inviteMessage({ email, message, at }) {
  const lines = [
    "Someone asked for an invite to Archon.",
    "",
    `Email: ${email}`,
    `Received: ${at.toISOString()}`,
    "",
    message === "" ? "(no message)" : "Message:",
  ];
  if (message !== "") lines.push(message);
  return `${lines.join("\n")}\n`;
}

/** The subject line. Fixed: a subject built from input is a spam vector. */
export const INVITE_SUBJECT = "Archon: invite request";
