# Research: hosting, state and collaboration

Research for the next phase of the doc template: Netlify hosting, persisted state, comments, threaded
discussion, inline editing and change history.

**Nothing here is implemented.** These documents exist to be handed to implementing agents.

**Documents 01 to 06 were written when the builder was Python.** They were converted to Rust on
2 September 2026, after the builder became one dependency-free Rust crate, `templates/docbuild/`.

**Read `00-integration-plan.md` first.** The six area documents were written in parallel and they
disagree. The plan reconciles them, rules on 26 contradictions, and turns the result into 22 tickets.
An area document is background for the plan, not an instruction on its own.

**The plan's deployment topology is superseded and is no longer the ruling document on it.** It describes
the hosted application and the renderer as separate Netlify sites with their own base directories. There is
now **one** Netlify site answering on two hostnames, with the host-aware edge gate as the single header
authority. For anything an operator would act on — sites, hostnames, sign-in, environment variables — read
the "Hosting" section of the repository [`README.md`](../../README.md) and
[`hosted/OPERATIONS.md`](../../hosted/OPERATIONS.md) instead. The plan's data model, anchoring ruling and
ticket decomposition are unaffected.

| Document | Area |
|---|---|
| [00-integration-plan.md](00-integration-plan.md) | **The plan.** Six binding decisions, the shared data model, the anchoring ruling, and 43 tickets in 4 phases |
| [01-hosting-and-build.md](01-hosting-and-build.md) | Netlify deploy for a repo with no package.json, deploy previews, URL layout |
| [02-auth.md](02-auth.md) | Who the caller is, and how a Function trusts the claim |
| [03-state-storage.md](03-state-storage.md) | Netlify Blobs against Netlify DB, and the data model that fits |
| [04-comments-and-discussion.md](04-comments-and-discussion.md) | Threads, and the anchoring problem |
| [05-inline-editing.md](05-inline-editing.md) | Reader edits, and where the edit goes |
| [06-history.md](06-history.md) | Document history against annotation history |
| [07-realtime-and-presence.md](07-realtime-and-presence.md) | Near-real-time updates and presence. Why Netlify cannot do it alone |
| [08-suggestions-and-editing-model.md](08-suggestions-and-editing-model.md) | Suggestion against direct edit, and the one apply path |
| [09-sharing-and-roles.md](09-sharing-and-roles.md) | An owner, three grantable roles, invitations, and the share panel |

## The decisions everything else hangs on

- **Netlify Blobs**, one blob per record, not one blob per document. Two people commenting at once must not
  contend on a shared array.
- **A permanent opaque `id` in `doc.json`** is the storage key, never the directory name. A rename would
  otherwise orphan every thread on the document.
- **Anchoring is two layers**: a build-time `data-aid` carried across rebuilds by sequence alignment, plus a
  text-quote selector resolved in the browser. Four incompatible schemes were proposed; this is the ruling.
- **A reader edit becomes a pull request and a rebuild**, never a live patch to the page. Git stays the
  source of truth.

## The shape of the build

Phase one opens five tickets wide because one keystone ticket lands every template placeholder and hook
site up front. Four areas all wanted to edit `templates/docbuild/src/main.rs`, `app.js` and `components.css`; with the hooks in
place each writes its own new file instead, and the phases stay parallel.
