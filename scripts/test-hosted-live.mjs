#!/usr/bin/env node
/**
 * AHU-013 — the live hosted acceptance preflight and read-only probe runner.
 *
 *   node scripts/test-hosted-live.mjs            # preflight only, contacts nothing
 *   node scripts/test-hosted-live.mjs probe      # preflight, then read-only HTTPS probes
 *
 * Every other runner in this repository proves application behaviour against
 * something the repository controls. This one cannot: the guarantees AHU-013
 * owns are the ones a fixture is structurally unable to stand in for -- GitHub's
 * own callback registration and granted scopes, Netlify's production routing and
 * conditional writes, two real HTTPS registrable sites, and installation of a
 * release an external consumer can actually reach. So this file does the two
 * things that *are* mechanisable without inventing a live result:
 *
 *   1. **The preflight gate.** It reads the operator-supplied description of the
 *      pilot and refuses, item by item, when a prerequisite is absent or does
 *      not satisfy the contract. An absent prerequisite is reported as
 *      `BLOCKED`, never as a skipped pass, and the process exits non-zero. This
 *      is what makes "the capstone is not closed yet" a machine-checkable state
 *      rather than a claim in a document.
 *   2. **Read-only deployed probes.** With every prerequisite supplied, `probe`
 *      makes unauthenticated GET requests to the two deployed origins and holds
 *      the responses against the header sets this repository actually generates
 *      -- `SECURITY_HEADERS` from `hosted/lib/http.mjs` and `rendererHeaders()`
 *      from `renderer/scripts/build.mjs`. No forked copy of either policy lives
 *      here, so a policy change fails this runner instead of drifting past it.
 *
 * What this runner deliberately does NOT do, because doing it would be inventing
 * a live result: sign in, hold a session, upload an artifact, approve a
 * publication, create or delete a provider resource, or drive a browser. Those
 * are the human-driven steps of
 * `docs/builds/agent-hosted-upload/live-acceptance.md`, and their outcomes are
 * recorded by hand in the dated evidence report. This runner marks each of them
 * `pending` in its manifest; nothing here can move one to `pass`.
 *
 * Secrets: `GITHUB_CLIENT_SECRET` belongs in the deployed site's environment and
 * nowhere else. This runner refuses to start if it can see one, refuses any
 * supplied value that looks like a credential, and writes no supplied value into
 * its manifest except non-secret identifiers -- the OAuth client id is recorded
 * as a digest, and the test accounts are operator-chosen opaque labels that may
 * not contain an address.
 *
 * Output contract: one `PASS  ` line per satisfied item and one final `PASS  `
 * line on stdout with exit 0, or one `BLOCKED  ` / `FAIL  ` line per unmet item
 * on stderr with exit 1 (exit 2 for an invalid command line).
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SECURITY_HEADERS } from "../hosted/lib/http.mjs";
import { registrableSite, validateOrigin, validateSessionResponse } from "../hosted/lib/contracts.mjs";
import { rendererHeaders } from "../renderer/scripts/build.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

/** The callback path C1 freezes. A registration at any other path is not this service. */
export const CALLBACK_PATH = "/api/hosted/auth/github/callback";

/** The single word an operator writes to say the empty-scope registration was verified. */
export const NO_SCOPES = "none";

/** The exact value that authorises the read-only probes to leave this machine. */
export const PROBE_AUTHORISATION = "operator-authorized";

/** Bounded response reading: a deployed origin is not trusted to be small. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 20_000;

/**
 * A value that must never be supplied to this runner.
 *
 * The list is prefixes rather than a general entropy test on purpose: a false
 * positive here is a refusal an operator cannot work around, and every one of
 * these is unambiguous. `GITHUB_CLIENT_SECRET` is checked separately by name,
 * because its value has no distinguishing prefix at all.
 */
const CREDENTIAL_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "nfp_"];

/**
 * The operator-supplied description of the pilot.
 *
 * These are acceptance inputs, not service configuration: the deployed service
 * reads C6's five keys out of its own site environment, and this runner never
 * sees them. The separate `HOSTED_LIVE_` prefix is what keeps the two sets from
 * being confused for one another -- a value here describes what an operator has
 * already provisioned, and setting one grants nothing.
 */
export const LIVE_ENV_KEYS = Object.freeze([
  "HOSTED_LIVE_APP_ORIGIN",
  "HOSTED_LIVE_RENDER_ORIGIN",
  "HOSTED_LIVE_OAUTH_CLIENT_ID",
  "HOSTED_LIVE_OAUTH_CALLBACK",
  "HOSTED_LIVE_OAUTH_SCOPES",
  "HOSTED_LIVE_ACCOUNTS",
  "HOSTED_LIVE_PACKAGE",
  "HOSTED_LIVE_PACKAGE_INTEGRITY",
  "HOSTED_LIVE_PACKAGE_SOURCE",
  "HOSTED_LIVE_SOURCE_REVISION",
  "HOSTED_LIVE_APP_DEPLOY",
  "HOSTED_LIVE_RENDER_DEPLOY",
  "HOSTED_LIVE_BUDGET_APPROVAL",
  "HOSTED_LIVE_RETENTION_OWNER",
  "HOSTED_LIVE_AHU012_REVISION",
]);

/** A 40-character git object name, and nothing shorter or prettier. */
const REVISION = /^[0-9a-f]{40}$/;

/** `@scope/name@1.2.3`: the exact release under test, never a floating range. */
const PACKAGE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The subresource integrity npm records for a tarball. */
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** An opaque operator-chosen label for a test identity. Never a login or an address. */
const ACCOUNT_LABEL = /^[a-z0-9][a-z0-9-]{1,31}$/;

/** A provider deployment identifier, kept opaque because its shape is the provider's. */
const DEPLOY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;

/** A GitHub OAuth application client id. Public, but recorded as a digest anyway. */
const CLIENT_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * The live guarantees AHU-013 must record a result for.
 *
 * `probe` items are decided by this runner. `runbook` items are decided by a
 * human following `docs/builds/agent-hosted-upload/live-acceptance.md`, and this
 * runner reports them as `pending` -- it has no way to observe them, and a
 * runner that could mark them `pass` would be the simulated live success the
 * ticket forbids.
 */
export const LIVE_GUARANTEES = Object.freeze([
  { id: "L1", by: "probe", waits: ["G2", "G6"], what: "deployed session endpoint answers anonymously with the hosted header set" },
  { id: "L2", by: "probe", waits: ["G2", "G6"], what: "deployed renderer serves the generated header set and sets no cookie" },
  { id: "L3", by: "probe", waits: ["G2", "G6"], what: "deployed viewer and metadata routes reveal nothing to a signed-out reader" },
  { id: "L4", by: "runbook", waits: ["G2", "G3", "G4"], what: "real GitHub sign-in: fixed callback, single-use state, PKCE, empty granted scopes" },
  { id: "L5", by: "runbook", waits: ["G2", "G3", "G4", "G5"], what: "installed released package and packaged skill drive a real publish (AE1)" },
  { id: "L6", by: "runbook", waits: ["G2", "G4", "G5"], what: "owner reads the artifact through the deployed renderer in a real browser" },
  { id: "L7", by: "runbook", waits: ["G2", "G4"], what: "a second real account is denied the same document" },
  { id: "L8", by: "runbook", waits: ["G2", "G6"], what: "real conditional-write race behaviour against deployed storage" },
  { id: "L9", by: "runbook", waits: ["G2", "G5"], what: "lost upload response recovers the same receipt" },
  { id: "L10", by: "runbook", waits: ["G2", "G7"], what: "publish-disabled transition refuses new work while private reads survive" },
  { id: "L11", by: "runbook", waits: ["G2", "G6"], what: "both per-IP rate rules accepted by the deploy and effective" },
  { id: "L12", by: "runbook", waits: ["G7"], what: "cleanup or intentional retention disposition of every generated record" },
]);

/**
 * The gate items each still-open guarantee is waiting on.
 *
 * A blocked capstone is only actionable if the operator can read, per
 * acceptance line, which prerequisite would release it. `waits` names the gate
 * items that must be met before the line can be attempted at all; this returns
 * the ones that are not met yet, so a line with an empty result is attemptable
 * and the run's remaining work is the runbook, not provisioning.
 */
export function guaranteesWaitingOn(preflight) {
  const unmet = new Set(preflight.items.filter((entry) => entry.status !== "met").map((entry) => entry.id));
  return LIVE_GUARANTEES.map(({ id, by, waits, what }) => ({
    id,
    by,
    what,
    waiting: waits.filter((gate) => unmet.has(gate)),
  }));
}

/* ------------------------------------------------------------------ *
 * Preflight.
 * ------------------------------------------------------------------ */

/** One preflight outcome. `detail` names a rule or a key, never a supplied value. */
function item(id, gate, status, detail) {
  return { id, gate, status, detail };
}

function met(id, gate, detail) {
  return item(id, gate, "met", detail);
}

function blocked(id, gate, detail) {
  return item(id, gate, "blocked", detail);
}

/**
 * A present, non-empty, credential-free value, or `null`.
 *
 * Absent and empty are one condition: an operator who has not set a key and one
 * who set it to the empty string have both not supplied it. A value carrying a
 * credential prefix throws rather than returning, because continuing would put
 * it on a code path that formats values.
 */
function supplied(env, key) {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  for (const prefix of CREDENTIAL_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      throw new Error(`${key} carries what looks like a provider credential; no acceptance input takes one`);
    }
  }
  return trimmed;
}

/** A production origin, or `null` when the value is not one. */
function productionOrigin(value) {
  try {
    return validateOrigin(value, { production: true, field: "origin" });
  } catch {
    return null;
  }
}

/**
 * Evaluate every gate item of the ticket's agent gate against a supplied
 * environment.
 *
 * Returns `{ok, items, facts}`. `facts` carries only what the manifest may
 * record: origins, registrable sites, revisions, the package identity and
 * digests. It never carries a secret, and the client id appears only as a
 * digest so no reader has to decide whether printing it was acceptable.
 */
export function evaluatePreflight(env) {
  const items = [];
  const facts = {};

  if (typeof env.GITHUB_CLIENT_SECRET === "string" && env.GITHUB_CLIENT_SECRET !== "") {
    items.push(
      item(
        "G0",
        "the OAuth client secret is installed server-side only",
        "failed",
        "GITHUB_CLIENT_SECRET is set in this runner's environment; it belongs in the deployed site and nowhere else",
      ),
    );
  } else {
    items.push(met("G0", "the OAuth client secret is installed server-side only", "no client secret is visible here"));
  }

  const values = {};
  const missing = [];
  for (const key of LIVE_ENV_KEYS) {
    const value = supplied(env, key);
    if (value === null) missing.push(key);
    values[key] = value;
  }
  if (missing.length > 0) {
    items.push(
      blocked(
        "G1",
        "every operator prerequisite is supplied",
        `not supplied: ${missing.join(", ")}`,
      ),
    );
  } else {
    items.push(met("G1", "every operator prerequisite is supplied", `${LIVE_ENV_KEYS.length} values supplied`));
  }

  /* Origins and the two-site separation. C1 makes this the property the whole
     cookie design rests on, and a sibling subdomain satisfies "two origins"
     while failing it, so the sites are compared rather than the hostnames. */
  const app = values.HOSTED_LIVE_APP_ORIGIN === null ? null : productionOrigin(values.HOSTED_LIVE_APP_ORIGIN);
  const render = values.HOSTED_LIVE_RENDER_ORIGIN === null ? null : productionOrigin(values.HOSTED_LIVE_RENDER_ORIGIN);
  if (app === null || render === null) {
    items.push(
      blocked(
        "G2",
        "two HTTPS origins on two different registrable sites",
        "both origins must be supplied as exact HTTPS origins with no path, port-only host or wildcard",
      ),
    );
  } else {
    const appSite = registrableSite(app);
    const renderSite = registrableSite(render);
    if (appSite === renderSite) {
      items.push(
        blocked(
          "G2",
          "two HTTPS origins on two different registrable sites",
          "both origins resolve to one registrable site; sibling subdomains share cookies and are not two sites",
        ),
      );
    } else {
      items.push(met("G2", "two HTTPS origins on two different registrable sites", `${appSite} and ${renderSite}`));
      facts.appOrigin = app;
      facts.renderOrigin = render;
      facts.appSite = appSite;
      facts.renderSite = renderSite;
    }
  }

  /* The OAuth registration. The callback is checked as an exact string against
     the app origin rather than parsed leniently: a registration that differs
     from the deployed origin by a trailing slash is a registration for a
     different service, and a wildcard is not a callback at all. */
  const callback = values.HOSTED_LIVE_OAUTH_CALLBACK;
  const clientId = values.HOSTED_LIVE_OAUTH_CLIENT_ID;
  const scopes = values.HOSTED_LIVE_OAUTH_SCOPES;
  if (app === null || callback === null || clientId === null || scopes === null) {
    items.push(blocked("G3", "dedicated OAuth application with the exact callback and empty scope", "not supplied"));
  } else if (callback !== `${app}${CALLBACK_PATH}`) {
    items.push(
      blocked(
        "G3",
        "dedicated OAuth application with the exact callback and empty scope",
        `the registered callback must be exactly <app origin>${CALLBACK_PATH}`,
      ),
    );
  } else if (scopes !== NO_SCOPES) {
    items.push(
      blocked(
        "G3",
        "dedicated OAuth application with the exact callback and empty scope",
        `HOSTED_LIVE_OAUTH_SCOPES must be "${NO_SCOPES}"; Archon requests no scope and must be granted none`,
      ),
    );
  } else if (!CLIENT_ID.test(clientId)) {
    items.push(
      blocked("G3", "dedicated OAuth application with the exact callback and empty scope", "the client id is malformed"),
    );
  } else {
    items.push(met("G3", "dedicated OAuth application with the exact callback and empty scope", "callback and scope agree with C1"));
    facts.callbackPath = CALLBACK_PATH;
    facts.clientIdDigest = createHash("sha256").update(clientId).digest("hex").slice(0, 16);
    facts.requestedScopes = NO_SCOPES;
  }

  /* Two test identities, named by opaque labels. A login or an address here
     would put a real person's identifier into an evidence file that is
     committed to a public repository. */
  const accounts = values.HOSTED_LIVE_ACCOUNTS === null ? [] : values.HOSTED_LIVE_ACCOUNTS.split(",").map((part) => part.trim());
  if (accounts.length !== 2) {
    items.push(
      blocked("G4", "two approved test identities in isolated browser profiles", "supply exactly two comma-separated labels"),
    );
  } else if (accounts[0] === accounts[1]) {
    items.push(blocked("G4", "two approved test identities in isolated browser profiles", "the two labels are identical"));
  } else if (!accounts.every((label) => ACCOUNT_LABEL.test(label))) {
    items.push(
      blocked(
        "G4",
        "two approved test identities in isolated browser profiles",
        "each label must be an opaque lowercase slug; a login or an address may not be recorded",
      ),
    );
  } else {
    items.push(met("G4", "two approved test identities in isolated browser profiles", `${accounts[0]} and ${accounts[1]}`));
    facts.accountLabels = accounts;
  }

  /* The release. `npm pack` output on this machine is not a release: AE1 is
     about what a consumer with no repository access can install, so a local
     path or a file: URL is refused however convenient it would be. */
  const pkg = values.HOSTED_LIVE_PACKAGE;
  const integrity = values.HOSTED_LIVE_PACKAGE_INTEGRITY;
  const source = values.HOSTED_LIVE_PACKAGE_SOURCE;
  if (pkg === null || integrity === null || source === null) {
    items.push(blocked("G5", "an externally installable release of the publisher package", "not supplied"));
  } else if (!PACKAGE.test(pkg)) {
    items.push(blocked("G5", "an externally installable release of the publisher package", "name the exact name@version under test"));
  } else if (!INTEGRITY.test(integrity)) {
    items.push(
      blocked("G5", "an externally installable release of the publisher package", "supply the tarball's sha512 integrity string"),
    );
  } else if (!source.startsWith("https://")) {
    items.push(
      blocked(
        "G5",
        "an externally installable release of the publisher package",
        "the install source must be an HTTPS URL a consumer without repository access can fetch",
      ),
    );
  } else {
    items.push(met("G5", "an externally installable release of the publisher package", pkg));
    facts.package = pkg;
    facts.packageIntegrity = integrity;
    facts.packageSource = source;
  }

  /* Frozen revisions. The AHU-012 local integration has to have passed at the
     same revision that is deployed, or "local integration is green" describes
     a different service from the one under test. */
  const revision = values.HOSTED_LIVE_SOURCE_REVISION;
  const local = values.HOSTED_LIVE_AHU012_REVISION;
  const appDeploy = values.HOSTED_LIVE_APP_DEPLOY;
  const renderDeploy = values.HOSTED_LIVE_RENDER_DEPLOY;
  if (revision === null || local === null || appDeploy === null || renderDeploy === null) {
    items.push(blocked("G6", "frozen source revision, deploy revisions and a passing AHU-012 at that revision", "not supplied"));
  } else if (!REVISION.test(revision) || !REVISION.test(local)) {
    items.push(
      blocked(
        "G6",
        "frozen source revision, deploy revisions and a passing AHU-012 at that revision",
        "revisions must be full 40-character commit ids",
      ),
    );
  } else if (revision !== local) {
    items.push(
      blocked(
        "G6",
        "frozen source revision, deploy revisions and a passing AHU-012 at that revision",
        "the AHU-012 pass is from a different revision than the one deployed",
      ),
    );
  } else if (!DEPLOY_ID.test(appDeploy) || !DEPLOY_ID.test(renderDeploy)) {
    items.push(
      blocked(
        "G6",
        "frozen source revision, deploy revisions and a passing AHU-012 at that revision",
        "both deploy identifiers must be supplied",
      ),
    );
  } else {
    items.push(met("G6", "frozen source revision, deploy revisions and a passing AHU-012 at that revision", revision));
    facts.sourceRevision = revision;
    facts.appDeploy = appDeploy;
    facts.renderDeploy = renderDeploy;
  }

  /* The approvals. These are the ones no amount of code can infer: a budget
     envelope somebody accepted, and a person who owns what the pilot leaves
     behind. C2 has no delete API, so "who owns the retained records" is a
     question with a person's name as its answer. */
  const budget = values.HOSTED_LIVE_BUDGET_APPROVAL;
  const retention = values.HOSTED_LIVE_RETENTION_OWNER;
  if (budget === null || retention === null) {
    items.push(blocked("G7", "an accepted pilot envelope and a named retention owner", "not supplied"));
  } else if (budget.length < 8 || retention.length < 2) {
    items.push(blocked("G7", "an accepted pilot envelope and a named retention owner", "both must name a real approval reference"));
  } else {
    items.push(met("G7", "an accepted pilot envelope and a named retention owner", "recorded"));
    facts.budgetApproval = budget;
    facts.retentionOwner = retention;
  }

  const ok = items.every((entry) => entry.status === "met");
  return { ok, items, facts };
}

/* ------------------------------------------------------------------ *
 * Read-only probes.
 * ------------------------------------------------------------------ */

/** A probe outcome, in the same vocabulary as a preflight item. */
function probe(id, what, status, detail) {
  return { id, what, status, detail };
}

/**
 * A bounded, credential-free GET.
 *
 * `redirect: "manual"` matters: a redirect is evidence about routing, and
 * following it would replace the response under test with a different one.
 * No cookie jar exists in `fetch`, so nothing this runner sends can carry a
 * session even by accident.
 */
async function get(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "*/*" },
    });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("the response exceeded the probe's byte ceiling");
    return { status: response.status, headers: response.headers, text: new TextDecoder().decode(buffer) };
  } finally {
    clearTimeout(timer);
  }
}

/** Every header of `expected` present with exactly that value, or a list of faults. */
export function headerFaults(headers, expected) {
  const faults = [];
  for (const [name, value] of expected) {
    const actual = headers.get(name);
    if (actual === null) faults.push(`${name} is absent`);
    else if (actual !== value) faults.push(`${name} does not match the generated policy`);
  }
  return faults;
}

/** The hosted response policy as name/value pairs, from the module production uses. */
export function hostedHeaderPairs() {
  return Object.entries(SECURITY_HEADERS);
}

/**
 * Drive the three read-only probes against a completed preflight.
 *
 * The document id is a random one that cannot exist, which is the whole point of
 * L3: an unknown id and another user's id have to be indistinguishable, and the
 * only one of those two a runner may request without touching a real record is
 * the unknown one.
 */
export async function probeDeployment(facts, { fetchImpl = fetch, documentId = null } = {}) {
  const results = [];
  const unknown = documentId ?? `probe${Math.random().toString(36).slice(2, 10)}`;

  try {
    const session = await get(`${facts.appOrigin}/api/hosted/session`, fetchImpl);
    const faults = headerFaults(session.headers, hostedHeaderPairs());
    if (session.status !== 200) {
      results.push(probe("L1", "deployed session endpoint", "fail", `answered ${session.status}`));
    } else if (faults.length > 0) {
      results.push(probe("L1", "deployed session endpoint", "fail", faults.join("; ")));
    } else {
      const body = validateSessionResponse(JSON.parse(session.text), { field: "session" });
      if (body.authenticated !== false) {
        results.push(probe("L1", "deployed session endpoint", "fail", "an anonymous request was answered as authenticated"));
      } else if (session.headers.get("set-cookie") !== null) {
        results.push(probe("L1", "deployed session endpoint", "fail", "an anonymous read was answered with a Set-Cookie"));
      } else {
        results.push(probe("L1", "deployed session endpoint", "pass", "anonymous, no cookie, full hosted header set"));
      }
    }
  } catch (error) {
    results.push(probe("L1", "deployed session endpoint", "fail", error.message.split("\n")[0]));
  }

  try {
    const shell = await get(`${facts.renderOrigin}/`, fetchImpl);
    const faults = headerFaults(shell.headers, rendererHeaders(facts.appOrigin));
    if (shell.status !== 200) {
      results.push(probe("L2", "deployed renderer shell", "fail", `answered ${shell.status}`));
    } else if (shell.headers.get("set-cookie") !== null) {
      results.push(probe("L2", "deployed renderer shell", "fail", "the cookie-free origin set a cookie"));
    } else if (faults.length > 0) {
      results.push(probe("L2", "deployed renderer shell", "fail", faults.join("; ")));
    } else {
      results.push(probe("L2", "deployed renderer shell", "pass", "generated header set served verbatim, no cookie"));
    }
  } catch (error) {
    results.push(probe("L2", "deployed renderer shell", "fail", error.message.split("\n")[0]));
  }

  try {
    const viewer = await get(`${facts.appOrigin}/docs/${unknown}`, fetchImpl);
    const meta = await get(`${facts.appOrigin}/api/hosted/docs/${unknown}`, fetchImpl);
    const content = await get(`${facts.appOrigin}/api/hosted/docs/${unknown}/content`, fetchImpl);
    const faults = [
      ...headerFaults(viewer.headers, hostedHeaderPairs()).map((fault) => `viewer: ${fault}`),
      ...headerFaults(meta.headers, hostedHeaderPairs()).map((fault) => `metadata: ${fault}`),
    ];
    if (meta.status === 200 || content.status === 200) {
      results.push(probe("L3", "signed-out private read", "fail", "a signed-out reader was answered with a document"));
    } else if (viewer.status >= 500) {
      results.push(probe("L3", "signed-out private read", "fail", `the viewer answered ${viewer.status}`));
    } else if (faults.length > 0) {
      results.push(probe("L3", "signed-out private read", "fail", faults.join("; ")));
    } else {
      results.push(
        probe("L3", "signed-out private read", "pass", `viewer ${viewer.status}, metadata ${meta.status}, content ${content.status}`),
      );
    }
  } catch (error) {
    results.push(probe("L3", "signed-out private read", "fail", error.message.split("\n")[0]));
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * Manifest.
 * ------------------------------------------------------------------ */

/**
 * The sanitized evidence manifest.
 *
 * Every guarantee appears with a status. A `runbook` guarantee is `pending`
 * whatever else happened, because this runner has no way to observe one and a
 * manifest that reported otherwise would be the simulated live success the
 * ticket forbids.
 */
export function buildManifest({ preflight, probes = [], now, mode }) {
  const byId = new Map(probes.map((entry) => [entry.id, entry]));
  return {
    v: 1,
    ticket: "AHU-013",
    mode,
    recordedAt: now,
    preflight: {
      ok: preflight.ok,
      items: preflight.items.map(({ id, gate, status, detail }) => ({ id, gate, status, detail })),
    },
    facts: preflight.facts,
    guarantees: guaranteesWaitingOn(preflight).map(({ id, by, what, waiting }) => {
      const observed = by === "probe" ? byId.get(id) : undefined;
      const status = by === "runbook" ? "pending" : observed ? observed.status : "blocked";
      return {
        id,
        by,
        what,
        status,
        waitingOn: waiting,
        detail: observed ? observed.detail : waiting.length > 0 ? `waits on ${waiting.join(", ")}` : "not observed",
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Entry point.
 * ------------------------------------------------------------------ */

/** Where the manifest is written, when an operator asked for one. */
function manifestPath(env) {
  const target = typeof env.HOSTED_LIVE_EVIDENCE === "string" ? env.HOSTED_LIVE_EVIDENCE.trim() : "";
  return target === "" ? null : resolve(ROOT, target);
}

export async function main(argv, env, { fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const mode = argv.length === 0 ? "preflight" : argv[0];
  if (argv.length > 1 || (mode !== "preflight" && mode !== "probe")) {
    process.stderr.write("usage: node scripts/test-hosted-live.mjs [preflight|probe]\n");
    return 2;
  }

  let preflight;
  try {
    preflight = evaluatePreflight(env);
  } catch (error) {
    process.stderr.write(`FAIL  live acceptance preflight: ${error.message.split("\n")[0]}\n`);
    return 1;
  }

  for (const entry of preflight.items) {
    if (entry.status === "met") process.stdout.write(`PASS  ${entry.id} ${entry.gate}\n`);
    else if (entry.status === "blocked") process.stderr.write(`BLOCKED  ${entry.id} ${entry.gate}: ${entry.detail}\n`);
    else process.stderr.write(`FAIL  ${entry.id} ${entry.gate}: ${entry.detail}\n`);
  }

  if (!preflight.ok) {
    /* An unmet gate is only useful to the operator alongside the acceptance
       lines it holds shut, so the two are printed together rather than leaving
       the mapping to be reconstructed from the runbook. */
    for (const entry of guaranteesWaitingOn(preflight)) {
      if (entry.waiting.length === 0) continue;
      process.stderr.write(`BLOCKED  ${entry.id} ${entry.what}: waits on ${entry.waiting.join(", ")}\n`);
    }
  }

  let probes = [];
  let failed = !preflight.ok;

  if (mode === "probe" && preflight.ok) {
    /* Leaving this machine is a separate permission from having the inputs that
       would make it possible. An operator who has described the pilot has not
       thereby asked for requests to be made against it. */
    if (env.HOSTED_LIVE_AUTHORIZED !== PROBE_AUTHORISATION) {
      process.stderr.write(
        `BLOCKED  P0 read-only probes are authorised: set HOSTED_LIVE_AUTHORIZED=${PROBE_AUTHORISATION} to contact the deployment\n`,
      );
      failed = true;
    } else {
      probes = await probeDeployment(preflight.facts, { fetchImpl });
      for (const entry of probes) {
        if (entry.status === "pass") process.stdout.write(`PASS  ${entry.id} ${entry.what}\n`);
        else {
          process.stderr.write(`FAIL  ${entry.id} ${entry.what}: ${entry.detail}\n`);
          failed = true;
        }
      }
    }
  } else if (mode === "probe") {
    process.stderr.write("BLOCKED  P0 read-only probes: the preflight did not pass, so nothing was contacted\n");
  }

  const target = manifestPath(env);
  if (target !== null) {
    const manifest = buildManifest({ preflight, probes, now: now(), mode });
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    process.stdout.write(`PASS  evidence manifest written\n`);
  }

  const pending = LIVE_GUARANTEES.filter((guarantee) => guarantee.by === "runbook").length;
  if (failed) {
    process.stderr.write(
      `FAIL  live acceptance is BLOCKED: ${preflight.items.filter((entry) => entry.status !== "met").length} gate items unmet\n`,
    );
    return 1;
  }
  process.stdout.write(
    `PASS  live acceptance preflight and ${probes.length} probes; ${pending} guarantees remain for the runbook\n`,
  );
  return 0;
}

/* Executed directly, never on import: the test suite drives the exported
   functions, and a module that ran its own main on import would make every
   import of it a live-acceptance attempt. */
if (process.argv[1] !== undefined && resolve(process.argv[1]) === SELF) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
