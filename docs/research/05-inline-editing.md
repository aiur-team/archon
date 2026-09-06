# Inline text editing by readers

Research for the `archon` documentation platform. Feature area: a reader with permission
edits text in place, and the change persists.

**Recommendation: Model 1, write back to git as a pull request, with a bounded pending-edit overlay in
Netlify Blobs used only as a cache.** Git stays the single record. The overlay only makes the reader's own
change visible before the deploy lands, and it deletes itself when the deploy lands.

**Written when the builder was Python. Converted to Rust on 2 September 2026.** Every command, module
name and code block below is now the Rust one. Where this document and `00-integration-plan.md`
disagree, the plan is correct.

---

## 1. What I checked, and when

All checks made on **1 September 2026**.

| Thing | Source | Result |
|---|---|---|
| `contenteditable="plaintext-only"` support | caniuse (MDN BCD table) | Chrome 51+, Edge 12+, Safari 5+, **Firefox 136+**. 94.76% global |
| Netlify Blobs API | `docs.netlify.com/build/data-and-storage/netlify-blobs/` | `@netlify/blobs`, `getStore`, `setJSON`, `onlyIfMatch`, `getWithMetadata`. Blob max 5 GB, key max 600 bytes, metadata max 2 KB |
| `@netlify/blobs` latest | npm registry | **11.0.2**, published 2026-08-28 |
| `@netlify/functions` latest | npm registry | **6.0.0**, published 2026-08-18 |
| `@octokit/rest` latest | npm registry | 22.0.1, published 2025-10-31 (I recommend **not** using it, see §8) |
| Rust in the Netlify build image | `docs.netlify.com/build/configure-builds/available-software-at-build-time/` and `.../manage-dependencies/`, re-checked **2 September 2026** | Ubuntu 24.04 Noble. `rustup` and `cargo` are preinstalled, but **no default toolchain is installed**. A `rust-toolchain` file in the base directory, or `rustup toolchain install stable` in the build command, is required |
| Netlify Identity status | Netlify support forum, 19 Feb 2026 | **Not deprecated.** The 2025 deprecation was reversed. Identity stays supported |
| Functions and Identity | `docs.netlify.com/build/functions/functions-and-identity/` | Netlify verifies the `Authorization: Bearer` JWT and puts the claims on `clientContext.user` |
| Free plan limits | Third-party pricing summaries, not Netlify's own page | 300 credits/month, functions 10 credits/GB-hour, 10 s sync timeout |

**Where I am unsure.** Two points.

1. The Functions v2 API reference does not list `clientContext` on the `Context` object. The separate
   "Functions and Identity" page still documents it. I give a fallback in §8 that does not depend on it.
2. I could not find Blobs storage limits or the free-tier credit table on Netlify's own pricing page. The
   credit numbers above come from third-party summaries. Confirm them before you rely on them.

I also measured the real repository. A scan over `*/sections/*.html` finds **79 prose blocks**
(`<p>`, `<h2>`, `<h3>`, `<h4>` that occupy whole lines). The only inline markup in prose is `<strong>`
(10), `<code>` (8) and `<em>` (2). There are no links and no entities, except one `&rarr;` in the
component reference. This measurement decides the design in §6.

---

## 2. The three models

The tension is real. `sections/*.html` in git is the source. `dist/*.html` is a build artifact. A reader
edits the artifact. The edit must reach the source, or the source and the page separate.

### Model 1 — write back to git through the GitHub API

The function commits to a branch and opens a pull request.

**For.** Git stays canonical. There is one record, not two. Review, history, blame, revert and attribution
all come free from tools the team already runs. The plain-file copy stays true. A reviewer who clones the
repo reads the current text. The next build produces the current page. Nothing drifts.

**Against.** The function needs a repository write token. That token is the largest new piece of attack
surface in the whole platform. An edit takes a few seconds, not milliseconds. Worst of all, the reader does
not see the change on the live page until the pull request merges and Netlify redeploys. Without a fix,
the reader presses save and nothing appears to happen.

### Model 2 — overlay in the state store, applied at render time

The function writes the new text to Netlify Blobs. The page fetches the overlay and patches the DOM.

**For.** Instant. No token. No conflict at write time. Any reader can edit.

**Against.** The page permanently disagrees with git. There are now two sources of truth, and the one in
git is the stale one. Everybody who reads the repository, opens the file from disk, or opens the published
artifact reads text that is out of date. That breaks the second constraint, not in letter but in
substance: the file still renders, but it renders the wrong words. The overlay must also be re-applied on
every load, so the reader sees the old text for a moment before the patch. Orphans accumulate as sections
change. Nothing ever reconciles.

### Model 3 — suggestions only, a human applies them

The reader proposes text. The proposal goes into a queue. A maintainer edits the section file by hand.

**For.** Cheapest to build. No write token. No conflicts. It suits a small internal team.

**Against.** It earns almost nothing over the commenting feature. A suggestion is a comment with a proposed
replacement string. If the platform builds threaded commenting, and it does, then Model 3 is a comment
template plus a badge. Building it as a separate subsystem duplicates the comment store, the comment UI
and the comment notification path. It is also the model most likely to rot: a queue nobody drains is worse
than no queue.

### Comparison

| | Model 1, git PR | Model 2, overlay | Model 3, suggestions |
|---|---|---|---|
| Source of truth | git | split | git |
| Reader sees the change | after merge and deploy | instantly | never, until applied |
| Plain file stays correct | yes | **no** | yes |
| Review before publish | yes, the PR | none | yes, by hand |
| New secret needed | repo write token | none | none |
| Attribution | commit author and PR | store field | store field |
| Conflict handling | needed, §9 | not needed | not needed |
| Build effort | 2 to 3 days | 1 day | half a day on top of comments |
| Ongoing burden | token rotation | reconciling the drift, forever | draining the queue, forever |

---

## 3. Recommendation, and why

**Take Model 1. Add a pending-edit cache from Model 2, strictly bounded.**

The reason is the last row of the table. Model 2 and Model 3 both look cheaper on day one and both create
a permanent human task. Model 2 makes somebody reconcile the overlay against git forever. Model 3 makes
somebody drain a queue forever. Model 1 makes somebody rotate a token once a year. For a tool with tens of
readers and no owner with spare time, the once-a-year job wins.

The only genuine defect of Model 1 is that the reader gets no feedback. Fix that with the smallest possible
piece of Model 2:

- On save, the function commits to git **and** writes the new text to a Blobs store, together with the
  hash of the source text it replaced.
- On load, the page fetches the pending map and applies it, with a visible "pending review" marker.
- On the next deploy, the builder writes a new manifest. Any pending entry whose recorded source hash no
  longer matches the built document is dropped. The cache empties itself.

The overlay is therefore never the record. It is a receipt with an expiry date. It holds only edits that
are in flight. If Blobs loses everything tomorrow, no content is lost, because the content is in git.

**Direct commit to `main` instead of a pull request?** No, not by default. A pull request costs one extra
API call and gives you a review gate on a document that carries a "Draft for engineering review" status
chip. If a specific document wants direct commits later, that is a two-line change in the function: skip
the pull request call and set `branch` to `main`. Do not add the switch until somebody asks.

---

## 4. What must never be reader-editable

State this plainly, because it is the part an implementer will get wrong.

| Never editable | Why |
|---|---|
| The section metadata comment (`id`, `label`, `summary`) | `id` is the anchor, the jump-nav target, and the anchor for comments and deep links. Change it and every existing link to the section breaks |
| The `<!-- peek -->` block | It is the closed-state view. It is a diagram or a table, not prose. It is the only thing most readers see, so it is the worst place for an unreviewed change |
| Any element that carries a `class` or other attribute | Class names carry meaning. `ok`, `warn` and `risk` are defined by a legend inside each document. Editing text inside a `.pill ok` invites a reader to change a guarantee by editing a word |
| Table cells (`<th>`, `<td>`) | Cells hold pills, tags and single words that the surrounding table's header defines. Version 1 excludes them. Revisit only after the prose path has run for a month |
| `<pre>` and fenced code | Whitespace is significant. Backticks in the plain-text edit format collide with code content |
| Diagram markup: `.flow`, `.node`, `.arrow`, `.band`, `.seq`, `.phases` | This is geometry expressed as markup. A text edit changes layout |
| `<summary>` of a `<details class="dx">` | It contains the `.dxn` letter badge as a sibling span. A plain-text edit deletes the badge |
| `doc.json` | Title, eyebrow, status chip, lede, masthead metadata and footer. These are the document's identity and its published status. A status chip that says "Draft" is a claim about process, not prose |
| `dist/*.html` | Build output. An edit written there is destroyed by the next build, silently |
| `templates/base/*` and `templates/docbuild/src/*` | One bad edit breaks every document at once |

**What is editable:** body paragraphs and body headings, and nothing else. That is `<p>`, `<h2>`, `<h3>`
and `<h4>` inside the `<!-- body -->` region, when the element occupies whole lines on its own and contains
no other block tag. In the current repository that is 79 candidate blocks, which is where nearly all the
words are.

---

## 5. Making a region editable

The builder decides. The author writes nothing new. This preserves the zero-dependency authoring path
exactly: a writer still edits an HTML fragment and runs one command.

Add `templates/docbuild/src/editable.rs`. It runs over the body only, never the peek. The public
signature is fixed by `00-integration-plan.md` section 4.1. Do not change it.

```rust
//! Mark the blocks a reader may edit, and build the manifest rows.
//!
//! A block is editable when it occupies whole lines on its own, holds no
//! other block tag, and survives the inline round trip (see inline_md.rs).
//!
//! No crates. The two patterns the Python expressed as regular expressions
//! are hand-written scans here, the way main.rs hand-writes find_placeholders().

use crate::{inline_md, Doc, Section};
use std::path::Path;

const EDITABLE: [&str; 4] = ["p", "h2", "h3", "h4"];
const NESTED: [&str; 11] =
    ["div", "table", "ul", "ol", "pre", "details", "section", "p", "h1", "h2", "h3"];

pub struct ManifestRow {
    pub eid: String,
    pub file: String,
    pub section: String,
    pub ordinal: usize,
    pub tag: String,
    pub hash: String,
}

/// Add data-editable and data-md to blocks that pass the policy, in place.
/// Requires data-aid to be present already.
/// Returns the manifest rows, keyed later by aid.
pub fn mark_editable(
    sections: &mut [Section],
    doc: &Doc,
    inst: &Path,
) -> Result<Vec<ManifestRow>, String>;
```

What it does, per section body. The behaviour is unchanged from the Python this replaces.

- Find each candidate: a line whose only content is `<p>`, `<h2>`, `<h3>` or `<h4>`, its inner text, and
  the matching close tag. The Python anchored this with `^([ \t]*)<(p|h2|h3|h4)>(.+?)</\2>[ \t]*$` under
  `re.M | re.S`. In Rust, iterate the body line by line, keep the leading whitespace, and accept the line
  when it starts with one of `EDITABLE` in a bare open tag and ends with the matching close tag. A block
  that spans lines is not a candidate, which is what the anchors already meant.
- Increment `ordinal` for **every** candidate, then reject the block if its inner text holds any tag in
  `NESTED`, or if `inline_md::to_html(&inline_md::to_md(inner)) != inner`.
- Derive the id from `"{doc_name}|{section_id}|{ordinal}"`. The Python took the first twelve characters
  of `hashlib.sha256`. Rust has no digest in its standard library, so use the same hand-written FNV-1a
  that `anchors.rs` uses and take twelve hexadecimal characters. The `hash` field on the row is the same
  function over `inner`. **This is change detection, not a cryptographic guarantee**, which is all
  section 9 asks of it: it must notice that the source moved under a pending edit.
- Splice ` data-eid="..."` into the open tag, and ` data-md="..."` as well when `md != inner`.

Two details matter.

**`ordinal` counts every candidate, not every accepted one.** A block that fails the gate still consumes
an ordinal. If it did not, adding one entity to a paragraph would renumber every block after it.

**`data-md` is only emitted when the block contains inline markup.** In the measured repository that is 20
of 79 blocks. The page grows by a few hundred bytes, not by the size of its prose. Blocks without `data-md`
are edited as `textContent`.

`ManifestRow` needs the section's source filename, and the `Section` struct in `main.rs` does not carry
one today. Add a `file: String` field to `Section` and set it in `parse_section()`, which already has the
path. That is a one-line change in a struct P1-B owns.

Write the manifest next to the built HTML. There is no `json.dumps`, so this is string formatting, the
same way `render_section()` formats HTML:

```rust
fn write_manifest(inst: &Path, instance: &str, rows: &[ManifestRow]) -> Result<(), String> {
    let commit = std::env::var("COMMIT_REF").unwrap_or_default();  // Netlify sets this
    let blocks = rows
        .iter()
        .map(|r| {
            format!(
                "  \"{eid}\": {{ \"file\": \"{file}\", \"section\": \"{sec}\", \
                 \"ordinal\": {ord}, \"tag\": \"{tag}\", \"hash\": \"{hash}\" }}",
                eid = r.eid, file = r.file, sec = r.section,
                ord = r.ordinal, tag = r.tag, hash = r.hash,
            )
        })
        .collect::<Vec<_>>()
        .join(",\n");
    let json = format!(
        "{{\n \"doc\": \"{instance}\",\n \"commit\": \"{commit}\",\n \"blocks\": {{\n{blocks}\n }}\n}}\n"
    );
    let out = inst.join("dist").join(format!("{instance}.edit.json"));
    std::fs::write(&out, json).map_err(|e| format!("{}: {e}", out.display()))
}
```

**The `built` timestamp is dropped.** The Python wrote `datetime.datetime.now(datetime.UTC)`. Rust's
standard library has no calendar: `SystemTime` gives seconds since the Unix epoch and nothing that formats
them. Either write the epoch seconds, or drop the field. Drop it. `commit` is what §9 actually uses, and a
build timestamp would also make the manifest change on every rebuild, which `00-integration-plan.md`
section 4.2 forbids for anything committed.

`COMMIT_REF` is what lets the function tell which commit the reader was reading. That is the base for
conflict detection in §9.

---

## 6. Capturing a change without a rich-text editor

### The format

The reader edits **plain text with three inline marks**. Nothing more.

| Source HTML | What the reader sees and edits |
|---|---|
| `<strong>x</strong>` | `**x**` |
| `<em>x</em>` | `*x*` |
| `<code>x</code>` | `` `x` `` |

There are no links in prose in this repository, so links are not supported. A block containing a link
fails the round-trip gate and is not editable. That is the correct outcome: it is honest, and it costs
nothing today.

`templates/docbuild/src/inline_md.rs`, the whole thing:

```rust
//! Three inline marks, both directions. Deliberately not Markdown.
//!
//! No regex crate. Each mark is a delimiter scan, which is all the three
//! patterns ever were.

/// Replace every `<tag>...</tag>` with `open`...`close`. First close wins,
/// which is what the non-greedy `(.*?)` meant.
fn untag(h: &str, tag: &str, open: &str, close: &str) -> String {
    let (o, c) = (format!("<{tag}>"), format!("</{tag}>"));
    let mut out = String::new();
    let mut rest = h;
    while let Some(a) = rest.find(&o) {
        let after = &rest[a + o.len()..];
        let Some(b) = after.find(&c) else { break };
        out.push_str(&rest[..a]);
        out.push_str(open);
        out.push_str(&after[..b]);
        out.push_str(close);
        rest = &after[b + c.len()..];
    }
    out.push_str(rest);
    out
}

/// Wrap every `d`-delimited run in `<tag>`. The run must be non-empty and must
/// hold no delimiter character, which is what keeps `*` and `**` apart.
fn wrap(t: &str, d: &str, tag: &str) -> String {
    let ch = d.as_bytes()[0] as char;
    let mut out = String::new();
    let mut rest = t;
    while let Some(a) = rest.find(d) {
        let after = &rest[a + d.len()..];
        let run = after.split(ch).next().unwrap_or("");
        if run.is_empty() || !after[run.len()..].starts_with(d) {
            out.push_str(&rest[..a + d.len()]);
            rest = after;
            continue;
        }
        out.push_str(&rest[..a]);
        out.push_str(&format!("<{tag}>{run}</{tag}>"));
        rest = &after[run.len() + d.len()..];
    }
    out.push_str(rest);
    out
}

pub fn to_md(h: &str) -> String {
    let s = untag(h, "code", "`", "`");
    let s = untag(&s, "strong", "**", "**");
    let s = untag(&s, "em", "*", "*");
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

pub fn to_html(t: &str) -> String {
    let s = t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let s = wrap(&s, "`", "code");
    let s = wrap(&s, "**", "strong");
    wrap(&s, "*", "em")
}
```

**`**` before `*` replaces the two lookarounds.** The Python needed `(?<!\*)` and `(?!\*)` on the `em`
pattern to stop it eating half of a `**` pair. `wrap` runs `**` first and refuses a run that holds the
delimiter character, so by the time `*` is scanned no `**` pair is left. The behaviour is the same and
there is nothing to look behind.

### The round-trip gate is the safety property

A block becomes editable only if `to_html(to_md(inner)) == inner`. Anything the converter cannot represent
is demoted to read-only automatically. No block can be silently mangled.

I ran this gate over every section file in the repository today, **as Python: 78 of 79 blocks pass.**
The one failure is `templates/components/sections/02-diagrams.html`, which contains `&rarr;` between code
spans. That block becomes read-only, correctly and without anyone having to notice.

**The Rust above is a translation and has not been run.** It is written to behave identically, but the
78-of-79 count is a measurement of the Python. `00-integration-plan.md` makes re-running the gate in Rust
an acceptance check on P2-D. Do that before you trust the converter.

The builder should print the count, next to the existing tag-balance and size checks:

```
  editable blocks  78 of 79 (1 demoted: entity or unsupported markup)
```

### `contenteditable="plaintext-only"`

Use it. Checked on caniuse on 1 September 2026: Chrome 51+, Edge 12+, Safari 5+, Firefox 136+, 94.76%
global coverage. Firefox is the recent arrival; Firefox 136 shipped in March 2025. For an internal audience
on evergreen browsers this is fully supported today.

It matters because `contenteditable="true"` lets a paste bring `<span style=...>`, `<b>` and `<font>` into
the DOM. `plaintext-only` refuses all of it. The saved value is then just `textContent`, and the three
inline marks are the only formatting anyone can express.

Detect it correctly. Assigning an unsupported value throws in some engines, so wrap the probe:

```js
var PLAINTEXT_OK = (function () {
  try {
    var d = document.createElement('div');
    d.contentEditable = 'plaintext-only';
    return d.contentEditable === 'plaintext-only';
  } catch (e) { return false; }
})();
```

The fallback for the residual 5% is `contenteditable="true"` plus a paste handler. It is nine lines:

```js
function makeEditable(el) {
  el.setAttribute('contenteditable', PLAINTEXT_OK ? 'plaintext-only' : 'true');
  if (!PLAINTEXT_OK) el.addEventListener('paste', function (e) {
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });
}
```

`document.execCommand` is deprecated but still works everywhere, and it is only reached on the fallback
path. I would not add a library to avoid it.

### Dependency weight

**Zero new runtime dependencies on the page.** No rich-text editor. For comparison, the smallest credible
alternatives are roughly 40 KB minified for Quill, and ProseMirror is larger still once you assemble the
modules it needs. Either one would more than double a 40 KB document, and both would break the
single-file constraint the moment they wanted a stylesheet from a CDN the artifact CSP blocks.

### The client, in full

Add to `templates/base/app.js`, inside the existing IIFE. All of it is behind one guard, so a file opened
from disk runs none of it.

```js
  /* ---- inline editing. Absent when opened from disk or when signed out. ---- */
  var EDIT = { user: null, blocks: {} };

  function textOf(el) {
    return el.dataset.md !== undefined ? el.dataset.md : el.textContent;
  }

  function armBlock(el) {
    var eid = el.dataset.eid, original = textOf(el);
    el.classList.add('editable');
    el.addEventListener('dblclick', function () {
      if (el.isContentEditable) return;
      el.dataset.before = original = textOf(el);
      el.textContent = original;              // show the marks, not the markup
      makeEditable(el);
      el.focus();
    });
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { el.textContent = el.dataset.before; el.blur(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.blur(); }
    });
    el.addEventListener('blur', function () {
      el.removeAttribute('contenteditable');
      var next = el.textContent.trim();
      if (next === el.dataset.before || !next) { el.textContent = el.dataset.before; return; }
      save(eid, next, el);
    });
  }

  function save(eid, text, el) {
    el.classList.add('saving');
    fetch('/api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json',
                 authorization: 'Bearer ' + EDIT.user.token.access_token },
      body: JSON.stringify({ doc: document.documentElement.dataset.doc, eid: eid, text: text })
    }).then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); })
      .then(function (res) {
        el.classList.remove('saving');
        if (res.s === 409) { el.classList.add('conflict'); el.textContent = res.b.current; return; }
        if (res.s !== 200) { el.classList.add('failed'); el.textContent = el.dataset.before; return; }
        el.classList.add('pending');
        el.title = 'Pending review in ' + res.b.pr;
      })
      .catch(function () { el.classList.remove('saving'); el.classList.add('failed');
                           el.textContent = el.dataset.before; });
  }

  if (location.protocol !== 'file:' && window.netlifyIdentity) {
    window.netlifyIdentity.on('init', function (u) {
      if (!u) return;                                    // signed out: read-only, no listeners
      EDIT.user = u;
      fetch('/api/pending?doc=' + document.documentElement.dataset.doc)
        .then(function (r) { return r.json(); })
        .then(function (p) {
          Object.keys(p).forEach(function (eid) {
            var el = document.querySelector('[data-eid="' + eid + '"]');
            if (!el) return;
            el.textContent = p[eid].text;
            el.classList.add('pending');
            el.title = 'Pending review, by ' + p[eid].by;
          });
        })
        .catch(function () {})                           // no network: the built text stands
        .then(function () { document.querySelectorAll('[data-eid]').forEach(armBlock); });
    });
  }
```

The graceful-degradation contract is one line: **nothing above runs unless the protocol is not `file:`
and an identity exists.** No `contenteditable` attribute is ever set. No pencil appears. The document
renders and reads exactly as it does today. Add `data-doc="{{DOC}}"` to the root element in
`layout.html` so the client knows which document it is.

CSS, in `components.css`, using existing tokens:

```css
[data-eid].editable:hover { outline:1px dashed var(--border-strong); outline-offset:4px; cursor:text }
[data-eid][contenteditable] { outline:2px solid var(--accent); outline-offset:4px; white-space:pre-wrap }
[data-eid].saving  { opacity:.55 }
[data-eid].pending { border-left:2px solid var(--warn); padding-left:.7em; margin-left:-.7em }
[data-eid].conflict{ border-left:2px solid var(--risk); padding-left:.7em; margin-left:-.7em }
[data-eid].failed  { border-left:2px solid var(--risk); padding-left:.7em; margin-left:-.7em }
```

---

## 7. Conflict handling

Three checks, in order. Each is cheap.

**Check 1, the manifest commit.** The page ships a manifest built at commit `C`. The function knows the
current head of `main`. If `C` is not the head, the source may have moved. This alone is not a conflict.
It is a hint.

**Check 2, the block hash. This is the one that matters.** The manifest records
`sha256(inner_html_of_the_block)` as built. The function reads the section file at the branch head, runs
the same `BLOCK_RE`, takes match number `ordinal`, and hashes it. If the hashes differ, the underlying text
changed after the reader loaded the page. Reject with **409** and return the current text. The client shows
it with a `conflict` marker so the reader can see what they were about to overwrite and try again.

**Check 3, the GitHub blob sha.** The Contents API needs the file's blob `sha` to update it. If two edits
to the same file race, the second gets **409 Conflict** from GitHub. Retry once from step 2. If it fails
again, return 409 to the client. Do not loop.

Note that Check 2 catches the case Check 3 misses: a change to a *different* block in the same file
changes the blob sha but not the reader's block. Retrying from step 2 handles that correctly, because the
block hash still matches and only the file content and sha are re-read.

**Ordinal drift.** If somebody inserts a paragraph into a section between the deploy and the edit,
`ordinal` points at the wrong block. The hash check catches this and rejects. It does not silently write to
the wrong place. That is the whole reason to hash the block rather than trust the ordinal.

**Pending-cache expiry.** Every pending Blobs entry records `baseHash`. On page load, `/api/pending` drops
any entry whose `baseHash` no longer matches the manifest that the deployed page carries. When the pull
request merges and Netlify rebuilds, the merged text is in the built page and the hash has changed, so the
pending entry disappears. No cleanup job is needed.

---

## 8. The function

Two functions. `netlify/functions/edit.mts` writes. `netlify/functions/pending.mts` reads the cache.

### Dependencies

**I would not add Octokit.** `@octokit/rest` 22.0.1 is a large tree for four HTTP calls, and Netlify
Functions run on a Node with global `fetch`. Forty lines of `fetch` are easier to read and impossible to
break with a transitive update. The only runtime dependency is `@netlify/blobs`.

```json
{
  "dependencies": { "@netlify/blobs": "11.0.2" },
  "devDependencies": { "@netlify/functions": "6.0.0" }
}
```

Both versions checked on npm on 1 September 2026. Pin them exactly. Note the Blobs 6.5.0 to 7.0.0 storage
format break in Netlify's docs: starting at 11.x avoids it, but do not downgrade past 7.0.0 later.

### `netlify/functions/edit.mts`

```ts
import type { Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const REPO  = process.env.DOCS_REPO!;                    // "aiur-team/archon"
const BASE  = process.env.DOCS_BASE_BRANCH ?? "main";
const TOKEN = process.env.DOCS_GITHUB_TOKEN!;

const BLOCK_RE = /^([ \t]*)<(p|h2|h3|h4)>([\s\S]+?)<\/\2>[ \t]*$/gm;

async function gh(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { ok: r.ok, status: r.status, body: r.status === 204 ? null : await r.json() };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The twin of inline_md.to_html. Kept in step by a shared fixture, see §11.
function toHtml(t: string) {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
}

const slug = (e: string) => e.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const json = (o: unknown, status = 200) =>
  Response.json(o as Record<string, unknown>, { status });

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);

  // --- identity. Never trust the body for this. ---------------------------
  const user = (context as any).clientContext?.user
            ?? (await identityFallback(req, context));
  if (!user?.email) return json({ error: "sign in to edit" }, 401);
  if (!(user.app_metadata?.roles ?? []).includes("editor"))
    return json({ error: "the editor role is required" }, 403);

  const { doc, eid, text } = await req.json();
  if (typeof doc !== "string" || typeof eid !== "string" || typeof text !== "string")
    return json({ error: "bad request" }, 400);
  if (text.length > 4000) return json({ error: "too long" }, 400);

  // --- resolve the block from the manifest shipped with THIS deploy -------
  // The client never supplies a path. This is what stops arbitrary file writes.
  let manifest: any;
  try {
    manifest = JSON.parse(await readFile(`./${doc}/dist/${doc}.edit.json`, "utf8"));
  } catch { return json({ error: "unknown document" }, 404); }
  const block = manifest.blocks[eid];
  if (!block) return json({ error: "unknown block" }, 404);

  const branch = `docs-edit/${doc}/${slug(user.email)}`;
  const path   = `${doc}/${block.file}`;

  // --- ensure the branch exists -------------------------------------------
  const head = await gh(`/repos/${REPO}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (head.status === 404) {
    const base = await gh(`/repos/${REPO}/git/ref/heads/${BASE}`);
    if (!base.ok) return json({ error: "cannot read the base branch" }, 502);
    const made = await gh(`/repos/${REPO}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.body.object.sha }),
    });
    if (!made.ok && made.status !== 422) return json({ error: "cannot create the branch" }, 502);
  }

  // --- read, verify, replace ----------------------------------------------
  const applied = await applyOnce();
  if (applied.status === 409 && applied.retryable) {
    const again = await applyOnce();                 // one retry, then give up
    return again.response;
  }
  return applied.response;

  async function applyOnce() {
    const file = await gh(
      `/repos/${REPO}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`);
    if (!file.ok) return { status: 502, retryable: false,
                           response: json({ error: "cannot read the section" }, 502) };

    const src  = Buffer.from(file.body.content, "base64").toString("utf8");
    const cut  = src.indexOf("<!-- body -->");
    if (cut < 0) return { status: 409, retryable: false,
                          response: json({ error: "no body marker" }, 409) };
    const head0 = src.slice(0, cut), body = src.slice(cut);

    const hits = [...body.matchAll(BLOCK_RE)];
    const m = hits[block.ordinal - 1];
    if (!m) return { status: 409, retryable: false,
                     response: json({ error: "the section changed", current: null }, 409) };

    if (sha256(m[3]) !== block.hash) {
      // Check 2 failed. Somebody edited this text after the page was built.
      return { status: 409, retryable: false, response: json({
        error: "the source changed since this page was built",
        current: m[3].replace(/<code>(.*?)<\/code>/gs, "`$1`")
                     .replace(/<strong>(.*?)<\/strong>/gs, "**$1**")
                     .replace(/<em>(.*?)<\/em>/gs, "*$1*")
                     .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
      }, 409) };
    }

    const replaced = head0 + body.slice(0, m.index!) +
                     `${m[1]}<${m[2]}>${toHtml(text)}</${m[2]}>` +
                     body.slice(m.index! + m[0].length);

    const put = await gh(`/repos/${REPO}/contents/${encodeURI(path)}`, {
      method: "PUT",
      body: JSON.stringify({
        branch,
        sha: file.body.sha,
        message: `Edit ${block.section} in ${doc}\n\nEdited in place by ${user.email}.\n` +
                 `Base build ${manifest.commit || "unknown"}.\n\n` +
                 `Co-authored-by: ${user.user_metadata?.full_name ?? user.email} <${user.email}>`,
        content: Buffer.from(replaced, "utf8").toString("base64"),
        author:    { name: user.user_metadata?.full_name ?? user.email, email: user.email },
        committer: { name: "architecture-docs bot", email: process.env.DOCS_BOT_EMAIL! },
      }),
    });
    if (put.status === 409) return { status: 409, retryable: true,
                                     response: json({ error: "conflict" }, 409) };
    if (!put.ok) return { status: 502, retryable: false,
                          response: json({ error: "cannot write" }, 502) };

    // --- one pull request per reader per document -------------------------
    const owner = REPO.split("/")[0];
    const open = await gh(
      `/repos/${REPO}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=open`);
    let pr = open.ok && open.body.length ? open.body[0] : null;
    if (!pr) {
      const made = await gh(`/repos/${REPO}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: `Inline edits to ${doc} from ${user.email}`,
          head: branch, base: BASE,
          body: `Edits made in place on the hosted document by **${user.email}**.\n\n` +
                `Each commit is one block. Review the diff, not the page.`,
        }),
      });
      if (made.ok) pr = made.body;
    }

    // --- pending cache. Not the record. Just a receipt. --------------------
    const store = getStore({ name: "doc-edits", consistency: "strong" });
    await store.setJSON(`${doc}/${eid}`, {
      text, by: user.email, at: new Date().toISOString(),
      baseHash: block.hash, pr: pr?.number ?? null,
    });

    return { status: 200, retryable: false,
             response: json({ ok: true, pr: pr ? `#${pr.number}` : null,
                              url: pr?.html_url ?? null }) };
  }
};

/** Used only if clientContext.user is absent. Verifies the token with GoTrue. */
async function identityFallback(req: Request, context: Context) {
  const auth = req.headers.get("authorization");
  const url  = (context as any).clientContext?.identity?.url;
  if (!auth || !url) return null;
  const r = await fetch(`${url}/user`, { headers: { authorization: auth } });
  return r.ok ? await r.json() : null;
}

export const config = { path: "/api/edit" };
```

### `netlify/functions/pending.mts`

```ts
import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";

export default async (req: Request) => {
  const doc = new URL(req.url).searchParams.get("doc") ?? "";
  if (!/^[a-z0-9-]{1,64}$/.test(doc)) return Response.json({}, { status: 400 });

  let manifest: any;
  try { manifest = JSON.parse(await readFile(`./${doc}/dist/${doc}.edit.json`, "utf8")); }
  catch { return Response.json({}, { status: 404 }); }

  const store = getStore({ name: "doc-edits", consistency: "strong" });
  const { blobs } = await store.list({ prefix: `${doc}/` });

  const out: Record<string, unknown> = {};
  await Promise.all(blobs.map(async ({ key }) => {
    const v: any = await store.get(key, { type: "json" });
    const eid = key.slice(doc.length + 1);
    // Self-cleaning. If the deployed build no longer matches, the edit landed.
    if (!v || manifest.blocks[eid]?.hash !== v.baseHash) { await store.delete(key); return; }
    out[eid] = { text: v.text, by: v.by, at: v.at, pr: v.pr };
  }));
  return Response.json(out, { headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/pending" };
```

### `netlify.toml`

```toml
[build]
  command  = "templates/build example && templates/build example"
  publish  = "public"

[functions]
  node_bundler   = "esbuild"
  included_files = ["*/dist/*.edit.json"]
```

**The Noble build image installs no Rust toolchain by itself.** `rustup` and `cargo` are preinstalled,
but Netlify installs no toolchain until you ask for one. Add a `rust-toolchain` file in the base
directory, or `rustup toolchain install stable` before the build command. There is no crate manifest to
fetch, because the builder has no dependencies. Netlify caches the selected toolchain between builds.
Checked 2 September 2026; document 01 section 2 carries the citations and the fallback. Copy each
`dist/*.html` into `public/` as a final build step, or point `publish` at a small script that does it.

### Secrets

| Variable | Value | Scope |
|---|---|---|
| `DOCS_REPO` | `aiur-team/archon` | Functions |
| `DOCS_BASE_BRANCH` | `main` | Functions |
| `DOCS_GITHUB_TOKEN` | fine-grained PAT, **secret** | **Functions only, not Builds** |
| `DOCS_BOT_EMAIL` | the bot's commit email | Functions |

Scope the token to Functions in the Netlify UI. If it is also exposed to Builds, Netlify's secrets scanner
can find it in build output and fail the deploy, which is the good outcome, but the better outcome is not
to expose it.

Token permissions, on that repository only:

- **Contents: Read and write** — needed to read the section file, create the branch, and commit.
- **Pull requests: Read and write** — needed to open and find the pull request.
- **Metadata: Read** — added automatically.

Nothing else. Not Actions, not Administration, not Workflows.

A fine-grained PAT expires, at most one year out. Put the expiry in a calendar. The alternative is a GitHub
App installation, whose tokens rotate automatically. The App is the better long-term answer and roughly a
day more setup. Start with the PAT. Move to the App if this outlives its first token.

---

## 9. Attribution

**Take the identity from the verified token, never from the request body.** The client sends only
`{doc, eid, text}`. The function reads the email from `clientContext.user`, which Netlify populates only
after it verifies the JWT signature.

The commit carries the identity in three places:

1. `author.name` and `author.email` — the reader.
2. `committer` — the bot. This is honest: the bot is what pushed.
3. A `Co-authored-by:` trailer, plus the email in the commit body.

One caveat, and it will surprise people. GitHub links a commit to a profile only when the author email is a
verified email on that account. A work email that is not on the reader's GitHub account produces an
unlinked author with a grey avatar. The commit is still correct and still attributed. If you want the
linked avatar, map the Identity user to a GitHub login once, store it in
`user_metadata.github_login`, and use `<id>+<login>@users.noreply.github.com`.

The pull request body names the reader. The pending cache records `by` and `at`, so the marker on the page
can say who is proposing the change while it waits.

---

## 10. Cost, limits, and where this breaks

Numbers checked 1 September 2026. Netlify's own pricing page did not give me the credit table, so treat
the credit figures as reported by third parties and confirm them.

| Limit | Value | Does it bite? |
|---|---|---|
| Netlify free plan | 300 credits/month, hard stop | Production deploys cost about 15 credits each, so roughly 20 deploys a month. **This is the binding limit** |
| Function compute | 10 credits per GB-hour | An edit takes about 1.5 s at 1 GB. A thousand edits a month is about 4 credits. Negligible |
| Function timeout | 10 s synchronous on free | An edit is four to six GitHub calls. Comfortable, but not if GitHub is slow |
| GitHub REST rate limit | 5,000 requests/hour for a PAT | Each edit uses four to six. Tens of readers cannot reach it |
| Blobs, per blob | 5 GB | A pending edit is under 1 KB |
| Blobs, key length | 600 bytes | `doc/eid` is about 30 bytes |
| Blobs, metadata | 2 KB per blob | Not used here. Everything is in the value |

**Where this breaks.**

- **Deploy count, not compute.** Every merged pull request triggers a rebuild. Twenty deploys a month on
  the free plan is not many if editing catches on. Mitigation: merge edit pull requests in batches, or move
  to the $9/month plan. Budget for the paid plan.
- **Concurrent edits to the same paragraph.** The second reader gets a 409 and sees the first reader's
  text. There is no merge. For tens of readers on a document, this is right. For a live editing session, it
  is not, and this design is not the answer for that.
- **Ordinal drift under heavy source churn.** If somebody restructures a section while pull requests are
  open, those pull requests get harder to merge. Git handles it. The page does not need to.
- **The token is the blast radius.** It can write to the whole repository. The manifest lookup is the only
  thing stopping a caller from choosing a path. Do not ever accept a path from the client. If you add a
  second write path later, re-derive it from the manifest too.
- **Netlify Blobs is eventually consistent by default.** Both functions above use
  `consistency: "strong"`. Do not drop that. Without it, a reader can reload after saving and see the old
  text, which looks exactly like the save failing.

---

## 11. Build order, with acceptance checks

1. **`templates/docbuild/src/inline_md.rs` plus a fixture.** Write `templates/fixtures/inline.json` as
   pairs of `{md, html}`. *Verify:* `to_html(to_md(h)) == h` for every block in every existing section
   file. **78 of 79 is the Python measurement. Re-run the gate in Rust and confirm the same count before
   you trust the converter.** The one demotion is expected.
2. **`editable.rs` marks blocks and writes the manifest.** *Verify:* the built HTML is byte-identical to the
   current build apart from `data-eid` and `data-md`; the manifest has 78 entries; the reported size grows
   by under 2 KB.
3. **A twin check for the TypeScript `toHtml`.** A four-line node script reads the same fixture and asserts
   the same output. *Verify:* it runs in CI and fails when the two converters separate. This is the only
   place the design duplicates logic, so it is the only place that needs a guard.
4. **`pending.mts` and the client read path, no writing.** Seed a blob by hand. *Verify:* the page shows
   the pending marker; the file opened from disk shows the built text and no marker.
5. **`edit.mts` against a scratch repository.** *Verify:* an edit produces a branch, a commit with the
   right author, and one pull request; a second edit adds a commit to the same pull request; a hand-edited
   source file makes the next save return 409 with the current text.
6. **Point it at the real repository, with the `editor` role required.** *Verify:* a reader without the
   role gets 403 and never sees a pencil.

---

## 12. Dependencies on other feature areas

**Hard dependency: authentication (area 01 or 02).** This design assumes three things from it.

1. A verified identity reaches the function, with an email. The code above reads
   `context.clientContext.user` and falls back to a GoTrue `/user` call. If that area chooses Auth0 rather
   than Netlify Identity, only the `identityFallback` function and the client's token source change.
2. A role named `editor` exists on the user. Without roles, every signed-in reader can edit, which is
   probably acceptable internally but should be a decision, not an accident.
3. The client can obtain a bearer token to attach to `fetch`.

Netlify Identity is the simplest fit and, as of 19 February 2026, is no longer being deprecated. That
reversal is recent, so confirm it before committing.

**Conflict to resolve with commenting and threaded discussion (area 03 or 04): block identity.**

Both features need to anchor to a region of the document. I derive `eid` from
`sha256(doc|section|ordinal)`. That id is stable when the block's *text* changes, which is what editing
needs. It is **not** stable when a block is inserted above, which re-numbers everything after it. For
inline editing that is fine, because edits are short-lived and the hash check catches drift. For comments,
which must survive for months, it is not fine: an inserted paragraph would silently move every comment
below it.

Do not average the two designs. Pick one:

- **Option A.** The comment area owns block identity and adds an optional author-written `data-eid` to the
  section markup, which the builder honours and only falls back to the derived id. Costs the author a small
  amount of discipline. Gives both features durable anchors.
- **Option B.** Comments store the anchoring *text*, not just the id, and re-anchor by fuzzy match on load.
  Costs no author discipline. Costs code, and it will sometimes guess wrong.

I recommend Option A, because it is smaller and it fails loudly. Whoever owns commenting should decide, and
inline editing should follow that decision rather than set it.

**Soft dependency: history of changes (area 06).** This design gives that area most of its answer for free.
The history of a paragraph is `git log --follow` on its section file, and every reader edit is a commit
with the reader as author. If that area is planning a separate change log, it should read this first.
