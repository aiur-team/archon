# Hosted upload: storage, rendering, and deployment research

Research date: 2026-09-09. Repository baseline: `dfbd7a7ed2bfb0b2f1742e1d1e2294ab599d1b79`. This is planning evidence; no application implementation, build, test, deploy, or external mutation was performed. Recommendations below require reconciliation into the build pack's canonical contracts before ticket execution.

## Recommendation

Ship a separate shared-hosting surface for one immutable, self-contained UTF-8 HTML document per publishing operation, limited to **2,097,152 input bytes**. Inline scripts, styles, SVG, and data-URL assets support interactive documents; external resources, repository integrations, server execution, archives, editing, and collaboration are outside this slice. The service must never execute or build uploaded code.

Keep bytes in a new site-wide Netlify Blobs namespace. Derive ownership from the approved Archon upload grant. Use one authoritative publication envelope, progressing `pending -> approved -> complete` with conditional writes; the final transition includes the entire document so bytes and owner cannot become visible independently. Existing generic storage primitives are reusable; existing identity, access ownership seeding, six-hex IDs, and the legacy edge gate are not suitable authorities for hosted documents.

Use a trusted account application origin and a **separate, cookieless static renderer origin**. The account page fetches authorized document bytes and transfers only those bytes to the renderer using a tightly checked `postMessage` protocol. The renderer puts them in an opaque-origin sandboxed child frame. No browser account session or upload grant reaches the renderer. This adds a small operator-owned static deployment, but avoids per-document domains, read-link bearer credentials, third-party cookies, and arbitrary HTML execution on the account origin.

## Evidence register

Every source below was checked on the research date. Confidence describes the claim, not whether Archon's future implementation has been tested.

| Claim | Source | Impact | Confidence / contradiction |
| --- | --- | --- | --- |
| Existing storage exposes strongly consistent JSON reads and bounded conditional writes. IDs in the legacy domain are six lowercase hex characters. | `netlify/lib/store.mjs`: `docState`, `read`, `mutate`, `upgrade`, `StoreError`, `assertDocId`, `MAX_MUTATE_ATTEMPTS` | Reuse generic primitives with a new store and new hosted key validators; do not widen legacy ID validation. | High, repository inspection. |
| Existing access binds first owner through `DOC_OWNERS` email matching and permits organization defaults/invitations. | `netlify/lib/access.mjs`: `resolveRole`, `assertAccessDocument`, `accessDocumentKey`; `netlify/lib/identity.mjs`: `identify`, `isOrgEmail` | A GitHub identity-only document must have a separate owner predicate. No synthetic email or organization classification. | High, repository inspection. |
| Blobs supports site-wide durability, strong reads, create-only and ETag-conditional writes; object limit is 5 GB. Stores are shared across deploy contexts. | [Blobs API, updated September 1, 2026](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) | Application input limit is much lower; production and preview must not accidentally share data. | High. A vendor prompt template says 5 MB; the detailed API wins. |
| Blobs has no TTL, and vendor guidance discourages transactional counters even with conditional-write retries. | [Netlify-maintained Blobs guide](https://raw.githubusercontent.com/netlify/context-and-tools/main/skills/netlify-blobs/SKILL.md) | Check expiry during use; cleanup is application-owned. Do not promise atomic multi-record commits or hard aggregate quotas from read/count/write. | High for stated guidance; conditional finite-state transitions are still supported by the API. |
| Synchronous functions allow 60 seconds and 6 MB buffered request/response payloads; binary transport effectively allows approximately 4.5 MB. Scheduled functions have 30 seconds. | [Function configuration](https://docs.netlify.com/build/functions/configuration/) | Choose 2 MiB raw HTML, reject compression and multipart archives, and avoid background upload responses that acknowledge before commit. | High, current official limits. |
| Functions 6.0.0 and Blobs 11.0.0 require Node 22.12+. Blobs 11.0.2 is an August 19 dependency update. Functions 5 removed the `/dev` export. | [Functions changelog](https://raw.githubusercontent.com/netlify/primitives/main/packages/functions/prod/CHANGELOG.md), [Blobs changelog](https://github.com/netlify/primitives/blob/main/packages/blobs/CHANGELOG.md), `package-lock.json` | Keep the already pinned Functions 6.0.0 / Blobs 11.0.2; verify build and runtime Node versions. Do not write a harness importing removed `/dev`. | High; no dependency upgrade needed for this plan. |
| Opaque-origin iframe sandboxing blocks same-origin authority; the HTML standard recommends a separate domain for hostile content. | [WHATWG iframe standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html) | Put active document code on the renderer origin inside `sandbox="allow-scripts"`; never add `allow-same-origin` to the artifact frame. | High for browser model, browser proof still required. |
| CSP `sandbox` and `frame-ancestors` cannot be enforced using a meta tag. | [W3C CSP Level 3](https://www.w3.org/TR/CSP3/#directive-sandbox) | HTTP headers and actual iframe attributes define trust boundaries. An uploaded meta tag is not a security control. | High. |
| TOML/static custom headers are not applied to function-generated responses. | [Netlify custom headers](https://docs.netlify.com/manage/routing/headers/) | Every hosted function sets its own no-store, nosniff, disposition, and other security headers on success and error paths. | High. |
| Basic per-domain-and-IP rate limits exist on all plans, but enforcement can lag by 10 seconds; Free allows two code rules and Pro five. Global domain aggregation requires Enterprise HP Edge. | [Netlify rate limiting](https://docs.netlify.com/manage/security/secure-access-to-sites/rate-limiting/) | Use ingress limits as abuse friction, never as an exact storage quota. Verify rule acceptance in deploy logs; invalid rules need not fail deployment. | High. |

## Exact local integration seams

`netlify/lib/store.mjs` exports `STORE_NAME = "doc-state"`, `MAX_MUTATE_ATTEMPTS = 6`, `StoreError`, `docState()`, `upgrade(value)`, `assertKey(key)`, `assertDocId(docId)`, `read(store, key, initial = null)`, `mutate(store, key, initial, apply)`, plus legacy thread/event/edit/suggestion key builders. `read` returns `{ value, etag }` and requests `{ type: "json", consistency: "strong" }`. `mutate` uses `{ onlyIfNew: true }` or `{ onlyIfMatch: etag }`, checks the returned `modified` flag, and retries conflicts. Its callback must be synchronous and free of external effects. No callback may create a second record, consume a credential, or log a success.

Proposed `hosted/lib/store.mjs` owns `hostedStore()`, `assertHostedDocId()`, `hostedDocumentKey()`, `assertHostedDocument()`, `completeHostedDocument()`, and `readOwnedDocument()`. It can import `read`, `mutate`, `upgrade`, `assertKey`, and `StoreError` from the existing generic module without modifying `docState()` or `assertDocId()`. Publication uses narrow, single-record state transitions; no billing/account-balance feature should be built on it. The final canonical contract may move these paths but must preserve one storage/state-machine authority across auth, upload, cancellation and expiry.

Use a name such as `archon-hosted-v1-production`. `getStore({ name, consistency: "strong" })` must obtain runtime credentials from Netlify, not from the publishing agent. Only an operator-controlled environment selector can select the namespace. Prefer a separate Netlify project for hosted staging rather than trusting a namespace convention to isolate hostile preview code: code in one project has access to its other site stores. Reject production requests whose actual origin is not the configured application origin; old deploy URLs must not become alternative login or document-serving origins.

`netlify/lib/access.mjs` is deliberately excluded: `resolveRole()` can write first-owner state while resolving access, the schema requires `boundFrom: "env:DOC_OWNERS"`, and `orgDefault` begins as `commenter` in the no-record path. `netlify/lib/identity.mjs` calls `@netlify/identity.getUser()` and classifies an organization-email domain. These assumptions remain appropriate to their existing self-hosted product, not the new GitHub-owned private upload surface.

`netlify/edge-functions/gate.ts` expects a legacy generated document marker after fetching downstream content. Root `netlify.toml` builds `_site` through `templates/build --site`, attaches this gate to `/*` with selected exclusions, and declares static public caching. Do not route hosted HTML into this build/gate pipeline. Add an explicitly separate hosted build/publish/functions configuration; do not weaken the legacy gate or silently change the existing site to the shared app.

`netlify/functions/retention.mjs` owns legacy event/suggestion/invitation scans. Keep hosted expiry in its own bounded scheduled function. `.github/workflows/check.yml` enumerates tests explicitly and invokes `scripts/check-test-inventory.mjs`; new tests need real CI wiring. A separate hosted build directory also needs explicit module/build coverage rather than assuming the existing `scripts/check-function-modules.mjs` scans it.

## Bundle and publication contract

Recommended application-level input format: `text/html; charset=utf-8`, one raw body, maximum 2 MiB, strict UTF-8 decoding. No `Content-Encoding`, ZIP/TAR, multipart asset tree, filename-to-path mapping, remote fetch-and-inline service, or uploaded headers. The local agent inlines assets before requesting authorization and retains the file. Count actual streamed bytes while reading; reject a too-large declared content length early, but never rely on that header alone. Abort/cancel the body on limit overflow. Validate content type, empty/invalid text, length and SHA-256 before storage. The renderer's policy, not an HTML regex sanitizer, is the active-content boundary.

The authorization request should commit title, raw UTF-8 byte length, and SHA-256 so the upload the user approves is the one later published. The title is plain display text, capped at 200 characters; it is not an HTML title fragment. Server-generated IDs should use 128 random bits or a UUID, independently of content and identity. No short legacy IDs, client-chosen storage key, or path-derived owner.

Worked immutable storage shape (illustrative values):

```json
{
  "v": 1,
  "kind": "hosted-document",
  "status": "complete",
  "docId": "hd_6ff6d2b8a27e405b9bb7ced887a417d1",
  "ownerId": "github:12345678",
  "operationSecretHash": "<one-way hash, never the bearer itself>",
  "title": "Project architecture",
  "mediaType": "text/html; charset=utf-8",
  "byteLength": 57,
  "sha256": "<64 lowercase hex digits computed over raw bytes>",
  "createdAt": "2026-09-09T18:00:00.000Z",
  "completedAt": "2026-09-09T18:03:00.000Z",
  "receiptExpiresAt": "2026-09-10T18:03:00.000Z",
  "html": "<!doctype html><html><body><h1>Diagram</h1></body></html>"
}
```

The `byteLength` above is illustrative and must be calculated by the worker fixture, not copied as an assertion. The canonical schema may choose an internal account ID instead of `github:<id>`; the invariant is a stable verified identity, never username/email.

Publication algorithm:

1. Authenticate the upload credential and read its operation strongly. Operation identity and document identity are the same server-issued random ID. The approved record already carries its immutable owner/digest/length/title.
2. Validate the complete body before any publication write. Do not accept an `ownerId` override or repurpose the upload token as a browser read credential.
3. Replace `approved` with `complete`, including the full validated HTML, using `onlyIfMatch` against the current ETag. The initial pending record was created with `onlyIfNew`. This one final conditional write is the publication commit: no independent content blob, access seed, lease, or success flag needs to become atomic with it.
4. When the write returns `modified: false`, strongly read the winner. Return its existing URL only for a matching completed owner, digest and length and a valid receipt credential. Different bytes or ownership are a conflict, never an overwrite or a second generated ID. A winning cancel/expire transition is terminal; do not reinterpret it as approval.
5. On ambiguous provider failure return a retryable error; a retry reconciles the same key. Do not claim success from an in-memory candidate. Any optional operation receipt is secondary to the committed document and must be recoverable from it.
6. Retain a 24-hour replay receipt window after completion. The same operation bearer can recover the completed URL, but cannot read HTML or other owned documents. An expired grant cannot make a new completion. Keep the completed envelope after receipt expiry; the authenticated owner can still read it.

Lost-write-response and cancel-race contract: a provider exception does not prove the write failed. A subsequent strong read with the same operation bearer may discover completion and return its receipt; if reconciliation also fails, return a retryable unavailable response and preserve the local artifact. Cancellation and completion both condition on the same ETag. Exactly one wins. A cancel handler that discovers `complete` reports already-completed and must not delete it; an uploader that discovers `cancelled` cannot publish. Expiry likewise transitions only nonterminal states using an ETag check. Re-check eligibility inside each retry transformation; do not capture a stale approved record and reapply it after cancellation. A request whose final eligible check crosses the grant deadline follows the canonical sampled-time rule; document and test that rule consistently across all three handlers.

JSON storage overhead does not use the inbound function payload budget: the server writes directly to Blobs. Raw owner reads return just HTML bytes, avoiding JSON escaping expansion in a buffered function response. Entire-document storage is acceptable at this deliberate 2 MiB bound and removes partial asset cleanup from the first release.

## Owner-serving and rendering contract

Use these conceptual routes; the final build pack owns spelling:

| Route | Authority | Representation |
| --- | --- | --- |
| `GET /d/:docId` | Valid Archon browser session and exact owner match | Trusted app shell; escaped title and fixed renderer URL only |
| `GET /api/hosted/documents/:docId/content` | Same owner check on every request | Raw HTML bytes as `application/octet-stream`, `Content-Disposition: attachment; filename="archon-document.html"`, `X-Content-Type-Options: nosniff` |
| Renderer `/` | Public static bootstrap, no account/session APIs | Empty until the authenticated app sends content in memory |

Both protected routes and their errors use `Cache-Control: private, no-store` and `Netlify-CDN-Cache-Control: no-store`; no ETag/304 shortcut before authorization. Signed-out shell navigation may redirect to same-origin sign-in with a validated local return path. Content fetch returns a generic 401 or 404, not login HTML. Return indistinguishable not-found responses for unknown and other-owned IDs. HEAD must enforce identical authorization and emit no content. Do not expose raw bytes through static assets, build output, redirect aliases, public Blob URLs, or permissive CORS. No `Access-Control-Allow-Origin: null` or credentialed renderer-origin access. GET routes have no account side effects; browser mutations require the authentication subsystem's origin/CSRF checks.

Recommended renderer protocol:

1. App creates a fixed-origin frame pointing at a configured renderer, with `referrerpolicy="no-referrer"`. If the outer trusted renderer frame is sandboxed, it needs `allow-scripts allow-same-origin` so its known renderer origin remains addressable. The renderer is cross-origin and holds no account credentials.
2. Renderer posts `{ type: "archon-renderer-ready", v: 1 }` only to its configured application origin. App validates `event.origin === rendererOrigin` and `event.source === rendererFrame.contentWindow`.
3. After owner-checked fetch, app posts `{ type: "archon-render", v: 1, html: "..." }` using the exact renderer origin as `targetOrigin`. It never sends session cookies, GitHub tokens, upload tokens, raw request URLs, or account metadata. No content/token in a query string or fragment.
4. Renderer accepts only an exact versioned shape, one message from `window.parent` whose origin matches configured application origin, and enforces the byte cap again. It assigns HTML to a newly created child iframe's `srcdoc` after setting `sandbox="allow-scripts"`. Do not interpolate HTML into renderer `innerHTML`, script strings, or the parent's document.
5. Artifact-to-parent `postMessage` is untrusted and ignored. Do not add command, fetch, navigation, clipboard, or credential bridges. Fixed-height/resizable-by-user frames avoid needing a height bridge in v1. A renderer bootstrap mounted successfully is not proof that artifact scripts succeeded; browser acceptance drives real controls inside the child.

Renderer response policy proposal:

```text
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
img-src data: blob:; font-src data:; media-src data: blob:;
connect-src 'none'; object-src 'none'; worker-src 'none';
frame-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors https://<configured-app-origin>
```

The renderer bootstrap is a small static inline script; this intentionally permissive inline-script allowance exists only on the credential-free renderer origin. The artifact `srcdoc` inherits its embedding document policy and remains sandboxed to an opaque origin. `frame-src 'none'` must be verified against `srcdoc` creation in the supported browser matrix; if a browser requires an explicit local-frame allowance, document the smallest adjustment and keep external navigation blocked. The app's own CSP may remain strict and allow frames only from its renderer. Use a header for `frame-ancestors`; a meta element cannot supply it. Deny camera, microphone, geolocation, payment, and other unnecessary permissions. Do not apply `X-Frame-Options: SAMEORIGIN` to a renderer expected to be cross-origin embedded.

This preserves DOM interactions, diagrams, CSS, canvas and in-document controls. It intentionally excludes remote libraries/fonts, network APIs, workers, browser storage dependencies, form submissions, top navigation, popups, downloads, and privileged device access. The generation skill must describe these compatibility rules and prepare a document accordingly. If required rich behavior conflicts with these constraints, that is a scope decision, not a reason to add `allow-same-origin` to the artifact frame.

Residual threat model: the Archon operator and its delivered JavaScript remain trusted with uploaded content. Sandboxing is an account-authority boundary, not a promise to run malicious JavaScript with zero possible side channels or zero browser resource consumption. Arbitrary code can freeze its frame, display misleading content, and attempt to disclose its own document; do not market this as end-to-end encryption or a general-purpose malware container. Fixed surrounding app identity and no credential prompts inside documents help users distinguish product UI from authored content.

## Abuse, cleanup, and lifecycle

Set real limits before launch: 2 MiB/document; short authorization TTL; enforced minimum polling interval; ingress rules for unauthenticated authorization starts and poll/upload traffic; capped title/metadata/error lengths. An example two-rule Free-plan shape groups authorization starts under one low-rate handler and the remaining publishing API under a second polling-compatible handler. Values must be selected with the auth polling interval and shared-enterprise-IP behavior; do not rate-limit a normal poll loop into failure.

The planning decision is a pilot with per-operation limits, edge abuse friction, usage visibility, an operator upload-disable switch, and an explicitly documented absence of hard aggregate caps. Public rollout waits for operator acceptance of the volume/rate budget. Do not use list length, an eventually updated counter, or the Netlify IP limiter as proof of a hard limit. Hard concurrent account quotas are deferred; a later requirement would need transactional reservations or a rigorously specified finite slot scheme with crash recovery. This is not covered by saying “Blobs has CAS.”

No staged asset objects exist with the one-envelope publication model. Hosted cleanup concerns expired transient authorization/session material. Expiry is enforced synchronously even when cleanup is late. Use bounded, manual pagination and a fixed work budget below the scheduled-function timeout. Never delete a record solely because stale listing metadata says expired. Completed envelopes live in the same namespace, so validate their current state and preserve them forever in this slice. Blobs documents unconditional `delete(key)`, not an ETag-conditional delete: read-then-delete of an approved record could erase a concurrent completion. Either CAS a non-complete record to an irreversible terminal tombstone first and prove no path can leave that state, or retain the small expired record and skip physical deletion. The conservative first implementation can retain tombstones. Stable random IDs are never reused. Do not expire successful documents, share legacy retention rules, or add a user-facing delete surface without scope authority.

Use separate staging/prod projects with production secrets restricted to production context. Neither a namespace suffix nor a hidden deployment URL alone is an isolation boundary. Uploads must survive a new app deployment, and rollback must continue understanding v1 records. Provisioning, domain changes, provider configuration, secret installation, production deployments, budget changes and actual GitHub sign-in remain operator actions unless separately authorized.

## Proposed ticket boundaries and proof

| Boundary | Produces / consumes | Required behavioral evidence |
| --- | --- | --- |
| Hosted storage and immutable publication | Produces owned-document schema, key factory, completion/read exports; consumes approved-upload identity/digest contract | Two simultaneous identical completions yield one ID; differing bytes conflict; cancellation races have one winner; simulated lost response retries same record; no owner override; storage rejection yields no readable document. |
| Private owner HTTP serving | Consumes hosted identity and document exports; produces shell/content endpoint contract | Owner, signed-out and second-account browser cases; HEAD/aliases/errors/304 all gated; no credential in URLs; bytes never execute as HTML when content endpoint opened directly. |
| Static renderer and viewer | Consumes content fetch route and canonical origins; produces renderer message contract and artifact compatibility fixture | Cross-origin/opaque-origin browser tests, live inline button/chart behavior, malicious parent-cookie/API/postMessage/navigation attempts fail; forged renderer origin/source messages ignored. |
| Hosted deployment and operational guardrails | Produces separate app/renderer build targets, staging isolation, runtime/env docs and rate rules | Built function configuration includes rules; no uploaded bytes in publish tree; preview cannot read production; public renderer has no credentials/functions; production rule acceptance recorded. |
| Integrated delivery proof | Consumes auth, CLI/skill, upload, viewer and deploy contracts | Real agent preparation → real browser GitHub authorization → real upload → owner rendering → second account denied; redeploy preserves URL; final-byte commit failure never prints success. |

Tests should exercise dangerous alternatives, not just rendered strings: remove owner comparison, remove artifact sandbox, permit artifact same-origin, allow a forged message origin/source, remove `onlyIfMatch` on completion, overwrite the winner on digest mismatch, trust `Content-Length`, or bypass expiry. Each relevant test must then fail. Hermetic tests use temp/local stores, a deterministic concurrent conditional-write fake, and distinct test origins. Browser tests need at least Chromium and a second engine for the CSP/srcdoc boundary. CI must name the tests and include the hosted build/module inventories. No live provider state is a fixture.

Real hosted proof requires a disposable operator-controlled staging project, renderer origin, OAuth configuration, two real GitHub identities, and permission to upload a synthetic artifact. Capture final response headers, network destinations, an actual interactive control result, denied second-user requests, a concurrent/retried upload outcome, deployment identity and timestamps. Verify conditional writes against real Blobs; a mock cannot prove provider guarantees. Verify platform rate-limit deploy-log acceptance and delayed enforcement separately from application quotas. Missing credentials or domains must produce an explicit operator gate, never a fabricated successful hosted test or a silent mock fallback.
