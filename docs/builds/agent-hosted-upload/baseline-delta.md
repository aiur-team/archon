# Baseline freshness check

Research pin: `dfbd7a7ed2bfb0b2f1742e1d1e2294ab599d1b79`.
Remote main observed 2026-09-09: `e4be2bd0b844880b4e50f0ef478b7774f9cd7cbc`.
The remote advanced during planning by one commit: Give a signed-in visitor a configurable default role.
Only `README.md`, `netlify/lib/access.mjs`, and `scripts/test-access-row.mjs` changed (424 insertions, one deletion).
The same change was originally inspected as a local public-default-role branch; it is now on remote main, not pending merge.

This does not change the selected separate hosted boundary: hosted ownership must remain private regardless of the legacy default-role setting.
No product files were merged or edited in this planning branch. All ticket researched-at pointers still name the actually inspected baseline, and workers must refresh against current main at pickup.
The approval/promotion gate must make the planning branch commit accessible to workers before dispatch; this turn leaves it local and creates no GitHub issues.

Read-only evidence commands: `gh api repos/aiur-team/archon/commits/main --jq .sha`, `git fetch origin main`, `git log --oneline dfbd7a7..origin/main`, `git diff --stat dfbd7a7..origin/main`.
