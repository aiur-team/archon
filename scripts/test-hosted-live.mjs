#!/usr/bin/env node
/**
 * AHU-013 — the live hosted acceptance preflight and read-only probe runner.
 *
 *   node scripts/test-hosted-live.mjs            # preflight only, contacts nothing
 *   node scripts/test-hosted-live.mjs probe      # preflight, then read-only HTTPS probes
 *
 * Every other runner in this repository proves application behaviour against
 * something the repository controls. This one cannot: the guarantees AHU-013
 * owns are the ones a fixture is structurally unable to stand in for -- an Auth0
 * tenant's own connections and the claims they actually publish, Netlify's
 * production routing and conditional writes, one site answering on two real
 * hostnames, and installation of a release an external consumer can actually
 * reach. So this file does the two things that *are* mechanisable without
 * inventing a live result:
 *
 *   1. **The preflight gate.** It reads the operator-supplied description of the
 *      pilot and refuses, item by item, when a prerequisite is absent or does
 *      not satisfy the contract. An absent prerequisite is reported as
 *      `BLOCKED`, never as a skipped pass, and the process exits non-zero. This
 *      is what makes "the capstone is not closed yet" a machine-checkable state
 *      rather than a claim in a document.
 *   2. **Read-only deployed probes.** With every prerequisite supplied, `probe`
 *      makes unauthenticated GET requests to the site's hostnames and holds the
 *      responses against the policy this repository actually ships --
 *      `SECURITY_HEADERS` from `netlify/lib/hosted/http.mjs`, and
 *      `rendererHeaders()`, `RENDERER_SHELL` and `isRenderPrefix()` from
 *      `netlify/lib/edge-host.mjs`, which is the gate's own module and the one
 *      authority on which hostname serves what. No forked copy of either policy
 *      lives here, so a policy change fails this runner instead of drifting past
 *      it. In particular the host refusal matrix is *read* from the gate rather
 *      than restated, so a matrix nobody implements cannot survive here.
 *
 * What this runner deliberately does NOT do, because doing it would be inventing
 * a live result: sign in, hold a session, upload an artifact, approve a
 * publication, create or delete a provider resource, or drive a browser. Those
 * are the human-driven steps of
 * `docs/builds/agent-hosted-upload/live-acceptance.md`, and their outcomes are
 * recorded by hand in the dated evidence report. This runner marks each of them
 * `pending` in its manifest; nothing here can move one to `pass`.
 *
 * Secrets: `AUTH0_CLIENT_SECRET` belongs in the deployed site's environment and
 * nowhere else. This runner refuses to start if it can see one, refuses any
 * supplied value that looks like a credential, and writes no supplied value into
 * its manifest except non-secret identifiers -- the Auth0 client id and tenant
 * are recorded as digests, and the test accounts are operator-chosen opaque
 * labels that may not contain an address.
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

import { SECURITY_HEADERS } from "../netlify/lib/hosted/http.mjs";
import { registrableSite, validateOrigin, validateSessionResponse } from "../netlify/lib/hosted/contracts.mjs";
/* The header authority moved to the gate when the two deployments became one
   site on two hostnames: `renderer/scripts/build.mjs` still generates a header
   set for the build's own renderer oracle, but nothing it writes reaches the
   deployed site any more. Comparing a live response against the build's copy
   would therefore be comparing it against a policy the deploy does not use. */
import {
  RENDERER_SHELL,
  RENDER_PREFIX,
  isRenderPrefix,
  rendererHeaders,
} from "../netlify/lib/edge-host.mjs";
import { CALLBACK_PATH, SCOPE as AUTH0_SCOPE } from "../netlify/lib/hosted/auth0-oidc.mjs";
import { DomainAccessError, normalizeDomainList } from "../netlify/lib/hosted/domain-access.mjs";
import { HostedConfigError, readHostedConfig } from "../netlify/lib/hosted/config.mjs";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

/**
 * The callback path C1 freezes. A registration at any other path is not this
 * service.
 *
 * Re-exported from the module that builds the redirect URI, not written down
 * again: a forked copy would let the deployed callback move while this gate
 * stayed green, which is the one failure this gate exists to prevent. It keeps
 * its own name because the runner's suite and the runbook both refer to it.
 */
export { CALLBACK_PATH };

/**
 * The scope set this deployment requests of its Auth0 tenant, taken from the
 * module that requests it rather than written down again here.
 *
 * The previous runner froze an *empty* scope set, because the previous design
 * talked to GitHub directly and needed nothing from it. Brokering through Auth0
 * inverts that: the application asks for `openid profile email`, and the address
 * it gets back is what every domain check reads. An operator who leaves the
 * GitHub connection without `user:email` therefore gets a tenant that answers
 * correctly, a session with no verified address, and a domain gate that refuses
 * every reader for a reason no error message names. That is L4b, and no
 * acceptance input can decide it -- only a real round trip can.
 */
export const REQUESTED_SCOPE = AUTH0_SCOPE;

/**
 * A client secret shaped placeholder, used to run the operator's supplied tenant
 * and client id through `readHostedConfig` -- the reader the deployed site uses
 * -- instead of restating its rules here.
 *
 * It is a literal in this file and is never an operator value: G0 exists
 * precisely so that a real `AUTH0_CLIENT_SECRET` cannot be in this process at
 * all, and the reader needs *a* secret only to get far enough to judge the two
 * fields this gate is about.
 *
 * The `!` characters are load-bearing. The reader also refuses a secret equal to
 * the client id, and a client id is `[A-Za-z0-9._-]` — so a placeholder drawn
 * from that alphabet is one an operator could supply as their client id, at
 * which point the reader's refusal would be reported as a defect in this file
 * rather than as the operator's own duplicated value. A placeholder outside the
 * client-id alphabet cannot collide with one.
 */
export const PLACEHOLDER_CLIENT_SECRET = "placeholder!not!a!secret!0000";

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
 * these is unambiguous. `AUTH0_CLIENT_SECRET` is checked separately by name,
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
  "HOSTED_LIVE_FOREIGN_ORIGIN",
  "HOSTED_LIVE_AUTH0_DOMAIN",
  "HOSTED_LIVE_AUTH0_CLIENT_ID",
  "HOSTED_LIVE_AUTH0_CALLBACK",
  "HOSTED_LIVE_ACCOUNTS",
  "HOSTED_LIVE_DOMAIN_ADMITTED",
  "HOSTED_LIVE_DOMAIN_REFUSED",
  "HOSTED_LIVE_PACKAGE",
  "HOSTED_LIVE_PACKAGE_INTEGRITY",
  "HOSTED_LIVE_PACKAGE_SOURCE",
  "HOSTED_LIVE_SOURCE_REVISION",
  "HOSTED_LIVE_APP_DEPLOY",
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

/**
 * A provider deployment identifier, kept opaque because its shape is the
 * provider's. There is one of them now: the renderer is a second hostname of the
 * same site rather than a second deployment, so a second identifier would be
 * describing a second site the topology no longer has.
 */
const DEPLOY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{5,63}$/;

/**
 * The live guarantees AHU-013 must record a result for.
 *
 * `probe` items are decided by this runner. `runbook` items are decided by a
 * human following `docs/builds/agent-hosted-upload/live-acceptance.md`, and this
 * runner reports them as `pending` -- it has no way to observe them, and a
 * runner that could mark them `pass` would be the simulated live success the
 * ticket forbids.
 *
 * The table is the ticket's live assertions one for one. `covers` exists
 * because several of those assertions belong to one sitting at a browser -- the
 * hostile fixture's handshake, its blocked account-origin access and its
 * message contents are one session, not three -- and a row that folded them
 * silently would let an operator record twelve passes while a third of the
 * ticket went unattempted. Every folded assertion is named here, so `covers` is
 * the checklist the operator works through inside a row and the runbook section
 * for that row repeats it in procedure form.
 */
export const LIVE_GUARANTEES = Object.freeze([
  {
    id: "L0",
    by: "probe",
    waits: ["G2", "G6"],
    what: "the renderer hostname answers 200 on its own and is not redirected",
    covers: [
      "a GET of the renderer hostname's root answers 200, not a 3xx to the primary domain",
      "that answer carries the renderer shell's own policy rather than the application's",
    ],
  },
  {
    id: "L0b",
    by: "probe",
    waits: ["G2", "G6"],
    what: "the renderer hostname is cookie-free in both directions",
    covers: [
      "a request carrying a cookie is answered identically to one that carries none",
      "neither the cookie-bearing nor the cookie-free answer sets a cookie",
    ],
  },
  {
    id: "L0c",
    by: "probe",
    waits: ["G2", "G6", "G8"],
    what: "the host refusal matrix holds on both hostnames and on a third",
    covers: [
      "every renderer shell path answers on the renderer hostname, and a query string on one does not",
      "the renderer hostname refuses an application path with no cookie, no body and private no-store",
      "the application hostname refuses the internal render prefix",
      "a third hostname resolving to this deployment is a bodyless 404 marked noindex and private no-store",
    ],
  },
  {
    id: "L1",
    by: "probe",
    waits: ["G2", "G6"],
    what: "deployed session endpoint answers anonymously with the hosted header set",
    covers: [
      "an anonymous GET is answered {v:1,authenticated:false} with no Set-Cookie",
      "every header of the shipped hosted policy is present with its exact value",
    ],
  },
  {
    id: "L2",
    by: "probe",
    waits: ["G2", "G6"],
    what: "deployed renderer serves the generated header set and sets no cookie",
    covers: [
      "the generated header set, including frame-ancestors of the app origin, survives the deploy",
      "the cookie-free origin sets no cookie",
    ],
  },
  {
    id: "L3",
    by: "probe",
    waits: ["G2", "G6"],
    what: "deployed viewer and metadata routes reveal nothing to a signed-out reader",
    covers: [
      "viewer, metadata and content routes return no document body and no title",
      "the private header set is on each response",
    ],
  },
  {
    id: "L4",
    by: "runbook",
    waits: ["G2", "G3", "G4"],
    what: "real Auth0 sign-in: fixed callback, single-use state, PKCE, host-locked cookie",
    covers: [
      "the pairing code and descriptor shown before sign-in match what the client sent",
      "authorization goes to the tenant's own endpoint with the dedicated client id, a state and an S256 challenge",
      "the callback lands on the exact frozen path and a replay of it is refused",
      "the session cookie carries __Host- prefix, Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain",
      "a GET of the approval URL never approves and never logs out",
    ],
  },
  {
    id: "L4a",
    by: "runbook",
    waits: ["G2", "G3", "G4"],
    what: "an Auth0 round trip completes with the operator's Google test account",
    covers: [
      "the Google connection completes the round trip and the session is authenticated",
      "the account key derives from the Auth0 subject, not from the address",
    ],
  },
  {
    id: "L4b",
    by: "runbook",
    waits: ["G2", "G3", "G4"],
    what: "an Auth0 round trip completes with the GitHub test account and carries a verified email",
    covers: [
      "the GitHub connection completes the round trip and the session is authenticated",
      "the session body carries a non-null email with emailVerified true",
      "the two accounts resolve to two different account keys",
    ],
  },
  {
    id: "L4c",
    by: "runbook",
    waits: ["G3"],
    what: "the tenant's sign-in page offers exactly two providers and no password form",
    covers: [
      "Auth0's Universal Login for this application offers Google and GitHub and nothing else",
      "the default username-password database connection is disabled on the application",
      "no sign-up affordance is offered for a connection this deployment does not use",
    ],
  },
  {
    id: "L5",
    by: "runbook",
    waits: ["G2", "G3", "G4", "G5"],
    what: "installed released package and packaged skill drive a real publish (AE1)",
    covers: [
      "the exact release installs in a clean directory from a source needing no repository access",
      "the shipped skill installs and reads by its supported instructions",
      "Claude, following only that skill, builds, starts, checkpoints and resumes the publication",
      "a separate client invocation observes the durable receipt",
      "the retained HTML is offline-readable with working section navigation and theme rendering",
      "the tested upstream account class is recorded and no managed-enterprise claim is made without a separate authorized test",
      "an organization or enterprise-managed restriction is recorded as an observed limitation with the local artifact fallback",
    ],
  },
  {
    id: "L6",
    by: "runbook",
    waits: ["G2", "G3", "G4", "G5"],
    what: "the completed record matches the real brokered identity and the source bytes",
    covers: [
      "the persisted account key is the a0_ digest of the real Auth0 subject, not a login or an address",
      "the descriptor in the completed record matches what the client sent",
      "the recorded owner matches the account that signed in",
      "the stored HTML digest matches both the receipt and the local source bytes",
    ],
  },
  {
    id: "L7",
    by: "runbook",
    waits: ["G2", "G4", "G5"],
    what: "owner reads the artifact through the deployed renderer in a real browser",
    covers: [
      "the trusted shell shows the title and owner identity and the artifact renders inside the renderer frame",
      "fragment navigation works inside the artifact and the renderer never replaces it",
      "the artifact never replaces or resizes the trusted regions",
      "content arrives same-origin as an attachment with private no-store and nosniff",
    ],
  },
  {
    id: "L8",
    by: "runbook",
    waits: ["G2", "G4", "G5"],
    what: "signed-out and a second real account are denied the same document",
    covers: [
      "the second account's viewer response is indistinguishable from one for an id that never existed",
      "metadata and content routes leak no title, no bytes and no marker of the document they refused",
      "the signed-out view is the same not-found view",
    ],
  },
  {
    id: "L9",
    by: "runbook",
    waits: ["G2", "G4", "G5", "G6"],
    what: "no private artifact is reachable outside the owner-authorized route",
    covers: [
      "no public Blobs URL, CDN copy, redirect bearer or downloadable asset path appears in the transfer",
      "the deployment's published static output contains no private byte, on either hostname",
      "the content route without the session returns nothing",
    ],
  },
  {
    id: "L10",
    by: "runbook",
    waits: ["G2", "G5", "G6"],
    what: "real conditional-write race behaviour against deployed storage",
    covers: [
      "two parallel identical uploads leave exactly one winner and one durable document",
      "a cancel racing an upload resolves to one decision without corrupting the record",
      "two concurrent approvals of one pending publication leave exactly one winner",
      "the completed record's owner and bytes never change afterwards",
      "the race runs against real Netlify conditional writes, never a fixture ETag map",
    ],
  },
  {
    id: "L11",
    by: "runbook",
    waits: ["G2", "G5"],
    what: "ambiguous and lost responses recover the identical receipt",
    covers: [
      "the upload response is dropped at a client-side interception layer while the service commits",
      "the same private request file recovers the same document id and digest with no second document",
      "recovery still works after the upload deadline but within the receipt window",
      "the owner read survives receipt expiry, or that observation is scheduled and this assertion stays open",
    ],
  },
  {
    id: "L12",
    by: "runbook",
    waits: ["G2", "G4", "G5"],
    what: "denied, expired and invalid attempts leave no accessible partial record",
    covers: [
      "a denied approval leaves nothing readable",
      "an expired approval leaves nothing readable",
      "invalid, oversized and descriptor-mismatched uploads leave nothing readable",
      "the original local HTML remains available after every one of those failures",
    ],
  },
  {
    id: "L13",
    by: "runbook",
    waits: ["G2", "G4", "G5", "G6"],
    what: "the authorized hostile fixture stays contained in the deployed renderer",
    covers: [
      "the exact source and origin handshake holds: ready then render, configured origins and the parent window only",
      "the artifact cannot reach the account origin or mutate the trusted shell",
      "no session token, CSRF token, document id or account identity appears in any message",
      "the deployed CSP and frame headers are the generated ones",
      "the failed-renderer state is shown honestly rather than as a blank frame",
      "the C4 self-navigation and exfiltration limitation is recorded, with no network-proof claim",
    ],
  },
  {
    id: "L14",
    by: "runbook",
    waits: ["G2", "G7"],
    what: "publish-disabled transition refuses new work while private reads survive",
    covers: [
      "new start and upload requests are refused with 503",
      "an existing private owner read still works",
      "a completed receipt still recovers",
      "the agreed setting is restored and the restoration is recorded",
    ],
  },
  {
    id: "L15",
    by: "runbook",
    waits: ["G2", "G6"],
    what: "both per-IP rate rules accepted by the deploy and effective",
    covers: [
      "the deploy log accepts both rules",
      "the effective deployed configuration covers the public start route and the agent status route",
      "what the platform enforced is recorded as delayed best-effort, never as a hard global or account quota",
      "no unapproved load test is run to obtain it",
    ],
  },
  {
    id: "L16",
    by: "runbook",
    waits: ["G2", "G6", "G7"],
    what: "logs redact secrets and the owned test operations are counted privately",
    covers: [
      "planted test markers are searched for in the deployed logs",
      "no session token, agent secret, verification fragment, client secret or cookie value appears in them",
      "the count and identifiers of the operations this run owns are recorded privately, not in the public report",
    ],
  },
  {
    id: "L17",
    by: "runbook",
    waits: ["G2", "G4", "G5"],
    what: "the browser experience is accessible in real rendered output",
    covers: [
      "the approval is completed by keyboard alone",
      "reader sign-out is reachable and revokes the session",
      "the renderer frame has an accessible title and failure states are announced to a screen reader",
      "the artifact theme and its fallback fonts are readable, and loading and error states are visible",
    ],
  },
  {
    id: "L18",
    by: "runbook",
    waits: ["G7"],
    what: "cleanup or intentional retention disposition of every generated record",
    covers: [
      "every resource the run created is named before anything is removed",
      "each is either removed through the approved paused-maintenance process or recorded as intentionally retained",
      "no delete API is invented for the purpose",
    ],
  },
  {
    id: "L19",
    by: "runbook",
    waits: ["G2", "G4", "G9"],
    what: "the verified-email domain gate admits a listed reader and refuses an unlisted one",
    covers: [
      "a reader whose verified address is at the admitted domain opens the document",
      "a reader whose verified address is at the unlisted domain gets the same not-found view as an id that never existed",
      "the refusal reveals no title, no bytes and no marker of the document it refused",
    ],
  },
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
  return LIVE_GUARANTEES.map(({ id, by, waits, what, covers }) => ({
    id,
    by,
    what,
    covers,
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

  if (typeof env.AUTH0_CLIENT_SECRET === "string" && env.AUTH0_CLIENT_SECRET !== "") {
    items.push(
      item(
        "G0",
        "the Auth0 client secret is installed server-side only",
        "failed",
        "AUTH0_CLIENT_SECRET is set in this runner's environment; it belongs in the deployed site and nowhere else",
      ),
    );
  } else {
    items.push(met("G0", "the Auth0 client secret is installed server-side only", "no client secret is visible here"));
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

  /* The third hostname. One site answers on more names than the two it is
     configured with -- a deploy permalink always exists, and a domain alias
     usually does -- and the gate's rule for all of them is a bodyless 404. That
     rule is only *proved* against a name that is actually routed here, so the
     operator names one. A value equal to either configured origin would make the
     probe assert the refusal of a hostname that must instead be served, which is
     the exact inversion this gate exists to prevent. */
  const foreign =
    values.HOSTED_LIVE_FOREIGN_ORIGIN === null ? null : productionOrigin(values.HOSTED_LIVE_FOREIGN_ORIGIN);
  if (foreign === null) {
    items.push(
      blocked(
        "G8",
        "a third hostname that resolves to this deployment and must be refused",
        "supply an exact HTTPS origin; on Netlify the deploy permalink is always one",
      ),
    );
  } else if (app !== null && render !== null && (foreign === app || foreign === render)) {
    items.push(
      blocked(
        "G8",
        "a third hostname that resolves to this deployment and must be refused",
        "the third hostname must be neither the application nor the renderer hostname; those two are served, not refused",
      ),
    );
  } else {
    items.push(met("G8", "a third hostname that resolves to this deployment and must be refused", foreign));
    facts.foreignOrigin = foreign;
  }

  /* The Auth0 application. The callback is checked as an exact string against
     the app origin rather than parsed leniently: a registration that differs
     from the deployed origin by a trailing slash is a registration for a
     different service, and a wildcard is not a callback at all.

     The tenant and client id are judged by `readHostedConfig` -- the reader the
     deployed site itself uses -- rather than by a second copy of its grammar
     here, so a tenant spelling the deployment would refuse cannot pass this gate
     and a rule the reader drops cannot survive in this file. */
  const callback = values.HOSTED_LIVE_AUTH0_CALLBACK;
  const clientId = values.HOSTED_LIVE_AUTH0_CLIENT_ID;
  const tenant = values.HOSTED_LIVE_AUTH0_DOMAIN;
  const G3 = "a dedicated Auth0 application with the exact callback and the configured tenant";
  if (app === null || render === null || callback === null || clientId === null || tenant === null) {
    items.push(blocked("G3", G3, "not supplied"));
  } else if (callback !== `${app}${CALLBACK_PATH}`) {
    items.push(blocked("G3", G3, `the registered callback must be exactly <app origin>${CALLBACK_PATH}`));
  } else {
    let refusal = null;
    try {
      readHostedConfig({
        HOSTED_APP_ORIGIN: app,
        HOSTED_RENDER_ORIGIN: render,
        AUTH0_DOMAIN: tenant,
        AUTH0_CLIENT_ID: clientId,
        AUTH0_CLIENT_SECRET: PLACEHOLDER_CLIENT_SECRET,
        HOSTED_PUBLISH_ENABLED: "false",
      });
    } catch (error) {
      /* The reader's message is `<key> <rule>` and carries no supplied value, so
         it is safe to print verbatim. The one key it may name that the operator
         did not supply is the placeholder above; naming it would send an
         operator looking for a secret this runner refuses to accept, so it is
         reported as what it is -- a defect in this file. */
      if (error instanceof HostedConfigError && error.key === "AUTH0_CLIENT_SECRET") {
        refusal = "this runner's placeholder no longer satisfies the reader; fix PLACEHOLDER_CLIENT_SECRET";
      } else {
        refusal = error.message.split("\n")[0];
      }
    }
    if (refusal !== null) {
      items.push(blocked("G3", G3, `the deployed configuration reader refuses these values -- ${refusal}`));
    } else {
      items.push(met("G3", G3, `callback ${CALLBACK_PATH}, tenant accepted by the deployed reader`));
      facts.callbackPath = CALLBACK_PATH;
      facts.clientIdDigest = createHash("sha256").update(clientId).digest("hex").slice(0, 16);
      facts.tenantDigest = createHash("sha256").update(tenant).digest("hex").slice(0, 16);
      facts.requestedScope = REQUESTED_SCOPE;
    }
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

  /* The domain pair L19 is decided against. A domain is not an address and names
     no person, so unlike the account labels these are recorded as themselves.

     Both are judged by `normalizeDomainList` -- ACN-007's own evaluator -- rather
     than by a grammar written again here, so each is a domain the deployed owner
     UI would actually accept.

     The two slots are judged separately, because the evaluator's public-mailbox
     rule applies to only one of them. An *admitted* `gmail.com` is refused for
     the reason the product refuses it: a list containing it admits everyone with
     a mailbox, which is not a domain gate. A *refused* `gmail.com` is the
     opposite -- it is the single most likely address a real test account has,
     and it is exactly the reader a domain list exists to exclude. Judging the
     pair as one list would reject it and leave the operator testing L19's
     refusal half against a domain nobody signs in from. */
  const admitted = values.HOSTED_LIVE_DOMAIN_ADMITTED;
  const refused = values.HOSTED_LIVE_DOMAIN_REFUSED;
  const G9 = "a domain the owner list admits and a domain it refuses";
  if (admitted === null || refused === null) {
    items.push(blocked("G9", G9, "supply one domain to be admitted and one to be refused"));
  } else {
    let admittedDomain = null;
    let refusedDomain = null;
    let refusal = null;
    try {
      [admittedDomain] = normalizeDomainList([admitted]);
      [refusedDomain] = normalizeDomainList([refused], { allowPublicMailboxes: true });
    } catch (error) {
      /* The reason alone, never the offending value. `DomainAccessError.domain`
         is the operator's own input, and the mistake most likely to land here is
         an address typed into a domain slot -- which would put a person's
         identifier into CI output that G4's opaque-label rule exists to keep
         out. `item()`'s contract already says detail names a rule or a key and
         never a supplied value. */
      refusal = error instanceof DomainAccessError ? error.reason : error.message.split("\n")[0];
    }
    if (refusal !== null) {
      items.push(blocked("G9", G9, `the deployed domain evaluator refuses this pair -- ${refusal}`));
    } else if (admittedDomain === refusedDomain) {
      items.push(blocked("G9", G9, "the two domains normalise to one; an admit and a refuse cannot be the same domain"));
    } else {
      items.push(met("G9", G9, `${admittedDomain} admitted, ${refusedDomain} refused`));
      facts.admittedDomain = admittedDomain;
      facts.refusedDomain = refusedDomain;
    }
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
  if (revision === null || local === null || appDeploy === null) {
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
  } else if (!DEPLOY_ID.test(appDeploy)) {
    items.push(
      blocked(
        "G6",
        "frozen source revision, deploy revisions and a passing AHU-012 at that revision",
        "the deploy identifier is malformed",
      ),
    );
  } else {
    items.push(met("G6", "frozen source revision, deploy revisions and a passing AHU-012 at that revision", revision));
    facts.sourceRevision = revision;
    facts.appDeploy = appDeploy;
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

  /* Evaluated grouped by subject -- the third hostname beside the two it is not,
     the domain pair beside the identities that carry the addresses -- and
     reported in gate order, because the operator reads this as a numbered
     checklist and a list that jumped G2, G8, G3 would read as a missing item.

     Compared on the number rather than the string: a lexicographic sort agrees
     with a numeric one only while every id is single-digit, so it would start
     printing G0, G1, G10, G2 the first time a tenth gate is added -- which is
     the same missing-item reading this sort exists to prevent, arriving
     silently. */
  items.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));

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
 *
 * `extraHeaders` exists for exactly one caller: L0b plants a deliberately
 * invalid `__Host-archon_session` value to prove the renderer hostname does not
 * vary its answer on a cookie. It is not a way to authenticate a probe, and
 * there is nothing here to authenticate with -- this runner never signs in and
 * never holds a session, so the only cookie it can send is one it made up. A
 * second call site that passed a real credential would be a probe holding a
 * session, which the module docblock rules out.
 */
async function get(url, fetchImpl, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "*/*", ...extraHeaders },
    });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new Error("the response exceeded the probe's byte ceiling");
    return { status: response.status, headers: response.headers, text: new TextDecoder().decode(buffer) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Header names that legitimately differ between two identical requests.
 *
 * Everything else is compared, because "answered identically" has to mean the
 * headers too: a hostname that read a cookie and responded with a different
 * `Vary`, `Cache-Control` or CSP — while serving the same bytes — is still
 * reading a credential, and a comparison of status and body alone would call
 * that identical.
 */
const VOLATILE_HEADERS = new Set(["date", "age", "x-nf-request-id", "x-request-id", "content-length", "etag"]);

/** The comparable header set of a response, as a sorted, stable string. */
function stableHeaders(headers) {
  return [...headers]
    .filter(([name]) => !VOLATILE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .sort()
    .join("\n");
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

  /* L0 runs before anything else and owns the redirect verdict, because a
     renderer hostname that 301s to the primary domain is not a slow topology or
     a header regression -- it is the second-hostname design being unavailable,
     and every probe after it would be describing the application host while
     claiming to describe the renderer. `redirect: "manual"` is what makes the
     3xx observable at all; a following fetch would have reported the app's 200. */
  /* Both halves of L0b's comparison must reach the origin. The renderer shell
     ships `public, max-age=0, must-revalidate`, and a shell path carrying a
     query is 404 by design, so the probe cannot cache-bust by URL -- an edge
     cache could otherwise serve both requests from one stored answer and make
     them identical no matter what the origin would have done with the cookie.
     L0's response is the control, so it carries the same header. */
  const noCache = { "cache-control": "no-cache", pragma: "no-cache" };

  let rendererRoot = null;
  try {
    rendererRoot = await get(`${facts.renderOrigin}/`, fetchImpl, noCache);
    if (rendererRoot.status >= 300 && rendererRoot.status < 400) {
      results.push(
        probe(
          "L0",
          "renderer hostname answers directly",
          "fail",
          `the renderer hostname answered ${rendererRoot.status} and redirected: the second-hostname topology is unavailable, so stop and escalate rather than continuing`,
        ),
      );
      rendererRoot = null;
    } else if (rendererRoot.status !== 200) {
      results.push(
        probe(
          "L0",
          "renderer hostname answers directly",
          "fail",
          `the renderer hostname answered ${rendererRoot.status}: the second-hostname topology is unavailable`,
        ),
      );
      rendererRoot = null;
    } else {
      /* A 200 alone does not prove the renderer *shell* answered. A deployment
         that lost `HOSTED_RENDER_ORIGIN` classifies every host as "app" and
         would serve the application here with a cheerful 200 — so the row's
         second covers line is only true if something shell-specific is read.
         The renderer CSP is the cheapest such thing, and it is the gate's own. */
      const faults = headerFaults(rendererRoot.headers, [
        ["Content-Security-Policy", Object.fromEntries(rendererHeaders(facts.appOrigin))["Content-Security-Policy"]],
      ]);
      if (faults.length > 0) {
        results.push(
          probe(
            "L0",
            "renderer hostname answers directly",
            "fail",
            "answered 200 but not with the renderer shell's policy; the hostname may be serving the application",
          ),
        );
        rendererRoot = null;
      } else {
        results.push(probe("L0", "renderer hostname answers directly", "pass", "200 on its own name, not redirected, renderer shell"));
      }
    }
  } catch (error) {
    results.push(probe("L0", "renderer hostname answers directly", "fail", error.message.split("\n")[0]));
  }

  /* L0b. The renderer hostname is a different registrable site from the
     application, so a browser never sends it the application's `__Host-` cookie
     -- but that is a browser rule, and what this proves is the half the site
     owns: the hostname neither sets a cookie nor behaves differently when one
     arrives anyway. A hostname that varied its answer on a cookie would be
     reading a credential on the origin that frames hostile HTML. */
  try {
    const withCookie = await get(`${facts.renderOrigin}/`, fetchImpl, {
      ...noCache,
      cookie: "__Host-archon_session=probe-value-that-is-not-a-session",
    });
    if (rendererRoot === null) {
      results.push(probe("L0b", "renderer hostname is cookie-free", "fail", "the cookie-free comparison needs L0's response"));
    } else if (withCookie.headers.get("set-cookie") !== null || rendererRoot.headers.get("set-cookie") !== null) {
      /* Both responses, not just the cookie-bearing one. `covers` claims no
         answer from this hostname sets a cookie, and a check that looked only at
         the request carrying one would leave the claim undecided for the request
         that does not -- which is the ordinary case every reader makes. */
      results.push(probe("L0b", "renderer hostname is cookie-free", "fail", "the cookie-free origin set a cookie"));
    } else if (withCookie.status !== rendererRoot.status || withCookie.text !== rendererRoot.text) {
      results.push(
        probe("L0b", "renderer hostname is cookie-free", "fail", "the answer changed when a cookie was supplied"),
      );
    } else if (stableHeaders(withCookie.headers) !== stableHeaders(rendererRoot.headers)) {
      /* Same status, same bytes, different headers is the quiet version of the
         same defect: a `Vary: Cookie` or a per-cookie CSP means the hostname
         read the credential, and stopping at the body would have called it
         identical. */
      results.push(
        probe("L0b", "renderer hostname is cookie-free", "fail", "the response headers changed when a cookie was supplied"),
      );
    } else {
      results.push(probe("L0b", "renderer hostname is cookie-free", "pass", "identical answer with and without a cookie, none set"));
    }
  } catch (error) {
    results.push(probe("L0b", "renderer hostname is cookie-free", "fail", error.message.split("\n")[0]));
  }

  /* L0c. The matrix is read off `netlify/lib/edge-host.mjs` rather than written
     down again: the shell paths come from `RENDERER_SHELL`, the refused prefix
     from `RENDER_PREFIX`/`isRenderPrefix`, so a gate that stopped serving a path
     fails here instead of leaving this file asserting a policy nobody
     implements. */
  try {
    const faults = [];
    for (const path of Object.keys(RENDERER_SHELL)) {
      const shell = await get(`${facts.renderOrigin}${path}`, fetchImpl);
      if (shell.status !== 200) faults.push(`renderer ${path} answered ${shell.status}`);
    }
    /* A shell path with a query is not a shell path: `rendererRewriteTarget`
       refuses it so the renderer can refuse to mount against a URL carrying
       one. */
    const queried = await get(`${facts.renderOrigin}/?probe=1`, fetchImpl);
    if (queried.status !== 404) faults.push(`renderer / with a query answered ${queried.status}, not 404`);

    /* "A bodyless 404" is what the covers line claims, so the body is read. A
       404 that renders something -- a debug page, or an application 404 echoing
       the id it refused -- is a body on the origin that frames hostile HTML, and
       a status-only check would record the claim as satisfied. `private,
       no-store` is checked for the same reason: it is what the gate's own
       `notFoundRenderer()` emits, so its absence means something other than the
       gate answered. */
    for (const path of ["/api/hosted/session", `/docs/${unknown}`]) {
      const refused = await get(`${facts.renderOrigin}${path}`, fetchImpl);
      if (refused.status !== 404) faults.push(`renderer ${path} answered ${refused.status}, not 404`);
      if (refused.headers.get("set-cookie") !== null) faults.push(`renderer ${path} set a cookie`);
      if (refused.text !== "") faults.push(`renderer ${path} answered 404 with a body`);
      if (refused.headers.get("cache-control") !== "private, no-store") {
        faults.push(`renderer ${path} was not refused by the gate; its 404 is not private, no-store`);
      }
    }

    const internal = `${RENDER_PREFIX}index.html`;
    if (!isRenderPrefix(internal)) faults.push(`${internal} is not a render prefix the gate refuses`);
    const leaked = await get(`${facts.appOrigin}${internal}`, fetchImpl);
    if (leaked.status !== 404) {
      faults.push(`the application host served ${internal} with ${leaked.status}; artifact HTML must never be first-party there`);
    }

    /* The third hostname's 404 has to be *this gate's* 404. A hostname that is
       not routed here also answers 404, and a status-only check could not tell
       the two apart -- so the probe would record the foreign-host refusal as
       observed live while the gate never saw the request. `noindex` plus
       `private, no-store` plus an empty body is what `notFoundForeignHost()`
       emits, and a stranger's 404 does not carry that combination. */
    const third = await get(`${facts.foreignOrigin}/`, fetchImpl);
    if (third.status !== 404) faults.push(`the third hostname answered ${third.status}, not 404`);
    else if (third.headers.get("x-robots-tag") !== "noindex") faults.push("the third hostname's 404 is not marked noindex");
    else if (third.headers.get("cache-control") !== "private, no-store" || third.text !== "") {
      faults.push("the third hostname's 404 is not the gate's; supply a hostname that is actually routed to this deployment");
    }

    results.push(
      faults.length > 0
        ? probe("L0c", "host refusal matrix", "fail", faults.join("; "))
        : probe("L0c", "host refusal matrix", "pass", "shells served, app paths refused on the renderer, third hostname noindex 404"),
    );
  } catch (error) {
    results.push(probe("L0c", "host refusal matrix", "fail", error.message.split("\n")[0]));
  }

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
 * Every guarantee appears with its `covers` checklist and a status. A
 * `runbook` guarantee is `pending`
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
    guarantees: guaranteesWaitingOn(preflight).map(({ id, by, what, covers, waiting }) => {
      const observed = by === "probe" ? byId.get(id) : undefined;
      const status = by === "runbook" ? "pending" : observed ? observed.status : "blocked";
      return {
        id,
        by,
        what,
        covers,
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
