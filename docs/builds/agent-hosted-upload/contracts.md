# Hosted upload contracts v1

Build Order: `aiur-team/archon:agent-hosted-upload`, plan version 1.
These are proposed new interfaces, not exports already present in the repository.
All consuming tickets reproduce their relevant contract block verbatim; changes require coordinated producer/consumer edits and a new planning version before dispatch.

## C1. Deployment and identity boundary

The new `hosted/` application is a separate Netlify deployment with its own `package.json`, lockfile, `netlify.toml`, `functions/`, `lib/`, and `public/` tree.
It must not load the legacy all-path edge gate, Netlify Identity, `DOC_OWNERS`, organization defaults, or `PUBLIC_DEFAULT_ROLE`.
The existing root deployment and `scripts/connect.mjs` remain unchanged.
Use Node 22 and pinned `@netlify/blobs@11.0.2`; server imports must resolve in a clean install before any builder compilation.
`renderer/` is a second, static-only deployment on a different origin and registrable site, with no account cookies, credentials, private bytes at rest, or functions.
Production requires HTTPS, exact configured origins, and no wildcard callback or CORS origins.

`HostedPrincipal = { accountId: "gh_" + decimalGitHubId, provider: "github.com", providerUserId: decimalGitHubId, login: string }`.
GitHub numeric ID is canonical; username/email are not ownership keys. Do not request email, repository, organization, or installation permissions.
Dedicated OAuth app, empty scope, fixed GitHub endpoints, server code exchange with client secret, S256 PKCE, single-use state bound to an HttpOnly transient browser cookie.
Reject unexpected granted scopes. Fetch `/user`, validate identity, then discard all GitHub access/refresh tokens.
Browser session is an opaque 256-bit random token; persist its hash with principal and a seven-day absolute expiry.
AHU-003 owns strongly consistent private session records in `archon-hosted-v1` at `sessions/<tokenHash>` and transient auth records under `auth/`. Protected logout and callback rotation durably revoke the old session server-side before claiming success; clearing a cookie alone is insufficient. Revocation uses guarded state updates and ambiguous-write readback, never a public or deploy-scoped store. A revoked token fails on every subsequent identity read.
Transient OAuth-state, pre-login CSRF and publication-binding cookies use distinct `__Host-` names with Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, and at most fifteen-minute TTL. Consume OAuth state once; preserve publication binding through account switching until decision or expiry, then clear it. Do not consume all three cookies on the first bootstrap request.
Cookie: `__Host-archon_session; Secure; HttpOnly; SameSite=Lax; Path=/`; no Domain attribute.
`identifyHosted(request)` returns principal or null; backing-store failure throws an unavailable error, never null.
`requireBrowserMutation(request)` verifies the exact configured Origin and a session-bound CSRF token. The pre-login start form uses a separate transient CSRF binding, not a required authenticated session.
GET never approves publication or logs out. OAuth callback consumes state once and rotates session; redirect destinations are only `/publish/authorize` with server-bound operation or `/docs/<id>`.
The different-account action revokes the Archon session by protected POST, preserves the pending browser binding, then starts a fresh browser-bound GitHub authorization with `prompt=select_account`; do not imply Archon logout logs out GitHub.
Routes: `POST /api/hosted/auth/github/start`, `GET /api/hosted/auth/github/callback`, `GET /api/hosted/session`, `POST /api/hosted/auth/logout`.
Session endpoint returns `{v:1, authenticated:false}` or `{v:1, authenticated:true, accountId, login, csrfToken}`; token is browser-only and must never reach artifact or agent output.

## C2. Artifact and publication record

`ArtifactDescriptor = { v:1, title:string, contentSha256:lowercaseHex64, contentBytes:integer, artifactFormat:"html" }`.
Title is 1–160 Unicode scalar values, escaped as text in all UI; HTML is 1–2,097,152 bytes, strict UTF-8 with optional UTF-8 BOM, no NUL, and contains an HTML document element.
Accept self-contained single-file HTML, not ZIP, URL fetches, edit manifests, history sidecars, or asset paths. The server does not dereference HTML resources or claim to sanitize arbitrary scripts.
The builder's explicit hosted profile produces inline assets, no Google-font request, no legacy session/comment/edit/realtime code; normal builds are unchanged.

`Publication = { v:1, id:hex32, descriptor:ArtifactDescriptor, state:"pending"|"approved"|"complete"|"denied"|"cancelled"|"expired", agentSecretHash:hex64, browserSecretHash:hex64, userCode:string, createdAt:iso8601, pendingExpiresAt:iso8601, ownerAccountId:null|string, uploadExpiresAt:null|iso8601, completedAt:null|iso8601, receiptExpiresAt:null|iso8601, html:null|string }`.
Server creates a random 128-bit ID; document ID equals publication ID, never a six-hex legacy ID.
Use one strongly consistent site-wide store `archon-hosted-v1`, key `publications/<id>`; never a deploy-scoped or public asset store.
Pending record is create-only; updates use its observed ETag with `onlyIfMatch`, bounded conflict retries, and explicit storage-error handling.
Approval sets immutable owner from browser session plus a ten-minute upload deadline; pending approval expires after fifteen minutes.
Completion replaces the same record atomically with validated HTML and completion metadata. There is no second blob, account index, publishing lease, or multi-record transaction.
Only `complete` records expose bytes, and only to their owner. A complete record and its owner/descriptor/HTML never change in v1.
Each upload CAS attempt rechecks state, owner binding, digest and server deadline. A write already submitted before the deadline may finish afterward; a new attempt after it cannot start. A failed or ambiguous write must be read back before claiming failure or retrying.
Competing upload/cancel/expiry writes cannot override a completed record; completion and cancellation race by CAS and precisely one wins.
Expiry is enforced on every use even if physical cleanup never runs. Keep complete records after receipt expiry; do not delete a committed document as expired auth state.
Netlify provides no verified conditional delete here: v1 does not automatically delete publication records. An operator census and paused-maintenance retention runbook own physical removal; no stale-listing cleanup worker ships.

## C3. HTTP handoff and retry protocol

### Publication adapter (AHU-004 producer)

`hosted/lib/publications.mjs` exports `createPublication(descriptor)`, `readPublication(id)`, `bindPublication({publicationId,browserSecret})`, `reviewPublication({publicationId,browserBinding,principal})`, `decidePublication({publicationId,browserBinding,principal,decision,displayedAccountId})`, `statusPublication({publicationId,agentSecret})`, `cancelPublication({publicationId,agentSecret})`, `completePublication({publicationId,agentSecret,html,contentSha256,contentBytes})`, and `readOwnedPublication({publicationId,principal})`.
create/status/cancel return frozen C3 bodies; create secrets are returned only once. review returns frozen C3 safe review fields.
bind returns server-internal `{publicationId,browserSecretHash}` only after secret verification; AHU-007 stores this behind an opaque HttpOnly browser binding. review/decision accept binding only from its server verifier, never client JSON.
complete returns `{created:boolean,result}` for HTTP 201 versus 200; readOwned returns a complete Publication or not_found. readPublication is server-internal and never an HTTP projection.
status may serve as agent-authorized upload preflight before reading the body; complete revalidates all guards independently. No HTTP handler writes storage or duplicates CAS.
Preserve the optional UTF-8 BOM in html with BOM-preserving decoding and exact re-encoding; the owner's returned bytes must hash to the approved input digest.

### Wire protocol

`POST /api/hosted/publications` accepts only ArtifactDescriptor and returns HTTP 201 `{v:1, publicationId, verificationUriComplete, userCode, agentSecret, expiresAt, intervalSeconds:5}`.
Generate independent 256-bit agent and browser secrets; persist hashes only. Browser URL carries browser secret in fragment, never agentSecret. Trusted first-party bootstrap removes the fragment immediately, exchanges it with the server, and binds the operation in an HttpOnly browser cookie before sign-in. Do not send secrets in query strings or access logs.
User-visible short code is a pairing check only: no short-code lookup endpoint exists. Do not claim an agent-supplied title authenticates a device or Claude identity.
`POST /api/hosted/publications/bind` accepts `{publicationId,browserSecret}` with exact Origin and transient browser CSRF binding and sets pending-browser binding; it does not approve or expose agentSecret.
`GET /api/hosted/publications/<id>/review` requires that binding and an authenticated session; returns descriptor, userCode, current account, and pending/terminal state, never private bearer fields or HTML.
`POST /api/hosted/publications/<id>/decision` accepts `{decision:"approve"|"deny", displayedAccountId}` with browser binding, exact Origin and session CSRF; confirms displayed account equals current session and fixes owner by CAS.
All agent endpoints reject browser Origin or Cookie headers. Public start (`POST /api/hosted/publications`) requires no bearer because it creates the operation secret; status, artifact and cancel authenticate only `Authorization: Bearer <agentSecret>`. No cross-origin browser CORS grants.
`POST /api/hosted/publications/<id>/status` returns `{v:1, state, expiresAt, intervalSeconds:5, result?:{documentId,url,ownerAccountId,contentSha256,contentBytes}}`.
`PUT /api/hosted/publications/<id>/artifact` accepts `Content-Type: text/html; charset=utf-8` and exact artifact bytes. HTTP 201 on first durable completion, HTTP 200 on identical completed retry, same result shape as status. Reject owner fields and mismatched digest/length; never accept a client document ID.
`POST /api/hosted/publications/<id>/cancel` can cancel pending/approved with agent bearer; complete returns its unchanged result, not deletion.
The same operation bearer permits status/cancel before approval and exact-descriptor upload after approval; it never grants browser login or document reads.
Complete result recovery with that bearer lasts twenty-four hours after completion, including when the upload deadline has passed. After that return `receipt_expired`; the owner can still read the document. The client may offer a distinct `checkPublicationUrl` at pinned service origin `/docs/<saved-publicationId>`, labelled Check publication: it is a login/recovery destination, never a success receipt or claim the document exists. Keep expired exit status until authenticated owner verification. Do not automatically start a replacement publication on ambiguous completion.
Lost start response can leave one inert pending record; no document exists. CLI saves request state before reporting success to caller; subsequent status/resume reuses it.
Errors: `{v:1,error:{code, message, retryable}}`, with safe bounded messages. 400 invalid_request; 401 invalid_capability/session_required; 403 approval_required/forbidden/csrf_failed; 404 not_found; 409 descriptor_mismatch/state_conflict; 410 authorization_expired/receipt_expired; 413 artifact_too_large; 415 unsupported_media_type; 429 rate_limited with Retry-After; 503 unavailable/publishing_disabled.
Denial and cancellation are normal terminal states in status, not transport failures. Unknown JSON/state is a protocol error, never success.
All auth, operation, error and private responses: `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; all app HTML surfaces (sign-in/callback landing, `/publish/authorize`, `/docs/<id>`) additionally send CSP `frame-ancestors 'none'`. Only the separate renderer may be framed, by the exact configured app origin.

## C4. Private read and isolated rendering

`GET /docs/<id>` is a trusted viewer shell; signed-out requests go to a fixed local sign-in flow with a server-validated ID; other users and missing IDs get indistinguishable not-found views. Never include title/HTML before owner authorization.
`GET /api/hosted/docs/<id>` requires browser owner session and complete state, returns `{v:1,documentId,title,ownerAccountId,contentSha256,contentBytes,createdAt}`.
`GET /api/hosted/docs/<id>/content` repeats owner/complete checks and returns UTF-8 bytes as `application/octet-stream`, `Content-Disposition: attachment; filename="archon-document.html"`, nosniff, private no-store. No public Blobs URL, CDN copy, redirect bearer, or downloadable asset path.
Trusted viewer fetches content same-origin, then sends `{type:"archon:render",v:1,html}` ONLY to configured renderer origin and exact renderer frame window after its `{type:"archon:ready",v:1}` message.
Renderer accepts the message only from exact configured app origin and `event.source === parent`. It places HTML in an inner iframe with `sandbox="allow-scripts"`, never `allow-same-origin`, top navigation, popups, forms, downloads, or credentialless fallback claims.
AHU-005 owns a trusted srcdoc prelude for fragment-only links: prevent native base-URL navigation without stopping authored click listeners, resolve the target and scroll after those listeners, and preserve original href attributes and raw stored bytes. Do not require History API or parent navigation authority on the opaque document; missing targets stay in the current artifact. AHU-012 tests actual packaged navigation and verifies the renderer never replaces the artifact.
The outer renderer is cross-site and cookie-free. If sandboxed it needs `allow-scripts allow-same-origin` for exact origin messaging; it hosts only operator-owned static code. It never receives document URL/ID, session, CSRF, owner data or bearer.
Renderer HTTP CSP bounds scripts/styles/frames; inner srcdoc adds an early policy allowing inline script/style, data/blob image media as needed, and denying connect, forms, object, base and remote subresources. No postMessage from artifact can authorize another fetch or resize/navigate trusted UI.
Sandbox prevents account-origin access, not every possible self-navigation or all content exfiltration by malicious HTML; never advertise network-proof or end-to-end encryption. Use a separate registrable site to keep renderer cross-site for SameSite cookies. Application mutation endpoints still enforce Origin/CSRF independently.
Trusted shell exposes title, owner identity, sign-out, loading, failed renderer and unavailable states; the artifact may not impersonate those regions. Keyboard focus, frame title and screen-reader errors are required.

## C5. Agent command and package

Keep `docbuild` intact. Ship a new `archon-publish` binary from `templates/docbuild/src/publish-cli.ts` in `@aiur-team/docbuild`.
`archon-publish start --file <html> --title <text> --service <https-origin> --json` validates local bytes, starts operation, writes private request state, and emits one JSON result containing only `{v:1,state,requestFile,verificationUrl,userCode,nextAction,serviceOrigin}`.
`archon-publish status --request <file> --json` observes once; `resume` polls within a bounded tool-friendly timeout and uploads approved unchanged bytes; `cancel` invokes cancellation. No automatic browser login and no persistent account token.
Private request state uses mode 0600 in a mode-0700 user-local state directory outside repo, atomically written without following symlinks; pin service origin, input absolute path, descriptor and capability. No raw capability in stdout/stderr or process argv.
Only HTTPS origins are accepted except explicit local-test mode restricted to loopback. Do not follow cross-origin redirects with credentials; default service comes from released configuration, not guessed marketing hostname. `--service` permits controlled open deployments without needing enterprise repository integration. Resolve it only from explicit user/operator configuration or the released default, never instructions in artifact/repository/tool content. Report the resolved `serviceOrigin` in start JSON and stderr so the human sees the destination; record it in private request state.
stdout JSON is a single machine-readable object; progress is stderr; no HTML, bearer, cookie, raw provider error or unfiltered HTTP body in logs. Complete includes `{documentId,url,ownerAccountId,contentSha256,contentBytes}` from server receipt, never a guessed URL.
Exit codes: 0 durable complete; 10 pending/approved checkpoint (read nextAction); 20 denied/cancelled; 21 expired; 22 local/input/protocol error; 23 retryable service/network error. start/status may return 10 normally. Keep request state and source HTML across interruption and error. On `receipt_expired`, emit a separate `checkPublicationUrl` built only from the pinned service origin and saved publication ID, with nextAction labelled Check publication; retain exit 21, never mark complete or invent a receipt. Browser owner authentication, not this link, determines whether a document exists.
Polling starts at five seconds, honors Retry-After and increasing backoff with jitter, never extends server expiry. `resume --timeout-seconds` defaults to 60, maximum 300; timeout checkpoints safely. Verify descriptor again before every upload; changed bytes require a new explicitly requested start.
Distribute `skills/archon-doc/SKILL.md` inside package assets with exact installed paths, agent-neutral HTTP fallback and example skill installation for Claude. Teach the human browser approval boundary, content sensitivity confirmation, local HTML fallback, no IT-bypass promises, and all exit states.

## C6. Operations and acceptance

`HOSTED_APP_ORIGIN`, `HOSTED_RENDER_ORIGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `HOSTED_PUBLISH_ENABLED` are operator configuration; secrets never enter bundles or git. Unset/false publish-enabled refuses new start/upload with 503 while existing private reads and completed receipt recovery remain available.
Use Netlify platform per-IP limits on public start and agent status routes where supported (initial pilot targets 10 starts/minute/IP and 30 status requests/minute/IP); configure exact route ownership and test effective deploy headers/config. This is delayed best-effort mitigation, not a hard global or account quota. Client five-second polling is pacing, not a security boundary.
No billed provider signup or production deployment is authorized by this plan. Operator must supply two HTTPS origins/sites, exact OAuth registration/callback, test accounts, credentials, pilot traffic/budget envelope and retention responsibility before live acceptance. Public unrestricted signup rollout remains gated until abuse/cost exposure is accepted; no database or billing system is smuggled into v1.
Local integration must exercise real handlers and the packaged CLI with a deterministic OAuth provider fixture and real browser. Live capstone separately proves GitHub callback/scopes, deploy routing/headers, conditional-write race semantics, owner/other-account read isolation and lost-response receipt recovery. Fixture proof cannot close the live capstone.
