# Suggestions and the editing model

Research for the `archon` documentation platform. Written 2026-09-02. Feature area: two kinds
of proposed change to a block of text — a **suggestion**, which needs acceptance, and an **edit**, which is
applied by a person who may apply it.

**This document is subordinate to `00-integration-plan.md`.** Where the plan rules, the plan wins. Where
this document must change the plan, section 16 names the exact section to edit. It does not edit the plan.

Language: ASD-STE100 Simplified Technical English. "Must" is a requirement. "Do not" is a prohibition.

---

## 1. The recommendation in one page

**Build one proposal mechanism with two entry points and one apply path.**

- A **suggestion** is a proposal that waits for a decision. Any member may write one.
- An **edit** is a proposal that is applied at the moment it is written. Only a **decider** may write one in
  Mode A. In Mode B any member may write one, because the pull request is the review gate.
- **Acceptance promotes a suggestion into an edit.** It runs the same apply path. It is not a second path.

**The five rulings that matter.**

1. **Authority comes from `doc.json`, not from a role.** `doc.json` gains `owner` (one email) and `editors`
   (a list of emails). The build copies both into the edit manifest. A person is a decider when
   `canEdit` is true **and** the email is the owner or is in `editors`. Section 1.2 of the plan rejects an
   `editor` role in Netlify Identity. This adds no role. It adds two fields to a committed file. See
   section 3.

2. **State is carried by which key exists, never by a field.** An open suggestion is a blob under
   `suggest/`. An applied change is the receipt under `edits/`. A rejected, withdrawn or superseded
   suggestion is a deleted blob plus one append-only event. There is no `status` field, so a suggestion
   record is immutable and needs no compare-and-swap. Section 1.1 of the plan says there is one mutable
   blob shape, a thread. That statement stays true. See section 5.

3. **The proposal layer fans out. The applied layer does not.** The new key is
   `suggest/<docId>/<aid>/<sugId>.json`, so ten people may suggest a change to one block and none
   overwrites another. `edits/<docId>/<aid>.json` keeps one blob for each anchor, because an applied edit
   replaces the whole text of the block, and two applied edits on one block are a genuine conflict. This
   is a change to section 2.5 of the plan. See section 5.2.

4. **Conflict detection is the block hash from section 3.4. There is no second mechanism.** This document
   adds one definition the plan needs: the **effective base** of a block is the applied overlay receipt
   when one exists, and the manifest hash when one does not. Every proposal records the effective base it
   was written against. See section 6.

5. **A suggestion is not a comment thread.** It reuses the comment panel, the margin rail and the
   `data-aid` anchor. It does not reuse the thread record. A thread is mutable and is written through
   `mutate()`. An acceptance must be atomic with a git write, and a suggestion has a `baseHash` life cycle
   that a thread does not have. See section 14, alternative 7.

**Why this feature is not optional.** Section 1.4 of the plan says plainly that in Mode A "the overlay *is*
the document, and nobody reviews it". Acceptance is the only review gate Mode A can have. So suggestions
matter more in Mode A than in Mode B, not less.

**Weight.** One new library module on the server (`authority.mjs`), one extracted module
(`gitedit.mjs`), two new functions, and about 200 lines added to `edit.js`. No new npm package. No new
placeholder in `layout.html`.

---

## 2. What the requirement is, and what it changes

The product owner wrote: "inline editing should allow standard 'Suggestion' vs 'edit' where the owner or an
editor email can turn a suggestion into an edit."

Three things follow.

| The requirement | What the plan says today | What must change |
|---|---|---|
| Two kinds of proposed change | One kind. Every member proposes an edit, and the pull request reviews it | A second kind, and a decision step inside the platform |
| An owner or an editor email decides | Section 1.2: two roles, `member` and `guest`, and no `editor` role | Authority moves to `doc.json`, which is committed. No new role |
| Acceptance turns a suggestion into an edit | Section 2.4: "Acceptance and rejection happen in a pull request, not in this platform" | Acceptance happens in this platform. Section 2.4 must regain `suggest.accept` and `suggest.reject` |

**The one sentence that is now wrong.** Section 2.4 of the plan says `edit.accept` and `edit.reject` reduce
to one kind, because acceptance happens in a pull request. That was correct when every proposal became a
pull request. A suggestion does not become a pull request until somebody accepts it, so the decision is an
act inside the platform and it must be in the audit trail.

**What does not change.** The overlay mechanism of section 1.4. The `data-aid` anchor of section 3.2. The
text-quote resolution of section 3.3. The editable policy of section 3.4. The three conflict checks of
section 3.4. The store, the consistency setting and the concurrency rule of section 1.1. The identity
contract of section 1.2. The document key of section 1.3.

---

## 3. The authority model — who may decide

### 3.1 The ruling

**A decider is named by the document, not by the identity provider.**

```json
{
  "id": "k7m2q4",
  "slug": "example",
  "aliases": [],
  "owner": "owner@example.com",
  "editors": ["ada@example.com", "grace@example.com"]
}
```

- `owner` is one email. It must be present. It cannot be empty.
- `editors` is a list of lowercase emails. It may be empty.
- The build copies `owner` and `editors` into `<instance>/dist/<instance>.edit.json`. The function reads
  them from the manifest, which is already the only source of a file path. One read gives the path and the
  authority together.
- Compare emails in lower case. Trim white space at build time, not at request time.

### 3.2 The test the server applies

```js
// netlify/lib/authority.mjs
export function isDecider(session, manifest) {
  if (!session || session.canEdit !== true) return false;      // a guest is never a decider
  const e = session.email.toLowerCase();
  return e === manifest.owner || manifest.editors.includes(e);
}
```

**`canEdit` is a precondition.** A guest email in `editors` gains nothing. Without this rule the committed
file becomes a way to raise a guest above the identity model, and section 1.2 does not permit that.

### 3.3 Why this does not add the role section 1.2 rejected

Section 1.2 gives one reason to reject an `editor` role: "A second role means a second list to maintain."
The reason is about a list in Netlify Identity, which nobody reviews and which lives outside the
repository. `doc.json` is different in four ways.

| | An Identity role | `doc.json` |
|---|---|---|
| Where it lives | The identity provider | The document |
| Who can see it | A team owner in the Netlify user interface | Every reader of the repository |
| How it changes | A click, with no record | A commit, with a diff and a reviewer |
| Scope | Every document at once | One document |

The last row is the one that decides it. Authority over one document is not authority over another. A role cannot express that. A field on the document can.

### 3.4 What no endpoint may do

**No endpoint ever writes `owner` or `editors`.** There is no "add an editor" API and no user interface for
it. In Mode B the change is a commit against `doc.json`, and the pull request reviews it. In Mode A the
change is a rebuild and a re-upload by the owner.

This is a property, not a limitation. The authority list cannot be changed from a browser, so a stolen
session cannot raise itself to a decider.

### 3.5 The permission matrix

| Act | Guest | Member | Decider | Notes |
|---|---|---|---|---|
| Read the document | Yes, in scope | Yes | Yes | Section 1.2 |
| Comment | No | Yes | Yes | Section 1.2 |
| Write a suggestion | No | Yes | Yes | Needs `canEdit` |
| Withdraw a suggestion | No | Own only | Own only | A decider rejects instead |
| Accept a suggestion | No | No | Yes | Section 4 |
| Reject a suggestion | No | No | Yes | Section 4 |
| Write a direct edit, Mode B | No | Yes | Yes | The pull request is the gate. Section 1.2 stands |
| Write a direct edit, Mode A | No | **No** | Yes | There is no gate. Section 1.4 gives the reason |
| Promote the overlay to a source | No | No | Owner only | Section 8.3 |

**The one tightening.** In Mode A a member who is not a decider must not write a direct edit. The overlay is
the document, so a direct edit publishes with no review. Section 1.4 states this cost and accepts it for the
owner. It must not be extended to every member.

**The default button.** In both modes the primary control is **Suggest**. A decider also sees **Edit**. In
Mode B a member also sees **Edit**, as a secondary control. Suggest is the default because it costs nothing
to withdraw, it opens no branch, and it does not spend a reviewer's attention on a change that may be
refused.

---

## 4. The state machine

### 4.1 The states

| State | Stored as | Computed? | Terminal? |
|---|---|---|---|
| `open` | `suggest/<docId>/<aid>/<sugId>.json` exists, and its `baseHash` equals the effective base | No | No |
| `superseded` | The same blob, and its `baseHash` does not equal the effective base | **Yes, at read time** | Yes |
| `applied` | `edits/<docId>/<aid>.json` exists and names the suggestion | No | No |
| `rejected` | No blob. One `suggest.reject` event | — | Yes |
| `withdrawn` | No blob. One `suggest.withdraw` event | — | Yes |
| `expired` | No receipt. The deploy changed the block hash | — | Yes |

**There is no `status` field on any record.** The plan already applies this idea to the anchor: section 2.2
says "Anchor state is never stored", because a stored state goes stale on the next rebuild. A proposal state
has the same defect. `superseded` depends on the current build, so it must be computed, exactly like
`drifted`.

The consequence is worth stating on its own. **A suggestion record is immutable after it is written.** Write
it with `onlyIfNew: true`, which is the rule section 1.1 gives for an append-only key. Nothing ever
compare-and-swaps a suggestion. Section 1.1's sentence "There is one mutable blob shape: a thread" stays
true after this feature lands.

### 4.2 Every transition

| # | From | To | Trigger | Who may | What is written, in order |
|---|---|---|---|---|---|
| T1 | — | `open` | Propose a suggestion | Member or decider | 1. The suggestion blob. 2. `suggest.create` |
| T2 | — | `applied` | Propose a direct edit | Mode B: member or decider. Mode A: decider | 1. The git commit (Mode B only). 2. The receipt. 3. `edit.propose` (Mode B) or `edit.apply` (Mode A) |
| T3 | `open` | `applied` | Accept | Decider | 1. The git commit (Mode B only). 2. The receipt. 3. Delete the suggestion blob. 4. `suggest.accept` |
| T4 | `open` | `rejected` | Reject, with an optional reason | Decider | 1. `suggest.reject`, holding the text and the reason. 2. Delete the suggestion blob |
| T5 | `open` | `withdrawn` | Withdraw | The author only | 1. `suggest.withdraw`. 2. Delete the suggestion blob |
| T6 | `open` | `superseded` | The effective base changed | Nobody. The server computes it | Nothing at the moment of the change. See T7 |
| T7 | `superseded` | Gone | The reaper, 14 days after `at` | Nobody. `GET /api/suggestions` does it | 1. `suggest.supersede`, with the system actor. 2. Delete the blob |
| T8 | `superseded` | `open` | **Not permitted.** Re-propose instead | — | A new suggestion, through T1 |
| T9 | `applied` | `expired` | The deploy landed and the block hash changed | Nobody. `GET /api/pending` drops it | Nothing. Section 3.4 of the plan already rules this |
| T10 | `applied` | Anything | **Not permitted.** There is no un-apply | — | See 4.4 |

### 4.3 The two transitions that need a word

**T3, accept.** The order of the four writes is load-bearing, and section 1.1 gives the rule that decides
it: "A crash between them loses the event, not the comment. That is the correct order." Apply the same test.

- The commit is first, because git is the durable record in Mode B.
- The receipt is second, because the receipt is what a reader sees. A crash after the receipt leaves the
  suggestion visible next to its own pending overlay for a few seconds. That reads as a duplicate. A crash
  in the other order would leave no overlay and no suggestion, and that reads as data loss. Choose the
  duplicate.
- The delete is third.
- The event is last, because an audit line is the cheapest thing to lose.

**Accept must be safe to retry.** A crash after the commit leaves the suggestion `open` and the commit
landed. A retry must not commit twice. So the commit message carries a trailer:

```
X-Suggestion-Id: s_m8x2k1_4f7a9c31
```

`gitedit.mjs` reads the message of the branch head, which it already fetches for check 2. If the trailer
matches, it skips the commit and continues at the receipt. This is one comparison against a value it
already holds.

**T5, withdraw, is the author's act only.** A decider who wants an open suggestion gone must reject it, so
that the event names a decider and holds a reason. A decider must not be able to remove somebody else's
proposal with no record.

### 4.4 Why there is no un-apply

An applied change is reverted the way any change to this repository is reverted.

- Mode B: close the pull request, or merge and then `git revert`. Section 5 of the plan already rules that
  "Restoring a version is `git revert`, run by a writer."
- Mode A: write a new edit with the old text.

An "un-apply" button would need to know whether the pull request had merged, whether the deploy had landed,
and whether a later edit had replaced the same block. That is three states of the world that the platform
does not track. Do not build it.

### 4.5 The state machine, drawn

```
  T1  propose a suggestion  (a member or a decider)
        └──►  OPEN

  T5  withdraw  (the author)          OPEN ──►  gone,  + suggest.withdraw
  T4  reject    (a decider)           OPEN ──►  gone,  + suggest.reject
  T3  accept    (a decider)           OPEN ──►  APPLIED
  T6  the base changed  (computed)    OPEN ──►  SUPERSEDED
  T7  14 days later  (the reaper)     SUPERSEDED ──►  gone,  + suggest.supersede
  T8  re-propose  (anybody)           SUPERSEDED ──►  a NEW record at OPEN, on the new base

  T2  propose a direct edit  (a decider always; a member in Mode B too)
        └──►  APPLIED

  T9  the deploy changed the block hash
        APPLIED ──►  gone.  The receipt cleans itself. Section 3.4 of the plan

  T10 there is no other arrow out of APPLIED. Section 4.4
```

---

## 5. The data model

### 5.1 The change to section 2.5, said plainly

**Section 2.5 of the plan is not sufficient and must change.** It defines a pending edit at
`edits/<docId>/<aid>.json`, one blob for each anchor. A suggestion breaks it, because several people may
suggest a change to one block at the same time, and one blob for each anchor means the second writer
overwrites the first.

The fix is not to make that blob mutable and hold an array in it. Section 1.1 forbids that: "Never a shared
mutable array in one blob." The fix is a deeper key.

### 5.2 The key layout

```
store "doc-state"                              consistency: "strong", site-wide

  threads/<docId>/<threadId>.json              unchanged. Mutable. CAS on write
  events/<docId>/<YYYY-MM>/<eventId>.json      unchanged. Append only
  edits/<docId>/<aid>.json                     unchanged shape, two new fields. ONE for each anchor
  suggest/<docId>/<aid>/<sugId>.json           NEW. One open suggestion. Immutable. onlyIfNew
```

**Why the two layers have different shapes.** They answer different questions.

| | `suggest/` | `edits/` |
|---|---|---|
| How many for one `aid` | Up to five | Exactly one |
| Mutable | No | No. Replaced whole |
| Write mode | `onlyIfNew: true` | `setJSON` after check 2 passes |
| Life ends when | A decider decides, or the base changes | The deploy changes the block hash |
| Two writers at once | Both land. Neither is lost | The second gets 409 |

The second column is the case section 1.1 confirmed in review: "an inline edit replaces the whole text of
one block, so two simultaneous edits to one block are a genuine conflict and the second writer must be
told... Do not 'fix' the same-block case by merging text." That ruling is about the **applied** layer, and
it stays. The **proposal** layer is not a conflict at all. Ten people may want ten different sentences, and
a decider chooses one.

**Key length.** `suggest/k7m2q4/a3f19c2b/s_m8x2k1_4f7a9c31.json` is 48 bytes. The limit is 600 bytes.

**Listing.** `list({ prefix: "suggest/<docId>/" })` returns every open suggestion in a document, in
creation order, because `<sugId>` starts with a base-36 timestamp. This is one `list()` and N parallel
`get()` calls, which is the same pattern and the same cost the plan already accepts for threads. No new
query shape is needed, so no trigger in section 1.1 fires.

### 5.3 The suggestion record

```json
{
  "v": 1,
  "id": "s_m8x2k1_4f7a9c31",
  "docId": "k7m2q4",
  "aid": "a3f19c2b",
  "section": "architecture",
  "text": "The cache key covers **every** declared input and nothing else.",
  "note": "This order matches the diagram above.",
  "by": { "sub": "u_931", "name": "the owner W", "email": "owner@example.com" },
  "at": "2026-09-02T12:04:11.201Z",
  "baseHash": "9c1f...",
  "baseText": "The cache key covers every declared input and nothing else.",
  "docVersion": "7aaca51"
}
```

| Field | Note |
|---|---|
| `id` | `s_${Date.now().toString(36)}_${crypto.randomUUID().slice(0,8)}`. The same convention as a thread id in section 2.3, so keys sort by creation time |
| `aid` | The `data-aid` of the block. The same anchor as a comment. Section 3.2 of the plan |
| `section` | Redundant with `aid`, and kept for the same reason section 2.3 keeps it: it survives the block's death and puts a dead suggestion in the right part of the panel |
| `text` | The proposed text, in the three-mark inline format of section 6 of document 05. Maximum **4000** characters. That is the plan's limit for an edit, ruling 26 |
| `note` | Why. Maximum **280** characters. Optional. A longer argument belongs in a comment thread |
| `by` | The actor shape of section 2.1. Set on the server from `identify()`. A client-supplied author is an impersonation bug |
| `baseHash` | The effective base at the moment the suggestion was written. See section 6.1 |
| `baseText` | The text the author was looking at. It is displayed in the panel next to the proposal. It is never used for a comparison |
| `docVersion` | The `head` short SHA from the baked history block, as in section 2.3 |

**No `status`, no `state`, no `resolvedBy`.** Section 4.1 gives the reason.

**`baseText` is display only.** A comparison must use `baseHash`, because the hash is over the block inner
HTML as built, and `baseText` is the reader's plain-text view of it. Two different normalisations must never
meet in a conflict check.

### 5.4 The change to the receipt in section 2.5

```json
{
  "v": 1,
  "aid": "a3f19c2b",
  "text": "The cache key covers **every** declared input and nothing else.",
  "by": { "sub": "u_931", "name": "the owner W", "email": "owner@example.com" },
  "at": "2026-09-02T12:11:03.884Z",
  "baseHash": "9c1f...",
  "pr": 412,

  "via": "suggestion",
  "sugId": "s_m8x2k1_4f7a9c31",
  "acceptedBy": { "sub": "u_402", "name": "Ada L", "email": "ada@example.com" },
  "acceptedAt": "2026-09-02T12:11:03.884Z"
}
```

Four fields are added. `via` is `"edit"` or `"suggestion"`. The other three are present only when `via` is
`"suggestion"`.

- `by` stays the author of the **text**. It is not the person who pressed accept.
- `acceptedBy` is the decider.
- `pr` is `null` in Mode A.

The pending marker on the page then reads "Proposed by the owner W. Accepted by Ada L." That sentence is the
whole reason these fields exist.

### 5.5 Caps

| Cap | Value | Why |
|---|---|---|
| `text` | 4000 characters | Ruling 26 of the plan |
| `note` and `reason` | 280 characters | A long argument is a comment, not a note on a proposal |
| Open suggestions on one block | **5** | The sixth returns 409 with "Decide the open suggestions first". A block with six competing rewrites is a discussion. Start a thread |
| Open suggestions in one document | None | The per-block cap bounds the render. A document-wide cap would need a count, and section 1.1 says "No count without a read" |

The per-block cap is free to apply. The create handler already lists the block's prefix to compute the
effective base, so it holds the count.

---

## 6. Conflict, staleness and every failure state

**This section adds no new detection mechanism.** Section 3.4 of the plan already rules that the block hash
is the detector, because "It detects a change made by anybody through any path, including a writer's
commit." Suggestions reuse it. They need one definition on top of it.

### 6.1 The effective base

> **The effective base of a block is the text and hash of the applied overlay receipt when a receipt
> exists, and the manifest hash when no receipt exists.**

This definition is needed because a block may already carry a pending applied edit. Without it, two readers
disagree about what "current" means: the manifest says one thing and the receipt says another. Every write
path must use one answer.

```js
async function effectiveBase(store, docId, aid, manifest) {
  const r = await store.get(`edits/${docId}/${aid}`, { type: "json", consistency: "strong" });
  if (r && r.baseHash === manifest.blocks[aid].hash) {
    return { hash: sha256(toHtml(r.text)), text: r.text, pending: true };
  }
  return { hash: manifest.blocks[aid].hash, text: manifest.blocks[aid].text, pending: false };
}
```

The test `r.baseHash === manifest.blocks[aid].hash` is the same expiry test that `/api/pending` applies in
P3-E. A receipt that failed it is already gone, so it must not become a base.

**The plan needs this definition too.** Section 3.4 says check 2 reads "the section file at the branch
head", which is correct for Mode B but says nothing about Mode A and nothing about a block that already has
a pending receipt. See section 16.

### 6.2 The three checks, applied to each act

| Act | Check 1, manifest commit | Check 2, block hash | Check 3, GitHub blob SHA |
|---|---|---|---|
| Write a suggestion | A hint. Record `docVersion` | **Yes.** Compare the client's claimed base against the effective base. A mismatch returns 409 with the current text | Not applicable. Nothing is written to git |
| Accept | A hint | **Yes.** Compare the suggestion's stored `baseHash` against the effective base | Mode B only. One retry from check 2 |
| Reject, withdraw | Skipped | **Skipped.** A decision on a stale proposal is still a valid decision | Not applicable |
| Direct edit | A hint | **Yes**, as section 3.4 rules today | Mode B only |

**Reject and withdraw skip check 2 on purpose.** If a stale suggestion could not be rejected, a superseded
proposal would be undecidable and would sit in the panel until the reaper removed it. A decider must always
be able to say no.

### 6.3 Every failure state

| # | Failure | How it is detected | What the reader sees | What the server does |
|---|---|---|---|---|
| F1 | The block text changed after the suggestion was written | Check 2 at read time and at accept time | "The text changed under this suggestion", with the proposal still readable and a **Re-propose** button | `superseded`. Reaped after 14 days |
| F2 | Two deciders accept two different suggestions on one block | The second accept fails check 2, or check 3 returns 409 from GitHub | The loser is told "Another change to this block landed first", and its suggestion becomes `superseded` in the same response | 409 with the current text. No merge, ever |
| F3 | A decider accepts a suggestion while a direct edit is pending on the same block | The receipt is the effective base, so check 2 fails | The same as F2 | 409 |
| F4 | The block is no longer `data-editable`, because a rebuild demoted it | The block hash necessarily changed, so check 2 fails | The same as F1 | `superseded`. **No second rule is needed.** This is why the hash is the detector and not a capability flag |
| F5 | The block was deleted. The `aid` is gone from the manifest | `manifest.blocks[aid]` is undefined. Treat an absent `aid` as a hash mismatch | "The paragraph this suggestion belonged to is gone", with the proposed text as a blockquote. This matches the `orphaned` treatment of section 3.3 | `superseded`. Reaped after 14 days |
| F6 | The author left the organisation and has no session | Not detected, and not checked | Nothing | Nothing. **A suggestion stays acceptable.** It is text, not a permission. The `by` field keeps the authorship |
| F7 | The author lost `canEdit` but still has a session | The withdraw handler tests `session.sub === record.by.sub` only | The author may still withdraw | A withdraw needs ownership, not `canEdit` |
| F8 | GitHub is unreachable at accept time | The fetch fails | "Could not reach the repository. Try again" | 502. **Nothing is written.** The suggestion stays `open` |
| F9 | A crash between the commit and the receipt | The next accept reads the `X-Suggestion-Id` trailer on the branch head | Nothing. The retry succeeds | Skip the commit. Continue at the receipt |
| F10 | A crash between the receipt and the delete | Not detected | The pending overlay **and** the open suggestion, together, for a few seconds | The next accept, reject or withdraw removes the blob. A duplicate render is the correct thing to lose. Section 4.3 |
| F11 | A crash before the event is written | Not detected | Nothing | The audit line is lost. Section 1.1 rules that this is the correct thing to lose |
| F12 | The sixth suggestion on one block | The create handler counts the prefix | "Decide the open suggestions first" | 409 |
| F13 | The proposed text fails the round-trip gate | `to_html(to_md(text)) != text` | "This text uses markup the editor cannot represent" | 400. The gate of section 3.4 |
| F14 | A suggestion on a block that has no `data-editable` | The manifest has no row for the `aid`, or the row is marked read-only | "This block cannot be edited. Leave a comment instead" | 403 |
| F15 | A non-decider calls accept | `isDecider()` returns false | The button was never shown. `data-session` is a rendering hint only | 403 |
| F16 | A client-supplied `by`, `acceptedBy` or `email` in the body | Not detected, and not read | Nothing | Every actor field is set from `identify()`. The body fields are ignored, as section 2 of the plan requires |
| F17 | The manifest cannot be read | The read throws | "Editing is not available for this document" | 503. Do not fall back to a client-supplied path. Section 4.6 of the plan |
| F18 | Blobs loses everything | Not detected | Every open suggestion is gone. No published text is lost | Mode B: git holds every accepted change. Mode A: the uploaded file holds every promoted change. An **un-promoted** Mode A overlay is lost. Section 13 |

**F18 is the honest cost of Mode A**, and it is the same cost section 1.4 already names.

---

## 7. Rendering in one self-contained HTML file

The document is one HTML file that must also render from `file://` and inside a Claude artifact with no
network. Agreement 4 of the plan makes that a hard requirement. Everything in this section is behind the
existing guard and is absent in those two environments.

### 7.1 One client module

**`templates/base/edit.js` owns proposing and deciding. Do not add a second module.**

A separate `suggest.js` would duplicate the `contenteditable` capture, the inline-mark converter, the
overlay application and the block lookup. Two modules would also compete for the same block. The plan
already solves this shape of problem by sequencing two tickets on one file: P3-C then P4-A both own
`comments.js`. Do the same here. So **no new placeholder is added to `layout.html`**, and section 4.1 of
the plan does not grow.

### 7.2 One rail, one panel, one owner

`comments.js` owns the margin rail and the right-hand panel. `edit.js` must not create a second rail and
must not create a second panel. Two absolutely positioned rails over one text column would collide, and
section 8.6 of document 04 already builds a declutter loop for one rail.

The two modules talk through **one global namespace object**, created in `layout.html` by the keystone
ticket:

```html
<script>window.doc = { rail: null, panel: null };</script>
```

`comments.js` fills both fields. `edit.js` reads them, and does nothing when they are null.

```js
// published by comments.js
window.doc.rail  = { add(kind, aid, label, onClick), remove(token), place() };
window.doc.panel = { register(kind, renderFn), refresh(), open(aid) };
```

This is one global object and two small interfaces. It is the same shape as the `session` event of section
1.2: one publisher, many listeners, no polling. Four independent modules with four mechanisms is what
section 1.2 refused, and one namespace is the alternative.

### 7.3 Several open suggestions on one block

**Show one chip, not N overlaid texts.**

- The block gets `data-suggest="3"`. One CSS rule draws a left border on the block. This is a block-level
  state, so it must not use `::highlight()`. The Custom Highlight API belongs to the passage-level comment
  highlight, and two overlapping registries on one range read as mud.
- The rail gets **one** marker for the block, with the count: "3 suggestions". Not three markers.
- A click opens the panel, filtered to that block.
- The panel then shows one card for each suggestion, in creation order. Each card holds: the author, the
  time, the note, the current text, the proposed text, and the controls the viewer may use.

**Do not diff the two texts.** Show the current text and the proposed text in full, one above the other,
with the current one collapsed by default. Blocks in this repository are one to three sentences under the
sentence-per-line convention, so the reader compares two short paragraphs by eye. Section 5 of the plan
already refuses a JavaScript diff library. A hand-written word-level diff is the same dependency in
disguise. See section 14, alternative 6.

**Accept is the only exclusive act.** When a decider accepts one card, the other cards on that block become
`superseded` on the next read. The panel does not remove them. It marks them and offers **Re-propose**.

### 7.4 Coexistence with comment threads on the same block

| Question | The ruling |
|---|---|
| Who owns the rail? | `comments.js`. `edit.js` registers a marker through `window.doc.rail` |
| Who owns the panel? | `comments.js`. `edit.js` registers a card renderer through `window.doc.panel.register("suggestion", fn)` |
| Two markers on one line? | No. The rail declutter loop of section 8.6 of document 04 already pushes them apart by 24 px. A comment marker and a suggestion marker are two markers |
| Order inside the panel, for one block | Comment threads first, then suggestions. A comment is often the argument for a suggestion, so it must be readable above it |
| Filter chips | The filter row of section 8.7 of document 04 gains one chip: **Suggestions**. The row becomes Open / Resolved / All, and Anchored / Discussion / Suggestions |
| Does an open suggestion highlight a passage? | No. It draws a border on the block. A suggestion is about the whole block |
| Does an accepted, pending change break a comment highlight? | **Yes, unless the order is fixed.** See 7.5 |
| Can a reader suggest a change to a table cell or a code block? | No. The editable policy of section 3.4 allows `p`, `h2`, `h3` and `h4` only. On any other block the panel offers a comment instead. **One policy, not a wider one for suggestions** |

### 7.5 The load order, which is a correctness requirement

`edit.js` replaces the inner HTML of a block when it applies the pending overlay. `comments.js` holds live
`Range` objects inside that block, in a `Highlight` registry. Replacing the inner HTML destroys those
ranges and the highlight silently disappears or lands on the wrong characters.

**Two rules, and both are requirements.**

1. `edit.js` must apply the overlay **before** `comments.js` resolves any anchor.
2. When `edit.js` changes a block after the first paint, it must dispatch one event, and `comments.js` must
   re-resolve the anchors of the named blocks and repaint.

```js
document.dispatchEvent(new CustomEvent("doc:overlay", { detail: { aids: ["a3f19c2b"] } }));
```

The name matches the `doc:event` bus convention that `07-realtime-and-presence.md` gives `realtime.js`.
This event is the **in-page** signal, and it fires whether or not a transport exists, because the reader's
own save changes a block with no network event involved. The wire-side equivalent is `edit.saved`, which
document 07 already defines. See section 11.2.

The plan does not describe this coupling, and it is the same class of failure that made section 4.5 forbid
`<mark>` wrappers: a DOM mutation that invalidates another module's anchor resolution. See section 16.

### 7.6 The three environments

| | Hosted on Netlify | Claude artifact | Plain file (`file://`) |
|---|---|---|---|
| Document renders | Yes | Yes | Yes |
| `data-aid` present | Yes | Yes | Yes |
| `data-editable` present | Yes | Yes | Yes |
| Suggestion chip, rail marker, panel card | Full | **Absent** | **Absent** |
| Suggestion counts baked into the file | **No** | No | No |

Counts are not baked in. Section 4.2 of the plan rejects `--with-comments` for the same reason: a `dist/`
that depends on the network breaks the byte-for-byte CI staleness check and the artifact parity contract.
A suggestion count is more volatile than a comment count, so the argument is stronger, not weaker.

---

## 8. Acceptance and the two deployment modes

Section 1.4 of the plan gives two modes and one overlay mechanism. Acceptance means a different thing in
each, and the difference must be stated in the user interface, not hidden.

### 8.1 What "accepted" means

| | Mode A — standalone file | Mode B — repo-backed |
|---|---|---|
| Can a suggestion be accepted? | **Yes.** See 8.2 | Yes |
| What acceptance writes | The overlay receipt only | A git commit on the author's branch, a pull request, and the overlay receipt |
| Is the change live at once? | **Yes.** The overlay is the document | No. The page shows it as "pending review" |
| Who reviews it after acceptance | **Nobody.** Acceptance is the review | The pull request reviewer |
| Number of gates | One: the decider | Two: the decider, then the pull request |
| How the receipt expires | The owner promotes, rewrites the file, and re-uploads. The new manifest has a new hash | The pull request merges and Netlify rebuilds. The new manifest has a new hash |
| Which conflict checks run | Check 2 only, against the effective base | All three, as section 3.4 rules |
| Where the durable text ends up | The promoted file, when the owner promotes | `sections/*.html`, when the pull request merges |

**One expiry mechanism, two triggers.** Section 3.4's self-cleaning receipt needs no change for Mode A. The
receipt drops when the deployed manifest no longer carries its `baseHash`, and a re-upload produces a new
manifest exactly as a rebuild does.

### 8.2 Can a suggestion be accepted in Mode A? Yes, and it is the point

Mode A has no pull request, so it has no review gate. Section 1.4 says so: "In Mode A the overlay *is* the
document, and nobody reviews it. That is the price of having no repository."

Acceptance is a gate that costs no repository. So in Mode A:

- A member who is not a decider **must not** write a direct edit. Section 3.5.
- Every proposal from such a member is a suggestion.
- The owner or an editor decides.
- Acceptance publishes at once, and the audit trail is the event log.

This inverts the intuition that suggestions are the weaker feature. In Mode B a suggestion saves a reviewer
some time. In Mode A a suggestion is the only reason the document is not open to anybody who signs in.

### 8.3 Mode B, in detail

- The branch keys on the **author of the text**, not on the person who accepted it:
  `docedit/<docId>/<authorSub>`. So accepting the owner's suggestion adds a commit to the owner's branch for that
  document. P4-B already rules "one pull request per reader per document"; this keeps that rule and reads
  "reader" as the author of the words.
- A decider who accepts three suggestions from three people therefore touches three branches and three
  pull requests. That is correct. Three people's words are three reviewable units with three authors.
- Check 2 reads the section file at the branch head when the branch exists, and at the head of `main` when
  it does not. That is what P4-B already does.
- The pull request body names both people: "Proposed by the owner W. Accepted by Ada L."

**Acceptance must not merge the pull request.** See section 14, alternative 4.

### 8.4 Mode A, in detail

- There is no commit and no pull request. Accept writes the receipt and the event.
- Check 3 does not exist. Check 1 is still a hint, because the uploaded file carries a manifest commit.
- Promotion is the owner's act, and section 1.4 makes it the owner's choice. It rewrites the standalone
  source and re-uploads.
- **Promotion must carry the attribution.** See section 9.3.

---

## 9. Authorship and the audit trail

### 9.1 Does an accepted suggestion keep its authorship? Yes, in four places

| Where | What it holds | How long it lasts |
|---|---|---|
| The git commit, Mode B | `author` is the suggester. `committer` is the bot. A `Co-authored-by:` trailer, and a body line "Accepted by \<decider\>" | Forever |
| The pull request body, Mode B | Both names, and a link to the block | Forever |
| The overlay receipt | `by` is the suggester. `acceptedBy` is the decider | Until the deploy expires it |
| The event log | `suggest.create` names the author. `suggest.accept` names the decider and the author | 18 months, unless the retention job excludes it. See 9.3 |

Section 9 of document 05 already rules on the commit shape, and it stays. Its one caveat also stays: GitHub
links a commit to a profile only when the author email is verified on that account, so a work email that is
not on the reader's GitHub account gives an unlinked author with a grey avatar. The commit is still correct.

**The decider never becomes the author of the words.** `by` is written once, at T1, from the suggester's
session. No handler rewrites it.

### 9.2 The events

Section 2.4 of the plan lists the `kind` values. Five are added and one is added for Mode A.

| `kind` | When | `actor` | Extra in `target` |
|---|---|---|---|
| `suggest.create` | T1 | The author | `aid`, `sugId` |
| `suggest.accept` | T3 | The decider | `aid`, `sugId`, `author`, `pr` |
| `suggest.reject` | T4 | The decider | `aid`, `sugId`, `author`, `reason`, `text` |
| `suggest.withdraw` | T5 | The author | `aid`, `sugId` |
| `suggest.supersede` | T7 | The **system actor** | `aid`, `sugId`, `author` |
| `edit.apply` | T2, Mode A only | The decider | `aid` |
| `edit.propose` | T2, Mode B. Unchanged | The member | `aid`, `pr` |

Two things need a word.

**`suggest.reject` holds the rejected text and the reason.** The record is deleted at the same moment, so
the event is the only place the text survives. A rejection with no text is not an audit line; it is a
rumour. The cost is at most 4280 characters in one append-only blob.

**`suggest.supersede` is written by a system actor.** Section 2.1 requires every actor field to be set on
the server from `identify()`. A system actor is set on the server, so this does not break the rule:

```json
{ "sub": "system", "name": "Build", "email": "" }
```

The alternative is a suggestion that vanishes with no trace, and an audit trail with silent deletions is not
an audit trail.

### 9.3 The gap the retention job creates, and the fix

P4-F deletes events older than 18 months. In Mode B that is harmless, because git holds the authorship
forever. In Mode A the event log is the **only** durable record of who wrote an accepted sentence. After 18
months it is gone.

**Two fixes, and take both.**

1. **P4-F must not delete `suggest.accept`, `suggest.reject` or `edit.apply`.** Retention exists to bound
   the changelog, and a decision is not changelog noise. The exclusion is one condition in the reaper.
2. **Promotion in Mode A must write the attribution into `history.json`.** Section 2.8 defines
   `<instance>/history.json` with a `versions[]` array, each version holding an `author` and a `subject`.
   In Mode B the file is generated from git. In Mode A there is no git, so the promotion step is what fills
   it: one `versions[]` row for each promotion, holding the accepted changes and their authors.

   The reader then sees an accepted suggestion in the changelog the platform already renders, credited to
   the person who wrote it. This reuses an existing file and an existing client (P3-D). It adds no new
   shape.

---

## 10. The interaction with anchoring

Section 3.2 of the plan defines `exact`, `drifted`, `moved` and `orphaned`. This document applies them. It
does not redefine them.

### 10.1 What an accepted suggestion does to the block

An accepted suggestion changes the text of one block. It cannot add a block and it cannot remove one,
because the edit format is inline text only. Section 3.4 already states this: "It cannot add or remove a
block, so `data-aid` stays valid for the whole life of the pending edit."

So the `aid` survives while the change is pending. At the next rebuild, `anchors.rs` sees the block as
`replace` and applies the 0.6 similarity floor of section 3.2:

| The size of the change | Alignment opcode | The `aid` | The result |
|---|---|---|---|
| A word or a clause | `replace`, similarity above 0.6 | Carried | Nothing is orphaned |
| A rewrite of the whole sentence | `replace`, similarity below 0.6 | **Orphaned** | Every comment thread on that block goes to `orphaned` or `moved` |

**A suggestion can therefore orphan its own comment threads.** That is correct and it must stay visible.

### 10.2 What happens to comments on the block

| The state of the change | Comments on the block | Why |
|---|---|---|
| A suggestion is open | Unchanged. `exact` | Nothing in the document changed. A suggestion is not applied text |
| A change is applied and pending | `exact` if the quoted words survive, `drifted` if they do not | The overlay replaced the block text. Section 3.4 calls this "visible and correct" |
| The change merged and the build ran, similarity above 0.6 | `exact` or `drifted` | The `aid` was carried |
| The change merged and the build ran, similarity below 0.6 | `orphaned`, or `moved` if the quote is found in exactly one other block | Section 3.2. `moved` needs a unique hit |

**A text change never orphans a comment on its own.** The block must die first. This is what makes the
inline edit format safe for the anchor.

### 10.3 What happens to other suggestions on the block

They become `superseded`, by check 2, because the effective base changed. Nothing else happens.

- Do **not** auto-reject them. A decider decided one thing, not four things.
- Do **not** rebase them onto the new text. See section 14, alternative 5.
- Show them with **Re-propose**, which opens a new suggestion pre-filled with the old proposed text and
  bound to the new base.

### 10.4 The warning a reviewer gets, and why Mode B has two gates

Section 3.2 makes the build print an anchor report, and section 2.7 keeps `anchors.json` committed so that
"A reviewer sees anchor churn in the diff, next to the text change that caused it."

That is exactly what happens to an accepted suggestion in Mode B. The pull request diff shows the text
change **and** the `anchors.json` churn, so the reviewer sees the sentence "this rewrite orphans two comment
threads" before the merge.

This is the second reason the pull request gate is not redundant after the decider gate. The decider judges
the words. The pull request shows the collateral damage to the discussion. In Mode A that warning does not
exist, and the owner sees it only in the build report at promotion time.

---

## 11. Realtime: what suggestions need from the transport

`07-realtime-and-presence.md` researches the transport, the presence roster and the advisory editing lock.
This section does not. It states what suggestions need from that transport, and what they do not need. It
reuses document 07's event names where they already cover the case.

### 11.1 The ruling

**Suggestions need less realtime than editing, not more, and they must not be sequenced after the transport
ticket.**

An edit is synchronous. Two people typing in one paragraph want to know about each other in the same second.
A suggestion is asynchronous by design: somebody proposes, and somebody else decides later, possibly on
another day. The natural feedback channel for a decision is not a socket. It is the Slack webhook the plan
already builds in P4-D.

**Nothing in this design is incorrect without a transport. It is only stale.** The correctness comes from
check 2, which returns 409 on any base the client did not have. A stale panel produces a refused action with
a clear message, never a wrong write.

### 11.2 What suggestions need the transport to carry

Three events, and only for the affordance.

| Event | Payload | Why it is wanted | What breaks without it |
|---|---|---|---|
| `suggest.created` | `docId`, `aid`, `sugId`, `by.name` | The chip count on the block changes without a reload | Nothing. The count is stale until the next refresh |
| `suggest.decided` | `docId`, `aid`, `sugId`, `outcome` | A second decider stops offering to accept something already decided. A second browser tab of the same decider agrees with the first | Nothing. The second accept returns 409 |
| `edit.saved` | `aid`, `hash`. **Already defined by document 07** | `edit.js` refetches `/api/pending`, repaints the block, and dispatches `doc:overlay` so `comments.js` re-resolves. Section 7.5 | The comment highlight on that block is wrong until the reader reloads |

**Only the first two are new.** `edit.saved` already exists in the wire protocol of
`07-realtime-and-presence.md`, and it is listed here because section 7.5 makes one of its consequences a
correctness requirement, not a nicety: the receiving client must re-resolve the anchors of the changed
block, not only repaint it.

Delivery is through the `doc:event` `CustomEvent` bus that document 07 gives `realtime.js`. Suggestions add
no second transport and no second bus.

Document 07 also gives `edit.claim` and `edit.release`, an advisory lock on an editable block. **A
suggestion must not claim the lock.** Two people may write suggestions on one block at the same time, and
section 5.2 makes that safe. The lock belongs to the direct-edit path only, where the second writer would
otherwise get a 409.

### 11.3 What suggestions do not need

- No presence. Nobody needs to know who is reading a suggestion.
- No cursors and no typing indicator inside a suggestion draft. A draft is private until it is posted.
- No per-character transport. There is no shared editing session on a proposal.
- No delivery guarantee. Every event is a hint that triggers a refetch, so a lost event costs one stale
  panel.

**The fallback, when no transport exists or the transport is down.** Refresh on `visibilitychange`,
throttled to once per 30 seconds. Section 4.5 of the plan already rules that this is the refresh strategy
for comments. Suggestions use the same one. Do not add a polling loop.

---

## 12. The API

Two functions, in the shape the plan already uses for threads: a list-and-create function, and an act-on-one
function.

| Method and path | What it does | Who | Returns |
|---|---|---|---|
| `GET /api/suggestions?doc=<docId>` | List by prefix. Compute `open` or `superseded` for each. Reap up to 10 records older than 14 days that are `superseded` | Anybody who may read the document | An array, in creation order |
| `POST /api/suggestions` | Create. Body `{ docId, aid, text, note, baseHash }` | `canEdit` | The new record |
| `POST /api/suggestion` | Act. Body `{ docId, sugId, action, reason }`, where `action` is `accept`, `reject` or `withdraw` | See section 3.5 | The receipt on accept. `{ ok: true }` otherwise |
| `POST /api/edit` | Unchanged from P4-B, plus `via: "edit"` on the receipt | See section 3.5 | The receipt |
| `GET /api/pending` | Unchanged from P3-E | Anybody who may read | The overlay map |

Every handler calls `requireOrigin(req)` as its first statement, then `identify(req)`. Section 1.2 of the
plan makes both mandatory.

### 12.1 The one apply path

**There must be exactly one function that applies text to a block.** Extract it:

```js
// netlify/lib/gitedit.mjs
/**
 * The one apply path. Used by /api/edit and by the accept branch of /api/suggestion.
 * Mode A: writes the receipt only. Mode B: commits, opens or updates the PR, then writes the receipt.
 * @returns {Promise<{receipt: object, pr: number|null}>}
 * @throws  {Response} 409 on a base mismatch, 502 on a git failure
 */
export async function applyText({ docId, aid, text, author, acceptedBy, sugId, via, expectBase });
```

If accept and edit each hold their own copy of the branch logic, the hash check and the receipt write, they
will drift, and the drift will show up as a conflict check that one path skips. One module removes the
possibility.

`expectBase` is the effective base hash the caller read. `applyText` re-reads it and compares, so the check
cannot be forgotten by a caller.

### 12.2 Status codes

| Code | When |
|---|---|
| 400 | The shape is wrong, a cap is exceeded, or the round-trip gate fails |
| 401 | No session |
| 403 | Not a decider, not the author, or the block is not editable |
| 404 | Unknown `docId`, `aid` or `sugId` |
| 409 | The base changed, or the block already holds five open suggestions |
| 502 | GitHub is unreachable |
| 503 | The manifest cannot be read |

---

## 13. Limits, and where this breaks

### 13.1 Cost

| Act | Blob reads | Blob writes | Git calls | Notes |
|---|---|---|---|---|
| Render a document with 12 suggestions | 1 `list` + 12 `get` + 1 receipt `get` for each touched block | 0 | 0 | The same pattern and the same order of cost as the 50-thread render document 04 measured at about 200 ms |
| Create a suggestion | 1 `list` on the block prefix + 1 receipt `get` | 2 | 0 | The list gives the per-block cap and the effective base together |
| Accept, Mode B | 2 | 3 | 4 to 6 | The same git call count document 05 measured for an edit |
| Accept, Mode A | 2 | 3 | 0 | Under 100 ms |
| Reject or withdraw | 1 | 2 | 0 | — |

**Deploys are still the whole bill.** Agreement 3 of the plan holds. A decision spends no deploy credit.
Only a merge does. So suggestions **reduce** the deploy bill compared with a world where every member opens
a pull request: a rejected suggestion costs nothing, while a rejected pull request has already cost a
deploy preview.

### 13.2 Where this breaks

- **A block with many competing rewrites.** The cap is five. At five the platform tells people to argue in a
  comment thread instead. That is a product answer, not a technical one, and it may feel arbitrary.
- **A decider who never decides.** An open suggestion has no owner and no deadline. Nothing drains the
  queue. Document 05 named this as the fatal defect of its Model 3: "a queue nobody drains is worse than no
  queue." This design reduces the risk, because the queue is per block and it is visible in the document,
  next to the text it is about. It does not remove the risk. **Mitigation: the Slack webhook fires on
  `suggest.create`, and the header shows a count of open suggestions next to the count of open threads.**
- **Mode A, before promotion.** An accepted suggestion lives only in Blobs. F18. Section 1.4 already accepts
  this and requires the export to be built before the editor.
- **The 18-month retention job.** Section 9.3 gives the fix. Without the fix, Mode A loses its authorship
  record.
- **A person who is a decider on one document and not on another.** This is intended, and it will surprise
  people. The panel must say why the accept button is absent: "Only \<owner\> and 2 editors can accept
  changes to this document."
- **No cross-document view.** "Every suggestion waiting for me" is exactly the query section 1.1 forbids. It
  would cost one `list` per document. If somebody asks for it, that is trigger 1 in section 1.1, and the
  answer is Postgres, not an index in Blobs.
- **`suggest.reject` grows the event store.** A rejection holds up to 4280 characters. A thousand rejections
  is about 4 MB. There is no published Blobs quota, which is open question 5 of the plan.

---

## 14. Rejected alternatives

| # | Alternative | Why it is rejected |
|---|---|---|
| 1 | A `status` field on the suggestion record | It makes the record mutable, so every decision needs `mutate()` and a compare-and-swap, and section 1.1's "There is one mutable blob shape" stops being true. Key existence already carries the state, and `superseded` must be computed anyway |
| 2 | One blob for each block, holding an array of suggestions | Section 1.1: "Never a shared mutable array in one blob." Two suggesters would contend on one key and one proposal would be lost. This is the exact failure the plan rules against |
| 3 | An `editor` role in Netlify Identity | Section 1.2 rejects it, and the reason holds: a role is a second list, in a second system, that nobody reviews. It also cannot be scoped to one document, and authority over one document is the requirement |
| 4 | Acceptance merges the pull request | It gives the accept button repository merge rights, and it removes the review that section 3.4 is built on. It also destroys the one warning a reviewer gets that a rewrite orphans comment threads, which is the `anchors.json` churn in the diff. Section 10.4 |
| 5 | Rebase a superseded suggestion onto the new text | That is a three-way text merge. Section 5 of the plan refuses a conflict-free replicated data type for the same class of problem: "Readers propose a sentence, occasionally, on a block they clicked." Offer **Re-propose** instead, which costs no merge logic and never guesses |
| 6 | A word-level diff of the two texts in the panel | A diff engine on the page. Section 5 already refuses a JavaScript diff library. A hand-written LCS is the same code with no maintainer. Blocks are one to three sentences, so two short paragraphs read fine side by side |
| 7 | Make a suggestion a thread with `kind: "suggestion"` | The most tempting alternative, and document 05 argued for it: "A suggestion is a comment with a proposed replacement string." Reject it for three concrete reasons. **(a)** A thread is mutable and is written through `mutate()`; an accept must order a git write, a receipt write and a delete, and a compare-and-swap loop around that is wrong. **(b)** A suggestion has a `baseHash` life cycle, so it dies when the text moves. A thread must survive the text moving; that is what section 3.3 is for. **(c)** `status` on a thread is `open` or `resolved`, and a proposal needs six states. Reuse the panel and the rail. Do not reuse the record |
| 8 | A second margin rail or a second panel for suggestions | Two absolutely positioned rails over one text column. Section 8.6 of document 04 already builds one declutter loop; a second rail would need to declutter against the first |
| 9 | Keep rejected and withdrawn records in the store | Nothing would ever read them. Section 1.1 forbids a per-user index and a cross-document query, so "my rejected suggestions" has no reader. The event log is the durable trace and it is already append-only |
| 10 | A `::highlight()` range for an open suggestion | A suggestion is about a whole block, not a passage. Two highlight registries on one range read as mud, and the comment highlight is the one that needs the precision |
| 11 | A second client module, `suggest.js`, with its own placeholder | It would duplicate the capture, the converter, the overlay application and the block lookup, and two modules would fight over one block. The plan already sequences two tickets on one file for `comments.js` |
| 12 | Email the author when a suggestion is decided | Section 5 of the plan rules out per-user notification, and the reason holds: subscription state, a provider, a sending domain and DNS records. The Slack webhook covers the real case. **Write down the gap:** an author who never reopens the document does not learn their suggestion was rejected |

---

## 15. Tickets this implies

The plan uses `P<phase>-<letter>`. Phase 1 to 4 already use A to E, A to E, A to E and A to G.

**The letters below avoid the ones `07-realtime-and-presence.md` claims.** That document was written in
parallel with this one and it takes P2-F, P3-F, P3-G, P4-H and P4-I. This document therefore starts at
P3-H and P4-J. **Read the letters as identifiers with no order.** If either document is dropped, renumber
by content, not by letter.

| Ticket | Work | Files it owns | Dependencies |
|---|---|---|---|
| **P1-F** | Add `owner` and `editors` to every `doc.json`. `owner` is required. Validate that every email is lower case and has no white space | `example/doc.json`, `example/doc.json`, `templates/components/doc.json`, `templates/skeleton/doc.json` | **Shares all four files with P1-A. Fold it into P1-A rather than opening a second ticket** |
| **P3-H** | `netlify/lib/authority.mjs`: `isDecider(session, manifest)`. Nothing else. About 10 lines and one test script | `netlify/lib/authority.mjs`, `scripts/check-authority.mjs` | P1-C for the session shape. P2-D for the manifest fields |
| **P4-J** | The one apply path. Move the branch, the hash check, the commit, the pull request and the receipt write out of `edit.mjs` into `gitedit.mjs`. Add the Mode A branch, which writes the receipt only. Add `via`, `sugId`, `acceptedBy` and `acceptedAt` to the receipt. Add the `X-Suggestion-Id` trailer and the idempotency check | `netlify/lib/gitedit.mjs`, `netlify/functions/edit.mjs` | **P4-B, which creates `edit.mjs`. Sequenced after it** |
| **P4-K** | The suggestion API. `GET`/`POST /api/suggestions` and `POST /api/suggestion` with accept, reject and withdraw. The per-block cap, the effective base, the 14-day reaper, and the six event kinds | `netlify/functions/suggestions.mjs`, `netlify/functions/suggestion.mjs` | P2-B, P3-H, P4-J |
| **P4-L** | The client. The Suggest and Edit controls, the draft box, the block chip, the panel card renderer, accept, reject, withdraw and re-propose. The `doc:overlay` event | `templates/base/edit.js`, `templates/base/edit.css` | **P4-B, which owns both files. Sequenced after it.** Also P4-K and P4-M. Also after P4-I of document 07 if that lands, which also owns `edit.js` |
| **P4-M** | The shared surface. `comments.js` publishes `window.doc.rail` and `window.doc.panel`, gains the Suggestions filter chip, and re-resolves the anchors of a block on `doc:overlay` | `templates/base/comments.js`, `templates/base/comments.css` | **P3-C and P4-A, which own both files. Sequenced after P4-A** |
| **P4-N** | Mode A acceptance and promotion. The overlay-only apply path, and a promotion step that writes one `versions[]` row into `history.json` for each promoted change, crediting the suggester | The Mode A connect and export tool named in section 1.4 of the plan, and `example/history.json` on promotion only | P4-J, P4-K, and the two Mode A tickets section 1.4 calls for |
| **P4-O** | Retention. Exclude `suggest.accept`, `suggest.reject` and `edit.apply` from the 18-month delete. Sweep `suggest/` records older than 90 days | `netlify/functions/retention.mjs` | **P4-F, which creates the file. Sequenced after it** |

**Nothing lands in phase 2.** Phase 2 needs one change, not a ticket: **P2-D must copy `owner` and
`editors` from `doc.json` into the edit manifest.** It already writes the manifest, and section 4 of the
plan forbids a second ticket on `editable.rs` in the same phase.

**Nothing lands before P4-B.** Every write path here builds on the edit function. Phase 4 already says
these tickets are "sequenced, not parallel, where they share a file", and four of these eight share a file
with an existing ticket.

### 15.1 Verification

| Ticket | How to verify |
|---|---|
| P3-H | A guest listed in `editors` is not a decider. An email in different case is a decider. An absent `owner` fails the build, not a request |
| P4-J | An edit through `/api/edit` and an accept through `/api/suggestion` produce byte-identical receipts, apart from `via`, `sugId`, `acceptedBy` and `acceptedAt`. Kill the function after the commit and retry: the trailer check prevents a second commit |
| P4-K | Five suggestions on one block all land. The sixth returns 409. Hand-edit the section file and rebuild: every open suggestion on that block reads as `superseded`. Accept one of two suggestions: the other reads as `superseded` and offers Re-propose. A `by` field in the request body is ignored |
| P4-L | Open the file from `file://`: no chip, no card, no console error. A member sees Suggest and, in Mode B only, Edit. A non-decider never sees Accept, and a forged `data-session` attribute still produces a 403 from the function |
| P4-M | Apply an overlay after the first paint, and confirm the comment highlight on that block is still on the right characters. Collapse the `<details>` around the section, and confirm both marker kinds hide |
| P4-N | Accept in Mode A, promote, and re-upload. The receipt disappears. `history.json` names the suggester. The promoted file holds the accepted text |
| P4-O | An event of kind `suggest.accept` dated 24 months ago survives the retention run. An event of kind `comment.create` of the same date is deleted |

---

## 16. What this changes in the plan

These are the sections of `00-integration-plan.md` that must be edited. Each row names the section and the
change. This document does not edit the plan.

| Section of the plan | The change |
|---|---|
| **§1.1, the key layout** | Add one line: `suggest/<docId>/<aid>/<sugId>.json` — one open suggestion, immutable, `onlyIfNew`. Add one sentence to the concurrency rule: a suggestion record is never mutated, so the sentence "There is one mutable blob shape: a thread" stays correct |
| **§1.1, the confirmed-by-review note** | It says two people editing one block contend on one key and that this is correct. Add that this applies to the **applied** layer only. The proposal layer fans out by `sugId` and does not contend |
| **§1.2, roles** | It says "**There is no `editor` role**". Keep the sentence, and add the reason it is still true: authority to accept comes from `doc.json`, which is committed and scoped to one document, and `canEdit` is a precondition, so a guest in `editors` gains nothing |
| **§1.2, the client contract** | Add the one namespace object `window.doc`, created in `layout.html`, and name it as the only cross-module surface besides the `session` event |
| **§1.3, the document key** | Add `owner` and `editors` to the `doc.json` example |
| **§1.4, the mode table** | Add two rows: **Who may write a direct edit** (Mode A: a decider only. Mode B: any member) and **Who may accept a suggestion** (a decider, in both). Add one sentence to "What this costs, said plainly": acceptance is the only review gate Mode A has, so the suggestion path is not optional in Mode A |
| **§2.4, the event kinds** | Add `suggest.create`, `suggest.accept`, `suggest.reject`, `suggest.withdraw`, `suggest.supersede` and `edit.apply`. **Delete the sentence** "`edit.propose`, `edit.accept` and `edit.reject` from document 06 reduce to one kind. Acceptance and rejection happen in a pull request, not in this platform." It is no longer true. Add the system actor `{ "sub": "system", "name": "Build", "email": "" }` as the one permitted non-human actor |
| **§2.5, pending edit** | **The largest change.** Split it into two records. Keep `edits/<docId>/<aid>.json` as one blob for each anchor, and add `via`, `sugId`, `acceptedBy` and `acceptedAt`. Add the new suggestion record at `suggest/<docId>/<aid>/<sugId>.json`, with the shape in section 5.3 of this document. State that only the proposal layer fans out |
| **§2.6, the edit manifest** | Add `owner` and `editors` at the top level, copied from `doc.json` by the build. State that the manifest is the only source of authority as well as the only source of a file path |
| **§2.8, `history.json`** | Add one sentence: in Mode A the file is written by the promotion step rather than from git, and each promotion adds one `versions[]` row crediting the author of each accepted change |
| **§3.4, conflict detection** | Add the **effective base** definition from section 6.1 of this document. Check 2 today reads "the section file at the branch head", which says nothing about Mode A and nothing about a block that already carries a pending receipt |
| **§3.4, the editable policy** | Add one sentence: a suggestion is possible only on a `data-editable` block, and the policy is the same one. There is no wider policy for suggestions |
| **§3.4, why a pending edit does not break an anchor** | Add the load-order requirement of section 7.5: the overlay must be applied before anchors are resolved, and a later overlay change must dispatch the `doc:overlay` event so `comments.js` re-resolves. This is the same class of failure that §4.5 forbids `<mark>` for |
| **§4.1, the placeholder table** | **No new placeholder.** Add the one-line `window.doc` namespace script to what P1-B lands in `layout.html` |
| **§4.3, P1-A** | Add `owner` and `editors` to the fields P1-A writes, and add the verify step. Do not open a second ticket on the same four files |
| **§4.4, P2-D** | Add "copy `owner` and `editors` into the manifest" to the scope |
| **§4.6, phase 4** | Add P4-J to P4-O from section 15 of this document. State that P4-J, P4-L, P4-M and P4-O each share a file with an existing phase-4 ticket and are sequenced after it. **Check the letters against `07-realtime-and-presence.md`, which claims P2-F, P3-F, P3-G, P4-H and P4-I** |
| **§4.6, P4-D** | The Slack webhook must fire on `suggest.create` and `suggest.accept` or `suggest.reject`. This is the only notification an author gets |
| **§4.6, P4-F** | Retention must exclude `suggest.accept`, `suggest.reject` and `edit.apply`. In Mode A those events are the only durable authorship record |
| **§5, what we are not building** | Add: an un-apply button, a rebase of a superseded suggestion, a word-level diff on the page, a cross-document "suggestions waiting for me" view, and an API that writes `owner` or `editors` |
| **§6, contradictions** | Add rulings 31 to 34: (31) suggestion against edit — two entry points, one apply path; (32) where authority lives — `doc.json`, not a role; (33) the suggestion key layout — the proposal layer fans out, the applied layer does not; (34) does acceptance happen in this platform — yes, which reverses the §2.4 sentence |
| **§6, open questions** | Add: can a Netlify function read `<instance>/dist/<instance>.edit.json` from the deploy, or must `included_files` bundle it? Can a Mode A CLI upload include a sidecar JSON that a function can read but a browser cannot? |
| **README.md of the research folder** | Add a row for this document, and add "a suggestion needs acceptance; an edit does not" to the list of decisions everything hangs on |

---

## 17. Unverified

Every item here is a claim this document depends on and did not confirm. Do not build on one without a
check.

1. **Can a Netlify Function read the edit manifest from the deploy?** The plan says the manifest is "read by
   the edit function" and never says how the file reaches the function's file system. It may need
   `included_files` in `netlify.toml`. This blocks P3-H and P4-J, because the authority list travels in the
   manifest. **Check this first. It is the highest-risk item in this document.**
2. **Can a Mode A CLI upload include a sidecar JSON that a function reads and a browser cannot?** If it
   cannot, the Mode A authority list must be baked into the HTML, where a reader can see it. That is
   probably acceptable — the list is a set of work emails — but it must be a decision.
3. **Does `list({ prefix })` work over a three-level prefix in Netlify Blobs?** The key is an opaque string,
   so it should. Not tested.
4. **Is there a Blobs rate limit or a per-account storage quota?** This is open question 5 of the plan.
   `suggest.reject` events hold up to 4280 characters each, so this design writes more than the plan
   assumed.
5. **Does `list()` honour a store-level `consistency: "strong"`?** Open question 2 of the plan. This design
   inherits the same mitigation: render a new record from the POST response, never from a refetched list.
6. **Two Highlight registries plus a class-based block border, read together.** Section 7.3 asserts that a
   `::highlight()` passage tint and a left border on the same block are legible at the same time. Nobody
   has looked at it.
7. **The 14-day and 90-day reap windows are guesses.** They are not measured against anybody's behaviour.
8. **The per-block cap of five is a judgement, not a measurement.** It may be too low for a contentious
   paragraph and too high for a clean one.
9. **`X-Suggestion-Id` as a commit trailer.** The GitHub Contents API accepts an arbitrary commit message,
   so a trailer should survive. Reading it back needs the branch head commit, which check 2 already fetches.
   Not tested.
10. **Whether the decider gate reads as bureaucracy.** This is a product question for a team of tens. Test
    it on one document with one decider before it is turned on for the set. If it reads as friction in Mode
    B, the answer is to keep the Edit control primary in Mode B and leave Suggest primary in Mode A, which
    is a one-line change in section 3.5.
11. **Whether an author ever learns their suggestion was rejected.** The design says the Slack webhook and
    the panel. Neither reaches somebody who does not open Slack and does not reopen the document. The plan
    records the same gap for comments and accepts it. It is worse here, because a rejection has a decision
    attached.
