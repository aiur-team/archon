# `hosted/` — the hosted publishing deployment

A second Netlify deployment, separate from the repo-backed `_site` build at the
repository root. It exists to give an Archon agent a way to hand one
self-contained HTML document to a person, have that person approve it in their
own browser, and make the result readable only by them.

This directory holds the **service boundary and its contracts**, and the
**identity-only GitHub sign-in** built on top of them. There is no publication
storage and no upload route yet; those are separate tickets. The shell at
`public/index.html` says so in as many words, because a placeholder that implied
otherwise would be a production surface making a claim nothing behind it can
keep.

## Why it is separate from `netlify/`

The root deployment is the self-hosted product. It resolves roles through
Netlify Identity, a `DOC_OWNERS` allowlist, organisation email defaults and the
all-path `gate` edge function. Those are correct authorities for a site an
organisation runs for itself, and the wrong ones for a shared service where the
only thing known about a visitor is which GitHub account they signed in with.

So the two trees share nothing at runtime: separate `package.json`, separate
lockfile, separate `netlify.toml`, separate functions directory. `hosted/`
imports nothing from `netlify/`, and `scripts/check-hosted-modules.mjs` fails
the build if it ever does. Nothing about the root deployment or
`scripts/connect.mjs` changes.

## Layout

| Path | What it is |
| --- | --- |
| `netlify.toml` | Deployment configuration. No edge function, no build command, no environment values. |
| `public/` | Static app shell, served as committed. |
| `lib/` | Server modules. Deployed. |
| `functions/` | Routed Netlify functions under `/api/hosted/*`. |
| `test/` | Tests and fixtures. Never reachable from a deployed module. |
| `docs/` | Consumer documentation for the modules in `lib/`. |

## Rules for code in this tree

`scripts/check-hosted-modules.mjs` enforces these on every build, and
`scripts/check-hosted-modules.test.mjs` proves it fails when they are broken.

Read them as "this cannot happen by accident or in passing", not as "this cannot
happen". The gate catches mistakes, straightforward spellings, and everything
that executes while the tree loads. A determined author inside `hosted/` has
`eval`, `new Function` and computed names, and a hostile declared dependency has
its own cold start; both are stopped by review of the diff and of the lockfile,
which is where each becomes visible.

- **Deployable code lives in `lib/` or `functions/`.** A module anywhere else
  under `hosted/` is refused rather than left unscanned.
- **Nothing resolves outside `hosted/`**, and every bare import must be a
  declared dependency that resolves inside `hosted/node_modules` — not a package
  that happens to be installed at the repository root. This rule is the sole
  barrier rather than a second opinion: Netlify's esbuild bundler follows a
  relative import anywhere in the checked-out repository, so a module reaching
  into `netlify/lib/` would bundle and deploy, working as written.
- **Nothing deployed may import `hosted/test/`.**
- **Static imports only.** Dynamic `import(` is refused anywhere in the tree,
  including inside a comment. The resolver observes every static import exactly;
  a dynamic one inside a function body is invisible to any check that does not
  execute it, and its specifier can be computed. Write "dynamic import" in prose
  if you need to mention it.
- **`.mjs` only.** No TypeScript — the deploy has no build step, and the gate
  has to be able to load what it checks. No `.cjs` or `.js` either: the boundary
  rules above are read off an ESM resolution hook, which Node never consults for
  a CommonJS `require()`, and a `.js` file's module system is decided by the
  nearest `package.json` rather than by the file itself.
- **No CommonJS `require` acquired in any of the ways a hosted module would
  plausibly acquire one.** `.mjs` alone does not stop
  `createRequire`, so builtin imports are an allowlist (`node:buffer`,
  `node:crypto`, `node:url`, `node:util`) that `node:module` can never join, and
  the names `createRequire` and `getBuiltinModule` are refused anywhere in the
  source for the same reason dynamic `import(` is: an acquisition inside a
  function body nothing calls is invisible to any hook. Both names are matched
  on the source as written *and* on the source with `\uXXXX` escapes decoded,
  because `create\u0052equire` is the same identifier to the parser. Needing
  another builtin is a one-line reviewed change to `ALLOWED_BUILTINS`.
- **The rule above covers what the tree loads, not just the files in it.** A
  declared dependency that imports `createRequire` and re-exports it under
  another name, for a handler to call from a body nothing executes, spells no
  banned name in any hosted file — but its own `import ... from "node:module"`
  happens when the hosted module links against it. So every module reached
  transitively from a hosted one is judged on that one capability: it may not
  resolve `node:module`, and it may not resolve a file outside `hosted/`. Its
  other internals are its own business. The second route to the same capability,
  `process.getBuiltinModule`, goes through no resolver, so the gate wraps the
  function while the tree loads and records a request for `node:module` whoever
  makes it. What remains is a dependency that acquires the capability without
  resolving or calling anything at load time: that is the dependency trust
  boundary, owned by the lockfile and by review of `package.json`.
- **`engines.node` is a `>=` floor of at least 22.15.0.** That is where
  `module.registerHooks` arrives, and the whole boundary is read off a
  synchronous resolution hook; a manifest permitting an older Node is a claim
  the deploy does not keep, so the gate refuses one. `netlify.toml` pins
  `NODE_VERSION = "22"`, which Netlify resolves to the newest 22.x.

## Modules

### `lib/contracts.mjs`

Pure validators and constants for contracts v1. No network, no clock, no ambient
environment. Each validator returns a validated, frozen value or throws a
`HostedContractError` carrying a wire error code — there is no third answer, and
in particular no way to spell "could not check" as success.

| Export | Purpose |
| --- | --- |
| `validateDescriptor(value, options?)` | C2 artifact descriptor. |
| `validatePublication(value, options?)` | C2 stored publication record, including its state-dependent nullability matrix. |
| `validatePrincipal(value, options?)` | C1 `HostedPrincipal`. |
| `validateSessionResponse(value, options?)` | C1 session-endpoint body, signed in or out. |
| `validateStartResponse(value, {appOrigin, ...})` | C3 201 start body. **`appOrigin` required.** |
| `validateResult(value, {appOrigin?, ...})` | C3 status / completion envelope. **`appOrigin` required when `complete`.** |
| `validateWireError(value, options?)` | C3 error envelope. |
| `validateDocumentMetadata(value, options?)` | C4 owner document metadata. |
| `validateReadyMessage` / `validateRenderMessage` | C4 renderer messages. |
| `validateOrigin(value, options?)` | One canonical origin. `{production: false}` relaxes the scheme only. |
| `registrableSite(origin, options?)` / `isLoopbackOrigin(origin)` | Site comparison helpers. |
| `decodeArtifactBytes` / `encodeArtifactBytes` | Strict-UTF-8, BOM-preserving round trip. |
| `HOSTED_LIMITS` | C2/C3 bounds and constants. |
| `PUBLICATION_STATES`, `TERMINAL_PUBLICATION_STATES`, `RENDER_MESSAGE_TYPES`, `LOOPBACK_HOSTS` | Vocabulary. |
| `ERROR_CODES` | C3 codes with their HTTP status and retryability. |
| `HostedContractError` | Typed invalid-input error, with `.toWire()`. |

Two things are worth knowing before you consume these:

- **`appOrigin` is required, not optional, for a receipt.** A self-consistent
  URL is not enough. Without pinning the origin, a hostile responder can return
  a perfectly well-formed `complete` envelope pointing at its own host and a
  client will print it as the user's published document. Omitting the option
  raises a `TypeError`, so the unsafe call cannot be written by accident.
- **`HOSTED_LIMITS.RECOMMENDED_USER_CODE_PATTERN` is advice, not a rule.** C2
  says `userCode: string`, so that is all `validatePublication` enforces.
  `lib/publications.mjs` does mint codes in the recommended alphabet; a shared
  validator that demanded it would silently amend the contract for every sibling.

### `lib/secrets.mjs`

The four cryptographic primitives everything else is built from: `randomToken()`
(256 bits, base64url), `hashToken()` (the SHA-256 hex a record is keyed by),
`sha256Base64Url()` (PKCE and the CSRF derivation) and `constantTimeEqual()`.

Two properties the rest of the tree assumes. **A secret is never a storage key** —
every record is filed under the digest of the token the browser holds, so a dump
of the store yields no usable credential. And **comparisons do not leak length** —
`constantTimeEqual` digests both sides to a fixed 32 bytes first, so it accepts
mismatched inputs that `crypto.timingSafeEqual` would refuse outright, and the
length check that would have preceded it is not a length oracle.

### `lib/auth-errors.mjs`

The typed errors, all extending `HostedContractError`, so a handler catches one
family and every one of them already carries a wire code, an HTTP status and a
`.toWire()` envelope.

| Error | Code | Meaning |
| --- | --- | --- |
| `AuthUnavailableError` | `unavailable` | The backing state or the provider could not be reached. Carries `reason: "storage" \| "provider"`. |
| `SessionRequiredError` | `session_required` | No usable session on a request that needs one. |
| `CsrfFailedError` | `csrf_failed` | The browser-only binding was absent, stale or wrong. |
| `ForbiddenOriginError` | `forbidden` | The request did not come from the configured origin. |
| `AuthRequestError` | `invalid_request` | Malformed request, or a provider round trip the visitor should restart. |

**`AuthUnavailableError` is the distinction AHU-007 and the private-read ticket
need.** "Nobody is signed in" and "we could not find out" must not be the same
value: a storage outage that read as signed-out would be a fail-open, and the
visible symptom is a service that looks like it is working. No error here carries
a `cause`, because a store or provider exception's message can contain a URL with
a token in it; `reason` is a word from a closed set instead.

### `lib/auth-store.mjs`

The `archon-hosted-v1` namespaces AHU-003 owns, and nothing else. Publication
state is AHU-004's and this module cannot reach it.

```
sessions/<sha256(sessionToken)>   browser session, seven-day absolute expiry
auth/oauth/<sha256(state)>        one OAuth transaction, fifteen minutes
auth/login/<sha256(token)>        one pre-login CSRF binding, fifteen minutes
auth/binding/<sha256(token)>      one pending publication binding, fifteen minutes
```

| Export | Purpose |
| --- | --- |
| `AuthStore` | The adapter, over an injected store object and an injected clock. |
| `openAuthStore({storeFactory?, now?})` | The production adapter: site-scoped, `consistency: "strong"`. |
| `HOSTED_STORE_NAME`, `SESSION_PREFIX`, `TRANSIENT_PREFIX`, `TRANSIENT_KINDS` | The namespaces. |
| `SESSION_TTL_SECONDS`, `TRANSIENT_TTL_SECONDS` | Seven days; fifteen minutes. |

Four things are load-bearing:

- **Every read is strongly consistent.** An eventually consistent read of a
  session record is a revocation that has not happened yet: logout returns
  success and a copied cookie keeps working from a stale replica.
- **The store is site-scoped, never deploy-scoped.** A deploy-scoped store is a
  different store per deploy, so a revocation written against one deploy would
  be invisible to another — a revoked token that keeps working.
- **Single use is a compare-and-set, not a delete.** An unconditional delete is
  not single use: two callbacks with the same state both read a live record,
  both proceed, and the second delete succeeds against nothing.
  `consumeTransient` writes the record back marked consumed with
  `onlyIfMatch: <etag>` and treats `modified: false` as "somebody else won".
- **`{modified: true}` is not believed.** `@netlify/blobs@11.0.2` maps *every*
  non-412 status of a conditional PUT to `{modified: true}`, and its retry
  helper returns a 5xx response instead of throwing once the attempts are used
  up — so a store having a bad day reports guarded writes as successful. Every
  write here carries a random `writeId` and counts as landed only when the
  record reads back carrying it. A `onlyIfMatch` write is refused outright when
  the read carried no ETag, because the client applies the condition only when
  the value is truthy and would otherwise perform an unconditional write.
- **A revocation is never reported without being observed.** A guarded write
  that throws is *ambiguous* — a timed-out request may still have applied — so
  the record is read back. Dead means success; live means an outage, and an
  outage is an `AuthUnavailableError` rather than a claim of success.
- **The pre-login binding has provenance.** `GET /api/hosted/session` mints it
  with `createTransient("login")` and stores only its hash; the start route
  redeems the presented cookie with `consumeTransient("login", …)`. So the
  binding proves two things — this browser was handed the value by this
  deployment, and it has not been spent — rather than only that some
  well-formed cookie was present. An earlier version wrote nothing at issue
  time and let the start route claim any 32–256 character token once, to keep an
  unauthenticated `GET` from writing; that made a *fabricated* cookie as good as
  an issued one, and left `SameSite=Lax` plus the exact `Origin` carrying the
  whole CSRF defence alone. The record it now writes is what the redemption
  checks against, and it is bounded by the same fifteen-minute window as every
  other transient.

Nothing schedules a cleanup. Expiry is enforced on every lookup, so physical
records outliving their lifetimes is the normal case rather than an anomaly; see
**Operator maintenance** below.

### `lib/github-oauth.mjs`

| Export | Purpose |
| --- | --- |
| `exchangeCodeForIdentity({code, codeVerifier, config}, {fetchImpl?, timeoutMs?})` | Redeem a code and return a validated `HostedPrincipal`. |
| `buildAuthorizeUrl({clientId, redirectUri, state, codeChallenge, selectAccount?})` | The provider URL. |
| `createPkcePair()` | An S256 verifier and challenge. |
| `callbackUri(appOrigin)` / `CALLBACK_PATH` | The exact registered callback. |
| `GITHUB_AUTHORIZE_URL`, `GITHUB_TOKEN_URL`, `GITHUB_USER_URL` | Fixed endpoints. |

- **No access token is ever returned.** The exchange and the `/user` call happen
  inside one function, so there is no exported value a caller could persist or
  log. `refresh_token` and the expiry fields modern OAuth app responses carry are
  read past and discarded, never persisted as a capability nobody asked for.
- **No `scope` parameter is emitted at all**, which is not the same as `scope=`
  and the consent screen shows the difference. A token response reporting *any*
  granted scope is refused rather than used.
- **The numeric ID is the identity.** A login can be renamed and reused and an
  email is optional and absent for most accounts; `id` must arrive as a safe
  positive integer, so a provider field spelled `"1010"` or `1.5` cannot become
  an account. `login` is display only; `email` is neither requested nor read.
- **Both calls are bounded.** A timeout is `AuthUnavailableError` with
  `reason: "provider"`; a 5xx is an outage and a 4xx is not.

### `lib/identity.mjs`

The C1 boundary. Downstream tickets should ask it two questions and nothing else.

| Export | Purpose |
| --- | --- |
| `identifyHosted(request, {store})` | The principal, `null`, or **throws** `AuthUnavailableError`. |
| `requireBrowserMutation(request, {store, config, presentedCsrf?})` | `{principal, sessionToken}` or a typed refusal. |
| `requireExactOrigin(request, config)` | Exact string equality against `config.appOrigin`. |
| `deriveCsrfToken(sessionToken)` | The browser-only, session-bound CSRF token. |
| `validateDestination(value)` | The two internal destinations, and only those. |
| `parseCookies`, `readCookie`, `serializeCookie`, `clearCookie` | The cookie boundary. |
| `SESSION_COOKIE`, `OAUTH_COOKIE`, `LOGIN_COOKIE`, `BINDING_COOKIE`, `CSRF_HEADER` | Names. |
| `createPendingBinding`, `readPendingBinding`, `clearPendingBinding` | The AHU-007 seam, below. |

**The CSRF token is derived, not stored:**
`SHA-256("archon-hosted-csrf-v1:" + sessionToken)`, base64url. It is bound to one
session by construction, it dies exactly when the session dies, and it is
one-way — a token that leaked into a page or an artifact does not yield the
session cookie. That is what makes it safe to hand to JavaScript while the
session cookie stays `HttpOnly`.

**`validateDestination` is an allowlist of two literals**, matched against the
raw string with no decoding and no `new URL`. That is why the whole family of
redirect-injection spellings — `//host`, `/\host`, `https://host`, `%2F`
separators, an unknown internal path — is uninteresting rather than individually
defended. The legacy root login's `safeNext` is deliberately *not* reused: its
"any same-site path" grammar is right for a site with many pages and wrong here.

## The four routes

| Route | Method | Behaviour |
| --- | --- | --- |
| `/api/hosted/session` | `GET` | `{v:1, authenticated:false}` or `{v:1, authenticated:true, accountId, login, csrfToken}`. Both answers issue a fresh pre-login binding; the signed-out answer also clears a dead session cookie. |
| `/api/hosted/auth/github/start` | `POST` | Begins a browser-bound authorization; `303` to GitHub. |
| `/api/hosted/auth/github/callback` | `GET` | Consumes state once, rotates the session, `303` to the stored destination. |
| `/api/hosted/auth/logout` | `POST` | Revokes server-side, then clears the cookie. |

`GET` never approves anything and never logs anybody out: logout answers `GET`
with a `405` that touches no record.

**Cookies.** Four distinct `__Host-` names, all `Secure; HttpOnly; SameSite=Lax;
Path=/` with no `Domain`. The prefix is browser-enforced rather than
server-promised, and the `Domain` part is the one that matters: a cookie with a
`Domain` is writable by every sibling subdomain, including a stray preview
deployment.

| Cookie | Lifetime | Consumed |
| --- | --- | --- |
| `__Host-archon_session` | 7 days | On logout and on callback rotation. |
| `__Host-archon_oauth` | 15 minutes | Once, by the callback. |
| `__Host-archon_login` | 15 minutes | Once, by a start (claim-on-use). |
| `__Host-archon_publish` | 15 minutes | **Survives an account switch**; cleared on a decision or at expiry. |

**Why the pre-login binding is presence rather than a double submit.** C1 freezes
the signed-out session body to `{v:1, authenticated:false}` and freezes every
transient cookie as `HttpOnly`, so there is no conformant channel for handing a
token to the static sign-in page for it to echo back — the body may not carry it
and JavaScript may not read the cookie. The binding rests on two independent
properties instead: `SameSite=Lax` means a cross-site POST carries no
`__Host-archon_login` at all, and the `Origin` header must equal the one
configured origin exactly. It is single-use through the same compare-and-set as
the OAuth state, so a captured binding cannot be replayed and a retry is a new
transaction rather than a replayed one.

**The OAuth cookie and the `state` are two different secrets.** The cookie
carries a random binding that never leaves the browser; only its SHA-256 is
stored on the transaction, and `state` — the half that travels through GitHub
and lands in access logs, traces and history — is useless without it. Making
them one value looked like a double submit and was not: the `__Host-` prefix is
enforced by browsers, while the server only reads a `Cookie` header, so anyone
who learned the callback URL held both halves and could redeem the code with
`curl`. The callback also proves the binding *before* it writes or clears
anything, so a stranger cannot burn a victim's in-flight transaction either.

**Why callback failures redirect.** The callback is reached by a top-level
navigation, so a JSON envelope rendered as text is not an actionable retry path.
Every failure lands on `/login/?status=<word>` with `word` from the closed set
`denied | expired | unavailable`, which the sign-in page announces, plus the
visitor's `destination` once the binding has been proved so a retry lands where
they were going. The distinctions a visitor can act on survive; everything about
*why* the transaction was rejected stays on the server, so the landing page
cannot be used to tell a bad state from a bad code.

The start route does the same thing for the same reason: the sign-in page
submits a real `<form method="post">`, so a form submission that fails lands on
`/login/?status=<word>` while a JSON caller still receives the C3 envelope.

**Where `/publish/authorize` goes today: nowhere.** It is the default
destination and AHU-007 owns the page behind it, so on this deployment a
completed sign-in currently 303s to a 404. The session is real and the cookie is
set; only the landing page is missing until that ticket lands.

## The AHU-007 seam

AHU-007 owns the pending-approval UI and its HTTP. It consumes this ticket's
identity, CSRF and transient-binding surface, and nothing else. The binding
helpers have this exact signature, and it is frozen here so AHU-007 can merge
against a real producer:

```js
import {
  BINDING_COOKIE,          // "__Host-archon_publish"
  createPendingBinding,
  readPendingBinding,
  clearPendingBinding,
} from "../lib/identity.mjs";

// operation: opaque, 32-256 base64url characters. Bound and returned unchanged.
await createPendingBinding(store, { operation });
//   -> Readonly<{ setCookie: string, expiresAt: string }>

await readPendingBinding(store, request);
//   -> Readonly<{ operation: string, expiresAt: string }> | null   (does NOT consume)

await clearPendingBinding(store, request);
//   -> Readonly<{ cleared: boolean, setCookie: string }>           (revokes, then clears)
```

**The operation is opaque here.** AHU-003 validates that it is a bounded
base64url token, binds it to this browser and hands it back unchanged; it never
parses it, never reads an owner out of it and never changes one. Reading does not
consume, because C1 requires the binding to survive an account switch — a visitor
who realises they are signed in as the wrong account must be able to switch and
still land on the same pending approval.

Immutable fixtures for all of this live in `test/fixtures/auth.mjs`.
`MemoryBlobStore` implements the exact two store methods `AuthStore` uses, with
the real conditional-write semantics *and* two faults the real client actually
produces — a conditional write that reports `{modified: true}` without applying,
and a read that carries no ETag. Both are the shapes a tidier fake omits, and
both are where the interesting bugs were. `githubProvider` is a narrow fake for
the two fixed endpoints, and `fixedClock` is a clock a test moves by hand.

### `lib/config.mjs`

| Export | Purpose |
| --- | --- |
| `readHostedConfig(env, options?)` | Validated operator configuration. |
| `formatHostedConfig(config)` | One-line, log-safe rendering. |
| `HostedConfigError` | Configuration fault, naming the key and never the value. |
| `HOSTED_CONFIG_KEYS`, `REDACTED`, `PRODUCTION`, `LOCAL_TEST` | The keys read, and the two modes. |

`readHostedConfig` takes the environment as an argument, which is what lets a
test inject a complete fixture and lets CI import the module with no credential
present.

### `lib/publication-store.mjs`

The only code that talks to the blob provider. One site-wide, strongly consistent
store named `archon-hosted-v1`, one key per publication at `publications/<id>`,
every write conditional, and no `delete` — Netlify offers no verified conditional
delete here, so v1 never removes a publication record.

| Export | Purpose |
| --- | --- |
| `createPublicationStore({getStore, name?})` | `{read, create, update}` over one store handle. `getStore` is injected, and the handle is opened lazily. |
| `publicationKey(id)` | `publications/<id>`, re-validating the id. A six-hex self-hosted document id fails it. |
| `PUBLICATION_STORE_NAME`, `PUBLICATION_KEY_PREFIX`, `MAX_WRITE_ATTEMPTS` | The store name, the namespace, and the bound of 6 attempts. |

Only `modified: true` with a non-empty ETag is taken at face value. Everything
else — a throw, a result that is not the documented shape, a `modified: true`
with no ETag, **and a resolved `modified: false`** — is read back with strong
consistency and compared to the exact record that was written. That last one is
the subtle case: `@netlify/blobs` retries the same conditional PUT on a network
error or a 5xx, so a write that commits and loses its response is re-sent, is
answered 412 by a server that already applied it, and arrives as
`modified: false`. The readback yields `committed`, `observed` (the stored record
is the intended one, but this call cannot prove it was the writer) or `refused`;
a readback that also fails surfaces as retryable `unavailable` with the
uncertainty intact.

### `lib/publications.mjs`

The one authority for publication state. Nine operations, one compare-and-set
loop, no second opinion about who owns a document. Full signatures, transition
table, typed failures and consumer examples are in
[`docs/publication-adapter.md`](docs/publication-adapter.md).

| Export | Purpose |
| --- | --- |
| `createPublications(dependencies)` | The frozen nine-method adapter, each method with its exact C3 signature. |
| `createPublication`, `readPublication`, `bindPublication`, `reviewPublication`, `decidePublication`, `statusPublication`, `cancelPublication`, `completePublication`, `readOwnedPublication` | The same operations, taking the dependency set as a second argument. |
| `publicationDependencies({env, getStore, mode?})` | Operator configuration plus a site-wide strong store. Opens nothing. |

Two rules a consumer has to know. **Expiry is logical**: a `pending` record past
its approval deadline and an `approved` record past its upload deadline are
`expired` to every caller with nothing written, so a deployment whose cleanup
never runs — which is this one — behaves identically to one whose cleanup runs
constantly. And **terminal is terminal**: a completed record's owner, descriptor
and bytes never change, a cancel that arrives after a completion returns the
completion, and only `readOwnedPublication` ever returns bytes.

### `lib/publications-http.mjs`

The transport shell the three agent endpoints share: method and browser-header
rejection, the bearer grammar, JSON body reading, and the C3 error envelope.
Every response it builds carries `Cache-Control: private, no-store`,
`Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, because
Netlify does not apply `netlify.toml` headers to function output.

## Routes

| Route | Method | Authentication |
| --- | --- | --- |
| `/api/hosted/publications` | `POST` | none — it mints the operation secret |
| `/api/hosted/publications/:publicationId/status` | `POST` | `Authorization: Bearer <agentSecret>` |
| `/api/hosted/publications/:publicationId/cancel` | `POST` | `Authorization: Bearer <agentSecret>` |

All three refuse a request carrying `Cookie` or `Origin`: they authenticate a
capability the CLI holds, and ambient browser credentials alongside a capability
is the confused-deputy shape the two-origin split exists to prevent. There is no
CORS grant anywhere in the hosted API.

## The browser approval routes

`/publish/authorize` is the trusted page a human answers. `docs/approval.md` is
the user-facing explanation of what it asks; these are the three routes behind
it, and their entry rules are the exact inverse of the agent routes above —
every one of them is meaningless without the browser credentials those refuse.

| Route | Method | Authentication |
| --- | --- | --- |
| `/api/hosted/publications/bind` | `POST` | exact `Origin` + the single-use pre-login `__Host-archon_login` binding |
| `/api/hosted/publications/:publicationId/review` | `GET` | the `__Host-archon_publish` binding + a live session |
| `/api/hosted/publications/:publicationId/decision` | `POST` | the binding + `requireBrowserMutation` (exact `Origin`, session, session-bound CSRF) |

**The link.** `verificationUriComplete` is
`<app origin>/publish/authorize#<publicationId>.<browserSecret>`. The fragment
carries both halves because the page has no other input: the path is fixed, C3
permits no query string, and there is no lookup by short code or by browser
secret. A fragment never reaches a server, and the page removes it with
`history.replaceState` before it makes any request, so the token is absent from
the address bar, from history and from every access log.

**The binding.** `bind` verifies the browser secret and stores the resulting
`{publicationId, browserSecretHash}` server-side under a fresh random
`__Host-archon_publish` cookie. Neither half is a capability — the id is public
and the digest is already on the record — so what the cookie proves is *how the
browser got them*. It survives an account switch and is revoked, server-side and
in the browser, only when the operation gets an answer.

**The decision.** `displayedAccountId` is the account the page told the human
they were acting as, and the decision is refused unless it equals the session's
account. It never selects an owner; it confirms that what was shown is what is
true, which is what a tab left open across an account switch gets wrong.

**Nothing before the click.** Nothing reaches the decision route until a button
is pressed, and `GET` cannot approve. `test/approval-browser.test.mjs` asserts
that against a real Chromium rather than against the handlers alone.

## Why `requireExactOrigin` has one Fetch Metadata exemption

A real `<form method="post">` submission is a navigation, and Fetch appends the
literal string `null` as the `Origin` of a non-CORS request whose document
carries `Referrer-Policy: no-referrer` — which C3 requires on every hosted
response. So every form POST in this deployment arrives as `Origin: null`, and
an exact-origin check with no exemption refuses the product's only sign-in path
in every browser rather than refusing an attacker.

`requireExactOrigin` therefore also accepts `Origin: null` when the request
carries `Sec-Fetch-Site: same-origin` **and** `Sec-Fetch-Mode: navigate`.
`Sec-Fetch-Site` is a forbidden header name, so page script cannot set it, and a
cross-site form POST arrives as `cross-site` — exactly the class the check
exists to refuse. Requiring the `navigate` mode too means a `fetch` or
`XMLHttpRequest` never gets the exemption; both send a real `Origin` anyway. A
browser too old to send Fetch Metadata sends neither header and is refused.

## Operator configuration

Every key below is set in the Netlify site environment. None is set in
`netlify.toml`: a secret there would be a secret in git, and values set there
are build-scoped rather than available to a function at runtime.

| Key | Required | Meaning |
| --- | --- | --- |
| `HOSTED_APP_ORIGIN` | yes | The trusted application origin. Exact, lowercase, no trailing slash, no trailing dot. |
| `HOSTED_RENDER_ORIGIN` | yes | The cookie-free static renderer origin. Must be a **different registrable site**. That deployment lives in `renderer/`. |
| `GITHUB_CLIENT_ID` | yes | OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | yes | OAuth app client secret. Never logged, never formatted, never committed. |
| `HOSTED_PUBLISH_ENABLED` | no | Exactly `true` or `false`. Anything else is a fault; unset means disabled. |

That is the whole list. Three properties are load-bearing:

- **Unset is the strict reading.** Missing publish-enabled means publishing is
  off. There is no configuration a deployment can fall into that is more
  permissive than what an operator explicitly asked for.
- **There is no environment variable that relaxes anything.** Loopback-only
  local testing is `readHostedConfig(env, { mode: "local-test" })` — an
  argument, not a key — so no value an operator can set on a site, deliberately
  or "temporarily on a preview", can turn off the HTTPS requirement or the
  two-site separation. That mode additionally requires *both* origins to be
  loopback, so it cannot describe a real deployment even by mistake.
- **"Different registrable site" is not "different hostname."** `app.example.com`
  and `render.example.com` are one site: they share cookies, and a renderer
  there is not the credential-free origin the design depends on. The comparison
  uses the public-suffix list through pinned `tldts` with private suffixes
  enabled, so `a.pages.dev` and `b.pages.dev` are correctly two sites. Comparing
  the last two hostname labels would get both of these wrong.

Reading the client secret is `config.github.readClientSecret()`. It is a call
rather than a property so that no inspector can print it: `JSON.stringify`,
`util.inspect` — including `{showHidden: true, getters: true, customInspect:
false}` — spread, `structuredClone` and template interpolation all render
`[redacted]`.

## Checks

```sh
npm --prefix hosted ci --ignore-scripts --no-audit --no-fund
node scripts/check-hosted-modules.mjs
node --test scripts/check-hosted-modules.test.mjs
node --test hosted/test/contracts.test.mjs
node --test \
  hosted/test/identity.test.mjs \
  hosted/test/auth-store.test.mjs \
  hosted/test/github-oauth.test.mjs \
  hosted/test/auth-routes.test.mjs
node --test --test-timeout=30000 \
  hosted/test/publication-store.test.mjs \
  hosted/test/publications.test.mjs \
  hosted/test/publications-agent.test.mjs
```

All of them run in `.github/workflows/check.yml`, and
`scripts/check-test-inventory.mjs` fails the build if a test file exists that no
run step names.

The auth suites run entirely against injected dependencies — an in-memory store
with the real conditional-write semantics, a hand-driven clock and a fake
provider — so **a missing secret cannot skip any of them**. Nothing here reads a
home directory, contacts GitHub or needs an operator credential.

The tests live in `test/` rather than beside their sources because `lib/` and
`functions/` are deploy directories: the module gate refuses a file there that
imports `node:test` or reaches into `test/`, and Netlify would publish
`functions/*.test.mjs` as a live route.

## Operator setup

### The OAuth app

Register a **dedicated** OAuth app for this deployment. Not a shared one, and not
one that has ever been granted a scope — the token exchange refuses any response
reporting a granted scope, so a reused client ID from an app with `repo` fails
closed rather than quietly exercising a permission the consent screen never
showed the visitor.

1. Create an OAuth app (not a GitHub App, and not a device-flow client).
2. Set the **Authorization callback URL** to exactly
   `https://<HOSTED_APP_ORIGIN host>/api/hosted/auth/github/callback`. GitHub now
   supports multiple redirect URIs, which makes an exact setting material rather
   than advisory: an extra entry is an extra place a code can be delivered.
3. Request **no scopes** and do not enable any email or organisation permission.
   The authorize URL emits no `scope` parameter at all.
4. Put the client ID and secret into the Netlify site environment as
   `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Never in `netlify.toml`, and
   never in git.

The callback is derived from `HOSTED_APP_ORIGIN`, never from a request `Host`
header and never from a marketing hostname, so a misconfigured origin is a
refused deploy rather than a callback pointing somewhere else.

### Operator maintenance

Session and transient records are **expired on lookup**, not by a cleanup job,
and this ticket schedules nothing. Expired and consumed records therefore remain
physically present in `archon-hosted-v1` until an operator removes them; they
authenticate nobody, because every read checks expiry against server time.

Retention is bounded by the lifetimes above: nothing under `auth/` is meaningful
after fifteen minutes and nothing under `sessions/` after seven days. Deleting
records older than those windows is safe at any time and is the whole of the
maintenance this ticket asks for. Do not assume the store offers a TTL or a
conditional delete — this design does not depend on either.

The anonymous write surface is two routes. `GET /api/hosted/session` writes one
small `auth/login/` record per request — the pre-login binding it issues, which
exists so the start route can prove the binding came from here — and `POST
/api/hosted/auth/github/start` writes one `auth/oauth/` transaction per accepted
request. Both are covered by the fifteen-minute retention window above, and
neither can grow `sessions/`. Rate limiting is a platform concern this ticket
does not implement; if an operator wants a cheaper anonymous `GET`, the lever is
a rate limit in front of the route, not a binding with no provenance.

### Live acceptance is still owed

Everything above is verified deterministically. **Live GitHub sign-in has not
been verified**, and cannot be until an operator supplies the OAuth registration
and two controlled accounts. That session must check the scopes GitHub actually
displays, the exact callback behaviour, and owner identity after an account
switch. Fixtures are not a deployed acceptance result.
