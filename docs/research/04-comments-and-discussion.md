# Commenting and threaded discussion

Research for the `archon` document platform. Written 2026-09-01. Every external fact below
was checked on 2026-09-01 unless another date is given.

**Written when the builder was Python. Converted to Rust on 2 September 2026.** Every command, module
name and code block below is now the Rust one. Where this document and `00-integration-plan.md`
disagree, the plan is correct.

---

## 1. The recommendation in one page

Build two things that share one data model.

- A **comment** anchors to a passage. It shows a marker in the margin and a highlight on the text.
- A **discussion** anchors to nothing. It shows only in the panel. It is the same record with `anchor: null`.

Solve anchoring in **two layers**, and put the hard half in the builder, not in the browser.

1. **Build time.** The builder gives every block element a stable `data-aid`. It keeps the ids in a
   committed `anchors.json`. On each rebuild it aligns the new block texts against the old ones with a
   hand-written sequence alignment. An edited paragraph keeps its id. A moved paragraph keeps its id.
   A deleted paragraph is reported as orphaned. This adds no dependency.
2. **Read time.** The client finds the block by `data-aid`, then finds the quoted text inside that block
   with a W3C-style text-quote selector. It uses exact search plus prefix and suffix disambiguation. It
   does no fuzzy matching, so it needs no library.

Store threads in **Netlify Blobs**, one blob per thread, read with strong consistency. Do not use
Netlify DB.

Render with the **CSS Custom Highlight API**. Never wrap text in `<mark>`. DOM mutation would corrupt the
next anchor resolution and fight the existing stylesheet.

**Zero runtime dependencies.** The client code is about 400 lines of vanilla JavaScript. The server code
is about 120 lines across two Netlify Functions. `@netlify/blobs` is the only npm package, and it runs on
the server only.

**Total added weight to the document: about 14 KB of JavaScript and 3 KB of CSS**, inlined by the builder.

---

## 2. What I checked, and when

| Thing | Source | Checked | Result |
|---|---|---|---|
| Netlify Blobs API and limits | [docs.netlify.com Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) | 2026-09-01 | 5 GB per object, 2 KB metadata, 600-byte keys, eventual consistency by default |
| `@netlify/blobs` version | npm registry | 2026-09-01 | **11.0.2**, published 2026-08-28, MIT |
| Netlify Functions v2 signature | [docs.netlify.com Functions](https://docs.netlify.com/build/functions/api/) | 2026-09-01 | `export default async (req, context) => Response`, `config.path`, `config.method` |
| Netlify credit rates | [credit-based pricing](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/credit-based-pricing-plans/) | 2026-09-01 | Free = 300 credits/mo. Production deploy = 15. Compute = 10 per GB-hour. Web requests = 2 per 10,000 |
| Netlify DB status | [Netlify changelog](https://www.netlify.com/changelog/2026-04-28-netlify-database/) and [billing docs](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/) | 2026-09-01 | GA. Postgres. Storage was free only **until 2026-07-01**. That date has passed |
| Netlify Identity status | [Netlify Support, Feb 2026](https://answers.netlify.com/t/netlify-identity-is-staying-feb-2026-reversal-what-changed-whos-affected-and-how-to-proceed/162733) | 2026-09-01 | Deprecation **reversed** in Feb 2026. Identity stays. Git Gateway is the part that was deprecated |
| Apache Annotator | [Apache Incubator](https://incubator.apache.org/projects/annotator.html) | 2026-09-01 | **Retired from the Incubator on 2025-08-11.** Do not depend on it |
| `dom-anchor-text-quote` | npm registry | 2026-09-01 | 4.0.2, last published **2017-02-10**. Pulls `diff-match-patch` |
| `approx-string-match` | npm registry | 2026-09-01 | 2.0.0, published 2021-11-23, MIT, **zero deps, 19.5 KB unpacked** |
| `@recogito/text-annotator` | npm registry | 2026-09-01 | 4.2.6, published **2026-09-01**, BSD-3, **543 KB unpacked, 9 dependencies** |
| `text-fragments-polyfill` | npm registry | 2026-09-01 | 6.7.0, published 2025-11-10, Apache-2.0, zero deps, 167 KB |
| CSS Custom Highlight API | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) | 2026-09-01 | **Baseline since June 2025.** Firefox 140 completed support |

Where I am unsure, I say so in the text. Two things I could **not** confirm from primary docs:

- Netlify does not publish a per-GB credit rate for Blobs storage. The pricing page lists Blobs as an
  included feature on all plans and meters compute, bandwidth and requests. Treat Blobs storage as free
  at our size and re-check before the volume grows.
- The `Highlight.priority` property is in the spec. I did not verify its behaviour in each browser.
  The design below does not rely on it.

---

## 3. The anchoring problem

A comment points at a passage. The document is rebuilt. The markup moves. Where does the comment go?

### 3.1 The three real approaches

**A. A stable id per element, emitted at build time.**

The build writes `<p data-aid="a3f19c2b">`. The comment stores `a3f19c2b`.

- Survives: restyling, wrapping the paragraph in a `<div>`, adding `<b>` inside it, reordering sections,
  renaming CSS classes.
- Fails: the id must come from somewhere. If the id is a hash of the text, then **any edit to the text
  changes the id and orphans every comment on that paragraph**. That is the common case, not the rare
  one. People comment on a paragraph exactly because they want it changed.
- Fails: the id has no sub-paragraph precision. A comment on five words in a long paragraph highlights
  the whole paragraph.

**B. A text-quote anchor, in the style of the W3C Web Annotation Data Model.**

The comment stores `{exact, prefix, suffix}`. The client searches the rendered text.

- Survives: every markup change, because it ignores markup completely. This is its one large virtue.
- Fails: any edit inside the quoted words. Exact search then finds nothing.
- Fails on short quotes. `"Yes"` or `"the client"` appears many times. Prefix and suffix reduce this
  but do not remove it.
- Fails slowly. Fuzzy matching hides the failure instead of reporting it. Hypothesis
  [documented](https://web.hypothes.is/blog/fuzzy-anchoring/) fuzzy anchoring as the fix, and then
  [reported](https://github.com/hypothesis/client/issues/3919) that fuzzy anchoring blocks the main
  thread for a long time on large documents with short generic quotes. A wrong fuzzy match moves a
  comment to the wrong paragraph and nobody notices.

**C. An XPath or a CSS selector.**

The comment stores `/main/section[3]/details/div/p[7]`.

- Survives: nothing useful.
- Fails: adding one paragraph above shifts every index below it. Wrapping a block in a `<div>` breaks
  every path through it. Our builder wraps every section in `<section><details><summary>...` and a
  template change would break every anchor in every document at once.
- **Reject this.** It is the approach with the worst ratio of effort to durability.

### 3.2 What to do instead

Use A and B together, and move the hard part to the build.

The insight is that **this platform has a build step that sees both versions of the document.** A browser
anchoring library never has that. It sees only the new text and a stored quote. Our builder sees the
old block texts in `anchors.json` and the new block texts in the section files. It can align them
properly, once, at build time, with full document context and no time pressure.

So:

- **`data-aid` carries identity across edits.** The build keeps the id on a paragraph even when the
  paragraph is rewritten, because sequence alignment tells it which new paragraph replaced which old one.
- **The text quote carries precision inside the block.** It selects the words, not the paragraph.
- **The two degrade independently.** If the quote drifts but the block is alive, the comment shows on the
  block with a "text changed" note. If the block dies, the comment goes to an "orphaned" list with its
  quote shown as plain text. Nothing is silently moved.

### 3.3 How each layer fails, honestly

| Change to the document | `data-aid` | Text quote | Reader sees |
|---|---|---|---|
| Restyle, rewrap, change classes | Keeps | Keeps | Nothing changed |
| Fix a typo elsewhere in the paragraph | Keeps (edit alignment) | Keeps | Nothing changed |
| Rewrite the quoted words | Keeps | **Loses** | Comment on the paragraph, marked "text changed" |
| Move the paragraph to another section | Keeps (move pass) | Keeps | Nothing changed |
| Split one paragraph into two | **Loses** | Keeps if quote survives in one half | Comment re-found by quote search, marked "moved" |
| Merge two paragraphs into one | Keeps for one, **loses** for the other | Keeps | One comment fine, one marked "moved" |
| Delete the paragraph | **Loses** | **Loses** | Thread listed as orphaned, with its quote |
| Two near-identical rows, one edited | Keeps, if alignment is not ambiguous | Keeps | Nothing changed |
| Whole section rewritten | **Loses** | **Loses** | All threads orphaned. This is correct |

The failure that worries me is **silent mis-pairing**: alignment moves a comment onto a paragraph that
merely resembles the old one. Two guards:

1. Sequence alignment, not pairwise best match. Order is respected, so two similar siblings do not swap.
2. A similarity floor of `0.6`. Below it, the build orphans rather than guesses.

And a third, which matters more than either: **the build prints a report.** Every rebuild says how many
blocks kept their id, how many were re-anchored after an edit, how many moved, and how many threads were
orphaned. A writer who orphans twelve threads finds out at the moment they do it.

---

## 4. Build-time anchoring: real code

**The algorithm is tested. The Rust is not.** I ran the alignment and the injector as Python on
2026-09-01, and the results in section 4.3 are real measurements of that run. The Rust below replaces
that Python. It is the specification the implementer codes to, and it has not been compiled. Section
4.5 lists what the conversion leaves unspecified.

### 4.1 New file: `templates/docbuild/src/anchors.rs`

The public signature is fixed by `00-integration-plan.md` section 4.1. Do not change it.

```rust
//! Stable per-block anchor ids, carried across rebuilds.
//!
//! Every block element in a section gets a data-aid. The ids live in
//! <instance>/anchors.json, which is committed, so a reviewer sees anchor
//! churn in the diff. On rebuild the new block texts are aligned against
//! the old ones. An edited block keeps its id. A moved block keeps its id.
//! A deleted block is reported.
//!
//! No crates. Every helper is written by hand, the way main.rs hand-writes
//! its JSON scanner and find_placeholders().

use crate::Section;
use std::path::Path;

const BLOCK: [&str; 12] = [
    "p", "li", "h2", "h3", "h4", "td", "th", "pre", "blockquote", "figcaption", "dd", "dt",
];

/// A block below this similarity is a new block, not an edit of an old one.
const THRESHOLD: f64 = 0.6;

/// One block: where its open tag starts and ends, and its normalised text.
struct Block {
    open_start: usize,
    open_end: usize,
    tag: String,
    text: String,
}

/// Collapse every whitespace run to one space, then trim.
/// The client must apply the identical rule: text.replace(/\s+/g, ' ').trim()
fn norm(s: &str) -> String;

/// "a" plus eight hexadecimal characters derived from the text.
fn new_id(text: &str) -> String;

/// Every non-nested block in one section body, in document order.
fn find_blocks(frag: &str) -> Vec<Block>;

/// Align two lists of block texts. Returns (ids, report, orphans).
fn realign(
    old_ids: &[String],
    old_texts: &[String],
    new_texts: &[String],
) -> (Vec<String>, Vec<(&'static str, String, Option<f64>)>, Vec<String>);

/// Insert ` data-aid="..."` into the open tag of each block.
fn inject(frag: &str, blocks: &[Block], ids: &[String]) -> String;

/// Add data-aid to every block in every section body, in place.
/// Rewrite <inst>/anchors.json.
/// Returns (report_lines, orphans), orphans as (section_id, aid).
pub fn anchor_sections(
    inst: &Path,
    sections: &mut [Section],
) -> Result<(Vec<String>, Vec<(String, String)>), String>;
```

What each one does. The behaviour is the behaviour section 4.3 measured; only the language changes.

- **`norm`** walks the characters, replaces each run of whitespace with one space, and trims the ends.
  It must call `char::is_whitespace`, not `is_ascii_whitespace`. Section 8.2 explains why that one call
  decides whether the client and the builder agree.
- **`new_id`** hashes the normalised text and takes the first eight hexadecimal characters. The Python
  used `hashlib.sha1`. Rust has no digest in its standard library, so use a hand-written FNV-1a over
  the bytes, formatted as `{:016x}` and truncated to eight characters. The id only has to be stable for
  the same text and unlikely to collide inside one document. It is never a security boundary.
- **`find_blocks`** replaces the two regular expressions. It scans for `<` followed by one of `BLOCK`
  and then `>` or whitespace, records the open tag span, then counts the same tag up and down until the
  depth returns to zero. That is the same scan shape as `find_placeholders()` in `main.rs`. The text is
  everything between the tags with `<...>` spans dropped, entities unescaped, and `norm` applied. A
  block with empty text is skipped.
- **`realign`** is the hard one, and section 4.5 records that its Rust is not specified. It replaces
  `difflib.SequenceMatcher`: an opcode alignment of the two text lists that yields `equal`, `delete`,
  `insert` and `replace` runs, plus a similarity ratio for one pair of strings. `equal` runs carry ids
  across. `delete` runs orphan. Inside a `replace` run the pairs are compared by ratio: at or above
  `THRESHOLD` the old id carries over and the pair is reported as `edited`, below it the old id is
  orphaned. Then the move pass runs: any orphan whose exact text reappears at an unclaimed position
  takes that position and is reported as `moved`. Anything still unclaimed gets `new_id`.
- **`inject`** copies the fragment and splices ` data-aid="..."` in at `open_end - 1`, immediately
  before the closing `>` of each open tag. It walks the blocks in order and never re-scans, so the
  recorded offsets stay valid.
- **`anchor_sections`** reads `anchors.json` if it exists, runs the four helpers for each section,
  writes the fresh file, and returns the report lines and the orphan list. It mutates `sections` in
  place through `&mut [Section]`, so ownership does not move.

`anchors.json` holds arrays of strings. The `Scanner` in `main.rs` models strings and one nested object
only, and skips an array, so this module either parses its own file or the scanner gains a
`Val::Arr(Vec<String>)` case. Prefer the scanner case: one more arm, and `doc.json` gains `aliases` for
free. Writing the file is string formatting, exactly as the Python `json.dumps` call was.

### 4.2 The hook in `main.rs`

Two added lines. Insert after the duplicate-id check, before `nav` is built. `sections` becomes
`let mut sections`.

```rust
    let (anchor_lines, orphaned) = anchors::anchor_sections(&inst, &mut sections)?;
```

And after `println!("built {}", shown.display())`:

```rust
    if !anchor_lines.is_empty() {
        println!("  anchors");
        for line in &anchor_lines {
            println!("{line}");
        }
    }
    if !orphaned.is_empty() {
        let shown = orphaned
            .iter()
            .take(8)
            .map(|(s, a)| format!("{s}/{a}"))
            .collect::<Vec<_>>()
            .join(", ");
        println!(
            "  !! {} anchor(s) gone. Threads on them become orphaned: {shown}",
            orphaned.len()
        );
    }
```

**Rust has no import path to fix, and no optional import either.** The Python plan needed a
`sys.path` line and a `try: import` guard. `mod anchors;` at the top of `main.rs` replaces both. The
module is a child of the crate root, so it can read the private fields of `Section` with no `pub`.
It is always compiled in, which is what `00-integration-plan.md` section 4.1 rules. `anchors.rs` has
no absent-input case to guard: a missing `anchors.json` means every block is new, which is the correct
result on the first run.

### 4.3 Verified behaviour

I ran the injector on a realistic fragment:

```
input:  <p class="lede">The cache key covers <b>every</b> declared input and&nbsp;nothing else.</p>
text:   "The cache key covers every declared input and nothing else."
output: <p class="lede" data-aid="a1">The cache key covers <b>every</b> ...
```

Inline tags are stripped for the text. `&nbsp;` is unescaped to U+00A0, then collapsed. JavaScript `\s`
and `char::is_whitespace` both match U+00A0, so the two sides agree. `is_ascii_whitespace` does not, which
is why section 4.1 forbids it.

I ran the alignment on four cases:

| Case | Result |
|---|---|
| Paragraph wrapped in a `<div>` **and** extended by a clause | Kept its id, reported `edited 0.86` |
| Three blocks reordered | All three kept their ids, via the move pass |
| Two near-identical siblings, one edited | Correct id on each, no swap |
| Paragraph split in two | Both halves new, old id orphaned. Reported, not silent |

### 4.4 `anchors.json`

```json
{
 "architecture": {
  "ids": ["a3f19c2b", "a90b7de1", "aee58e63"],
  "texts": [
   "The cache key covers every declared input and nothing else.",
   "Every write records the identity that produced it.",
   "Open question: who owns the key rotation schedule?"
  ]
 }
}
```

It is committed. A reviewer sees anchor churn in the pull request diff, next to the text change that
caused it. That is the cheapest possible review tool for this problem.

Cost: the file is roughly the size of the document's plain text, so about 20 KB for a 40 KB document. It
does not go into `dist/`.

### 4.5 What the Rust conversion leaves unspecified

State these honestly rather than guessing. Every one of them is a place where Python's standard library
carried weight that Rust's does not.

1. **`realign` is not specified in Rust.** `difflib.SequenceMatcher` gave the opcode alignment and the
   similarity ratio for free. Rust has neither, and no crate may be added. The implementer must write
   both: an opcode diff over two lists of strings, and a ratio for one pair of strings. Section 4.1
   describes the algorithm and section 4.3 gives four cases the result must reproduce. **The code is
   not written and the behaviour is not yet verified in Rust.** Treat P1-D as larger than the Python
   estimate for exactly this reason.
2. **The id hash changed.** The Python used `hashlib.sha1`. Rust's standard library has no digest, so
   section 4.1 specifies a hand-written FNV-1a instead. The ids in an existing `anchors.json` would
   therefore not be reproduced by the Rust builder. That is harmless on a first run, because no
   `anchors.json` is committed yet. Land `anchors.rs` before any thread exists.
3. **Entity unescaping is by hand.** `html.unescape` handled the full named-entity table. The builder
   needs the five XML entities, `&nbsp;`, and the numeric forms. Anything else in a section file must
   fail loud rather than pass through, or the client and the builder will disagree on that block.
4. **`anchors.json` needs an array case in the scanner.** Section 4.1 records the choice.
5. **`--with-comments` needs an HTTP client Rust does not have.** Section 11 records this, and
   `00-integration-plan.md` section 4.2 rejects the flag on other grounds.

---

## 5. Data model

One thread is one record. A comment is one entry inside it. Threads are shallow: **one level of replies,
no nesting**. Nested trees look powerful and read badly. Slack settled on one level for good reasons.

```json
{
  "id": "t_m8x2k1_4f7a9c31",
  "doc": "example",
  "kind": "comment",
  "status": "open",
  "section": "architecture",
  "anchor": {
    "block": "a3f19c2b",
    "exact": "a cache miss never blocks the build",
    "prefix": "We guarantee that ",
    "suffix": ". This is the only hard",
    "start": 142
  },
  "title": null,
  "createdAt": "2026-09-01T14:02:11.412Z",
  "author": { "sub": "u_931", "name": "the owner W", "email": "owner@example.com" },
  "resolvedAt": null,
  "resolvedBy": null,
  "comments": [
    {
      "id": "c_m8x2k1_1",
      "body": "Is this still true after the September key change?",
      "author": { "sub": "u_931", "name": "the owner W", "email": "owner@example.com" },
      "createdAt": "2026-09-01T14:02:11.412Z",
      "editedAt": null
    }
  ]
}
```

Field notes.

- `kind` is `"comment"` or `"discussion"`. A discussion has `anchor: null` and a `title`. That is the
  only difference. One code path, one panel, one storage layout.
- `anchor.start` is the character offset of the quote inside the **normalised block text**. It is a
  tiebreaker only. It is never trusted alone.
- `anchor.prefix` and `anchor.suffix` are 32 characters each. That is the length
  [`dom-anchor-text-quote` uses](https://github.com/tilgovi/dom-anchor-text-quote), and it is enough.
- `section` is redundant with `block` but survives the block's death. It puts an orphan in the right part
  of the panel.
- `status` is `"open"` or `"resolved"`. There is no `"deleted"`. See section 9.
- `id` sorts by creation time: `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0,8)}`. Blob
  keys sort lexicographically, so listing is already in order.
- There is **no `buildRev`**. Anchors are meant to survive rebuilds. Recording the build they were made
  against would invite code that invalidates on mismatch, which is the behaviour we are avoiding.

**Anchor state is computed at read time, never stored.** The client sets `exact`, `drifted`, `moved`, or
`orphaned` on the object in memory. Storing it would go stale on the next rebuild.

---

## 6. Storage: Netlify Blobs

### 6.1 The layout

One store, one blob per thread.

```
store "threads"
  example/t_m8x2k1_4f7a9c31.json
  example/t_m8x2p9_be014277.json
  example/t_m8y0aa_2c9f1e40.json
```

One blob per thread, not one blob per document, because **a comment and a reply are concurrent writes to
different threads**. Per-thread blobs remove contention entirely. Appending a reply is a compare-and-swap
on one small object.

Reading a document costs one `list({ prefix })` plus N parallel `get` calls, all inside one function
invocation. At 50 threads that is one round trip from the browser and about 200 ms from the function. It
is fine. It stops being fine somewhere past a few hundred threads per document, at which point move to a
per-document index blob or to Postgres.

### 6.2 Consistency

**Read with `consistency: "strong"`.** This is the single most important line in the storage code.

Netlify Blobs defaults to eventual consistency, and the docs say updates propagate globally **within 60
seconds**. Default reads would mean: post a comment, reload, comment is gone, post it again. Strong
consistency costs read latency and nothing else.

### 6.3 Why not Netlify DB

Netlify DB went GA on 2026-04-28 and is real Postgres. I still say no.

- **It now costs money.** Database storage was free only until 2026-07-01. That date has passed. Compute
  and database bandwidth are metered at 10 credits per GB-hour and 20 credits per GB. Blobs, at our size,
  are effectively free.
- **It adds a schema and migrations.** That is a second build-time toolchain in a repository whose whole
  premise is one dependency-free binary.
- **It adds a driver dependency** and connection handling in a serverless function.
- **We have no queries.** The only read is "all threads for this document". `list({ prefix })` answers it.
  There is no join, no aggregate, no sort we cannot do in 5 lines of JavaScript.

Revisit if: threads pass a few hundred per document, or full-text search across documents is wanted, or a
notification digest needs "all comments since timestamp T across all documents".

### 6.4 Why not GitHub, and why not git

Storing threads as JSON in the repository is tempting. It gives free history and free review. Reject it:
every comment becomes a commit and a deploy, a deploy costs 15 of the 300 free monthly credits, and two
people commenting at once produce a merge conflict in a data file. GitHub Discussions through
[giscus](https://giscus.app) is a better version of the same idea and is covered in section 12.

---

## 7. The API

Two functions. Netlify Functions v2 syntax, `.mjs` files, in `netlify/functions/`.

### 7.1 Shared module: `netlify/functions/_lib.mjs`

```js
import { getStore } from "@netlify/blobs";

export const store = () => getStore({ name: "threads", consistency: "strong" });

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export const key = (doc, id) => `${doc}/${id}.json`;

/** Owned by the authentication area. Returns {sub,name,email} or null. */
export { identify } from "./_auth.mjs";
```

### 7.2 `netlify/functions/threads.mjs` — list and create

```js
import { store, json, key, identify } from "./_lib.mjs";

export default async (req, context) => {
  const user = await identify(req, context);
  if (!user) return json({ error: "unauthenticated" }, 401);

  const url = new URL(req.url);
  const doc = url.searchParams.get("doc");
  if (!doc || !/^[a-z0-9-]{1,64}$/.test(doc)) return json({ error: "bad doc" }, 400);

  const s = store();

  if (req.method === "GET") {
    const { blobs } = await s.list({ prefix: `${doc}/` });
    const threads = await Promise.all(
      blobs.map((b) => s.get(b.key, { type: "json", consistency: "strong" }))
    );
    return json({ threads: threads.filter(Boolean) });
  }

  // POST: create a thread with its first comment.
  const b = await req.json();
  if (typeof b.body !== "string" || !b.body.trim() || b.body.length > 10000)
    return json({ error: "bad body" }, 400);
  if (b.kind !== "comment" && b.kind !== "discussion")
    return json({ error: "bad kind" }, 400);
  if (b.kind === "comment" && (!b.anchor || typeof b.anchor.block !== "string"))
    return json({ error: "comment needs an anchor" }, 400);

  const now = new Date().toISOString();
  const id = `t_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
  const thread = {
    id,
    doc,
    kind: b.kind,
    status: "open",
    section: typeof b.section === "string" ? b.section.slice(0, 64) : null,
    anchor: b.kind === "comment"
      ? {
          block: String(b.anchor.block).slice(0, 32),
          exact: String(b.anchor.exact || "").slice(0, 1000),
          prefix: String(b.anchor.prefix || "").slice(0, 64),
          suffix: String(b.anchor.suffix || "").slice(0, 64),
          start: Number(b.anchor.start) || 0,
        }
      : null,
    title: b.kind === "discussion" ? String(b.title || "").slice(0, 200) : null,
    createdAt: now,
    author: user,
    resolvedAt: null,
    resolvedBy: null,
    comments: [
      { id: `c_${Date.now().toString(36)}_1`, body: b.body, author: user,
        createdAt: now, editedAt: null },
    ],
  };

  await s.setJSON(key(doc, id), thread, { onlyIfNew: true });
  context.waitUntil(notify(thread, thread.comments[0], "new"));   // section 10
  return json({ thread }, 201);
};

export const config = { path: "/api/threads", method: ["GET", "POST"] };
```

### 7.3 `netlify/functions/thread.mjs` — reply, resolve, reopen, edit

The append is a compare-and-swap. `getWithMetadata` returns an `etag`. `set` with `onlyIfMatch` returns
`{ modified: false }` if the blob changed under us. Retry three times, then give up with 409.

```js
import { store, json, key, identify } from "./_lib.mjs";

const MAX_TRIES = 3;

/** Read, mutate, conditionally write. Retries on a lost race. */
async function update(s, k, mutate) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const got = await s.getWithMetadata(k, { type: "json", consistency: "strong" });
    if (!got) return { error: "not found", status: 404 };
    const next = mutate(structuredClone(got.data));
    if (next.error) return next;
    const { modified } = await s.set(k, JSON.stringify(next.thread), {
      onlyIfMatch: got.etag,
    });
    if (modified) return next;
  }
  return { error: "conflict, please retry", status: 409 };
}

export default async (req, context) => {
  const user = await identify(req, context);
  if (!user) return json({ error: "unauthenticated" }, 401);

  const { doc, id } = context.params;
  if (!/^[a-z0-9-]{1,64}$/.test(doc) || !/^t_[a-z0-9_]{1,40}$/.test(id))
    return json({ error: "bad path" }, 400);

  const s = store();
  const k = key(doc, id);
  const b = await req.json();
  const now = new Date().toISOString();

  let result;

  if (req.method === "POST") {
    // Append a reply.
    if (typeof b.body !== "string" || !b.body.trim() || b.body.length > 10000)
      return json({ error: "bad body" }, 400);
    result = await update(s, k, (t) => {
      t.comments.push({
        id: `c_${Date.now().toString(36)}_${t.comments.length + 1}`,
        body: b.body, author: user, createdAt: now, editedAt: null,
      });
      return { thread: t };
    });
  } else if (req.method === "PATCH") {
    // Resolve, reopen, or edit one's own comment.
    result = await update(s, k, (t) => {
      if (b.status === "resolved" || b.status === "open") {
        t.status = b.status;
        t.resolvedAt = b.status === "resolved" ? now : null;
        t.resolvedBy = b.status === "resolved" ? user : null;
      }
      if (b.commentId && typeof b.body === "string") {
        const c = t.comments.find((x) => x.id === b.commentId);
        if (!c) return { error: "no such comment", status: 404 };
        if (c.author.sub !== user.sub) return { error: "not yours", status: 403 };
        c.body = b.body;
        c.editedAt = now;
      }
      return { thread: t };
    });
  } else {
    return json({ error: "method" }, 405);
  }

  if (result.error) return json({ error: result.error }, result.status || 500);
  if (req.method === "POST")
    context.waitUntil(notify(result.thread, result.thread.comments.at(-1), "reply"));
  return json({ thread: result.thread });
};

export const config = {
  path: "/api/threads/:doc/:id",
  method: ["POST", "PATCH"],
};
```

Note: `structuredClone` is available in the Node runtime Netlify Functions use. If the target runtime is
older, use `JSON.parse(JSON.stringify(x))`.

Note: `config.path` in `threads.mjs` has no `:doc` segment, so the document comes from a query parameter
there and from the path in `thread.mjs`. That inconsistency is deliberate and small. Make both
path-shaped (`/api/docs/:doc/threads`) if it bothers the implementer.

### 7.4 Authentication boundary

`identify(req, context)` is **not mine to write**. It belongs to the authentication area. This design needs
exactly one thing from it:

```js
// returns { sub: string, name: string, email: string } or null
export async function identify(req, context) { ... }
```

`sub` must be stable for a person across sessions. Comment ownership and "not yours" checks depend on it.
Until that module exists, a stub that reads a `netlify-vary` cookie or returns a fixed test user unblocks
all the client work.

---

## 8. The client, without a framework

One new file, `templates/base/comments.js`, inlined by the builder through a `{{COMMENTS_JS}}` placeholder,
plus `templates/base/comments.css` through `{{COMMENTS_CSS}}`.

### 8.1 The guard that makes the plain file work

```js
(function () {
  var API = document.body.getAttribute("data-comments-api");
  var online = /^https?:$/.test(location.protocol);
  if (!API || !online) return;            // file://, or comments not enabled
  // ... everything else
})();
```

That is the whole degradation story for `file://`. The builder emits the attribute only when `doc.json`
has `"comments": true`. Opened from disk, `location.protocol` is `file:`, the module returns, and no
comment UI exists. The document reads exactly as it does today.

Every network call is additionally wrapped:

```js
async function api(path, opts) {
  try {
    var r = await fetch(API + path, Object.assign({ credentials: "same-origin" }, opts));
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } catch (e) {
    fail();                 // hide the comment UI, show one small notice, never throw
    return null;
  }
}
```

Under the Claude artifact CSP, `location.protocol` is `https:` but `connect-src` blocks the Netlify host.
The first `fetch` rejects, `fail()` runs, and the reader sees a one-line "Comments are not available in
this view" notice under the masthead. That is the correct behaviour and it costs 6 lines.

### 8.2 Normalised text, and mapping offsets back to the DOM

This must match `norm()` in `anchors.rs` exactly.

```js
/** Walk text nodes. Build the normalised string and a per-character
    map back into (node, offset). Whitespace runs collapse to one space. */
function textMap(root) {
  var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  var s = "", pos = [], prevWs = true, n;
  while ((n = w.nextNode())) {
    var v = n.nodeValue;
    for (var i = 0; i < v.length; i++) {
      if (/\s/.test(v[i])) {
        if (prevWs) continue;              // collapse the run
        s += " "; pos.push([n, i]); prevWs = true;
      } else {
        s += v[i]; pos.push([n, i]); prevWs = false;
      }
    }
  }
  if (s.slice(-1) === " ") { s = s.slice(0, -1); pos.pop(); }   // == .trim()
  return { text: s, pos: pos };
}

function rangeFor(map, start, end) {
  if (start < 0 || end > map.pos.length || end <= start) return null;
  var a = map.pos[start], b = map.pos[end - 1];
  var r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1] + 1);
  return r;
}
```

Leading whitespace never enters `s`, because `prevWs` starts `true`. One trailing space is trimmed. This
reproduces `norm()` in `anchors.rs`.

**The Rust side must use `char::is_whitespace`, not `is_ascii_whitespace`.** `main.rs` uses the ASCII
form in its JSON scanner, where every byte is ASCII. `norm()` cannot: `&nbsp;` unescapes to U+00A0,
which the client collapses and `is_ascii_whitespace` would keep. That single wrong call would break the
offset agreement on every block that holds a non-breaking space.

The one known divergence: JavaScript `\s` also matches U+FEFF, which `char::is_whitespace` does not, and
`char::is_whitespace` also matches U+0085, which JavaScript `\s` does not. Neither appears in
hand-authored documentation. If one ever does, the client finds no match and the comment shows at block
level. It does not corrupt anything.

### 8.3 Describing a selection

```js
function describe(block, range) {
  var map = textMap(block), start = null, end = null;
  for (var i = 0; i < map.pos.length; i++) {
    var p = map.pos[i], q = document.createRange();
    q.setStart(p[0], p[1]); q.setEnd(p[0], p[1] + 1);
    var inside =
      range.compareBoundaryPoints(Range.START_TO_START, q) <= 0 &&
      range.compareBoundaryPoints(Range.END_TO_END, q) >= 0;
    if (inside) { if (start === null) start = i; end = i + 1; }
  }
  if (start === null) return null;
  return {
    block: block.getAttribute("data-aid"),
    exact: map.text.slice(start, end),
    prefix: map.text.slice(Math.max(0, start - 32), start),
    suffix: map.text.slice(end, end + 32),
    start: start,
  };
}
```

`compareBoundaryPoints` is used rather than offset arithmetic because it is correct across element
boundaries without any special cases. It is O(n) in block characters, which is a few hundred. It runs
once per new comment, not per frame.

### 8.4 Resolving an anchor

```js
function findQuote(text, a) {
  if (!a.exact) return -1;
  var best = -1, bestScore = -Infinity, i = -1;
  while ((i = text.indexOf(a.exact, i + 1)) !== -1) {
    var pre = text.slice(Math.max(0, i - a.prefix.length), i);
    var suf = text.slice(i + a.exact.length, i + a.exact.length + a.suffix.length);
    var score = commonSuffix(pre, a.prefix) + commonPrefix(suf, a.suffix)
              - Math.abs(i - a.start) / 1000;      // gentle tiebreak only
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

function locate(t) {
  if (!t.anchor) return { state: "discussion" };
  var el = document.querySelector('[data-aid="' + CSS.escape(t.anchor.block) + '"]');
  if (el) {
    var map = textMap(el), i = findQuote(map.text, t.anchor);
    if (i >= 0)
      return { state: "exact", el: el,
               range: rangeFor(map, i, i + t.anchor.exact.length) };
    return { state: "drifted", el: el, range: null };   // block alive, words changed
  }
  // Block gone. Look for the exact quote anywhere, and accept only a unique hit.
  var hits = [];
  document.querySelectorAll("[data-aid]").forEach(function (e) {
    var m = textMap(e), j = findQuote(m.text, t.anchor);
    if (j >= 0) hits.push([e, m, j]);
  });
  if (hits.length === 1) {
    var h = hits[0];
    return { state: "moved", el: h[0],
             range: rangeFor(h[1], h[2], h[2] + t.anchor.exact.length) };
  }
  return { state: "orphaned" };
}
```

Four states, four different things the reader sees. Nothing is ever silently relocated: `moved` requires a
**unique** exact hit, and the UI labels it.

Cost: `locate` walks the document once per thread in the `moved` branch only. With 50 threads and, say,
5 orphans, that is 5 document walks on load. Measured cost is small, but if it ever matters, build the
text map for every block once and reuse it. Say `mapCache = new WeakMap()`.

### 8.5 Highlighting: the CSS Custom Highlight API

```js
var hlAll = new Highlight(), hlActive = new Highlight();
function paint(threads) {
  if (!window.CSS || !CSS.highlights) return;    // fall back to block borders
  CSS.highlights.delete("cmt"); CSS.highlights.delete("cmt-on");
  hlAll = new Highlight(); hlActive = new Highlight();
  threads.forEach(function (t) {
    if (t.loc.range && t.status === "open")
      (t.id === activeId ? hlActive : hlAll).add(t.loc.range);
  });
  CSS.highlights.set("cmt", hlAll);
  CSS.highlights.set("cmt-on", hlActive);
}
```

```css
::highlight(cmt)    { background: var(--cmt-tint); }
::highlight(cmt-on) { background: var(--cmt-tint-on); }
```

This is the reason to use the API rather than wrapping text in `<mark>`:

- **No DOM mutation.** `textMap` keeps producing the same offsets. A `<mark>` wrapper would split text
  nodes and invalidate the anchor resolution of every other thread.
- **Overlapping comments just work.** Two people can comment on overlapping phrases. With `<mark>`
  wrappers that needs an interval-splitting algorithm.
- **It cannot break the existing stylesheet.** No new elements enter the cascade.

Baseline since June 2025, when Firefox 140 shipped it. For anything older, the fallback is a left border
on the block:

```js
if (!window.CSS || !CSS.highlights)
  threads.forEach(function (t) { if (t.loc.el) t.loc.el.classList.add("has-cmt"); });
```

Precision is lost, the feature still works. Do not add a polyfill.

### 8.6 Margin markers

Markers live in one absolutely positioned rail. They are placed from `getBoundingClientRect`.

```js
var rail = document.createElement("aside");
rail.id = "cmt-rail";
document.body.appendChild(rail);      // body { position: relative }

function place(threads) {
  var y0 = window.scrollY;
  threads.forEach(function (t) {
    var host = t.loc.el, m = t.marker;
    // Hide a marker whose section is collapsed.
    var d = host && host.closest("details");
    var hidden = !host || (d && !d.open) || !host.offsetParent;
    m.hidden = hidden;
    if (hidden) return;
    var r = (t.loc.range || host).getBoundingClientRect();
    m.style.top = (r.top + y0) + "px";
  });
  declutter(threads);      // push overlapping markers down by 4px steps
}

document.addEventListener("toggle", place, true);   // capture: toggle does not bubble
window.addEventListener("resize", place);
```

The `true` third argument is load-bearing. The `toggle` event on `<details>` does not bubble, and this
template puts every section inside a `<details>`. Capture-phase listening catches all of them with one
handler and no per-element wiring. Also call `place()` after `openFromHash()` in `app.js`.

`declutter` is a 6-line loop: sort by `top`, and if a marker is within 24 px of the previous one, move it
to `prev + 24`. Do not build a layout engine.

### 8.7 The panel, and no `innerHTML`

The panel is a `position: fixed` right-hand column. It is `hidden` until a marker is clicked or the header
button is pressed. Rendering rebuilds the list from the thread array on every change. At tens of threads,
a full rebuild is faster than any diffing and much shorter to write.

Every string from the API goes through `textContent`. Never through `innerHTML`. One helper:

```js
function h(tag, attrs, kids) {
  var e = document.createElement(tag);
  for (var k in attrs || {}) {
    if (k === "text") e.textContent = attrs[k];
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(function (c) { e.appendChild(c); });
  return e;
}
```

That is the whole framework. About 12 lines. Adding React to render a list of 50 items would add 140 KB
to a 40 KB document.

Panel contents, top to bottom:

1. A filter row: **Open** / **Resolved** / **All**, and **Anchored** / **Discussion**.
2. Threads with a live anchor, in document order.
3. A separated group headed "Not attached any more", holding `orphaned` threads with their quote
   rendered as a blockquote. This group is the honesty mechanism. It is never hidden.
4. A "Start a discussion" button, for the unanchored kind.

### 8.8 Selecting text and starting a comment

```js
document.addEventListener("mouseup", function () {
  var sel = document.getSelection();
  if (!sel || sel.isCollapsed) return hideTip();
  var range = sel.getRangeAt(0);
  var block = range.startContainer.parentElement
    && range.startContainer.parentElement.closest("[data-aid]");
  if (!block) return hideTip();
  var endBlock = range.endContainer.parentElement
    && range.endContainer.parentElement.closest("[data-aid]");
  if (endBlock !== block) return showTip(range, "Select inside one paragraph", null);
  showTip(range, "Comment", function () { draft(describe(block, range)); });
});
```

A small floating button appears above the selection. It shows the reason when the selection spans two
blocks, rather than silently doing nothing. **Multi-block selections are refused, not clamped.** A clamped
anchor lies about what the reader picked.

Also bind `Ctrl`/`Cmd` + `Alt` + `M` to the same action for keyboard users, and make markers reachable by
`Tab` with `role="button"` and a `tabindex`.

Touch devices fire `mouseup` inconsistently after a text selection. Add `document.addEventListener
("selectionchange", debounce(check, 250))` as well, and de-duplicate. I have not tested this on iOS
Safari.

---

## 9. Resolve and reopen

- **Resolve** sets `status: "resolved"`, `resolvedAt`, `resolvedBy`. Anyone authenticated may resolve.
  This is an internal team of tens. Permission rules would cost more than they save.
- A resolved thread **loses its highlight and its marker** and drops out of the default panel view. It
  stays in the `Resolved` filter, whole.
- **Reopen** sets `status: "open"` and clears the two fields. Same endpoint, same shape.
- **Replying to a resolved thread does not reopen it.** Automatic reopening surprises people. Show a
  "Reopen" button next to the reply box instead.
- **There is no delete.** A thread is data with an author and a timestamp. Deleting it removes a record
  someone else may be answering. If a thread must go, remove the blob with the Netlify CLI:
  `netlify blobs:delete threads example/t_xxx.json`. Deliberate friction on a rare, destructive act
  is the right trade.
- An author may **edit their own comment**. `editedAt` is set and the UI shows "edited". Do not keep the
  previous text here. That belongs to the history area.

---

## 10. Notification

**Recommendation: no per-user notification, and one Slack webhook.**

Per-user notification means subscription state, digest scheduling, unsubscribe links, an email provider,
and a deliverability problem. For tens of internal readers that is the wrong amount of machinery.

Instead, do two cheap things.

**In the document.** The header shows a count of open threads. A thread the reader has not seen is marked
with a dot. "Seen" is per-reader and belongs in `localStorage`, not on the server:

```js
var seen = JSON.parse(localStorage.getItem("cmt-seen:" + DOC) || "{}");
// seen[threadId] = comments.length at last view
```

It is per-browser and it can be lost. That is fine for a "new" dot. Wrap the read and the write in
`try/catch`: some browsers throw on `localStorage` access.

**Out of the document.** One Slack incoming webhook per document, in a Netlify environment variable. No
dependency, about 12 lines, fired from `context.waitUntil` so it never delays the response.

```js
export async function notify(thread, comment, kind) {
  const hook = Netlify.env.get("SLACK_WEBHOOK_URL");
  if (!hook) return;
  const url = `${Netlify.env.get("URL")}/${thread.doc}/#thread-${thread.id}`;
  const what = kind === "new"
    ? (thread.kind === "discussion" ? "started a discussion" : "commented on")
    : "replied on";
  const quote = thread.anchor ? `> ${thread.anchor.exact.slice(0, 140)}\n` : "";
  await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `*${comment.author.name}* ${what} <${url}|${thread.doc}>\n`
          + quote + comment.body.slice(0, 400),
    }),
  });
}
```

`Netlify.env.get` is the global available inside Functions v2. `process.env` also works.

**What I would not do here.** Do not send email. Netlify's email extension needs an external provider
(SendGrid or Mailgun), which means an account, an API key, a sending domain, and DNS records. That is
more setup than the whole comment system.

**What is genuinely missing without notification:** a reader who never reopens the document never learns
that their comment was answered. The Slack webhook covers the team channel case, which is the real one
here. Accept the gap and write it down.

---

## 11. The three environments

| | Hosted on Netlify | Claude artifact | Plain file (`file://`) |
|---|---|---|---|
| Document renders | Yes | Yes | Yes |
| Theme toggle, deep links | Yes | Yes | Yes |
| `data-aid` attributes present | Yes | Yes | Yes |
| Comment UI | Full | **Absent** | **Absent** |
| Why | — | CSP blocks `connect-src` to every host | `fetch` from `file://` fails |
| Reader sees | Markers, highlights, panel | One line: "Comments are not available in this view" | Nothing. The document as it is today |

The guard in section 8.1 produces all three rows. There is no separate build and no second template.

### Optional: a read-only snapshot in the plain file

The builder can bake the current threads into the file, so an offline reader sees the discussion as
static text.

```bash
templates/build example --with-comments
```

**Rust makes this more expensive than Python did, and the plan rejects it.** The Python version cost
about 25 lines because `urllib.request` is in the standard library. Rust's standard library has no HTTP
client and no TLS, so the fetch must shell out to `curl` through `std::process::Command`, or a crate
must be added. Adding a crate ends the zero-dependency rule for one optional flag.
`00-integration-plan.md` section 4.2 rejects `--with-comments` on a separate ground: it makes `dist/` a
function of the network and breaks the CI staleness check. Treat this subsection as a record of the
option, not as work to do.

The flag is **off by default**. Without it the build makes no network call and works on a plane. With it,
The builder fetches `/api/threads?doc=...` and writes:

```html
<script type="application/json" id="cmt-seed">[ ... ]</script>
```

`comments.js` reads the seed when it cannot reach the API, and renders the panel **read-only**: no reply
box, no resolve button, a banner saying "Snapshot from 2026-09-01. Open the hosted document to reply."

This is worth building **after** the hosted version works, not before. It is the feature that makes a
document you email to somebody still useful.

---

## 12. Existing implementations, and whether to depend on any

| Project | Version and date | Verdict |
|---|---|---|
| [W3C Web Annotation Data Model](https://www.w3.org/TR/annotation-model/) | Recommendation, 2017-02-23 | **Borrow the vocabulary.** `TextQuoteSelector` with `exact`/`prefix`/`suffix` is exactly our anchor shape. Using its field names costs nothing and makes the data readable by anyone who knows the spec. Do not implement the whole model. We need one selector type, not seven |
| [Hypothesis client](https://github.com/hypothesis/client) | Active | **Borrow the strategy, not the code.** Try selectors in order; treat the quote as the durable one; show orphans rather than hiding them. The code is built for annotating third-party pages inside a browser extension. We control the page, which is a much easier problem |
| Apache Annotator | 0.2.0, published 2021-09-03. **Retired from the Apache Incubator on 2025-08-11** | **No.** The retirement settles it. Also 202 KB unpacked, and it pulls `@babel/runtime-corejs3` and `optimal-select` |
| [`dom-anchor-text-quote`](https://www.npmjs.com/package/dom-anchor-text-quote) | 4.0.2, published **2017-02-10** | **No.** Nine years without a release. Pulls `diff-match-patch` for fuzzy search we do not want |
| [`approx-string-match`](https://www.npmjs.com/package/approx-string-match) | 2.0.0, published 2021-11-23, MIT, **zero deps, 19.5 KB unpacked** | **The only one I would consider.** It is the bitap matcher Hypothesis extracted. If client-side fuzzy anchoring ever becomes necessary, vendor this single file into `templates/base/` rather than adding npm. It is not necessary now, because the build-time alignment in `anchors.rs` does the same job with more context and no bytes in the document |
| [`@recogito/text-annotator`](https://github.com/recogito/text-annotator-js) | 4.2.6, published **2026-09-01**, BSD-3 | **No, and it hurts to say so.** It is actively maintained, W3C-aligned, and does exactly this. It is also **543 KB unpacked with 9 dependencies** including `rbush`, `hotkeys-js` and `uuid`. That is ten times the size of the document it would annotate, and it needs a bundler, which ends the one-command, no-package-manager story |
| [`text-fragments-polyfill`](https://www.npmjs.com/package/text-fragments-polyfill) | 6.7.0, 2025-11-10, Apache-2.0, zero deps, 167 KB | **No, but note it.** Native text fragments (`#:~:text=`) are widely supported. A "copy link to this comment" feature can emit `#thread-<id>` and let our own code scroll, which is simpler and works everywhere |
| [giscus](https://giscus.app) (GitHub Discussions in an iframe) | Active | **A serious alternative for the unanchored half only.** It gives threading, authentication, notification and moderation for zero code. It cannot anchor to a passage, it is an iframe from `giscus.app` so it dies under the artifact CSP, and it would split the system into two data models with two notification paths. Reject, but reconsider if the anchored half is ever cut from scope |
| [CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API) | Baseline June 2025 | **Use it.** It is a platform feature, not a dependency. Section 8.5 |
| Netlify Forms | Free and unlimited submissions | **No.** Free storage is attractive, but there is no read API without a Netlify personal access token, and no thread structure |

**Verdict: no runtime dependency.** `@netlify/blobs@11.0.2` runs on the server. Nothing is added to the
document.

The one thing worth stealing wholesale is the **vocabulary**. Name the fields `exact`, `prefix`, `suffix`.
A future migration to any annotation tool then becomes a field rename.

---

## 13. What I would not do

- **A React rewrite, or a static-site generator.** The document is 40 KB and self-contained. React and
  ReactDOM alone are about 140 KB minified. A framework would make the artifact target harder, add a
  bundler, add `package.json`, and end the "edit a fragment, run one command" path. The comment
  feature needs about 400 lines of DOM code. That is not a framework's worth of complexity.
- **XPath or CSS-selector anchors.** Section 3.1C. They break on the first template change.
- **Content-hash-only block ids.** They orphan a comment the moment somebody fixes a typo, which is
  precisely when the comment matters.
- **Client-side fuzzy matching.** It hides failure instead of reporting it, and Hypothesis has the
  performance bug to prove the cost. The build has more context and no time limit.
- **DOM mutation for highlights.** `<mark>` wrappers invalidate every other thread's text offsets and
  need interval splitting for overlaps.
- **Netlify DB.** Section 6.3. It costs credits now and buys queries we do not have.
- **Comments stored in git.** Every comment becomes a deploy, and a deploy costs 15 of 300 free credits.
- **One blob per document.** It puts every reply into one compare-and-swap contention point for a saving
  of about 150 ms on load.
- **Realtime updates.** No websockets, no polling loop, no server-sent events. Refresh on focus
  (`document.addEventListener("visibilitychange", ...)`, throttled to once per 30 s) covers every real case
  for tens of readers.
- **Delete.** Section 9.
- **Email notification.** Section 10.
- **Nested reply trees.** One level of replies.

---

## 14. Cost and limits

### Netlify free plan: 300 credits per month

| Meter | Rate | Comment traffic, 40 readers × 20 visits/month | Credits |
|---|---|---|---|
| Web requests | 2 per 10,000 | ~2,400 API calls | **0.5** |
| Compute | 10 per GB-hour | 2,400 × 200 ms × 1 GB ≈ 0.13 GB-h | **1.3** |
| Bandwidth | 20 per GB | ~10 MB of JSON | **0.2** |
| Blobs storage | not separately metered in the published rates | ~2 MB | **0** |
| **Comment feature total** | | | **~2 credits/month** |
| Production deploys | 15 each | | **15 per deploy** |

**The comment feature is free. Deploys are the constraint.** 300 credits divided by 15 is **20 production
deploys per month** on the free plan. A documentation repository that publishes edits often will hit that
before it notices any comment cost. Budget for the Personal plan at $9/month for 1,000 credits, which is
about 66 deploys, and note that the free plan is a **hard cap**: at 300 credits the sites pause until the
next month.

I could not confirm whether deploy previews are metered at the same rate as production deploys. Check
before assuming.

### Hard limits that matter

| Limit | Value | When it bites |
|---|---|---|
| Blob object size | 5 GB | Never |
| Blob key length | 600 bytes | Never |
| Blob metadata | 2 KB | Do not put comment bodies in metadata |
| Blob consistency | eventual, up to 60 s | **Always.** Use `consistency: "strong"` |
| Function response | 20 MB (streaming) | About 4,000 threads. Never |
| Threads per document before load feels slow | roughly 200 | Move to a per-document index blob, then to Postgres |

### Where this design breaks

- **Past ~200 threads per document**, the fan-out read gets slow. Fix: one index blob per document holding
  thread summaries, written on create and on resolve only. Full thread bodies stay per-blob.
- **Past ~10 simultaneous writers on one thread**, the three-try compare-and-swap starts returning 409.
  Fix: raise `MAX_TRIES` and add jitter. This will not happen with tens of readers.
- **A whole-document rewrite** orphans everything. That is correct behaviour, not a bug, and the build
  report says so.

---

## 15. Build order

Each step is shippable and verifiable on its own.

1. **`templates/docbuild/src/anchors.rs` plus the hook in `main.rs`.** Verify: rebuild `example` twice with no
   change and confirm `anchors.json` is byte-identical. Edit one paragraph, rebuild, and confirm the
   report says `1 edited` and the id in `dist/` is unchanged. No UI yet.
2. **The two Netlify Functions plus `_auth.mjs` stubbed to a fixed user.** Verify with `curl` against
   `netlify dev`: create a thread, list it, reply, resolve, reopen.
3. **`comments.js` read-only.** Load threads, resolve anchors, paint highlights, place markers, render the
   panel. No writing. Verify all four anchor states by hand-editing a section and rebuilding.
4. **Writing.** Selection tooltip, new comment, reply, resolve, reopen.
5. **Real authentication.** Replace the `identify` stub. Depends on the authentication area.
6. **The Slack webhook.**
7. **Optional: the `--with-comments` offline snapshot.**

Step 1 is the one to get right. Its algorithm was tested as Python and section 4.3 records the results.
The Rust in section 4.1 is a specification, not tested code, and section 4.5 lists what it leaves
unspecified. Steps 2 to 4 are ordinary work.

---

## 16. Dependencies on other areas

| Area | What this area needs | How hard the coupling is |
|---|---|---|
| **Authentication** | `identify(req, context) -> {sub, name, email} \| null`, with `sub` stable per person. Same-origin cookie session preferred, so the client `fetch` needs only `credentials: "same-origin"` | **Blocking for step 5 only.** A stub unblocks steps 1 to 4 |
| **Inline text editing** | **The sharpest coupling in the project.** A reader edit changes block text, so it must go through the same alignment. If editing writes back to `sections/*.html` and rebuilds, this design already handles it. If editing patches the DOM live without a rebuild, anchors and `anchors.json` drift apart and comments start mis-resolving. **Recommend: reader edits become a change to the section fragment plus a rebuild, never a live DOM patch** | **Design-level. Settle it before either area is built** |
| **History of changes** | Wants an append-only event stream. Comment create, reply, resolve and reopen should emit into it. Suggest one blob store `events` with key `<doc>/<iso-timestamp>-<uuid>.json`. Resolve who owns the writer | **Medium. Agree the event shape early, add the emit later** |
| **Persisted state** | Shares the `localStorage` namespace (`cmt-seen:*`) and, probably, the same `_lib.mjs` blob helper and the same `/api/*` function conventions | **Low. Agree the key prefix and the store names** |
| **Netlify hosting and build** | `netlify.toml` must publish `<instance>/dist/` and set `functions = "netlify/functions"`. Comments need `"comments": true` in `doc.json` and a `{{COMMENTS_JS}}` / `{{COMMENTS_CSS}}` placeholder pair in `templates/base/layout.html` | **Low, but somebody must own `netlify.toml`** |
