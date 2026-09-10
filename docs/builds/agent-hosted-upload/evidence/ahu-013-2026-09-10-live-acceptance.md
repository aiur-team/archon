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

```
$ node scripts/test-hosted-live.mjs
PASS  G0 the OAuth client secret is installed server-side only
BLOCKED  G1 every operator prerequisite is supplied: not supplied: HOSTED_LIVE_APP_ORIGIN, …
BLOCKED  G2 two HTTPS origins on two different registrable sites
BLOCKED  G3 dedicated OAuth application with the exact callback and empty scope
BLOCKED  G4 two approved test identities in isolated browser profiles
BLOCKED  G5 an externally installable release of the publisher package
BLOCKED  G6 frozen source revision, deploy revisions and a passing AHU-012 at that revision
BLOCKED  G7 an accepted pilot envelope and a named retention owner
FAIL  live acceptance is BLOCKED: 7 gate items unmet
```

`G0` passes for the only reason it can here: there is no client secret in this
environment, which is where a client secret must never be.

Two of the seven were checked against the outside world rather than against an
absent variable, because "not supplied" and "does not exist" are different
findings and only the second one is a fact about the project:

- **G5, the release.** `npm view @aiur-team/docbuild` answers `404 Not Found` on
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
recorded in place of one.

| ID | Guarantee | Status | Why |
| --- | --- | --- | --- |
| L1 | Deployed session endpoint answers anonymously with the hosted header set | blocked | no deployment |
| L2 | Deployed renderer serves the generated header set and sets no cookie | blocked | no deployment |
| L3 | Deployed viewer and metadata routes reveal nothing to a signed-out reader | blocked | no deployment |
| L4 | Real GitHub sign-in: fixed callback, single-use state, PKCE, empty granted scopes | blocked | no OAuth application, no origin to register a callback against |
| L5 | Installed released package and packaged skill drive a real publish (AE1) | blocked | package not published; no service to publish to |
| L6 | Owner reads the artifact through the deployed renderer in a real browser | blocked | no deployment |
| L7 | A second real account is denied the same document | blocked | no deployment, no approved test identities |
| L8 | Real conditional-write race behaviour against deployed storage | blocked | no deployed storage |
| L9 | Lost upload response recovers the same receipt | blocked | no deployment |
| L10 | Publish-disabled transition refuses new work while private reads survive | blocked | no deployment |
| L11 | Both per-IP rate rules accepted by the deploy and effective | blocked | no deploy log exists |
| L12 | Cleanup or intentional retention disposition of every generated record | blocked | nothing was created, so there is nothing to dispose of |

## What the local evidence does and does not cover

AHU-012's integrated gate is green on this revision: the `check` workflow
concluded `success` on `837dab4`, which runs `scripts/test-hosted-integration.mjs`
along with every other gate in the repository. That is the strongest statement
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
- [`../live-acceptance.md`](../live-acceptance.md) — the procedure for L1–L12,
  the evidence-sanitisation rules, and the cleanup/retention disposition.
- CI wiring that fails if the runner ever reports a live result without
  prerequisites, which is the state every build runs in.

## Mutation proof of the new gate

A refusal mechanism that stops refusing is silent, so each rule the gate enforces
was removed one at a time in an isolated clean worktree and the suite re-run. The
mutation is reverted and the suite re-run green after every one.

```
$ git worktree add --detach .worktrees/pr-176-<unique> HEAD
$ python3 - <<'…'   # for each mutation: patch, node --test, revert, node --test
$ node --test --test-timeout=30000 scripts/test-hosted-live.test.mjs
```

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
