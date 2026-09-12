/**
 * Regressions for the two self-serve publish routes: the claim route behind
 * `/publish/approve` and the pending list behind `/publish/pending`.
 *
 * These are the routes that let a person reach an approval without the agent's
 * link, so the whole suite is organised around the two things they must never
 * become:
 *
 *  - **a way to approve somebody else's publication.** Every refusal here is
 *    the cross-user case in a different disguise: an id with no capability
 *    behind it, a code that belongs to a record another account already
 *    claimed, a list that would show one person another's document. The
 *    decision route is deliberately exercised at the end of the happy path too,
 *    to prove that what the claim route hands out is a *route to* the existing
 *    authorisation gate and not a way around it.
 *  - **an oracle.** A signed-in visitor typing codes must not be able to tell a
 *    code that names nothing from a code that names something they may not
 *    have. The bodies are compared byte for byte for that reason.
 *
 * Every test drives the real exported handlers over an injected dependency set -
 * a real `AuthStore` on a memory blob store and the real publication adapter on
 * the conditional-write provider double - so what runs here is the code the
 * deploy runs.
 *
 *   node --test netlify/test/hosted/publications-self-serve.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { HOSTED_LIMITS, validatePublication } from "../../lib/hosted/contracts.mjs";
import {
  BINDING_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  deriveCsrfToken,
  validateDestination,
} from "../../lib/hosted/identity.mjs";
import {
  PUBLICATION_KEY_PREFIX,
  createPublicationStore,
} from "../../lib/hosted/publication-store.mjs";
import { normalizeUserCode } from "../../lib/hosted/publications.mjs";
import claimHandler, {
  createClaimRoute,
  config as claimConfig,
} from "../../functions/hosted-publications-claim.mjs";
import pendingHandler, {
  createPendingRoute,
  config as pendingConfig,
} from "../../functions/hosted-publications-pending.mjs";
import { createDecisionRoute } from "../../functions/hosted-publications-decision.mjs";
import { createReviewRoute } from "../../functions/hosted-publications-review.mjs";
import { MemoryBlobStore, fixedClock, hostedConfig, memoryAuthStore } from "./fixtures/auth.mjs";
import {
  FIXTURE_APP_ORIGIN,
  FIXTURE_KEY,
  FIXTURE_NOW,
  FIXTURE_PRINCIPAL,
  FIXTURE_PUBLICATION_ID,
  OTHER_PRINCIPAL,
  RECORDS,
} from "./fixtures/publications.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

const CLAIM_PATH = "/api/hosted/publications/claim";
const PENDING_PATH = "/api/hosted/publications/pending";
const DECISION_PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/decision`;
const REVIEW_PATH = `/api/hosted/publications/${FIXTURE_PUBLICATION_ID}/review`;

/** The fixture pending record's own pairing code, as the minter produced it. */
const FIXTURE_CODE = RECORDS.pending.userCode;

/** A second pending publication, so "only mine" has something to exclude. */
const SECOND_ID = "1234567890abcdef1234567890abcdef";
const SECOND_CODE = "GHJK-6789";
const SECOND_KEY = `${PUBLICATION_KEY_PREFIX}${SECOND_ID}`;
const SECOND_RECORD = validatePublication({
  ...RECORDS.pending,
  id: SECOND_ID,
  userCode: SECOND_CODE,
  descriptor: { ...RECORDS.pending.descriptor, title: "The other person's document" },
});

/**
 * One harness carrying both stores, both clocks and the injected dependency set.
 *
 * Seeded with the fixture pending record, and optionally with a second
 * publication and a claimant already stamped on either - which is how a test
 * asks what a *different* account can see and do.
 */
function harness({
  seed = "pending",
  claimant = null,
  second = false,
  secondClaimant = null,
  publishEnabled = true,
} = {}) {
  const provider = createProviderDouble();
  if (seed !== null) {
    const record = claimant === null ? RECORDS[seed] : { ...RECORDS[seed], claimantAccountId: claimant };
    provider.put(FIXTURE_KEY, JSON.stringify(validatePublication(record)));
  }
  if (second) {
    const record =
      secondClaimant === null ? SECOND_RECORD : { ...SECOND_RECORD, claimantAccountId: secondClaimant };
    provider.put(SECOND_KEY, JSON.stringify(validatePublication(record)));
  }
  const clock = createClock(FIXTURE_NOW);
  const authClock = fixedClock(Date.parse(FIXTURE_NOW));
  const blobs = new MemoryBlobStore();
  const { store } = memoryAuthStore(authClock, blobs);

  const dependencies = {
    config: hostedConfig(),
    store,
    publications: {
      store: createPublicationStore({ getStore: provider.getStore }),
      appOrigin: FIXTURE_APP_ORIGIN,
      production: true,
      publishEnabled,
      now: clock.now,
      randomBytes: sequentialRandomBytes(),
    },
  };

  return {
    provider,
    clock,
    store,
    dependencies,
    claim: createClaimRoute(() => dependencies),
    pending: createPendingRoute(() => dependencies),
    decision: createDecisionRoute(() => dependencies),
    review: createReviewRoute(() => dependencies),
    record(key = FIXTURE_KEY) {
      const raw = provider.raw(key);
      return raw === null ? null : JSON.parse(raw.data);
    },
    async session(principal = FIXTURE_PRINCIPAL) {
      return (await store.createSession(principal)).token;
    },
    /** A live publication binding cookie, as the link's bind route would mint. */
    async publishBinding(publicationId = FIXTURE_PUBLICATION_ID) {
      const operation = `${publicationId}${RECORDS.pending.browserSecretHash}`;
      return (await store.createTransient("binding", { operation })).token;
    },
  };
}

/** A `Request` shaped the way a browser sends one to these routes. */
function request(
  path,
  { method = "GET", cookies = {}, origin = FIXTURE_APP_ORIGIN, csrf = null, json = null } = {},
) {
  const headers = new Headers();
  const pairs = Object.entries(cookies).filter(([, value]) => value !== undefined && value !== null);
  if (pairs.length > 0) {
    headers.set("cookie", pairs.map(([name, value]) => `${name}=${value}`).join("; "));
  }
  if (origin !== null) headers.set("origin", origin);
  if (csrf !== null) headers.set(CSRF_HEADER, csrf);
  let body;
  if (json !== null) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(json);
  }
  return new Request(`${FIXTURE_APP_ORIGIN}${path}`, { method, headers, body });
}

/** A signed-in claim request, with the session's own CSRF token on it. */
async function claimRequest(kit, body, { principal = FIXTURE_PRINCIPAL, binding = null } = {}) {
  const session = await kit.session(principal);
  return request(CLAIM_PATH, {
    method: "POST",
    cookies: { [SESSION_COOKIE]: session, [BINDING_COOKIE]: binding },
    csrf: deriveCsrfToken(session),
    json: body,
  });
}

/** The `Set-Cookie` values a response carries. */
function cookiesOf(response) {
  return typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter((value) => value !== null);
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

test("both routes are declared under the hosted API namespace and are rate limited", () => {
  assert.equal(claimConfig.path, CLAIM_PATH);
  assert.equal(pendingConfig.path, PENDING_PATH);
  assert.equal(typeof claimHandler, "function");
  assert.equal(typeof pendingHandler, "function");
  /* A code is the one capability in this flow a person can type, so the route
     that accepts one is bounded the same way the anonymous start route is. */
  assert.equal(claimConfig.rateLimit.windowLimit, 10);
  assert.equal(claimConfig.rateLimit.windowSize, 60);
  assert.deepEqual(claimConfig.rateLimit.aggregateBy, ["ip", "domain"]);
  assert.equal(typeof pendingConfig.rateLimit.windowLimit, "number");
});

test("the two self-serve pages are sign-in destinations, and nothing near them is", () => {
  assert.equal(validateDestination(HOSTED_LIMITS.PENDING_PATH), "/publish/pending");
  assert.equal(validateDestination(HOSTED_LIMITS.APPROVE_PATH), "/publish/approve");
  for (const spelling of [
    "/publish/pending/",
    "/publish/approve/",
    "/publish/approve?code=BCDF-2345",
    "/publish",
    "//evil.example/publish/approve",
    "https://evil.example/publish/approve",
  ]) {
    assert.throws(() => validateDestination(spelling), /unknown destination/, spelling);
  }
});

/* ------------------------------------------------------------------ */
/* the typed pairing code                                              */
/* ------------------------------------------------------------------ */

test("a typed pairing code claims the publication and hands back a binding", async () => {
  const kit = harness();
  const response = await kit.claim(await claimRequest(kit, { userCode: FIXTURE_CODE }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.publicationId, FIXTURE_PUBLICATION_ID);
  assert.equal(body.expiresAt, RECORDS.pending.pendingExpiresAt);
  /* The descriptor is not here. It belongs to the review route, behind the
     binding this response just issued. */
  assert.deepEqual(Object.keys(body).sort(), ["expiresAt", "publicationId", "v"]);

  const cookies = cookiesOf(response);
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], new RegExp(`^${BINDING_COOKIE}=`));
  assert.match(cookies[0], /HttpOnly/i);

  /* The claim is recorded, and nothing else about the record moved. */
  const stored = kit.record();
  assert.equal(stored.claimantAccountId, FIXTURE_PRINCIPAL.accountId);
  assert.equal(stored.state, "pending");
  assert.equal(stored.ownerAccountId, null);
});

test("a code is read the way a person types it", async () => {
  for (const typed of ["bcdf-2345", "BCDF2345", " bcdf 2345 ", "bCdF-2345"]) {
    const kit = harness();
    const response = await kit.claim(await claimRequest(kit, { userCode: typed }));
    assert.equal(response.status, 200, typed);
  }
  /* And normalisation is not a second, laxer grammar: anything that is not the
     minted shape is refused before a store is touched. */
  for (const junk of ["", "BCDF-234", "BCDF-23456", "AEIO-UAEI", "../../etc/passwd"]) {
    assert.equal(normalizeUserCode(junk), null, junk);
  }
});

test("a wrong code and another person's code are the same refusal, byte for byte", async () => {
  const unknown = harness();
  const unknownResponse = await unknown.claim(await claimRequest(unknown, { userCode: "GHJK-6789" }));

  /* The same record, already claimed by somebody else, and the caller typing
     the correct code for it. If this answered differently from the line above,
     the page would be an existence oracle for other people's publications. */
  const taken = harness({ claimant: OTHER_PRINCIPAL.accountId });
  const takenResponse = await taken.claim(await claimRequest(taken, { userCode: FIXTURE_CODE }));

  assert.equal(unknownResponse.status, 404);
  assert.equal(takenResponse.status, takenResponse.status);
  assert.equal(takenResponse.status, 404);
  assert.deepEqual(await takenResponse.json(), await unknownResponse.json());
  /* And the claim somebody else holds is untouched. */
  assert.equal(taken.record().claimantAccountId, OTHER_PRINCIPAL.accountId);
});

test("a terminal or expired publication cannot be claimed by its code", async () => {
  for (const state of ["approved", "complete", "denied", "cancelled", "expired"]) {
    const kit = harness({ seed: state });
    const response = await kit.claim(await claimRequest(kit, { userCode: FIXTURE_CODE }));
    assert.equal(response.status, 404, state);
  }

  /* A pending record whose deadline has passed is expired to every caller,
     without anything having been written. */
  const kit = harness();
  kit.clock.advanceSeconds(HOSTED_LIMITS.PENDING_TTL_SECONDS + 1);
  const response = await kit.claim(await claimRequest(kit, { userCode: FIXTURE_CODE }));
  assert.equal(response.status, 404);
  assert.equal(kit.record().claimantAccountId, null);
});

test("claiming again as the same account is idempotent and writes nothing new", async () => {
  const kit = harness({ claimant: FIXTURE_PRINCIPAL.accountId });
  const before = kit.provider.raw(FIXTURE_KEY).etag;

  const response = await kit.claim(await claimRequest(kit, { userCode: FIXTURE_CODE }));

  assert.equal(response.status, 200);
  assert.equal(kit.provider.raw(FIXTURE_KEY).etag, before);
  assert.equal(cookiesOf(response).length, 1);
});

/* ------------------------------------------------------------------ */
/* the cross-user refusals                                             */
/* ------------------------------------------------------------------ */

test("a publication id alone is not a capability: a signed-in stranger is refused", async () => {
  const kit = harness();

  const response = await kit.claim(
    await claimRequest(kit, { publicationId: FIXTURE_PUBLICATION_ID }, { principal: OTHER_PRINCIPAL }),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(cookiesOf(response), []);
  assert.equal(kit.record().claimantAccountId, null);
});

test("a stranger cannot take over a publication another account has claimed", async () => {
  const kit = harness({ claimant: FIXTURE_PRINCIPAL.accountId });

  const byId = await kit.claim(
    await claimRequest(kit, { publicationId: FIXTURE_PUBLICATION_ID }, { principal: OTHER_PRINCIPAL }),
  );
  const byCode = await kit.claim(
    await claimRequest(kit, { userCode: FIXTURE_CODE }, { principal: OTHER_PRINCIPAL }),
  );

  assert.equal(byId.status, 404);
  assert.equal(byCode.status, 404);
  assert.equal(kit.record().claimantAccountId, FIXTURE_PRINCIPAL.accountId);
});

test("a claim cannot be made without a session, the CSRF token or the exact Origin", async () => {
  const kit = harness();
  const session = await kit.session();

  const anonymous = await kit.claim(
    request(CLAIM_PATH, { method: "POST", json: { userCode: FIXTURE_CODE } }),
  );
  const noCsrf = await kit.claim(
    request(CLAIM_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session },
      json: { userCode: FIXTURE_CODE },
    }),
  );
  const foreignOrigin = await kit.claim(
    request(CLAIM_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session },
      csrf: deriveCsrfToken(session),
      origin: "https://evil.example",
      json: { userCode: FIXTURE_CODE },
    }),
  );

  assert.equal(anonymous.status, 401);
  assert.equal(noCsrf.status, 403);
  assert.equal(foreignOrigin.status, 403);
  assert.equal(kit.record().claimantAccountId, null);
});

test("claim accepts only POST, and only a JSON object", async () => {
  const kit = harness();
  const wrongMethod = await kit.claim(request(CLAIM_PATH, { method: "GET" }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const session = await kit.session();
  const notJson = await kit.claim(
    new Request(`${FIXTURE_APP_ORIGIN}${CLAIM_PATH}`, {
      method: "POST",
      headers: {
        origin: FIXTURE_APP_ORIGIN,
        cookie: `${SESSION_COOKIE}=${session}`,
        [CSRF_HEADER]: deriveCsrfToken(session),
        "content-type": "text/plain",
      },
      body: "userCode=BCDF-2345",
    }),
  );
  assert.equal(notJson.status, 415);
});

/* ------------------------------------------------------------------ */
/* the link path, and the round trip to a real decision                */
/* ------------------------------------------------------------------ */

test("the browser binding from the agent's link is itself a proof of claim", async () => {
  const kit = harness();
  const binding = await kit.publishBinding();

  const response = await kit.claim(
    await claimRequest(kit, { publicationId: FIXTURE_PUBLICATION_ID }, { binding }),
  );

  assert.equal(response.status, 200);
  assert.equal(kit.record().claimantAccountId, FIXTURE_PRINCIPAL.accountId);
  /* The browser is already holding this exact publication, so the live binding
     is kept rather than revoked and re-minted underneath an approval in flight. */
  assert.deepEqual(cookiesOf(response), []);
});

test("a claim reaches the existing approval gate and does not replace it", async () => {
  const kit = harness();
  const session = await kit.session();
  const csrf = deriveCsrfToken(session);

  /* Type the code, exactly as `/publish/approve` does. */
  const claimed = await kit.claim(
    request(CLAIM_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session },
      csrf,
      json: { userCode: FIXTURE_CODE },
    }),
  );
  assert.equal(claimed.status, 200);
  const issued = cookiesOf(claimed)[0];
  const binding = /__Host-archon_publish=([^;]+)/.exec(issued)[1];

  /* The review route now answers for this browser, which is what the approval
     page needs to render anything at all. */
  const reviewed = await kit.review(
    request(REVIEW_PATH, { cookies: { [SESSION_COOKIE]: session, [BINDING_COOKIE]: binding } }),
  );
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).state, "pending");

  /* And the decision route is unchanged: it still demands the binding, the
     session, the CSRF token and the displayed account, and it still fixes the
     owner to the session's own account. */
  const withoutBinding = await kit.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session },
      csrf,
      json: { decision: "approve", displayedAccountId: FIXTURE_PRINCIPAL.accountId },
    }),
  );
  assert.equal(withoutBinding.status, 403);
  assert.equal(kit.record().state, "pending");

  const decided = await kit.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session, [BINDING_COOKIE]: binding },
      csrf,
      json: { decision: "approve", displayedAccountId: FIXTURE_PRINCIPAL.accountId },
    }),
  );
  assert.equal(decided.status, 200);
  const stored = kit.record();
  assert.equal(stored.state, "approved");
  assert.equal(stored.ownerAccountId, FIXTURE_PRINCIPAL.accountId);
  /* The claim survives the decision: it is who reached the approval, not who
     owns the document, and the two are recorded separately. */
  assert.equal(stored.claimantAccountId, FIXTURE_PRINCIPAL.accountId);
});

test("a session that claimed nothing still cannot approve anything", async () => {
  const kit = harness({ claimant: FIXTURE_PRINCIPAL.accountId });
  const session = await kit.session(OTHER_PRINCIPAL);

  const response = await kit.decision(
    request(DECISION_PATH, {
      method: "POST",
      cookies: { [SESSION_COOKIE]: session },
      csrf: deriveCsrfToken(session),
      json: { decision: "approve", displayedAccountId: OTHER_PRINCIPAL.accountId },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(kit.record().state, "pending");
  assert.equal(kit.record().ownerAccountId, null);
});

/* ------------------------------------------------------------------ */
/* the pending list                                                    */
/* ------------------------------------------------------------------ */

test("the pending list shows this account's claims and never anybody else's", async () => {
  const kit = harness({
    claimant: FIXTURE_PRINCIPAL.accountId,
    second: true,
    secondClaimant: OTHER_PRINCIPAL.accountId,
  });

  const mine = await kit.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await kit.session() } }),
  );
  const theirs = await kit.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await kit.session(OTHER_PRINCIPAL) } }),
  );

  assert.equal(mine.status, 200);
  const body = await mine.json();
  assert.equal(body.publications.length, 1);
  assert.equal(body.publications[0].publicationId, FIXTURE_PUBLICATION_ID);
  assert.equal(body.publications[0].userCode, FIXTURE_CODE);
  assert.equal(body.publications[0].title, RECORDS.pending.descriptor.title);
  /* Neither secret hash, no HTML, and no owner or claimant identifier: a list
     row carries what a person needs to recognise their own document and
     nothing that would be a capability if it leaked. */
  assert.deepEqual(
    Object.keys(body.publications[0]).sort(),
    ["contentBytes", "createdAt", "expiresAt", "publicationId", "title", "userCode"],
  );

  /* The other account sees its own one row and never this one - and the
     serialised body cannot even contain the other publication's id. */
  const otherBody = await theirs.json();
  assert.equal(otherBody.publications.length, 1);
  assert.equal(otherBody.publications[0].publicationId, SECOND_ID);
  assert.ok(!JSON.stringify(otherBody).includes(FIXTURE_PUBLICATION_ID));
  assert.ok(!JSON.stringify(otherBody).includes(FIXTURE_CODE));
});

test("an unclaimed, terminal or expired publication is on nobody's list", async () => {
  const unclaimed = harness();
  const anybody = await unclaimed.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await unclaimed.session() } }),
  );
  assert.deepEqual((await anybody.json()).publications, []);

  for (const state of ["approved", "complete", "denied", "cancelled", "expired"]) {
    const kit = harness({ seed: state, claimant: FIXTURE_PRINCIPAL.accountId });
    const response = await kit.pending(
      request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await kit.session() } }),
    );
    assert.deepEqual((await response.json()).publications, [], state);
  }

  const lapsed = harness({ claimant: FIXTURE_PRINCIPAL.accountId });
  lapsed.clock.advanceSeconds(HOSTED_LIMITS.PENDING_TTL_SECONDS + 1);
  const response = await lapsed.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await lapsed.session() } }),
  );
  assert.deepEqual((await response.json()).publications, []);
});

test("the pending list needs a session, answers only GET, and is never cached", async () => {
  const kit = harness({ claimant: FIXTURE_PRINCIPAL.accountId });

  const anonymous = await kit.pending(request(PENDING_PATH));
  assert.equal(anonymous.status, 401);
  assert.ok(!(await anonymous.text()).includes(FIXTURE_PUBLICATION_ID));

  const wrongMethod = await kit.pending(request(PENDING_PATH, { method: "POST" }));
  assert.equal(wrongMethod.status, 405);

  const listed = await kit.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await kit.session() } }),
  );
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  assert.equal(listed.headers.get("vary"), "Cookie");
});

test("a storage outage is a retryable 503, never an empty list", async () => {
  const kit = harness({ claimant: FIXTURE_PRINCIPAL.accountId });
  kit.provider.failNextList({ throws: true });

  const response = await kit.pending(
    request(PENDING_PATH, { cookies: { [SESSION_COOKIE]: await kit.session() } }),
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.retryable, true);
  kit.provider.assertFaultsConsumed();
});

/* ------------------------------------------------------------------ */
/* the two pages                                                       */
/* ------------------------------------------------------------------ */

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "publish");
const page = (name) => readFileSync(join(PUBLIC_DIR, name), "utf8");

test("neither self-serve page writes markup or leaves a capability in a URL", () => {
  /* Matched as code rather than as text, because each of these files *says*
     in its own header that it contains no `innerHTML`, and a substring search
     would be satisfied by the promise instead of by the property. */
  for (const name of ["pending.js", "approve.js", "authorize.js"]) {
    const source = page(name);
    assert.ok(!/\.(inner|outer)HTML\s*=/.test(source), `${name} writes markup`);
    assert.ok(!/insertAdjacentHTML\s*\(/.test(source), `${name} writes markup`);
    assert.ok(!/document\.write\s*\(/.test(source), `${name} writes markup`);
  }
  /* The typed code goes into one request body. It is never a query parameter,
     never stored, and never read back onto the screen. */
  const approve = page("approve.js");
  assert.ok(!/[?&]code=/.test(approve), "the code reached a URL");
  assert.ok(!approve.includes("sessionStorage.setItem(STORAGE_KEY, typed"), "the code was stored");
  assert.match(approve, /field\.value = ""/);
});

test("each page signs in back to itself, using a destination the grammar allows", () => {
  const destinations = {
    "pending.html": HOSTED_LIMITS.PENDING_PATH,
    "approve.html": HOSTED_LIMITS.APPROVE_PATH,
    "authorize.html": HOSTED_LIMITS.AUTHORIZE_PATH,
  };
  for (const [name, destination] of Object.entries(destinations)) {
    const html = page(name);
    assert.ok(
      html.includes(`name="destination" value="${destination}"`),
      `${name} does not sign in back to ${destination}`,
    );
    assert.equal(validateDestination(destination), destination);
  }
});

test("the approval page spells authorize the way the rest of the product does", () => {
  const html = page("authorize.html");
  assert.ok(!/Authoris/i.test(html), "the page still says Authorise");
  assert.match(html, /<h1>Authorize a publication<\/h1>/);
  assert.match(html, /<title>Authorize a publication/);
  assert.ok(!/authoris/i.test(page("authorize.js")), "the script still says authorised");
});

test("the approval page shows the pairing code and names both ways back in", () => {
  const html = page("authorize.html");
  /* Part 3 of #254: the code is relayed by the agent, so the page has to show
     it - the alternative was dropping it from the agent contract, and the
     typeable page below is exactly why it is worth keeping. */
  assert.match(html, /Pairing code/);
  assert.match(html, /id="user-code"/);
  assert.match(html, /href="\/publish\/approve"/);
  assert.match(html, /href="\/publish\/pending"/);
});
