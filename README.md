# Archon

**Always-on Architecture Docs.**

An Archon document builds into **one self-contained HTML file** — inlined CSS and JS, theme-aware, no
bundler, no external requests. It opens from `file://`, survives being emailed, and can be published
anywhere that serves static files.

Deployed, that same static page gains a live layer: sign-in, comments anchored to text that moves as the
document is edited, inline suggestions and direct edits, per-document roles, document history, and
near-real-time presence.

## Run one

1. `cp -r templates/skeleton my-doc`, then edit `my-doc/doc.json` — give it a fresh six-hex `id`, a
   unique `slug`, and a `title` — and write `my-doc/sections/*.html`.
2. `templates/build my-doc` → `my-doc/dist/my-doc.html`. Node 18 or later, nothing else.
3. Commit and push to the repository that holds your documents.
4. Create a Netlify site from that repository. `netlify.toml` already sets the build command to
   `templates/build --site` and publishes `_site`.
5. Set the site environment variables below. They are site-wide: Netlify's free plan cannot scope a
   variable to Functions only, so mark the secret ones **secret** instead.
6. Deploy. The build walks the repository for every directory containing a `doc.json` and writes `_site`
   from scratch, so each such directory becomes a route: `/<slug>/`, its `aliases`, and `/d/<id>` as a
   permanent link that survives a slug change.

Read `example/` first — `templates/build example && open example/dist/example.html`. It is a finished
document about an invented subject and the reference for the *shape*. `templates/components/` is the
exhaustive component reference, built by this template so it cannot drift from the CSS.

## Configuration

| Variable | Purpose |
|---|---|
| `HOSTED_APP_ORIGIN` | The origin this site is served on, exactly — scheme, host and any port, with no path or trailing slash. Sign-in and every write depend on it: it is the origin a request's `Origin` header is compared against, and an unset or mismatched value refuses writes rather than admitting them. |
| `HOSTED_RENDER_ORIGIN` | The separate origin artifact HTML is rendered on. It must be a different registrable site from `HOSTED_APP_ORIGIN`, not a sibling subdomain, because siblings share cookies. |
| `AUTH0_DOMAIN` | The Auth0 tenant host, bare: no scheme, port, path or trailing slash. |
| `AUTH0_CLIENT_ID` | The Auth0 application's client ID. |
| `AUTH0_CLIENT_SECRET` | The Auth0 application's client secret. Never logged and never sent to a caller. |
| `DOC_OWNERS` | Comma-separated document-owner seeds in `<document>:<email>` form. |
| `HOSTED_PUBLISH_ENABLED` | The publishing tap. Spelled exactly `true` or `false`; anything else is a configuration error, and unset means disabled. A deployment that ships with it unset refuses to start a publication or commit uploaded bytes. |
| `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` | Optional. Whether a document owner may list a public mailbox provider — `gmail.com`, `outlook.com` and the rest of the frozen list — as a domain that may read their document. Spelled exactly `true` or `false`; unset means refused. Enforced when an owner writes a list, not when a reader is admitted by one. Applies to hosted documents and collaboration documents alike. |
| `ARCHON_ADMINS` | Optional. Comma-separated email addresses that hold the site-level admin capability: the `/admin` console, the document census and the platform allowlist. Seeded here and nowhere else — there is no path that grants it to anybody else. An admin is admitted only on a *verified* address matching an entry exactly, and a malformed entry is a configuration error rather than a silently empty list. |
| `ARCHON_PLATFORM_ALLOWLIST` | Optional. Comma-separated seed for the platform allowlist: individual email addresses, whole domains, or both. An entry admits its holder to sign in and use the deployment; it shares no document, because which documents someone may open is still decided per document. This is the initial list only — the mutable one lives in the store and an admin edits it from `/admin` with no redeploy. An entry seeded here cannot be removed from that page. |
| `ARCHON_PLATFORM_ALLOWLIST_ENFORCED` | Optional. Whether the platform allowlist actually gates sign-in. Spelled exactly `true` or `false`; unset means not enforced, and the list is recorded but inert. With it on, signing in requires an admin address, an allowlisted address, or an address at an allowlisted domain; an allowlist the store cannot be read for refuses with a retryable outage rather than admitting or denying. It is a separate switch rather than "a non-empty list is a gate" so that adding the first entry, or removing the last one, never changes the admission rule silently. |
| `ARCHON_EMAIL_PROVIDER` | Optional. The transactional email provider for invite requests. The only accepted value is `resend`; the endpoint is a constant in `netlify/lib/hosted/mailer.mjs` and is deliberately not configurable. Set all four `ARCHON_EMAIL_*` keys or none — a partial configuration is an error, and none at all means the invite form reports itself unavailable. |
| `ARCHON_EMAIL_API_KEY` | Optional. The provider API key. A real secret: never logged, never rendered, and reachable only through `readApiKey()`. |
| `ARCHON_EMAIL_SENDER` | Optional. The address invite-request mail is sent from. Must be an address the provider will accept for your domain. |
| `ARCHON_EMAIL_RECIPIENT` | Optional. The administrator address invite requests are delivered to. It is the only recipient: a requester's address is content of the message and never a `to`, so the form cannot be used as an open relay. |
| `ABLY_API_KEY` | Optional Ably API key for realtime presence and events. |
| `SLACK_WEBHOOK_URL` | Optional Slack webhook for notifications. |
| `DOCS_REPO` | Source repository in `<owner>/<repository>` form for repository-backed edits. |
| `DOCS_BASE_BRANCH` | Source branch for repository-backed edits; defaults to `main`. |
| `DOCS_GITHUB_TOKEN` | Fine-grained GitHub token used for repository-backed edits. |
| `DOCS_BOT_EMAIL` | Committer email used for repository-backed edits. |

### Signing in

There is one sign-in page and one session. A visitor signs in at `/login/`, which hands them to Auth0 to
continue with Google or GitHub, and the session that comes back is the same one the hosted document viewer
uses. Archon never sees a password, and there is no email-and-password form to configure.

The five variables above are what sign-in needs. Without them the sign-in route answers `503` and gated
documents stay unreachable, which is the intended behaviour for a site vendored by `scripts/connect.mjs`
that has no Auth0 tenant of its own — not a failure to repair. A site that does want sign-in configures its
own Auth0 application against these same names.

Two variables that used to widen access are gone. `ORG_EMAIL_DOMAIN` decided membership for every document
on a deployment from one setting, and it matched by address suffix — which calls `member@example.com.evil.com`
a member of `example.com`. `PUBLIC_DEFAULT_ROLE` handed a read-only role to any other signed-in caller, and
sign-in is open to anyone with a Google or GitHub account, so that was the whole internet. Per-document
domain lists replace both, matched by exact full-domain equality against a verified address. Setting either
variable on a deployment now does nothing at all.

### Sharing a document

An owner shares a document two ways, both from the **Access** panel behind the Share button. The
**Email domains** section lists the domains that may read the document: add one and anybody signing in with
a verified address at it can read, remove it and they cannot. It admits readers only, and it stores no
record of who used it, so there is no person to remove afterwards — the domain is the grant. A public
mailbox provider is refused with the reason, because listing one would admit anyone.

The second way is per person. An owner shares a document by inviting an email address at a role. That writes an invitation and sends
nothing: there is no account to provision and no password to set. The invited person signs in with that
address and the invitation is matched and consumed at that moment — so tell them the document URL. The
match requires an address the identity provider has **verified**; an unverified one matches nothing, and an
identity carrying no address at all (a GitHub account with no public email) can sign in but can never
satisfy an invitation.

An owner can also list email domains on a document. A signed-in reader whose **verified** address is at a
listed domain reads it, as a `viewer` and never more: a domain names a class of people, so it may not confer
a capability that changes the document or its membership. Matching is exact, case-insensitive, full-domain
equality — `mail.example.com` is not `example.com`, and neither is `example.com.evil.net` — and the decision
is recomputed on every request, so removing a domain takes effect immediately rather than at the end of a
session. A document listing no domains admits its owner and the people the owner named, and nobody else.

### Publishing a document to everyone

A document read without signing in is not a share, it is a publication, and it takes two edits rather than
one. Set `"public": true` in its `doc.json`, and add its exact route to `APP_PUBLIC_DOCUMENT_PATHS` in
`netlify/lib/edge-host.mjs`. Omitting either is a build failure naming the route and the file, because the
two lists are held equal: the gate runs on the edge, where no `doc.json` exists, so its copy of the public
set is checked against the documents rather than trusted.

The route is matched by **exact full path**, never as a prefix. `/example/` is public; `/example-thing/` is
a different document and stays gated. That is deliberate and is the reason the list is written out in full:
a prefix would publish every future slug that happens to begin with a published one.

`public` is absent from every document the skeleton produces, and absent means gated. The three reference
documents this repository ships — `/example/`, `/components/` and `/how-archon-works/` — are the only ones
that set it.

## The two modes

**Repository-backed.** All four `DOCS_*` variables are set. An edit commits back through the fine-grained
token and arrives as a reviewable change on the source branch.

**Standalone.** None of them are set. An editor changes the live document with no review; export is the
only path back to a reviewable artifact.

Mode is chosen by configuration and never by a request. **Partial configuration is a fatal invalid
state** — `DOCS_REPO` present with any of the other three missing or malformed fails, and so does any
`DOCS_*` variable set without `DOCS_REPO`. A configured repository never falls back into standalone, and
standalone never borrows a repository value.

## Writing a document

Read `.claude/skills/architecture-doc/SKILL.md` when you are writing a document *in this
repository*. `skills/archon-doc/SKILL.md` is the portable one: it teaches the same writing rules
plus the packaged workflow — `npm install`, the skeleton, `docbuild --hosted`, and publishing
through `archon-publish` with a human approving in a browser — and it is the file the
`aiur-archon` tarball carries at `dist/skills/archon-doc/SKILL.md`. Both share one rule,
and it is the one that matters:

> **A document is an argument, not a summary.** If a reader can only take one sentence away, decide now
> what that sentence is. Everything else earns its place by supporting it or by honestly limiting it.

## What is here

| Path | What it is |
|---|---|
| `templates/base/` | The theme, the components, the page skeleton, the runtime JS |
| `templates/docbuild/` | The builder. TypeScript, zero runtime dependencies |
| `templates/skeleton/` | Copy this to start a document |
| `templates/components/` | Every component, rendered live with its markup |
| `example/` | A complete worked document. Read this one first |
| `how-archon-works/` | The document about Archon that the site serves at `/how-archon-works/` |
| `site/` | The hand-written homepage. Published at the root of the built site |
| `netlify/` | The live layer: sign-in, access, comments, suggestions, edits, history, presence |
| `renderer/` | The isolated static origin that displays one uploaded document's active HTML |
| `docs/research/` | The platform design. `00-integration-plan.md` is the ruling document |
| `.claude/skills/architecture-doc/` | How to turn raw research into a document, in this repository |
| `skills/archon-doc/` | The same, for someone who installed the package. Shipped in the tarball |
| `AGENTS.md`, `llms.txt` | What an agent reads first. Served at `/AGENTS.md` and `/llms.txt` |

## Checks

```bash
templates/check-dist                        # rebuild every document; fail if committed dist/ changed
scripts/scrub-check.sh                      # fail if private context reached this repository
npm --prefix templates/docbuild run check   # typecheck
node scripts/check-function-modules.mjs     # fail if a netlify/ module does not load
node scripts/check-test-inventory.mjs       # fail if a test file is not wired into CI
node scripts/test-publish-package.mjs       # fail if the packed tarball does not work for a clean consumer
node scripts/vendor-netlify-lib.mjs         # fail if the deploy tree is not self-contained
```

`.github/workflows/check.yml` is the full list; these are the ones worth running by hand.

A deploy carries only `netlify/`, `netlify.toml` and the root lockfile, so **no relative import anywhere
under `netlify/` may resolve outside `netlify/`.** `netlify/lib/anchor-core.mjs` and
`netlify/lib/inline-md.mjs` are generated copies: after changing
`templates/docbuild/src/anchor-core.ts` or `templates/docbuild/src/inline_md.ts`, run
`npm --prefix templates/docbuild run build && node scripts/vendor-netlify-lib.mjs --write` and commit the
result with the source.

## Hosting

One repository, **one Netlify site**, two hostnames, one Auth0 application. There is no second site to
create: the renderer is the same site answering on its own `*.netlify.app` name, and the host-aware edge
gate in `netlify/edge-functions/gate.ts` is the only authority on which host a request arrived on and which
headers it gets. Every value below is a placeholder under a reserved documentation domain;
[`netlify/.env.example`](netlify/.env.example) is the copyable template and
[`hosted/OPERATIONS.md`](hosted/OPERATIONS.md) is the full runbook.

1. **Reuse the existing Netlify site** rather than creating one. Point it at this repository and let it read
   the repository build settings: build command `templates/build --site`, publish directory `_site`, base
   directory empty.
2. **Confirm the site's `<name>.netlify.app` hostname answers `200` with no redirect.** Netlify does not
   redirect it to the primary custom domain, and that non-redirect is the renderer hostname's whole basis.
   If it redirects — because someone added a rule — stop: the renderer hostname is not available and the
   topology needs an operator decision. Never add such a redirect afterwards.
3. **Bind your custom domain as the site's primary domain**, leaving the `*.netlify.app` name serving. The
   two are different registrable sites, which is what satisfies the cookie-separation rule the configuration
   reader enforces.
4. **Create the Auth0 application as a Regular Web App.**
5. **Enable the Google and GitHub connections on it, using your own provider applications.** Auth0's
   developer keys are not for production. Give the GitHub application the **`user:email`** scope: without it
   a GitHub sign-in can carry no email at all, and a document gated by email domain then refuses everyone
   who signed in with GitHub, with no error an operator can see.
6. **Disable every other connection on the application**, including the default
   `Username-Password-Authentication` database. Archon never sees a password and has no form to type one in.
7. **Register the callback and logout URLs**, both exact and both on the application hostname — no wildcard,
   no second entry: Allowed Callback URL `https://app.example.com/api/hosted/auth/callback`, Allowed Logout
   URL `https://app.example.com/` (the trailing slash is part of it; `/v2/logout` refuses a `returnTo` that
   is not an exact match).
8. **Set the environment variables** in the site environment, marking the secret ones secret:

   | Key | Secret | Value |
   |---|---|---|
   | `HOSTED_APP_ORIGIN` | no | `https://app.example.com` — the primary custom domain |
   | `HOSTED_RENDER_ORIGIN` | no | `https://render.example.net` — in a real setup, the site's own `*.netlify.app` name |
   | `AUTH0_DOMAIN` | no | The tenant host, bare |
   | `AUTH0_CLIENT_ID` | no | The application's client id |
   | `AUTH0_CLIENT_SECRET` | **yes** | The application's client secret |
   | `ABLY_API_KEY` | **yes** | Optional; presence and realtime events |
   | `HOSTED_PUBLISH_ENABLED` | no | Exactly `true` or `false`; unset means disabled |
   | `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` | no | Optional; exactly `true` or `false`; unset means refused |
   | `ARCHON_ADMINS` | no | Optional; comma-separated admin addresses for `/admin` |
   | `ARCHON_PLATFORM_ALLOWLIST` | no | Optional; comma-separated seed addresses and domains |
   | `ARCHON_PLATFORM_ALLOWLIST_ENFORCED` | no | Optional; exactly `true` or `false`; unset means not enforced |
   | `ARCHON_EMAIL_PROVIDER` | no | Optional; exactly `resend`. Set all four `ARCHON_EMAIL_*` keys or none |
   | `ARCHON_EMAIL_API_KEY` | **yes** | Optional; the provider API key |
   | `ARCHON_EMAIL_SENDER` | no | Optional; the address invite requests are sent from |
   | `ARCHON_EMAIL_RECIPIENT` | no | Optional; the admin address invite requests go to |

   The free plan has no per-scope environment variables, so every value here is site-wide and the client
   secret is readable by the build step. The mitigation is that no build-time code reads it: only the
   deployed functions call `config.auth0.readClientSecret()`.
9. **Deploy.** Changing a variable does not change an already-deployed function — Netlify captures the
   environment when a deploy is built — so every change to this list ends with a deploy.
10. **Run the live acceptance:**
    [`docs/builds/agent-hosted-upload/live-acceptance.md`](docs/builds/agent-hosted-upload/live-acceptance.md).
