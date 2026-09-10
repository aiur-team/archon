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
5. Set the site environment variables below, scoped to Functions rather than Builds.
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
| `ARCHON_ALLOW_PUBLIC_MAIL_DOMAINS` | Off unless set to exactly `true`. Lets a document list a public mailbox provider — `gmail.com` and eleven others — on its domain list. Listing one admits everyone on earth who can sign up for an address, so it is refused by default and the override is site-wide. Any value other than `true` or `false` refuses the whole deployment rather than being read as "on". |
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

An owner shares a document by inviting an email address at a role. That writes an invitation and sends
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
`@aiur-team/archon` tarball carries at `dist/skills/archon-doc/SKILL.md`. Both share one rule,
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
