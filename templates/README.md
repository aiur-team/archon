# Architecture doc template

A small build step that composes a document into **one self-contained HTML file**.

Single file is not a preference. A published Claude artifact runs under a strict CSP that blocks every
external host except the font CDN, so relative CSS and JS would fail silently. The build inlines
everything.

## Make a new document

Choose one lowercase kebab-case name that is not already a slug or alias, and replace every
`cache-notes` below with that name. Copy the skeleton, generate the permanent ID once, and replace the
skeleton's placeholder `id` and `slug` before publication. Paste the generated six-hex value into `id`,
write `cache-notes` into `slug`, and leave `aliases` as `[]` for this never-published name.

```bash
cp -R templates/skeleton cache-notes
openssl rand -hex 3
"${EDITOR:-vi}" cache-notes/doc.json
"${EDITOR:-vi}" cache-notes/sections/*.html
templates/build cache-notes
git add cache-notes
templates/build --site
git add cache-notes
templates/check-dist
scripts/scrub-check.sh
npm --prefix templates/docbuild run check
git diff --check
git diff --cached --check
```

The two `--check` commands report whitespace errors and conflict markers; they do not show the content
you are about to publish. Review both unstaged and staged content explicitly:

```bash
git diff
git diff --cached
```

Site mode discovers publishable regular `doc.json` directories in the working tree, including untracked
instances, creates the new route, and checks global identity collisions. It does not require staging. The
first `git add cache-notes` brings the new instance into Git's tracked inventory so `templates/check-dist`
includes it. The second `git add cache-notes` restages any committed outputs refreshed by site mode.

Read the instance build's anchor report and review both `git diff` and the staged diff before publishing.
Confirm that the instance identity checks and the site build's global ID, slug, and alias checks passed.
Commit `doc.json`, `sections/`,
`anchors.json`, `history.json` when produced, and `dist/` together. `_site/` is generated deploy output and
is not committed.

The builder is TypeScript with **zero runtime dependencies**. `templates/build` compiles it on first run
and caches the output, so the only thing you need installed is **Node 18 or later**. TypeScript is the one
devDependency and it is fetched once.

Open `cache-notes/dist/cache-notes.html` in a browser, or publish it as an artifact.

## Document identity and URLs

Every `doc.json` requires `id`, `slug`, and `aliases`, and may set `public`. For example:

```json
{
  "id": "4b7d2a",
  "slug": "cache-notes",
  "aliases": [],
  "title": "Cache notes"
}
```

- **`id`** is exactly six lowercase hexadecimal characters. Generate it once with
  `openssl rand -hex 3`. It must be globally unique across tracked `doc.json` files and is used as
  `<docId>` for comment, edit, and history state and for the permanent `/d/<id>` route. The `id` is never edited,
  reused, or derived from a URL, slug, directory, or other meaningful value.
- **`slug`** matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` and must be globally unique. It controls the current
  hosted URL at `/<slug>/` and may change.
- **`aliases`** is a required array of prior slugs. Every alias follows the same grammar, is globally
  unique across all current slugs and aliases, and must not equal the document's current slug.
- **`public`** is optional and defaults to `false`. `true` asks the deployment's edge gate to serve this
  document with no sign-in. It is only meaningful on a repo-backed deployment that carries its own
  `netlify/lib/edge-host.mjs`, which must list every route the document is served at; the build fails
  naming them otherwise. Anything but a boolean is rejected.

The routes `api`, `d`, `login`, `invite`, and `_assets` are reserved and cannot be slugs or aliases.
The copied skeleton's placeholder `id` and `slug` are not publishable values.

The instance directory is only a filesystem location and build input. It is not document identity and
need not match the URL. Never derive a state key from a URL or directory. Share `/d/<id>` links when the
link must remain permanent.

### Rename a published document

A URL rename is one atomic metadata edit. For a rename from `cache-notes` to `bounded-cache`, the result
is:

```json
{
  "id": "4b7d2a",
  "slug": "bounded-cache",
  "aliases": ["cache-notes"]
}
```

1. Record the current `id` and `slug` from `doc.json`.
2. Confirm that the new slug is valid, is not reserved, and is absent from every tracked current slug
   and alias.
3. Keep `id` byte-for-byte unchanged.
4. Append the old slug once to the end of `aliases`, preserving every earlier alias, then set `slug` to
   the new value.
5. Run `templates/build <instance>` and `templates/build --site`.
6. Require `_site/bounded-cache/index.html` and these generated lines in `_site/_redirects`:

   ```text
   /d/4b7d2a /bounded-cache/ 301
   /cache-notes /bounded-cache/ 301!
   ```

7. Read the anchor report, run every repository gate in the new-document checklist, review the diff, and
   publish the metadata and refreshed generated committed inputs together.

Do not replace an old alias or remove an alias after its redirect has been shared. Do not change `id`,
rename the directory merely to change the URL, or edit `_site/_redirects` by hand. A rename does not
repair a previously changed or reused ID, resolve an existing alias collision, or migrate state between
deployment modes.

### Rename an instance directory

A directory rename is optional and separate from a URL rename. Directory renames of documents with a
committed `history.json` are currently unsupported: fallback history is bound to the instance basename,
so moving that file makes the next build reject it. Never delete `history.json` merely to enable a rename.

For an invented instance that has no `history.json`, a rename from `cache-notes` to
`cache-notes-source` is safe with this order:

```bash
test ! -e cache-notes/history.json
git mv cache-notes cache-notes-source
rm -f cache-notes-source/dist/cache-notes.html
rm -f cache-notes-source/dist/cache-notes.edit.json
templates/build cache-notes-source
templates/build --site
git add -A -- cache-notes-source
```

Before moving it, verify that `history.json` is absent rather than removing one. Leave `id`, `slug`, and
`aliases` unchanged so the permanent ID and hosted URLs are preserved. Removing the old-basename HTML and
edit manifest prevents stale artifacts from surviving beside the newly generated
`cache-notes-source.html` and `cache-notes-source.edit.json`. After staging both paths, run every repository
gate in the new-document checklist and review the unstaged and staged diffs. A filesystem move alone never
changes the URL.

## What is in a document

| Path | What it is |
|---|---|
| `doc.json` | Identity (`id`, `slug`, `aliases`), title, eyebrow, status chip, heading, lede, masthead metadata, footer |
| `sections/*.html` | One section each, ordered by filename. Rename to reorder |
| `extra.css` | Optional. Per-document CSS, appended last so it wins |
| `extra.js` | Optional. Per-document JavaScript, for something genuinely specific to one document |
| `anchors.json` | Generated by the build and committed. The block IDs that comments attach to. Never hand-edit it |
| `history.json` | Generated from an approved local public Git history when available and committed. The changelog the page shows |
| `dist/` | Generated artifact HTML and `.edit.json` manifest. Commit it so reviewers need no toolchain |

The skeleton starts with six sections, which is the shape most of these documents want:

1. **The problem** — what is broken and what it costs, evidence before argument
2. **Solution** — the shape of the answer, and what it deliberately does not do
3. **Architecture** — the parts, how they fit, where the guarantees stop
4. **API** — the interface other systems call
5. **Build order** — how the work splits and where it parallelises
6. **Open questions** — what is unresolved and changes the design

Delete what you do not need. Add more by adding files. Use `details.dx` for depth inside a section rather
than adding top-level sections, so the jump nav stays scannable.

## Section file format

```html
<!--
id: architecture
label: Architecture
summary: One or two sentences, shown while the section is closed.
-->
<!-- peek -->
  ...closed-state markup, usually the section's key diagram...
<!-- body -->
  ...open markup...
```

`id` becomes the anchor and the nav target. Add `nav:` to use a shorter label in the jump nav. The peek
block is optional.

**The peek is the part that matters.** It is the only thing most readers see. Put the section's key
diagram, table or chips there — never a restatement of the summary line.

## Components

Every component is rendered live, with its markup, in the component reference:

```bash
templates/build templates/components
open templates/components/dist/components.html
```

That page is itself built by this template, so it cannot drift from the CSS.

## Theming

Three states, and all three must work: an explicit `data-theme` stamp in either direction, and the
un-stamped default where only `prefers-color-scheme` decides. `templates/base/theme.css` handles this.

The rule that matters: **never declare a colour only inside a media or `[data-theme]` block.** Define
tokens in the bare `:root`, redefine them in the two theme blocks, and style components through the
tokens. A colour that exists only behind `[data-theme]` renders one theme's text on the other theme's
ground.

The semantic trio `ok` / `warn` / `risk` is deliberately generic. Each document decides what the three
mean and states it in a legend. The compliance document uses them as hard guarantee, best effort, and
bypass.

## Build an artifact or a site

| Command | Scope | Required result | Commit? |
|---|---|---|---|
| `templates/build <instance>` | One source instance | Refresh `<instance>/dist/<basename>.html` and generated committed inputs | Commit changed `dist/`, `anchors.json`, and `history.json` when validly refreshed |
| `templates/build --site` | Every publishable working-tree instance | Refresh artifacts and build `_site/<slug>/index.html`, `_site/index.html`, `_site/_redirects`, and the hashed enhancement asset | Do not commit `_site/` |
| `templates/check-dist` | Every tracked document | Rebuild and prove committed `*/dist/*.html` byte-identical | No rewrite accepted; commit changed dist HTML with its source first |

Site mode discovers publishable working-tree instances, validates their identities together, refreshes each
artifact, and writes `_site/` from scratch. `_site/` is disposable deploy output and is never committed.
Netlify runs `templates/build --site` and publishes `_site/`.

Artifact and site HTML differ only by the hosted enhancement-script line. Both contain the document-ID
meta element. Neither mode fetches comments or live state into committed artifacts. Local builds,
including `templates/build --site`, refresh `history.json` only from a non-shallow local Git checkout whose
`origin` is a supported GitHub URL and whose exact `<owner>/<repo>` has been approved by a maintainer for
public redistribution. After that approval, set `DOCBUILD_PUBLIC_HISTORY_APPROVED=<owner>/<repo>` to the
exact value derived from `origin`; do not opt in automatically. Without every prerequisite, the build uses
the canonical committed `history.json`, or omits history when the file is absent. On Netlify
(`NETLIFY=true`), builds never refresh history and follow the same committed-file fallback.

`docbuild --site` is the underlying CLI spelling. Writers normally use the repository wrapper
`templates/build --site`.

## Build one document for private hosted reading

```bash
templates/build cache-notes --hosted
```

`--hosted` is an explicit profile, not an inference from the environment or from where the builder is
installed. It writes `cache-notes/dist/cache-notes.hosted.html` — named after the instance directory, like
every artifact here — and leaves the committed `cache-notes.html` untouched, so `templates/check-dist`
still rebuilds the normal artifact byte-for-byte.

The hosted artifact keeps the inline theme and component CSS, `extra.css`, `extra.js`, the theme toggle,
the section navigation, the open/closed section behaviour, the generated `data-aid` anchors and the local
changelog client. It omits the Google Fonts `preconnect` and stylesheet links, so the generated chrome
makes no network request, and it omits the session, comment, edit, realtime, presence and share client
code together with the styles for their controls. Text falls back to the local `ui-monospace` and
`system-ui` stacks the theme already names. Remote references you authored in your sections, `extra.css`
or `extra.js` are left exactly as written and are not covered by this profile.

`--hosted` and `--site` build different things and cannot be combined; either one with an unknown flag
fails with the synopsis and a nonzero exit. The profile is not an HTML sanitizer: authored remote images,
fonts and scripts stay exactly as written, are never fetched during the build, and remain subject to the
renderer's own policy. Do not describe a hosted artifact as having comments or inline editing enabled.

A hosted artifact is built on demand for one private upload and is not committed; `.gitignore` keeps
`dist/*.hosted.html` out of the tree so a routine `git add cache-notes` cannot carry it along.

`docbuild <instance> --hosted` is the underlying CLI spelling.

## Write prose one sentence per line

Inside `sections/*.html`, start each new prose sentence on a new source line in paragraphs, headings,
list items, blockquotes, table cells, and `<details>` copy while preserving the enclosing HTML. Do not
reflow code or preformatted blocks, diagram source, JSON, shell examples, URLs, or a sentence merely
because it wraps visually.

Browsers collapse ordinary HTML whitespace. This convention makes Git diffs readable; it does not
intentionally add `<br>`, change rendered spacing, or alter text content. The anchor normalizer also
collapses whitespace, so rewrapping existing prose alone does not change its `data-aid`.

## Read the anchor report

Every prose block carries a `data-aid`, and comments attach to that permanent block ID. The build aligns
current text with the committed `anchors.json` and reports what happened:

| Report token | Meaning | Writer action |
|---|---|---|
| `equal` | Block text/order match retained the existing `data-aid` | No action beyond normal diff review |
| `edited` | Similar replacement at or above the 0.6 threshold retained the ID | Confirm the intended block kept the ID and inspect comment quote drift |
| `moved` | Exact orphaned text reappeared and reclaimed its prior ID | Confirm the move is intentional |
| `ORPHANED` | An old block ID no longer has a safe match | Review `anchors.json` and affected prose; accept only when comments should become moved/orphaned |

On a first build without `anchors.json`, every block is new, every count is zero, and the build creates the
file. On an unchanged second build, every section must report zero `ORPHANED` and leave `anchors.json`
byte-identical.

The report is a warning, not permission to hand-edit IDs until it becomes green. Restore or revise prose
when an orphan is unintended. A whole rewrite may legitimately orphan threads, but make that loss visible
in review instead of suppressing it.

## What the build checks

An instance artifact build validates that `id` is exactly six lowercase hexadecimal characters, but it
does not validate the instance's slug, aliases, or collisions with other documents. Site-mode preflight
validates the full identity inventory, including global ID, slug, and alias collisions. Artifact-only
success is therefore insufficient for publication.

`docbuild` also fails on a missing section field, a duplicate section ID, and an unfilled placeholder.
After writing, it reports anchor alignment, tag balance, theme-state count, and file size. Read every
report before committing.

Run the complete repository gate sequence in the new-document checklist before publication.

It has no runtime dependencies. Node only, and only to build — a reader needs nothing.

## Where to put a component

If two documents would use it, it belongs in `templates/base/components.css`. If only one ever will, it
belongs in that document's `extra.css`.

The line is drawn by reuse, not by complexity. A lane diagram and a decision card are general, so they
are in the base. An interactive graph built for one document's data is not, however polished it is, so it
lives in that document's `extra.css` and `extra.js`.
