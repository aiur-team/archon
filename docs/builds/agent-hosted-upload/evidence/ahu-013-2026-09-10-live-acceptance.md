# AHU-013 — live acceptance result, 2026-09-10

**Result: BLOCKED.** No required live guarantee was proved, because none of the
operator prerequisites the capstone depends on exists yet. Nothing was deployed,
registered, signed into, published, uploaded or spent during this run.

This is a real result, not a deferral: the capstone stays open, and the procedure
that will close it is [`../live-acceptance.md`](../live-acceptance.md).

## What was under test

| Fact | Value |
| --- | --- |
| Source revision | `837dab4f77964f703e2956a3862d60cc86e891a8` |
| Application origin | none provisioned |
| Renderer origin | none provisioned |
| OAuth application | none registered |
| Deploy identifiers | none; neither `hosted/` nor `renderer/` is deployed |
| Publisher release | none published |
| Pilot envelope / retention owner | not accepted, not named |

## Preflight gate

The transcript below is this branch's head, `0946c9a` + this rework, verbatim
(stdout then stderr, which is the order the runner writes them):

```
$ node scripts/test-hosted-live.mjs
PASS  G0 the OAuth client secret is installed server-side only
BLOCKED  G1 every operator prerequisite is supplied: not supplied: HOSTED_LIVE_APP_ORIGIN, HOSTED_LIVE_RENDER_ORIGIN, HOSTED_LIVE_OAUTH_CLIENT_ID, HOSTED_LIVE_OAUTH_CALLBACK, HOSTED_LIVE_OAUTH_SCOPES, HOSTED_LIVE_ACCOUNTS, HOSTED_LIVE_PACKAGE, HOSTED_LIVE_PACKAGE_INTEGRITY, HOSTED_LIVE_PACKAGE_SOURCE, HOSTED_LIVE_SOURCE_REVISION, HOSTED_LIVE_APP_DEPLOY, HOSTED_LIVE_RENDER_DEPLOY, HOSTED_LIVE_BUDGET_APPROVAL, HOSTED_LIVE_RETENTION_OWNER, HOSTED_LIVE_AHU012_REVISION
BLOCKED  G2 two HTTPS origins on two different registrable sites: both origins must be supplied as exact HTTPS origins with no path, port-only host or wildcard
BLOCKED  G3 dedicated OAuth application with the exact callback and empty scope: not supplied
BLOCKED  G4 two approved test identities in isolated browser profiles: supply exactly two comma-separated labels
BLOCKED  G5 an externally installable release of the publisher package: not supplied
BLOCKED  G6 frozen source revision, deploy revisions and a passing AHU-012 at that revision: not supplied
BLOCKED  G7 an accepted pilot envelope and a named retention owner: not supplied
BLOCKED  L1 deployed session endpoint answers anonymously with the hosted header set: waits on G2, G6
BLOCKED  L2 deployed renderer serves the generated header set and sets no cookie: waits on G2, G6
BLOCKED  L3 deployed viewer and metadata routes reveal nothing to a signed-out reader: waits on G2, G6
BLOCKED  L4 real GitHub sign-in: fixed callback, single-use state, PKCE, empty granted scopes: waits on G2, G3, G4
BLOCKED  L5 installed released package and packaged skill drive a real publish (AE1): waits on G2, G3, G4, G5
BLOCKED  L6 the completed record matches the real GitHub identity and the source bytes: waits on G2, G3, G4, G5
BLOCKED  L7 owner reads the artifact through the deployed renderer in a real browser: waits on G2, G4, G5
BLOCKED  L8 signed-out and a second real account are denied the same document: waits on G2, G4, G5
BLOCKED  L9 no private artifact is reachable outside the owner-authorized route: waits on G2, G4, G5, G6
BLOCKED  L10 real conditional-write race behaviour against deployed storage: waits on G2, G5, G6
BLOCKED  L11 ambiguous and lost responses recover the identical receipt: waits on G2, G5
BLOCKED  L12 denied, expired and invalid attempts leave no accessible partial record: waits on G2, G4, G5
BLOCKED  L13 the authorized hostile fixture stays contained in the deployed renderer: waits on G2, G4, G5, G6
BLOCKED  L14 publish-disabled transition refuses new work while private reads survive: waits on G2, G7
BLOCKED  L15 both per-IP rate rules accepted by the deploy and effective: waits on G2, G6
BLOCKED  L16 logs redact secrets and the owned test operations are counted privately: waits on G2, G6, G7
BLOCKED  L17 the browser experience is accessible in real rendered output: waits on G2, G4, G5
BLOCKED  L18 cleanup or intentional retention disposition of every generated record: waits on G7
FAIL  live acceptance is BLOCKED: 7 gate items unmet
$ echo $?
1
```

`G0` passes for the only reason it can here: there is no client secret in this
environment, which is where a client secret must never be.

Two of the seven were checked against the outside world rather than against an
absent variable, because "not supplied" and "does not exist" are different
findings and only the second one is a fact about the project:

- **G5, the release.** `npm view @aiur-team/archon` (then named `@aiur-team/docbuild`) answers `404 Not Found` on
  the public registry, and the repository has no published GitHub release. The
  package is `private: false` and packs correctly — `scripts/test-publish-package.mjs`
  proves a clean consumer can install *a tarball built here* — but AE1 is about
  what a consumer with no repository access can install, and today that is
  nothing. Local `npm pack` output cannot stand in for it.
- **G2/G6, the deployments.** No application or renderer deployment exists to name
  a revision of. `hosted/` and `renderer/` are complete deployable trees with
  their own lockfiles and configuration; neither has been deployed.

## Required live guarantees

Every guarantee is `blocked`. None was attempted, and no fixture result is
recorded in place of one. The **waits on** column is the runner's own mapping,
printed on every blocked run, so each open acceptance line names the gate items
in "What unblocks this" that would release it — G2 the two deployments, G3 the
OAuth application, G4 the two test identities, G5 the published release, G6 the
frozen revisions with a passing AHU-012, G7 the accepted envelope and named
retention owner.

| ID | Guarantee | Status | Waits on | Why |
| --- | --- | --- | --- | --- |
| L1 | Deployed session endpoint answers anonymously with the hosted header set | blocked | G2, G6 | no deployment |
| L2 | Deployed renderer serves the generated header set and sets no cookie | blocked | G2, G6 | no deployment |
| L3 | Deployed viewer and metadata routes reveal nothing to a signed-out reader | blocked | G2, G6 | no deployment |
| L4 | Real GitHub sign-in: fixed callback, single-use state, PKCE, empty granted scopes | blocked | G2, G3, G4 | no OAuth application, no origin to register a callback against |
| L5 | Installed released package and packaged skill drive a real publish (AE1) | blocked | G2, G3, G4, G5 | package not published; no service to publish to |
| L6 | The completed record matches the real GitHub identity and the source bytes | blocked | G2, G3, G4, G5 | no completed record exists, and no real GitHub identity has signed in |
| L7 | Owner reads the artifact through the deployed renderer in a real browser | blocked | G2, G4, G5 | no deployment |
| L8 | Signed-out and a second real account are denied the same document | blocked | G2, G4, G5 | no deployment, no approved test identities |
| L9 | No private artifact is reachable outside the owner-authorized route | blocked | G2, G4, G5, G6 | nothing is published and no static site output exists to inspect |
| L10 | Real conditional-write race behaviour against deployed storage | blocked | G2, G5, G6 | no deployed storage |
| L11 | Ambiguous and lost responses recover the identical receipt | blocked | G2, G5 | no deployment |
| L12 | Denied, expired and invalid attempts leave no accessible partial record | blocked | G2, G4, G5 | no publication can be started, so none can fail |
| L13 | The authorized hostile fixture stays contained in the deployed renderer | blocked | G2, G4, G5, G6 | no deployed renderer to load the fixture through |
| L14 | Publish-disabled transition refuses new work while private reads survive | blocked | G2, G7 | no deployment |
| L15 | Both per-IP rate rules accepted by the deploy and effective | blocked | G2, G6 | no deploy log exists |
| L16 | Logs redact secrets and the owned test operations are counted privately | blocked | G2, G6, G7 | no deployed logs, and no operations were performed to count |
| L17 | The browser experience is accessible in real rendered output | blocked | G2, G4, G5 | nothing was rendered in a browser |
| L18 | Cleanup or intentional retention disposition of every generated record | blocked | G7 | nothing was created, so there is nothing to dispose of |

The table is #176's live assertions one for one. Where one row folds several of
them — L5's account class and the enterprise-managed limitation, L10's three
races, L13's handshake, containment, message contents and failure state — the
sub-assertions are named in the runner's `covers` field and in the matching
runbook section, and each needs its own recorded outcome inside that row. An
operator working this table cannot record a `pass` for a row while one of its
lines went unattempted.

## What the local evidence does and does not cover

AHU-012's integrated gate is green on this revision: the `check` workflow
concluded `success` on `837dab4` (run `34489740605`), which runs
`scripts/test-hosted-integration.mjs` along with every other gate in the
repository. That is the strongest statement
available today, and its limits are stated in
[`ahu-012-local-integration.md`](ahu-012-local-integration.md): it composes the
real handlers, the real packaged CLI and a real browser against a deterministic
OAuth provider fixture on loopback origins. It cannot observe GitHub's
registration or granted scopes, Netlify's routing, CDN behaviour or conditional
writes, two real registrable sites, or an externally installable release — which
is the exact list above.

The gate was not re-run inside this workspace: `scripts/test-hosted-integration.mjs`
installs a pinned browser first, and that install failed here with a filesystem
error (`Unknown system error -122`) before any assertion ran. The CI conclusion on
the same revision is the record, not a local re-run.

## What this run added

- `scripts/test-hosted-live.mjs` — the preflight gate and read-only probe runner.
  It contacts nothing without a complete preflight *and* an explicit
  authorisation, and it cannot report a `pass` for any human-decided guarantee.
- `scripts/test-hosted-live.test.mjs` — one planted violation per rule the gate
  enforces, with an injected `fetch` so no probe leaves the runner.
- [`../live-acceptance.md`](../live-acceptance.md) — the procedure for L1–L18,
  the evidence-sanitisation rules, and the cleanup/retention disposition.
- CI wiring that fails if the runner ever reports a live result without
  prerequisites, which is the state every build runs in.
- The gate-to-guarantee mapping: every acceptance line declares the gate items it
  waits on, the runner prints the unmet ones per line on a blocked run, and the
  manifest carries them as `waitingOn`. A blocked capstone is only actionable if
  the operator can read which prerequisite releases which guarantee.
- One acceptance line per live assertion #176 names. The table grew from twelve
  rows to eighteen; the assertions that previously had no row at all were the
  numeric-identity and record-matching checks, the failure cases that must leave
  no partial record, the hostile fixture through the deployed renderer, the
  static-output and public-URL exposure check, log redaction with the private
  operation count, and the accessibility assertions. Folded sub-assertions are
  named rather than implied, so a recorded set of passes cannot close the
  capstone with part of it never attempted.

## Mutation proof of the new gate

A refusal mechanism that stops refusing is silent, so each rule the gate enforces
was removed one at a time in an isolated clean worktree and the suite re-run. The
mutation is reverted and the suite re-run green after every one.

```
$ git worktree add --detach .worktrees/pr-176-<unique> HEAD
$ npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
$ python3 -u mutate.py   # for each mutation: patch, node --test, revert, node --test
$ node --test --test-reporter=tap --test-timeout=30000 scripts/test-hosted-live.test.mjs
```

The suite is 42 tests and is green before and after every mutation below.

| Guarded condition removed | Test that failed |
| --- | --- |
| G2 registrable-site comparison | sibling subdomains are not two registrable sites |
| G3 exact callback comparison | the callback must be the app origin's exact frozen path |
| G3 empty-scope comparison | any granted scope at all blocks the gate |
| G4 opaque account-label rule | test identities are two distinct opaque labels |
| G5 HTTPS install-source rule | a local tarball is not an externally installable release |
| G6 AHU-012 revision equality | a local integration pass from another revision does not count |
| G0 client-secret absence | a client secret in this runner's environment fails the gate |
| supplied-credential refusal | a supplied provider credential is refused before anything formats it |
| probe authorisation | probing without explicit authorisation contacts nothing |
| runbook guarantees stay `pending` | a runbook guarantee stays pending no matter what the probes did |
| header value comparison | headerFaults names a header that differs; renderer frame-ancestors probe |
| anonymous session must not authenticate | a session endpoint that authenticates an anonymous request fails |
| every prerequisite required | three gate tests, including each prerequisite key is individually required |
| guarantee waits filtered to unmet gates | a met gate stops holding its acceptance lines shut |
| blocked run prints the waiting lines | a blocked run prints the gate each open acceptance line waits on |
| manifest records `waitingOn` | the manifest records the unmet gates per guarantee |
| a guarantee's `waits` names a real gate item | every guarantee waits on gate items the preflight actually reports |
| a guarantee's `covers` checklist | every acceptance line names the sub-assertions folded into it |
| a ticket assertion dropped from the table | every live assertion the ticket names has a row that claims it |
| the manifest carries `covers` | the manifest carries each guarantee's sub-assertion checklist |

One row is defended twice: the runbook-`pending` rule is expressed both in the
probe-only lookup and in the status expression, and removing either alone changes
nothing. Both had to be removed together before the test failed, which is
recorded here rather than left as a mutation that appeared to survive.

## What unblocks this

In dependency order, all operator decisions, none of them taken here:

1. Two HTTPS sites on two different registrable sites, deployed from `hosted/`
   and `renderer/`.
2. A dedicated GitHub OAuth application per environment, empty scope, callback
   registered at exactly `<app origin>/api/hosted/auth/github/callback`, with
   `GITHUB_CLIENT_SECRET` installed in the site environment only.
3. A published release of the publisher package that an external consumer can
   install, with its integrity recorded.
4. Two approved test GitHub accounts usable in isolated browser profiles.
5. An accepted traffic and cost envelope, and a named retention owner — C2 keeps
   completed documents and has no delete API.

`hosted/OPERATIONS.md` §8 is the operator-side list; this file is the acceptance
side of the same gate.
