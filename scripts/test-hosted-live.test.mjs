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
  NO_SCOPES,
  PROBE_AUTHORISATION,
  buildManifest,
  evaluatePreflight,
  guaranteesWaitingOn,
  headerFaults,
  hostedHeaderPairs,
  main,
  probeDeployment,
} from "./test-hosted-live.mjs";

import { rendererHeaders } from "../renderer/scripts/build.mjs";

const APP = "https://app.example.com";
const RENDER = "https://render.example.net";

/** A complete, contract-satisfying operator description of a pilot. */
function completeEnv(overrides = {}) {
  const revision = "a".repeat(40);
  return {
    HOSTED_LIVE_APP_ORIGIN: APP,
    HOSTED_LIVE_RENDER_ORIGIN: RENDER,
    HOSTED_LIVE_OAUTH_CLIENT_ID: "Iv1.0123456789abcdef",
    HOSTED_LIVE_OAUTH_CALLBACK: `${APP}${CALLBACK_PATH}`,
    HOSTED_LIVE_OAUTH_SCOPES: NO_SCOPES,
    HOSTED_LIVE_ACCOUNTS: "pilot-owner,pilot-other",
    HOSTED_LIVE_PACKAGE: "@aiur-team/archon@0.1.0",
    HOSTED_LIVE_PACKAGE_INTEGRITY: `sha512-${"A".repeat(86)}==`,
    HOSTED_LIVE_PACKAGE_SOURCE: "https://registry.npmjs.org/@aiur-team/archon/-/archon-0.1.0.tgz",
    HOSTED_LIVE_SOURCE_REVISION: revision,
    HOSTED_LIVE_APP_DEPLOY: "deploy-app-001",
    HOSTED_LIVE_RENDER_DEPLOY: "deploy-render-001",
    HOSTED_LIVE_BUDGET_APPROVAL: "pilot envelope accepted 2026-09-10",
    HOSTED_LIVE_RETENTION_OWNER: "pilot-operator",
    HOSTED_LIVE_AHU012_REVISION: revision,
    ...overrides,
  };
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
  assert.equal(result.facts.renderSite, "example.net");
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
  const result = evaluatePreflight(completeEnv({ GITHUB_CLIENT_SECRET: "not-a-real-secret" }));
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
    `${APP}/api/hosted/auth/github/callback2`,
    `${APP}/callback`,
    `https://*.example.com${CALLBACK_PATH}`,
    `https://other.example.net${CALLBACK_PATH}`,
  ]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_OAUTH_CALLBACK: callback }));
    assert.equal(result.ok, false, `${callback} was accepted as the registered callback`);
    assert.equal(gate(result, "G3").status, "blocked");
  }
});

test("any granted scope at all blocks the gate", () => {
  for (const scopes of ["read:user", "user:email", "repo", ""]) {
    const result = evaluatePreflight(completeEnv({ HOSTED_LIVE_OAUTH_SCOPES: scopes }));
    assert.equal(result.ok, false, `${JSON.stringify(scopes)} was accepted as an empty scope`);
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
    { HOSTED_LIVE_PACKAGE: "@aiur-team/archon@latest" },
    { HOSTED_LIVE_PACKAGE: "@aiur-team/archon@^0.1.0" },
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

/** A deployment that answers every probe the way a correct one must. */
function healthyDeployment(overrides = {}) {
  return (url) => {
    const path = new URL(url).pathname;
    const origin = new URL(url).origin;
    if (overrides[path] !== undefined) return Promise.resolve(overrides[path]);
    if (origin === RENDER) return Promise.resolve(reply("<!doctype html>", generatedRendererHeaders()));
    if (path === "/api/hosted/session") {
      return Promise.resolve(reply(JSON.stringify({ v: 1, authenticated: false }), hostedHeaders()));
    }
    if (path.startsWith("/api/hosted/docs/")) {
      return Promise.resolve(reply(JSON.stringify({ v: 1, error: "not_found" }), hostedHeaders(), 404));
    }
    return Promise.resolve(reply("<!doctype html>not found", hostedHeaders({ "content-type": "text/html; charset=utf-8" }), 404));
  };
}

const FACTS = { appOrigin: APP, renderOrigin: RENDER };

test("a correct deployment passes all three probes", async () => {
  const results = await probeDeployment(FACTS, { fetchImpl: healthyDeployment(), documentId: "probe0000" });
  assert.deepEqual(
    results.map((entry) => [entry.id, entry.status]),
    [
      ["L1", "pass"],
      ["L2", "pass"],
      ["L3", "pass"],
    ],
  );
});

test("a missing hosted security header fails the session probe", async () => {
  const headers = hostedHeaders();
  delete headers["cache-control"];
  const fetchImpl = healthyDeployment({
    "/api/hosted/session": reply(JSON.stringify({ v: 1, authenticated: false }), headers),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(results[0].status, "fail");
  assert.match(results[0].detail, /cache-control is absent/);
});

test("a session endpoint that authenticates an anonymous request fails", async () => {
  const fetchImpl = healthyDeployment({
    "/api/hosted/session": reply(
      JSON.stringify({ v: 1, authenticated: true, accountId: "gh_1", login: "someone", csrfToken: "t".repeat(43) }),
      hostedHeaders(),
    ),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(results[0].status, "fail");
});

test("a renderer that sets a cookie fails its probe", async () => {
  const fetchImpl = (url) =>
    new URL(url).origin === RENDER
      ? Promise.resolve(reply("<!doctype html>", generatedRendererHeaders({ "set-cookie": "a=b" })))
      : healthyDeployment()(url);
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(results[1].status, "fail");
  assert.match(results[1].detail, /cookie/);
});

test("a renderer whose frame-ancestors names another origin fails its probe", async () => {
  const headers = generatedRendererHeaders();
  headers["Content-Security-Policy"] = headers["Content-Security-Policy"].replace(APP, "https://elsewhere.example.org");
  const fetchImpl = (url) =>
    new URL(url).origin === RENDER ? Promise.resolve(reply("<!doctype html>", headers)) : healthyDeployment()(url);
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(results[1].status, "fail");
});

test("a signed-out reader answered with a document fails the isolation probe", async () => {
  const fetchImpl = healthyDeployment({
    "/api/hosted/docs/probe0000": reply(JSON.stringify({ v: 1, documentId: "probe0000" }), hostedHeaders()),
  });
  const results = await probeDeployment(FACTS, { fetchImpl, documentId: "probe0000" });
  assert.equal(results[2].status, "fail");
  assert.match(results[2].detail, /signed-out/);
});

test("an unreachable origin is a failed probe, never an absent one", async () => {
  const results = await probeDeployment(FACTS, {
    fetchImpl: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    documentId: "probe0000",
  });
  assert.equal(results.length, 3);
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
    "numeric id",
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
  ];
  for (const phrase of required) {
    assert.ok(table.includes(phrase), `no acceptance line claims the ticket's "${phrase}" assertion`);
  }
});

test("acceptance line ids are unique and contiguous", () => {
  const ids = LIVE_GUARANTEES.map((guarantee) => guarantee.id);
  assert.equal(new Set(ids).size, ids.length, "an acceptance line id is used twice");
  assert.deepEqual(ids, LIVE_GUARANTEES.map((_, index) => `L${index + 1}`));
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
