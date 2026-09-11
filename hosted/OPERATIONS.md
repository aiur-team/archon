# Hosted publishing: operator runbook

This is the runbook for the Archon deployment: **one Netlify site**, answering on
two hostnames. It covers the settings an operator enters, how to stop new
publishing safely, how to inspect what is retained, and what has to be true
before a live pilot can start.

Nothing in this document has been performed. No provider account exists, no
Auth0 tenant is registered, no domain is bought, no secret is installed and
nothing is deployed. Every value shown is a placeholder. §8 lists what an
operator must supply and approve before the live acceptance ticket can run.

`README.md`'s "Hosting" section is the same setup in ten numbered steps, for a
first run through. This document is the reference behind it.

---

## 1. Topology: one site, two hostnames

There is one `netlify.toml` in this repository, one build command and one publish
directory. The collaboration documents, the hosted publishing application, the
renderer shell and the served agent files are all produced by that one build.

| | Value |
|---|---|
| Base directory | *(repository root)* |
| Build command | `templates/build --site` |
| Publish directory | `_site` |
| Functions | `netlify/functions` |
| Edge function | `gate`, on `/*`, with no excluded path |

The site answers on **two hostnames**:

| Hostname | Configured as | What it serves |
|---|---|---|
| The primary custom domain | `HOSTED_APP_ORIGIN` | The application: sign-in, the session, `/docs/<id>`, every `/api/` route |
| The site's own `<name>.netlify.app` name | `HOSTED_RENDER_ORIGIN` | The renderer shell under `/_render/`, cookie-free |

**Do not create a second Netlify site.** The renderer used to be one; it is not
one now, and a second site would be a second header authority the gate cannot
see, a second build the inventory contract does not describe, and a second origin
to keep in step by hand.

### The gate is the header authority

Only the edge function can tell which of the two hostnames a request arrived on,
so it is the only place a security header may be decided. `netlify.toml` declares
no `X-Frame-Options`, no `Content-Security-Policy` and no `Referrer-Policy`, and
the renderer build writes no `_headers` file beside the shell it publishes.
Netlify emits every matching rule, and a browser handed two
`Content-Security-Policy` headers enforces their intersection — so two
authorities could only make a page more dead, never more permissive, in a way
that looks like the stricter one working.

The gate classifies by host, and a host it does not recognise gets neither
application nor renderer treatment. The `frame-ancestors` rule that names the
application origin is emitted there, from `HOSTED_APP_ORIGIN`, and never from a
request `Host` header.

### The two origins must still be two registrable sites

`app.example.com` and `render.example.com` are **not** acceptable: sibling
subdomains share cookies and count as one site for `SameSite` purposes, and a
cookie-free renderer is the property the whole design rests on. That rule is
unchanged, and one site satisfies it because a `*.netlify.app` name is a
different registrable site from a custom domain — `netlify.app` is on the public
suffix list, so two `*.netlify.app` names are two sites, which a "compare the
last two labels" check would get exactly backwards.

This is enforced in code. `netlify/lib/hosted/config.mjs` resolves both origins
through the public-suffix list (pinned `tldts`, private suffixes enabled) and
refuses to start the application when they resolve to the same site.

Production also requires `https://` on both origins, with no path, no trailing
slash, no credentials in the URL and no wildcard. There is no wildcard callback
and no cross-origin CORS grant anywhere in this service.

### The `*.netlify.app` hostname must keep answering directly

Netlify does **not** redirect `<name>.netlify.app` to the primary custom domain.
That non-redirect is the renderer hostname's whole basis. Before configuring
anything else, confirm the name answers `200` on its own; if it redirects, the
renderer hostname is not available and the topology needs an operator decision.
Adding such a redirect later breaks the renderer.

### Staging is a separate project, not a branch

Netlify Blobs stores are **site-wide**: every deploy context of one site —
production, branch deploys, deploy previews — reads and writes the same
`archon-hosted-v1` store. A staging *branch* on the production site would
therefore share production's publication records and could complete or cancel
them.

Staging, if you run one, is a **separate Netlify project**: its own copy of this
same one-site topology, with its own two hostnames, its own Auth0 application and
its own credentials. It is not a second site *within* the production topology,
which stays exactly one. In addition:

- Do not give a **deploy-preview** context production secrets. A preview that
  carries `AUTH0_CLIENT_SECRET` is an alternate login origin for the production
  Auth0 application, reachable from any pull request.
- Scope every secret to the production context of the project it belongs to.

---

## 2. Environment variables

`netlify/.env.example`, beside the reader that consumes it, is the redacted
template. The keys below are read by `netlify/lib/hosted/config.mjs` and by
nothing else; the collaboration layer's own keys — `ABLY_API_KEY`, `DOC_OWNERS`,
`SLACK_WEBHOOK_URL` and the four `DOCS_*` names — are in
the "Configuration" table of the repository `README.md`.

Set them in the Netlify **site environment** (Site configuration → Environment
variables), never in `netlify.toml` and never in the repository: a value in
`netlify.toml` is build-scoped rather than available to a function at runtime,
and a value in git is a value in git.

| Key | Secret | Notes |
|---|---|---|
| `HOSTED_APP_ORIGIN` | no | Exact origin, `https://` in production. The primary custom domain. |
| `HOSTED_RENDER_ORIGIN` | no | Exact origin. The site's `*.netlify.app` name; a different registrable site from the app. |
| `AUTH0_DOMAIN` | no | The tenant host, bare: no scheme, port, path or trailing slash. |
| `AUTH0_CLIENT_ID` | no | Public; it appears in the authorization URL. |
| `AUTH0_CLIENT_SECRET` | **yes** | Production context only. Mark it secret in the Netlify UI. |
| `HOSTED_PUBLISH_ENABLED` | no | Exactly `true` or `false`. Unset means disabled. |
| `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` | no | Exactly `true` or `false`. Unset means refused. See §9. |
| `ARCHON_ADMINS` | no | Comma-separated admin addresses. Unset means no administrators. See §10. |
| `ARCHON_PLATFORM_ALLOWLIST` | no | Comma-separated seed addresses and domains. A seed only; the live list is in the store. See §10. |
| `ARCHON_PLATFORM_ALLOWLIST_ENFORCED` | no | Exactly `true` or `false`. Unset means the list is recorded but not enforced. See §10. |
| `ARCHON_EMAIL_PROVIDER` | no | Exactly `resend`, or unset. Set all four `ARCHON_EMAIL_*` keys or none. See §11. |
| `ARCHON_EMAIL_API_KEY` | **yes** | The provider API key. Mark it secret in the Netlify UI. |
| `ARCHON_EMAIL_SENDER` | no | The address invite-request mail is sent from. |
| `ARCHON_EMAIL_RECIPIENT` | no | The admin address invite requests are delivered to. The only recipient. |

One site means one set of values, read the same way on both hostnames. There is
no per-hostname environment and nothing to keep in step.

`HOSTED_PUBLISH_ENABLED`, `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` and
`ARCHON_PLATFORM_ALLOWLIST_ENFORCED` are all spelled strictly: `1`, `yes` and
`TRUE` are configuration *errors*, not falsy defaults, so a typo fails loudly
instead of silently changing what the deployment does.

The four `ARCHON_EMAIL_*` keys are the one group **not** read by
`config.mjs`. `netlify/lib/hosted/mailer.mjs` reads them, because a deployment
that has not configured email must serve every other hosted request normally
rather than refuse to start; the cost is that a mistake in them is found by the
invite-request route rather than by every route. Set all four or none — a
partial set is an error.

**Every value here is site-wide.** Netlify's free plan has no per-scope
environment variables, so `AUTH0_CLIENT_SECRET` is readable by the build step as
well as by functions. Marking it secret stops it being read back out of the UI,
the API and the deploy log; the reason that is enough is that **no build-time
code reads it** — `templates/build --site` never imports
`netlify/lib/hosted/config.mjs`, and the secret is reachable only through
`config.auth0.readClientSecret()` in a deployed function.

**Changing an environment variable does not change a running function.**
Netlify captures the environment when a deploy is built; already-deployed
functions keep the values they were deployed with until a new deploy replaces
them. Every change in this document therefore ends with "trigger a deploy and
verify", and no step in it promises instant effect. If you need an immediate
stop, see §4.

---

## 3. Auth0 application registration

Sign-in is brokered by Auth0. Archon never sees a password, never stores a
provider token and never acts on a user's behalf; it reads an identity and stops.

Register **one Regular Web App** per environment. Do not reuse an application
between staging and production: sharing one makes staging a valid login origin
for production accounts.

- **Connections: Google and GitHub, using your own provider applications.**
  Auth0's developer keys are explicitly not for production, so they are not an
  option to configure. Create a Google OAuth client and a GitHub OAuth
  application of your own and give Auth0 their credentials.
- **The GitHub application needs the `user:email` scope.** Without it the
  identity Auth0 returns can carry no `email` claim at all — GitHub does not
  publish a private address otherwise. A document gated by verified email domain
  then refuses everyone who signed in with GitHub, silently, with no error an
  operator can see and nothing in a log that names the cause.
- **Disable every other connection**, including the default
  `Username-Password-Authentication` database. A connection left enabled is a
  sign-in path nobody designed for, and there is no password form in this
  product.
- **Allowed Callback URLs: exactly one, exact.**
  `<HOSTED_APP_ORIGIN>/api/hosted/auth/callback` — for the placeholder origin,
  `https://app.example.com/api/hosted/auth/callback`. No wildcard, no second
  entry, no `http://`, no trailing path variation. The value is derived in code
  from the configured origin, never from a request `Host` header, so a marketing
  hostname cannot become a callback.
- **Allowed Logout URLs: exactly one, exact.** `<HOSTED_APP_ORIGIN>/` — for the
  placeholder origin, `https://app.example.com/`. The trailing slash is part of
  it: `/v2/logout` compares `returnTo` against the allow-list exactly, and a
  value that differs by one character is a logout that ends on an Auth0 error
  page. The `returnTo` this application sends is built from configuration and
  never from the request.
- **Requested scopes: `openid profile email`, and no more.** In particular no
  `offline_access`: the application keeps its own server-side session, so a
  refresh token would be a stored credential with no caller and every risk.
- **Application Login URI**, if you set one (it is optional): the application
  origin's `/login/`, which is the one sign-in page.

The ownership key is the Auth0 subject (`sub`), not an email address. A user who
changes their address keeps their documents; an address is what an *invitation*
and a *domain rule* are matched against, and only when the provider has marked it
verified.

Install `AUTH0_CLIENT_SECRET` through the Netlify UI or `netlify env:set` (the
Netlify CLI is an operator prerequisite installed separately — neither lockfile
in this repository provides it), into the production context of the site only,
marked secret. Rotating it is a normal operation: set the new value, deploy, then
rotate the credential at Auth0.

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

Run it from the repository root with the root `node_modules` installed
(`npm ci`); it resolves `@netlify/blobs` from there.

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

- One Netlify site with two hostnames on two different registrable sites: a
  primary custom domain and the site's own `*.netlify.app` name, confirmed to
  answer `200` without redirecting (§1).
- A separate staging project with its own hostnames and its own Auth0
  application.
- A dedicated Auth0 Regular Web App per environment, with the Google and GitHub
  connections enabled against your own provider applications, `user:email` on
  the GitHub application, every other connection disabled, and one exact
  callback URL and one exact logout URL each (§3).
- `AUTH0_CLIENT_SECRET` installed and marked secret in the production context of
  each project.
- Two test accounts, to prove owner and non-owner read isolation.

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
effect on deployed functions, the deployed response headers and routing on
*each* of the two hostnames, the real Auth0 callback and the email claim each
connection actually returns, conditional-write race behaviour against real
Blobs, owner/other-account read isolation, lost-response receipt recovery, and
staging/production isolation.

The acceptance side of this list is
[`docs/builds/agent-hosted-upload/live-acceptance.md`](../docs/builds/agent-hosted-upload/live-acceptance.md):
the procedure for each of those recordings, and the preflight gate
`node scripts/test-hosted-live.mjs`, which refuses — item by item, as `BLOCKED`
rather than as a skipped pass — until everything above is supplied. Dated results
live beside it under `evidence/`.

---

## 9. Domain access on a document

A published document is readable by its owner. Its owner may additionally list
email domains on it, and any signed-in reader holding a **verified** address at
a listed domain then reads it. Nobody else does, and nobody else learns the
document exists.

The list lives on the document, and the owner sets it:

```
GET  /api/hosted/publications/<id>/access
PUT  /api/hosted/publications/<id>/access   {"v":1,"allowedDomains":["example.com"]}
```

Both require the owner's session; the `PUT` also requires the app's exact
`Origin` and the session's `x-archon-csrf` token, so it is reachable only from
the application's own pages. The `PUT` **replaces** the whole list. `[]` clears
it and returns the document to owner-only.

There are four things an operator should know about the rule itself, because
each of them is a support question:

- **Matching is exact.** `example.com` admits `ann@example.com` and does *not*
  admit `ann@mail.example.com`, `ann@notexample.com` or `ann@example.com.evil`.
  There are no wildcards and no subdomain expansion; list each domain you mean.
- **Verification is the provider's, not ours.** A reader whose address the
  identity provider has not verified is shown "Verify your email" rather than
  the document, however corporate the address looks. The fix is on their side.
  Note what that page admits: the address it matched against is unverified, so
  the domain is claimed rather than held. Somebody who already has a document
  link can sign up with an address at a guessed domain and learn from the 403
  that the document lists it. That is the accepted price of an actionable
  message — it needs the unguessable link first, and it never speaks about a
  document whose list the caller did not name — but it is why the list should
  be treated as visible to anyone holding the link, not as a secret.
- **Nothing is stored when a domain admits somebody.** The decision is recomputed
  from the reader's current verified address on every request, and a session
  lasts at most 24 hours — so removing a domain, or a reader losing the address,
  costs access within a day without any cleanup step here.
- **The owner is never locked out.** Owner access is decided from the stored
  account id before any email logic, so a provider that stops asserting a
  verified address does not take an owner's own document away from them.

### Public mailbox providers

`gmail.com`, `googlemail.com`, `outlook.com`, `hotmail.com`, `live.com`,
`yahoo.com`, `icloud.com`, `proton.me`, `pm.me`, `aol.com`, `mail.ru` and
`qq.com` are refused when an owner tries to list them. Listing one would admit
every person who can sign up for an address at it, which is publishing the
document while believing it is private. The owner sees
`public_mailbox_domain` naming the domain they typed.

**That list is exact, and it is not every free provider.** `hotmail.co.uk`,
`me.com`, `gmx.de`, `yandex.com` and others are accepted today. Read the guard
as "the most common accident is caught", never as "a domain it accepted is
therefore a private one" — the owner is still responsible for knowing who can
get an address at a domain they list.

`ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS=true` lifts that refusal for the whole site.
Set it only on a deployment where those really are the corporate mailboxes.
There is no per-document override and no per-owner exception.

Turning it back off does **not** break a document whose list was set while it was
on: the rule is enforced when a list is written, not when a reader is admitted by
one. An existing list keeps working and simply cannot be written again until the
entry is removed. That asymmetry is deliberate — enforcing the denylist on read
would turn a policy change into an outage on documents that are perfectly
intact.

The list is bounded at **20 domains**, each at most 253 characters, and is stored
normalized: lower-cased, de-duplicated and sorted. An entry that is not a domain
— a wildcard, a URL, an address, a name with a trailing dot, or anything
non-ASCII — is refused as `invalid_domain` naming the entry.

### Rolling this deploy back

Deploying domain access is a **one-way door for the records it touches**, and
that is worth knowing before you deploy rather than during a rollback.

The stored record gains an `allowedDomains` field and its version goes from `1`
to `2`. The new code reads both versions, so rolling *forward* is safe and no
existing document needs migrating. The previous deploy's validator does not: it
rejects any record carrying a field it does not know, whatever the version says.
So every publication created or transitioned after this deploy — not just those
with a domain list — becomes unreadable to the code that ran before it, and
`publication-store.mjs` reports that as a retryable `unavailable`, which a
client will retry against a condition that cannot resolve.

This is a property of adding the field at all rather than of the version number;
`ownerEmail` has the same shape. Practically: treat a rollback past this deploy
as needing a data decision, not just a revert, and prefer rolling forward with a
fix. Nothing here is urgent today — no document has been published on a live
deployment yet.


---

## 10. The admin console and the platform allowlist

### Who is an admin

`ARCHON_ADMINS` is a comma-separated list of email addresses and is the **only**
source of the capability. There is no promote-others page, no grant record and
no revocation path, which is deliberate: a grantable admin needs all three plus
an answer to "the last admin revoked themselves", and a seeded identity's
recovery story is an environment variable you already control.

An admin is admitted on a **verified** address matching an entry exactly. An
unverified address is a string the visitor typed into a sign-up form, so it is
never an admin claim however truthy the provider's assertion looks.

A malformed entry is a configuration error and the deployment refuses to serve,
rather than coming up with an empty admin list. An admin list is discovered to be
wrong only when somebody needs it, and the person who needs it is locked out at
that moment.

### What `/admin` shows, and what it cannot

The console lists **every** document this deployment stores: title, id, owner
account and address, created date, state and access rules. It does not open
document content and there is no endpoint behind it that could —
`/api/hosted/docs/<id>/content` remains the only path to a document's bytes and
authorises through `readOwnedPublication`, which has no admin branch.

A record this version of the software cannot interpret is listed as unreadable
with its id, rather than omitted. A census that dropped it would show you a
shorter list than the truth with no way to notice.

A signed-in non-admin gets **403**, not the 404 the rest of this tree uses to
hide whether a document exists: `/admin` is one fixed path that exists on every
deployment of this software, so hiding it would cost a comprehensible answer and
hide nothing.

### The platform allowlist

An entry is an individual email address **or** a whole domain, and it admits its
holder to sign in and be a user of this deployment. It shares no document:
which documents somebody can open is still decided per document, so an
allowlisted address with no document shared to it signs in and sees nothing. That
is the correct outcome, not a fault.

It is **not** a document's `allowedDomains` and is not held to the public-mailbox
refusal in §9. Listing `gmail.com` on a *document* admits everyone on earth to
that document; listing one named gmail address here admits one mailbox to the
platform. Leave `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS=false`.

`ARCHON_PLATFORM_ALLOWLIST` seeds the list; the live list is a record in the same
site-wide blob store as the publications, at `access/platform-allowlist`, and an
admin edits it from `/admin` **without a redeploy**. Each stored entry carries
the admin who added it and when. That audit is not a log: removing an entry
deletes its provenance with it, so the record answers "who admitted this address"
and never "who removed one".

A seeded entry cannot be removed from the page, and the page says so rather than
accepting a removal the next request would undo. To remove one, change
`ARCHON_PLATFORM_ALLOWLIST` and deploy.

### Turning the gate on

`ARCHON_PLATFORM_ALLOWLIST_ENFORCED=true` is what makes the list actually gate
sign-in. Until then it is recorded and inert.

Order matters when you first turn it on:

1. Seed or add every address and domain that should keep working, **and** set
   `ARCHON_ADMINS`.
2. Read the list back on `/admin` and confirm it is what you meant.
3. Set the flag and deploy.

The flag exists rather than "a non-empty list is a gate" because the latter
changes the deployment's admission rule silently in both directions: the deploy
that seeds one address would lock out every identity that could sign in the day
before, and an admin removing the last entry would reopen the platform without
being told that is what the button did.

Three properties are worth knowing before an incident:

- **An admin is admitted before the list is consulted**, and before the store has
  to have been readable. An operator who enforces an empty list, or whose
  allowlist store is unreachable, can still reach `/admin` and fix it.
- **An unreadable list refuses everybody else as an outage**, not as "you are not
  allowed". The visitor lands on `/login/?status=unavailable`, which they retry,
  rather than on a message they act on by giving up.
- **The gate runs once, at sign-in.** A session lasts at most 24 hours, so
  removing an entry costs access within a day rather than immediately. If you
  need somebody out *now*, that is a session revocation, not an allowlist edit.

### Turning it back off

Unset the flag — or set it to `false` — and deploy. Nothing about the stored
list changes, and no session is affected.

---

## 11. Invite requests

The splash page carries a "request an invite" form. A submission emails
`ARCHON_EMAIL_RECIPIENT` the requester's address and their optional note. With
none of the four `ARCHON_EMAIL_*` keys set, the route answers "not enabled" and
nothing else in the deployment is affected.

**No account is registered by any code in this repository.** Sign up with the
provider yourself, set the four values in the Netlify site environment, mark the
API key secret, and deploy.

### What bounds it

- **Not an open relay.** `ARCHON_EMAIL_RECIPIENT` is the only recipient and
  nothing on the wire can change it. The requester's address is *content* of the
  message — never a `to`, a `from` or a `reply-to` — so the form cannot be used
  to send mail from your domain to an address a stranger typed.
- **No membership disclosure.** The route reads neither the allowlist nor the
  session store nor the publication store, so there is no query whose result or
  timing could differ between an address that is already a user and one that is
  not. Every accepted submission gets one fixed body.
- **Rate limited, failing closed.** Three submissions per source per hour and
  sixty in total per hour, counted in one record at `access/invite-rate` that
  resets itself when the hour rolls over. A counter that cannot be read refuses
  the submission: a rate limiter that fails open is one an attacker only has to
  break once. The per-source bucket is a digest of the platform's own
  `x-nf-client-connection-ip`, so the counter is not a log of who visited; a
  request without that header shares one strict bucket rather than escaping the
  limit.
- **A failed send does not refund the budget.** A genuine requester who hits a
  provider outage loses one of three attempts in an hour, which is cheaper than
  letting anybody who can make sends fail spend unlimited attempts at the
  provider.

### The endpoint is not configurable

`ARCHON_EMAIL_PROVIDER` is an exact value and the request URL is a constant in
`netlify/lib/hosted/mailer.mjs`. A configurable endpoint on a route an anonymous
visitor can reach would be a server-side request forgery primitive behind a name
that reads like a setting. Adding a second provider is a change to that file.

### Raising or lowering the limits

They are constants in `netlify/lib/hosted/invite-requests.mjs`
(`INVITE_LIMITS`), not environment variables, because a limit an operator can
raise in a hurry during an abuse incident is a limit that gets raised during an
abuse incident. Changing one is a deploy and a review.
