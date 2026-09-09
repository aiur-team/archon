# Dependency and integration audit

Build Order `aiur-team/archon:agent-hosted-upload`, version 1; target depth five.
13 executable/capstone units, no umbrella workers, no executable GitHub issues yet.

## Wave profile

| Phase | Members | Width | Merge readiness |
| --- | --- | --- | --- |
| 1 | AHU-001, AHU-002 | 2 | Baseline researched; no missing producer |
| 2 | AHU-003, AHU-004, AHU-005, AHU-006 | 4 | AHU-001 contract/deploy seam merged |
| 3 | AHU-007, AHU-008, AHU-009, AHU-010, AHU-011 | 5 | Respective producers merged |
| 4 | AHU-012 | 1 | All real product boundaries available |
| 5 | AHU-013 | 1 | Integrated implementation plus operator live gates |

Longest hard path: AHU-001 → AHU-004 → AHU-007 → AHU-012 → AHU-013; five nodes.
AHU-001 fan-out four; AHU-004 fan-out four (approval, upload, reader, operations). AHU-012 joins five direct inputs.
Earliest useful agent/builder lane: phase1; identity/storage/reader implementation: phase2; integrated result: phase4; live acceptance: phase5.
Each wave is an antichain under transitive dependencies. No ticket depends on a peer in the same wave.
The phases are not runtime barriers: independent ready tickets can start after their own prerequisites merge.

## Hard-edge justification

- AHU-003/004/005/006 → AHU-001: consume executable descriptor/state/error/config contracts, not a decorative docs-only milestone.
- AHU-007 → AHU-003/004: real authenticated principal and atomic approval producer are required to connect browser actions.
- AHU-008 → AHU-004: artifact endpoint uses the sole capability/commit state authority.
- AHU-009 → AHU-003/004/005: owner principal, complete-record read and renderer origin/message boundary must exist.
- AHU-010 → AHU-002/006: package distribution must reference the actual offline profile and command.
- AHU-011 → AHU-004: rate rules attach to real start/status handlers; no parallel edge rewrite or imaginary handler paths.
- AHU-012 → AHU-007/008/009/010/011: integrates actual UI, upload, read, distributed client and deployed configuration.
- AHU-013 → AHU-012: live proof cannot substitute for missing deterministic integration regressions.

## Conflict partitioning

No same-wave serialization clique remains. Shared CI file edits are additive named run steps, with explicit inventory and merge-refresh review; they are not semantic dependencies.
AHU-002 owns existing docbuild CLI/profile files; AHU-006 uses a new publishing binary, avoiding simultaneous CLI dispatcher edits.
AHU-010 follows both before editing package distribution and README.
AHU-004 owns state/store plus start/status/cancel handlers; AHU-008 owns artifact-only handler; AHU-007 owns browser-only handlers; no sibling writes a second CAS loop.
AHU-011 extends rate config exports after AHU-004 and owns renderer Netlify deployment configuration; AHU-005 owns renderer assets/header build script. Neither overwrites the other's output.
AHU-009 owns viewer routes/assets, not renderer source.
Root self-hosted files are read-only except the explicit builder profile and CI wiring. The public-default-role change now on origin/main is not a predecessor; hosted ownership remains isolated from it. See baseline-delta.md.
`serializes_with`, `suggested_after`, and `contains` are empty after partitioning; shared additive CI exceptions are documented instead of converting read-only dataflow into scheduling edges.

## Reconnection ledger

| Coupling not used as hard edge | Temporary test path | Real integration owner and gate |
| --- | --- | --- |
| CLI AHU-006 ↔ HTTP producers AHU-004/007/008 | Frozen wire fixtures in client tests; no production fake server | AHU-012 drives installed binary through actual handlers and approval UI |
| Approval AHU-007 ↔ artifact AHU-008 | Approved-state producer fixtures | AHU-012 signs in, approves and uploads; detects wrong immutable owner/descriptor |
| Upload AHU-008 ↔ reader AHU-009 | Reader tests seed valid complete envelope through the actual store boundary | AHU-012 publishes real bytes then owner/other-user/raw reads and compares exact digest |
| Renderer AHU-005 ↔ ops AHU-011 | Local static build with injected explicit test origins | AHU-012 loads production-style headers; AHU-013 proves deployed origins/CSP/rate configuration |
| Offline builder AHU-002 ↔ publisher AHU-006 | Single-file fixture | AHU-010 clean tarball build/publish; AHU-012 renders actual packaged output |

Contract authority beats implementation proof only where this ledger names the temporary path and later reconnecting test.
No local mock result closes AHU-013. No external gate is encoded as a fake worker ticket.
