/**
 * The live acceptance gate can fail.
 *
 *   node --test scripts/test-hosted-live.test.mjs
 *
 * `scripts/test-hosted-live.mjs` is a refusal mechanism, and a refusal
 * mechanism that stops refusing is silent: an edit that loosened one rule would
 * turn "the capstone is blocked" into "the capstone passed" with every other
 * gate in this repository still green. So each rule the runner enforces is
 * driven here against a value that must not be accepted, and the happy-path
 * fixture next to it proves the rule is not simply refusing everything.
 *
 * Nothing here contacts a network. The probes take an injected `fetch`, so the
 * response policy assertions run against hand-built responses -- including the
 * ones a deployment must never produce, which cannot be arranged on a real
 * origin at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_PATH,
  LIVE_ENV_KEYS,
  LIVE_GUARANTEES,
  PLACEHOLDER_CLIENT_SECRET,
  PROBE_AUTHORISATION,
  buildManifest,
  evaluatePreflight,
  guaranteesWaitingOn,
  headerFaults,
  hostedHeaderPairs,
  main,
  probeDeployment,
} from "./test-hosted-live.mjs";

import { RENDERER_SHELL, RENDER_PREFIX, isRenderPrefix, rendererHeaders } from "../netlify/lib/edge-host.mjs";
import { readHostedConfig } from "../netlify/lib/hosted/config.mjs";

const APP = "https://app.example.com";
/* The renderer origin is the deployed shape -- the site's own `*.netlify.app`
   name -- so the fixtures here exercise the hostname pattern a real pilot has
   rather than a second documentation domain no deploy will ever use. */
const RENDER = "https://archon-example.netlify.app";
/* A third hostname routed to the same deployment. On Netlify the deploy
   permalink is always one, and the gate's rule for it is a bodyless 404. */
const FOREIGN = "https://deploy-preview-7--archon-example.netlify.app";

/** A complete, contract-satisfying operator description of a pilot. */
function completeEnv(overrides = {}) {
  const revision = "a".repeat(40);
  return {
    HOSTED_LIVE_APP_ORIGIN: APP,
    HOSTED_LIVE_RENDER_ORIGIN: RENDER,
    HOSTED_LIVE_FOREIGN_ORIGIN: FOREIGN,
    HOSTED_LIVE_AUTH0_DOMAIN: "archon-pilot.us.auth0.com",
    HOSTED_LIVE_AUTH0_CLIENT_ID: "exampleAuth0ClientId0000000000000",
    HOSTED_LIVE_AUTH0_CALLBACK: `${APP}${CALLBACK_PATH}`,
    HOSTED_LIVE_ACCOUNTS: "pilot-owner,pilot-other",
    HOSTED_LIVE_DOMAIN_ADMITTED: "pilot.example.com",
    HOSTED_LIVE_DOMAIN_REFUSED: "outside.example.org",
    HOSTED_LIVE_PACKAGE: "aiur-archon@0.1.0",
    HOSTED_LIVE_PACKAGE_INTEGRITY: `sha512-${"A".repeat(86)}==`,
    HOSTED_LIVE_PACKAGE_SOURCE: "https://registry.npmjs.org/aiur-archon/-/archon-0.1.0.tgz",
    HOSTED_LIVE_SOURCE_REVISION: revision,
    HOSTED_LIVE_APP_DEPLOY: "deploy-app-001",
    HOSTED_LIVE_BUDGET_APPROVAL: "pilot envelope accepted 2026-09-10",
    HOSTED_LIVE_RETENTION_OWNER: "pilot-operator",
    HOSTED_LIVE_AHU012_REVISION: revision,
    ...overrides,
  };
}

/** The one probe result with this id. */
function result(results, id) {
  const found = results.find((entry) => entry.id === id);
  assert.ok(found, `no probe result ${id}`);
  return found;
}

/** The one gate item with this id. */
function gate(result, id) {
  const found = result.items.find((entry) => entry.id === id);
  assert.ok(found, `no gate item ${id}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * The gate refuses an unprepared pilot.
 * ------------------------------------------------------------------ */

test("an empty environment blocks every prerequisite rather than skipping it", () => {
  const result = evaluatePreflight({});
  assert.equal(result.ok, false);
  const blocked = result.items.filter((entry) => entry.status === "blocked");
  assert.equal(blocked.length, result.items.length - 1, "only the secret-absence item may pass with nothing supplied");
  for (const entry of blocked) {
    assert.notEqual(entry.status, "skipped");
    assert.notEqual(entry.status, "met");
  }
  assert.deepEqual(result.facts, {}, "an unprepared pilot records no facts");
});

test("a complete operator description satisfies every gate item", () => {
  const result = evaluatePreflight(completeEnv());
  const unmet = result.items.filter((entry) => entry.status !== "met");
  assert.deepEqual(unmet, [], "the gate must be satisfiable, or it is only refusing everything");
  assert.equal(result.ok, true);
  assert.equal(result.facts.appSite, "example.com");
  assert.equal(result.facts.renderSite, "archon-example.netlify.app");
});

test("each prerequisite key is individually required", () => {
  for (const key of LIVE_ENV_KEYS) {
    const env = completeEnv();
    delete env[key];
    const result = evaluatePreflight(env);
    assert.equal(result.ok, false, `${key} is not required by the gate`);
    assert.match(gate(result, "G1").detail, new RegExp(key));
  }
});

test("an empty string is not a supplied prerequisite", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_RETENTION_OWNER: "   " }));
  assert.equal(result.ok, false);
  assert.match(gate(result, "G1").detail, /HOSTED_LIVE_RETENTION_OWNER/);
});

/* ------------------------------------------------------------------ *
 * C1's boundaries, item by item.
 * ------------------------------------------------------------------ */

test("a client secret in this runner's environment fails the gate", () => {
  const result = evaluatePreflight(completeEnv({ AUTH0_CLIENT_SECRET: "not-a-real-secret" }));
  assert.equal(result.ok, false);
  assert.equal(gate(result, "G0").status, "failed");
});

test("a supplied provider credential is refused before anything formats it", () => {
  assert.throws(
    () => evaluatePreflight(completeEnv({ HOSTED_LIVE_RETENTION_OWNER: "ghp_0123456789abcdef" })),
    /provider credential/,
  );
});

test("sibling subdomains are not two registrable sites", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_RENDER_ORIGIN: "https://render.example.com" }));
  assert.equal(result.ok, false);
  assert.match(gate(result, "G2").detail, /one registrable site/);
  /* The refusal has to explain itself in terms of the property at stake. An
     operator told only that two hostnames "are the same site" reads it as a
     naming quibble and reaches for a third subdomain; told that the two would
     share cookies, they reach for a different site. */
  assert.match(gate(result, "G2").detail, /cookies/);
});

test("the deployed *.netlify.app shape is two sites with a custom domain, without a new rule", () => {
  const result = evaluatePreflight(completeEnv());
  assert.equal(gate(result, "G2").status, "met");
  assert.equal(result.facts.appSite, "example.com");
  assert.equal(result.facts.renderSite, "archon-example.netlify.app");
});

test("two hostnames under one *.netlify.app name would still be one site", () => {
  /* `netlify.app` is a private public-suffix entry, so two names under it are two
     sites -- but two hostnames under *one* of those names are not, and that is
     the misconfiguration a "compare the last two labels" check would wave
     through in the opposite direction. */
  const app = "https://app.archon-example.netlify.app";
  const result = evaluatePreflight(
    completeEnv({
      HOSTED_LIVE_APP_ORIGIN: app,
      HOSTED_LIVE_RENDER_ORIGIN: "https://shell.archon-example.netlify.app",
      HOSTED_LIVE_AUTH0_CALLBACK: `${app}${CALLBACK_PATH}`,
    }),
  );
  assert.equal(result.ok, false);
  assert.match(gate(result, "G2").detail, /cookies/);
});

test("a plaintext origin is refused", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_APP_ORIGIN: "http://app.example.com" }));
  assert.equal(result.ok, false);
  assert.equal(gate(result, "G2").status, "blocked");
});

test("an origin carrying a path is not an origin", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_APP_ORIGIN: `${APP}/app` }));
  assert.equal(result.ok, false);
  assert.equal(gate(result, "G2").status, "blocked");
});

test("the callback must be the app origin's exact frozen path", () => {
  for (const callback of [
    `${APP}${CALLBACK_PATH}/`,
    `${APP}/api/hosted/auth/callback2`,
    `${APP}/callback`,
    `https://*.example.com${CALLBACK_PATH}`,
    `https://other.example.net${CALLBACK_PATH}`,
  ]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_AUTH0_CALLBACK: callback }));
    assert.equal(result.ok, false, `${callback} was accepted as the registered callback`);
    assert.equal(gate(result, "G3").status, "blocked");
  }
});

test("a tenant the deployed reader would refuse does not pass the gate", () => {
  /* The point is not that these particular spellings are wrong; it is that the
     gate asks `readHostedConfig` -- the reader the deployed site runs -- rather
     than a copy of its grammar. A tenant carrying a scheme or a path is a
     redirect-to-anywhere primitive behind a name that reads like a setting, and
     the gate must not be the one place that forgets it. */
  for (const tenant of [
    "https://archon-pilot.us.auth0.com",
    "archon-pilot.us.auth0.com/authorize",
    "archon-pilot.us.auth0.com:443",
    "auth0com",
    "ARCHON-PILOT.US.AUTH0.COM",
  ]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_AUTH0_DOMAIN: tenant }));
    assert.equal(result.ok, false, `${tenant} was accepted as a tenant`);
    assert.equal(gate(result, "G3").status, "blocked");
    assert.match(gate(result, "G3").detail, /AUTH0_DOMAIN/);
  }
});

test("a malformed client id is refused by the reader, not waved through", () => {
  for (const clientId of ["short", `x${"y".repeat(200)}`, "has spaces in it"]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_AUTH0_CLIENT_ID: clientId }));
    assert.equal(result.ok, false, `${clientId} was accepted as a client id`);
    assert.equal(gate(result, "G3").status, "blocked");
  }
});

test("the gate never asks an operator for the runner's own placeholder secret", () => {
  const result = evaluatePreflight(completeEnv());
  assert.equal(gate(result, "G3").status, "met");
  for (const entry of result.items) {
    assert.doesNotMatch(entry.detail, /AUTH0_CLIENT_SECRET/, `${entry.id} sends the operator looking for a secret`);
  }

  /* The assertion above only proves the happy path says nothing about a secret,
     which it would even with the branch that handles the case deleted. The
     branch exists for one condition -- the reader tightening its client-secret
     rule until this file's placeholder stops satisfying it -- so the thing to
     assert is that condition directly: the placeholder must remain acceptable
     to the reader, and the day it does not, this fails here rather than sending
     an operator to hunt for a secret the runner refuses to accept. */
  assert.doesNotThrow(
    () =>
      readHostedConfig({
        HOSTED_APP_ORIGIN: APP,
        HOSTED_RENDER_ORIGIN: RENDER,
        AUTH0_DOMAIN: "archon-pilot.us.auth0.com",
        AUTH0_CLIENT_ID: "exampleAuth0ClientId0000000000000",
        AUTH0_CLIENT_SECRET: PLACEHOLDER_CLIENT_SECRET,
        HOSTED_PUBLISH_ENABLED: "false",
      }),
    "the runner's placeholder no longer satisfies the deployed reader",
  );
});

test("the third hostname must be supplied and must be neither served hostname", () => {
  assert.equal(gate(evaluatePreflight(completeEnv()), "G8").status, "met");
  for (const origin of [APP, RENDER]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_FOREIGN_ORIGIN: origin }));
    assert.equal(result.ok, false, `${origin} was accepted as a hostname that must be refused`);
    assert.match(gate(result, "G8").detail, /served, not refused/);
  }
  for (const origin of ["http://preview.example.com", `${FOREIGN}/`, "not-an-origin"]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_FOREIGN_ORIGIN: origin }));
    assert.equal(result.ok, false, `${origin} was accepted as a third hostname`);
    assert.equal(gate(result, "G8").status, "blocked");
  }
});

test("the domain pair is judged by the deployed evaluator, and an admit is not a mailbox provider", () => {
  assert.equal(gate(evaluatePreflight(completeEnv()), "G9").status, "met");

  /* A list containing a public mailbox provider admits everyone with a mailbox.
     ACN-007's evaluator refuses it, and this gate refuses it for the same
     reason rather than a second one written here. */
  const mailbox = evaluatePreflight(completeEnv({ HOSTED_LIVE_DOMAIN_ADMITTED: "gmail.com" }));
  assert.equal(mailbox.ok, false, "a public mailbox provider was accepted as an admitted domain");
  assert.equal(gate(mailbox, "G9").status, "blocked");

  /* The same domain in the *refused* slot is the opposite case and must be
     accepted. It is the most likely address a real test account has, and it is
     exactly the reader a domain list exists to exclude, so refusing it here
     would leave L19's refusal half testing a domain nobody signs in from. */
  const refusedMailbox = evaluatePreflight(completeEnv({ HOSTED_LIVE_DOMAIN_REFUSED: "gmail.com" }));
  assert.equal(gate(refusedMailbox, "G9").status, "met", "a public mailbox provider must be usable as the unlisted domain");
  assert.equal(refusedMailbox.ok, true);
  assert.equal(refusedMailbox.facts.refusedDomain, "gmail.com");

  for (const overrides of [
    { HOSTED_LIVE_DOMAIN_REFUSED: "pilot.example.com" },
    { HOSTED_LIVE_DOMAIN_ADMITTED: "PILOT.EXAMPLE.COM", HOSTED_LIVE_DOMAIN_REFUSED: "pilot.example.com" },
  ]) {
    const result = evaluatePreflight(completeEnv(overrides));
    assert.equal(result.ok, false, `${JSON.stringify(overrides)} was accepted as an admit/refuse pair`);
    assert.match(gate(result, "G9").detail, /cannot be the same domain/);
  }

  for (const domain of ["not a domain", "example", "-bad.example.com", `${"a".repeat(300)}.example.com`]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_DOMAIN_REFUSED: domain }));
    assert.equal(result.ok, false, `${domain} was accepted as a domain`);
    assert.equal(gate(result, "G9").status, "blocked");
  }
});

test("a refused domain is named by its rule, never by the value the operator supplied", () => {
  /* `item()`'s contract is that a detail names a rule or a key and never a
     supplied value, and G9 is the one gate whose evaluator hands back the
     offending input. The mistake most likely to land here is an address typed
     into a domain slot -- so an echo would put a person's identifier into CI
     output, which is exactly what G4's opaque-label rule exists to prevent. */
  const address = "pilot.owner@example.com";
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_DOMAIN_ADMITTED: address }));
  assert.equal(result.ok, false);
  const detail = gate(result, "G9").detail;
  assert.match(detail, /invalid_domain/, "the refusal does not name the rule it applied");
  /* Sanitized or not: the evaluator strips `@`, so the bare local part and the
     bare host are both checked rather than only the address as typed. */
  for (const fragment of [address, "pilot.owner", "pilot.ownerexample.com"]) {
    assert.ok(!detail.includes(fragment), `G9 echoed the supplied value: ${detail}`);
  }
});

test("test identities are two distinct opaque labels", () => {
  for (const accounts of ["pilot-owner", "pilot-owner,pilot-owner", "owner@example.com,other@example.com", "a,b,c"]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_ACCOUNTS: accounts }));
    assert.equal(result.ok, false, `${accounts} was accepted as two approved identities`);
    assert.equal(gate(result, "G4").status, "blocked");
  }
});

test("a local tarball is not an externally installable release", () => {
  for (const source of [
    "file:///tmp/docbuild-0.1.0.tgz",
    "./docbuild-0.1.0.tgz",
    "http://registry.example.com/docbuild-0.1.0.tgz",
  ]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_PACKAGE_SOURCE: source }));
    assert.equal(result.ok, false, `${source} was accepted as a public install path`);
    assert.equal(gate(result, "G5").status, "blocked");
  }
});

test("the release must be an exact version with a tarball integrity", () => {
  for (const overrides of [
    { HOSTED_LIVE_PACKAGE: "aiur-archon@latest" },
    { HOSTED_LIVE_PACKAGE: "aiur-archon@^0.1.0" },
    { HOSTED_LIVE_PACKAGE_INTEGRITY: "sha1-abcdef" },
    { HOSTED_LIVE_PACKAGE_INTEGRITY: `sha512-${"A".repeat(40)}` },
  ]) {
    const result = evaluatePreflight(completeEnv(overrides));
    assert.equal(result.ok, false, `${JSON.stringify(overrides)} was accepted as a frozen release`);
    assert.equal(gate(result, "G5").status, "blocked");
  }
});

test("a local integration pass from another revision does not count", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_AHU012_REVISION: "b".repeat(40) }));
  assert.equal(result.ok, false);
  assert.match(gate(result, "G6").detail, /different revision/);
});

test("an abbreviated revision is not a frozen revision", () => {
  const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_SOURCE_REVISION: "abc1234", HOSTED_LIVE_AHU012_REVISION: "abc1234" }));
  assert.equal(result.ok, false);
  assert.equal(gate(result, "G6").status, "blocked");
});

test("the pilot envelope and the retention owner must both be named", () => {
  for (const overrides of [{ HOSTED_LIVE_BUDGET_APPROVAL: "ok" }, { HOSTED_LIVE_RETENTION_OWNER: "x" }]) {
    const result = evaluatePreflight(completeEnv(overrides));
    assert.equal(result.ok, false, `${JSON.stringify(overrides)} was accepted as an approval`);
    assert.equal(gate(result, "G7").status, "blocked");
  }
});

/* ------------------------------------------------------------------ *
 * The manifest records what happened and nothing else.
 * ------------------------------------------------------------------ */

test("the manifest never carries a client id or an approval secret in the clear", () => {
  const env = completeEnv();
  const preflight = evaluatePreflight(env);
  const manifest = buildManifest({ preflight, probes: [], now: "2026-09-10T00:00:00.000Z", mode: "preflight" });
  const serialised = JSON.stringify(manifest);
  assert.doesNotMatch(serialised, /Iv1\.0123456789abcdef/, "the OAuth client id was recorded in the clear");
  assert.match(manifest.facts.clientIdDigest, /^[0-9a-f]{16}$/);
});

test("a runbook guarantee stays pending no matter what the probes did", () => {
  const preflight = evaluatePreflight(completeEnv());
  const probes = LIVE_GUARANTEES.map(({ id }) => ({ id, what: "invented", status: "pass", detail: "invented" }));
  const manifest = buildManifest({ preflight, probes, now: "2026-09-10T00:00:00.000Z", mode: "probe" });
  for (const guarantee of manifest.guarantees) {
    if (guarantee.by === "runbook") {
      assert.equal(guarantee.status, "pending", `${guarantee.id} was reported from a probe result it cannot have`);
    }
  }
});

test("an unobserved probe guarantee is blocked, not passed", () => {
  const preflight = evaluatePreflight(completeEnv());
  const manifest = buildManifest({ preflight, probes: [], now: "2026-09-10T00:00:00.000Z", mode: "preflight" });
  for (const guarantee of manifest.guarantees) {
    if (guarantee.by === "probe") assert.equal(guarantee.status, "blocked");
  }
});

/* ------------------------------------------------------------------ *
 * Probes.
 * ------------------------------------------------------------------ */

/** A response with a chosen body and header set. */
function reply(body, headers, status = 200) {
  return new Response(body, { status, headers });
}

/** The hosted header set as a plain object, for building a compliant reply. */
function hostedHeaders(extra = {}) {
  return { ...Object.fromEntries(hostedHeaderPairs()), "content-type": "application/json; charset=utf-8", ...extra };
}

/** The renderer's generated header set as a plain object. */
function generatedRendererHeaders(extra = {}) {
  return { ...Object.fromEntries(rendererHeaders(APP)), "content-type": "text/html; charset=utf-8", ...extra };
}

/** The renderer host's bodyless 404 for anything that is not a shell path. */
function rendererRefusal() {
  return reply(null, { "cache-control": "private, no-store" }, 404);
}

/** The gate's bodyless, noindex 404 for a hostname it does not serve. */
function foreignRefusal() {
  return reply(null, { "x-robots-tag": "noindex", "cache-control": "private, no-store" }, 404);
}

/**
 * A deployment that answers every probe the way a correct one must.
 *
 * `overrides` is keyed by the exact request URL rather than by path, because the
 * matrix probe asks the same path of more than one hostname and a path-keyed
 * override could only plant a violation on all of them at once.
 */
function healthyDeployment(overrides = {}) {
  return (url) => {
    const { pathname: path, origin, search } = new URL(url);
    /* Cloned, because the matrix probe asks some URLs more than once and a
       `Response` body may only be read one time: an override handed back twice
       would fail the second probe with "body already read" and look like a
       policy violation the fixture never planted. */
    if (overrides[url] !== undefined) return Promise.resolve(overrides[url].clone());
    /* Path-keyed overrides are the application host's, so planting one cannot
       accidentally make the renderer host serve an application route -- which
       is itself a matrix violation, and would be one nobody asked for. */
    if (origin === APP && overrides[path] !== undefined) return Promise.resolve(overrides[path].clone());

    /* A third hostname routed here is a bodyless 404 the crawlers skip. */
    if (origin === FOREIGN) return Promise.resolve(foreignRefusal());

    if (origin === RENDER) {
      const shell = Object.prototype.hasOwnProperty.call(RENDERER_SHELL, path);
      if (!shell || (search !== "" && search !== "?")) return Promise.resolve(rendererRefusal());
      return Promise.resolve(reply("<!doctype html>", generatedRendererHeaders()));
    }

    /* The application host refuses the internal render prefix rather than
       serving artifact HTML as a first-party page on the account origin. */
    if (path === "/_render" || path.startsWith(RENDER_PREFIX)) {
      return Promise.resolve(reply(null, hostedHeaders(), 404));
    }
    if (path === "/api/hosted/session") {
      return Promise.resolve(reply(JSON.stringify({ v: 1, authenticated: false }), hostedHeaders()));
    }
    if (path.startsWith("/api/hosted/docs/")) {
      return Promise.resolve(reply(JSON.stringify({ v: 1, error: "not_found" }), hostedHeaders(), 404));
    }
    return Promise.resolve(reply("<!doctype html>not found", hostedHeaders({ "content-type": "text/html; charset=utf-8" }), 404));
  };
}

const FACTS = { appOrigin: APP, renderOrigin: RENDER, foreignOrigin: FOREIGN };

/** Every probe id, in the order `probeDeployment` decides them. */
const PROBE_IDS = ["L0", "L0b", "L0c", "L1", "L2", "L3"];

test("a correct deployment passes every probe", async () => {
  const results = await probeDeployment(FACTS, { fetchImpl: healthyDeployment(), documentId: "probe0000" });
  assert.deepEqual(
    results.map((entry) => [entry.id, entry.status]),
    PROBE_IDS.map((id) => [id, "pass"]),
  );
});

/* ------------------------------------------------------------------ *
 * L0: the renderer hostname answers on its own name.
 * ------------------------------------------------------------------ */

test("a renderer hostname that redirects to the primary domain fails loudly", async () => {
  for (const status of [301, 302, 307, 308]) {
    const fetchImpl = healthyDeployment({
      [`${RENDER}/`]: reply(null, { location: `${APP}/` }, status),
    });
    const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
    const l0 = result(results, "L0");
    assert.equal(l0.status, "fail", `a ${status} was not a failed gate`);
    /* A redirect is a failed gate, never a warning, and the text has to say what
       the operator must do: this is a topology decision, not a header fix. */
    assert.match(l0.detail, /topology is unavailable/);
    assert.match(l0.detail, new RegExp(String(status)));
    /* Named as a *redirect*, not merely as "not 200". The two need different
       operator actions -- a 503 is an outage to wait out, a 301 is a routing
       rule somebody added that has to be removed -- and a message that collapsed
       them would send the operator to retry a gate that will never pass. */
    assert.match(l0.detail, /and redirected/);
    assert.match(l0.detail, /stop and escalate/);

    /* And L0b explains itself rather than surfacing the consequence of L0's
       failure as a runner bug. Without its guard the comparison dereferences
       null, and the operator reads "Cannot read properties of null" next to a
       correct topology diagnosis. */
    assert.match(result(results, "L0b").detail, /needs L0's response/);
  }
});

test("a renderer hostname that answers anything but 200 fails the topology gate", async () => {
  const fetchImpl = healthyDeployment({ [`${RENDER}/`]: reply(null, {}, 503) });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  const l0 = result(results, "L0");
  assert.equal(l0.status, "fail");
  assert.match(l0.detail, /topology is unavailable/);
  /* And it is not reported as a redirect, which would be a different defect
     with a different fix. */
  assert.doesNotMatch(l0.detail, /redirected/);
});

test("a renderer hostname serving the application with a 200 fails L0", async () => {
  /* The failure a status-only check misses: a deployment that lost
     `HOSTED_RENDER_ORIGIN` classifies every host as "app", so the renderer
     hostname answers 200 with the application. */
  const fetchImpl = healthyDeployment({
    [`${RENDER}/`]: reply("<!doctype html>the app", hostedHeaders({ "content-type": "text/html; charset=utf-8" })),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L0").status, "fail");
  assert.match(result(results, "L0").detail, /may be serving the application/);
});

/* ------------------------------------------------------------------ *
 * L0b: the renderer hostname is cookie-free.
 * ------------------------------------------------------------------ */

test("a renderer hostname that answers differently when given a cookie fails", async () => {
  /* The second call is the one carrying the cookie, so a fixture that varies by
     call count is exactly a hostname that reads the credential. */
  let calls = 0;
  const healthy = healthyDeployment();
  const fetchImpl = (url, init) => {
    if (new URL(url).origin === RENDER && new URL(url).pathname === "/") {
      calls += 1;
      if (calls === 2) return Promise.resolve(reply("<!doctype html>signed in", generatedRendererHeaders()));
    }
    return healthy(url, init);
  };
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L0b").status, "fail");
  assert.match(result(results, "L0b").detail, /changed when a cookie was supplied/);
});

test("a renderer hostname that sets a cookie on a cookie-bearing request fails", async () => {
  let calls = 0;
  const healthy = healthyDeployment();
  const fetchImpl = (url, init) => {
    if (new URL(url).origin === RENDER && new URL(url).pathname === "/") {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve(reply("<!doctype html>", generatedRendererHeaders({ "set-cookie": "a=b" })));
      }
    }
    return healthy(url, init);
  };
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L0b").status, "fail");
  assert.match(result(results, "L0b").detail, /set a cookie/);
});

test("a renderer hostname that varies only its headers on a cookie fails", async () => {
  /* Same status, same bytes, a `Vary: Cookie` the cookie-free answer did not
     carry. The hostname read the credential; a body-only comparison calls this
     identical. */
  let calls = 0;
  const healthy = healthyDeployment();
  const fetchImpl = (url, init) => {
    if (new URL(url).origin === RENDER && new URL(url).pathname === "/") {
      calls += 1;
      if (calls === 2) {
        return Promise.resolve(reply("<!doctype html>", generatedRendererHeaders({ vary: "Cookie" })));
      }
    }
    return healthy(url, init);
  };
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L0b").status, "fail");
  assert.match(result(results, "L0b").detail, /headers changed when a cookie was supplied/);
});

test("both halves of the cookie comparison ask the origin, not a cache", async () => {
  const seen = [];
  const healthy = healthyDeployment();
  const fetchImpl = (url, init) => {
    if (new URL(url).origin === RENDER && new URL(url).pathname === "/") {
      seen.push(init.headers["cache-control"] ?? null);
    }
    return healthy(url, init);
  };
  await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.ok(seen.length >= 2, "L0 and L0b must each make a request");
  for (const value of seen.slice(0, 2)) {
    assert.equal(value, "no-cache", "a cached answer could stand in for the origin's");
  }
});

test("the cookie-free probe actually sends a cookie, or it proves nothing", async () => {
  const seen = [];
  const healthy = healthyDeployment();
  const fetchImpl = (url, init) => {
    if (new URL(url).origin === RENDER && new URL(url).pathname === "/") {
      seen.push(init.headers.cookie ?? null);
    }
    return healthy(url, init);
  };
  await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  const carried = seen.filter((value) => value !== null);
  assert.equal(carried.length, 1, "exactly one request must carry a cookie, or the comparison has no control");
  assert.match(carried[0], /^__Host-archon_session=/, "the planted cookie is not the session cookie's own name");
  assert.ok(seen.some((value) => value === null), "no request was made without a cookie to compare against");
});

/* ------------------------------------------------------------------ *
 * L0c: the host refusal matrix.
 * ------------------------------------------------------------------ */

test("the internal render prefix the probe asks about is one the gate refuses", () => {
  /* L0c carries a self-consistency fault for this, but that fault is only
     reachable when the invariant is already broken -- so it can never be driven
     from a fixture, and a deleted `isRenderPrefix` check would look tested.
     Asserted at the module instead, which is where the invariant lives. */
  assert.ok(isRenderPrefix(`${RENDER_PREFIX}index.html`), "the gate does not refuse its own internal render prefix");
  assert.ok(isRenderPrefix("/_render"));
  assert.ok(!isRenderPrefix("/docs/abc"), "an ordinary application path must not read as internal");
});

test("each violation of the host refusal matrix fails the matrix probe", async () => {
  const violations = [
    ["a renderer shell path that stopped being served", { [`${RENDER}/renderer.css`]: rendererRefusal() }, /renderer\.css/],
    [
      "a shell path served despite a query string",
      { [`${RENDER}/?probe=1`]: reply("<!doctype html>", generatedRendererHeaders()) },
      /with a query/,
    ],
    [
      "an application route answered on the renderer hostname",
      {
        [`${RENDER}/api/hosted/session`]: reply(JSON.stringify({ v: 1, authenticated: false }), hostedHeaders()),
      },
      /api\/hosted\/session/,
    ],
    [
      "a cookie set on a renderer-hostname refusal",
      { [`${RENDER}/docs/probe0000`]: reply(null, { "set-cookie": "a=b" }, 404) },
      /set a cookie/,
    ],
    [
      "artifact HTML served first-party on the application hostname",
      { [`${APP}${RENDER_PREFIX}index.html`]: reply("<!doctype html>", hostedHeaders()) },
      /never be first-party/,
    ],
    ["a third hostname that is served rather than refused", { [`${FOREIGN}/`]: reply("<!doctype html>", hostedHeaders()) }, /third hostname answered 200/],
    [
      "a third hostname refused but left indexable",
      { [`${FOREIGN}/`]: reply(null, { "cache-control": "private, no-store" }, 404) },
      /noindex/,
    ],
    [
      "a renderer refusal that renders a body",
      { [`${RENDER}/docs/probe0000`]: reply("<h1>Not found: probe0000</h1>", { "cache-control": "private, no-store" }, 404) },
      /404 with a body/,
    ],
    [
      "a renderer refusal that is not the gate's",
      { [`${RENDER}/api/hosted/session`]: reply(null, { "cache-control": "public, max-age=60" }, 404) },
      /not private, no-store/,
    ],
    [
      "a third hostname whose 404 is a stranger's rather than the gate's",
      { [`${FOREIGN}/`]: reply("not found", { "x-robots-tag": "noindex", "cache-control": "public, max-age=60" }, 404) },
      /actually routed to this deployment/,
    ],
  ];
  for (const [label, overrides, expected] of violations) {
    const results = await probeDeployment(FACTS, { fetchImpl: healthyDeployment(overrides), documentId: "probe0000" });
    const l0c = result(results, "L0c");
    assert.equal(l0c.status, "fail", `${label} passed the matrix probe`);
    assert.match(l0c.detail, expected, `${label} failed for the wrong reason`);
  }
});

test("a missing hosted security header fails the session probe", async () => {
  const headers = hostedHeaders();
  delete headers["cache-control"];
  const fetchImpl = healthyDeployment({
    "/api/hosted/session": reply(JSON.stringify({ v: 1, authenticated: false }), headers),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L1").status, "fail");
  assert.match(result(results, "L1").detail, /cache-control is absent/);
});

test("a session endpoint that authenticates an anonymous request fails", async () => {
  const fetchImpl = healthyDeployment({
    "/api/hosted/session": reply(
      JSON.stringify({ v: 1, authenticated: true, accountId: "gh_1", login: "someone", csrfToken: "t".repeat(43) }),
      hostedHeaders(),
    ),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L1").status, "fail");
});

test("a renderer that sets a cookie fails its probe", async () => {
  const fetchImpl = (url) =>
    new URL(url).origin === RENDER
      ? Promise.resolve(reply("<!doctype html>", generatedRendererHeaders({ "set-cookie": "a=b" })))
      : healthyDeployment()(url);
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L2").status, "fail");
  assert.match(result(results, "L2").detail, /cookie/);
});

test("a renderer whose frame-ancestors names another origin fails its probe", async () => {
  const headers = generatedRendererHeaders();
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(APP, "https://elsewhere.example.org");
  const fetchImpl = (url) =>
    new URL(url).origin === RENDER ? Promise.resolve(reply("<!doctype html>", headers)) : healthyDeployment()(url);
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L2").status, "fail");
});

test("a signed-out reader answered with a document fails the isolation probe", async () => {
  const fetchImpl = healthyDeployment({
    "/api/hosted/docs/probe0000": reply(JSON.stringify({ v: 1, documentId: "probe0000" }), hostedHeaders()),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(result(results, "L3").status, "fail");
  assert.match(result(results, "L3").detail, /signed-out/);
});

test("an unreachable origin is a failed probe, never an absent one", async () => {
  const results = await probeDeployment(FACTS, {
    fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    documentId: "probe0000",
  });
  assert.equal(results.length, PROBE_IDS.length);
  for (const entry of results) assert.equal(entry.status, "fail");
});

test("headerFaults names a header that differs rather than passing it", () => {
  const headers = new Headers({ "x-content-type-options": "sniff" });
  assert.deepEqual(headerFaults(headers, [["x-content-type-options", "nosniff"]]), [
    "x-content-type-options does not match the generated policy",
  ]);
  assert.deepEqual(headerFaults(new Headers({ "x-content-type-options": "nosniff" }), [["x-content-type-options", "nosniff"]]), []);
});

/* ------------------------------------------------------------------ *
 * The entry point.
 * ------------------------------------------------------------------ */

/** Run `main` with its output captured, so a test asserts on what an operator sees. */
async function run(argv, env, options = {}) {
  const out = [];
  const err = [];
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  try {
    const code = await main(argv, env, { now: () => "2026-09-10T00:00:00.000Z", ...options });
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

test("every guarantee waits on gate items the preflight actually reports", () => {
  const gates = new Set(evaluatePreflight({}).items.map((entry) => entry.id));
  for (const guarantee of LIVE_GUARANTEES) {
    assert.ok(guarantee.waits.length > 0, `${guarantee.id} names no gate item`);
    for (const gate of guarantee.waits) {
      assert.ok(gates.has(gate), `${guarantee.id} waits on ${gate}, which no gate item produces`);
    }
  }
});

test("with nothing supplied every acceptance line names the gates holding it shut", () => {
  const waiting = guaranteesWaitingOn(evaluatePreflight({}));
  assert.equal(waiting.length, LIVE_GUARANTEES.length);
  for (const entry of waiting) {
    assert.ok(entry.waiting.length > 0, `${entry.id} reads as attemptable with nothing provisioned`);
  }
});

test("a met gate stops holding its acceptance lines shut", () => {
  const waiting = guaranteesWaitingOn(evaluatePreflight(completeEnv()));
  for (const entry of waiting) {
    assert.deepEqual(entry.waiting, [], `${entry.id} still waits on ${entry.waiting.join(", ")}`);
  }
});

test("a blocked run prints the gate each open acceptance line waits on", async () => {
  const { err } = await run([], {});
  assert.match(err, /^BLOCKED {2}L5 .*: waits on G2, G3, G4, G5$/m);
  assert.match(err, /^BLOCKED {2}L18 .*: waits on G7$/m);
});

test("the manifest records the unmet gates per guarantee", () => {
  const manifest = buildManifest({
    preflight: evaluatePreflight({}),
    probes: [],
    now: "2026-09-10T00:00:00.000Z",
    mode: "preflight",
  });
  const l8 = manifest.guarantees.find((entry) => entry.id === "L8");
  assert.deepEqual(l8.waitingOn, ["G2", "G4", "G5"]);
  assert.match(l8.detail, /waits on G2, G4, G5/);
});

test("every acceptance line names the sub-assertions folded into it", () => {
  for (const guarantee of LIVE_GUARANTEES) {
    assert.ok(Array.isArray(guarantee.covers), `${guarantee.id} folds its sub-assertions into nothing`);
    assert.ok(guarantee.covers.length > 0, `${guarantee.id} names no sub-assertion`);
    for (const entry of guarantee.covers) {
      assert.equal(typeof entry, "string");
      assert.ok(entry.trim().length > 10, `${guarantee.id} carries a sub-assertion too short to check against`);
    }
  }
});

/* The one-for-one rule the ticket's live bullets impose. Each of these phrases
   belongs to a distinct live assertion of #176 that a twelve-row table left with
   no row and no gate: a run that recorded every row as passing would otherwise
   have closed the capstone with a third of it never attempted. The test is
   deliberately a text search over the whole table -- it does not care which row
   holds a phrase, only that no assertion is silently absent. */
test("every live assertion the ticket names has a row that claims it", () => {
  const table = LIVE_GUARANTEES.map((guarantee) => [guarantee.what, ...guarantee.covers].join(" ")).join(" ").toLowerCase();
  const required = [
    "a0_ digest",
    "descriptor in the completed record",
    "denied approval",
    "expired approval",
    "oversized",
    "original local html",
    "hostile fixture",
    "account origin",
    "failed-renderer",
    "self-navigation",
    "parallel identical uploads",
    "cancel racing an upload",
    "receipt window",
    "receipt expiry",
    "public blobs url",
    "static output",
    "test markers",
    "recorded privately",
    "keyboard alone",
    "sign-out",
    "accessible title",
    "screen reader",
    "fallback fonts",
    "account class",
    "enterprise-managed restriction",
    /* ACN-012's own additions. Each is a live assertion the single-site
       topology introduced, and each would otherwise be a row an operator could
       record as passing without a line to attempt. */
    "not redirected",
    "answered identically to one that carries none",
    "query string on one does not",
    "marked noindex",
    "google test account",
    "emailverified true",
    "google and github and nothing else",
    "username-password database connection is disabled",
    "admitted domain opens the document",
    "unlisted domain",
  ];
  for (const phrase of required) {
    assert.ok(table.includes(phrase), `no acceptance line claims the ticket's "${phrase}" assertion`);
  }
});

/**
 * The acceptance line ids, written out rather than generated.
 *
 * They used to be `L1..Ln` and could be checked arithmetically. They are not any
 * more: the single-site topology added gates *ahead* of the release-order table
 * (`L0`, `L0b`, `L0c`) and split one sign-in row into four (`L4`, `L4a`, `L4b`,
 * `L4c`), and renumbering the rest would have silently renamed every row an
 * operator and the committed AHU-013 evidence report already refers to by id.
 *
 * So the property is asserted as membership and order against this literal
 * instead of against a formula. That is stricter, not looser: a formula accepted
 * any contiguous run, and this accepts exactly one table.
 */
const ACCEPTANCE_LINE_IDS = Object.freeze([
  "L0",
  "L0b",
  "L0c",
  "L1",
  "L2",
  "L3",
  "L4",
  "L4a",
  "L4b",
  "L4c",
  "L5",
  "L6",
  "L7",
  "L8",
  "L9",
  "L10",
  "L11",
  "L12",
  "L13",
  "L14",
  "L15",
  "L16",
  "L17",
  "L18",
  "L19",
]);

test("acceptance line ids are unique and are exactly the published table", () => {
  const ids = LIVE_GUARANTEES.map((guarantee) => guarantee.id);
  assert.equal(new Set(ids).size, ids.length, "an acceptance line id is used twice");
  assert.deepEqual(ids, [...ACCEPTANCE_LINE_IDS]);
});

test("gate items print in gate order, and would still with a tenth gate", () => {
  const ids = evaluatePreflight({}).items.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))));
  assert.equal(ids[0], "G0", "the checklist does not start at its first item");

  /* The ordering an operator actually reads is numeric, not lexicographic. The
     two agree only while every id is single-digit, so the comparator is checked
     against a synthetic tenth gate rather than against the set that happens to
     exist today. */
  const withTenth = ["G10", "G2", "G0", "G9", "G1"].sort(
    (left, right) => Number(left.slice(1)) - Number(right.slice(1)),
  );
  assert.deepEqual(withTenth, ["G0", "G1", "G2", "G9", "G10"]);
});

test("every probe id is an acceptance line, and every other line is the runbook's", () => {
  const byId = new Map(LIVE_GUARANTEES.map((guarantee) => [guarantee.id, guarantee]));
  for (const id of PROBE_IDS) {
    assert.equal(byId.get(id)?.by, "probe", `${id} is probed but is not declared a probe line`);
  }
  for (const guarantee of LIVE_GUARANTEES) {
    if (guarantee.by === "probe") {
      assert.ok(PROBE_IDS.includes(guarantee.id), `${guarantee.id} claims to be probed but no probe decides it`);
    } else {
      assert.equal(guarantee.by, "runbook", `${guarantee.id} is decided by neither a probe nor the runbook`);
    }
  }
});

test("the manifest carries each guarantee's sub-assertion checklist", () => {
  const manifest = buildManifest({
    preflight: evaluatePreflight({}),
    probes: [],
    now: "2026-09-10T00:00:00.000Z",
    mode: "preflight",
  });
  for (const guarantee of manifest.guarantees) {
    const source = LIVE_GUARANTEES.find((entry) => entry.id === guarantee.id);
    assert.deepEqual(guarantee.covers, source.covers, `${guarantee.id} lost its checklist in the manifest`);
  }
});

test("with nothing supplied the run is BLOCKED and exits non-zero", async () => {
  const { code, out, err } = await run([], {});
  assert.equal(code, 1);
  assert.match(err, /^BLOCKED {2}G1/m);
  assert.match(err, /live acceptance is BLOCKED/);
  assert.doesNotMatch(out, /SKIP/);
});

test("probing without explicit authorisation contacts nothing", async () => {
  let called = 0;
  const { code, err } = await run(["probe"], completeEnv(), {
    fetchImpl: () => {
      called += 1;
      return Promise.reject(new Error("must not be called"));
    },
  });
  assert.equal(called, 0, "the deployment was contacted without authorisation");
  assert.equal(code, 1);
  assert.match(err, /HOSTED_LIVE_AUTHORIZED/);
});

test("an incomplete preflight contacts nothing even when authorised", async () => {
  let called = 0;
  const env = completeEnv({ HOSTED_LIVE_AUTHORIZED: PROBE_AUTHORISATION });
  delete env.HOSTED_LIVE_RETENTION_OWNER;
  const { code, err } = await run(["probe"], env, {
    fetchImpl: () => {
      called += 1;
      return Promise.reject(new Error("must not be called"));
    },
  });
  assert.equal(called, 0, "the deployment was contacted before the preflight passed");
  assert.equal(code, 1);
  assert.match(err, /nothing was contacted/);
});

test("an authorised probe of a correct deployment passes and still leaves the runbook pending", async () => {
  const { code, out } = await run(["probe"], completeEnv({ HOSTED_LIVE_AUTHORIZED: PROBE_AUTHORISATION }), {
    fetchImpl: healthyDeployment(),
  });
  assert.equal(code, 0);
  assert.match(out, /guarantees remain for the runbook/);
});

test("an unknown mode is a usage error, not a silent preflight", async () => {
  const { code } = await run(["live"], completeEnv());
  assert.equal(code, 2);
});
