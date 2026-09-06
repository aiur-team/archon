# Netlify hosting and the build pipeline

**Area:** deployment, `netlify.toml`, directory layout, clean URLs, deploy previews, stable URLs, and the
parallel Claude artifact path.

**Written when the builder was Python. Converted to Rust on 2 September 2026.** Every command and code
block below is now the Rust one. Where this document and `00-integration-plan.md` disagree, the plan is
correct.

**All Netlify facts below were checked on 2026-09-01**, except the build-image facts in section 2, which
were re-checked on **2026-09-02** for Rust. Netlify moved to credit-based pricing. Old guidance about
"300 build minutes" is out of date. Read the cost section before you plan anything.

---

## 1. Summary of the recommendation

Build on Netlify. Do not commit the site output.

1. Netlify runs one build command, `templates/build --site`. There is no `package.json` and none is
   needed to deploy.
2. A new `--site` mode of `docbuild` builds every document into `_site/`. It reuses the composition code
   in `main.rs`, so the two outputs cannot drift apart.
3. Each document gets `_site/<slug>/index.html`. Netlify serves that at `/<slug>/`.
4. Keep committing `<instance>/dist/<name>.html`. That file is the artifact deliverable. It is not a
   build artifact of the website.
5. A GitHub Action rebuilds and fails if the committed `dist/` is stale.
6. Every document gets a permanent `id` in `doc.json`. `/d/<id>` redirects to the current slug forever.
7. Deploy previews are automatic, free, and per pull request. They are the highest-value feature here.

The writer's command does not change. `templates/build my-doc` still works and still writes one
self-contained file.

---

## 2. Facts I verified

| Question | Answer | Source, checked 2026-09-01 |
|---|---|---|
| Does a Netlify build work with no `package.json`? | Yes. Netlify skips JavaScript dependency install and runs your build command. | [Manage build dependencies](https://docs.netlify.com/build/configure-builds/manage-dependencies/) |
| Is a Rust toolchain present in the build image? | **Partly, and this is the one thing the language change actually costs.** The image is Ubuntu 24.04 (Noble). `rustup` and `cargo` are preinstalled, but **Netlify installs no default Rust toolchain**. Rust is listed as "any version that `rustup` can install". Node 24 is still the default Node. | [Available software at build time](https://docs.netlify.com/build/configure-builds/available-software-at-build-time/), checked 2026-09-02 |
| How do I get and pin a toolchain? | A `rust-toolchain` file in the base directory, which `cargo` acts on the first time it runs; or `rustup toolchain install stable` in the build command. **There is no `RUST_VERSION` build variable**, unlike `NODE_VERSION` and `GO_VERSION`. | [Manage build dependencies](https://docs.netlify.com/build/configure-builds/manage-dependencies/), checked 2026-09-02 |
| What does Netlify cache between builds? | The selected toolchain. Crates in `~/.cargo/registry`, and compilation output in `target`, when the working directory holds a `Cargo.toml` or `Cargo.lock`. No plugin needed. | same, checked 2026-09-02 |
| Does `foo.html` serve at `/foo`? | Yes, by default. `foo/index.html` serves at `/foo/`, and `/foo` 301s to `/foo/`. | [Trailing slash support guide](https://answers.netlify.com/t/support-guide-how-can-i-alter-trailing-slash-behaviour-in-my-urls-will-enabling-pretty-urls-help/31191) |
| Deploy preview URL | `https://deploy-preview-<PR>--<site>.netlify.app`, automatic on GitHub pull requests. | [Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/) |
| Immutable deploy URL | `https://<deploy-id>--<site>.netlify.app`. Its content never changes. | [Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/) |
| Free plan credits | 300 per month. Hard cap. No overage purchase. | [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/) |
| Production deploy cost | 15 credits each. | same |
| Deploy preview cost | **0 credits.** Branch deploys are also 0. | same |
| Bandwidth cost | 20 credits per GB. Web requests 2 credits per 10,000. | same |
| Failed deploy cost | 0 credits. Rollback is also 0. | same |
| Default functions directory | `netlify/functions`. | [Functions optional configuration](https://docs.netlify.com/build/functions/optional-configuration/) |

### What I could not confirm

- **What installing a Rust toolchain costs on a cold build.** Netlify documents no figure. The only
  source I found is a support-forum thread about slow Rust builds and cache misses
  ([answers.netlify.com](https://answers.netlify.com/t/build-time-large-rust-cargo-registry-cache-not-used/36008),
  checked 2026-09-02), which is anecdote, not a number. **Mitigation:** the builder has no dependencies,
  so only the toolchain is fetched, and Netlify documents that it caches the toolchain. Measure the first
  two deploys and record the real figure here.
- **Whether the `target` cache applies to this repository.** Netlify caches `target` "if your working
  directory has a `Cargo.toml` or `Cargo.lock` file". This repository's manifest is at
  `templates/docbuild/Cargo.toml`, not at the root, so the condition may not hold. Not confirmed. It
  matters little: a dependency-free crate compiles in seconds.
- **Whether `netlify/build-image` still describes the current image.** It does not. The repository was
  archived on 2023-01-25 and its software list is the Ubuntu 20.04 "focal" era
  ([included_software.md](https://github.com/netlify/build-image/blob/focal/included_software.md), checked
  2026-09-02). It happens to use the same "Rust: not installed by default" wording, which is corroboration
  and nothing more. Trust the live docs page, not the repository.
- **Whether a publish-only deploy is a supported first-class workflow.** Committing a built `dist/` and
  leaving the build command empty is common practice, but I found no Netlify page that names it. The CLI
  documents `netlify deploy --no-build` for an ad-hoc deploy, which is a different mechanism.
  **The safe fallback, if the toolchain install ever fails or costs too much:** set the build command to a
  copy step over the committed `dist/*.html` files, which section 7 keeps committed anyway. The site loses
  the live deploy preview from `sections/` and nothing else.
- **Whether a build skipped by `[build] ignore` consumes deploy credits.** Logically it should not,
  because no deploy is created. I did not find this stated. Treat the credit maths in section 8 as the
  pessimistic case.
- **Whether Netlify sets `X-Robots-Tag: noindex` on deploy previews automatically.** The deploy preview
  documentation does not state it. Section 5 adds the header explicitly, which costs two lines.

---

## 3. Directory layout

```
archon/
├── netlify.toml                     # new. see section 4
├── rust-toolchain                   # new. the build image installs no toolchain by itself
├── .gitignore                       # new line: _site/
├── .github/workflows/build.yml      # new. staleness guard, see section 7
│
├── templates/
│   ├── build                        # UNCHANGED. wrapper: compile if stale, then run
│   ├── docbuild/src/main.rs         # one doc -> <inst>/dist/<name>.html, plus the new --site mode
│   ├── base/                        # layout.html, theme.css, components.css, app.js
│   ├── enhance/
│   │   └── enhance.js               # new. hosted-only features. see section 6
│   ├── skeleton/                    # not published. --site skips it
│   └── components/                  # published at /components/
│       ├── doc.json
│       └── dist/components.html     # committed
│
├── example/
│   ├── doc.json
│   ├── sections/*.html
│   └── dist/example.html      # committed. this is the artifact copy
│
├── example/
│
├── netlify/functions/               # other areas own this
│   └── *.mjs
├── package.json                     # ONLY when a function needs an npm package
│
└── _site/                           # build output. gitignored. never committed
    ├── index.html
    ├── _redirects
    ├── _headers
    ├── _assets/enhance.<hash>.js
    ├── example/index.html
    ├── example/index.html
    └── components/index.html
```

Rules that keep this simple.

- A directory is a document if it holds a `doc.json`. Nothing else registers a document.
- `skeleton` is excluded by name. It is a template, not a document.
- The writer never opens `netlify.toml`, `rust-toolchain`, or `package.json`.

---

## 4. The exact `netlify.toml`

Put this at the repository root.

```toml
# Netlify configuration for archon.
# The build is one command and one compiled binary. There is no package.json
# and none is needed. Verified against Netlify file-based configuration docs on
# 2026-09-01; the Rust build-image facts re-checked 2026-09-02.

[build]
  command = "templates/build --site"
  publish  = "_site"

  # Skip the build when the commit touched nothing that can change the site.
  # Exit 0 means "skip". Exit 1 means "build".
  # Remove this line if a skipped build ever hides a real change.
  ignore = "git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- ':!*.md' ':!**/dist/**'"

[build.processing]
  skip_processing = true   # the HTML is already one self-contained file

# Functions. Safe to keep even while netlify/functions/ is empty.
[functions]
  directory    = "netlify/functions"
  node_bundler = "esbuild"

# ---------------------------------------------------------------- headers

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy        = "strict-origin-when-cross-origin"
    X-Frame-Options        = "SAMEORIGIN"

# A document must never be served stale. It is 50 KB. Revalidate every time.
[[headers]]
  for = "/*"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"

# Assets carry a content hash in the filename, so they are immutable.
[[headers]]
  for = "/_assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

# ---------------------------------------------------------------- contexts

[context.production.environment]
  DOC_ENV = "production"

[context.deploy-preview.environment]
  DOC_ENV = "preview"

[context.branch-deploy.environment]
  DOC_ENV = "preview"
```

Notes on choices.

- **A `rust-toolchain` file, not an environment variable.** Netlify documents no `RUST_VERSION`, and it
  installs no toolchain by itself, so the file is not optional. One line, `stable`, in the base directory.
  `templates/build` compiles the binary on first run and caches it, so the build command stays one line.
- **`skip_processing = true`.** Netlify post-processing would rewrite and minify HTML. This document is
  already one hand-tuned file with an inline stylesheet. Leave it alone.
- **`ignore`.** This is a cost lever, not a correctness feature. See section 8.
- **Redirects are not here.** They are generated per document into `_site/_redirects`. Netlify applies
  `netlify.toml` redirects before `_redirects` rules, so keeping the two sets separate avoids surprise.

---

## 5. The `--site` build mode

This is the whole mode. It has no dependencies. It reuses `build()` rather than copying it.
`00-integration-plan.md` section 4.2 rules that the site build is a mode of the one binary, not a second
script, so that the two outputs cannot drift apart.

```rust
// templates/docbuild/src/main.rs, the --site mode.
//
//     docbuild --site
//
// This reuses build() for composition. It adds four things the
// single-document build does not do:
//
//   1. one directory per document, so each document gets a clean URL
//   2. the doc-id meta tag and the enhancement script tag, which the
//      artifact build must never carry
//   3. _redirects, so a renamed document keeps every URL it ever had
//   4. an index page that lists the documents
//
// It also refreshes every committed dist/*.html on the way through, because
// build() writes there. One command therefore keeps the artifact copies
// current. CI uses that: build, then `git diff --exit-code`.

const SKIP: [&str; 6] = ["_site", "node_modules", ".git", "skeleton", "netlify", "dist"];

/// Every directory that holds a doc.json. A directory is a document if it
/// holds one. Nothing else registers a document.
fn instances(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::new();
    walk(root, &mut out)?;
    out.sort();
    Ok(out)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
        let p = entry.map_err(|e| format!("{}: {e}", dir.display()))?.path();
        if !p.is_dir() {
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        if p.join("doc.json").is_file() {
            out.push(p.clone());
        }
        walk(&p, out)?;
    }
    Ok(())
}

/// FNV-1a. The asset filename only needs a content hash, and there is no
/// digest in the standard library. This is not a security boundary.
fn content_hash(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    format!("{h:016x}")[..8].to_string()
}

/// Copy enhance.js under a content hash. Return the tag, or "".
fn copy_enhancer(root: &Path, out_dir: &Path) -> Result<String, String> {
    let src = root.join("templates").join("enhance").join("enhance.js");
    if !src.exists() {
        return Ok(String::new());
    }
    let raw = fs::read(&src).map_err(|e| format!("{}: {e}", src.display()))?;
    let name = format!("enhance.{}.js", content_hash(&raw));
    let dst = out_dir.join("_assets").join(&name);
    fs::write(&dst, &raw).map_err(|e| format!("{}: {e}", dst.display()))?;
    Ok(format!("<script defer src=\"/_assets/{name}\"></script>"))
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn index_page(root: &Path, docs: &[(String, Doc)]) -> Result<String, String> {
    let rows = docs
        .iter()
        .map(|(slug, d)| {
            let title = d.get_or("title", "");
            format!(
                "    <li><a href=\"/{slug}/\"><b>{}</b><span>{}</span></a></li>",
                esc(&d.get_or("heading", &title)),
                esc(&d.get_or("lede", "")),
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let theme = read(&root.join("templates").join("base").join("theme.css"))?;
    Ok(format!(
        r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture docs</title>
<style>{theme}
body{{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.6}}
.w{{max-width:52rem;margin:0 auto;padding:4rem 1.5rem}}
h1{{font-size:1.5rem;margin:0 0 2rem}}
ul{{list-style:none;margin:0;padding:0}}
li{{border-top:1px solid var(--border)}}
a{{display:block;padding:1.1rem 0;color:inherit;text-decoration:none}}
a:hover b{{text-decoration:underline}}
span{{display:block;color:var(--ink-3);font-size:.9rem;margin-top:.25rem}}
</style></head><body><div class="w">
  <h1>Architecture docs</h1>
  <ul>
{rows}
  </ul>
</div></body></html>
"#
    ))
}

fn site(root: &Path) -> Result<(), String> {
    let out_dir = root.join("_site");
    if out_dir.exists() {
        fs::remove_dir_all(&out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    }
    let assets = out_dir.join("_assets");
    fs::create_dir_all(&assets).map_err(|e| format!("{}: {e}", assets.display()))?;
    let tag = copy_enhancer(root, &out_dir)?;

    let mut docs: Vec<(String, Doc)> = Vec::new();
    let mut redirects: Vec<String> = Vec::new();
    let mut seen_slugs: HashSet<String> = HashSet::new();
    let mut seen_ids: HashSet<String> = HashSet::new();

    for inst in instances(root)? {
        let rel = inst.strip_prefix(root).unwrap_or(&inst).to_string_lossy().to_string();
        let name = inst.file_name().unwrap_or_default().to_string_lossy().to_string();
        let src = read(&inst.join("doc.json"))?;
        let doc = Doc { fields: Scanner::new(&src).object()? };
        let slug = doc.get_or("slug", &name);
        let doc_id = doc
            .get("id")
            .ok_or_else(|| format!("{name}/doc.json: add a permanent \"id\""))?
            .to_string();
        if !seen_slugs.insert(slug.clone()) {
            return Err(format!("duplicate slug: {slug}"));
        }
        if !seen_ids.insert(doc_id.clone()) {
            return Err(format!("duplicate id: {doc_id}"));
        }

        // build() writes <inst>/dist/<name>.html, the artifact copy.
        let built = build(root, &rel)?;

        let page = out_dir.join(&slug);
        fs::create_dir_all(&page).map_err(|e| format!("{}: {e}", page.display()))?;
        let html = format!(
            "{}\n<meta name=\"doc-id\" content=\"{doc_id}\">\n\
             <meta name=\"doc-slug\" content=\"{slug}\">\n{tag}\n",
            read(&built)?
        );
        let index = page.join("index.html");
        fs::write(&index, html).map_err(|e| format!("{}: {e}", index.display()))?;

        redirects.push(format!("/d/{doc_id}     /{slug}/   301"));
        redirects.push(format!("/d/{doc_id}/*   /{slug}/   301"));
        for old in doc.aliases() {
            redirects.push(format!("/{old}       /{slug}/          301!"));
            redirects.push(format!("/{old}/*     /{slug}/:splat    301!"));
        }
        docs.push((slug, doc));
    }

    fs::write(out_dir.join("_redirects"), redirects.join("\n") + "\n")
        .map_err(|e| format!("_site/_redirects: {e}"))?;
    fs::write(out_dir.join("index.html"), index_page(root, &docs)?)
        .map_err(|e| format!("_site/index.html: {e}"))?;

    // Deploy previews and branch deploys must not reach search engines.
    if std::env::var("CONTEXT").unwrap_or_else(|_| "production".into()) != "production" {
        fs::write(out_dir.join("_headers"), "/*\n  X-Robots-Tag: noindex\n")
            .map_err(|e| format!("_site/_headers: {e}"))?;
    }

    println!("built {} documents into _site/", docs.len());
    for (slug, _) in &docs {
        println!("  /{slug}/");
    }
    Ok(())
}
```

Three notes on the conversion, all of them things an implementer would otherwise discover the hard way.

- **`main()` must learn one more argument.** It rejects anything except a single instance name today. Add
  a `--site` arm before the instance path; keep `--help` as it is.
- **`aliases` needs an array case in the `Scanner`.** `aliases` is a JSON array of strings, and the
  scanner in `main.rs` models strings and one nested object only — it skips an array and stores an empty
  string. Add `Val::Arr(Vec<String>)` and a `Doc::aliases()` accessor. This is the same one-arm change
  document 04 section 4.5 asks for.
- **The asset hash is FNV-1a, not SHA-1.** The Python used `hashlib.sha1`. Rust has no digest in its
  standard library and no crate may be added. The filename only has to change when the bytes change, and
  it does.

`index_page` uses only tokens that `templates/base/theme.css` already defines: `--bg`, `--ink`,
`--ink-3`, `--border` and `--sans`. I verified that list against the file on 2026-09-01. **The Python
original of this mode was run against the real repository** and it produced `_site/index.html`,
`_site/example/index.html`, `_site/components/index.html`, `_site/_redirects` and a hashed
`_site/_assets/enhance.<hash>.js`. The Rust above is a translation of it and has **not** been compiled.
Compile it and repeat that check before you trust it.

---

## 6. Two outputs from one source: artifact and Netlify in parallel

This is the constraint that decides the design. A Claude artifact runs under a strict Content Security
Policy. It blocks every external host except the font CDN. A file opened from disk has no origin at all
and no network. Therefore the hosted features must be **added by the site build, never by the document
build**.

| | Command | Output | Script tag | Where it runs |
|---|---|---|---|---|
| Artifact and disk | `templates/build example` | `example/dist/example.html` | none | artifact, `file://`, email attachment |
| Website | `templates/build --site` | `_site/example/index.html` | `/_assets/enhance.<hash>.js` | Netlify |

The two files are byte-identical except for the three lines appended at the end. That is the whole
mechanism. It has no build flags, no template branches, and no conditional CSS.

The degradation story is therefore exact, not aspirational:

- **In an artifact.** The script tag is absent. The reader sees the complete document.
- **From disk.** The script tag is absent. The reader sees the complete document, offline.
- **Someone saves the hosted page to disk.** The tag is present, `/_assets/...` fails to resolve, the
  script never runs. The reader still sees the complete document.
- **On Netlify with the API down.** `enhance.js` loads, its first fetch fails, it stops. The reader still
  sees the complete document.

`templates/enhance/enhance.js`, the starting point that other areas extend:

```js
/* Hosted-only enhancement. The artifact build never loads this file.
   Every feature module must fail closed: on any error the document must
   still read correctly, with the feature simply absent. */
(function () {
  if (location.protocol === 'file:') return;

  var id = document.querySelector('meta[name="doc-id"]');
  if (!id) return;

  window.DOC = {
    id: id.content,                                    // stable across renames
    slug: document.querySelector('meta[name="doc-slug"]').content,
    api: '/api',                                       // see netlify/functions
    ready: function (fn) {
      // Never let a feature module break the page.
      try { fn(window.DOC); } catch (e) { console.warn('doc feature failed', e); }
    }
  };
})();
```

Other areas add modules that call `window.DOC.ready(...)`. They must key all stored state on
`window.DOC.id`, never on the slug and never on `location.pathname`. Section 9 explains why.

---

## 7. Build in CI, or commit the output?

Both, for different files. The two outputs are not the same kind of thing.

**Commit `<instance>/dist/<name>.html`.** It is the deliverable, not an intermediate. It is what you paste
into a Claude artifact. It is what a reviewer opens from a clean checkout with no toolchain. It is what
survives if Netlify is gone. Keeping it committed is the reason constraint 2 holds today, and dropping it
would trade a real guarantee for a tidier `git status`.

**Do not commit `_site/`.** Netlify builds it in about one second. Committing it would duplicate every
document in the diff, create merge conflicts inside generated HTML, and give a reviewer two copies to
disagree about.

The risk of a committed build output is staleness. Close it with one check, not with discipline.

`.github/workflows/build.yml`:

```yaml
name: build
on: [push, pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # checked 2026-09-01
      # No toolchain step. The ubuntu-latest runner image ships rustc, cargo,
      # rustdoc and rustup in its "Rust Tools" section. Checked 2026-09-02:
      # actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
      - name: Rebuild every document
        run: templates/build --site
      - name: Fail if a committed dist/ file is stale
        run: |
          git diff --exit-code -- '*/dist/*.html' \
            || { echo "::error::dist/ is stale. Run: templates/build --site"; exit 1; }
```

This works because `--site` calls `build()`, which writes into each `dist/`. One command rebuilds
everything a writer might have forgotten. The runner needs no setup step: `ubuntu-latest` is Ubuntu 24.04
and its documented software list has a "Rust Tools" section with `rustc`, `cargo`, `rustdoc` and `rustup`
([actions/runner-images](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md),
checked 2026-09-02). That README is rewritten with each image snapshot, so read the version out of it
rather than pinning one here. If a pin is ever needed, `dtolnay/rust-toolchain` is the maintained
community action; `actions-rs/toolchain` was archived on 2023-10-13 and must not be used. The Action costs nothing on the GitHub free tier for a private
repository of this size, and it is faster feedback than a Netlify deploy.

`.gitignore` gains one line:

```
_site/
```

**What I would not do:** make the Netlify build itself fail on a stale `dist/`. A writer who forgets to
rebuild would then lose the deploy preview, which is the one thing that would have shown them the
problem. Netlify must always build from `sections/`, and must always succeed. Let GitHub Actions carry the
staleness complaint.

---

## 8. Cost, limits, and where this breaks

Netlify's credit pricing changed the shape of the answer. Deploys now cost far more than traffic does.

| | Free | Personal | Pro |
|---|---|---|---|
| Price | $0 | $9/month | $20/month |
| Credits per month | 300 | 1,000 | 3,000 |
| Production deploys per month | **20** | 66 | 200 |
| Who can view a private project | Team Owner only | Team Owner only | unlimited team members |

Costs, from [How credits work](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/):
production deploy 15 credits, bandwidth 20 credits per GB, web requests 2 credits per 10,000 requests,
compute 10 credits per GB-hour. **Deploy previews and branch deploys cost zero credits. Failed deploys
cost zero credits.**

For this workload the traffic is a rounding error. Fifty readers loading a 50 KB document ten times a
month is about 25 MB, which is roughly 0.5 credits. Deploys are the entire bill.

**Where the free plan breaks: at 20 merges to `main` in a month.** A documentation repository with two
active writers passes that easily. When the 300 credits run out, Netlify does not throttle. Every project
on the team shows a "Site not available" page until the next billing cycle. That is a hard outage, not a
slowdown.

Two levers, in order of preference.

1. **The `ignore` command in section 4.** A commit that changes only Markdown or only `dist/` does not
   produce a production deploy. This removes a large share of merges from the bill. I could not confirm
   that a skipped build spends no credits, so treat it as likely, not certain.
2. **Pay $9 for Personal.** 66 production deploys per month is comfortable. This is the correct default
   for an internal tool. Do not spend engineering time on lever 1 to avoid $9.

**The plan decision is really an auth decision, and it is not free.** On Free and Personal, a private
project is visible to the **Team Owner only**
([Project visibility](https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/)).
An audience of tens of readers behind Netlify login therefore requires **Pro at $20/month**. The
alternative is to leave the project public and enforce authentication inside the page with Netlify
Identity plus a function gate, which keeps Personal viable. That fork belongs to the authentication area.
Section 10 records it as a dependency. Note also that Netlify Identity was scheduled for deprecation and
then kept, confirmed 2026-02-19
([forum notice](https://answers.netlify.com/t/netlify-identity-is-staying-feb-2026-reversal-what-changed-whos-affected-and-how-to-proceed/162733));
Git Gateway is the part that was deprecated.

Storage and compute for comments and history are small at this scale, but they are billed as compute at 10
credits per GB-hour. That belongs to the persistence area, which should check its own numbers against the
same credit table.

---

## 9. Clean URLs, and a URL that survives a rename

### Clean URLs need no configuration

Netlify serves `_site/example/index.html` at `/example/`. A request for `/example`
returns a 301 to `/example/`. This is default behaviour and needs no redirect rule.

**Do not enable the "Pretty URLs" post-processing setting.** It exists to strip `.html` from URLs. The
`<slug>/index.html` layout has no `.html` to strip, so the setting can only add redirects you did not ask
for.

### The rename problem

A slug is a name. Names change. `example` becomes `build-cache`. Every link in Slack, every
link in a pull request, every link in a Notion page breaks at once. Worse, once comments and edit history
exist, anything keyed on the URL loses its rows.

Give each document a permanent identifier that is never allowed to change. Add two fields to `doc.json`:

```json
{
  "id": "k7m2q4",
  "slug": "example",
  "aliases": [],
  "title": "Remote Build Cache"
}
```

- **`id`** is six random lowercase characters, generated once, never edited. It is meaningless on purpose.
  A meaningful id is an id someone will eventually want to correct.
- **`slug`** is the readable URL. It defaults to the directory name. It is allowed to change.
- **`aliases`** lists every slug this document has previously used.

Generate an id with:

```bash
openssl rand -hex 3
```

The `--site` mode emits these redirects for the example above:

```
/d/k7m2q4       /example/   301
/d/k7m2q4/*     /example/   301
```

**The renaming procedure is three steps.** Move the directory, set `slug`, push the old slug onto
`aliases`:

```json
{
  "id": "k7m2q4",
  "slug": "build-cache",
  "aliases": ["example"]
}
```

The generated `_redirects` becomes:

```
/d/k7m2q4        /build-cache/          301
/d/k7m2q4/*      /build-cache/          301
/example   /build-cache/          301!
/example/* /build-cache/:splat    301!
```

`301!` forces the redirect even if a file exists at that path. That matters if a new document later takes
the retired slug.

**Share `/d/<id>` links, not slug links.** Put that URL in the document footer so a reader can copy the
permanent one. `doc.json` already drives the footer, so this is a `doc.json` edit, not a template change.

**The id is also the storage key.** Comments, resolved-thread state, inline edits, and change history must
all key on `window.DOC.id`. If they key on the slug or the path, a rename orphans every row. This is the
main reason the id is load-bearing rather than a nicety.

---

## 10. Deploy previews

This is the feature that pays for the whole migration, and it needs no configuration.

Open a pull request. Netlify builds every document and posts a status check with a link to
`https://deploy-preview-<PR>--<site>.netlify.app`. A reviewer clicks it and reads the rendered document.
Today a reviewer must clone the repository, run the build, and open a local file. That is the difference
between a document that gets reviewed and one that gets approved unread.

Facts worth knowing before you design around it.

- Previews are automatic for GitHub pull requests. The base branch must be the production branch or must
  have branch deploys enabled.
- Previews cost **zero credits**. Push as often as you like.
- The preview URL updates with each push. The permalink `https://<deploy-id>--<site>.netlify.app` never
  changes, so it is the correct link to paste into a decision record.
- Preview visibility is configured separately from production visibility.
- The **Netlify Drawer** (`Cmd+\`) already provides commenting, screenshots, and responsive testing on a
  deploy preview. **The commenting area should read this before building anything.** Netlify's commenting
  covers review of a proposed change. It does not cover discussion on the published document. Those are
  different features and only the second needs to be built.
- You can set the preview landing page by writing `@netlify /example/` in the pull request
  description. Useful when a pull request touches one document out of six.

The one thing to add is the noindex header for non-production contexts, which section 5 already does.

---

## 11. What I would not do, and why

**A static site generator (Eleventy, Astro, Hugo).** This is the big one. It would bring a
`package.json`, a `node_modules` directory, a lockfile, a template language, and an upgrade treadmill.
The writer's mental model would change from "edit an HTML fragment" to "learn Nunjucks and the config
file". The builder is one dependency-free Rust crate, about 600 lines with no crate to fetch, and it
already does everything a generator would do here. **The cost is not worth it. Do not migrate.**

**A React or client-side rewrite.** The document is prose and diagrams. It has no state that a framework
would manage. A rewrite would also break the single-file artifact output, which is a hard requirement.

**Committing `_site/`.** Doubles every diff, creates conflicts inside generated HTML, and buys nothing.
Netlify builds it in a second.

**Dropping the committed `dist/`.** It is the artifact deliverable and the offline guarantee. Keep it and
guard it with the CI check in section 7.

**One Netlify site per document.** Six sites means six configurations, six sets of credits, six preview
URLs on a pull request that touches two documents, and no shared enhancement layer. One site with many
paths is strictly simpler.

**Netlify Edge Functions for routing.** Static redirects do this. Edge Functions add a runtime and a
compute bill to solve a problem `_redirects` already solved.

**Installing a toolchain by hand with `curl https://sh.rustup.rs | sh`.** `rustup` is already on the
image's PATH. A `rust-toolchain` file is the documented way and it is one line. Do not fight the image.

**Netlify's Pretty URLs and asset post-processing.** The build already produces exactly the file it wants
served. Post-processing can only rewrite it into something you did not test.

**Netlify Forms for comments.** It is tempting because it is free and needs no function. It gives you no
threading, no read API from the page, and no edit or delete. It is the wrong shape.

---

## 12. Order of work

1. Add `id` and `slug` to `example/doc.json`, `templates/components/doc.json`, and
   `templates/skeleton/doc.json`. Generate each id with `openssl rand -hex 3`. **Blocks everything else.**
2. Write the `--site` mode in `templates/docbuild/src/main.rs`. Run it. Confirm `_site/` holds one
   directory per document and that `git diff` is empty afterwards.
3. Add `_site/` to `.gitignore`.
4. Write `netlify.toml` and the one-line `rust-toolchain` file.
5. Connect the repository to a new Netlify project. Set the build command and publish directory from
   `netlify.toml`. Choose the plan using section 8, after the authentication area has decided.
6. Open a throwaway pull request. Confirm the deploy preview URL renders every document.
7. Add `.github/workflows/build.yml`.
8. Add `templates/enhance/enhance.js` with the stub from section 6. Confirm the artifact build still has
   no script tag, and that `dist/example.html` still opens correctly from `file://`.
9. Hand `window.DOC` to the other areas.
10. Update `templates/README.md`: document `id`, `slug`, `aliases`, the rename procedure, and
    `docbuild --site`.

---

## 13. Dependencies on other areas

1. **Authentication decides the Netlify plan, and the plan is a real cost.** If access control is Netlify
   project visibility, Pro at $20/month is required, because Free and Personal show a private project to
   the Team Owner only. If access control is Netlify Identity inside the page plus a function gate, the
   project stays public and Personal at $9/month is enough. I cannot pick the plan until that area
   decides. **This is the highest-priority cross-area question.**
2. **Every stateful area must key on `window.DOC.id`, not the slug and not the path.** Comments, threads,
   inline edits, and history all break on a rename otherwise. Section 9 defines the id and section 6
   exposes it.
3. **The first npm import inside a function forces a root `package.json`.** That is fine and does not
   affect the writer, but that area owns the file and its lockfile. Pinned versions checked 2026-09-01:
   `@netlify/functions@6.0.0`, `@netlify/blobs@11.0.2`, `@netlify/neon@0.1.2`, `netlify-cli@27.4.2`.
   `[functions] node_bundler = "esbuild"` is already set in section 4.
4. **The commenting area should evaluate the Netlify Drawer first.** It already gives free threaded
   comments on deploy previews. Only commenting on the published document needs to be built.
5. **The persistence area should price its own compute against the credit table in section 8**, not
   against the old build-minutes model.
