# Executor handoff — agent hosted upload

Authority stops before implementation dispatch. The current pack is draft-only: do not create executable GitHub issues, resume Aiur, push a branch, merge, publish npm packages, provision providers or deploy without the appropriate later authorization.

## Durable inputs

- Unified plan: `docs/plans/2026-09-09-001-feat-agent-hosted-upload-plan.md`.
- Pack: this directory's build-order.json, contracts.md, design-v1.md, research/ and 13 tickets/.
- Validation/review: validation-report.md and `node docs/builds/agent-hosted-upload/validate-pack.mjs`.
- Product baseline and remote delta: baseline-delta.md.
- Scope and external limits: questions-or-commands.md and deferred-findings.md.
- Local branch: `plan/agent-hosted-upload`. The local-only planning commit must become available to worker checkouts before dispatch; this turn does not push it.
- Canonical machine state: `~/.aiur/repo/aiur-team/archon/builds/agent-hosted-upload/`; daemon owns status.json. The local Executor handoff records the planning SHA and observed dashboard/instance identity.

## Prepared run

Archon's local .aiur/config selects Claude only, concurrency ceiling five, no prewarming, isolated guarded git workspaces and dashboard port 4001. .aiur/prompt.md fences this AHU build from the old shared-Identity architecture and requires explicit human merge/live-action authority. These machine-local preparation files are not product configuration or part of the planning commit.

The dashboard launch was `aiurdev --bg --pause --executor .aiur/config`, invoked from Archon. It is globally paused with zero workers. The daemon uses Aiur's development release but Archon's instance key; never point AIUR_REPO_ROOT at the Aiur checkout to launch this instance.

The existing draft PlanningSource adapter is selected for this daemon only. It is not persistent across reboot and does not change dispatch policy. The default source is GitHub-backed and will not display draft-only packs. Do not rebuild the shared release in demo mode merely to persist this display setting.

The draft-only preview also uses a guarded direct-status callback for the cold-paused empty-fleet case; validation-report.md records why. Before any execution, remove `:build_order_planning_membership_snapshot` and `:build_order_planning_pack` application overrides (or restart normally), so live source authority is unmodified. No membership records or status.json were synthesized.

## Before a later authorized run

1. Re-read current user scope, source-of-truth precedence and aiur-run/aiur-monitor skills. Recheck branch, remote main, pack digest and paused/zero-worker status.
2. Obtain explicit ticket-promotion and implementation-dispatch authority; separately establish push/review/merge authority. Promote this finite pack only; preserve logical IDs and dependencies and attach full worker-ready bodies.
3. Make the planning commit available to worker workspaces under the selected source-control authority. Do not assume an unpushed local branch exists in origin clones.
4. Resolve the reported `ci_readiness_operator_token_required` preflight using the documented credential path; verify current-main CI and trusted comment identities. Do not weaken the preflight.
5. Restrict the dispatch boundary to the newly promoted AHU members; historical #43 and unrelated todo backlog are not part of this run. Validate dependencies, labels and Claude routing before any resume.
6. Only then start/resume implementation. A resume command is intentionally not executed in this handoff.
7. After deterministic implementation, AHU-013 still requires separately authorized real GitHub OAuth registration, two HTTPS sites, two test accounts, credentials, non-sensitive test material, accepted pilot budget and retention responsibility. If absent, stop at that gate; do not substitute mocks or declare delivery complete.

Acceptance ends only when all finite outcomes satisfy their ticket contracts and AHU-013 carries actual deployed proof. Scope drift belongs in deferred-findings.md for the user, not opportunistic extra tickets.
