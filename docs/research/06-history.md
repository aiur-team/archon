# History of changes

Research for the archon documentation platform. All external facts were checked on
**1 September 2026**. Where a fact was not confirmed, this document says so.

**Written when the builder was Python. Converted to Rust on 2 September 2026.** Every command, module
name and code block below is now the Rust one. Where this document and `00-integration-plan.md`
disagree, the plan is correct: in particular the plan adds a committed `<instance>/history.json` between
the git read and the build, so that `dist/*.html` stays a pure function of committed files.

---

## 1. Summary

There are two histories. Do not mix them.

| | Document history | Annotation history |
|---|---|---|
| What it is | The sequence of published versions | The sequence of comments and reader edits |
| Source of truth | Git commits that touch the source fragments | An append-only event log in Netlify Blobs |
| Who writes it | Writers, through commits | Readers, through the page |
| Mutability | Immutable | Append-only, with tombstones |
| Retention | Forever. It is git | 18 months, then hard delete |
| Needs a server | No | Yes |

The recommendation is small. **Bake the document history into the HTML at build time.** `history.rs` reads
`git log` on the writer's machine, computes per-section diffs, and embeds a small JSON block. The page
reads that block and a `localStorage` marker to answer *"what changed since I last read this"*. This needs
no server, no token, no network, and no new dependency. It works from disk.

Annotation history is a second, later layer. It is an event log, not a mutable comment list.

---

## 2. What git already gives, free

The repository is `aiur-team/archon`. A document is an instance directory:

```
example/
  doc.json            metadata
  sections/*.html     the source the writer edits
  extra.css           optional
  dist/example.html   the build output, committed
```

Git already holds a complete, attributed, immutable version history of that directory. You do not need to
build one. You need to **surface** it.

Three facts decide how.

**Fact 1. The repository is private.** An unauthenticated `GET https://api.github.com/repos/aiur-team/archon`
returned HTTP 404 on 1 September 2026. A 404 is how GitHub hides a private repository. So the page cannot
call the GitHub API from the browser. Any live history read needs a server-side token.

**Fact 2. `dist/` is committed.** A naive `git log -- example` therefore lists commits that only
changed the generated file. Restrict the pathspec to the source:

```
example/sections  example/doc.json  example/extra.css
```

This single pathspec is the "diff the source, not the output" rule, expressed once.

**Fact 3. Netlify's clone depth is not documented.** Netlify's build docs do not state whether the build
container gets a full clone or a shallow one. A 2019 request asked Netlify to shallow-clone
([netlify/build-image#317](https://github.com/netlify/build-image/issues/317)); the repository is archived
and the current docs are silent. A shallow clone would silently produce a one-entry changelog, and the
failure would look like a correct build.

Therefore: **read git on the writer's machine, not in the Netlify build.** The writer already runs
`templates/build example`. Git history is complete there. The result is committed with
the `dist/` file, so the deployed page carries its own history.

### 2.1 Reading commit history through the GitHub API

You do not need this for the recommended design. It is written here because a later feature may want live
history, and because a reader of this document should be able to copy it.

The endpoint is `GET /repos/{owner}/{repo}/commits` (checked 1 September 2026). Relevant parameters:

| Parameter | Meaning |
|---|---|
| `path` | "Only commits containing this file path will be returned." One path only |
| `since`, `until` | ISO 8601 bounds |
| `per_page` | Max 100 |
| `page` | 1-based |

Each item gives `sha`, `commit.author.date`, `commit.message`, `author.login`, and `html_url`.

The `path` parameter accepts one value. For three source paths, make three calls and merge by `sha`, or
pass the directory `example/sections` and accept that `doc.json` changes are missed. Merging is
cheap; do that.

To read a fragment at a past commit, use `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` with the
header `Accept: application/vnd.github.raw+json`. Files up to 1 MB support every media type; 1–100 MB
supports only `raw` and `object`. Section fragments are a few KB, so this never matters.

Rate limits, from GitHub's REST rate-limit page (checked 1 September 2026):

| Credential | Requests per hour |
|---|---|
| Unauthenticated | 60 |
| Personal access token | 5,000 |
| GitHub App installation | 5,000 baseline, up to 12,500 |

A fine-grained PAT with **Contents: Read** on this one repository is sufficient. 5,000/hour against tens
of readers is not a constraint.

Here is the proxy function, if you build it. It caches into Blobs so the token is used rarely.

```js
// netlify/functions/history.mjs
// Tier 2 only. The recommended design does not need this.
import { getStore } from "@netlify/blobs"

const REPO = "aiur-team/archon"
const SRC = ["sections", "doc.json", "extra.css"]
const TTL_MS = 10 * 60 * 1000

async function gh(path, token) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "architecture-docs",
    },
  })
  if (!res.ok) throw new Error(`github ${res.status} on ${path}`)
  return res.json()
}

export default async (req) => {
  const doc = new URL(req.url).searchParams.get("doc")
  if (!doc || !/^[a-z0-9-]{1,64}$/.test(doc)) {
    return new Response("bad doc", { status: 400 })
  }

  const cache = getStore("history-cache")
  const hit = await cache.getWithMetadata(doc, { type: "json" })
  if (hit && Date.now() - hit.metadata.at < TTL_MS) {
    return Response.json(hit.data)
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) return new Response("no token", { status: 500 })

  const pages = await Promise.all(
    SRC.map((p) =>
      gh(`repos/${REPO}/commits?per_page=30&path=${encodeURIComponent(`${doc}/${p}`)}`, token)
    )
  )

  const bySha = new Map()
  for (const commit of pages.flat()) {
    bySha.set(commit.sha, {
      sha: commit.sha.slice(0, 8),
      date: commit.commit.author.date,
      author: commit.author?.login ?? commit.commit.author.name,
      subject: commit.commit.message.split("\n")[0],
      url: commit.html_url,
    })
  }
  const versions = [...bySha.values()].sort((a, b) => b.date.localeCompare(a.date))

  const body = { doc, versions }
  await cache.setJSON(doc, body, { metadata: { at: Date.now() } })
  return Response.json(body)
}

export const config = { path: "/api/history" }
```

Set `GITHUB_TOKEN` through the Netlify UI or CLI, not in `netlify.toml`. A token in `netlify.toml` is a
token in git.

**A live diff, if you ever need one:** `GET /repos/{owner}/{repo}/compare/{base}...{head}` returns a
`files` array where each entry has a `patch` field holding the unified diff for that file. Filter
`files` by `filename.startsWith(doc + "/sections/")`. I did **not** verify the response's file-count cap
this session; check it before relying on it for a wide comparison.

---

## 3. Diffing: source fragments, not generated HTML

**Diff the source fragments. Never diff `dist/*.html`.** Four reasons, in order of force.

**1. The generated file changes when the document does not.** The builder inlines `theme.css`,
`components.css` and `app.js` into every document. A one-token change to `theme.css` rewrites the
generated file of every document in the repository. A dist diff would report a change to the Architecture
document that the Architecture document did not make. That is not a small problem. It is a diff that
lies.

**2. The generated file has no useful line structure.** It is a 30–50 KB blob of interleaved CSS, markup
and script. Line-based diff tools produce hunks that straddle a stylesheet and a table. Nobody reads
those.

**3. The fragment is the unit the reader already navigates.** Every section file carries `id` and
`label` metadata that the builder turns into an anchor and a nav entry. A diff scoped to
`sections/03-architecture.html` maps one-to-one onto the "Architecture" section the reader can jump to.
That mapping is the whole feature. A dist diff cannot produce it, because by then the section boundary
is gone.

**4. The fragment diff is smaller.** A version's fragment diff is a few hundred bytes. Twelve of them fit
in the page. Twelve dist diffs would not.

The one thing you lose is rendered appearance: the source diff shows `<td class="ok">` rather than a green
cell. For an internal architecture document read by writers and engineers, that is an acceptable loss.
If a reader needs the rendered old version, link to it — see §5.3.

### 3.1 Producing the diff: let git do it

Do not write a diff algorithm. `git diff` already produces a unified diff, scoped by pathspec, in one
call:

```
git diff -U2 --no-color <parent> <sha> -- example/sections example/doc.json example/extra.css
```

A hand-written diff would also work, but it would need the two file versions fetched out of git first,
and Rust's standard library has no sequence matcher to build one on. `git diff` does both steps at once,
and `std::process::Command` is all it takes to call it. Prefer it.

### 3.2 The authoring convention that makes diffs readable

A line diff on HTML is only as readable as the lines. Adopt one free convention:

> **In `sections/*.html`, put each sentence on its own line.**

This costs the writer nothing. It converts every future diff from "this 400-character line changed" into
"this sentence changed". It is worth more than any diff algorithm you could add. Add it to
`templates/README.md`.

### 3.3 Optional: word-level diff

If sentence-per-line is not adopted, a word-level diff recovers readability. It needs a sequence matcher
over a token list, which Rust's standard library does not have and no crate may supply. That is the same
hand-written matcher document 04 section 4.5 records as unspecified. This is an upgrade, not a
requirement. Do not build it in the first pass.

---

## 4. The build-time change: `history.rs`

Three additions. No crate. `std::process::Command` calls git, and everything else is string work. The
public signatures are fixed by `00-integration-plan.md` section 4.1. Do not change them.

```rust
//! templates/docbuild/src/history.rs
//!
//! Document history, read from local git on the writer's machine and baked
//! into the page. No crate: git is called through std::process::Command and
//! the JSON is emitted by hand.

use crate::Section;
use std::path::Path;
use std::process::Command;

const REPO_URL: &str = "https://github.com/aiur-team/archon";
const SRC_PATHS: [&str; 3] = ["sections", "doc.json", "extra.css"];
const HISTORY_LIMIT: usize = 12;          // versions carried in the page
const PATCH_CAP: usize = 1200;            // bytes of diff kept per changed file
const HISTORY_BUDGET: usize = 16 * 1024;  // ceiling for the whole embedded block

pub struct Changed {
    pub file: String,     // basename, e.g. "03-architecture.html"
    pub id: String,       // the section id that file produces
    pub add: usize,
    pub del: usize,
    pub patch: String,
    pub clipped: bool,
}

pub struct Version {
    pub sha: String,
    pub date: String,
    pub author: String,
    pub subject: String,
    pub url: String,
    pub changed: Vec<Changed>,
}

pub struct History {
    pub doc: String,
    pub head: String,
    pub versions: Vec<Version>,
}

/// Run git. Return stdout, or None if git failed or is absent.
fn git(root: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).current_dir(root).output().ok()?;
    if out.status.success() {
        String::from_utf8(out.stdout).ok()
    } else {
        None
    }
}

/// Truncate at or before `cap` bytes, never inside a character.
fn clip(s: &str, cap: usize) -> &str {
    if s.len() <= cap {
        return s;
    }
    let mut i = cap;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    &s[..i]
}

/// Split a unified diff into one entry per changed file.
/// `ids` maps a section file stem to the section id that file produces.
fn parse_diff(text: &str, ids: &[(String, String)]) -> Vec<Changed> {
    let mut files: Vec<(String, Vec<String>)> = Vec::new();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let name = rest
                .rsplit(" b/")
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("")
                .to_string();
            files.push((name, Vec::new()));
        } else if let Some((_, lines)) = files.last_mut() {
            let first = line.as_bytes().first().copied();
            let kept = matches!(first, Some(b'+') | Some(b'-') | Some(b'@') | Some(b' '));
            if kept && !line.starts_with("+++ ") && !line.starts_with("--- ") {
                lines.push(line.to_string());
            }
        }
    }

    files
        .into_iter()
        .map(|(file, lines)| {
            let add = lines.iter().filter(|l| l.starts_with('+')).count();
            let del = lines.iter().filter(|l| l.starts_with('-')).count();
            let body = lines.join("\n");
            let stem = file.rsplit_once('.').map(|(a, _)| a).unwrap_or(&file);
            let id = ids
                .iter()
                .find(|(k, _)| k == stem)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| stem.to_string());
            Changed {
                add,
                del,
                clipped: body.len() > PATCH_CAP,
                patch: clip(&body, PATCH_CAP).to_string(),
                id,
                file,
            }
        })
        .collect()
}

/// Refresh <inst>/history.json from local git when git works.
/// Read and return the file when git is absent. Returns Ok(None) when neither works.
pub fn refresh(inst: &Path) -> Result<Option<History>, String>;

/// Emit the whole block as JSON, with no whitespace. Hand-written: there is no
/// serialiser in the standard library and no crate may be added.
impl History {
    fn to_json(&self) -> String;
}

/// Drop diff bodies oldest-first until the block fits.
///
/// Never touch the newest version. "What changed most recently" is the whole
/// point of the block, so it is the last thing to give up.
fn trim(h: &mut History) {
    let mut dropped = 0usize;
    'outer: for vi in (1..h.versions.len()).rev() {
        for ci in 0..h.versions[vi].changed.len() {
            if h.to_json().len() <= HISTORY_BUDGET {
                break 'outer;
            }
            let c = &mut h.versions[vi].changed[ci];
            if !c.patch.is_empty() {
                c.patch.clear();
                c.clipped = true;
                dropped += 1;
            }
        }
    }
    if dropped > 0 {
        println!("  history trim     dropped {dropped} old diff bodies");
    }
    let size = h.to_json().len();
    if size > HISTORY_BUDGET {
        println!(
            "  history block    OVER BUDGET by {:.1} KB - lower HISTORY_LIMIT or PATCH_CAP",
            (size - HISTORY_BUDGET) as f64 / 1024.0
        );
    }
}
```

`refresh()` is the function the plan renamed. It does what the Python `history()` did — `git log
--max-count=12 --first-parent --format=%H%x1f%aI%x1f%an%x1f%s` over the document's source paths, then one
`git diff -U2 --no-color <sha>^ <sha>` per version, split by `parse_diff` — and it then writes
`<inst>/history.json` and returns the result. When git is absent it reads the committed file instead.
When neither works it returns `Ok(None)` and the build prints `SKIPPED`. A root commit has no parent, so
that `git diff` fails and `git()` returns `None`, which becomes an empty diff exactly as before.

**Two Rust details that are not stylistic.**

`std::process::Command` has no timeout, so the Python `timeout=20` is gone. `git log` and `git diff`
against a local repository do not hang in practice, but a build that hangs now hangs forever. If that
ever bites, the fix is a thread plus `try_wait`, not a crate.

The index loops in `trim` are forced. `to_json()` borrows the whole `History`, so an iterator over
`h.versions` cannot be live at the same time. Indexing is how the borrow checker lets the same algorithm
through unchanged.

**The label lookup moved out of the diff parser**, which the plan's signatures already imply. `parse_diff`
records the **section id**, which is stable, and `changelog_section` resolves the human label at render
time. A reworded label therefore does not churn the committed `history.json`.

**This was measured, not guessed — as Python.** Running the Python original against the real repository
showed the founding commit is the pathological case: it adds every file at once, so with
`PATCH_CAP = 4000` a single-version document produced a **22 KB** history block. `PATCH_CAP = 1200`
brings the same document to **9.2 KB**. The arithmetic: worst case is `PATCH_CAP x files-in-a-commit`, so
1200 x 7 files is about 8 KB for one version, and `trim` handles the rest. Start at 1200. **Re-measure
once `to_json()` exists**, because the byte count is now a property of a hand-written emitter rather than
of `json.dumps`.

The changelog is rendered as a normal section, so it reuses the existing chrome, appears in the jump nav,
and cannot drift from the stylesheet:

```rust
/// Return a Section that render_section() can consume.
/// `labels` maps a section id to its human label.
pub fn changelog_section(h: &History, labels: &[(String, String)]) -> Section {
    let label_of = |c: &Changed| -> String {
        labels
            .iter()
            .find(|(id, _)| *id == c.id)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| c.file.clone())
    };

    let peek_rows = h
        .versions
        .iter()
        .take(3)
        .map(|v| {
            format!(
                "<tr><td><code>{}</code></td><td>{}</td><td>{}</td></tr>",
                v.sha,
                &v.date[..10],
                esc(&v.subject)
            )
        })
        .collect::<String>();

    let entries = h
        .versions
        .iter()
        .map(|v| {
            let touched = if v.changed.is_empty() {
                "&mdash;".to_string()
            } else {
                v.changed
                    .iter()
                    .map(|c| format!("<a href=\"#{}\">{}</a>", c.id, esc(&label_of(c))))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let patches = v
                .changed
                .iter()
                .map(|c| {
                    let tail = if c.clipped { "\n[diff clipped]" } else { "" };
                    format!(
                        "<h4>{}  <span class=\"dx-stat\">+{} &minus;{}</span></h4>\
                         <pre class=\"diff\">{}{}</pre>",
                        esc(&label_of(c)), c.add, c.del, esc(&c.patch), esc(tail)
                    )
                })
                .collect::<String>();
            format!(
                "<details class=\"dx\" data-sha=\"{sha}\">\
                 <summary><code>{sha}</code> &nbsp;{subject} \
                 <span class=\"dx-meta\">{author} &middot; {date}</span></summary>\
                 <p>Changed: {touched} &middot; \
                 <a href=\"{url}\">commit on GitHub</a></p>{patches}</details>",
                sha = v.sha,
                subject = esc(&v.subject),
                author = esc(&v.author),
                date = &v.date[..10],
                url = v.url,
                touched = touched,
                patches = patches,
            )
        })
        .collect::<String>();

    Section {
        id: "changelog".to_string(),
        label: "Changelog".to_string(),
        nav: "Changes".to_string(),
        summary: format!(
            "{} versions. Latest: {}.",
            h.versions.len(),
            esc(&h.versions[0].subject)
        ),
        peek: format!(
            "<table class=\"tbl\"><thead><tr><th>Version</th><th>Date</th>\
             <th>Change</th></tr></thead><tbody>{peek_rows}</tbody></table>"
        ),
        body: entries,
    }
}

/// The three characters that matter inside element text. There is no HTML
/// escaper in the standard library.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}
```

`REPO_URL` is unused above only because `refresh()` builds `Version::url` from it.

Wire both into `build()`, just after the duplicate-id check. `sections` becomes `let mut sections`:

```rust
    let labels: Vec<(String, String)> = sections
        .iter()
        .map(|s| (s.id.clone(), s.label.clone()))
        .collect();

    let hist = if doc.get("history").unwrap_or("true") != "false" {
        history::refresh(&inst)?
    } else {
        None
    };
    let hist_block = match &hist {
        Some(h) => {
            sections.push(history::changelog_section(h, &labels));
            // JSON in a script tag: "</" must not close the tag early.
            let json = h.to_json().replace("</", "<\\/");
            format!("<script type=\"application/json\" id=\"doc-history\">{json}</script>")
        }
        None => String::new(),
    };
```

Add `("{{HISTORY}}", hist_block)` to the `subs` list, and put `{{HISTORY}}` in
`templates/base/layout.html` immediately before `{{APP_JS}}`'s `<script>` tag.

**`doc.json` holds strings, not booleans.** The `Scanner` in `main.rs` skips a non-string value and
stores an empty string, so `"history": false` would read as absent and the check above would enable
history. Write `"history": "false"` in `doc.json`, or add a boolean arm to the scanner. Say which in
`templates/README.md`; do not leave it to be discovered.

Finally, extend the existing `check()` report with the history size, because this block is the only part
of the page that grows without a writer noticing. There is no regex, so this is the same kind of scan as
`count_open()`:

```rust
    const OPEN: &str = "<script type=\"application/json\" id=\"doc-history\">";
    let size = match t.find(OPEN) {
        Some(a) => {
            let rest = &t[a + OPEN.len()..];
            rest.find("</script>").map(|b| rest[..b].len()).unwrap_or(0)
        }
        None => 0,
    };
    println!(
        "  history block    {:.1} KB {}",
        size as f64 / 1024.0,
        if size < 16 * 1024 { "OK" } else { "TOO BIG" }
    );
```

**Size budget.** The page is 30–50 KB today. A 16 KB ceiling on the history block keeps the document
under about 66 KB, which is still one comfortable file. `trim` enforces it by dropping old diff bodies,
and prints when it cannot. When it prints, lower `HISTORY_LIMIT` — do not start compressing. A reader who
wants a dropped diff has the GitHub link on that row.

**Failure behaviour.** Every git call fails soft to `None`, and the build prints `SKIPPED`. It prints;
it does not hide. A build outside a git checkout, or with git absent, still produces a valid document
without a changelog. Rust has no optional import to lean on, so `history.rs` is always compiled in and
this absent-input path is the guard, exactly as `00-integration-plan.md` section 4.1 rules.

---

## 5. The page: "what changed since I last read this"

This is the question the whole feature exists to answer. The answer needs one stored value per reader:
the version they last saw.

### 5.1 Store the marker in `localStorage`

Not in Blobs, not behind auth. Reasons: it works from disk, it works offline, it needs no login, it needs
no server, and losing it is harmless — the reader just sees no banner once. Cross-device continuity is
not worth a network round trip for an internal document.

Append this to `templates/base/app.js`. It is about 45 lines, matching the file's existing scale.

```js
/* Change markers. Silent if the history block is absent. */
(function () {
  var el = document.getElementById("doc-history");
  if (!el) return;

  var h;
  try { h = JSON.parse(el.textContent); } catch (e) { return; }
  if (!h.versions || !h.versions.length) return;

  var KEY = "read:" + h.doc;
  var seen = null;
  try { seen = localStorage.getItem(KEY); } catch (e) { return; }

  function mark() {
    try { localStorage.setItem(KEY, h.head); } catch (e) {}
  }

  // First visit is not a change. Record and stop.
  if (seen === null) { mark(); return; }
  if (seen === h.head) return;

  // Versions newer than the marker. If the marker predates the window, all of them.
  var at = -1;
  for (var i = 0; i < h.versions.length; i++) {
    if (h.versions[i].sha === seen) { at = i; break; }
  }
  var since = at === -1 ? h.versions : h.versions.slice(0, at);
  if (!since.length) return;

  // Which sections changed, most recent first, de-duplicated.
  var ids = [], labels = [];
  since.forEach(function (v) {
    (v.changed || []).forEach(function (c) {
      if (ids.indexOf(c.id) === -1) { ids.push(c.id); labels.push(c.label); }
    });
  });

  ids.forEach(function (id) {
    var sec = document.getElementById(id);
    if (sec) sec.classList.add("changed");
    var nav = document.querySelector('nav a[href="#' + id + '"]');
    if (nav) nav.classList.add("changed");
  });

  var bar = document.createElement("div");
  bar.className = "changebar";
  bar.innerHTML =
    "<span><b>" + since.length + "</b> change" + (since.length === 1 ? "" : "s") +
    " since you last read this" +
    (labels.length ? ": " + labels.map(function (l, i) {
      return '<a href="#' + ids[i] + '">' + l + "</a>";
    }).join(", ") : "") +
    '</span><button type="button">Mark as read</button>';
  bar.querySelector("button").addEventListener("click", function () {
    mark();
    bar.remove();
    document.querySelectorAll(".changed").forEach(function (n) {
      n.classList.remove("changed");
    });
  });
  document.querySelector("main").prepend(bar);
})();
```

Add to `templates/base/components.css`, defining every colour in the bare `:root` first, as the
template's own rule requires:

```css
:root { --changed: #b45309; --changed-bg: #fef3c7; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --changed: #fbbf24; --changed-bg: #3f2d0a; }
}
:root[data-theme="dark"] { --changed: #fbbf24; --changed-bg: #3f2d0a; }

.changebar { display: flex; gap: 1rem; align-items: center; justify-content: space-between;
  padding: .6rem .9rem; margin: 0 0 1rem; border-radius: 8px;
  background: var(--changed-bg); color: var(--changed); font-size: .9rem; }
.changed > .sec > summary .sec-label::after,
nav a.changed::after { content: "•"; margin-left: .35em; color: var(--changed); }
pre.diff { font-size: .78rem; line-height: 1.45; overflow-x: auto; }
```

### 5.2 Why this is the smallest useful thing

It answers the question with: one JSON block written by a build step the writer already runs, one
`localStorage` key, and no server. A reader who returns after two weeks lands on a banner naming the two
sections that changed, clicks one, and reads the diff in a collapsed block. That is the entire user need.
Everything in §6 is optional on top of it.

### 5.3 Reading an old version

Do not store old renders, and do not build a version picker that re-renders them. `dist/*.html` is
committed, so every past render already exists in git. One link per version is enough:

```
https://github.com/aiur-team/archon/blob/<sha>/example/dist/example.html
```

GitHub will not render it, but a reader can use the **Raw** button, and a writer can
`git show <sha>:example/dist/example.html > /tmp/old.html`. For tens of internal readers this
is enough. Storing rendered snapshots to save that step is not.

---

## 6. Annotation history

Comments and reader edits need a server. Use **Netlify Blobs**. Not Netlify DB — see §8.

### 6.1 Model it as an append-only event log

The single most important decision: **store events, not current state.** The comment list a reader sees is
a fold over events. A delete is an event. An edit is an event. Nothing is overwritten.

This gives the history for free — the log *is* the history — and avoids a real bug described in §6.3.

### 6.2 Event shape

```json
{
  "id": "1756742651221-4f2a9c",
  "doc": "example",
  "ts": "2026-09-01T18:04:11.221Z",
  "actor": "owner@example.com",
  "kind": "comment.create",
  "target": { "section": "architecture", "anchor": "p:7" },
  "docVersion": "7aaca51",
  "supersedes": null,
  "body": { "text": "The bypass path needs a guarantee here." }
}
```

| Field | Why it exists |
|---|---|
| `kind` | One of `comment.create`, `comment.edit`, `comment.delete`, `thread.resolve`, `edit.propose`, `edit.accept`, `edit.reject` |
| `docVersion` | **The field implementations forget.** The document version the annotation was made against |
| `supersedes` | The event id this one replaces. An edit points at the comment it edits |
| `target.anchor` | Where in the section. Owned by the commenting area, not this one |

`docVersion` is what stops comments from rotting. When the document moves on, a comment made against
`7aaca51` on a paragraph that has since changed can be shown as *"on an earlier version"*, with a link to
that version's diff. Without the field, the reader cannot tell a stale objection from a live one. The
value comes free from the baked history block: `JSON.parse($("#doc-history").textContent).head`.

### 6.3 Key layout, and the bug it avoids

One blob per event:

```
events/<doc>/<YYYY-MM>/<ts>-<rand>.json
```

Example: `events/example/2026-09/1756742651221-4f2a9c.json`

**Do not store the log as one JSON array in one blob.** Two readers commenting at the same time would each
read the array, append, and write. One comment is lost. Netlify Blobs is eventually consistent by default,
with roughly 60 seconds of propagation, so the read side of that read-modify-write can be stale by a
minute. The window is not theoretical. One blob per event has no such window: no two writers ever touch
the same key.

The month shard keeps `list({ prefix })` bounded, and makes the retention job in §7 a prefix scan rather
than a full walk.

Blobs limits, from Netlify's Blobs documentation (checked 1 September 2026):

| Limit | Value |
|---|---|
| Store name | 64 bytes, no `/` or `:` |
| Key | 600 bytes, cannot start with `/` |
| Blob | 5 GB |
| Metadata | 2 KB per blob |

An event is well under a kilobyte. None of these bind.

### 6.4 The function

```js
// netlify/functions/annotations.mjs
import { getStore } from "@netlify/blobs"

// Strong consistency: a reader must see their own comment immediately.
// Eventual consistency propagates in about 60s, which reads as a lost comment.
const store = () => getStore({ name: "annotations", consistency: "strong" })

const KINDS = new Set([
  "comment.create", "comment.edit", "comment.delete",
  "thread.resolve", "edit.propose", "edit.accept", "edit.reject",
])
const DOC = /^[a-z0-9-]{1,64}$/
const MAX_BODY = 8000

const shard = (iso) => iso.slice(0, 7)                    // "2026-09"
const keyFor = (doc, ts, id) => `events/${doc}/${shard(ts)}/${id}.json`

export default async (req, context) => {
  // Supplied by the auth area. See §9.
  const user = context.claudeUser ?? context.clientContext?.user ?? null
  if (!user) return new Response("unauthenticated", { status: 401 })

  const url = new URL(req.url)
  const doc = url.searchParams.get("doc")
  if (!doc || !DOC.test(doc)) return new Response("bad doc", { status: 400 })

  if (req.method === "GET") {
    const from = url.searchParams.get("from")   // "2026-07", optional
    const s = store()
    const { blobs } = await s.list({ prefix: `events/${doc}/` })
    const wanted = blobs
      .filter((b) => !from || b.key.split("/")[2] >= from)
      .sort((a, b) => a.key.localeCompare(b.key))
    const events = await Promise.all(
      wanted.map((b) => s.get(b.key, { type: "json" }))
    )
    return Response.json({ doc, events: events.filter(Boolean) })
  }

  if (req.method !== "POST") return new Response("method", { status: 405 })

  const input = await req.json().catch(() => null)
  if (!input || !KINDS.has(input.kind)) {
    return new Response("bad kind", { status: 400 })
  }
  if (JSON.stringify(input.body ?? {}).length > MAX_BODY) {
    return new Response("body too large", { status: 413 })
  }

  const ts = new Date().toISOString()
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const event = {
    id,
    doc,
    ts,
    actor: user.email,                        // server-set. Never trust the client
    kind: input.kind,
    target: input.target ?? null,
    docVersion: input.docVersion ?? null,     // client-set, from the baked block
    supersedes: input.supersedes ?? null,
    body: input.body ?? {},
  }

  await store().setJSON(keyFor(doc, ts, id), event, {
    metadata: { actor: event.actor, kind: event.kind, ts },
  })
  return Response.json(event, { status: 201 })
}

export const config = { path: "/api/annotations" }
```

`actor` is set from the authenticated identity on the server. A client-supplied author field is an
impersonation bug, and this is exactly the kind of internal tool where nobody would notice.

**One uncertainty, stated plainly:** Netlify's docs show `consistency: "strong"` at store level and on
`get`. I did **not** confirm this session that `list()` honours the store-level setting. If a freshly
written event does not appear in a `list()` immediately, the fix is one line on the client — render the
event you just posted from the POST response, rather than re-fetching. Do that anyway; it is faster.

### 6.5 Folding events into a view

Deliberately on the client, in about 20 lines. There is no server-side view to keep in sync, and no
migration when the fold changes.

```js
function fold(events) {
  const byId = new Map()
  for (const e of events) {                 // events arrive in key order = time order
    if (e.kind === "comment.create") {
      byId.set(e.id, { ...e, edited: null, deleted: false, resolved: false })
      continue
    }
    const target = byId.get(e.supersedes)
    if (!target) continue                   // orphan; ignore
    if (e.kind === "comment.edit") { target.body = e.body; target.edited = e.ts }
    if (e.kind === "comment.delete") { target.deleted = true; target.body = {} }
    if (e.kind === "thread.resolve") { target.resolved = true }
  }
  return [...byId.values()]
}
```

The annotation trail for one comment is `events.filter(e => e.id === id || e.supersedes === id)`. Render
it as "edited 3 Sept by X" with the prior text behind a `<details>`.

### 6.6 Showing annotation history against document history

The join is `docVersion`. Two displays are worth building; a third is not.

**Worth it.** On a comment whose `docVersion` is not the current head, and whose section appears in the
`changed` list of any newer version: a muted line reading *"Made against `7aaca51`, before this section
changed"*, linking to `#changelog` and that version's `<details>`. That is the difference between a
comment that still applies and one that does not.

**Worth it.** In the changelog entry for a version, a count: *"4 comments were open against this
version."* One `filter` over the folded events.

**Not worth it.** A merged unified timeline of commits and comments. It sounds appealing and reads badly:
two event streams at different rates, with different meanings, competing for the same column. Keep the
changelog a list of versions and the comment thread a list of comments, joined by a link.

---

## 7. Retention

### 7.1 The policy

| Data | Kept | Deleted by |
|---|---|---|
| Document history (git) | Forever | Nobody. Rewriting published history is out of scope |
| Annotation events | 18 months from `ts` | A scheduled function, automatically |
| Deleted comment bodies | 30 days after the `comment.delete` event | The same job |
| The `history-cache` store | 10 minutes | Overwritten in place |

**18 months** because an internal architecture document's comments stop being useful once the design
ships, and 18 months covers a design cycle plus one look-back. It is a choice, not a derivation. Write it
in `doc.json` so it is visible rather than buried in a function.

**Two-stage delete** is the part that matters. A `comment.delete` event hides the body from the UI
immediately. Thirty days later the job strips `body` from the stored event and sets
`purged: true`, keeping the skeleton — id, timestamp, actor, kind — so the thread still reads coherently
("comment deleted") and folds correctly. Immediate hiding gives the author the removal they asked for;
the delay gives a moderator a window to look at a deletion that was itself abusive. After 30 days,
"deleted" means the text is gone.

### 7.2 Who may delete

| Action | Who |
|---|---|
| Delete own comment | Its author |
| Delete anyone's comment in a document | A document owner, listed in `doc.json` as `"owners": ["owner@example.com"]` |
| Purge a whole document's annotations | A site admin, by hand, with the CLI |
| Delete document history | Nobody |

The whole-document purge stays a manual CLI action — `netlify blobs:delete annotations events/<doc>/...` —
and is deliberately **not** a button. A one-click "delete all discussion" in an internal tool is an
accident waiting for a Friday afternoon. If the manual step becomes annoying, that is a signal that
something else is wrong.

Enforce the first two rules in the function, on the server:

```js
// inside the POST branch, before writing a delete event
if (input.kind === "comment.delete") {
  const original = await store().get(input.supersedesKey, { type: "json" })
  const owners = OWNERS[doc] ?? []           // read from a committed doc.json copy
  if (!original) return new Response("no such comment", { status: 404 })
  if (original.actor !== user.email && !owners.includes(user.email)) {
    return new Response("forbidden", { status: 403 })
  }
}
```

### 7.3 The retention job

```js
// netlify/functions/retention.mjs
import { getStore } from "@netlify/blobs"

const KEEP_MS = 18 * 30 * 24 * 60 * 60 * 1000   // ~18 months
const PURGE_MS = 30 * 24 * 60 * 60 * 1000       // 30 days

export default async () => {
  const store = getStore({ name: "annotations", consistency: "strong" })
  const now = Date.now()
  const { blobs } = await store.list({ prefix: "events/" })

  let expired = 0, purged = 0
  const deletes = new Set()

  // Pass 1: find delete events past the purge window; note their targets.
  for (const b of blobs) {
    const e = await store.get(b.key, { type: "json" })
    if (!e) continue
    if (now - Date.parse(e.ts) > KEEP_MS) {
      await store.delete(b.key)
      expired++
      continue
    }
    if (e.kind === "comment.delete" && now - Date.parse(e.ts) > PURGE_MS) {
      deletes.add(e.supersedes)
    }
  }

  // Pass 2: strip bodies from purged comments, keep the skeleton.
  for (const b of blobs) {
    const e = await store.get(b.key, { type: "json" })
    if (!e || e.purged || !deletes.has(e.id)) continue
    await store.setJSON(b.key, { ...e, body: {}, purged: true },
                        { metadata: { kind: e.kind, ts: e.ts, purged: "1" } })
    purged++
  }

  console.log(`retention: expired=${expired} purged=${purged}`)
  return new Response("ok")
}

export const config = { schedule: "@daily" }
```

Netlify's scheduled-function limits, checked 1 September 2026: cron in UTC, the shorthands `@hourly`
`@daily` `@weekly` `@monthly` `@yearly` (`@reboot` and `@annually` are **not** supported), a **30-second**
execution limit, and no HTTP invocation in production — testing is the **Run now** button in the UI or
`netlify functions:invoke`.

Thirty seconds is the real constraint. This job reads every event blob twice. At tens of readers that is
hundreds of blobs and comfortably inside the budget. If the log ever reaches several thousand events, do
not optimise the reads: pass a `prefix` of one month per run and cycle through months by day-of-month.
That keeps the job simple and bounded.

---

## 8. What I would not do, and why

**Do not diff the generated HTML.** A change to a shared stylesheet rewrites every document's `dist/`
file. The diff would report changes that no writer made. See §3.

**Do not put annotation history in Netlify DB.** Checked 1 September 2026: Netlify Database is Postgres,
provisioned with `netlify database init`, and is on **credit-based plans only**. Its storage was free
"until July 1, 2026" — a date that has now passed — and its compute bills at 10 credits per GB-hour
against a 300-credit monthly Free allowance. For an append-only log read by tens of people, Postgres buys
you queries you will not write and a schema you will have to migrate. Blobs is one `setJSON` and one
`list`. Choose Blobs. Revisit only if you need a query across all documents that `list` cannot serve.

**Do not call the GitHub API from the browser.** Verified 1 September 2026: the repository returns 404
unauthenticated, so it is private. A browser call would need a token in a page that is also distributed as
a file on disk.

**Do not read git history inside the Netlify build.** Netlify does not document its clone depth. A shallow
clone would produce a one-entry changelog and a green build. Read git on the writer's machine, where the
history is known-complete, and commit the result.

**Do not load a JavaScript diff library.** `jsdiff` 9.0.0 is on cdnjs (checked 1 September 2026) and would
work under the artifact CSP. It still fails the from-disk requirement, and it recomputes at render time
what `git diff` already computed at build time. Zero runtime dependencies is the template's main asset.

**Do not store rendered snapshots of old versions.** `dist/` is committed. Git has them. Link at a sha.

**Do not merge commits and comments into one timeline.** §6.6.

**Do not add a "restore this version" button.** That is `git revert`, run by a writer who knows what they
are reverting. A button that rewrites a document from a page read by tens of people is a way to lose work.

**Do not rewrite in React or move to a static-site generator.** Nothing in this area needs one. The whole
document-history feature is about 120 lines of Rust in one module beside the builder, 45 lines added to a
40-line `app.js`, and one JSON block. A framework would add a build toolchain to a project whose defining
property is that it has none.

---

## 9. Cost, limits, and where this breaks

Netlify moved to credit-based pricing. Checked 1 September 2026.

| Plan | Credits per month | Price |
|---|---|---|
| Free | 300, hard limit, no auto-recharge | $0 |
| Personal | 1,000 | $9 |
| Pro | 3,000–20,000 | $20–$126 |

| Resource | Rate |
|---|---|
| Web bandwidth | 20 credits per GB |
| Web requests | 2 credits per 10,000 |
| Functions compute | 10 credits per GB-hour |
| Database compute | 10 credits per GB-hour |
| Production deploy | 15 credits each |

Blobs storage and operation rates are **not** listed on that page. I could not confirm them. Assume Blobs
usage is metered somewhere and check the billing page before storing anything large.

**Where the Free plan breaks first: deploys, not this feature.** At 15 credits per production deploy, 300
credits is about 20 production deploys per month before anything else is counted. A documentation
repository where several writers each publish a few times a week will exhaust that. Budget for the
Personal plan at $9/month from the start, and treat the Free plan as a trial.

**This feature's own cost is close to zero.** Document history is static bytes in an already-served HTML
file: a few KB of extra bandwidth per read. At tens of readers that is invisible. Annotation history is
one function invocation per comment and one per page load — hundreds of invocations a month, each running
tens of milliseconds. Well under one credit.

**Where the design breaks, in order:**

1. **The history block exceeds 16 KB.** `trim` drops old diff bodies and says so. If it still does not
   fit, lower `HISTORY_LIMIT`. Every dropped diff is one GitHub link away.
2. **A reader's marker is older than `HISTORY_LIMIT` versions.** Handled: the banner shows every version in
   the window, which over-reports rather than under-reports. Over-reporting is the safe error.
3. **A `list()` on one document exceeds a few thousand events.** Shard the retention job by month (§7.3)
   and fetch by month on the client.
4. **You need a query across all documents** — "every unresolved comment mentioning me". `list` plus a
   client filter stops being reasonable at that point. That is the moment to reconsider Netlify DB, and
   the only one.

---

## 10. Build order

| Step | What | Depends on |
|---|---|---|
| 1 | `git`, `parse_diff`, `refresh`, `trim` in `templates/docbuild/src/history.rs`; `{{HISTORY}}` in `layout.html` | Nothing |
| 2 | `changelog_section`, the history-size check | Step 1 |
| 3 | Change markers in `app.js`, `.changebar` CSS | Step 1 |
| 4 | Sentence-per-line convention in `templates/README.md` | Nothing |
| 5 | `netlify/functions/annotations.mjs` | Auth area, commenting area |
| 6 | Annotation-trail rendering, `docVersion` badge | Steps 3, 5 |
| 7 | `netlify/functions/retention.mjs` | Step 5 |
| 8 | `netlify/functions/history.mjs` | Probably never. Only if live history is needed |

**Steps 1 to 4 are the deliverable.** They are self-contained, need no server, no auth and no network, and
they answer the question this area exists to answer. Ship them alone and stop. Steps 5 to 7 arrive with
commenting; they are annotation history, which is a different feature that happens to share a word.

---

## 11. Verification log

Everything below was checked on **1 September 2026**.

| Claim | Source |
|---|---|
| `GET /repos/{owner}/{repo}/commits` supports `path`, `since`, `until`, `per_page` (max 100), `page` | GitHub REST docs, Commits |
| Contents endpoint takes `ref`; `application/vnd.github.raw+json`; all features ≤1 MB, raw/object 1–100 MB | GitHub REST docs, Repository contents |
| Rate limits: 60/hr unauthenticated, 5,000/hr PAT, 5,000–12,500/hr GitHub App | GitHub REST rate-limits page |
| `aiur-team/archon` is private | `curl` returned HTTP 404 unauthenticated |
| Netlify Functions v2: default export `(req, context)`, `export const config = { path }`, `netlify/functions/` | Netlify Functions get-started |
| Function limits: 60s synchronous, 30s scheduled, 15min background, not configurable | Netlify Functions optional configuration |
| Node runtime follows the build's Node version; fallback Node 24; override with `AWS_LAMBDA_JS_RUNTIME`, UI/CLI/API only | Netlify Functions optional configuration |
| Blobs: `getStore`, `setJSON`, `getWithMetadata`, `list({prefix})`; eventual consistency ~60s; `consistency: "strong"` opt-in; no TTL | Netlify Blobs docs |
| Blobs limits: 64-byte store name, 600-byte key, 5 GB blob, 2 KB metadata | Netlify Blobs docs |
| Scheduled functions: `export const config = { schedule }`, UTC cron, `@daily` etc., no `@reboot`/`@annually`, no HTTP invocation in production | Netlify scheduled functions |
| Netlify Database: Postgres, `netlify database init`, credit-based plans only, storage free until 1 July 2026 | Netlify Database docs |
| Credits: Free 300/mo hard limit; bandwidth 20/GB; functions 10 credits/GB-hour; deploy 15 credits | Netlify credit-based pricing |
| `@netlify/blobs` latest is **11.0.2**, published 28 August 2026, requires Node ≥22.12.0 | npm registry |
| `@netlify/functions` latest is **6.0.0**, published 18 August 2026 | npm registry |
| `jsdiff` **9.0.0** is on cdnjs (rejected, §8) | cdnjs API |
| The §4 code runs and produces correct output | Executed **as Python** against this repository, 1 September 2026. The Rust in §4 is a translation of that Python and has **not** been compiled |
| Rust in the Netlify build image: `rustup` and `cargo` preinstalled, no default toolchain installed | Netlify docs, checked 2 September 2026. See document 01 section 2 |

### Pinned versions

Only used if you build the server layer. Steps 1 to 4 need nothing.

```json
{
  "dependencies": {
    "@netlify/blobs": "11.0.2"
  },
  "devDependencies": {
    "@netlify/functions": "6.0.0"
  }
}
```

`@netlify/blobs` 11 requires **Node ≥ 22.12.0**. Set `NODE_VERSION = 22` (or 24) in the Netlify UI so the
build and the function runtime agree. Version 11.0.0 was published 18 August 2026, so it is about two
weeks old. If the deploy misbehaves, `10.x` is the last long-settled major (10.0.0, June 2025). Note that
the same `package.json` is the first dependency of any kind this repository will have. Keep it at the
repository root and out of the document build path, so `templates/build` never needs it.

### Uncertainties

1. Whether `list()` honours a store-level `consistency: "strong"`. Mitigation in §6.4.
2. Blobs storage and operation credit rates. Not published on the pricing page I read.
3. Netlify's git clone depth in the build container. Undocumented. This design routes around it rather
   than depending on the answer.
4. The file-count cap on the GitHub `compare` endpoint. Not checked. Only relevant to the rejected live-diff
   path.
5. **The Rust in §4 has not been compiled or run.** The algorithm and the measurements are the Python's.
   The JSON that goes into the page is emitted by hand, because no crate may be added, so the byte sizes
   in §4 must be re-measured once `history.rs` exists. The 16 KB budget and the `trim` behaviour are the
   things to re-check first.
