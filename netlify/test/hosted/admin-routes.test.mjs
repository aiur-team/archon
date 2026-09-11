/**
 * The three admin routes, over injected dependencies.
 *
 * Each runs against a real `AuthStore` on a memory blob store, a real allowlist
 * store on the publication suite's provider double, and a real publication
 * store - so what is verified is the routes' own authorisation, not a mock of
 * it. Nothing here needs a credential, a provider or a network.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ALLOWLIST_KEY, createAllowlistStore } from "../../lib/hosted/allowlist.mjs";
import { readHostedConfig } from "../../lib/hosted/config.mjs";
import { deriveAccountId } from "../../lib/hosted/contracts.mjs";
import {
  deriveCsrfToken,
  RESERVED_FIRST_SEGMENTS,
  SESSION_COOKIE,
  validateDestination,
} from "../../lib/hosted/identity.mjs";
import { createPublicationStore } from "../../lib/hosted/publication-store.mjs";
import { createAdminAllowlistRoute } from "../../functions/hosted-admin-allowlist.mjs";
import { createAdminDocumentsRoute } from "../../functions/hosted-admin-documents.mjs";
import { ADMIN_PAGE_PATH } from "../../lib/hosted/admin.mjs";
import { ADMIN_SIGN_IN, createAdminPageRoute } from "../../functions/hosted-admin-page.mjs";
import {
  APP_ORIGIN,
  HOSTED_ENV,
  MemoryBlobStore,
  browserRequest,
  fixedClock,
  memoryAuthStore,
} from "./fixtures/auth.mjs";
import { RECORDS } from "./fixtures/publications.mjs";
import { createProviderDouble } from "./helpers/publication-store.mjs";

const ADMIN = "its.everdred@gmail.com";
const NOT_ADMIN = "reader@example.com";

/**
 * A principal with a verified address, as `principalFromClaims` produces one.
 *
 * The account id is derived rather than written out, because `validatePrincipal`
 * recomputes it from the subject and refuses a pair that disagrees - so a
 * literal here would be a fixture that only the person who typed it can edit.
 * The subject is derived from the address so two different people are two
 * different accounts without a caller having to say so.
 */
function personAt(email, { emailVerified = true } = {}) {
  const providerUserId = `google-oauth2|${email}`;
  return {
    accountId: deriveAccountId(providerUserId),
    provider: "auth0",
    providerUserId,
    login: email.slice(0, email.indexOf("@")),
    email,
    emailVerified,
  };
}

/**
 * A publication record, derived from the shared C2 fixture rather than typed
 * out here.
 *
 * A hand-written record is a second, drifting statement of C2's shape - the
 * first draft of this helper carried an `error` field the contract does not
 * have, and `validatePublication` refused it. Starting from the fixture for the
 * state and overriding the three fields a census test cares about keeps the
 * shape in one place.
 */
function publication(id, { title, ownerEmail = null, allowedDomains = [], state = "complete" } = {}) {
  const base = RECORDS[state];
  return {
    ...base,
    id,
    descriptor: { ...base.descriptor, title },
    ownerEmail: base.ownerAccountId === null ? null : ownerEmail,
    allowedDomains,
  };
}

async function harness({ env = {}, documents = [] } = {}) {
  const clock = fixedClock();
  const auth = memoryAuthStore(clock, new MemoryBlobStore());
  const provider = createProviderDouble();
  const publications = createPublicationStore({ getStore: provider.getStore });
  for (const record of documents) await publications.create(record);

  const config = readHostedConfig({ ...HOSTED_ENV, ARCHON_ADMINS: ADMIN, ...env });
  const deps = () =>
    Object.freeze({
      config,
      store: auth.store,
      allowlist: createAllowlistStore({ getStore: provider.getStore }),
      publications,
    });

  return {
    provider,
    config,
    async signIn(principal) {
      const session = await auth.store.createSession(principal);
      return { cookies: { [SESSION_COOKIE]: session.token }, csrf: deriveCsrfToken(session.token) };
    },
    page: createAdminPageRoute(deps),
    documents: createAdminDocumentsRoute(deps),
    allowlist: createAdminAllowlistRoute(deps),
  };
}

/* --- the page ------------------------------------------------------------- */

test("the admin page is served to a seeded admin", async () => {
  const app = await harness();
  const { cookies } = await app.signIn(personAt(ADMIN));
  const response = await app.page(browserRequest("/admin", { cookies }));

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Archon admin/);
  assert.match(body, new RegExp(ADMIN.replace(".", "\\.")), "the page names who is signed in");
  /* The shell carries no document data, so nothing about a document can leak
     through a cached copy of it. */
  assert.ok(!body.includes("documentId"), "the shell holds no document data");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /script-src 'self'/);
});

test("a signed-in non-admin gets 403 and learns nothing about any document", async () => {
  const app = await harness();
  const { cookies } = await app.signIn(personAt(NOT_ADMIN));
  const response = await app.page(browserRequest("/admin", { cookies }));

  assert.equal(response.status, 403);
  const body = await response.text();
  assert.match(body, /not an administrator/);
  assert.ok(!body.includes("<script"), "the refusal page is inert");
});

test("an admin whose address is unverified is not an admin", async () => {
  /* The one claim that turns typing an address into holding a capability. */
  const app = await harness();
  const { cookies } = await app.signIn(personAt(ADMIN, { emailVerified: false }));
  assert.equal((await app.page(browserRequest("/admin", { cookies }))).status, 403);
});

test("a signed-out visitor is sent to sign in and comes back to /admin", async () => {
  const app = await harness();
  const response = await app.page(browserRequest("/admin"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/login/?destination=%2Fadmin");
});

test("the console's address really is a destination sign-in will return to", async () => {
  /* The redirect above promises a return to `/admin`. `validateDestination` is
     an allowlist of exact shapes, so without an entry for it the promise is
     silently broken: the sign-in page drops the destination it cannot express
     and the visitor lands on the default page instead of the console. */
  assert.equal(validateDestination(ADMIN_PAGE_PATH), ADMIN_PAGE_PATH);
  assert.equal(
    ADMIN_SIGN_IN,
    `/login/?destination=${encodeURIComponent(ADMIN_PAGE_PATH)}`,
    "the route redirects to the destination it is allowed to ask for",
  );

  /* And by exactly one string, not a shape: nothing near it becomes a
     destination. */
  for (const near of ["/admin/", "/admin/x", "//admin", "/adminfoo", "/ADMIN"]) {
    assert.throws(() => validateDestination(near), `${near} is not a destination`);
  }

  /* `admin` is also a reserved first segment, so `/admin/` cannot be accepted as
     a collaboration slug that lands a visitor one character from the console. */
  assert.ok(RESERVED_FIRST_SEGMENTS.includes("admin"));
});

test("a deployment that seeds no admin has no admins", async () => {
  const app = await harness({ env: { ARCHON_ADMINS: "" } });
  const { cookies } = await app.signIn(personAt(ADMIN));
  assert.equal((await app.page(browserRequest("/admin", { cookies }))).status, 403);
});

/* --- the census ----------------------------------------------------------- */

test("the census lists every document with its owner, date and access rules", async () => {
  const app = await harness({
    documents: [
      publication("a".repeat(32), {
        title: "Quarterly plan",
        ownerEmail: "owner@example.com",
        allowedDomains: ["partner.example.org"],
      }),
      publication("e".repeat(32), { title: "Draft", state: "pending" }),
    ],
  });
  const { cookies } = await app.signIn(personAt(ADMIN));
  const response = await app.documents(browserRequest("/api/hosted/admin/documents", { cookies }));

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.v, 1);
  assert.equal(body.documents.length, 2);

  const complete = body.documents.find((held) => held.documentId === "a".repeat(32));
  assert.equal(complete.title, "Quarterly plan");
  assert.equal(complete.ownerEmail, "owner@example.com");
  assert.equal(complete.ownerAccountId, RECORDS.complete.ownerAccountId);
  assert.equal(complete.createdAt, RECORDS.complete.createdAt);
  assert.deepEqual(complete.allowedDomains, ["partner.example.org"]);
  assert.equal(complete.state, "complete");

  /* A publication nobody has approved yet has no owner, and is listed anyway:
     an operator census that hid in-flight records would hide the ones most
     worth knowing about. */
  const pending = body.documents.find((held) => held.documentId === "e".repeat(32));
  assert.equal(pending.ownerAccountId, null);
  assert.equal(pending.state, "pending");
});

test("the census carries no document content and no secret", async () => {
  /* Operator decision 4: metadata only. The projection is built from nothing, so
     this asserts the property rather than a list of field names. */
  const app = await harness({
    documents: [publication("a".repeat(32), { title: "Quarterly plan", ownerEmail: "owner@example.com" })],
  });
  const { cookies } = await app.signIn(personAt(ADMIN));
  const body = await (await app.documents(browserRequest("/api/hosted/admin/documents", { cookies }))).text();

  for (const forbidden of ["<!doctype", "agentSecretHash", "browserSecretHash", "userCode", "\"html\""]) {
    assert.ok(!body.includes(forbidden), `the census does not carry ${forbidden}`);
  }
});

test("a record this version cannot interpret is reported, not dropped", async () => {
  const app = await harness({
    documents: [publication("a".repeat(32), { title: "Readable", ownerEmail: "owner@example.com" })],
  });
  app.provider.put("publications/" + "f".repeat(32), JSON.stringify({ v: 99 }));

  const { cookies } = await app.signIn(personAt(ADMIN));
  const body = await (await app.documents(browserRequest("/api/hosted/admin/documents", { cookies }))).json();

  const unreadable = body.documents.find((held) => held.unreadable === true);
  assert.equal(unreadable.documentId, "f".repeat(32));
  assert.equal(body.documents.length, 2, "the readable record is still listed");
});

test("the census refuses a non-admin and a signed-out caller", async () => {
  const app = await harness({
    documents: [publication("a".repeat(32), { title: "Secret", ownerEmail: "owner@example.com" })],
  });
  const { cookies } = await app.signIn(personAt(NOT_ADMIN));

  const refused = await app.documents(browserRequest("/api/hosted/admin/documents", { cookies }));
  assert.equal(refused.status, 403);
  assert.ok(!(await refused.text()).includes("Secret"), "a refusal names no document");

  const anonymous = await app.documents(browserRequest("/api/hosted/admin/documents"));
  assert.equal(anonymous.status, 401);
});

/* --- the allowlist editor ------------------------------------------------- */

test("an admin adds and removes an entry, and the whole list comes back", async () => {
  const app = await harness();
  const { cookies, csrf } = await app.signIn(personAt(ADMIN));

  const added = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies,
      csrf,
      json: { v: 1, action: "add", entry: "Named@Gmail.com" },
    }),
  );
  assert.equal(added.status, 200);
  const afterAdd = await added.json();
  assert.deepEqual(
    afterAdd.entries.map((held) => [held.kind, held.value, held.addedBy, held.source]),
    [["email", "named@gmail.com", ADMIN, "store"]],
  );

  const removed = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies,
      csrf,
      json: { v: 1, action: "remove", entry: "named@gmail.com" },
    }),
  );
  assert.deepEqual((await removed.json()).entries, []);
});

test("an edit without the session-derived token is refused and writes nothing", async () => {
  const app = await harness();
  const { cookies } = await app.signIn(personAt(ADMIN));
  const response = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies,
      json: { v: 1, action: "add", entry: "named@gmail.com" },
    }),
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "csrf_failed");
  assert.ok(!app.provider.keys().includes(ALLOWLIST_KEY), "nothing was written");
});

test("an edit from another origin is refused before any store read", async () => {
  const app = await harness();
  const { cookies, csrf } = await app.signIn(personAt(ADMIN));
  const response = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies,
      csrf,
      origin: "https://evil.example",
      json: { v: 1, action: "add", entry: "named@gmail.com" },
    }),
  );
  assert.equal(response.status, 403);
  assert.ok(!app.provider.keys().includes(ALLOWLIST_KEY), "nothing was written");
});

test("a non-admin can neither read nor edit the allowlist", async () => {
  const app = await harness();
  const admin = await app.signIn(personAt(ADMIN));
  await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies: admin.cookies,
      csrf: admin.csrf,
      json: { v: 1, action: "add", entry: "named@gmail.com" },
    }),
  );

  const other = await app.signIn(personAt(NOT_ADMIN));
  const read = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", { cookies: other.cookies }),
  );
  assert.equal(read.status, 403);
  /* Being admitted to the platform does not entitle you to enumerate who else
     was, so the refusal carries no entry. */
  assert.ok(!(await read.text()).includes("named@gmail.com"));

  const write = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies: other.cookies,
      csrf: other.csrf,
      json: { v: 1, action: "remove", entry: "named@gmail.com" },
    }),
  );
  assert.equal(write.status, 403);
});

test("a bad entry, a bad action and a bad envelope are each named", async () => {
  const app = await harness();
  const { cookies, csrf } = await app.signIn(personAt(ADMIN));
  const post = (json) =>
    app.allowlist(browserRequest("/api/hosted/admin/allowlist", { method: "POST", cookies, csrf, json }));

  const entry = await post({ v: 1, action: "add", entry: "not a domain" });
  assert.equal(entry.status, 400);
  assert.match((await entry.json()).error.message, /neither an email address nor a domain/);

  assert.equal((await post({ v: 1, action: "purge", entry: "x.example" })).status, 400);
  assert.equal((await post({ v: 2, action: "add", entry: "x.example" })).status, 400);
});

test("the editor reports whether the gate is actually enforced", async () => {
  /* An admin adding entries to a list nothing enforces has done nothing, and the
     page has to be able to say so. */
  const off = await harness();
  const offSession = await off.signIn(personAt(ADMIN));
  const offBody = await (
    await off.allowlist(browserRequest("/api/hosted/admin/allowlist", { cookies: offSession.cookies }))
  ).json();
  assert.equal(offBody.enforced, false);

  const on = await harness({ env: { ARCHON_PLATFORM_ALLOWLIST_ENFORCED: "true" } });
  const onSession = await on.signIn(personAt(ADMIN));
  const onBody = await (
    await on.allowlist(browserRequest("/api/hosted/admin/allowlist", { cookies: onSession.cookies }))
  ).json();
  assert.equal(onBody.enforced, true);
});

test("a seeded entry is marked and its removal is refused with a usable message", async () => {
  const app = await harness({ env: { ARCHON_PLATFORM_ALLOWLIST: "acme.example" } });
  const { cookies, csrf } = await app.signIn(personAt(ADMIN));

  const listed = await (
    await app.allowlist(browserRequest("/api/hosted/admin/allowlist", { cookies }))
  ).json();
  assert.deepEqual(
    listed.entries.map((held) => [held.value, held.source]),
    [["acme.example", "environment"]],
  );

  const refused = await app.allowlist(
    browserRequest("/api/hosted/admin/allowlist", {
      method: "POST",
      cookies,
      csrf,
      json: { v: 1, action: "remove", entry: "acme.example" },
    }),
  );
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error.message, /ARCHON_PLATFORM_ALLOWLIST/);
});

test("every admin route refuses the methods it does not implement", async () => {
  const app = await harness();
  const { cookies } = await app.signIn(personAt(ADMIN));
  const cases = [
    [app.page, "/admin", "POST", "GET, HEAD"],
    [app.documents, "/api/hosted/admin/documents", "POST", "GET"],
    [app.allowlist, "/api/hosted/admin/allowlist", "DELETE", "GET, POST"],
  ];
  for (const [route, path, method, allow] of cases) {
    const response = await route(browserRequest(path, { method, cookies }));
    assert.equal(response.status, 405, `${path} refuses ${method}`);
    assert.equal(response.headers.get("allow"), allow);
  }
});

test("no admin response is cacheable and none carries a CORS grant", async () => {
  const app = await harness({
    documents: [publication("a".repeat(32), { title: "Plan", ownerEmail: "owner@example.com" })],
  });
  const { cookies } = await app.signIn(personAt(ADMIN));
  for (const [route, path] of [
    [app.page, "/admin"],
    [app.documents, "/api/hosted/admin/documents"],
    [app.allowlist, "/api/hosted/admin/allowlist"],
  ]) {
    const response = await route(browserRequest(path, { cookies }));
    assert.match(response.headers.get("Cache-Control"), /no-store/, `${path} is not cached`);
    assert.equal(response.headers.get("access-control-allow-origin"), null, `${path} grants no CORS`);
  }
  assert.equal(APP_ORIGIN, HOSTED_ENV.HOSTED_APP_ORIGIN);
});
