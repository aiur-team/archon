/**
 * The invite-request form: its mail configuration, its abuse controls and the
 * route that ties them together.
 *
 * Every send goes through the real request-building code against an injected
 * `fetch` double, so what is verified is the headers, the body and how a
 * provider failure is reported. No account is registered, no key is present and
 * nothing leaves this process.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INVITE_LIMITS,
  INVITE_RATE_KEY,
  claimInviteSubmission,
  createInviteRateStore,
  inviteMessage,
  normalizeMessage,
  normalizeRequesterEmail,
  sourceKeyOf,
  validateRateRecord,
  windowOf,
} from "../../lib/hosted/invite-requests.mjs";
import {
  MailerConfigError,
  MailerSendError,
  RESEND_ENDPOINT,
  readMailerConfig,
  sendMail,
} from "../../lib/hosted/mailer.mjs";
import { readHostedConfig } from "../../lib/hosted/config.mjs";
import { HostedContractError } from "../../lib/hosted/contracts.mjs";
import { createInviteRequestRoute } from "../../functions/hosted-invite-request.mjs";
import { APP_ORIGIN, HOSTED_ENV, browserRequest } from "./fixtures/auth.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";

const MAIL_ENV = Object.freeze({
  ARCHON_EMAIL_PROVIDER: "resend",
  ARCHON_EMAIL_API_KEY: "fixture-email-api-key-value",
  ARCHON_EMAIL_SENDER: "archon@example.com",
  ARCHON_EMAIL_RECIPIENT: "its.everdred@gmail.com",
});

const AT = new Date("2026-09-10T12:00:00.000Z");

/** The error a call throws, which `assert.throws` does not hand back. */
function thrown(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

/* --- the mail configuration ----------------------------------------------- */

test("no ARCHON_EMAIL_* key at all means the feature is simply not configured", () => {
  /* A deployment that has not set up email must serve every other hosted request
     normally, which is why these four keys are not part of `readHostedConfig`. */
  assert.equal(readMailerConfig({}), null);
});

test("a partial configuration is a fault, not a silent 'not enabled'", () => {
  /* This is the state an operator reaches while setting it up, and the failure
     they need to see is "you have not set the sender" rather than a form that
     keeps accepting submissions and mailing nobody. */
  const { ARCHON_EMAIL_SENDER, ...partial } = MAIL_ENV;
  const error = thrown(() => readMailerConfig(partial));
  assert.ok(error instanceof MailerConfigError);
  assert.equal(error.key, "ARCHON_EMAIL_SENDER");
});

test("the provider is named exactly, so no request URL is ever configurable", () => {
  /* A configurable endpoint on a route an anonymous visitor can reach is a
     server-side request forgery primitive behind a name that reads like a
     setting. */
  const error = thrown(() =>
    readMailerConfig({ ...MAIL_ENV, ARCHON_EMAIL_PROVIDER: "https://evil.example" }),
  );
  assert.equal(error.key, "ARCHON_EMAIL_PROVIDER");
  assert.match(RESEND_ENDPOINT, /^https:\/\/api\.resend\.com\//);
});

test("both addresses go through the deployment's one address grammar", () => {
  for (const key of ["ARCHON_EMAIL_SENDER", "ARCHON_EMAIL_RECIPIENT"]) {
    const error = thrown(() => readMailerConfig({ ...MAIL_ENV, [key]: "not-an-address" }));
    assert.equal(error.key, key);
  }
  const mailer = readMailerConfig({ ...MAIL_ENV, ARCHON_EMAIL_SENDER: "Archon@Example.COM" });
  assert.equal(mailer.sender, "archon@example.com");
});

test("the API key cannot be rendered by anything that walks properties", () => {
  const mailer = readMailerConfig(MAIL_ENV);
  const key = MAIL_ENV.ARCHON_EMAIL_API_KEY;
  assert.equal(mailer.readApiKey(), key, "the one call that reads it says so out loud");
  for (const rendering of [
    JSON.stringify(mailer),
    String(mailer),
    `${mailer}`,
    JSON.stringify({ ...mailer }),
    Object.keys(mailer).join(","),
  ]) {
    assert.ok(!rendering.includes(key), "the key is not reachable as a property");
  }
});

test("a send carries the key as a bearer token and the operator as the only recipient", async () => {
  const mailer = readMailerConfig(MAIL_ENV);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  await sendMail({ mailer, subject: "s", text: "t" }, { fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RESEND_ENDPOINT);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${MAIL_ENV.ARCHON_EMAIL_API_KEY}`);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.to, [MAIL_ENV.ARCHON_EMAIL_RECIPIENT]);
  assert.equal(body.from, MAIL_ENV.ARCHON_EMAIL_SENDER);
});

test("a provider refusal is an outage that carries none of its answer", async () => {
  const mailer = readMailerConfig(MAIL_ENV);
  const leaked = "sk-live-fixture-leak";
  const refused = async () =>
    new Response(JSON.stringify({ detail: leaked }), { status: 422 });
  const error = await sendMail({ mailer, subject: "s", text: "t" }, { fetchImpl: refused }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof MailerSendError);
  assert.ok(!error.message.includes(leaked), "the provider's body is discarded");

  const thrower = async () => {
    throw new TypeError("network");
  };
  await assert.rejects(
    () => sendMail({ mailer, subject: "s", text: "t" }, { fetchImpl: thrower }),
    MailerSendError,
  );
});

/* --- the message ---------------------------------------------------------- */

test("a note is bounded and stripped of control characters", () => {
  assert.equal(normalizeMessage(undefined), "");
  assert.equal(normalizeMessage("  hello\nthere  "), "hello\nthere");
  /* A bare carriage return in a plain-text mail body is how a message gets a
     forged header line; the right-to-left override, spelled here as an escape,
     is how it renders as something other than what arrived. */
  assert.equal(normalizeMessage("a\rbc‮d"), "abcd");
  assert.throws(
    () => normalizeMessage("x".repeat(INVITE_LIMITS.MESSAGE_MAX_SCALARS + 1)),
    HostedContractError,
  );
  assert.throws(() => normalizeMessage(42), HostedContractError);
});

test("the requester's address is validated and says nothing about who is known", () => {
  assert.equal(normalizeRequesterEmail(" Someone@Example.COM "), "someone@example.com");
  const error = thrown(() => normalizeRequesterEmail("not-an-address"));
  assert.ok(error instanceof HostedContractError);
  assert.equal(error.code, "invalid_request");
});

test("the operator's message labels every field and puts the note last", () => {
  /* A note containing something that looks like a label cannot appear to precede
     a field that follows it, because no field follows it. */
  const text = inviteMessage({
    email: "someone@example.com",
    message: "Email: forged@evil.example",
    at: AT,
  });
  assert.match(text, /^Someone asked for an invite/);
  assert.match(text, /\nEmail: someone@example\.com\n/);
  assert.ok(text.indexOf("Message:") < text.indexOf("forged@evil.example"), "the note is last");
});

/* --- the rate limit ------------------------------------------------------- */

function rateHarness() {
  const provider = createProviderDouble();
  return { provider, store: createInviteRateStore({ getStore: provider.getStore }) };
}

test("a source is a digest, so the counter is not a log of who visited", () => {
  const request = new Request("https://app.example.com/", {
    headers: { "x-nf-client-connection-ip": "203.0.113.7" },
  });
  const key = sourceKeyOf(request);
  assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!key.includes("203.0.113"), "the address itself is not the key");
});

test("a client-settable forwarding header is not read at all", () => {
  /* `x-forwarded-for` is a request header a client can set, so trusting it would
     be a per-source budget anybody can reset by typing a new value. */
  const forged = new Request("https://app.example.com/", {
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(sourceKeyOf(forged), "unknown");
});

test("a source the platform did not name shares one strict bucket", async () => {
  const { store } = rateHarness();
  const now = () => AT;
  for (let i = 0; i < INVITE_LIMITS.MAX_PER_SOURCE; i += 1) {
    await claimInviteSubmission({ source: "unknown", now }, { store });
  }
  await assert.rejects(
    () => claimInviteSubmission({ source: "unknown", now }, { store }),
    (error) => error instanceof HostedContractError && error.code === "rate_limited",
  );
});

test("the per-source budget is spent, and another source still has its own", async () => {
  const { store } = rateHarness();
  const now = () => AT;
  for (let i = 0; i < INVITE_LIMITS.MAX_PER_SOURCE; i += 1) {
    await claimInviteSubmission({ source: "aaa", now }, { store });
  }
  await assert.rejects(
    () => claimInviteSubmission({ source: "aaa", now }, { store }),
    HostedContractError,
  );
  await claimInviteSubmission({ source: "bbb", now }, { store });
});

test("the window total bounds what the deployment sends however many sources appear", async () => {
  /* The limit that survives an attacker who can vary their apparent source, and
     therefore the only one that actually bounds the provider bill. */
  const { store } = rateHarness();
  const now = () => AT;
  for (let i = 0; i < INVITE_LIMITS.MAX_PER_WINDOW; i += 1) {
    await claimInviteSubmission({ source: `s${i}`, now }, { store });
  }
  await assert.rejects(
    () => claimInviteSubmission({ source: "fresh", now }, { store }),
    (error) => error instanceof HostedContractError && error.code === "rate_limited",
  );
});

test("the counter resets when the window rolls over, and keeps one key forever", async () => {
  const { provider, store } = rateHarness();
  for (let i = 0; i < INVITE_LIMITS.MAX_PER_SOURCE; i += 1) {
    await claimInviteSubmission({ source: "aaa", now: () => AT }, { store });
  }
  const later = new Date(AT.getTime() + INVITE_LIMITS.WINDOW_MS);
  assert.notEqual(windowOf(later), windowOf(AT));
  await claimInviteSubmission({ source: "aaa", now: () => later }, { store });
  /* One key rather than one per hour: the provider has no expiry and no
     conditional delete, so a key per window would never be removed by anything. */
  assert.deepEqual(provider.keys(), [INVITE_RATE_KEY]);
});

test("a counter that cannot be read refuses the submission", async () => {
  /* Fail closed. A rate limiter that fails open is one an attacker only has to
     break once. */
  const { provider, store } = rateHarness();
  provider.failNextRead({ throws: true });
  await assert.rejects(
    () => claimInviteSubmission({ source: "aaa", now: () => AT }, { store }),
    (error) => error instanceof HostedContractError && error.code === "unavailable",
  );
});

test("a corrupt counter is an outage rather than a fresh budget", async () => {
  const { provider, store } = rateHarness();
  provider.put(INVITE_RATE_KEY, JSON.stringify({ v: 1, window: "1", counts: { aaa: -5 } }));
  await assert.rejects(
    () => claimInviteSubmission({ source: "aaa", now: () => AT }, { store }),
    (error) => error instanceof HostedContractError && error.code === "unavailable",
  );
});

test("the stored total is derived, never read", () => {
  /* A stored total that disagreed with the counts it sums would be the field an
     attacker most wants to write. */
  const record = validateRateRecord({ v: 1, window: "1", counts: { aaa: 2, bbb: 3 }, total: 0 });
  assert.equal(record.total, 5);
});

/* --- the route ------------------------------------------------------------ */

function routeHarness({ env = MAIL_ENV, send = async () => new Response("{}", { status: 200 }) } = {}) {
  const provider = createProviderDouble();
  const sends = [];
  const fetchImpl = async (url, init) => {
    sends.push(JSON.parse(init.body));
    return send(url, init);
  };
  const deps = () =>
    Object.freeze({
      config: readHostedConfig(HOSTED_ENV),
      mailer: readMailerConfig({ ...HOSTED_ENV, ...env }),
      rate: createInviteRateStore({ getStore: provider.getStore }),
      fetchImpl,
      now: () => AT,
    });
  return { provider, sends, route: createInviteRequestRoute(deps) };
}

function submission(json, options = {}) {
  return browserRequest("/api/hosted/invite-request", { method: "POST", json, ...options });
}

test("a submission is accepted, mailed to the operator, and answered with one fixed body", async () => {
  const app = routeHarness();
  const response = await app.route(
    submission({ v: 1, email: "Someone@Example.com", message: "I would like to try Archon." }),
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { v: 1, status: "received" });
  assert.equal(app.sends.length, 1);
  assert.deepEqual(app.sends[0].to, [MAIL_ENV.ARCHON_EMAIL_RECIPIENT]);
  assert.match(app.sends[0].text, /someone@example\.com/);
  assert.match(app.sends[0].text, /I would like to try Archon\./);
});

test("the requester is never a recipient, so this is not an open relay", async () => {
  const app = routeHarness();
  await app.route(submission({ v: 1, email: "victim@elsewhere.example", message: "" }));
  const sent = app.sends[0];
  assert.deepEqual(sent.to, [MAIL_ENV.ARCHON_EMAIL_RECIPIENT]);
  assert.equal(sent.from, MAIL_ENV.ARCHON_EMAIL_SENDER);
  for (const [field, value] of Object.entries(sent)) {
    if (field === "text") continue;
    assert.ok(
      !JSON.stringify(value).includes("victim@elsewhere.example"),
      `the requester's address is content, not ${field}`,
    );
  }
});

test("the answer is the same whoever submits, so the form is not a membership oracle", async () => {
  const app = routeHarness();
  const first = await app.route(submission({ v: 1, email: "its.everdred@gmail.com", message: "" }));
  const second = await app.route(submission({ v: 1, email: "nobody@nowhere.example", message: "" }));
  assert.equal(first.status, second.status);
  assert.deepEqual(await first.json(), await second.json());
});

test("a submission from another origin is refused before any counter is touched", async () => {
  const app = routeHarness();
  const response = await app.route(
    submission({ v: 1, email: "someone@example.com" }, { origin: "https://evil.example" }),
  );
  assert.equal(response.status, 403);
  assert.equal(app.sends.length, 0);
  assert.deepEqual(app.provider.keys(), [], "nothing was written");
});

test("a form-encoded body is refused, so no cross-origin form can reach this route", async () => {
  const app = routeHarness();
  const response = await app.route(
    browserRequest("/api/hosted/invite-request", {
      method: "POST",
      form: { email: "someone@example.com" },
    }),
  );
  assert.equal(response.status, 415);
  assert.equal(app.sends.length, 0);
});

test("a malformed address is refused and costs no send", async () => {
  const app = routeHarness();
  const response = await app.route(submission({ v: 1, email: "not-an-address" }));
  assert.equal(response.status, 400);
  assert.equal(app.sends.length, 0);
});

test("a rate-limited submission is a 429 with one message for every way it can happen", async () => {
  const app = routeHarness();
  for (let i = 0; i < INVITE_LIMITS.MAX_PER_SOURCE; i += 1) {
    const accepted = await app.route(submission({ v: 1, email: `p${i}@example.com` }));
    assert.equal(accepted.status, 202);
  }
  const refused = await app.route(submission({ v: 1, email: "late@example.com" }));
  assert.equal(refused.status, 429);
  assert.match((await refused.json()).error.message, /too many invite requests/);
  assert.equal(app.sends.length, INVITE_LIMITS.MAX_PER_SOURCE, "the refused one was never sent");
});

test("a failed send does not refund the budget", async () => {
  /* A budget refunded on failure lets anybody who can make sends fail spend an
     unlimited number of attempts at the provider. */
  const app = routeHarness({ send: async () => new Response("{}", { status: 500 }) });
  const failed = await app.route(submission({ v: 1, email: "someone@example.com" }));
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).error.retryable, true);

  for (let i = 1; i < INVITE_LIMITS.MAX_PER_SOURCE; i += 1) {
    assert.equal((await app.route(submission({ v: 1, email: `p${i}@example.com` }))).status, 503);
  }
  const spent = await app.route(submission({ v: 1, email: "late@example.com" }));
  assert.equal(spent.status, 429, "the failed attempts were still spent");
});

test("a deployment with no mail configuration reports the feature unavailable", async () => {
  const app = routeHarness({ env: {} });
  const response = await app.route(submission({ v: 1, email: "someone@example.com" }));
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /not enabled/);
  assert.equal(app.sends.length, 0);
});

test("the route accepts POST only and grants no CORS", async () => {
  const app = routeHarness();
  const refused = await app.route(browserRequest("/api/hosted/invite-request", { method: "GET" }));
  assert.equal(refused.status, 405);
  assert.equal(refused.headers.get("allow"), "POST");

  const accepted = await app.route(submission({ v: 1, email: "someone@example.com" }));
  assert.equal(accepted.headers.get("access-control-allow-origin"), null);
  assert.equal(APP_ORIGIN, HOSTED_ENV.HOSTED_APP_ORIGIN);
});
