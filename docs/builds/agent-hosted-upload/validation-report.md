# Planning validation report

Build Order `aiur-team/archon:agent-hosted-upload`, plan version 1. Reviewed 2026-09-09. This validates a planning pack, not an implemented or deployed feature.

## Verdict

Implementation contracts are ready for later authorized ticket promotion. Dispatch is deliberately stopped. Live acceptance is externally gated and cannot be reported complete from local tests.

The pack contains 15 covered requirements, seven technical decisions, six frozen interface blocks and 13 worker-ready documents. Dependency levels have widths 2, 4, 5, 1, 1; longest hard path is five. No cycles, unresolved dependency IDs, same-level hard dependencies, umbrella workers or unexplained serialization edges remain.

Run `node docs/builds/agent-hosted-upload/validate-pack.mjs`; add `--runtime` to verify byte-identical discovery copies. This is a validator of the current runtime manifest, not the older incompatible publisher schema. Its first runs caught metadata-format differences and incomplete C3 contract copies; those were corrected before final PASS.

## Research and confidence

| Decision | Evidence and confidence | Remaining proof |
| --- | --- | --- |
| DEC-001 additive hosted deployment | High: pinned repo sources, current legacy import/cookie/access paths | Clean install/import and unchanged legacy CI in AHU-001/012 |
| DEC-002 identity-only GitHub OAuth | High: current GitHub OAuth/scopes/PKCE docs and published Netlify SDK/provider source | Real provider registration, callback, scope and account behavior in AHU-013 |
| DEC-003 single-record guarded publication | High mechanism confidence: current Blobs conditional writes and strong-read API; one atomic envelope avoids invented transactions | Real provider races, deadline and ambiguous-write readback in AHU-013 |
| DEC-004 isolated renderer | High trust-boundary confidence, medium compatibility confidence until browser proof: WHATWG/CSP and baseline navigation | Actual packaged navigation/hostile HTML in AHU-005/012 and effective deployed headers in AHU-013 |
| DEC-005 split-phase agent command | High: agent tool checkpoints and current npm packaging/source boundaries | Fresh tarball consumer plus actual Claude-following-skill capstone |
| DEC-006 portable hosted builder profile | High: inspected base assets/fonts/collaboration inclusion | Offline packaged rendering and unchanged normal-profile regressions |
| DEC-007 safe pilot operations | High on documented limits, explicitly not a hard-quota claim | Operator budget acceptance, deploy plan support and effective settings |

Required deepening was applied to load-bearing technical decisions, system impact, file/producer ownership and verification contracts despite small individual tickets. Security, consistency and cross-origin claims were not accepted from file shape alone. Source refresh remains mandatory before implementation; baseline-delta.md records the one observed remote-main change.

## CE review coverage and reconciliation

Seven headless personas: coherence, feasibility, security-lens, design-lens, scope, product-lens and adversarial. Independent cross-model passes: Claude product-lens, adversarial, security-lens and whole-doc; runner receipts report requested opus, actual claude-opus-5, independence verified. These were review agents, not implementation agents.

| Review finding | Resolution |
| --- | --- |
| Start endpoint wrongly implied a pre-existing bearer | C3 now distinguishes public start from bearer-authenticated status/upload/cancel; all copied blocks synchronized |
| Plan file maps and orphan reader test name drifted | Producer-owned file maps corrected; AHU-009 owns owner-viewer browser test, AHU-012 owns integration |
| srcdoc fragment links can replace/fail navigation | C4 assigns trusted prelude to AHU-005; preserves href/authored listeners and defers scroll; actual packaged navigation required in AHU-012/013 |
| Account switch could reuse same GitHub session | C1 requires protected Archon logout, preserved binding and GitHub prompt=select_account; explicit fixture/browser test |
| Expired receipt has no recovery destination | C3/C5 supply distinct Check publication URL from saved ID and pinned origin, still exit 21, never a fabricated receipt |
| Logout/session storage insufficiently explicit | C1 pins private session namespace, strong revocation and callback rotation; AHU-003 tests copied old token failure and outages |
| Approval page could be framed | C3 explicitly protects all app HTML surfaces, including approval/viewer; renderer alone permits exact app framing |
| Transient cookies under-specified | C1 pins host-only attributes, bounded lifetime and distinct consumption rules; pending binding survives account switching |
| Service override provenance hidden | C5 exposes serviceOrigin and limits its source to user/operator config; skill warns against artifact instructions |
| R1/R2 missing from AE trace | AE1 explicitly requires actual Claude plus installed skill, local build and retained offline artifact; AHU-013 cannot substitute hand-driven CLI |
| Same generic AE trace on all units; AHU-011 scheduling wording | Specific per-unit AE contributions and exact AHU-004 predecessor now stated |
| Strong consistency/idempotency absent from isolated product slice | Already specified in C2/C3 and AHU-004; retained and clarified, not replaced with cross-authorization semantics |
| Invalid artifact should preserve approval | Original exact bytes can retry; corrected bytes require new approval. AHU-004 states the distinction |
| Raw/asset access absent from short AE2 wording | AE2 now includes direct metadata/raw requests and no public sidecar path; AHU-009/012/013 test real routes |
| Preserve old self-hosted workflow | Already explicit in C1, non-goals, regression CI and definition of done; no redundant R16 |
| Managed enterprise authorization, deletion, wider quotas/audit | Explicit scope/pilot residuals in deferred-findings.md; no universal promise or silent expansion |

No P0/P1 implementation-contract blocker is accepted as an undocumented risk. External live gates remain open, as intended.

## Structural and verification audit

- Every executable unit names outcome, requirements, concrete files/exports, source evidence, existing owner/reuse target, frozen contracts, failure cases, sibling boundaries, agent/merge/human gates and user-facing surfaces.
- Producer contracts are carried verbatim inside consumers; runtime ticket bodies do not require another worker to invent APIs.
- Shared CI edits are additive with explicit runner inventory. Narrow production mutations must make new behavioral tests fail; restore and rerun before review.
- Removed hard edges have explicit fixture-to-real-producer reconnection owners in graph-audit.md. AHU-012 joins all actual boundaries.
- No product tests or deployment ran during planning; all proposed test scripts are labelled new and belong to named implementation tickets.
- Design is versioned in design-v1.md, grounded in this user's workflow and existing theme rather than an external mockup. Validator reports its SHA-256.
- Runtime root is synthetic and draft-only, not a GitHub issue. Do not follow its generated GitHub placeholder URL or infer promotion from dashboard identity.

## Dashboard discovery diagnosis

The initial daemon selected the GitHub data source (application override nil), so only historic issue #43 appeared and search_paths was empty. Pack files and repository-scoped discovery directories were correct. Selecting the existing PlanningSource application adapter on the Archon-only daemon exposed this pack without GitHub writes or worker dispatch. No Aiur source code or shared release configuration changed.

The selection is boot-local: restart returns to the default GitHub view unless the planning adapter is selected again. A second cold-pause issue was confirmed: candidate_snapshot_fresh? was true but snapshot_ready? false, SnapshotStore returned snapshot_unpublished, and the reconciler therefore marked freshness unavailable despite a healthy empty membership store. The direct StatusReport read confirmed globally_paused=true and running/retrying/idle=[].

A daemon-local planning snapshot callback is restricted to this explicit draft pack. It uses the direct status observation only when membership is healthy/empty AND the live status is paused with all three lists empty; otherwise it returns the actual membership unchanged. It does not modify membership, snapshot storage, tracker state or dispatch. This is a planning-preview accommodation, not an Aiur production fix. Remove the preview override before later execution. No fake member or status.json was written.
