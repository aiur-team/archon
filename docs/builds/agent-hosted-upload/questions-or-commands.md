# Agent hosted upload: intake and decisions

Build Order: `aiur-team/archon:agent-hosted-upload`. Plan version: `1`. Logical prefix: `AHU`.
Researched product commit: `dfbd7a7ed2bfb0b2f1742e1d1e2294ab599d1b79`.

## Operator request

> use compound engineering skills to research all needed work, create deeply researched archon ticket docs, create an aiur build order to create a dag of those tickets and then prepare to run aiurdev within archon to have aiur claude agents implement the tickets. send me the aiur dashboard build order link and stop before spinning up agents to implement tickets

The feature is the preceding request: an agent turns selected material into bundled HTML, directs the user through GitHub sign-in, uploads it through an endpoint, and returns a hosted document owned by that user.

## Authority and stop boundary

- Authorized: local research, external documentation research, planning docs, a dependency graph, a dashboard-discoverable Build Order, and preparing an Archon Aiur instance.
- Planning commits are part of preserving this pack. No product implementation or merge is authorized in this turn.
- Ticket docs and a draft Build Order are authorized. GitHub executable issue promotion is not needed to render the draft graph; keep members draft unless separately requested.
- A dashboard-only preparation launch must use the cold-start global pause and verify zero workers. Never resume dispatch or start implementation agents.
- Stop after the reviewed pack is visible in the dashboard and provide the actual Build Order deep link.

## Carried decisions and assumptions

- Agent upload replaces mandatory GitHub repository integration; GitHub is used for identity only.
- Working first-slice scope: private documents accessible to their authenticated owner. Sharing and collaboration were offered as an optional scope expansion and have not been selected.
- No user-specified ticket-count target. Boundaries will follow independently reviewable outcomes, with five phases as the planning depth target.
- Architecture and provider choices are planning-owned where they preserve this UX and use existing infrastructure.
- Primary output is Markdown in this repository; runtime discovery copies are separate projections.

## Source precedence

Current operator decisions > accepted product contract > researched design/contracts > GitHub for promoted ticket truth > Aiur for runtime truth > this pack for baseline intent.
Historical research files are evidence to check, not automatic authority over the new hosted architecture.

## Open items

Technical choices are resolved in contracts C1–C6 and DEC-001–007, with primary-source evidence and review dispositions in validation-report.md. No unresolved architecture choice is delegated to a worker.

Before dispatch: explicit permission to promote executable GitHub tickets and start Claude agents; make the planning checkpoint available to workspaces; resolve Aiur CI-readiness operator-token preflight. Before live acceptance: operator-supplied OAuth app, two HTTPS origins, two accounts, credentials, approved non-sensitive test content and accepted pilot budget/retention responsibility. These external gates remain open.
