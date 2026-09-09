# Authentication and agent publishing authorization research

Research date: 2026-09-09. Product baseline: `dfbd7a7ed2bfb0b2f1742e1d1e2294ab599d1b79`. Planning only; no provider registration, implementation, or deployment was performed. CE best-practices-researcher and framework-docs-researcher guidance informed source/version checks and the sequencing recommendations. Context7 CLI was unavailable; official documentation and published package/source code were read directly.

## Recommendation

Create a dedicated hosted authentication boundary: an Archon-owned **GitHub OAuth app used only for sign-in**, a server-side authorization-code exchange, and an opaque Archon browser session. Preserve the existing Netlify Identity path for self-hosted documents. The hosted publishing handoff is an **Archon protocol inspired by device authorization**, separate from GitHub's device flow: the agent never receives a GitHub token.

This is a recommendation inferred from the requirements and evidence below, not a claim that Netlify Identity is unusable generally. Reusing its current provider login does not establish stable GitHub-ID ownership; its published SDK also deliberately exposes session cookies to JavaScript. A narrow hosted seam lets the first version meet the specified identity and HTML-isolation contract without migrating existing self-hosted users.

## Evidence that changes implementation

### A1. No repository integration is needed to identify the user

- Claim/current behavior: GitHub's empty OAuth scope grants public read access. The service can identify the authenticated account via `/user` without repository write, private repository, organization membership, or private-email access. The numeric user ID is durable; login is mutable and public email may be absent.
- Source/locus: [OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps), [REST users, authenticated user and ID lookup](https://docs.github.com/en/rest/users/users). Both checked 2026-09-09.
- Why it matters: ownership must not depend on an email being present, an organization domain, or the agent's local GitHub identity.
- Confidence/freshness: high, current official docs.
- Contradiction/open question: empty scope still permits public-data reads, so do not describe the token itself as technically unable to read any repository. Application code should call only `/user`. [Organization restrictions](https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions) distinguish access to organization resources from personal authorization; this is not a promise that managed enterprise identities or company data-handling policies permit Archon.
- Suggested contract impact: use fixed provider `github.com` and normalized numeric ID as the identity key. Public email is optional display data, never an ownership key. No account auto-linking by matching email or username.

### A2. Current GitHub OAuth supports stronger flow controls than older advice assumed

- Claim/current behavior: PKCE is supported; use S256, browser-bound single-use state, and a fixed exact callback. Current web flow still documents a client secret. Validate `/user` after every exchange because the user may switch accounts. Omitted scope can reuse previous grants, so use a dedicated sign-in app and validate returned scopes. OAuth apps now support expiring tokens and configurable callback matching.
- Source/locus: [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps), [PKCE announcement, 2025-07-14](https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/), [OAuth changes, 2026-08-14](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/).
- Why it matters: a server callback is a normal dependency; no browser-held GitHub credential or agent listener is needed. Pre-August registrations may retain wildcard callbacks. New apps default to expiring tokens.
- Confidence/freshness: high; checked 2026-09-09. No current sunset notice found for these flows. Historical OAuth Application API sunsets concern older token-management endpoints, not this authorization-code flow.
- Contradiction/open question: GHES versions differ. GitHub.com only is the proposed first-version contract; adding arbitrary enterprise issuers requires separate account namespaces and configuration.
- Suggested contract impact: pin exact callback(s), disable wildcard matching, ignore/discard refresh credentials because GitHub is only consulted at login, and do not couple Archon session lifetime to provider token lifetime.

### A3. Netlify Identity is supported, but minimal reuse has a contract gap

- Claim/current behavior: Netlify reversed its deprecation in February 2026. Current docs support social GitHub login, optional custom OAuth branding, and open registration; invite-only registration also blocks new social users.
- Source/locus: [Official reversal](https://www.netlify.com/blog/auth0-extension-identity-changes/) (updated 2026-02-19), [Identity overview](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/overview/) (2026-03-30), [Registration and login](https://docs.netlify.com/manage/security/secure-access-to-sites/identity/registration-login/) (2026-09-01).
- Why it matters: rejection based on deprecation would be wrong. Minimal reuse would add `oauthLogin('github')`, callback handling, and provider configuration without a new identity system.
- Confidence/freshness: high for availability; checked 2026-09-09.
- Contradiction/open question: these docs do not establish provider-ID-based linking or an empty-scope custom provider configuration.
- Suggested contract impact: preserve Netlify Identity for the existing product; do not route hosted ownership through it unless a separately demonstrated adapter satisfies R6 and session requirements.

### A4. Published source shows why reuse cannot simply be assumed

- Claim/current behavior: `@netlify/identity@2.0.0` is the exact root dependency. Its `dist/main.js` lines 110-127 create `nf_jwt` and `nf_refresh` with `httpOnly: false`; lines 496-538 initiate browser OAuth and accept callback fragment credentials. Lines 649-688 expose the Identity subject and provider metadata, not a guaranteed durable GitHub ID. `verifyRequestOrigin` at lines 793-801 rejects missing origins.
- Source/locus: [Versioned npm package](https://registry.npmjs.org/@netlify/identity/-/identity-2.0.0.tgz), verified via `npm view @netlify/identity@2.0.0 repository.url dist.tarball --json` and streamed tar reads. Its declared source repository is `netlify/primitives`.
- Why it matters: passing these cookies to the agent violates R8; same-origin active documents can read them. The existing origin guard also cannot be blindly applied to a non-browser agent request, which has no browser Origin.
- Confidence/freshness: high for published 2.0.0 source; no local node_modules were installed or changed.
- Contradiction/open question: Netlify's hosted backend need not equal its public GoTrue branch. That branch at `aac5b5734ea1869d72d0ef40a073b89f1681efb5` requests `user:email` and omits GitHub ID in [github.go](https://github.com/netlify/gotrue/blob/aac5b5734ea1869d72d0ef40a073b89f1681efb5/api/provider/github.go); [external.go](https://github.com/netlify/gotrue/blob/aac5b5734ea1869d72d0ef40a073b89f1681efb5/api/external.go#L120) finds existing accounts by verified email. This is evidence against assuming R6, not proof about the live hosted implementation.
- Suggested contract impact: hosted handlers get explicit `identifyHosted(request)` and `requireHostedBrowserMutation(request)` interfaces. Agent bearer authentication is separate and never falls back to browser cookies.

### A5. Existing ownership schema cannot represent the proposed owner binding unchanged

- Claim/current behavior: `netlify/lib/identity.mjs:48` returns Netlify's `user.id`, optional email, and organization classification. `netlify/lib/access.mjs:550` requires a nonempty owner email and `boundFrom: 'env:DOC_OWNERS'`. `resolveRole` at line 1046 seeds from configured email and defaults an absent record's organization role to commenter. `netlify/edge-functions/gate.ts:211` identifies through that existing provider.
- Source/locus: exact baseline source above; `netlify/lib/store.mjs:82` constrains legacy IDs to six hex characters, and its consistency/CAS helper lives at line 1 onward.
- Why it matters: adding upload handlers alone cannot establish durable owner access. Do not fabricate emails or write a misleading `env:DOC_OWNERS` cause to satisfy a legacy validator.
- Confidence/freshness: high, local baseline.
- Contradiction/open question: hosted documents need either an explicitly versioned access record or a separate hosted namespace; the latter minimizes accidental legacy invitations/org defaults. Common auth concepts can still be factored later.
- Suggested contract impact: an authoritative hosted document record carries `{ownerAccountId, publicationId, status, artifactDigest}` and is checked by every hosted byte-serving endpoint. Hosted accounts never inherit organization defaults, invitations, or legacy `DOC_OWNERS` bindings. Use `boundFrom: 'agent-authorization'` if provenance is stored.

### A6. Device-style handoff needs a durable protocol, not a polling boolean

- Claim/current behavior: RFC 8628 specifies separated user/device codes, expiry, user confirmation, polling interval/slowdown, denial, and brute-force defenses. RFC 9700 provides current guidance for redirect and token misuse defenses.
- Source/locus: [RFC 8628 sections 3 and 5](https://www.rfc-editor.org/rfc/rfc8628.html), [RFC 9700 sections 2 and 4](https://www.rfc-editor.org/rfc/rfc9700.html), checked 2026-09-09.
- Why it matters: retries, browser account switching, a stolen verification link, and a dropped successful response are separate failure cases. A localhost callback is unnecessary for remote agents.
- Confidence/freshness: high for standards; the concrete Archon API below is a design inference, not claimed RFC conformance.
- Contradiction/open question: a title supplied by an agent is not trustworthy evidence of agent identity. An approval screen must describe the local upload and show a pairing code, not assert a verified Claude/device name.
- Suggested contract impact: approve precisely one operation and content digest, hash bearer secrets at rest, enforce server time and atomic transitions, and keep approval behind a user action rather than automatically approving on GET or OAuth return.

## Recommended concrete interfaces

These names are proposed contracts for ticket decomposition. Freeze their final spelling in one shared contract ticket before parallel consumers start.

### Hosted identity

`HostedAccount = { id, provider: 'github.com', providerUserId, loginSnapshot, displayName, createdAt }`. Key account creation by provider and numeric ID with create-only semantics. A deterministic `gh_<numeric-id>` account key is a minimal valid implementation; no separate email lookup or cross-record uniqueness index is required. An account's display fields can change without changing owner IDs. Private email is not needed.

`POST /api/hosted/auth/github/start` creates a short-lived login transaction and redirects to GitHub. Accept only an internal pending-publication ID or allowlisted application destination. Require same-origin request and browser CSRF protection. Store a 256-bit random state hash, browser binding hash, PKCE verifier, expiry, and internal return destination server-side. Protect the verifier from logs and encrypt sensitive stored transaction fields where the chosen store's boundary requires it. Use a dedicated transient `__Host-` HttpOnly Secure SameSite=Lax cookie. A full return URL from the agent is not accepted.

`GET /api/hosted/auth/github/callback` validates state, browser binding, expiry, and one-time redemption before creating a session. Exchange on fixed GitHub URLs with server client secret and S256 verifier. Reject unexpected scopes, malformed identity, provider denial, or provider outage without creating owner authority. Fetch `/user`; discard provider credentials without logging or returning them. Mint a random opaque session token, store only its hash and server-side account reference, and set `__Host-archon_session; Secure; HttpOnly; SameSite=Lax; Path=/` with no Domain attribute. Clear transaction state/cookie on completion or cancellation. Proposed session absolute lifetime: seven days, no refresh-token system in v1. `POST /api/hosted/auth/logout` revokes the server session and clears its cookie; existing approved publication capabilities retain their separate short expiry unless explicitly cancelled.

`identifyHosted(req) -> HostedAccount | null` distinguishes invalid/expired session from storage failure; a storage outage yields 503 at the HTTP boundary. `requireHostedBrowserMutation(req)` requires exact configured origin plus a session-bound CSRF token. Neither helper accepts GitHub/PAT tokens or legacy Identity cookies. The exact origin must come from trusted configuration, not arbitrary Host/X-Forwarded-Host input. Session and callback responses use private no-store, no-referrer, and frame-ancestors none. Uploaded documents never execute on this session origin.

### Agent handoff

`POST /api/hosted/publications` accepts `{v:1, title, contentSha256, contentBytes, artifactFormat}` and **no owner fields**. It creates a server-generated operation ID plus a 256-bit `agentSecret` and a distinct high-entropy browser verification secret. Return `{publicationId, verificationUriComplete, userCode, agentSecret, expiresAt, intervalSeconds:5}`. Proposed pending authorization lifetime: 15 minutes. The URL contains only the browser verification material, never agent/upload authority. Display the short `userCode` in both agent output and approval page; the high-entropy URL is required, so no public short-code lookup is necessary. Do not store secrets or document titles in request logs. A lost start response may leave an orphan pending operation; it expires and creates no document. Rate-limit starts by trusted platform client-IP identity and bound request size; do not allocate artifact storage before approval.

`GET /publish/authorize?...` displays escaped title, size, pairing code and eventual account; require sign-in before exposing detailed pending metadata. Scrub the verification secret from browser URL/history after binding it to the browser transaction. No GET, login callback, or page load approves upload. `POST /api/hosted/publications/{id}/decision` takes explicit approve/deny, session CSRF token, and the browser-bound pending request. The owner is the session account at confirmation time, verified against the displayed account. CAS allows the first valid decision only; a later account cannot replace it. Approval fixes content digest, byte length, owner, and an upload deadline proposed at ten minutes after approval.

`POST /api/hosted/publications/{id}/status` uses `Authorization: Bearer <agentSecret>`, no cookies, and returns `pending|approved|publishing|complete|denied|expired|failed`, poll interval/deadline, and only non-secret result metadata. The simplest capability model reuses this opaque operation secret: before approval it authorizes polling; after approval it authorizes uploading only the bound bytes to that operation. Thus a lost approval/poll response cannot lose a newly issued one-shot credential, and no second token store is required. Never return or accept this bearer as an account session. Browser CORS access is disabled; unexpected Origin/cookies can be rejected by contract while ordinary non-browser requests remain valid.

`PUT /api/hosted/publications/{id}/artifact` sends the approved bytes with the operation bearer. Hash and byte count must match the approved descriptor. Reserve one stable hosted document ID per operation. Write artifact privately, validate it, then atomically mark a single authoritative publication/document record complete only when all required data exists durably. The storage ticket owns crash recovery and lease/fencing details; auth supplies immutable owner/digest/deadline invariants. An interruption before commit can be retried using the same ID/bytes. After durable completion, identical retries return the same URL; changed bytes return 409. No ownership field is trusted. Result recovery is allowed for the operation secret for 24 hours after completion, while new upload authority expires at its upload deadline; after recovery expiry, reauthenticate to view the already-created URL rather than republish automatically.

Rate-limit status polls per operation: initial five seconds, `429` plus Retry-After on excess. The client increases its interval, applies exponential backoff for transport/service failures, and stops at denial, expiry, permanent validation failure or completion. Pending metadata and completed recovery records have finite retention and cleanup; enforce expiry when reading even if cleanup is late. Do not extend capability lifetime merely because the client keeps polling.

## Lifecycle and invariants

| Current state | Trigger | Next state | Invariant |
|---|---|---|---|
| pending | explicit approved browser POST | approved | One immutable owner and content descriptor |
| pending | denial / pending deadline | denied / expired | No artifact or owner document created |
| approved | authenticated validated upload starts | publishing | Same operation, reserved document ID, owner and digest |
| approved | upload deadline passes | expired | No new upload may start |
| publishing | durable artifact + authoritative commit | complete | Stable URL, private readable content, immutable owner |
| publishing | interrupted worker/storage call | publishing/retryable | Recovery follows same operation; no duplicate document |
| publishing | invalid content | failed | No readable partial document |
| complete | authenticated same-operation retry | complete | Same document and URL, never a second creation |

The storage contract must explicitly resolve expiration during an in-flight upload. Recommended: initial admission before deadline grants a bounded publishing lease; commit may complete within that lease, with fencing against expired workers. Do not independently implement a second authorization state machine in the upload handler. A terminal completion is durable even after all agent credentials expire. A completed publication record is not itself public-read authority.

## Required verification scenarios for ticket authors

1. Provider fixtures: same numeric ID with changed login/email retains ownership; different ID with same email never inherits it; null public email succeeds; a malformed ID or provider failure cannot create a session. Capture requested/granted scopes and verify no repo/org/private-email endpoint is called.
2. OAuth browser flows: missing/mismatched/replayed/expired state, missing transaction cookie, wrong PKCE verifier, account switch, exact callback enforcement, hostile return destinations, denied provider consent, provider timeout, and simultaneous callback replay. Verify session fixation resistance and cookies are HttpOnly/host-only/Secure; account APIs reject those cookies on an unrelated content origin.
3. Agent separation: an agent bearer cannot read private content or authenticate as an account; a browser verification URL cannot poll or upload; a browser session cannot silently bypass an unapproved operation; sensitive tokens never appear in errors, JSON identity responses, URLs, or audit logs.
4. Approval: two accounts race to approve the same request; precisely one owner wins. Replayed approve/deny cannot change the result. GET and OAuth return never approve. Bad Origin, missing CSRF and changed displayed identity fail. The approved title/digest/size cannot be replaced after sign-in.
5. Poll/recovery: enforce interval and expiry using injected server clock, test Retry-After and network backoff, denial stops, lost success poll recovers, and a status outage is 503 rather than denial or success. Expiration works with cleanup disabled.
6. Upload: premature/expired/wrong bearer, digest mismatch, client owner injection, two simultaneous identical uploads, lost successful upload response, storage failure after bytes but before commit, worker lease expiry, and retry after complete. Assert one durable doc ID and one immutable owner; verify raw bytes and assets remain unreadable before completion and to another account.
7. Regression: existing self-hosted login, seeded owners, invitations and edge gate remain under their current contract. Hosted auth never treats a legacy subject or organization email as hosted ownership.
8. Deployed browser evidence: use a real Archon OAuth registration and two controlled GitHub test accounts, then execute an agent start → human browser sign-in/approve → CLI upload → owner read → other-account denial → logout denial. Stubbed tests do not prove callback, provider scope, cookie, Netlify edge/function forwarding, or browser isolation behavior. Missing provider credentials is a release-verification prerequisite, not authority for an agent to create accounts or registrations without the operator's involvement.

## Sequencing and handoff impact

Freeze identity, session, publication and errors in the first shared contract. Hosted identity and durable publication-state implementation can then proceed independently, followed by decision endpoints tying them together. Agent publisher UI/CLI can target the frozen contract in parallel. Upload admission consumes approved state; private rendering consumes completed document ownership. Final integration tests depend on all four boundaries plus operator-managed OAuth callback/client-secret configuration.

Keep provider provisioning and production enablement explicit in the deployment ticket: Archon operator registers an identity-only OAuth app, sets exact callback/client secret and trusted app origin, and verifies no user is asked for Netlify membership or repository installation. No claim is made that this planning research observed the actual production provider settings.
