# Live acceptance runbook — hosted owner publishing (AHU-013)

This is the procedure that closes AHU-013, and the only procedure that can. Every
other gate in this repository runs against something the repository controls: a
handler against an injected store, a client against a protocol fixture, a package
against a fixture service, and — in AHU-012 — all of them assembled together with
one deterministic identity provider upstream. None of that can say anything about
GitHub's registered callback, the scopes GitHub actually grants, Netlify's
production routing and conditional writes, two real HTTPS registrable sites, or
whether a consumer with no repository access can install the publisher at all.

Those are the guarantees below. A fixture result is not one of them.

**Nothing in this document authorises anything.** Provider signup, deployment,
OAuth registration, DNS, spending and package publication are operator decisions
taken elsewhere. This runbook describes what to do once they have been taken, and
what to record when they have not.

- Operator prerequisites and the deployment topology: [`hosted/OPERATIONS.md`](../../../hosted/OPERATIONS.md)
- Local integration this builds on: [`evidence/ahu-012-local-integration.md`](evidence/ahu-012-local-integration.md)
- Dated results: [`evidence/`](evidence/)

## 1. The gate comes first

Run the preflight before touching anything live:

```sh
npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
node scripts/test-hosted-live.mjs
```

With no prerequisites supplied it prints one `BLOCKED` line per unmet item and
exits non-zero. That is the correct result of an unprepared pilot, and it is what
CI runs on every build. An absent prerequisite is a **blocked** live guarantee,
never a skipped pass.

The runner reads its inputs from a `HOSTED_LIVE_*` environment. These are
*acceptance inputs*: they describe what an operator has already provisioned, and
setting one grants nothing and provisions nothing. They are deliberately separate
from the five C6 keys the deployed service reads out of its own site environment,
which this runner never sees.

| Variable | What it must be |
| --- | --- |
| `HOSTED_LIVE_APP_ORIGIN` | The deployed application origin. Exact HTTPS origin, no path. |
| `HOSTED_LIVE_RENDER_ORIGIN` | The deployed renderer origin. Must be a **different registrable site**, not a sibling subdomain. |
| `HOSTED_LIVE_OAUTH_CLIENT_ID` | The dedicated OAuth application's client id. Recorded only as a digest. |
| `HOSTED_LIVE_OAUTH_CALLBACK` | The URL registered with GitHub. Must equal `<app origin>/api/hosted/auth/github/callback` exactly. |
| `HOSTED_LIVE_OAUTH_SCOPES` | `none`. Archon requests no scope and must be granted none. |
| `HOSTED_LIVE_ACCOUNTS` | Two comma-separated opaque labels for the two test identities, e.g. `pilot-owner,pilot-other`. Never a login or an address. |
| `HOSTED_LIVE_PACKAGE` | The exact `name@version` under test. Not a tag, not a range. |
| `HOSTED_LIVE_PACKAGE_INTEGRITY` | The `sha512-…` integrity of that exact tarball. |
| `HOSTED_LIVE_PACKAGE_SOURCE` | An HTTPS URL a consumer without repository access can fetch. A `file:` path or local `npm pack` output is refused. |
| `HOSTED_LIVE_SOURCE_REVISION` | Full 40-character commit id of the deployed source. |
| `HOSTED_LIVE_APP_DEPLOY` / `HOSTED_LIVE_RENDER_DEPLOY` | The two provider deploy identifiers under test. |
| `HOSTED_LIVE_BUDGET_APPROVAL` | The accepted pilot traffic/cost envelope reference. |
| `HOSTED_LIVE_RETENTION_OWNER` | The named person accepting retention responsibility. C2 has no delete API. |
| `HOSTED_LIVE_AHU012_REVISION` | The revision at which AHU-012 passed. Must equal `HOSTED_LIVE_SOURCE_REVISION`. |

`GITHUB_CLIENT_SECRET` must **not** be present in the shell that runs this. It
belongs in the deployed site's environment and nowhere else; the runner fails if
it can see one, and refuses any supplied value carrying a provider-credential
prefix.

With every item met, the read-only probes are a separate permission:

```sh
HOSTED_LIVE_AUTHORIZED=operator-authorized \
HOSTED_LIVE_EVIDENCE=docs/builds/agent-hosted-upload/evidence/ahu-013-manifest.json \
  node scripts/test-hosted-live.mjs probe
```

The probes are unauthenticated GETs. They never sign in, upload, approve, create
or delete anything. They decide L1–L3 below; every other guarantee is decided by a
person following §3, and the runner reports those as `pending` no matter what —
there is no input that makes it claim otherwise.

## 2. Rules that hold for every step

**The agent does not sign in.** No agent may type the operator's GitHub password,
receive their session cookie, or drive their authenticated browser profile for
convenience. Browser sign-in and the approve/deny click are the human's steps. An
agent may prepare commands, read sanitized output, and record results.

**Use a disposable artifact.** The document published during acceptance must
contain no confidential source and no personal data. Give it a unique fixture
title so the record is identifiable later; C2 retains completed documents.

**Evidence is content-minimal and sanitized.** Record status, headers, timings,
opaque identifiers and digests. Never record an access token, a session cookie,
the `agentSecret`, a verification fragment, a full account API payload, a login,
an email address, or a machine path. Screenshots must be cropped to the region
being asserted and must not include a browser profile's account chrome.

**A log line is not evidence of what a person saw.** "render sent" does not prove
the artifact rendered, and a 403 in a log does not prove the second account saw a
not-found view. L6 and L7 are decided from actual rendered browser output.

**Bounded volume.** Keep to the operation count in the accepted envelope. No load
test, no unrelated account, no customer document.

## 3. The live guarantees

Each item names what to do, what decides it, and what to record. Record `pass`,
`fail` or `blocked` for every one — there is no fourth answer, and an item nobody
got to is `blocked`.

### L1 — deployed session endpoint (probe)

`GET <app>/api/hosted/session` with no cookie answers `{v:1,authenticated:false}`
with the full hosted header set (`private, no-store`, `Vary: Cookie`, `nosniff`,
`no-referrer`, `X-Frame-Options: DENY`, the deny-all CSP) and no `Set-Cookie`.
Decided by `node scripts/test-hosted-live.mjs probe`. Record the manifest entry.

### L2 — deployed renderer headers (probe)

`GET <render>/` serves exactly the header set `renderer/scripts/build.mjs`
generates for the configured app origin — including `frame-ancestors <app>` —
and sets no cookie. This is the deploy-routing assertion: the `_headers` file is
generated at build time, and only a real deploy proves the platform applied it.
Decided by the probe. Record the manifest entry.

### L3 — signed-out private read (probe)

`GET <app>/docs/<unknown-id>`, `GET <app>/api/hosted/docs/<unknown-id>` and
`…/content` reveal nothing to a signed-out reader: no document body, no title, the
private header set on each response. Decided by the probe against a random id that
cannot exist, which is the only id a runner may request without touching a real
record. The owner/other-account half of isolation is L7.

### L4 — real GitHub sign-in (human)

From the publisher CLI's start output, open the verification URL in a clean
browser profile signed in as the first test account.

Record, without collecting any token:

- the pairing code and descriptor shown before sign-in, and that the descriptor
  matches what the CLI sent;
- that the authorization request goes to GitHub's fixed endpoint and carries the
  dedicated client id, a `state`, and an S256 PKCE challenge;
- **the scopes GitHub's consent screen says are being granted** — this must be
  none, and this is the assertion no fixture can make;
- that the callback lands on `<app>/api/hosted/auth/github/callback` and that a
  replay of the same callback URL is refused (state is single-use);
- that the resulting session cookie is `__Host-archon_session` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain` (read from devtools; do
  not copy the value anywhere).

Then perform the real approve action and, separately, verify that a `GET` of the
approval URL alone never approves.

### L5 — installed release drives a real publish (human + agent, AE1)

In a clean directory with no repository access:

1. Install the exact `HOSTED_LIVE_PACKAGE` from `HOSTED_LIVE_PACKAGE_SOURCE`, and
   record the resolved integrity. If the only artifact available is a local
   `npm pack` tarball, L5 is **blocked**: AE1 is about what an external consumer
   can install.
2. Install and read the shipped skill by the supported instructions.
3. Ask Claude, following **only** the installed skill, to turn selected disposable
   test material into an Archon doc and publish it — build, start, checkpoint,
   resume. A human-authored CLI replay does not close this.
4. Resume in a **separate** client invocation and observe the durable receipt.
5. Retain the offline-readable HTML and record actual section navigation and theme
   rendering in the rendered output.

Record the tested GitHub account class. Do not claim managed-enterprise
compatibility unless a separately authorized managed-account test actually passed.

### L6 — the owner reads the artifact (human)

Signed in as the first account, open `<app>/docs/<id>`. Record from the rendered
browser output: the trusted shell's title and owner identity, the artifact
rendering inside the renderer frame, working fragment navigation within the
artifact, and that the artifact never replaces or resizes the trusted regions.
Record the network evidence that the content came from the same-origin content
route with `Content-Disposition: attachment` and `private, no-store` — and that no
public Blobs URL, CDN copy or redirect bearer appears anywhere in the transfer.

### L7 — a second real account is denied (human)

In a second isolated browser profile signed in as the second test account, open
the same `<app>/docs/<id>`. Record the rendered not-found view and that it is
indistinguishable from the view for an id that never existed. Record that the
metadata and content routes return no document body and no marker of the document
they refused.

### L8 — real conditional-write race (human)

Drive two concurrent decisions against one pending publication against the
deployed storage — the same operation from two windows, or two approve requests
issued together. Exactly one must win; the loser must be refused without
corrupting the record, and the completed record must be internally consistent
afterwards. This must exercise real Netlify conditional writes. A fixture ETag map
does not close L8.

### L9 — lost upload response recovers the same receipt (human)

Interrupt the upload **response** at a client-side proxy or interception layer
while the service commits — do not stop the service. Re-run the client with the
same private request file and record that it recovers the same receipt: same
document id, same content digest, no second document created.

### L10 — publish-disabled transition (human)

With the operator's authority, set `HOSTED_PUBLISH_ENABLED=false` on the deployed
site and redeploy per `hosted/OPERATIONS.md` §4. Record that new start and upload
requests are refused with 503, that existing private reads still work, and that a
completed receipt still recovers. Restore the previous value and record the
restoration.

### L11 — rate rules are accepted and effective (human)

Record the deploy log accepting **both** per-IP rules, and the effective deployed
configuration for the public start route and the agent status route. Record what
the platform actually enforced — this is a delayed best-effort mitigation, not a
hard quota, and the record must not claim otherwise.

### L12 — cleanup and retention disposition (human)

Name every resource the acceptance run created before removing anything. C2
retains completed documents and there is **no delete API**; do not invent one.
Either remove the named test records through the approved paused-maintenance
operator process of `hosted/OPERATIONS.md` §7 after verifying the exact targets,
or record their intentional retention against the named retention owner. Record
which of the two happened for each resource.

## 4. Recording the result

Write a dated report at
`docs/builds/agent-hosted-upload/evidence/ahu-013-<date>-live-acceptance.md`
containing:

- the frozen facts: package version and integrity, install source, source
  revision, both deploy identifiers, both origins and their registrable sites, the
  OAuth client id digest, and the account labels;
- one row per guarantee L1–L12 with `pass`, `fail` or `blocked` and the evidence
  it was decided from;
- the cleanup/retention disposition from L12;
- anything the run could not observe, stated as such.

Commit the machine-written manifest alongside it if one was produced. Keep both
sanitized: they are published in a public repository.

## 5. When something fails

A live failure is a real defect. Route it to the producer ticket that owns the
surface — or to a focused follow-up when no producer ticket does — with a
reproducible, sanitized reproduction. Do not repair a producer's behaviour inside
the acceptance runbook, and do not weaken an assertion to make a run finish.

AHU-013 closes only when every required live guarantee has a recorded `pass`.
Missing prerequisites leave it open; a passing fixture, a shipped runbook and a
green CI build are none of them the capstone outcome.
