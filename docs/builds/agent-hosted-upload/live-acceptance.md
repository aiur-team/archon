# Live acceptance runbook — hosted owner publishing (AHU-013)

This is the procedure that closes AHU-013, and the only procedure that can. Every
other gate in this repository runs against something the repository controls: a
handler against an injected store, a client against a protocol fixture, a package
against a fixture service, and — in AHU-012 — all of them assembled together with
one deterministic identity provider upstream. None of that can say anything about
the Auth0 tenant's registered callback, which connections it actually offers,
whether the GitHub connection publishes a verified address, Netlify's production
routing and conditional writes, one site answering on two real hostnames, or
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
npm ci --ignore-scripts --no-audit --no-fund
node scripts/test-hosted-live.mjs
```

With no prerequisites supplied it prints one `BLOCKED` line per unmet item and
exits non-zero. That is the correct result of an unprepared pilot, and it is what
CI runs on every build. An absent prerequisite is a **blocked** live guarantee,
never a skipped pass.

The runner reads its inputs from a `HOSTED_LIVE_*` environment. These are
*acceptance inputs*: they describe what an operator has already provisioned, and
setting one grants nothing and provisions nothing. They are deliberately separate
from the C6 keys the deployed service reads out of its own site environment,
which this runner never sees.

The topology they describe is **one Netlify site, answering on two hostnames**,
with one Auth0 tenant in front of it and two operator-owned test accounts behind
that. There is no second deployment and no second site; `hosted/OPERATIONS.md` §1
is the authority on the shape, and these inputs only describe the instance of it
that is under test.

| Variable | What it must be |
| --- | --- |
| `HOSTED_LIVE_APP_ORIGIN` | The application hostname — the site's primary custom domain. Exact HTTPS origin, no path. |
| `HOSTED_LIVE_RENDER_ORIGIN` | The renderer hostname — the site's own `<name>.netlify.app` name. Must be a **different registrable site** from the app, not a sibling subdomain. |
| `HOSTED_LIVE_FOREIGN_ORIGIN` | A **third** hostname that routes to this same deployment and must be refused. The deploy permalink `https://<deploy-id>--<site-name>.netlify.app` is always one. |
| `HOSTED_LIVE_AUTH0_DOMAIN` | The tenant, as a bare host — `your-tenant.us.auth0.com` or your custom domain. No scheme, port or path. Recorded only as a digest. |
| `HOSTED_LIVE_AUTH0_CLIENT_ID` | The dedicated Auth0 application's client id. Recorded only as a digest. |
| `HOSTED_LIVE_AUTH0_CALLBACK` | The callback URL registered on that application. Must equal `<app origin>/api/hosted/auth/callback` exactly. |
| `HOSTED_LIVE_ACCOUNTS` | Two comma-separated opaque labels for the two test identities, e.g. `pilot-owner,pilot-other`. Never a login or an address. |
| `HOSTED_LIVE_DOMAIN_ADMITTED` | The domain the test document's owner list admits. A domain, never an address; a public mailbox provider is refused. |
| `HOSTED_LIVE_DOMAIN_REFUSED` | A different domain that list does **not** admit, used for L19's refusal half. |
| `HOSTED_LIVE_PACKAGE` | The exact `name@version` under test. Not a tag, not a range. |
| `HOSTED_LIVE_PACKAGE_INTEGRITY` | The `sha512-…` integrity of that exact tarball. |
| `HOSTED_LIVE_PACKAGE_SOURCE` | An HTTPS URL a consumer without repository access can fetch. A `file:` path or local `npm pack` output is refused. |
| `HOSTED_LIVE_SOURCE_REVISION` | Full 40-character commit id of the deployed source. |
| `HOSTED_LIVE_APP_DEPLOY` | The provider deploy identifier under test. One deployment, one identifier. |
| `HOSTED_LIVE_BUDGET_APPROVAL` | The accepted pilot traffic/cost envelope reference. |
| `HOSTED_LIVE_RETENTION_OWNER` | The named person accepting retention responsibility. C2 has no delete API. |
| `HOSTED_LIVE_AHU012_REVISION` | The revision at which AHU-012 passed. Must equal `HOSTED_LIVE_SOURCE_REVISION`. |

The two Auth0 fields are judged by `netlify/lib/hosted/config.mjs` — the reader
the deployed site itself runs — so a tenant spelling the deployment would refuse
is refused here too, rather than passing a gate and failing at sign-in.

`AUTH0_CLIENT_SECRET` must **not** be present in the shell that runs this. It
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
or delete anything. They decide L0, L0b, L0c and L1–L3 below; every other
guarantee is decided by a person following §3, and the runner reports those as
`pending` no matter what — there is no input that makes it claim otherwise.

**L0 comes before everything.** If the renderer hostname redirects to the primary
domain, the second-hostname topology does not exist and no later result means
anything. That is a failed gate and an operator decision, never a warning to work
around: see `hosted/OPERATIONS.md` §1, "The `*.netlify.app` hostname must keep
answering directly".

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
not-found view. L7, L8, L13 and L17 are decided from actual rendered browser
output.

**Bounded volume.** Keep to the operation count in the accepted envelope. No load
test, no unrelated account, no customer document.

## 3. The live guarantees

Each item names what to do, what decides it, and what to record. Record `pass`,
`fail` or `blocked` for every one — there is no fourth answer, and an item nobody
got to is `blocked`.

The table is #176's live assertions one for one, plus the ones the single-site
topology added: L0, L0b and L0c for the two hostnames and the third, L4a, L4b and
L4c for the Auth0 round trip, and L19 for the domain gate. Row ids were **not**
renumbered when those were inserted, because the committed evidence files already
refer to the existing rows by id. Several of these assertions are
one person's session at a browser rather than three separate runs, so a row may
fold more than one; where it does, the **sub-assertions are listed in the row and
carried in the runner's `covers` field**, and each of them needs its own recorded
outcome inside that row's result. A row is `pass` only when every line under it
is.

Every item also waits on specific §1 gate items, and a blocked run prints that
mapping per line so an operator can read which prerequisite releases which
acceptance guarantee. The runner is the authority for it.

| Guarantee | Waits on | Released by |
| --- | --- | --- |
| L0, L0b, L1, L2, L3, L15 | G2, G6 | the site answering on both hostnames at a frozen revision |
| L0c | G2, G6, G8 | the above plus a third hostname routed to the same deployment |
| L4, L4a, L4b | G2, G3, G4 | the Auth0 application and the two test identities |
| L4c | G3 | the Auth0 application alone |
| L5, L6 | G2, G3, G4, G5 | all of the above plus a published release |
| L7, L8, L12, L17 | G2, G4, G5 | the site, an identity and the released package |
| L9, L13 | G2, G4, G5, G6 | the above at a frozen deployed revision |
| L10 | G2, G5, G6 | the site at a frozen revision and the released package |
| L11 | G2, G5 | the site and the released package |
| L14 | G2, G7 | the site and the accepted pilot envelope |
| L16 | G2, G6, G7 | the site plus the accepted envelope and retention owner |
| L18 | G7 | the named retention owner |
| L19 | G2, G4, G9 | the site, an identity and the admit/refuse domain pair |

### L0 — the renderer hostname answers on its own name (probe)

`GET <render>/` answers **200**, not a 3xx to the primary domain. Netlify does not
redirect a site's `*.netlify.app` name by default, and that non-redirect is the
renderer hostname's whole basis. A redirect here is a **failed gate**: stop, do
not record the later rows, and escalate — the topology needs an operator decision
before any of this procedure is valid.

### L0b — the renderer hostname is cookie-free (probe)

The probe asks `<render>/` twice, once carrying a `__Host-archon_session` cookie
value that is not a session. Both answers must be identical and neither may carry
a `Set-Cookie`. A hostname whose answer varies on a cookie is reading a
credential on the origin that frames hostile HTML. (That a browser never *sends*
the application's `__Host-` cookie to this hostname is the two-registrable-sites
property G2 refuses to start without, plus the cookie's own prefix; L4 records
the prefix from devtools.)

### L0c — the host refusal matrix (probe)

Read from `netlify/lib/edge-host.mjs`, which is the gate's own module and the one
authority on which hostname serves what:

- every renderer shell path answers 200 on `<render>`, and one with a query
  string does not;
- `<render>` refuses an application path — `/api/hosted/session`, `/docs/<id>` —
  with a bodyless 404 and no `Set-Cookie`;
- `<app>` refuses the internal `/_render/` prefix, so artifact HTML is never a
  first-party page on the account origin;
- `<foreign>` — the third hostname — is a bodyless 404 carrying
  `X-Robots-Tag: noindex`.

A hostname serving something it must not is a failure, whichever direction it
goes in.

### L1 — deployed session endpoint (probe)

`GET <app>/api/hosted/session` with no cookie answers `{v:1,authenticated:false}`
with the full hosted header set (`private, no-store`, `Vary: Cookie`, `nosniff`,
`no-referrer`, `X-Frame-Options: DENY`, the deny-all CSP) and no `Set-Cookie`.
Decided by `node scripts/test-hosted-live.mjs probe`. Record the manifest entry.

### L2 — deployed renderer headers (probe)

`GET <render>/` serves exactly the header set `netlify/lib/edge-host.mjs`
generates for the configured app origin — including `frame-ancestors <app>` —
and sets no cookie. This is the deploy-routing assertion, and the edge gate is
now the one place that emits it: `netlify.toml` declares no security header and
the renderer build writes no `_headers` beside the shell it publishes, because
only the gate can tell which of the two hostnames a request arrived on. Decided
by the probe. Record the manifest entry.

### L3 — signed-out private read (probe)

`GET <app>/docs/<unknown-id>`, `GET <app>/api/hosted/docs/<unknown-id>` and
`…/content` reveal nothing to a signed-out reader: no document body, no title, the
private header set on each response. Decided by the probe against a random id that
cannot exist, which is the only id a runner may request without touching a real
record. The owner/other-account half of isolation is L8.

### L4 — real Auth0 sign-in (human)

From the publisher CLI's start output, open the verification URL in a clean
browser profile signed in as the first test account.

Record, without collecting any token:

- the pairing code and descriptor shown before sign-in, and that the descriptor
  matches what the CLI sent;
- that the authorization request goes to the tenant's own `/authorize` endpoint
  and carries the dedicated client id, a `state`, and an S256 PKCE challenge;
- that the callback lands on `<app>/api/hosted/auth/callback` and that a replay
  of the same callback URL is refused (state is single-use);
- that the resulting session cookie is `__Host-archon_session` with `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/` and no `Domain` (read from devtools; do
  not copy the value anywhere) — the `__Host-` prefix forbids `Domain`, which is
  what keeps the cookie off the renderer hostname;
- that a `GET` of the approval URL alone never approves and never logs out.

Then perform the real approve action.

### L4a — the Google connection completes a round trip (human)

Sign in with the operator's **Google** test account and record that the session
becomes authenticated and that the persisted account key is the `a0_` digest of
the Auth0 subject rather than anything derived from the address. This is the
assertion a fixture cannot make: the loopback runner's tenant stand-in answers
whatever it is asked, and only the real tenant proves the connection is enabled
and configured with the operator's own Google application.

### L4b — the GitHub connection carries a verified email (human)

Sign in with the operator's **GitHub** test account, in a second isolated
profile, and record from `GET <app>/api/hosted/session`:

- `authenticated` is `true`;
- `email` is **not null** and `emailVerified` is `true`.

This is the row that catches the single most silent misconfiguration in the whole
setup. Archon requests `openid profile email`, but Auth0 can only publish a
GitHub address if the GitHub connection was given the `user:email` scope. Without
it the tenant answers correctly, the session is valid, and **every domain check
refuses every reader** with a reason no error message names. A failure here is
that scope, not the domain list.

Record also that the two test accounts resolve to two different account keys.

### L4c — the tenant offers exactly two providers (human)

On the tenant's Universal Login screen for this application, record that the only
choices offered are **Google** and **GitHub**, that the default
`Username-Password-Authentication` database connection is disabled on the
application, and that no sign-up affordance is offered for a connection this
deployment does not use. A connection left enabled is a login path nobody
reviewed. Decided from the rendered screen, not from the tenant's settings page
alone.

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
If an organization restriction or an enterprise-managed account blocks the flow,
that is an **observed limitation** recorded with the local artifact fallback that
still works — never a reason to ask anyone to weaken an IT control.

### L6 — the completed record matches the real identity and the source (human)

From the completed record and the receipt, with evidence kept content-minimal:

- the persisted account key is `a0_<digest of the Auth0 subject>` and derives
  from that subject — a login or an address is not an ownership key, and a
  rename of the test account, or a change of its address, must not change it;
- the descriptor stored in the completed record is the one the client sent;
- the recorded owner is the account that actually signed in;
- the stored HTML digest equals both the receipt's `contentSha256` and the digest
  of the local source bytes.

### L7 — the owner reads the artifact (human)

Signed in as the first account, open `<app>/docs/<id>`. Record from the rendered
browser output: the trusted shell's title and owner identity, the artifact
rendering inside the renderer frame, working fragment navigation within the
artifact, and that the artifact never replaces or resizes the trusted regions.
Record the network evidence that the content came from the same-origin content
route with `Content-Disposition: attachment`, `private, no-store` and `nosniff`.

### L8 — signed-out and a second real account are denied (human)

In a second isolated browser profile signed in as the second test account, open
the same `<app>/docs/<id>`. Record the rendered not-found view and that it is
indistinguishable from the view for an id that never existed. Record that the
metadata and content routes return no document body and no marker of the document
they refused. Repeat signed out and record that the view is the same one.

### L9 — nothing private is reachable outside the owner route (human)

With the document published, look for it everywhere it must not be:

- no public Blobs URL, CDN copy, redirect bearer or downloadable asset path
  appears anywhere in the owner's transfer;
- the deployment's published static output contains no private byte, on either
  hostname — check what `<render>` serves in particular, which is the four shell
  files under the internal `/_render/` rewrite and must hold only operator-owned
  code;
- the content route replayed without the session returns nothing.

### L10 — real conditional-write race (human)

Against the deployed storage, under the bounded operation count:

- issue two **parallel identical uploads** for one pending publication: exactly
  one wins, one durable document exists, and the loser is refused cleanly;
- race a **cancel against an upload**: one decision wins and the record is not
  left half-decided;
- issue two approvals together: exactly one wins.

Afterwards the completed record's owner and bytes must be unchanged. This must
exercise real Netlify conditional writes; a fixture ETag map does not close L10.

### L11 — lost and ambiguous responses recover the same receipt (human)

Interrupt the upload **response** at a client-side proxy or interception layer
while the service commits — do not stop the service. Re-run the client with the
same private request file and record that it recovers the same receipt: same
document id, same content digest, no second document created. Repeat the recovery
**after the upload deadline but within the receipt window**. Then record that the
owner read still works after the receipt has expired — or, if the bounded live
schedule does not reach that point, schedule the follow-up observation and keep
this assertion explicitly open rather than recording it as passed.

### L12 — failed attempts leave no accessible partial record (human)

Drive each failure case and record that nothing readable is left behind: a
**denied** approval, an **expired** approval, and uploads that are **invalid**,
**oversized** and **descriptor-mismatched**. After every one, confirm the original
local HTML is still available to the user — a refused publication must not cost
them their document.

### L13 — the hostile fixture stays contained in the deployed renderer (human)

Publish the authorized hostile fixture from AHU-012 and open it as the owner.
Record from real browser output and the network log:

- the exact source and origin handshake — `archon:ready` from the renderer frame,
  `archon:render` only to the configured renderer origin and that exact window;
- the artifact cannot reach the account origin or mutate the trusted shell;
- no session token, CSRF token, document id or account identity appears in any
  message;
- the deployed CSP and frame headers are the generated ones;
- the failed-renderer state is shown honestly when the renderer cannot load.

Record the C4 limitation as stated: the sandbox prevents account-origin access,
**not** every self-navigation or every exfiltration path a malicious document
could take. Do not write a network-proof or end-to-end-encryption claim.

### L14 — publish-disabled transition (human)

With the operator's authority, set `HOSTED_PUBLISH_ENABLED=false` on the site and
redeploy per `hosted/OPERATIONS.md` §4. There is one site, so this is one
variable change and one redeploy. Record that new start and upload requests are
refused with 503, that existing private reads still work, and that a completed
receipt still recovers. Restore the previous value and record the restoration.

### L15 — rate rules are accepted and effective (human)

Record the deploy log accepting **both** per-IP rules, and the effective deployed
configuration for the public start route and the agent status route. Record what
the platform actually enforced — this is a delayed best-effort mitigation, not a
hard quota, and the record must not claim otherwise. Do not generate an
unapproved load test to obtain this.

### L16 — log redaction and the private operation count (human)

Plant unique test markers in the run's titles and operation identifiers, then
search the deployed logs for them. Record that the markers are findable and that
**no** session token, agent secret, verification fragment, client secret or cookie
value appears anywhere alongside them. Record the count and identifiers of the
operations this run owns **privately**, held for L18 — they identify exactly what
may later be disposed of, and they do not belong in the public report.

### L17 — the browser experience is accessible (human)

From real rendered output, not from markup inspection alone:

- the approval is completed by **keyboard alone**, with visible focus;
- reader sign-out is reachable and actually revokes the session;
- the renderer frame has an accessible title, and a failure state is announced to
  a screen reader rather than being a silent blank frame;
- the artifact's theme and its fallback fonts are readable, and the loading and
  error states are visible.

### L18 — cleanup and retention disposition (human)

Name every resource the acceptance run created — from L16's private list — before
removing anything. C2 retains completed documents and there is **no delete API**;
do not invent one. Either remove the named test records through the approved
paused-maintenance operator process of `hosted/OPERATIONS.md` §7 after verifying
the exact targets, or record their intentional retention against the named
retention owner. Record which of the two happened for each resource.

### L19 — the verified-email domain gate is live (human)

As the owner, add `HOSTED_LIVE_DOMAIN_ADMITTED` to the test document's domain
list. Then, from real rendered browser output:

- a reader whose **verified** address is at the admitted domain opens the
  document;
- a reader whose verified address is at `HOSTED_LIVE_DOMAIN_REFUSED` gets the
  same not-found view as an id that never existed, and the metadata and content
  routes leak no title, no bytes and no marker of the document they refused.

Use the two test accounts from G4 for the two halves. If the account you intended
as the admitted reader has no verified address on its session, that is **L4b**
failing, not this row — fix the GitHub connection's `user:email` scope and
re-run, rather than recording L19 as a refusal that worked.

## 4. Recording the result

Write a dated report at
`docs/builds/agent-hosted-upload/evidence/ahu-013-<date>-live-acceptance.md`
containing:

- the frozen facts: package version and integrity, install source, source
  revision, the deploy identifier, the three hostnames and the two registrable
  sites the served pair resolves to, the Auth0 tenant and client id digests, the
  account labels, and the admitted and unlisted domains;
- one row per guarantee L0–L19 with `pass`, `fail` or `blocked`, the evidence it
  was decided from, and — for a blocked one — the gate items it is still waiting
  on, copied from the runner's `waits on` lines. A row that folds several of the
  ticket's assertions records an outcome for each line of its `covers` list;
- the cleanup/retention disposition from L18;
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
