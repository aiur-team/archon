# Hosted publishing: operator runbook

This is the runbook for the **hosted** publishing service: the `hosted/`
application and the `renderer/` static origin. It covers the settings an operator
enters, how to stop new publishing safely, how to inspect what is retained, and
what has to be true before a live pilot can start.

Nothing in this document has been performed. No provider account exists, no
OAuth application is registered, no domain is bought, no secret is installed and
nothing is deployed. Every value shown is a placeholder. The last section lists
what an operator must supply and approve before the live acceptance ticket can
run.

The root deployment (`netlify.toml`, `netlify/`, `scripts/connect.mjs`, Netlify
Identity, `DOC_OWNERS`) is the **self-hosted** product and is untouched by any of
this. It is a different site with a different security model; do not merge the
two configurations or copy environment values between them.

---

## 1. Topology: three deployments

| | Base directory | Build command | Publish | Functions | Origin |
|---|---|---|---|---|---|
| Legacy self-hosted site | *(repo root)* | `templates/build --site` | `_site` | `netlify/functions` | operator's existing site |
| **Hosted application** | `hosted` | *(none)* | `public` | `functions` | `HOSTED_APP_ORIGIN` |
| **Renderer** | `renderer` | `node scripts/build.mjs` | `dist` | *(none)* | `HOSTED_RENDER_ORIGIN` |

Create the hosted application and the renderer as **two separate Netlify sites**,
each with its own base directory set in the site's build settings. The base
directory is what selects `hosted/netlify.toml` or `renderer/netlify.toml`; a
site left at the repository root reads the *legacy* configuration and would
deploy the legacy edge gate.

The application deploys with **no build command**. `public/` is served as
committed and the functions bundle from `hosted/package-lock.json`, so a deploy
never compiles the docbuild TypeScript. The renderer runs one Node script with no
dependencies, which generates its own security headers — including the
`frame-ancestors` rule that names the application origin — into the published
tree. Neither `netlify.toml` declares those headers, because only the build knows
the configured origin.

### The two origins must be two registrable sites

`app.example.com` and `render.example.com` are **not** acceptable: sibling
subdomains share cookies and count as one site for `SameSite` purposes, and a
cookie-free renderer is the property the whole design rests on. Use two different
registrable sites — for example `app.example.com` and `render.example.net`.

This is enforced in code. `hosted/lib/config.mjs` resolves both origins through
the public-suffix list (pinned `tldts`, private suffixes enabled) and refuses to
start the application when they resolve to the same site. Platform subdomains are
handled correctly by that rule: `a.pages.dev` and `b.pages.dev` are two sites,
not one, which a "compare the last two labels" check would get exactly backwards.

Production also requires `https://` on both origins, with no path, no trailing
slash, no credentials in the URL and no wildcard. There is no wildcard callback
and no cross-origin CORS grant anywhere in this service.

### Staging is a separate project, not a branch

Netlify Blobs stores are **site-wide**: every deploy context of one site —
production, branch deploys, deploy previews — reads and writes the same
`archon-hosted-v1` store. A staging *branch* on the production site would
therefore share production's publication records and could complete or cancel
them.

Create staging as a **separate Netlify site** (a separate project) with its own
origins, its own OAuth application and its own credentials. In addition:

- Do not give a **deploy-preview** context production secrets. A preview that
  carries `GITHUB_CLIENT_SECRET` is an alternate login origin for the production
  OAuth application, reachable from any pull request.
- Scope every secret to the production context of the site it belongs to.

---

## 2. Environment variables

`hosted/.env.example` is the redacted template. The five keys below are read by
`hosted/lib/config.mjs` and by nothing else. Set them in the Netlify **site
environment** (Site configuration → Environment variables), never in
`netlify.toml` and never in the repository: a value in `netlify.toml` is
build-scoped rather than available to a function at runtime, and a value in git
is a value in git.

| Key | Site | Secret | Notes |
|---|---|---|---|
| `HOSTED_APP_ORIGIN` | application, renderer | no | Exact origin, `https://` in production. |
| `HOSTED_RENDER_ORIGIN` | application, renderer | no | Different registrable site from the app. |
| `GITHUB_CLIENT_ID` | application | no | Public; appears in the authorization URL. |
| `GITHUB_CLIENT_SECRET` | application | **yes** | Production context only. Never on the renderer. |
| `HOSTED_PUBLISH_ENABLED` | application | no | Exactly `true` or `false`. Unset means disabled. |

The renderer reads only the two origins and holds no secret at all.
`HOSTED_PUBLISH_ENABLED` is spelled strictly: `1`, `yes` and `TRUE` are
configuration *errors*, not falsy defaults, so a typo fails loudly instead of
silently disabling publishing.

**Changing an environment variable does not change a running function.**
Netlify captures the environment when a deploy is built; already-deployed
functions keep the values they were deployed with until a new deploy replaces
them. Every change in this document therefore ends with "trigger a deploy and
verify", and no step in it promises instant effect. If you need an immediate
stop, see §4.

---

## 3. GitHub OAuth registration

Register a **dedicated** OAuth application. Do not reuse an existing one, and do
not use a GitHub App: this service wants identity and nothing else.

- **Scopes: none.** Request the empty scope. Do not request `user:email`, `repo`,
  `read:org` or any installation permission. The service fetches `/user`,
  reads the numeric account id, and then discards the GitHub access and refresh
  tokens; it never stores a GitHub token and never acts on a user's behalf.
  Unexpected granted scopes are rejected at callback.
- **Authorization callback URL: exactly one, exact.**
  `https://<HOSTED_APP_ORIGIN host>/api/hosted/auth/github/callback` — for the
  placeholder origin, `https://app.example.com/api/hosted/auth/github/callback`.
  No wildcard, no second entry, no `http://`, no trailing path variation.
- **Homepage URL:** the application origin.
- Register a **separate** OAuth application for staging, with staging's callback.
  Sharing one application between staging and production makes staging a valid
  login origin for production accounts.
- The numeric GitHub user id is the ownership key. A user who renames their
  GitHub account keeps their documents; a user who deletes their account and
  another who later claims the freed username do **not** inherit them.

Install `GITHUB_CLIENT_SECRET` through the Netlify UI or `netlify env:set` (the
Netlify CLI is an operator prerequisite installed separately — neither lockfile
in this repository provides it), into
the production context of the application site only. Rotating it is a normal
operation: set the new value, deploy, then delete the old credential at GitHub.

---

## 4. Stopping new publishing

### What `HOSTED_PUBLISH_ENABLED=false` does

Set it to `false` (or unset it) and redeploy the application. Then, as the code
stands today:

- **New publications are refused.** `POST /api/hosted/publications` answers
  `503` with `{"error":{"code":"publishing_disabled", ...}}`. This is checked
  inside `createPublication`, not in the route handler, so no future route can
  start a publication by forgetting to ask.
- **New uploads are refused too**, including for a publication that was already
  approved. The check is inside `completePublication`, the library function any
  upload has to go through to commit bytes, so a route cannot commit them by
  forgetting to ask. `PUT /api/hosted/publications/<id>/artifact` is that route,
  and it answers the same `503`. It also checks the flag itself before reading
  the body, which only makes the refusal cheaper — the answer with that pre-check
  removed is still `503`, from `completePublication`. Together these two are the
  whole tap — with the flag off, no new bytes reach the store.
- **Status and receipt recovery keep working.** `POST
  /api/hosted/publications/<id>/status` deliberately does not consult the flag.
  An agent that already published can still recover its receipt for the
  twenty-four hours the receipt deadline allows.
- **Owners keep reading their documents.** Turning publishing off never affects
  an owner reading a document they already published. Completed records keep
  their bytes and their owner, unchanged.
- **Nothing is deleted.** The flag stops new work; it removes nothing.

### What it does *not* do

**It does not revoke an approval.** A publication that had already started can
still be approved by its browser, and it can still be cancelled or left to
expire. What it cannot do is commit bytes. So an in-flight operation is stopped
rather than erased: if you re-enable publishing while that publication is still
inside its windows — currently **15 minutes** pending plus **10 minutes** to
upload — its agent can retry the upload and it will succeed.

**It does not affect a document that already completed.** An identical retry of a
completed upload is receipt recovery, not a new publication, and it keeps
answering with the receipt it earned.

**It is not instant.** It takes effect only for functions deployed *after* the
change (§2). Until that deploy publishes, the running functions still carry the
old value. The verification step below, not the environment variable, is what
tells you the change has landed.

### Procedure

1. Set `HOSTED_PUBLISH_ENABLED=false` on the application site's production
   context.
2. Trigger a production deploy. Wait for it to publish.
3. Verify — this is the step that proves it, not the variable:

   ```
   curl -i -X POST https://app.example.com/api/hosted/publications \
     -H 'content-type: application/json' \
     -d '{"v":1,"title":"probe","contentSha256":"<64 hex zeros>","contentBytes":11,"artifactFormat":"html"}'
   ```

   Expect `HTTP/2 503` and `"code":"publishing_disabled"`. A `201` means the
   deploy did not pick up the change; repeat step 2.
4. That `503` is the whole proof. It is the one route you can probe from
   outside, and because the upload path is gated on the same flag *inside
   `completePublication`* — the function the artifact route goes through to
   commit bytes —
   there is no window to wait out: once the deploy carrying the change is live,
   no new bytes can be committed, whatever was approved beforehand. Probing the
   upload path separately needs an approved publication, which needs a human
   approval you cannot get while starts are refused — so the start probe is the
   one to run. The gate's coverage of the upload is proven instead by
   `scripts/test-hosted-operations.mjs`, which calls `completePublication`
   directly, and by the route's own suite.

### Immediate stop

The flag stops publishing, not the service. If you need the *service* down —
because you are responding to an incident rather than pausing a pilot — unpublish
the production deploy, or lock the site, in the Netlify UI. That refuses
everything, including owner reads, which is the trade being made.

### Rollback

To resume publishing: set `HOSTED_PUBLISH_ENABLED=true`, deploy, and verify with
the same `curl` — a well-formed descriptor should now answer `201`. Cancel the
probe publication afterwards with its returned `agentSecret`:

```
curl -i -X POST https://app.example.com/api/hosted/publications/<id>/cancel \
  -H 'authorization: Bearer <agentSecret>'
```

### Outage is not the same as disabled publishing

They are different situations with different responses, and the status code
distinguishes them:

| Symptom | Meaning | Response |
|---|---|---|
| `503 publishing_disabled` on start, `200` on status | Publishing is off, service is healthy | Intended. §4 to resume. |
| `503 unavailable` on any route | Storage or configuration fault | Check the deploy log for `invalid_configuration` naming a key; check Blobs availability. |
| `500`, or no response | Function or platform fault | Netlify status, function logs. |
| `429` with `Retry-After` | Rate limit (§5) | Expected under load; the client honours `Retry-After`. |

An `invalid_configuration` error names the offending environment variable and
never its value. A configuration error refuses to start the service; it never
erases an existing document.

---

## 5. Rate limits

Two per-IP rules are declared in the handlers' own `config` exports, which is
where Netlify reads them:

| Route | Limit | Window | Aggregated by |
|---|---|---|---|
| `POST /api/hosted/publications` | 10 | 60s | client IP + domain |
| `POST /api/hosted/publications/<id>/status` | 30 | 60s | client IP + domain |

Understand what these are:

- **Delayed, best-effort mitigation.** The platform's counters can lag by around
  ten seconds, so a burst can exceed the nominal limit. They bound a sustained
  flood, not a spike.
- **Not an authorization boundary.** Every route validates its own bearer,
  descriptor and state regardless of whether a rule fired. Nothing downstream
  treats a rate limit as a check.
- **Not a hard quota.** There is no per-account and no global cap in v1. Volume
  caps are deferred, and public unrestricted signup stays gated until the cost
  exposure is accepted (§8).
- **Shared-IP impact is real.** Users behind one corporate or carrier NAT share
  a counter. The `429` carries `Retry-After` and the client honours it; there is
  no bypass, and adding one is not a supported operation.
- The five-second client poll interval is pacing, not a security boundary.
- **The document read routes carry no rule. That is a gap, not a proof.**
  `/docs/<id>`, `/api/hosted/docs/<id>` and `/api/hosted/docs/<id>/content`
  disclose nothing without a valid session — a signed-out or non-owner request
  gets an answer that is identical whether or not the document exists — so the
  missing rule is not a disclosure risk. It **is** a cost and availability one,
  and the reason is worth stating plainly rather than waving at: reaching those
  routes does not require a session, and `identifyHosted` performs a
  strongly-consistent Blobs read for *any* `__Host-archon_session` cookie value
  a caller invents before deciding it is worthless. So an unauthenticated loop
  over `/docs/<32 hex>` with a junk cookie buys one function invocation and one
  consistent store read per request, with no `429` anywhere. Each real viewer
  load additionally makes `/api/hosted/session` **write** a transient record.
  Watch invocation and Blobs-read volume during the pilot (§8); if it moves,
  the fix is a rule on these routes, and it is not blocked on anything.

An invalid rule is **dropped by the platform without failing the deploy**, which
is the failure mode to watch for: the route would be silently unprotected. Check
the deploy log's function configuration output for both rules after the first
deploy, and again after any change to a handler's `config` export.

---

## 6. Read-only census

Before reasoning about retention, count what exists. `scripts/hosted-census.mjs`
is read-only by construction: the provider handle it opens exposes only `list`
and `getWithMetadata`, and there is no flag that deletes anything.

```
NETLIFY_SITE_ID=<application site id> NETLIFY_AUTH_TOKEN=<operator token> \
  node scripts/hosted-census.mjs --store archon-hosted-v1 --prefix publications/
```

Both arguments are required and have no defaults, so the store you inspect is
always one you named. Both environment variables are required too: the tool
reads them and passes them to `getStore` as `siteID`/`token`, because
`@netlify/blobs` picks up no ambient configuration outside a Netlify runtime.
Omitting either fails immediately, naming the one that is missing. Use a
personal access token scoped to the account that owns the application site.

Run it from the repository root with `hosted/node_modules` installed
(`npm --prefix hosted ci`); it resolves `@netlify/blobs` from there.

It prints a JSON summary: `total`, `byState`, `byAgeBucket`, `retainedBytes` and
a `rows` array of `{id, state, artifactBytes, ageSeconds, ageBucket}`.
`retainedBytes` counts completed records only, because those are the only
records that hold artifact bytes.

It prints **no content and no capability material**: no HTML, no title, no
`contentSha256`, neither secret hash, no user code, and no owner account id.
Publication ids are printed, and are what the retention procedure below targets.

Run it against staging first. Run it before and after any maintenance.

---

## 7. Retention: paused-maintenance removal (procedure, not a tool)

**v1 ships no automatic deletion.** No sweep runs, no cleanup worker exists, and
no endpoint deletes a publication. Expiry is enforced on every *use* — an expired
pending record cannot be approved and an expired upload window cannot commit —
so a record that is never physically removed is still harmless. Physical removal
is an operator decision, performed by hand, and this section is the procedure for
it. It is documentation on purpose: an automatic sweeper that raced a completing
upload could delete a document that had just been committed.

Only **expired non-complete** records are candidates: `pending`, `approved`,
`denied`, `cancelled` and `expired` records past their deadlines. A `complete`
record is a published document and is never a candidate, whatever its age — in
particular, a completed record whose 24-hour agent receipt window has passed is
*not* expired auth state, and deleting it would destroy a document its owner can
still read.

1. **Census first.** Run §6 and keep the output. It is the before-picture.
2. **Choose exact targets.** Derive an explicit list of publication ids from the
   census rows, filtered to non-complete states past their deadlines. Never a
   prefix, never a wildcard, never "everything older than X".
3. **Stop the writers.** Set `HOSTED_PUBLISH_ENABLED=false`, deploy, and verify
   per §4. Once that `503` is confirmed, no upload can land on a record you are
   about to remove. Approvals and cancellations can still change state, so for a
   fully frozen store take the deployment down for the maintenance window.
4. **Re-census, and re-derive.** State can still change between steps. Confirm every id
   on your list is still non-complete and still expired. Discard any that is now
   `complete`.
5. **Back up.** Export each target record before removing it. There is no undo.
6. **Get explicit authorization.** Physical deletion is a separate decision from
   inspection and needs a named human to authorize it against the exact id list.
   Nothing in this repository performs it for you.
7. **Delete, by exact key.** `netlify blobs:delete archon-hosted-v1
   publications/<id>`, one id at a time, from the authorized list. This needs the
   Netlify CLI, installed and linked by the operator; it is not a dependency of
   either lockfile here, and nothing in this repository performs the deletion.
8. **Re-census and resume.** Confirm the counts moved as expected and no complete
   record was touched, then re-enable publishing per §4's rollback.

Retention is unresolved operational work until a named owner accepts it. Until
then the honest position is: records accumulate, expiry is enforced on use, and
nothing is deleted.

---

## 8. Before a live pilot

The live acceptance ticket cannot run until an operator supplies and approves all
of the following. None of it is authorized by this repository.

**Materials**

- Two HTTPS origins on two different registrable sites, and the two Netlify
  sites configured with `hosted` and `renderer` as their base directories.
- A separate staging project with its own origins and its own OAuth application.
- A dedicated GitHub OAuth application per environment, empty scope, one exact
  callback URL each (§3).
- `GITHUB_CLIENT_SECRET` installed in the production context of each application
  site.
- Two GitHub test accounts, to prove owner and non-owner read isolation.

**Approvals**

- An accepted traffic and cost envelope for the pilot. There is no hard quota;
  the per-IP rules in §5 are the only volume mitigation, and Blobs storage and
  function invocations are billed.
- A named owner accepting retention responsibility (§7).
- Acceptance that public unrestricted signup stays gated until abuse and cost
  exposure is understood.
- Acknowledgement that a plan change or provider signup may be required, and is
  a separate decision.

**What the live capstone must record**, since no fixture can stand in for it:
deploy-log acceptance of *both* rate rules, the publish flag actually taking
effect on deployed functions, the deployed response headers and routing, the real
GitHub callback and granted scopes, conditional-write race behaviour against real
Blobs, owner/other-account read isolation, lost-response receipt recovery, and
staging/production isolation.

The acceptance side of this list is
[`docs/builds/agent-hosted-upload/live-acceptance.md`](../docs/builds/agent-hosted-upload/live-acceptance.md):
the procedure for each of those recordings, and the preflight gate
`node scripts/test-hosted-live.mjs`, which refuses — item by item, as `BLOCKED`
rather than as a skipped pass — until everything above is supplied. Dated results
live beside it under `evidence/`.
