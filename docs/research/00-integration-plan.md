# Integration plan

**Status:** this document rules. Documents 01 to 06 are research. Where this document and a research
document disagree, this document is correct.

**Written:** 2026-09-01. It reconciles `01-hosting-and-build.md`, `02-auth.md`, `03-state-storage.md`,
`04-comments-and-discussion.md`, `05-inline-editing.md` and `06-history.md`.

**The builder is TypeScript.** It was Python, then Rust, then TypeScript, all on 2 September 2026. What
changed was not taste: the template became a dependency that TypeScript repositories consume, and the
platform half of this plan is already JavaScript. Rulings 39 and 40 record it. **Every module named in
this document is a `.ts` module**; documents 01 to 06 still say Rust and are wrong on that point.

**Revised 2026-09-02 after review, twice.** It now also reconciles `07-realtime-and-presence.md`,
`08-suggestions-and-editing-model.md` and `09-sharing-and-roles.md`, which were written in parallel on
2 September and disagree with each other in two places. Sections 1.5 and 1.6 hold the new binding
decisions, section 4.7 holds the renumbered tickets, and rulings 31 to 36 record the disagreements.
**Three earlier statements in this document are now false and are marked as such**, in section 1.2
(there is no `editor` role), section 2.4 (acceptance happens in a pull request) and section 5 (no
real-time updates).

The first revision made two changes, both recorded where they bind. The build tooling is
Rust, not Python, so every module and command named here is a Rust one; documents 01 to 06 still show
Python and are wrong on that point. And a second deployment mode was added — a standalone file with no
repository — which all six research documents assumed away. See section 1.4. It bends section 3.4.

The six documents were written in parallel. They agree on the large facts. They disagree on 26 concrete
points. Section 6 lists every disagreement and gives the ruling. Sections 1 to 4 are the plan that
follows from those rulings.

Language: ASD-STE100 Simplified Technical English. "Must" is a requirement. "Do not" is a prohibition.

---

## 1. The decisions that bind everything

Six decisions constrain every feature. Make them first. Do not revisit them inside a feature ticket.

### 1.1 The state store

**Decision: Netlify Blobs. One store, named `doc-state`. Strong consistency. One blob per record.
Never a shared mutable array in one blob.**

All six documents reject Netlify DB. They agree on the reasons: the free plan sleeps after 5 minutes of
inactivity, database storage price after 1 July 2026 is unknown, and an automatic migration at deploy can
block a publish and take every document offline. Keep that agreement.

The documents disagree on the blob layout. Document 03 wants one blob for each document. Document 04
wants one blob for each thread. Document 06 wants one blob for each event.

**Ruling: one blob for each record.** Document 04 and document 06 agree with each other against
document 03, and they give the same reason. A shared mutable array in one blob makes every write to that
document a compare-and-swap on one key. Document 06 states the failure correctly: two readers append,
one comment is lost. Document 03's compare-and-swap loop prevents the loss, but it makes every write on
a document contend with every other write on that document. A live review session is the moment that
matters, and it is the moment that produces the most simultaneous writes.

The price is read cost. To render a document, a function must do one `list()` and N parallel `get()`
calls. Document 04 measured this at about 200 ms for 50 threads, inside one function invocation. The
reader pays one browser round trip. Accept that price.

**The key layout:**

```
store "doc-state"                       consistency: "strong", site-wide

  threads/<docId>/<threadId>.json       one thread and its comments. Mutable. CAS on write.
  events/<docId>/<YYYY-MM>/<eventId>.json  one audit event. Append only. Never rewritten.
  edits/<docId>/<aid>.json              one pending inline edit. Self-cleaning receipt.
  suggest/<docId>/<aid>/<sugId>.json    one open suggestion. Immutable. onlyIfNew.
  access/<docId>/doc.json               ownerSub and the org default. Mutable. CAS on write.
  access/<docId>/u/<sub>.json           one person's grant on one document.
  access/<docId>/i/<emailHash>.json     one outstanding invitation. emailHash = sha256(email)[0:32].
```

`<docId>` is the permanent `id` from `doc.json`. It is never the directory name and never the slug.
See section 1.3.

**Reasons.**

- Blobs needs no provisioning. It is available on every plan. It has no idle sleep and no wake-up delay.
- The workload is small and it is scoped to one document. There is no query that `list({prefix})` cannot
  answer.
- A bad blob write damages one thread. A bad migration takes every document offline.

**What this rules out.** State these now, so nobody plans around them.

- No query across documents. "Every unresolved thread that mentions me" costs one `get` per document.
- No full-text search of comment bodies. Blobs has no index and cannot get one.
- No transaction across two blobs. A thread write and its event write are two acts. A crash between them
  loses the event, not the comment. That is the correct order.
- No count without a read. No sort except by key.
- No per-user index. Read receipts, subscriptions and an unread count do not fit this model.
- No ephemeral state. Blobs has no time-to-live, so anything with a lifetime shorter than the document
  belongs somewhere else. Presence is the case that matters. See §1.6.
- No cross-document access query. There is no "shared with me" list and no cross-document revoke.
  Offboarding is `admin.deleteUser`. Both features were cut deliberately to keep this ruling.

**The triggers to change the decision.** Any one of these is enough to move to Postgres:

1. A query is no longer scoped to one document.
2. Somebody asks to search comment text.
3. One document passes about 200 threads and the first paint feels slow.
4. Sustained writes exceed about one per second on one thread.
5. A change must span two documents atomically.
6. Per-user state that is not per-document is needed.

**Presence does not fire trigger 4, because presence must never be written to this store at all.** Trigger
4 is the *reason* for that prohibition, not a consequence of it. Ten readers at a five-second beat is two
writes a second on one key, and a shared roster array is exactly the "shared mutable array in one blob"
this section forbids. Moving to Postgres would not fix it either: a fact with a twenty-second lifetime does
not belong in a durable store of any kind. See §1.6.

**The concurrency rule.** There is one mutable blob shape: a thread. Write it only through `mutate()` in
`netlify/lib/store.mjs`. That helper reads the blob with its ETag, applies a function, and writes with
`onlyIfMatch`. If another writer commits first, the write is rejected, and the function runs again on the
newer value. Take the loop from document 03 section 5.2. It has six attempts and exponential back-off
with jitter. Do not take the three-attempt loop from document 04 section 7.3.

Write every append-only blob with `onlyIfNew: true`. An append-only key holds a timestamp and a random
suffix, so a collision means a bug, not contention.

**Consistency.** Set `consistency: "strong"` at the store. All six documents agree. Eventual consistency
gives a 60-second window in which a reader's own comment can appear, vanish and return. That reads as
data loss.

**Unverified:** it is not confirmed that `list()` honours a store-level `consistency: "strong"`. Do not
depend on it. After a POST, render the record from the POST response. Do not re-fetch the list. This is
faster anyway.

**Confirmed by review, 2 September 2026.** The granularity test is "whatever makes the most sense when a
file is open and edited by several people in rapid succession". One blob for each record is the answer to
exactly that test, and the reason is the one document 06 gives: a shared mutable array turns every
concurrent write into contention on one key, and a live review session is when concurrent writes happen.

That test does expose one gap the layout above does not cover. **Two people editing the same block still
contend on one key**, because a pending edit is keyed `edits/<docId>/<aid>.json`. This is correct and it
must stay correct: an inline edit replaces the whole text of one block, so two simultaneous edits to one
block are a genuine conflict and the second writer must be told. The block hash in section 3.4 detects
it and returns 409 with the current text. Rapid succession across *different* blocks does not contend at
all, which is the common case. Do not "fix" the same-block case by merging text.

### 1.2 The authentication model

**Decision: Netlify Identity, invite-only, read through `getUser()` from `@netlify/identity@2.0.0`.
Netlify Functions v2 only. One Edge Function gate on `/*`. Two roles.**

Document 02 wins outright on this area. It is the only document that checked the package, the February
2026 deprecation reversal, and the runtime contract. Documents 03, 05 and 06 read
`context.clientContext.user`. That is the version 1 Functions path. Document 02 states that
`@netlify/identity` server calls need version 2 Functions, and that a version 1 handler silently has no
session. A silent 401 in production is the worst possible failure for this platform.

**The one identity module.** Every function reads identity through one file. No function calls
`getUser()` directly. No function reads `clientContext`. No function reads a header or a body field for
an author.

```js
// netlify/lib/identity.mjs
// The single identity contract. Every /api/* function imports from here.

/**
 * @returns {Promise<null | {
 *   sub: string,        // Identity user id. Stable for a person across sessions.
 *   email: string,      // lower case
 *   name: string,
 *   roles: string[],    // ["member"] or ["guest"]
 *   canComment: boolean,
 *   canEdit: boolean,
 *   docs: string[]      // guest scope, as docIds. Empty for a member.
 * }>}
 */
export async function identify(req) { /* getUser(), then the rules below */ }

/** Throws a 403 Response on a cross-site POST. Call it first in every mutating handler. */
export function requireOrigin(req) { /* verifyRequestOrigin(req) */ }
```

The rules inside `identify()`:

- No session returns `null`.
- An email that ends with `@example.com` gets `roles: ["member"]`, `canComment: true`, `canEdit: true`.
- Any other confirmed user gets `roles: ["guest"]`, `canComment: false`, `canEdit: false`, and `docs`
  from `appMetadata.docs`.
- Read roles defensively. The write API sets `role` as a string. The documentation describes storage at
  `app_metadata.roles`. Use `user.roles ?? (user.role ? [user.role] : [])`.
- Read only these fields: `id`, `email`, `name`, `roles`, `appMetadata`, `userMetadata`. When the
  Identity API is unreachable, `getUser()` falls back to the verified JWT claims, and only those fields
  are populated. Do not test `confirmedAt` or `lastSignInAt`.

**Cross-site request forgery.** `nf_jwt` is a cookie, so every mutating endpoint is exposed. Call
`requireOrigin(req)` as the first statement of every POST, PATCH and DELETE handler. Only document 02
raised this. It is not optional.

**The gate.** One Edge Function protects the HTML. It matches `/*` and excludes three paths:

```toml
[[edge_functions]]
  path         = "/*"
  excludedPath = ["/login/*", "/api/*", "/_assets/*"]
  function     = "gate"
```

The default for any new path is "gated". `/api/*` is excluded because every function gates itself. That
is not a hole; it is the correct division. The edge gate decides who sees HTML. It never decides who may
write.

**Roles.** Two *identity* roles, `member` and `guest`, and four *document* roles held in the state
store: `owner`, `editor`, `commenter`, `viewer`.

**Ruling #10 was reopened on 2 September 2026 by the product requirement.** It said there is no `editor`
role, and the reason it gave was sound: the pull request is the review gate, and a second role is a second
list to maintain. That reason still holds and it is why `editor` is **not** the default. What it did not
anticipate is a share panel that invites a named person into a named role, which is now a requirement.

The reconciliation is smaller than it looks, because **§1.2's `canEdit` never meant "may change the
text"** — it meant "may propose an edit", which becomes a pull request. So today's org member maps exactly
onto the new `commenter`: read, comment, suggest. Nothing that works today changes behaviour. `editor` is
new above that ceiling, `viewer` is new below the floor, and `canEdit` splits into `canSuggest` and
`canEdit`. See `09-sharing-and-roles.md`, and §1.5 for where authority lives.

**The client contract.** One mechanism reveals interactive controls. `templates/base/session.js` calls
`/api/session`, and on success it sets `data-session` on the root element. The CSS in
`templates/base/session.css` reveals controls. Four different mechanisms were proposed. This is the only
one.

```js
document.documentElement.dataset.session = s.canSuggest ? "editor" : "reader";
document.dispatchEvent(new CustomEvent("session", { detail: s }));
```

Every other client module listens for the `session` event. No module polls. No module calls
`/api/session` again.

`data-session` is a rendering hint, not a security control. A reader can set it in the developer tools
and see an edit button. The button then calls a function, the function calls `identify()`, and the
function returns 403.

**What this rules out.**

- No GitHub OAuth. No Auth0. No second identity vendor.
- No multi-factor authentication and no single sign-on. If the organisation mandates either, this design
  is replaced, not extended.
- No self-registration. No password-reset user interface in version 1.
- No `netlify-identity-widget` and no `gotrue-js`. Document 05's client uses
  `window.netlifyIdentity`. Remove it.
- No Git Gateway. It is deprecated and the deprecation was not reversed.
- No Netlify project visibility as the access control. The gate does the work, so the project can be
  public.

**The plan.** Netlify **Personal, $9 per month**. Document 01 could not choose the plan because the
choice depended on this area. The gate does the access control, so Pro is not required. Personal gives
1,000 credits, which is about 66 production deploys per month. The free plan gives 20, and it is a hard
cap: at 300 credits every project shows a "Site not available" page until the next billing cycle.

### 1.3 The document key

This is a third decision, and it is small, but every storage key depends on it.

**Decision: the permanent `id` in `doc.json`.** Six random lowercase hexadecimal characters. Generated
once. Never edited. Never meaningful.

```json
{
  "id": "k7m2q4",
  "slug": "example",
  "aliases": []
}
```

Documents 03, 04, 05 and 06 all key on the directory name or the slug. A rename then orphans every
thread, every event and every pending edit. Document 01 is correct.

- `<docId>` is the storage key. It is the `id`.
- `<slug>` is the URL. It may change. `aliases` holds every slug the document has used.
- `<instance>` is the directory name. It is needed only to compute a git path for an inline edit. The
  server reads it from the build manifest. **A function must never accept a path or an instance name
  from the client.**

`/d/<id>` redirects to the current slug forever. Put that URL in the document footer.

### 1.4 The deployment modes

**Decision: two supported modes, one overlay mechanism, and propagate-back is the owner's choice in both.**

This decision arrived in review after documents 01 to 06 were written. **Every one of them assumed a
repository.** That assumption is now only half the product.

| | **Mode A — standalone file** | **Mode B — repo-backed** |
|---|---|---|
| What Netlify gets | One built HTML file, uploaded | A repository with many documents |
| What is built | Nothing. The file is the deploy | `docbuild --site`, scoped to one document |
| Source of truth for text | The file, plus the overlay | `sections/*.html` in git |
| Setup | A CLI tool signs the user in to Netlify, creates or links the site, and configures the deploy | Point Netlify at the repository, select one document, configure its build |
| Propagate back | Owner's choice. Rewrites the file, or opens a PR once a repository is attached | Owner's choice. Opens a PR against `sections/*.html` |
| Who it is for | One author with one document and no repository | A team with a document set under review |

**The setup tool is agent-assisted, and it is the only new component.** It signs the user in through the
Netlify CLI rather than asking for a token, because a token pasted into a prompt is a credential we then
have to hold. It is written in Rust or TypeScript; **Rust, to match the builder, unless it needs the
Netlify JavaScript SDK.** Decide that when the ticket is written, not now.

**Mode A contradicts section 3.4 as written, and section 3.4 is the one that bends.** Section 3.4 rules
that a reader edit must change the section fragment and then rebuild, never a live DOM patch. In Mode A
there is no fragment and no rebuild. So state the mechanism one level lower, where both modes share it:

> **An edit is an overlay keyed by `aid`, applied over the built HTML. Promotion of that overlay to a
> durable source is a separate, explicit act.**

Mode B promotes on every accepted edit, by opening a PR, which is what section 3.4 describes. Mode A
holds the overlay until the owner asks to promote it. Section 3.4's actual argument survives intact:
what it forbids is text drifting away from the anchors that comments hang on, and an overlay keyed by
`aid` cannot cause that drift, because it replaces the contents of a block and never the block's
identity. A DOM patch that rewrote block boundaries would still be forbidden.

**What this costs, said plainly.** In Mode A the overlay *is* the document, and nobody reviews it. That
is the price of having no repository, and it is why propagate-back is not optional to build — it is the
only path from Mode A back to a reviewable artifact. Build the export before the editing, not after.

**What this changes in section 4.** P1-E owns Netlify configuration and now covers Mode B only. Mode A
adds one new phase-4 ticket for the connect tool, and one for overlay export. Neither blocks anything in
phases 1 to 3, because both modes read the same overlay records defined in section 2.5. **The data model
does not change.** That is the test this decision had to pass, and it passes.

**Who may write a direct edit.** Mode A: a decider only, because acceptance is the only review gate Mode A
has. Mode B: any member, because the pull request is still the gate. **Who may accept a suggestion:** a
decider, in both. So the suggestion path is not optional in Mode A — see §1.5.

**Unverified:** whether a Netlify site created by CLI upload can later be converted to a repository-linked
site without losing its URL. If it cannot, Mode A to Mode B is a migration with a new URL, and the `/d/<id>`
redirect in section 1.3 is what makes that survivable.

### 1.5 Authority: who may edit, and who decides

**Decision: a document has one owner and three grantable roles, held in the state store and changed
through a share panel. Every change to authority writes an append-only event.**

**This ruling resolves a real contradiction between two research documents, and it is worth recording why
rather than blending them.** `08-suggestions-and-editing-model.md` and `09-sharing-and-roles.md` were
written in parallel and reached incompatible answers to the same question:

| | `08` — authority in a committed file | `09` — authority in the state store |
|---|---|---|
| Where a grant lives | `owner` and `editors` in `doc.json` | `access/<docId>/u/<sub>.json` |
| How it changes | A commit, a review and a rebuild | A write from the share panel |
| Strongest argument | A committed file is reviewed. Nobody grants themselves authority in secret | An invitation is immediate, and a revoke is immediate |
| Reopens ruling #10 | No, deliberately | Yes, and says so plainly |

**Ruling: `09`.** The deciding fact is the requirement itself — a panel that invites a named person into a
named role. A commit-per-invitation cannot serve that, and in Mode A it is not merely slow but impossible:
there is no repository to commit to after the file is uploaded. `08` avoided reopening ruling #10, which
was the right instinct and the wrong conclusion; the requirement reopens it whether the design does or not.

**Keep `08`'s argument, though, because it identifies the real risk.** Runtime grants mean authority can
change with no review. The mitigation is the audit trail, not the storage location: **every one of
`access.invite`, `access.change`, `access.revoke` and `access.transfer` writes an append-only event under
§2.4, and those events are excluded from retention.** A grant made in secret is then still a grant made on
the record.

Two consequences follow, and neither is optional:

- **`isDecider(session, manifest)` from `08` is superseded by `resolveRole(docId, user)`** in
  `netlify/lib/access.mjs`. One authority function, or the two drift.
- **`doc.json` gains no `owner` and no `editors` field.** The first owner comes from the `DOC_OWNERS` site
  environment variable, bound to a `sub` on first sign-in, because that works in both modes, sits outside
  the client's reach, and is not seizable first-come. Sharing is opt-in: no entry means today's §1.2
  behaviour and no panel.

**One apply path, whatever the entry point.** A suggestion waits for a decision; a direct edit applies on
write; acceptance runs the same code. Extract `netlify/lib/gitedit.mjs` so accept and edit cannot drift
into two conflict checks. The block hash of §3.4 stays the sole authority on conflict, and §3.4 gains one
missing definition — the **effective base** is the applied receipt when one exists, else the manifest hash.

**State is carried by which key exists, never by a status field.** `open` means the blob exists.
`superseded` is computed from the block hash at read time, exactly as §2.2 forbids storing anchor state.
`applied` means the `edits/` receipt exists. Rejected and withdrawn mean a deleted blob plus one event. So
a suggestion record is immutable and written with `onlyIfNew`, and §1.1's sentence "there is one mutable
blob shape: a thread" survives this feature.

**The proposal layer fans out; the applied layer does not.** Up to five open suggestions may exist on one
block, keyed by `sugId`. Only one *applied* edit may exist per block, which is the contention §1.1's review
note already ruled is a genuine conflict rather than a bug.

### 1.6 Realtime and presence

**Decision: one hosted broker. Not Netlify, because Netlify cannot do it.**

**Netlify Functions cannot hold a WebSocket** — 10-second synchronous, 15-minute background and 60-second
streaming limits. Netlify **Edge** Functions *can* hold a stream open indefinitely, and there is an
official SSE example, which looks like the answer and is not: **Netlify has no fan-in.** No shared memory
between isolates, no bus, no publish-subscribe, and Blobs has no change feed. An SSE endpoint on Netlify
could only poll Blobs from inside the stream, so **SSE without a broker is polling with extra steps.** A
third-party broker is therefore mandatory, not a preference.

**First choice: Ably Pub/Sub**, one channel per document, subscribed with the browser's built-in
`EventSource` against Ably's SSE endpoint, published with `fetch` to Ably's REST endpoint, and the token
minted by a Netlify Function. No SDK, no script tag, no bundler — which is the constraint that eliminated
Liveblocks, Supabase and the Ably SDK itself. Pusher is second choice over the raw protocol. **Cloudflare
Durable Objects is the better technical fit and is the named migration target**, rejected for v1 only
because it means running a Worker we do not otherwise need.

**Decided 2026-09-02: Ably, on the free tier.** This adds the repository's first external service
dependency and its first secret, `ABLY_API_KEY`. Say that plainly when the ticket is written.

**The free tier and what actually binds.** Six million messages each month, 200 concurrent connections,
200 concurrent channels, 200 presence members for each channel, 500 messages a second, and 64 KiB for each
message.

Message volume is not the constraint: a ten-reader review session for one hour is about 18,000 messages,
so the monthly allowance holds roughly **330 such hours**. **The 200 concurrent *connections* is the
ceiling, and it is account-wide rather than per document.** One reader is one connection, so the practical
limit is **200 people reading documents at the same moment** — about twenty busy documents at ten readers
each, or a single all-hands document with 200 readers. The 200-channel limit allows 200 documents to be
live at once and will therefore never bind first.

**What to do when it binds.** Two paths, and the choice is already framed in this section: pay Ably, or
migrate to Cloudflare Durable Objects, which is the named target. Presence is never persisted and events
carry only ids and hashes, so the migration is one client module and no data migration. **The free tier
carries no service level agreement.** Realtime is additive — every feature degrades to a refresh — so an
outage is a slower document, not a broken one. Do not let any write path depend on the broker.

**The cost argument, because it is not the latency argument.** Ten concurrent readers for one hour: a
five-second poll is about 7,200 function invocations, roughly 3.0 Netlify credits against a 300-credit
monthly free plan on which one deploy costs 15, plus 7,200 `list()` and 72,000 `get()` calls against
undocumented Blobs rate limits. The broker is about ten token mints, roughly 0.001 credits, and about
18,000 Ably messages against a six-million monthly free tier. **The broker is about a thousand times
cheaper in the currency deploys are paid in.** The poll survives only as the no-broker fallback for content
freshness; it cannot do presence at all.

**Presence is derived on the client from heartbeats** — a 20-second beat, a 50-second expiry, and a `bye`
on `pagehide`. It is never persisted, never written to Blobs, and never written to the event log.

**Scope, honestly.** "Near-real-time editing" is block-level notification plus an *advisory* claim lock. No
conflict-free replicated data type is reopened. Server events carry an id and a hash, **never text**.

**Opt-in, and absent by default.** With no `ABLY_API_KEY` the token endpoint returns **204, not an error**.
That single switch is the whole degradation story: `file://` stops at the protocol test, a Claude artifact
never gets a session because CSP blocks `/api/session`, and a Mode A site works untouched until its owner
chooses otherwise.

---

## 2. The shared data model

One set of record shapes. Six features, one schema.

Rules that apply to every record:

- `docId` is always the permanent `id`. Never the slug, never the directory name.
- Every timestamp is an ISO 8601 string in UTC, with milliseconds.
- Every actor field is set on the server from `identify()`. **A client-supplied author field is an
  impersonation bug.** Ignore any author, email or name in a request body.
- Every record carries `v: 1`. Read through one `upgrade()` function. A shape change is a new branch
  there, applied on read and persisted on the next write.
- The maximum comment body is **8000 characters**. The maximum edit text is **4000 characters**. The
  four documents proposed four different limits. These are the two.

### 2.1 Actor

Embedded in every record. Document 03 stores an email string. Document 04 stores an object and checks
ownership with `sub`. Document 06 stores `actor` as an email. Take document 04's object, because
ownership checks need a stable id that is not an email.

```json
{ "sub": "u_931", "name": "the owner W", "email": "owner@example.com" }
```

### 2.2 Anchor

The one anchor shape. Used by threads today, and by any future annotation. Field names come from the
W3C Web Annotation Data Model, so a later migration is a field rename.

```json
{
  "block": "a3f19c2b",
  "exact": "a cache miss never blocks the build",
  "prefix": "We guarantee that ",
  "suffix": ". This is the only hard",
  "start": 142
}
```

| Field | Meaning |
|---|---|
| `block` | The `data-aid` of the block. Layer 1. See section 3 |
| `exact` | The selected text, normalised. Layer 2 |
| `prefix` | Up to 32 characters before `exact`, normalised |
| `suffix` | Up to 32 characters after `exact`, normalised |
| `start` | The character offset of `exact` in the normalised block text. A tiebreak only. Never trusted alone |

**Anchor state is never stored.** The client computes `exact`, `drifted`, `moved` or `orphaned` at read
time. A stored state goes stale on the next rebuild.

### 2.3 Thread

Blob key: `threads/<docId>/<threadId>.json`. Mutable. Write only through `mutate()`.

```json
{
  "v": 1,
  "id": "t_m8x2k1_4f7a9c31",
  "docId": "k7m2q4",
  "kind": "comment",
  "status": "open",
  "section": "architecture",
  "anchor": { "...": "section 2.2, or null" },
  "title": null,
  "docVersion": "7aaca51",
  "createdAt": "2026-09-01T14:02:11.412Z",
  "author": { "...": "section 2.1" },
  "resolvedAt": null,
  "resolvedBy": null,
  "comments": [
    {
      "id": "c_m8x2k1_1",
      "body": "Is this still true after the September key change?",
      "author": { "...": "section 2.1" },
      "createdAt": "2026-09-01T14:02:11.412Z",
      "editedAt": null
    }
  ]
}
```

| Field | Note |
|---|---|
| `id` | `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0,8)}`. Sorts by creation time, so `list()` returns document order. Document 03's `seq` counter is rejected: it needs the per-document blob that section 1.1 rejects |
| `kind` | `"comment"` or `"discussion"`. A discussion has `anchor: null` and a `title`. One code path |
| `status` | `"open"` or `"resolved"`. There is no `"deleted"` |
| `docVersion` | The `head` short SHA from the baked history block, read from the page. This is document 06's best idea. It lets the panel say "made against an earlier version" |
| `section` | Redundant with `anchor.block`, but it survives the block's death. It puts an orphan in the right part of the panel |
| `comments` | One level of replies. No nesting |

There is **no `buildRev`** and no anchor state. Anchors must survive rebuilds, so a field that records
the build would invite code that invalidates on a mismatch.

### 2.4 Event

Blob key: `events/<docId>/<YYYY-MM>/<eventId>.json`. Append only. Never rewritten. Never read to render
the comment panel.

```json
{
  "v": 1,
  "id": "1756742651221-4f2a9c",
  "docId": "k7m2q4",
  "ts": "2026-09-01T18:04:11.221Z",
  "actor": { "...": "section 2.1" },
  "kind": "comment.create",
  "target": { "threadId": "t_m8x2k1_4f7a9c31", "aid": "a3f19c2b" },
  "docVersion": "7aaca51",
  "summary": "commented on Architecture"
}
```

`kind` is one of: `comment.create`, `comment.reply`, `comment.edit`, `thread.resolve`, `thread.reopen`,
`edit.propose`.

**The event log is an audit trail, not the source of truth.** Document 06 wants the comment panel to be
a fold over events. Reject that. A fold means the client must fetch every event ever written, so the
render cost grows without bound, and the 18-month retention job becomes load-bearing for correctness.
The thread blob is what the panel renders. The event log is what the changelog and the audit read.

**The `kind` list grows.** Add `suggest.create`, `suggest.accept`, `suggest.reject`, `suggest.withdraw`,
`suggest.supersede`, `edit.apply`, and the four access events `access.invite`, `access.change`,
`access.revoke`, `access.transfer`.

The sentence that stood here — that `edit.propose`, `edit.accept` and `edit.reject` "reduce to one kind"
because "acceptance and rejection happen in a pull request, not in this platform" — **is now false and is
deleted.** Acceptance happens in this platform: that is the whole of the suggestion feature. In Mode A
there is no pull request at all, and these events are the only durable record of who wrote an accepted
sentence, so retention must not delete them.

One non-human actor is permitted: `{ "sub": "system", "name": "Build", "email": "" }`.

A heartbeat is not an audit fact. Presence and realtime events are never written here.

The month shard keeps `list({prefix})` bounded and makes the retention job a prefix scan.

### 2.5 Pending edit

Blob key: `edits/<docId>/<aid>.json`. It is a receipt, not a record. See section 3.4.

```json
{
  "v": 1,
  "aid": "a3f19c2b",
  "text": "The cache key covers **every** declared input and nothing else.",
  "by": { "...": "section 2.1" },
  "at": "2026-09-01T12:04:11.201Z",
  "baseHash": "sha256 of the block inner HTML as built",
  "pr": 412
}
```

### 2.6 Edit manifest — `<instance>/dist/<instance>.edit.json`

Written by the build. Read by the edit function. It is the only source of a file path.

```json
{
  "docId": "k7m2q4",
  "instance": "example",
  "commit": "7aaca51",
  "built": "2026-09-01T17:30:00Z",
  "blocks": {
    "a3f19c2b": {
      "file": "sections/03-architecture.html",
      "section": "architecture",
      "tag": "p",
      "hash": "sha256 of the block inner HTML"
    }
  }
}
```

Keyed by `aid`, not by an ordinal. See section 3.

### 2.7 Anchors file — `<instance>/anchors.json`

Committed. Written by `anchors.ts`. A reviewer sees anchor churn in the diff, next to the text
change that caused it.

```json
{
  "architecture": {
    "ids": ["a3f19c2b", "a90b7de1"],
    "texts": [
      "The cache key covers every declared input and nothing else.",
      "Every write records the identity that produced it."
    ]
  }
}
```

### 2.8 History file — `<instance>/history.json`

Committed. Written by `history.ts` from local git. Read by the build. See section 4, ticket
P2-E, for why this file exists.

```json
{
  "doc": "example",
  "head": "7aaca51",
  "versions": [
    {
      "sha": "7aaca51",
      "date": "2026-09-01T17:20:00+00:00",
      "author": "the owner W",
      "subject": "Add remote build cache document",
      "url": "https://github.com/aiur-team/archon/commit/7aaca51...",
      "changed": [
        { "file": "03-architecture.html", "id": "architecture", "label": "Architecture",
          "add": 4, "del": 1, "patch": "...", "clipped": false }
      ]
    }
  ]
}
```

### 2.9 Session — the `/api/session` response

```json
{
  "sub": "u_931",
  "email": "owner@example.com",
  "name": "the owner W",
  "roles": ["member"],
  "canComment": true,
  "canEdit": true
}
```

Headers: `Cache-Control: private, no-store`. A missing session returns 401 with no body.

---

## 3. The anchoring decision

This is the hardest problem in the set. Comments, inline edits and the change markers all depend on it.
Four incompatible schemes were proposed. Read this section before any of them.

### 3.1 The ruling

**`data-aid` is the one block identity in the platform.** It is produced at build time by
`anchors.ts`, and it is carried across rebuilds by sequence alignment. A text-quote selector
gives precision inside the block. The two layers degrade independently.

Take document 04 section 3 and section 4 whole. Reject the three alternatives:

- **Reject `data-eid = sha256(doc|section|ordinal)`** from document 05. The id is derived from a
  position. One inserted paragraph renumbers every block below it, and every anchor below it silently
  moves. Document 05 raised this conflict itself and asked the commenting area to decide. The commenting
  area decides, and the decision is stronger than document 05's Option A: there is no second id.
  Inline editing uses `data-aid`. `data-eid` does not exist.
- **Reject `"p:7"`** from document 06. That is an index into the document. Document 04 rejects it
  correctly as the approach with the worst ratio of effort to durability.
- **Reject `{section, quote, offset}` with no block id** from document 03. That is layer 2 without
  layer 1. It fails the moment somebody rewrites the quoted words, which is the exact reason the comment
  exists.

### 3.2 Layer 1 — `data-aid`, carried by alignment at build time

The insight is that this platform has a build step that sees both versions of the document. A browser
anchoring library never has that. It sees only the new text and a stored quote. `anchors.ts` sees the old
block texts in `anchors.json` and the new block texts in the section files. It can align them properly,
once, with full context and no time pressure.

**The scanner.** One block list, one normaliser, one module. `templates/docbuild/src/anchors.ts` owns
both, and **the client imports the same module rather than reimplementing it.** See the normaliser
contract below — that sharing is the point, and it is the single largest benefit of the builder being
JavaScript.

```ts
export const BLOCK = [
  "p", "li", "h2", "h3", "h4", "td", "th", "pre", "blockquote", "figcaption", "dd", "dt",
] as const;

/** Collapse whitespace. Exported so the page runs this exact function. */
export const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
```

Document 05 uses a different, narrower block set. That is a **policy**, not a second scanner. See
section 3.4. Two scanners over the same file will disagree about block boundaries, and the disagreement
will be silent.

**The alignment.** `difflib.SequenceMatcher` over the list of normalised block texts, old against new.

| Opcode | Action |
|---|---|
| `equal` | Carry the id |
| `replace` | Pair the blocks in order. Carry the id when the similarity is 0.6 or more. Below 0.6, orphan the old id |
| `delete` | Orphan the old id |
| `insert` | Mint a new id: `"a" + sha1(text)[:8]` |

Then one move pass: an orphaned id whose exact text reappears elsewhere in the section reclaims that
block.

**Two guards against silent mis-pairing.** Sequence alignment respects order, so two similar siblings do
not swap. The 0.6 floor makes the build orphan rather than guess.

**A third guard matters more than either: the build prints a report.** Every rebuild says how many
blocks kept an id, how many were re-anchored after an edit, how many moved, and how many were orphaned.
A writer who orphans twelve threads finds out at the moment they do it.

```
  anchors
    architecture: 12 equal, 1 edited, 1 moved, 2 ORPHANED
  !! 2 anchor(s) gone. Threads on them become orphaned: architecture/a3f19c2b, architecture/a90b7de1
```

### 3.3 Layer 2 — the text quote, resolved in the client

The client finds the block by `data-aid`, builds the normalised text of that block, and searches for
`exact`. It scores each hit by the length of the common suffix with `prefix`, plus the common prefix
with `suffix`, minus a gentle distance penalty from `start`.

**There is no fuzzy matching.** Fuzzy matching hides failure instead of reporting it, and it blocks the
main thread on large documents with short generic quotes. Do not add `approx-string-match`. Do not add
`dom-anchor-text-quote`.

Four states, and the reader sees a different thing in each:

| State | Condition | The reader sees |
|---|---|---|
| `exact` | Block found, quote found | The highlight, in place |
| `drifted` | Block found, quote not found | The comment on the block, marked "text changed" |
| `moved` | Block gone, the quote found in exactly one other block | The comment there, marked "moved" |
| `orphaned` | Block gone, quote not found or found more than once | The comment in a "Not attached any more" group, with its quote as a blockquote |

`moved` requires a **unique** hit. Nothing is ever silently relocated.

**The normaliser contract is retired, because the duplication is gone.**

This section has now had three answers, and the third is the only one that does not need a test to stay
true. **Under Python the builder and the client had different whitespace sets** and neither had chosen
one: JavaScript `\s` matches U+FEFF, Python's `\s` matched U+0085 and U+001C to U+001F. **Under Rust the
sets were enumerated by hand on both sides**, which removed the divergence but left two implementations
and a CI fixture (`scripts/check-normalise.mjs`) whose only job was to keep them honest.

**The builder is now JavaScript, so there is one function.** `norm()` is defined once in
`templates/docbuild/src/anchors.ts`, the builder calls it directly, and the page runs the same code
because the build inlines that module through a placeholder. There is no second implementation to drift,
no enumerated code-point list to maintain on two sides, and no fixture asserting that two languages
agree.

**The requirement this places on P1-B and P1-D.** The shared text functions — `norm()` and the block
scanner — must live in a module that is valid in **both** a Node build and a browser page: no Node
built-ins, no DOM, only string operations. Inline it through its own placeholder so the page and the
builder cannot fall out of step. **Do not let the client reimplement `norm()` "for convenience"**; that
recreates the whole problem, and it is the failure this ruling exists to prevent.

`scripts/check-normalise.mjs` is not built. Delete the reference to it wherever documents 04 and 05 name
it. What remains worth testing is `norm()` itself, once, as an ordinary unit test.

### 3.4 How inline editing shares the anchor

**A reader edit must produce a change to the section fragment, and then a rebuild. Never a live DOM
patch.** *(Section 1.4 restates this one level lower so it holds for a standalone file too: an edit is an
overlay keyed by `aid`, and promotion to a durable source is a separate act. What follows is that ruling
in its repo-backed form.)* Document 04 calls this the sharpest coupling in the project, and it is correct. If an edit
patches the DOM without a rebuild, the page text and `anchors.json` separate, and comments begin to
mis-resolve.

Document 05's Model 1 satisfies this. **Take Model 1: the edit function commits to a branch and opens a
pull request.** Reject document 03's `edits/<docId>` blob, which makes the overlay the record. Document
05 states the cost of that correctly: everybody who reads the repository, opens the file from disk, or
opens the published artifact reads text that is out of date.

Keep the pending overlay, strictly bounded, exactly as document 05 designs it:

- On save, the function commits to git **and** writes `edits/<docId>/<aid>.json` with the `baseHash` of
  the text it replaced.
- On load, the page applies the pending map and marks each block "pending review".
- `/api/pending` drops any entry whose `baseHash` no longer matches the manifest of the deployed build.
  When the pull request merges and Netlify rebuilds, the hash changes and the entry disappears. No
  cleanup job is needed.

The overlay is a receipt with an expiry date. If Blobs loses everything tomorrow, no content is lost.

**Why a pending edit does not break an anchor.** The edit format is inline text only. It cannot add or
remove a block, so `data-aid` stays valid for the whole life of the pending edit. The text quote may go
to `drifted` while the edit is pending. That is visible and correct.

**The editable policy, applied on top of the one scanner.** A block is editable when all of these are
true:

1. It has a `data-aid`.
2. Its tag is `p`, `h2`, `h3` or `h4`.
3. It occupies whole lines on its own in the section file.
4. It contains no other block tag.
5. It survives the round trip: `to_html(to_md(inner)) == inner`.
6. It is inside the `<!-- body -->` region, not the `<!-- peek -->` block.

`editable.ts` adds `data-editable` and, when the block holds inline markup, `data-md`. It
writes the manifest keyed by `aid`. Measured on this repository today: 78 of 79 candidate blocks pass
the round trip. The one failure holds `&rarr;`, and it becomes read-only automatically.

**Never editable:** the section metadata comment, the peek block, any element with a class, table cells,
`<pre>`, diagram markup, a `<summary>`, `doc.json`, `dist/*.html`, and anything under `templates/base/`.

**Conflict detection.** Document 05 hashes the block inner HTML in the per-deploy manifest. Document 03
uses an `ifAt` timestamp on the blob. **Take the block hash.** It detects a change made by anybody
through any path, including a writer's commit. A timestamp on a blob detects only a change made through
that blob.

Three checks, in order:

1. **The manifest commit.** A hint, not a conflict.
2. **The block hash.** The function reads the section file at the branch head, finds the block by
   `aid` through the same `anchors.ts` scanner, and hashes it. A mismatch returns 409 with the current
   text.
3. **The GitHub blob SHA.** A racing write returns 409 from GitHub. Retry once from check 2. Do not
   loop.

Check 2 finds the block by `aid`, not by an ordinal. This removes document 05's "ordinal drift" failure
entirely: an inserted paragraph no longer points the edit at the wrong block.

### 3.5 What the anchor survives

| Change to the document | `data-aid` | Text quote | The reader sees |
|---|---|---|---|
| Restyle, rewrap, change classes | Keeps | Keeps | Nothing changed |
| Fix a typo elsewhere in the paragraph | Keeps | Keeps | Nothing changed |
| Rewrite the quoted words | Keeps | Loses | The comment on the block, "text changed" |
| Move the paragraph to another section | Keeps | Keeps | Nothing changed |
| Split one paragraph in two | Loses | Keeps in one half | Re-found by quote, marked "moved" |
| Delete the paragraph | Loses | Loses | Orphaned, with its quote |
| Rename the document | Keeps | Keeps | Nothing changed. The key is the `id` |
| Rewrite a whole section | Loses | Loses | Every thread orphaned. This is correct |

---

## 4. The build order

Small tickets. Each ticket names its file surface. **Two tickets in the same phase never touch the same
file.** Where a dependency exists but no file is shared, the ticket says so.

### 4.1 The move that makes the front wide

Four feature areas want to edit `templates/docbuild/src/index.ts`, `templates/base/layout.html`,
`templates/base/app.js` and `templates/base/components.css`. That is a four-way collision on four files.

**Fix it once, in phase 1.** One ticket (P1-B) adds every placeholder and every hook call site. Each
placeholder reads an optional file. A missing file resolves to an empty string, so P1-B is safe to land
before any feature exists.

```ts
/** Inline templates/base/<name> if it exists, else nothing. */
const slot = (base: string, name: string): string =>
  existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8") : "";
```

Placeholders added to `layout.html`, all empty on the day P1-B lands:

| Placeholder | File | Owner |
|---|---|---|
| `{{SESSION_JS}}` | `templates/base/session.js` | P2-C |
| `{{SESSION_CSS}}` | `templates/base/session.css` | P2-C |
| `{{COMMENTS_JS}}` | `templates/base/comments.js` | P3-C, P4-A |
| `{{COMMENTS_CSS}}` | `templates/base/comments.css` | P3-C |
| `{{EDIT_JS}}` | `templates/base/edit.js` | P4-B |
| `{{EDIT_CSS}}` | `templates/base/edit.css` | P4-B |
| `{{HISTORY_JS}}` | `templates/base/history.js` | P3-D |
| `{{HISTORY_CSS}}` | `templates/base/history.css` | P3-D |
| `{{HISTORY_JSON}}` | generated from `<instance>/history.json` | P2-E |
| `{{DOC_ID}}` | from `doc.json` | P1-A |
| `{{REALTIME_JS}}` | `templates/base/realtime.js` | P3-F |
| `{{PRESENCE_JS}}` | `templates/base/presence.js` | P3-G |
| `{{PRESENCE_CSS}}` | `templates/base/presence.css` | P3-G |
| `{{SHARE_JS}}` | `templates/base/share.js` | P3-I, P4-L |
| `{{SHARE_CSS}}` | `templates/base/share.css` | P3-I |

P1-B grows by five rows and stays safe to land first, because `slot()` resolves a missing file to an empty
string. **No markup is added to `.head-top`** — the share panel and the presence strip are created by
script, so they are *absent* rather than hidden on `file://`, in an artifact, in print, and in Mode A
before a site is connected. P1-B also lands the one-line `window.doc` namespace object, which is the only
cross-module surface besides the `session` event.

**The three builder gaps are closed, and two of them stopped existing.** The Rust conversion found three
gaps for P1-B. The TypeScript rewrite on 2 September resolved all three without a ticket:

1. ~~**The scanner cannot read arrays.**~~ Gone. `JSON.parse` is built in, so `doc.json` can hold
   `aliases` and `anchors.json` is readable with no parser work at all. The hand-rolled scanner that
   forced this gap no longer exists.
2. ~~**Non-string values read as absent.**~~ Gone for the same reason. `"history": false` parses as a
   boolean. The builder still exposes only string fields through `get()`, deliberately, but the
   distinction between absent and false is now available whenever a feature needs it.
3. ~~**`Section` has no `file` field.**~~ Added in the rewrite. `editable.ts` can key its manifest row on
   it immediately.

**So P1-B is smaller than planned, not larger.** That is worth noting because it is the keystone ticket
every phase-1 lane waits on.

**Nobody edits `app.js` or `components.css` again for feature work.** They hold the existing theme
toggle and the existing component styles. New behaviour goes in a new file with a new placeholder.

Three hook call sites also land in P1-B.

**The guard is a present-input test, not a present-module test.** The original Python plan wrapped each
hook in `try: import ... except ImportError`, so a feature that had not landed was simply absent. One
compiled package has no optional import — every module ships — so the guard moves to *is the input
present*, which is the same test `slot()` already applies. Each hook is a module under
`templates/docbuild/src/`, always compiled, returning a no-op when its input file does not exist. P1-B
lands three modules that return empty values, and a feature ticket fills one in without touching a call
site.

The exact signatures, so two agents can code to them without talking:

```ts
// templates/docbuild/src/anchors.ts                        (P1-D)
/** Add data-aid to every block in every section body, in place.
 *  Rewrites <inst>/anchors.json. Orphans are [sectionId, aid] pairs. */
export function anchorSections(
  inst: string,
  sections: Section[],
): { report: string[]; orphans: Array<[string, string]> };

// templates/docbuild/src/editable.ts                       (P2-D)
/** Add data-editable and data-md to blocks that pass the policy, in place.
 *  Requires data-aid to be present already. Returns manifest rows, keyed later by aid. */
export function markEditable(sections: Section[], doc: Doc, inst: string): ManifestRow[];

// templates/docbuild/src/history.ts                        (P2-E)
/** Refresh <inst>/history.json from local git when git works.
 *  Read and return the file when git is absent. Returns null when neither works. */
export function refresh(inst: string): History | null;

/** Return a Section that renderSection() can consume. */
export function changelogSection(h: History, labels: Array<[string, string]>): Section;
```

`Section` and `Doc` are the types `index.ts` already exports. A hook mutates the `Section[]` it is given,
exactly as the Python plan did, so the ownership of each stage does not change. Every hook throws
`BuildError` on an expected failure, so the CLI never prints a stack trace.

### 4.2 The build contract

Two documents collide here, and neither saw the other.

Document 06 bakes `git log` output into `dist/*.html`. Document 01 requires CI to rebuild and assert
`git diff --exit-code` is empty. Those cannot both hold: the writer builds at commit N-1 and commits the
result, then CI checks out commit N and rebuilds, and the history block now includes commit N. The
staleness check fails on every commit.

Document 06 also forbids a git read inside the Netlify build, because Netlify does not document its
clone depth, and a shallow clone would produce a one-entry changelog and a green build.

**The ruling solves both at once. `<instance>/history.json` is a committed generated file.**

- `history.ts` reads local git on the writer's machine and refreshes `history.json`.
- The builder reads `history.json`. It never runs git when the file is present and git is absent.
- `docbuild --site` on Netlify runs the same composition against the same committed inputs. No git read
  happens there.
- `dist/*.html` becomes a pure function of committed files. CI can compare it byte for byte with no
  exclusions.

This costs one more committed generated file, next to `anchors.json`. It buys a deterministic build, a
live deploy preview from `sections/`, and history churn that a reviewer sees in the diff.

**The two outputs stay parallel.** `docbuild <instance>` produces the artifact copy. `docbuild --site`
produces the site copy. One entry point, two modes, so the two paths cannot drift apart the way two
scripts could. They differ by **one line**: the script tag for `/_assets/enhance.<hash>.js`. The doc-id meta
tag moves into `layout.html`, so both copies carry it. Document 01's three appended lines become one.

**Reject the `--with-comments` snapshot** from document 04 section 11. It would fetch live comments into
`dist/`, which makes `dist/` a function of the network and breaks the CI staleness check and the parity
contract. Revisit only after everything else works.

### 4.3 Phase 1 — unblocks everything. Five tickets, no shared file.

| Ticket | Work | Files it owns |
|---|---|---|
| **P1-A** | Add `id`, `slug`, `aliases` to every `doc.json`. Generate each id with `openssl rand -hex 3`. Create `example/doc.json` and a first section, or exclude that directory | `example/doc.json`, `example/doc.json`, `templates/components/doc.json`, `templates/skeleton/doc.json` |
| **P1-B** | The keystone. Add `slot()`, every placeholder in section 4.1, `{{DOC_ID}}`, and the three guarded hook call sites | `templates/docbuild/src/index.ts`, `templates/base/layout.html` |
| **P1-C** | The identity contract. `identify()` and `requireOrigin()`. `/api/session`. The one `package.json` | `package.json`, `netlify/lib/identity.mjs`, `netlify/functions/session.mjs` |
| **P1-D** | `anchors.ts`: the scanner, the normaliser, the alignment, the move pass, the report. Section 3.2 | `templates/docbuild/src/anchors.ts`, `example/anchors.json` |
| **P1-E** | Netlify configuration. `netlify.toml` complete, including the `[[edge_functions]]` block that points at a gate P2-A writes. The `--site` build mode. `.gitignore`. The CI workflow | `netlify.toml`, `.gitignore`, `templates/docbuild/src/site.ts`, `.github/workflows/build.yml` |

**Verify P1-A:** every id is six hexadecimal characters, and no id and no slug repeats.

**Verify P1-B:** `templates/build example` produces a file that is byte-identical to
today, except for one `<meta name="doc-id">` line. No unfilled placeholder remains.

**Verify P1-C:** `netlify dev`, then `curl -i localhost:8888/api/session` returns 401 when signed out and
the section 2.9 shape when signed in. `identify()` never throws.

**Verify P1-D:** rebuild `example` twice with no change; `anchors.json` is byte-identical. Edit one
paragraph, rebuild; the report says `1 edited` and the `data-aid` in `dist/` is unchanged. Reorder three
paragraphs; all three keep their ids.

**Verify P1-E:** open a throwaway pull request. The deploy preview renders every document. `git diff`
after `docbuild --site` is empty.

**The one `package.json`.** Three documents proposed three partial dependency lists. This is the file:

```json
{
  "name": "architecture-docs-functions",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "dependencies": {
    "@netlify/blobs": "11.0.2",
    "@netlify/identity": "2.0.0"
  },
  "devDependencies": {
    "@netlify/functions": "6.0.0"
  }
}
```

Pinned exactly. All three versions were checked on 2026-09-01. Set `NODE_VERSION` to 22 or 24 in the
Netlify user interface, so the build and the function runtime agree.

**This does not break the zero-dependency rule.** That rule protects the authoring path. A writer runs
`templates/build my-doc` and needs no Node and no npm. Only Netlify runs npm, only at deploy,
and only for the server.

### 4.4 Phase 2 — five tickets, no shared file

| Ticket | Work | Files it owns | Needs |
|---|---|---|---|
| **P2-A** | The edge gate. The login and logout functions. The login page, an HTML form with no build step | `netlify/edge-functions/gate.ts`, `netlify/functions/login.mjs`, `netlify/functions/logout.mjs`, `login/index.html` | P1-C, P1-E |
| **P2-B** | The store helper. `docState()`, `mutate()` with six attempts and back-off, `read()`, `upgrade()`, key builders | `netlify/lib/store.mjs` | P1-C |
| **P2-C** | The session probe and the reveal rules. Dispatch the `session` event | `templates/base/session.js`, `templates/base/session.css` | P1-B, P1-C |
| **P2-D** | `inline_md.ts`, the round-trip gate, `editable.ts`, the manifest writer, the fixture | `templates/docbuild/src/inline_md.ts`, `templates/docbuild/src/editable.ts`, `templates/fixtures/inline.json` | P1-B, P1-D |
| **P2-E** | `history.ts`: `git()`, `parse_diff()`, `history()`, `trim()`, `changelog_section()`. Write `history.json` | `templates/docbuild/src/history.ts`, `example/history.json` | P1-B |

**Verify P2-A:** `netlify dev`. An anonymous request to `/example/` redirects to `/login/?next=...`.
A signed-in member reads the page. A guest without the document in scope gets 403. `/login/` and
`/api/*` are never redirected.

**Smoke-test first:** confirm that `import { getUser } from '@netlify/identity'` resolves inside a Deno
edge function. Document 02 lists this as unresolved. If it fails, move the gate into a version 2
function with `config.path`, and accept the extra complexity.

**Verify P2-B:** two concurrent writes to one thread key both land. The second retries once.

**Verify P2-D:** the round trip passes for 78 of 79 blocks in this repository. The demoted block is
`templates/components/sections/02-diagrams.html`. The built HTML grows by less than 2 KB.

**Verify P2-E:** `history.json` is stable when nothing changes. The embedded block is under 16 KB. With
git absent, the build prints `SKIPPED` and still produces a valid document.

### 4.5 Phase 3 — five tickets, no shared file

| Ticket | Work | Files it owns | Needs |
|---|---|---|---|
| **P3-A** | The threads API. `GET /api/threads` lists by prefix. `POST` creates. `POST`/`PATCH` on one thread replies, resolves and reopens. Every handler calls `requireOrigin()` then `identify()` | `netlify/functions/threads.mjs`, `netlify/functions/thread.mjs` | P1-C, P2-B |
| **P3-B** | The events API. `POST` appends. `GET` lists by month prefix | `netlify/functions/events.mjs` | P1-C, P2-B |
| **P3-C** | The comments client, **read only**. `textMap()`, `locate()`, the four states, the CSS Custom Highlight API, the margin rail, the panel | `templates/base/comments.js`, `templates/base/comments.css` | P1-D, P2-C |
| **P3-D** | The changelog client. Read `#doc-history`, compare against a `localStorage` marker, render the change bar and the section dots | `templates/base/history.js`, `templates/base/history.css` | P2-E |
| **P3-E** | `GET /api/pending`. It reads `edits/<docId>/*` and drops any entry whose `baseHash` no longer matches the manifest | `netlify/functions/pending.mjs` | P2-B, P2-D |

**Verify P3-A:** with `curl` against `netlify dev`: create a thread, list it, reply, resolve, reopen. A
signed-out request returns 401. A request with an `author` field in the body stores the server identity,
not the body.

**Verify P3-C:** all four anchor states, produced by hand. Edit the quoted words and rebuild: `drifted`.
Move a paragraph to another section and rebuild: still `exact`. Delete the paragraph and rebuild:
`orphaned`, and the panel shows the quote. Open the file from `file://`: no comment user interface, no
console error.

**Verify P3-D:** clear the `localStorage` key, load, and see no banner. Add a commit, rebuild, reload,
and see the banner name the changed section.

**Highlight rule:** use the CSS Custom Highlight API. **Never wrap text in `<mark>`.** A `<mark>` wrapper
splits text nodes and invalidates the anchor resolution of every other thread. The API has been Baseline
since June 2025. The fallback for anything older is a left border on the block. Do not add a polyfill.

**Refresh rule:** document 03 polls every 15 seconds. Document 04 forbids a polling loop. **Take document
04.** Refresh on `visibilitychange`, throttled to once per 30 seconds. Polling a background tab spends
credits and buys nothing for tens of readers.

### 4.6 Phase 4 — write paths and the sharp edges

These are sequenced, not parallel, where they share a file.

| Ticket | Work | Files it owns | Needs |
|---|---|---|---|
| **P4-A** | The comment write path. The selection tooltip, the draft box, reply, resolve, reopen. Multi-block selections are refused, not clamped | `templates/base/comments.js` | P3-A, P3-C |
| **P4-B** | The edit write path. `POST /api/edit`: manifest lookup, branch, block hash check, commit, one pull request per reader per document, pending receipt. The client: `contenteditable="plaintext-only"` with the nine-line fallback | `netlify/functions/edit.mjs`, `templates/base/edit.js`, `templates/base/edit.css` | P2-D, P3-E |
| **P4-C** | The converter twin check and the normaliser check, both in CI | `scripts/check-inline-md.mjs`, `scripts/check-normalise.mjs`, `.github/workflows/build.yml` | P2-D, P3-C |
| **P4-D** | The Slack webhook, fired from `context.waitUntil` | `netlify/lib/notify.mjs` | P3-A |
| **P4-E** | ~~Guest invite and the signed share link.~~ **RETIRED 2026-09-02.** Replaced by the access write path (P4-J) and invitation acceptance (P4-K). A bearer share link cannot attribute a comment, because §2.1 needs a proven `sub`, and it cannot be revoked. `netlify/lib/share.mjs` is not built | — | — |
| **P4-F** | Retention. Delete events older than 18 months. Run daily | `netlify/functions/retention.mjs` | P3-B |
| **P4-G** | Documentation: `id`, `slug`, `aliases`, the rename procedure, the sentence-per-line convention, `docbuild --site`, the anchor report | `templates/README.md` | everything |

**Verify P4-B:** an edit produces a branch, a commit with the reader as author, and one pull request. A
second edit adds a commit to the same pull request. A hand-edited source file makes the next save return
409 with the current text. A reader who is not an org member gets 403 and never sees the affordance.

**The token.** `DOCS_GITHUB_TOKEN` is a fine-grained personal access token, scoped to this one
repository, with Contents read and write and Pull requests read and write. Nothing else. Scope it to
Functions in the Netlify user interface, **not to Builds**. Put its expiry in a calendar.

**The blast radius.** The token can write to the whole repository. The manifest lookup is the only thing
that stops a caller from choosing a path. **Never accept a path or an instance name from the client.**
If a second write path is added later, derive its path from the manifest too.

**The sentence-per-line convention** costs the writer nothing and converts every future diff from "this
400-character line changed" into "this sentence changed". It is worth more than any diff algorithm.

---

### 4.7 The tickets the September scope adds

Documents 07, 08 and 09 were written in parallel on 2 September 2026 and **three of them claimed the same
letters.** The letters below are the authority; the letters inside those three documents are not. Read a
letter as an identifier with no order.

Two tickets proposed there do not appear, and this is deliberate:

- **`08`'s P1-F** (add `owner` and `editors` to every `doc.json`) is dropped. §1.5 rules that authority
  does not live in `doc.json`. Nothing is folded into P1-A.
- **`08`'s authority module** is dropped. `isDecider(session, manifest)` is superseded by
  `resolveRole(docId, user)` in `netlify/lib/access.mjs`, which P2-G owns.

| Ticket | Work | Files it owns | Source | Depends on |
|---|---|---|---|---|
| **P2-F** | The realtime server contract. `mintToken()` and `publish()`, both returning `null` with no `ABLY_API_KEY`. `GET /api/realtime-token` with its 204, 401 and 403 cases | `netlify/lib/realtime.mjs`, `netlify/functions/realtime-token.mjs` | 07 | P1-C, P1-E |
| **P2-G** | The access library. Parse `DOC_OWNERS`, `resolveRole()`, the capability map, the key builders, the email hash, owner binding, invitation conversion | `netlify/lib/access.mjs` | 09 | P1-C, P2-B |
| **P2-H** | Split identity from authorisation. `identify()` loses `canComment`, `canEdit` and `docs`, and gains `isOrg` | `netlify/lib/identity.mjs` (after P1-C) | 09 | P1-C |
| **P3-F** | The client transport. The four degradation gates, the SSE attach with `rewind=30s`, token refresh on Ably 40140–40149, and a `doc:event` bus. **No presence, no interface** | `templates/base/realtime.js` | 07 | P1-B, P2-C, P2-F |
| **P3-G** | Presence. The 20-second beat, `bye` on `pagehide`, the 50-second expiry, the masthead avatars, the per-block rail marker, the "hide me" toggle | `templates/base/presence.js`, `templates/base/presence.css` | 07 | P1-D, P3-F |
| **P3-H** | `GET /api/access` for `canSeeMembers` only. Amend `/api/session` to take `?doc=` | `netlify/functions/access.mjs`, `netlify/functions/session.mjs` (after P1-C) | 09 | P2-G, P2-H |
| **P3-I** | The share panel, read only. The button in `.head-top`, the popover, the member list, the `file:` guard, the print rule | `templates/base/share.js`, `templates/base/share.css` | 09 | P1-B, P2-C, P3-H |
| **P3-J** | The gate learns the grant store. Read the docId from `<meta name="doc-id">`, resolve read access from `access/`. Retire `appMetadata.docs` | `netlify/edge-functions/gate.ts` (after P2-A) | 09 | P2-A, P2-G |
| **P4-H** | The server fan-out. A realtime sink beside the Slack sink, so there is **one** fan-out point. Events carry an id and a hash only | `netlify/lib/notify.mjs` (after P4-D) | 07 | P2-F, P3-F, P4-D |
| **P4-I** | The editing soft lock. `edit.claim` on focus, `edit.release` on blur, save and `pagehide`. The "editing" chip. **The block hash stays the authority** | `templates/base/edit.js`, `templates/base/presence.js` (after P4-B) | 07 | P3-G, P4-B |
| **P4-J** | The access write path. `POST`, `PATCH`, `DELETE` on `/api/access`, plus transfer. `admin.createUser` and `requestPasswordRecovery`. The four audit events | `netlify/functions/access.mjs` (after P3-H) | 09 | P3-H, P3-J, P2-A |
| **P4-K** | Invitation acceptance. `/invite/` as an HTML page reading `location.hash`. `POST /api/accept` consumes the token server-side | `invite/index.html`, `netlify/functions/accept.mjs` | 09 | P4-J, P2-A |
| **P4-L** | The share panel write controls. Invite row, role menu, revoke, cancel, transfer with confirmation, the org default control | `templates/base/share.js` (after P3-I) | 09 | P3-I, P4-J |
| **P4-M** | Enforcement in the existing write paths. `threads.mjs` and `thread.mjs` check `canComment` and the resolve rule; `edit.mjs` checks `canSuggest` and `canEdit` | `netlify/functions/threads.mjs`, `thread.mjs` (after P3-A), `edit.mjs` (after P4-B) | 09 | P3-A, P4-B, P2-G |
| **P4-N** | The one apply path. Move the branch, hash check, commit, pull request and receipt write into `gitedit.mjs`. Add the Mode A branch, the receipt fields, and the `X-Suggestion-Id` idempotency trailer | `netlify/lib/gitedit.mjs`, `netlify/functions/edit.mjs` (after P4-B) | 08 | P4-B |
| **P4-O** | The suggestion API. `GET`/`POST /api/suggestions`, and accept, reject and withdraw. The five-per-block cap, the effective base, the 14-day reaper | `netlify/functions/suggestions.mjs`, `netlify/functions/suggestion.mjs` | 08 | P2-B, P2-G, P4-N |
| **P4-P** | The suggestion client. Suggest and Edit controls, the draft box, the block chip, the card renderer, accept, reject, withdraw, re-propose, and the `doc:overlay` event | `templates/base/edit.js`, `templates/base/edit.css` (after P4-B and P4-I) | 08 | P4-I, P4-O, P4-Q |
| **P4-Q** | The shared surface. `comments.js` publishes `window.doc.rail` and `window.doc.panel`, gains the Suggestions filter, and re-resolves a block's anchors on `doc:overlay` | `templates/base/comments.js`, `comments.css` (after P4-A) | 08 | P3-C, P4-A |
| **P4-R** | Mode A acceptance and promotion. The overlay-only apply path, and a promotion step writing one `versions[]` row into `history.json` for each promoted change, crediting the suggester | The Mode A connect and export tool, `history.json` on promotion | 08 | P4-N, P4-O, the §1.4 Mode A tickets |
| **P4-S** | The connect tool sets `DOC_OWNERS` for a new Mode A document and prints the ownership warnings | The connect tool | 09 | P2-G, the §1.4 connect ticket |
| **P4-T** | Retention. Exclude `suggest.accept`, `suggest.reject`, `edit.apply` and the four `access.*` events from the 18-month delete. Sweep `suggest/` older than 90 days | `netlify/functions/retention.mjs` (after P4-F) | 08 | P4-F |

**Phase 4 is sequenced, not parallel, wherever a file is shared.** That was already the rule. Nine of
these fourteen phase-4 tickets amend a file an earlier ticket creates, and each says so.

**Two existing tickets change scope.** P4-D's Slack webhook must also fire on `suggest.create` and on a
decision, because that is the only notification an author gets. P2-A ships before P3-J, so until P3-J lands
a non-org session gets 403 on every document — that fails closed, so the order is safe.

**A load-order requirement that is easy to miss.** `edit.js` replacing a block's inner HTML destroys the
live `Range` objects `comments.js` holds, which is the same class of failure that made §4.5 forbid
`<mark>`. The overlay must be applied **before** anchors resolve, and any later change must dispatch
`doc:overlay`.

---

## 5. What we are not building

Each item names why, so nobody re-proposes it.

**Storage and the server**

- **Netlify DB and Postgres.** The free plan sleeps after 5 minutes, storage price after 1 July 2026 is
  unknown, and a failed migration blocks the publish. Section 1.1 lists the six triggers to revisit.
- **Any store outside Netlify.** Supabase, Firebase, Upstash, PlanetScale. Each adds a vendor, a
  credential and a second thing that can be down.
- **An object-relational mapper.** Drizzle adds `node_modules`, a build step and a type-generation step
  to a repository whose appeal is a builder with no runtime dependencies.
- **Comments in git.** Every comment becomes a commit and a deploy at 15 credits. Two readers commenting
  at once produce a merge conflict that neither can resolve from a browser.
- **Netlify Forms.** No threading, no read API from the page, no edit and no delete.
- **A transaction across two blobs.** Blobs has none. A thread write and its event write are two acts.

**Identity**

- **GitHub OAuth by hand.** About 150 lines of security-relevant code that nobody will review again.
- **Auth0.** Its value is multi-factor authentication, single sign-on and social providers. None is
  needed for tens of internal readers. Revisit only on a policy mandate.
- **Git Gateway.** Deprecated, and the deprecation was not reversed.
- **Netlify project visibility as the gate.** On Free and Personal a private project is visible to the
  Team Owner only, and it cannot scope one document to one person.
- **A password-reset user interface and self-registration.** Run `requestPasswordRecovery` by hand.
- **A one-time ownership claim code.** Considered for Mode A, where the person deploying a document is
  often not its owner. It is a bearer secret until it is redeemed, and `DOC_OWNERS` covers the case. Revisit
  when somebody actually deploys a document for another person.
- **A bearer share link.** An invitation is bound to an identity. A bearer link cannot attribute a
  comment and cannot be revoked.
- **A co-owner.** One owner. Transfer is a single act.
- **A group as the unit of a grant.** One grant, one person.
- **A cross-document access query.** No "shared with me" list and no cross-document revoke.

**The document and the client**

- **A static site generator.** Eleventy, Astro or Hugo would add a lockfile, a template language and an
  upgrade treadmill. The builder is one TypeScript package with no runtime dependencies at all.
- **React or any framework in the page.** React and ReactDOM alone are about 140 KB against a 40 KB
  document, and a bundler ends the one-command path.
- **Any runtime npm dependency in the page. Zero.** `@netlify/blobs` and `@netlify/identity` run on the
  server only.
- **A rich-text editor.** Quill is about 40 KB minified. Three inline marks cover the prose in this
  repository.
- **A conflict-free replicated data type.** Yjs and Automerge solve concurrent character-level editing.
  Readers propose a sentence, occasionally, on a block they clicked.
- **A JavaScript diff library.** `git diff` already computed the diff at build time.
- **Real-time updates, as originally ruled.** This bullet said "no websockets, no server-sent events, no
  polling loop". **That is superseded.** The narrower prohibition: no WebSocket server of our own, no SSE
  endpoint on Netlify, no conflict-free replicated data type, no realtime SDK in the page, and no caret or
  selection sharing. Realtime is one hosted broker; it carries ids and hashes, never text; and presence is
  never persisted. See §1.6.
- **An un-apply button, a rebase of a superseded suggestion, a word-level diff on the page, a
  cross-document "suggestions waiting for me" view, and an API that writes `owner` or `editors`.**

**Anchoring**

- **Client-side fuzzy matching.** It hides failure instead of reporting it.
- **XPath and CSS-selector anchors.** One added paragraph breaks every path below it.
- **Content-hash-only block ids.** They orphan a comment the moment somebody fixes a typo, which is
  precisely when the comment matters.
- **Apache Annotator** (retired from the Incubator on 2025-08-11), **`dom-anchor-text-quote`** (last
  published 2017), **`@recogito/text-annotator`** (543 KB, 9 dependencies), **`text-fragments-polyfill`**.
- **DOM mutation for highlights.** Section 4.5.

**Features**

- **Comment delete.** Document 04 has none. Document 06 has a two-stage purge and a retention job to
  serve it. Take document 04. A rare, destructive act keeps deliberate friction:
  `netlify blobs:delete doc-state threads/<docId>/<threadId>.json`. Document 06's retention job survives
  for expiry only.
- **Nested reply trees.** One level of replies. Nested trees look powerful and read badly.
- **Email notification, per-user subscriptions, digests, unread counts.** Each needs subscription state,
  a provider, a sending domain and DNS records. That is more setup than the whole comment system. One
  Slack webhook covers the real case. **Write down the gap:** a reader who never reopens the document
  never learns their comment was answered.
- **A version picker, a "restore this version" button, and stored renders of old versions.** `dist/` is
  committed, so git already has every past render. Restoring a version is `git revert`, run by a writer.
- **A merged timeline of commits and comments.** Two event streams at different rates competing for one
  column. Keep the changelog a list of versions and the thread a list of comments, joined by a link.
- **The `--with-comments` offline snapshot.** Section 4.2.
- **Editing tables, code, diagrams, peek blocks, summaries, `doc.json` or `dist/`.** Section 3.4.
- **`localStorage` as a store of record.** It is correct for two things only: a draft comment, and the
  "last read" marker. Wrap every read and every write in `try`/`catch`.
- **One Netlify site for each document.** Six configurations, six credit budgets, six preview links on a
  pull request that touches two documents.
- **Octokit.** Four HTTP calls do not need a large dependency tree.
- **A cross-document query, an inbox, or search.** Section 1.1 lists these as the triggers to migrate.

---

## 6. Contradictions found

Twenty-six. Each produces different code, so each needed a ruling.

| # | The disagreement | Position A | Position B | Ruling |
|---|---|---|---|---|
| 1 | `netlify.toml` publish directory and build command | 01: `_site`, a site build | 02: `public`, a publish script. 03: `.`, one document. 05: `public`, two builder calls | **01.** One site, one directory for each document. P1-E owns the whole file. The other three files are deleted |
| 2 | The URL layout | 01: `/<slug>/` | 02: `/docs/<instance>/`, and the gate matches `/docs/*` | **01.** Clean URLs, and `/d/<id>` redirects forever. The gate matches `/*` with three exclusions instead |
| 3 | The document storage key | 01: a permanent opaque `id` | 03, 04, 05, 06: the directory name or the slug | **01.** A rename otherwise orphans every thread, event and pending edit |
| 4 | Threads blob granularity | 03: one blob for each document | 04: one blob for each thread | **04.** 04 and 06 agree against 03, for the same reason: no shared mutable array in one blob. The read cost is accepted |
| 5 | Source of truth for discussion | 03, 04: a mutable thread record | 06: an append-only event log, folded on the client | **03 and 04.** A fold means the client fetches every event ever written. The event log stays as an audit trail |
| 6 | Store names | 03: `doc-state`. 04: `threads` | 05: `doc-edits`. 06: `annotations`, `history-cache` | **One store, `doc-state`,** with three key prefixes. `history-cache` is not needed; the live-history proxy is not built |
| 7 | Block identity | 04: `data-aid`, aligned by `difflib` | 05: `data-eid` from `sha256(doc\|section\|ordinal)`. 06: `"p:7"`. 03: no block id | **04.** Section 3. `data-eid` does not exist. Inline editing uses `data-aid` |
| 8 | Where a reader edit lands | 05: a git pull request, plus a bounded receipt | 03: an `edits/<docId>` blob that is the record | **05.** An overlay as the record makes the repository, the disk copy and the artifact all stale |
| 9 | The identity accessor | 02: `getUser()`, Functions v2 | 03, 05, 06: `context.clientContext.user`, Functions v1. 04: unspecified `identify()`. 06 also `context.claudeUser` | **02.** A v1 handler silently has no session. One module, `netlify/lib/identity.mjs`, exports 04's `identify()` signature |
| 10 | Roles | 02: `member` and `guest` only | 05: a required `editor` role | **02 — REOPENED 2026-09-02.** The original ruling stands as the reason `editor` is not the default. The product requirement added a share panel that invites a named person, which the ruling did not anticipate. See §1.2 and `09-sharing-and-roles.md` |
| 11 | Client capability gating | 02: `data-session` on the root | 03: `.has-state`. 04: `data-comments-api` on the body. 05: `window.netlifyIdentity` | **02.** One probe, one attribute, one `session` event. `netlify-identity-widget` is not used |
| 12 | The document id in the HTML | 01: a meta tag added by the site build only | 03: `data-doc-id` on the masthead. 05: `data-doc` on the root | **A meta tag in `layout.html`,** so both builds carry it. This makes the two outputs differ by one line, not three |
| 13 | Refresh strategy | 03: poll every 15 seconds | 04: no polling; `visibilitychange`, throttled to 30 seconds | **04.** Polling a background tab spends credits and buys nothing |
| 14 | `package.json` contents | 02: `@netlify/identity` only | 03: `@netlify/blobs` only. 05, 06: blobs plus functions | **One file, all three,** pinned. Section 4.3 |
| 15 | The Netlify plan | 02: Pro, $20. 01: Pro if visibility is the gate | 03, 04, 06: Personal, $9 | **Personal, $9.** The edge gate does the access control, so the project can be public and Pro is not required |
| 16 | Who writes a history row | 03: the threads function writes it inline | 06: a separate annotations function. 04: "resolve who owns the writer" | **The threads function writes the event,** through `netlify/lib/store.mjs`. `/api/events` is read-mostly |
| 17 | Does the builder change | 02: "it does not change" | 03, 04, 05, 06: all four change it | **It changes, once, in P1-B.** After that, features add modules, not lines to `index.ts` |
| 18 | The block scanner tag set | 04: `p\|li\|h2\|h3\|h4\|td\|th\|pre\|blockquote\|figcaption\|dd\|dt` | 05: `p\|h2\|h3\|h4`, whole lines only | **One scanner (04), two policies.** 05's set becomes the editable policy applied on top. Two regexes would disagree silently |
| 19 | Comment delete | 04: there is no delete | 06: `comment.delete`, a 30-day purge, and a retention job | **04.** Deliberate friction on a rare destructive act. 06's retention job survives for expiry only |
| 20 | Baked git history against the staleness check | 06: the builder bakes `git log` into `dist/` | 01: CI rebuilds and asserts `git diff --exit-code` is empty | **Neither document saw the other.** The check would fail on every commit. Ruling: `<instance>/history.json` is a committed generated file, so `dist/` is a pure function of committed inputs |
| 21 | Reading git in the Netlify build | 01: the site build runs on Netlify | 06: never read git there; the clone depth is undocumented | **06's constraint, 01's build.** The same ruling as #20 removes the git read from Netlify entirely |
| 22 | Artifact and site output parity | 01: identical except three appended lines | 04: `--with-comments` bakes fetched comments into `dist/` | **01.** A network-dependent `dist/` breaks the parity contract and the CI check. Revisit later |
| 23 | Edit staleness detection | 05: `sha256` of the block inner HTML, in a per-deploy manifest | 03: an `ifAt` timestamp on the blob | **05.** A hash detects a change made through any path. A blob timestamp detects only a change made through that blob |
| 24 | Thread and comment id format | 03: `t7`, `c11`, from a per-document `seq` minted inside the CAS | 04: `t_<base36 time>_<uuid8>` | **04.** 03's counter needs the per-document blob that #4 rejects. 04's id also sorts by creation time, so `list()` returns document order |
| 25 | The author field shape | 03, 06: an email string | 04: `{sub, name, email}`, with ownership checked on `sub` | **04.** An email is not a stable identifier and it changes on a rename. Section 2.1 |
| 26 | The body length cap | 03: 8000. 04: 10000 | 05: 4000 for an edit. 06: 8000 for a whole event body | **8000 for a comment, 4000 for an edit.** One validator, not four |

### Added in review, 2 September 2026

| # | Question | Ruling |
|---|---|---|
| 27 | What language is the build tooling | **TypeScript.** Decided 2026-09-02, superseding the Rust answer given earlier the same day. Reasons in ruling 39. Documents 01 to 06 name Python or Rust modules throughout and are superseded on every one |
| 28 | Repository, or a single uploaded file | **Both.** Section 1.4. Two modes, one overlay mechanism, one data model |
| 29 | Does an accepted edit reach the source | **The owner chooses, in both modes.** A PR is the expected path in Mode B. Mode A needs an export before it needs an editor |
| 30 | Blob granularity under concurrent editing | **One blob for each record, as already ruled in section 1.1.** The review confirmed the test that ruling was made against |
| 31 | Realtime and presence against §5's "no real-time updates" | **§5's bullet is superseded and narrowed.** Netlify cannot hold a socket and has no publish-subscribe primitive, so a hosted broker is the only path. The store decision does not change. §1.6 |
| 32 | Where authority lives — a committed `doc.json` (document 08) or the state store (document 09) | **Document 09.** A commit-per-invitation cannot serve a share panel, and in Mode A there is no repository to commit to. Document 08's argument is kept as the audit-trail requirement. §1.5 |
| 33 | Suggestion against edit | **Two entry points, one apply path.** `gitedit.mjs` is extracted so accept and edit cannot drift into two conflict checks |
| 34 | The suggestion key layout | **The proposal layer fans out by `sugId`; the applied layer stays one blob per anchor.** §1.1 already ruled that two applied edits on one block are a genuine conflict |
| 35 | Does acceptance happen in this platform | **Yes.** This reverses the §2.4 sentence, which is deleted. In Mode A there is no pull request at all |
| 37 | Which realtime broker, and on what plan | **Ably, free tier.** Decided 2026-09-02. The ceiling is 200 account-wide concurrent connections. Durable Objects is the migration target |
| 39 | What language is the builder, finally | **TypeScript, zero runtime dependencies.** Decided 2026-09-02 when the template became a consumable dependency for TypeScript repositories. Four reasons: the consumers are TS repos; every Netlify Function in this plan is already JavaScript, so Rust made the product bilingual; Node is the Netlify build image default while Rust has no installed toolchain there; and `norm()` becomes one shared function instead of two implementations plus a CI fixture. Byte parity against all three committed documents was the acceptance test and it passed |
| 40 | Netlify toolchain pinning | **Nothing to pin.** The Rust answer needed a `rust-toolchain` file because the build image installs no default toolchain, and its cold-build cost was undocumented. Node 24 is the image default. `rust-toolchain` is not created |
| 38 | How a Mode A document gets its first owner | **The `DOC_OWNERS` site environment variable, set by the connect tool.** Decided 2026-09-02. It seeds ownership only; transfer is a store write |
| 36 | Presence in Blobs | **Never.** Trigger 4 is the reason for the prohibition, not a consequence of it. A twenty-second fact does not belong in a durable store of any kind |

### Agreements worth recording

These four are unanimous. Do not reopen them.

1. **Netlify Blobs, not Netlify DB.** All six documents, and the same three reasons.
2. **`consistency: "strong"`.** Eventual consistency gives a 60-second window that reads as data loss.
3. **Deploys are the whole bill, not state.** 15 credits for a production deploy against 300 free
   credits is 20 deploys per month. Comment traffic costs about 2 credits per month.
4. **The document must render from `file://` and inside a Claude artifact with no network.** Every
   feature is hidden by default and revealed only by a successful probe. Every network call fails
   silently. This is a hard requirement, not a nice property.

### Open questions that need a ruling from the owner

These are not research gaps. Each is a decision with a cost that is not mine to accept.

1. ~~**The baked history block leaks internal git history to an external viewer.**~~ **ANSWERED
   2026-09-02: accepted.** §2.8 bakes commit subjects and diffs into the built HTML, and a `viewer` from
   outside the organisation reads all of it. The owner accepted this. No stripping, no per-document opt-in, and
   no ticket. Two consequences to keep in view rather than re-litigate: a commit message in this repository
   is published to anybody holding a `viewer` grant on any document built from it, and the same is true of
   the diff body. If a document is ever shared with a customer, that is the moment to check what the last
   few commit subjects say.
2. ~~**Ably is the repository's first external service dependency and first secret.**~~ **ANSWERED
   2026-09-02: Ably, free tier.** Accepted, including the external dependency and the secret. The ceiling
   is 200 account-wide concurrent connections, which is about 200 simultaneous readers. Cloudflare Durable
   Objects stays the named migration target for when that binds or when a single authoritative writer for
   each document is wanted. §1.6.
3. ~~**Mode A ownership rests on one site environment variable.**~~ **ANSWERED 2026-09-02: option A,
   the site environment variable.** The connect tool sets `DOC_OWNERS` at site creation, and the address is
   bound to a `sub` on first sign-in. Whoever can deploy the file decides who owns it. Rejected: a
   first-writer-wins claim, which is a land grab; an owner baked into the built file, which is in the
   client's reach; and deriving ownership from the Netlify site account, which ties document identity to
   Netlify accounts rather than the addresses everything else uses.

   **The environment variable only seeds ownership.** Once an address is bound, `ownerSub` lives in
   `access/<docId>/doc.json` and transfer is one write, so the variable is not a standing dependency and
   nobody needs Netlify access to hand a document over. **Two consequences to accept with it:** the person
   who runs the connect tool can name themselves owner of a document they merely deployed, and correcting a
   wrong address before first sign-in means editing the variable. A one-time claim code was considered as a
   follow-on for the case where the deployer is not the owner; it is not built now, and it is recorded in
   section 5 as not being built.

### Open questions that block nothing but must be checked

1. Does `import { getUser } from '@netlify/identity'` resolve inside a Deno edge function? Smoke-test it
   in P2-A. Fallback: a version 2 function with `config.path`.
2. Does `list()` honour a store-level `consistency: "strong"`? Do not depend on it. Render a new record
   from the POST response.
3. Does invite-only registration also block account creation through an external provider? The email
   domain check in `identify()` covers the gap.
4. What is the Netlify DB storage rate after 1 July 2026? Only relevant if a trigger in section 1.1
   fires.
5. Is there a per-account Blobs storage quota, and a Blobs rate limit? Neither is published. Confirm
   before storing anything large.
6. Does a build skipped by `[build] ignore` spend deploy credits? Treat the credit arithmetic as the
   pessimistic case.
