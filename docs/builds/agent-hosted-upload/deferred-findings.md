# Deferred findings and pilot boundaries

These are explicit limits, not extra implementation tickets. The selected finite outcome remains agent-built HTML, browser approval, upload, and private owner reading.

| Finding | Disposition and owner |
| --- | --- |
| Sharing, comments, editing, repeat publishing, library/list/search, self-service deletion | Product scope deferred. Do not implement without a later user decision. Lost URL plus lost local request state is not recoverable through a library in this slice. |
| Enterprise managed-account compatibility | Identity-only scope avoids repository integration, not every enterprise authorization/data policy. AHU-013 records account classes actually tested; a managed-enterprise test needs an available account and authority. No universal IT-bypass claim. |
| Public abuse, auth/bind route traffic, hard quotas, per-account blocks and billing | Two basic platform rate rules cover start/status only. Other routes and delayed enforcement remain cost exposure. AHU-011 documents this explicitly; no unrestricted public launch until operator accepts a bounded pilot budget and rollback plan. Wider controls require later scope/provider-plan decisions. |
| Record accumulation, mistaken sensitive upload and deletion requests | No automatic deletion or self-service deletion. Named operator owns retention, backup and separately authorized paused-maintenance removal. Warn before upload; publishing private content to a third-party service is still data transfer. |
| Dedicated security audit/event retention service | Not added to this finite slice. Preserve safe platform diagnostics and document their limitations; do not claim incident-grade auditability. A dedicated audit pipeline/retention policy needs separate scope. |
| Renderer integrity and storage-provider trust | Operator-controlled renderer receives HTML and is trusted infrastructure; a compromised renderer or storage provider is outside browser sandbox protection. No end-to-end-encryption or network-proof claim. AHU-011 covers operator secrets/configuration and rollback. |
| Legacy Netlify Identity/org-role/connect architecture and historic #43 backlog | Preserved and regression-tested, not migrated or re-executed. Remote main's default-role change is not a prerequisite. |
| Live acceptance provider materials | AHU-013 remains blocked until explicit infrastructure/test authority and actual external prerequisites exist; deterministic fixtures cannot close it. |
| Aiur CI-readiness operator token | Observed unavailable in paused preflight. Executor must resolve the configured credential before later dispatch/review; no credential generated or exposed in planning. |

## Review disposition rationale

The cross-model proposal for idempotency across re-authorization conflicts with the deliberately immutable descriptor/owner and single-operation capability model. C2/C3 define server-issued publication ID plus saved request state as operation identity. Exact retries recover the same record; a new authorization is a new operation and is never started automatically after ambiguity.

The proposal to upload corrected bytes under an old approval conflicts with approval of an exact digest. Invalid transport does not consume approval; the originally approved bytes can retry until expiry. Changed content requires explicit fresh approval.

Deletion, extra rate-limit routes and audit infrastructure are not silently accepted feature expansions. Their risks are visible above and in live-release gates.
