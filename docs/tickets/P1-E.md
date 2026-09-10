# P1-E — Netlify configuration, the site build mode, and CI

## Outcome

`templates/build --site` deterministically builds every publishable document into a clean-URL Netlify site while refreshing the byte-stable artifact copies, and the repository has fail-closed Netlify configuration plus CI that enforces privacy, type safety, site generation, and committed-output freshness.

## Context

The repository currently builds one self-contained artifact at a time, but a repo-backed deployment needs one discoverable site containing every document, permanent links that survive slug changes, protected deploy previews, and a root index.
This ticket adds that second output mode through the existing TypeScript builder so the artifact and hosted copies share composition rather than becoming two implementations.
It also makes the edge-gate declaration testable now even though P2-A creates the gate itself later.

## Scope

### In scope

- Add one `--site` branch to the existing `docbuild` CLI and document it in CLI help without changing the single-instance command.
- Add a TypeScript site module that discovers publishable documents, validates the P1-A identity/route metadata, calls the shared `build()` function for each document, and writes `_site/` from scratch.
- Produce clean document URLs, a deterministic root index, permanent-ID redirects, alias redirects, conditional preview noindex headers, and an optional content-hashed hosted enhancer asset.
- Copy the planned root static page directories `login/` and `invite/` into `_site/` when they exist, so P2-A and P4-K can add those pages without reopening the site builder.
- Add the complete root `netlify.toml`, including the future P2-A edge-gate target and its exact fail-closed exclusions.
- Ignore `_site/` and amend the existing GitHub Actions workflow so the scrub gate remains first and site/config checks join the current TypeScript and `dist/` checks.
- Keep Node 18 as the local builder minimum while selecting Node 22 in Netlify and CI so P1-C's later root Functions package satisfies its `>=22.12.0` engine requirement.

### Out of scope

- Adding or changing `id`, `slug`, or `aliases` in any `doc.json`; P1-A owns those files and their source-data contract.
- Changing shared document composition, placeholders, hook order, `{{DOC_ID}}`, or `layout.html`; P1-B owns those files and contracts.
- Creating `templates/enhance/enhance.js`; this ticket only defines deterministic behavior if that optional source appears.
- Implementing the edge gate, login/logout Functions, or `login/index.html`; P2-A owns them.
- Implementing `invite/index.html` or invitation acceptance; P4-K owns them.
- Creating the root Functions `package.json`, installing server dependencies, or implementing identity; P1-C owns that package and contract.
- Connecting a Netlify account, enabling Identity, setting project visibility, creating a site, opening or merging a pull request, or changing repository settings.
- Supporting standalone-file deployment (Mode A), fetching live comments into an artifact, committing `_site/`, introducing a static-site generator, or adding a runtime dependency.
- Editing `templates/build`, `templates/check-dist`, `templates/docbuild/src/index.ts`, `templates/base/layout.html`, any generated `dist/*.html`, or any research document by hand.
- Documenting the author-facing `--site` and rename procedures in `templates/README.md`; P4-G owns that documentation.

## Interface contract

### TypeScript site module

Create `templates/docbuild/src/site.ts` with these exact exported interfaces and functions:

```ts
export interface SiteDocument {
  instance: string;
  id: string;
  slug: string;
  aliases: string[];
}

export interface SiteBuildResult {
  outDir: string;
  documents: SiteDocument[];
  enhancerUrl: string | null;
}

/** First eight lower-case hexadecimal characters of SHA-256(bytes). */
export function contentHash(bytes: Uint8Array): string;

/** Build the complete repo-backed site and refresh each artifact copy. */
export function buildSite(root: string): SiteBuildResult;
```

`SiteBuildResult.outDir` is exactly `resolve(root, "_site")`: an absolute, platform-native filesystem path with no trailing path separator.
It is not `_site`, `_site/`, a repo-relative path, or a URL.
`documents` contains the validated records in ascending slug order, with each `instance` stored as a repo-relative `/`-separated path and each `aliases` array copied in source order.
`enhancerUrl` is either the root-relative URL described below or `null`.

`contentHash()` uses only `node:crypto`; no package may be added.
It is a deterministic cache-busting name, not a security boundary.
For the UTF-8 bytes of the invented string `invented enhancer\n`, it returns `5b39bbbb`.

Every expected discovery, metadata, build, copy, and write failure throws `BuildError` from `templates/docbuild/src/index.ts`.
The CLI therefore prints one `error: <message>` line and exits `1` without a stack trace.
Unexpected programming errors continue to propagate as they do in the current CLI.

### `templates/build --site` CLI behavior

`templates/build` remains unchanged: it compiles the TypeScript builder when missing or stale and forwards all arguments to `dist/cli.js`.
`templates/docbuild/src/cli.ts` recognizes the exact one-argument form `--site` before treating its argument as an instance path:

```text
templates/build --site
```

On success it exits `0` and ends stdout with routes in ascending slug order:

```text
built 2 documents into _site/
  /components/
  /example/
```

The count and route lines reflect the discovered documents; the two-document output above is exact for the current repository after P1-A is integrated.
Shared builder hooks may print their own diagnostics before this final summary.
Compilation may print `compiling the builder...` to stderr when the wrapper finds stale TypeScript output.

`-h` and `--help` still exit `0`, and their stdout synopsis includes both forms in this order:

```text
    docbuild <instance>
    docbuild --site
```

Zero arguments or more than one argument print help to stdout and exit `2`.
`docbuild <instance>` retains its current build, validation, output lines, exit codes, and trailing-slash normalization.
No other flag is introduced, and a one-argument unknown flag retains the current behavior of being treated as an instance path and failing with `error: no such instance directory: <value>`.

### Site discovery and metadata validation

`buildSite(root)` recursively walks `root` in lexicographic directory-entry order and uses directory-entry/lstat information rather than following symlinks.
A publishable document is any visited directory containing a regular `doc.json` file.
Discovery does not use a registry, a hard-coded instance list, committed `dist/`, or directory names as document identity.

Do not descend into:

- `.git/`, `_site/`, `node_modules/`, `dist/`, or `netlify/` at any depth.
- Any directory whose basename starts with `.`.
- `templates/skeleton/`, which is a copy source rather than a published document.
- Root `login/` and `invite/`, which are reserved static pages and never document instances.

Name-based exclusions are applied before traversal, so an excluded path is neither opened nor followed.
At every other visited path, a symbolic link is a hard error rather than an ignored document or a traversed path:

```text
<repo-relative-path>: symbolic links are not supported in site discovery
```

A symlink at a candidate document's `doc.json` gets the more specific error:

```text
<instance>/doc.json: symbolic links are not supported for document metadata
```

Regular non-directory files other than `doc.json` are ignored during discovery.
This makes discovery deterministic and prevents an apparently in-repository instance from resolving to content outside `root`.

Normalize each discovered `instance` as a repo-relative path with `/` separators, then sort the complete inventory by `slug` before building or emitting any index, redirect, result, or CLI route entry.
If no publishable document exists, throw `BuildError("found no site documents (no publishable directory contains doc.json)")`.

Parse site metadata with the platform's built-in `JSON.parse`; do not add a parser and do not change P1-B's `Doc` interface solely to expose arrays.
Every published `doc.json` must satisfy this subset of P1-A's contract:

```ts
interface SiteMetadata {
  id: string;       // /^[0-9a-f]{6}$/
  slug: string;     // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
  aliases: string[];// each item matches the slug expression
  title: string;    // non-empty; already required by the artifact builder
  heading?: string;
  lede?: string;
}
```

Validation rules are exact:

- `id`, current `slug`, and every alias are required to meet the formats above; do not derive or generate a missing value.
- IDs are unique across published documents.
- Each current slug and alias is a globally unique route name across published documents.
- An alias cannot equal its document's current slug or repeat inside its own array.
- `api`, `d`, `login`, `invite`, and `_assets` are reserved route names and cannot be a slug or alias.
- `aliases` must be an array of strings; a scalar, `null`, mixed array, or omitted field fails the site build.
- Preserve alias array order inside one document when writing redirects; source order is committed input and therefore deterministic.
- `heading` and `lede`, when present, must be strings for index rendering. The displayed name is `heading ?? title`; a missing `lede` becomes the empty string.

Use these stable expected-failure forms:

```text
<instance>/doc.json: <JSON.parse error>
<instance>/doc.json: missing or invalid 'id' (expected six lowercase hexadecimal characters)
<instance>/doc.json: missing or invalid 'slug' (expected one lowercase kebab-case path segment)
<instance>/doc.json: missing or invalid 'aliases' (expected an array of lowercase kebab-case path segments)
<instance>/doc.json: missing or invalid 'title' (expected a non-empty string)
<instance>/doc.json: invalid 'heading' (expected a string when present)
<instance>/doc.json: invalid 'lede' (expected a string when present)
templates/enhance/enhance.js: expected a regular file when present
duplicate document id: <id> (<first-instance>, <second-instance>)
duplicate site route: <route> (<first-instance>, <second-instance>)
reserved site route: <route> (<instance>)
```

Filesystem failures prefix the repo-relative source or destination path and retain the operating-system message.
Preflight checks the exact optional enhancer path before recursive document discovery, then validates the complete document inventory and every entry in an existing `login/` or `invite/` tree before `_site/` is deleted or any artifact is rebuilt.
If `templates/enhance/enhance.js` exists but is not a regular file, including when it is a symlink, use the enhancer-specific error above rather than the general discovery error.
Metadata, route, enhancer-type, document-symlink, and static-tree failures therefore preserve the prior `_site/` and every artifact byte.

### Site output and artifact parity

After successful inventory validation, remove the existing `_site/` tree and recreate it.
This guarantees that a removed document, alias, preview header, or old hashed asset cannot survive into a later deploy.
Never remove or overwrite a directory outside the exact `<root>/_site` path.

For every inventory entry, call P1-B's shared `build(root, instance)` exactly once.
That call refreshes `<instance>/dist/<basename>.html`, runs the common history/anchor/editable hook chain when those tickets are present, and returns the artifact path.
Run the existing `check()` against the result; a failed tag-balance check aborts the site build with `BuildError("<instance>: unbalanced tags in the built document")`.
Do not duplicate section parsing, template substitution, optional feature slots, or hook logic in `site.ts`.

Write each hosted page to:

```text
_site/<slug>/index.html
```

The hosted page is the artifact's bytes unchanged when `templates/enhance/enhance.js` is absent.
When the enhancer exists, the hosted page differs only by one final line, adding a separator newline first only if the artifact lacks one:

```html
<script defer src="/_assets/enhance.<hash>.js"></script>
```

P1-B places `<meta name="doc-id">` in the shared layout, so both copies already contain it.
Do not add a site-only document-ID line, a `doc-slug` meta element, conditional template branch, fetched state, or comment snapshot.
The artifact remains self-contained and contains no hosted enhancer tag.

If `templates/enhance/enhance.js` is absent:

- `enhancerUrl` is `null`.
- No enhancer tag is appended to a document.
- `_site/_assets/` is not created merely as an empty directory.

If it exists:

- Read its raw bytes, calculate `contentHash(bytes)`, and copy the bytes unchanged to `_site/_assets/enhance.<hash>.js`.
- Set `enhancerUrl` to `/_assets/enhance.<hash>.js`.
- Append the exact `defer` tag above to every hosted document, and only to hosted documents.
- A byte change changes the filename deterministically; rebuilding unchanged bytes produces the same name and output.

### Static pages

After cleaning `_site/`, copy root `login/` to `_site/login/` and root `invite/` to `_site/invite/` when each source exists.
Copy regular files byte-for-byte, recurse through directories in sorted order, and reject a symlink or unsupported file type with `BuildError` rather than following it outside the repository.
Use this exact symlink error:

```text
<repo-relative-static-path>: symbolic links are not supported in static page trees
```

Absence is a no-op: P1-E must pass before P2-A or P4-K creates either directory.
These pages are not added to the document index, artifact output, redirects, or the `documents` result.

### Root index

Always write `_site/index.html` after all document pages succeed.
It is deterministic, includes `templates/base/theme.css` inline, makes no external request, and lists one row per document in ascending slug order.
It contains an HTML5 doctype, `<html lang="en">`, UTF-8 charset and viewport metadata, `<title>Architecture docs</title>`, one visible `<h1>Architecture docs</h1>`, and exactly one `<ul>` containing exactly one `<li>` per published document.
Each row has this exact semantic structure:

```html
<li><a href="/<slug>/"><b><escaped heading-or-title></b><span><escaped lede-or-empty-string></span></a></li>
```

Escape `&`, `<`, and `>` in displayed text.
Use `heading` when present, otherwise `title`; always emit the `<span>`, using an empty string when `lede` is absent.
Do not put aliases, permanent IDs, filesystem instance names, static pages, feature controls, external `<link>` elements, or any `<script>` element on the root index.
Use only the existing theme variables `--bg`, `--ink`, `--ink-3`, `--border`, and `--sans`; no new CSS source file belongs to this ticket.

### Redirects

Always write `_site/_redirects` with a final newline.
For each document, emit the permanent-ID pair first, then alias pairs in source array order:

```text
/d/<id> /<slug>/ 301
/d/<id>/* /<slug>/ 301
/<alias> /<slug>/ 301!
/<alias>/* /<slug>/:splat 301!
```

Documents are grouped in ascending slug order.
`/d/<id>` is the permanent share URL; `id` never changes and is never derived from a slug or instance.
Alias redirects use forced `301!` rules so an old slug keeps redirecting even if a file later appears at that path.
The wildcard alias rule preserves the splat; the permanent-ID wildcard intentionally lands at the document root.
Do not place generated document redirects in `netlify.toml`.

### Preview noindex behavior

Treat `process.env.CONTEXT ?? "production"` as the build context.
For any value other than `production`, write `_site/_headers` with exactly:

```text
/*
  X-Robots-Tag: noindex
```

Include the final newline.
When context is `production` or absent, `_site/_headers` must not exist; cleaning `_site/` removes a header left by an earlier preview build.
This file supplements, and does not replace, the security and cache headers in `netlify.toml`.

### `netlify.toml`

Create the root file with these relevant blocks and values exactly; comments may explain them but must not change the declarations:

```toml
[build]
  command = "templates/build --site"
  publish = "_site"
  ignore = "git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- ':!*.md' ':!**/dist/**'"

[build.environment]
  NODE_VERSION = "22"

[build.processing]
  skip_processing = true

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[edge_functions]]
  path = "/*"
  excludedPath = ["/login/*", "/api/*", "/_assets/*"]
  function = "gate"

[[headers]]
  for = "/*"
  [headers.values]
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    X-Frame-Options = "SAMEORIGIN"

[[headers]]
  for = "/*"
  [headers.values]
    Cache-Control = "public, max-age=0, must-revalidate"

[[headers]]
  for = "/_assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[context.production.environment]
  DOC_ENV = "production"

[context.deploy-preview.environment]
  DOC_ENV = "preview"

[context.branch-deploy.environment]
  DOC_ENV = "preview"
```

`skip_processing = true` prevents Netlify from rewriting the already-composed HTML.
The `ignore` command exits `0` and skips when the commit changed only Markdown and/or committed `dist/`; any relevant source/config change or an unavailable comparison ref returns nonzero and builds.
`CONTEXT` is supplied by Netlify and drives `_headers`; `DOC_ENV` is the explicit application environment available to later Functions and client behavior.

The edge declaration is intentionally present before `netlify/edge-functions/gate.ts` exists.
P2-A creates that file and owns all gate behavior.
Do not weaken the declaration, add a catch-all exclusion, create a placeholder gate, or remove the block to make a pre-P2-A deploy pass.
`/invite/` remains gated; the only exclusions are the login page, self-authorizing API endpoints, and immutable assets.

### `.gitignore`

Append exactly this root site-output rule and preserve every current entry:

```gitignore
_site/
```

Do not ignore committed per-document `dist/` outputs, source metadata, generated `anchors.json`, or generated `history.json`.

### GitHub Actions workflow

Amend the existing `.github/workflows/check.yml`; do not create the obsolete `.github/workflows/build.yml` path named in older research.
Keep the workflow triggers as push to `main` plus every pull request, keep one `check` job on `ubuntu-latest`, and use this step order and commands:

```yaml
name: check
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: scrub gate
        run: scripts/scrub-check.sh

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - name: typecheck
        run: npm --prefix templates/docbuild ci --no-audit --no-fund && npm --prefix templates/docbuild run check

      - name: edge gate config is fail-closed
        run: |
          node --input-type=module <<'NODE'
          import assert from "node:assert/strict";
          import { readFileSync } from "node:fs";

          const toml = readFileSync("netlify.toml", "utf8");
          const marker = "[[edge_functions]]";
          const start = toml.indexOf(marker);
          assert.notEqual(start, -1, "missing [[edge_functions]] block");
          assert.equal(toml.indexOf(marker, start + marker.length), -1, "expected exactly one edge_functions block");
          const tail = toml.slice(start + marker.length);
          const nextBlock = tail.search(/^\[/m);
          const block = nextBlock === -1 ? tail : tail.slice(0, nextBlock);
          assert.match(block, /^\s*path\s*=\s*"\/\*"\s*$/m);
          assert.match(block, /^\s*function\s*=\s*"gate"\s*$/m);
          const line = block.match(/^\s*excludedPath\s*=\s*\[(.*)\]\s*$/m);
          assert.ok(line, "missing excludedPath");
          const quoted = [...line[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
          assert.deepEqual(quoted, ["/login/*", "/api/*", "/_assets/*"]);
          assert.equal(line[1].replace(/"[^"]+"/g, "").replace(/[\s,]/g, ""), "");
          console.log("PASS  edge gate config is fail-closed");
          NODE

      - name: complete site builds
        run: templates/build --site

      - name: every document rebuilds byte-identically
        run: templates/check-dist
```

The scrub gate remains the first executable repository command.
Node 22 is intentional: `@aiur-team/archon` continues to declare Node `>=18`, while the root Functions package P1-C later creates declares Node `>=22.12.0`.
The edge assertion prevents a future edit from silently publishing every document by removing the gate, changing its target, or widening its exclusions.
The site command proves the deploy entry point; `templates/check-dist` then compares the refreshed committed artifacts to git and fails if a writer forgot to commit them.

## Files owned

- `netlify.toml` — **new**; created by P1-E, and later tickets may rely on it but do not own its declarations.
- `.gitignore` — **amended**; pre-existing before the Build Order, so no ticket created it.
- `templates/docbuild/src/site.ts` — **new**; created by P1-E as the complete repo-backed site builder.
- `templates/docbuild/src/cli.ts` — **amended**; pre-existing before the Build Order, so no ticket created it. P1-E owns only the `--site` dispatch and help integration in this amendment.
- `.github/workflows/check.yml` — **amended**; pre-existing before the Build Order, so no ticket created it.

Generated `_site/**` and compiler output under `templates/docbuild/dist/` are ignored build products, not implementation files.
Per-document `dist/*.html` files are committed artifacts refreshed by the shared builder, not hand-edited implementation surfaces.
No other file is owned by this ticket.

## Dependencies

P1-E is a Phase 1 root with no Build Order scheduling dependency.
Its source/configuration paths are disjoint from P1-A, P1-B, and P1-C, but P1-D amends `anchors.ts`, which P1-B creates.
Use these safe Phase 1 waves:

1. **Wave 1 — isolated worktrees:** P1-A, P1-B, P1-C, and P1-E may implement their owned source/configuration files in parallel.
2. **Wave 2 — after P1-B:** P1-D starts from or rebases onto P1-B, then amends only P1-B's `anchors.ts` stub and its own declared fixture.
3. **P1-E integration:** integrate P1-A and P1-B before running P1-E's real-repository site/parity acceptance commands.
4. **Serialized final gate:** one integrator refreshes committed per-document artifacts, compiles ignored TypeScript output, builds `_site/`, then runs the repository checks on the combined tree.

Generated `dist/*.html`, ignored `templates/docbuild/dist/**`, and ignored `_site/**` are shared integration products.
They are not concurrently owned source surfaces, and parallel ticket agents must not hand-edit, commit, or use them to claim overlapping ownership.

| Boundary | Exact contract P1-E uses | Parallel/integration rule |
|---|---|---|
| P1-A | Every published `doc.json` supplies valid, globally unique `id`, `slug`, and `aliases` values | `site.ts`, CLI, config, ignore, and workflow work may proceed in parallel. The real-repository `templates/build --site` acceptance run waits until P1-A data is integrated; missing metadata must fail rather than be derived. |
| P1-B | `build(root, instance)` remains the only composition path, `check(path)` remains available, and the shared layout emits `<meta name="doc-id">` when P1-A data exists | P1-E must not edit `index.ts`, `layout.html`, or P1-B's hook stubs. Implementation may proceed in parallel; artifact/site byte-parity verification is final only after P1-B is integrated. |
| P1-C | The later root Functions package requires Node `>=22.12.0` | No code dependency and no shared file. P1-E selects Node 22 in Netlify/CI now so the later server package and the Node `>=18` builder share one supported runtime. |
| P1-D | Anchor generation eventually runs inside P1-B's shared `build()` path | No file is shared with P1-E, but P1-D is Wave 2 because it amends a P1-B-created stub. A site build receives anchors after integration without a P1-E change. |
| P2-A | Creates `netlify/edge-functions/gate.ts`, login/logout Functions, and `login/index.html` | P2-A is not a P1-E dependency or Phase 1 acceptance gate. P1-E points at `gate` and tolerates absent `login/`; do not create a placeholder or move P2-A work into this ticket. |
| P4-K | Creates `invite/index.html` and invitation acceptance | The optional `invite/` copy seam is prepared now, so P4-K does not need to amend site code. The page remains gated because `/invite/*` is not an edge exclusion. |

Within P1-E, three work lanes are independent until verification: (1) `site.ts` plus the coupled CLI dispatch, (2) `netlify.toml` plus `.gitignore`, and (3) the existing CI workflow amendment.
Do not split `site.ts` and `cli.ts` across concurrent writers because one defines and the other consumes the same new interface.

Live Netlify verification is an integration boundary, not an implementation dependency.
The declared `gate` file is absent until P2-A by design, so a provider-side deploy that rejects the missing target does not authorize removing the fail-closed block.

**Deferred cross-ticket verification, not P1-E acceptance:** after P2-A lands, that ticket or the phase integrator must open the throwaway pull request and prove the live deploy preview renders every document, carries `X-Robots-Tag: noindex`, leaves `/login/` reachable, and applies the gate to document routes.
P1-E's Phase 1 Definition of Done stops at deterministic local preview-header generation, the exact fail-closed declaration, and green repository gates after P1-A/P1-B integration.

## Acceptance criteria

- [ ] `templates/build --site` is the only site-build entry point, exits `0` after a valid build, prints the exact final summary contract, and is present in `--help`.
- [ ] The existing `templates/build <instance>` behavior and `templates/build` wrapper remain unchanged.
- [ ] `buildSite(root)` returns `outDir` as exactly `resolve(root, "_site")`: an absolute, platform-native path with no trailing separator; it never returns a repo-relative path or URL.
- [ ] Discovery finds the current `example` and `templates/components` documents, excludes the skeleton and infrastructure/generated directories, rejects every non-excluded symlink with the documented boundary-specific error, and sorts output by slug.
- [ ] Missing, malformed, duplicate, colliding, or reserved P1-A metadata—including non-string optional `heading` or `lede`—fails before `_site/` is replaced or any artifact is rebuilt, using `BuildError` and the documented exact messages.
- [ ] Each publishable document is composed once through the shared `build()` path and checked, producing `_site/<slug>/index.html` and refreshing its committed artifact.
- [ ] With no enhancer source, each hosted document is byte-identical to its artifact, no tag is appended, and no empty `_assets/` directory is created.
- [ ] With an enhancer source, the SHA-256-derived eight-hex filename and copied bytes are deterministic, and hosted documents differ from artifacts by only the exact final script line.
- [ ] `_site/index.html`, `_site/_redirects`, and conditional `_site/_headers` are deterministic and contain the exact routes/header behaviors in this contract.
- [ ] Permanent `/d/<id>` routes and every alias route target the current slug; alias splats are preserved and route collisions cannot overwrite a document or reserved path.
- [ ] Existing `login/` and `invite/` trees copy byte-for-byte when present and their absence does not fail P1-E.
- [ ] A preview or branch build writes `X-Robots-Tag: noindex`; a production or local build with no `CONTEXT` has no `_headers` file.
- [ ] `netlify.toml` uses `_site`, one `templates/build --site` command, Node 22, no HTML post-processing, the exact Functions config, security/cache headers, environment blocks, and one gate on `/*` with exactly three exclusions.
- [ ] `.gitignore` ignores `_site/` without ignoring committed document artifacts.
- [ ] `.github/workflows/check.yml` retains its current triggers/job and runs scrub first, Node 22 setup, typecheck, fail-closed gate assertion, full site build, and `templates/check-dist` in that order.
- [ ] Strict TypeScript checking passes with `noUncheckedIndexedAccess` and no runtime dependency is added to `@aiur-team/archon`.
- [ ] After P1-A and P1-B are integrated and committed artifacts are refreshed, a site build followed by `git diff --exit-code -- '*/dist/*.html'` is clean.
- [ ] No file outside the five owned implementation paths changes, apart from ignored/generated outputs produced while testing.
- [ ] The repository scrub gate passes for this ticket and all implementation changes.
- [ ] GitHub issue #5 retains the exact ticket title and exact two-paragraph canonical-document pointer; its parsed full commit SHA and path resolve through `git show` to bytes identical to `docs/tickets/P1-E.md`.

## Test plan

Run local commands from the repository root.
The full site tests require P1-A's metadata and P1-B's shared layout/hook contract to be integrated; `site.ts`, CLI, configuration, ignore, and workflow authoring can occur before that point.

1. Typecheck and compile the dependency-free builder:

   ```bash
   npm --prefix templates/docbuild run check
   npm --prefix templates/docbuild run build
   ```

   Expected: both commands exit `0` with no TypeScript diagnostics.
   `templates/docbuild/package.json` still has no `dependencies` field and still declares `engines.node` as `>=18`.

2. Run one cleanup-safe fixture outside the repository to prove the exported result, enhancer-present and enhancer-absent parity, static copies, metadata preflight, both symlink boundaries, redirects, and full root-index semantics:

   ```bash
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { createHash } from "node:crypto";
   import {
     cpSync,
     existsSync,
     mkdirSync,
     mkdtempSync,
     readFileSync,
     rmSync,
     symlinkSync,
     writeFileSync,
   } from "node:fs";
   import { tmpdir } from "node:os";
   import { basename, dirname, join, resolve, sep } from "node:path";
   import { BuildError } from "./templates/docbuild/dist/index.js";
   import { buildSite, contentHash } from "./templates/docbuild/dist/site.js";

   const sha256Prefix = (bytes) => createHash("sha256").update(bytes).digest("hex").slice(0, 8);

   const fixture = mkdtempSync(join(tmpdir(), "p1-e-site-"));
   const write = (path, value) => {
     mkdirSync(dirname(path), { recursive: true });
     writeFileSync(path, value);
   };
   const section = `<!--
   id: overview
   label: Overview
   summary: An invented fixture section.
   -->
   <!-- body -->
   <p>Fixture body.</p>
   `;
   const writeDocument = (instance, doc) => {
     const dir = join(fixture, instance);
     mkdirSync(join(dir, "sections"), { recursive: true });
     writeFileSync(join(dir, "doc.json"), `${JSON.stringify(doc, null, 2)}\n`);
     writeFileSync(join(dir, "sections", "01-overview.html"), section);
   };
   const expectBuildError = (expected) => {
     let thrown;
     try {
       buildSite(fixture);
     } catch (error) {
       thrown = error;
     }
     assert.ok(thrown instanceof BuildError, `expected BuildError, got ${thrown}`);
     assert.equal(thrown.message, expected);
   };

   try {
     cpSync("templates/base", join(fixture, "templates", "base"), { recursive: true });
     writeDocument("nested/alpha-source", {
       id: "a1b2c3",
       slug: "alpha-route",
       aliases: ["former-alpha"],
       title: "Alpha title",
       heading: "Alpha & <Overview>",
       lede: "First > second & safe",
     });
     writeDocument("zeta-source", {
       id: "d4e5f6",
       slug: "zeta-route",
       aliases: [],
       title: "Zeta title",
     });
     write(join(fixture, "login", "index.html"), "invented login page\n");
     write(join(fixture, "invite", "nested", "help.txt"), "invented invite help\n");
     const enhancerBytes = Buffer.from('console.log("invented enhancer")\n');
     const enhancerSource = join(fixture, "templates", "enhance", "enhance.js");
     write(enhancerSource, enhancerBytes);

     const plainBytes = new TextEncoder().encode("invented enhancer\n");
     assert.equal(sha256Prefix(plainBytes), "5b39bbbb");
     assert.equal(contentHash(plainBytes), "5b39bbbb");
     const hash = sha256Prefix(enhancerBytes);
     assert.equal(hash, "770200c2");
     assert.equal(contentHash(enhancerBytes), hash);

     const result = buildSite(fixture);
     assert.equal(result.outDir, resolve(fixture, "_site"));
     assert.equal(result.outDir.endsWith(sep), false);
     assert.equal(result.enhancerUrl, `/_assets/enhance.${hash}.js`);
     assert.deepEqual(result.documents, [
       { instance: "nested/alpha-source", id: "a1b2c3", slug: "alpha-route", aliases: ["former-alpha"] },
       { instance: "zeta-source", id: "d4e5f6", slug: "zeta-route", aliases: [] },
     ]);

     const asset = join(result.outDir, "_assets", `enhance.${hash}.js`);
     assert.deepEqual(readFileSync(asset), enhancerBytes);
     const tag = `<script defer src="/_assets/enhance.${hash}.js"></script>\n`;
     for (const doc of result.documents) {
       const artifact = readFileSync(join(fixture, doc.instance, "dist", `${basename(doc.instance)}.html`), "utf8");
       const hosted = readFileSync(join(result.outDir, doc.slug, "index.html"), "utf8");
       assert.equal(hosted, `${artifact}${artifact.endsWith("\n") ? "" : "\n"}${tag}`);
       assert.equal(artifact.includes("/_assets/enhance."), false);
     }

     assert.equal(readFileSync(join(result.outDir, "login", "index.html"), "utf8"), "invented login page\n");
     assert.equal(readFileSync(join(result.outDir, "invite", "nested", "help.txt"), "utf8"), "invented invite help\n");
     assert.equal(
       readFileSync(join(result.outDir, "_redirects"), "utf8"),
       "/d/a1b2c3 /alpha-route/ 301\n" +
         "/d/a1b2c3/* /alpha-route/ 301\n" +
         "/former-alpha /alpha-route/ 301!\n" +
         "/former-alpha/* /alpha-route/:splat 301!\n" +
         "/d/d4e5f6 /zeta-route/ 301\n" +
         "/d/d4e5f6/* /zeta-route/ 301\n",
     );

     const index = readFileSync(join(result.outDir, "index.html"), "utf8");
     const theme = readFileSync(join(fixture, "templates", "base", "theme.css"), "utf8");
     const alphaRow = '<li><a href="/alpha-route/"><b>Alpha &amp; &lt;Overview&gt;</b><span>First &gt; second &amp; safe</span></a></li>';
     const zetaRow = '<li><a href="/zeta-route/"><b>Zeta title</b><span></span></a></li>';
     assert.match(index, /^<!doctype html>/i);
     assert.match(index, /<html lang="en">/);
     assert.match(index, /<meta charset="utf-8">/);
     assert.match(index, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
     assert.match(index, /<title>Architecture docs<\/title>/);
     assert.match(index, /<h1>Architecture docs<\/h1>/);
     assert.equal((index.match(/<ul>/g) ?? []).length, 1);
     assert.equal((index.match(/<li>/g) ?? []).length, 2);
     assert.ok(index.includes(theme));
     assert.ok(index.includes(alphaRow));
     assert.ok(index.includes(zetaRow));
     assert.ok(index.indexOf(alphaRow) < index.indexOf(zetaRow));
     for (const forbidden of ["a1b2c3", "d4e5f6", "former-alpha", "nested/alpha-source", "zeta-source"]) {
       assert.equal(index.includes(forbidden), false, `index leaked ${forbidden}`);
     }
     assert.equal(/<script\b/i.test(index), false);
     assert.equal(/<link\b/i.test(index), false);

     rmSync(enhancerSource);
     const withoutEnhancer = buildSite(fixture);
     assert.equal(withoutEnhancer.enhancerUrl, null);
     assert.equal(existsSync(join(withoutEnhancer.outDir, "_assets")), false);
     for (const doc of withoutEnhancer.documents) {
       const artifact = readFileSync(join(fixture, doc.instance, "dist", `${basename(doc.instance)}.html`), "utf8");
       assert.equal(readFileSync(join(withoutEnhancer.outDir, doc.slug, "index.html"), "utf8"), artifact);
     }

     const sentinel = join(withoutEnhancer.outDir, "preflight-sentinel.txt");
     writeFileSync(sentinel, "preserve me\n");
     const artifactsBefore = new Map(
       withoutEnhancer.documents.map((doc) => [
         doc.instance,
         readFileSync(join(fixture, doc.instance, "dist", `${basename(doc.instance)}.html`)),
       ]),
     );
     const assertPreflightPreserved = () => {
       assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n");
       for (const [instance, before] of artifactsBefore) {
         assert.deepEqual(readFileSync(join(fixture, instance, "dist", `${basename(instance)}.html`)), before);
       }
     };

     writeDocument("bad-id", { slug: "bad-id", aliases: [], title: "Bad id fixture" });
     expectBuildError("bad-id/doc.json: missing or invalid 'id' (expected six lowercase hexadecimal characters)");
     assertPreflightPreserved();
     rmSync(join(fixture, "bad-id"), { recursive: true });

     writeDocument("bad-heading", { id: "b0b0b0", slug: "bad-heading", aliases: [], title: "Bad heading fixture", heading: 7 });
     expectBuildError("bad-heading/doc.json: invalid 'heading' (expected a string when present)");
     assertPreflightPreserved();
     rmSync(join(fixture, "bad-heading"), { recursive: true });

     writeDocument("bad-lede", { id: "c0c0c0", slug: "bad-lede", aliases: [], title: "Bad lede fixture", lede: false });
     expectBuildError("bad-lede/doc.json: invalid 'lede' (expected a string when present)");
     assertPreflightPreserved();
     rmSync(join(fixture, "bad-lede"), { recursive: true });

     mkdirSync(join(fixture, "linked-doc", "sections"), { recursive: true });
     writeFileSync(join(fixture, "linked-doc", "sections", "01-overview.html"), section);
     symlinkSync(join(fixture, "nested", "alpha-source", "doc.json"), join(fixture, "linked-doc", "doc.json"));
     expectBuildError("linked-doc/doc.json: symbolic links are not supported for document metadata");
     assertPreflightPreserved();
     rmSync(join(fixture, "linked-doc"), { recursive: true });

     symlinkSync(join(fixture, "nested", "alpha-source"), join(fixture, "linked-directory"), "dir");
     expectBuildError("linked-directory: symbolic links are not supported in site discovery");
     assertPreflightPreserved();
     rmSync(join(fixture, "linked-directory"));

     symlinkSync(join(fixture, "login", "index.html"), join(fixture, "login", "linked.html"));
     expectBuildError("login/linked.html: symbolic links are not supported in static page trees");
     assertPreflightPreserved();

     console.log("PASS  isolated site fixture covers output and preflight contracts");
   } finally {
     rmSync(fixture, { recursive: true, force: true });
   }
   NODE
   ```

   Expected: exit `0` and stdout ends with `PASS  isolated site fixture covers output and preflight contracts`; shared builder-hook diagnostics may precede that line after P1-D integration.
   The fixture lives under the operating system's temporary directory, removes itself in `finally` even after an assertion failure, and never creates or edits a repository source file owned by P1-A, P1-B, P2-A, P4-K, or any other ticket.

3. Verify CLI help and bad-arity behavior:

   ```bash
   templates/build --help | grep -F 'docbuild --site'
   set +e
   p1e_no_args="$(templates/build 2>&1)"
   status=$?
   set -e
   test "$status" -eq 2
   printf '%s\n' "$p1e_no_args" | grep -F 'docbuild --site'
   ```

   Expected: exit `0`; both `grep` calls print the `docbuild --site` synopsis line and the inner no-argument invocation exits `2`.

4. Build the production-shaped site with `CONTEXT` absent:

   ```bash
   unset CONTEXT
   templates/build --site
   ```

   Expected: exit `0`; stdout ends exactly with:

   ```text
   built 2 documents into _site/
     /components/
     /example/
   ```

   `_site/index.html`, `_site/_redirects`, `_site/components/index.html`, and `_site/example/index.html` exist.
   `_site/_headers` does not exist.

5. Verify discovery results, redirect ordering, root-index ordering, artifact parity, and current enhancer behavior:

   ```bash
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { existsSync, readFileSync } from "node:fs";
   import { createHash } from "node:crypto";

   const docs = ["example", "templates/components"]
     .map((instance) => ({ instance, doc: JSON.parse(readFileSync(`${instance}/doc.json`, "utf8")) }))
     .sort((a, b) => a.doc.slug.localeCompare(b.doc.slug));

   const enhancerSource = "templates/enhance/enhance.js";
   let enhancerTag = "";
   if (existsSync(enhancerSource)) {
     const bytes = readFileSync(enhancerSource);
     const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
     const asset = `_site/_assets/enhance.${hash}.js`;
     assert.deepEqual(readFileSync(asset), bytes);
     enhancerTag = `<script defer src="/_assets/enhance.${hash}.js"></script>\n`;
   } else {
     assert.equal(existsSync("_site/_assets"), false);
   }

   const redirects = [];
   for (const { instance, doc } of docs) {
     const name = instance.split("/").at(-1);
     const artifact = readFileSync(`${instance}/dist/${name}.html`, "utf8");
     const hosted = readFileSync(`_site/${doc.slug}/index.html`, "utf8");
     const expected = enhancerTag === "" ? artifact : `${artifact}${artifact.endsWith("\n") ? "" : "\n"}${enhancerTag}`;
     assert.equal(hosted, expected, `${doc.slug}: artifact/site parity`);
     redirects.push(`/d/${doc.id} /${doc.slug}/ 301`, `/d/${doc.id}/* /${doc.slug}/ 301`);
     for (const alias of doc.aliases) {
       redirects.push(`/${alias} /${doc.slug}/ 301!`, `/${alias}/* /${doc.slug}/:splat 301!`);
     }
   }
   assert.equal(readFileSync("_site/_redirects", "utf8"), `${redirects.join("\n")}\n`);

   const index = readFileSync("_site/index.html", "utf8");
   const routeOffsets = docs.map(({ doc }) => index.indexOf(`href="/${doc.slug}/"`));
   assert.ok(routeOffsets.every((offset) => offset >= 0));
   assert.deepEqual(routeOffsets, [...routeOffsets].sort((a, b) => a - b));
   assert.equal(index.includes("templates/skeleton"), false);
   assert.equal(existsSync("_site/_headers"), false);
   console.log("PASS  deterministic site output and artifact parity");
   NODE
   ```

   Expected: exit `0` and exactly `PASS  deterministic site output and artifact parity`.

6. Prove preview noindex and stale-file cleanup, then restore the normal local output:

   ```bash
   mkdir -p _site/retired-route _site/_assets
   : > _site/retired-route/index.html
   : > _site/_assets/enhance.deadbeef.js
   CONTEXT=deploy-preview templates/build --site
   test ! -e _site/retired-route/index.html
   test ! -e _site/_assets/enhance.deadbeef.js
   diff -u <(printf '/*\n  X-Robots-Tag: noindex\n') _site/_headers
   unset CONTEXT
   templates/build --site >/dev/null
   test ! -e _site/_headers
   ```

   Expected: exit `0` and no `diff` output.
   The retired route, stale asset, and preview-only header are absent after the corresponding clean rebuild.

7. Verify the fail-closed Netlify declaration independently of YAML execution:

   ```bash
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";

   const toml = readFileSync("netlify.toml", "utf8");
   const marker = "[[edge_functions]]";
   const start = toml.indexOf(marker);
   assert.notEqual(start, -1, "missing [[edge_functions]] block");
   assert.equal(toml.indexOf(marker, start + marker.length), -1, "expected exactly one edge_functions block");
   const tail = toml.slice(start + marker.length);
   const nextBlock = tail.search(/^\[/m);
   const block = nextBlock === -1 ? tail : tail.slice(0, nextBlock);
   assert.match(block, /^\s*path\s*=\s*"\/\*"\s*$/m);
   assert.match(block, /^\s*function\s*=\s*"gate"\s*$/m);
   const line = block.match(/^\s*excludedPath\s*=\s*\[(.*)\]\s*$/m);
   assert.ok(line, "missing excludedPath");
   const quoted = [...line[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
   assert.deepEqual(quoted, ["/login/*", "/api/*", "/_assets/*"]);
   assert.equal(line[1].replace(/"[^"]+"/g, "").replace(/[\s,]/g, ""), "");
   console.log("PASS  edge gate config is fail-closed");
   NODE
   ```

   Expected: exit `0` and exactly `PASS  edge gate config is fail-closed`.

8. Run the repository gates after committed artifacts have been refreshed by their owning integration changes:

   ```bash
   templates/check-dist
   git diff --exit-code -- '*/dist/*.html'
   scripts/scrub-check.sh docs/tickets/P1-E.md netlify.toml .gitignore templates/docbuild/src/site.ts templates/docbuild/src/cli.ts .github/workflows/check.yml
   ```

   Expected: all commands exit `0`; `templates/check-dist` ends with `PASS  every committed document is byte-identical after a rebuild`, `git diff` prints nothing, and the scrub check ends with `PASS  no denied term and no warning.`

9. Confirm the implementation diff respects ticket and generated-output boundaries:

   ```bash
   git diff --name-only -- netlify.toml .gitignore templates/docbuild/src/site.ts templates/docbuild/src/cli.ts .github/workflows/check.yml
   git status --short
   ```

   Expected: P1-E contributes only the five owned implementation paths plus `docs/tickets/P1-E.md` on the coordination branch.
   `_site/` and `templates/docbuild/dist/` do not appear; other agents' ticket documents may appear as separately owned untracked files.

10. After the canonical document is committed, pushed, and linked from the tracker, verify the immutable issue pointer:

   ```bash
   set -euo pipefail
   p1e_issue_json="$(mktemp "${TMPDIR:-/tmp}/p1-e-issue.XXXXXX")"
   p1e_linked_blob="$(mktemp "${TMPDIR:-/tmp}/p1-e-linked.XXXXXX")"
   trap 'rm -f "$p1e_issue_json" "$p1e_linked_blob"' EXIT
   gh issue view 5 --repo aiur-team/architecture-docs --json title,body >"$p1e_issue_json"
   read -r p1e_commit_sha p1e_linked_path < <(
     P1E_ISSUE_JSON="$p1e_issue_json" \
     P1E_TICKET_PATH="docs/tickets/P1-E.md" \
     P1E_EXPECTED_TITLE="P1-E — Netlify configuration, the site build mode, and CI" \
       node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";

   const issue = JSON.parse(readFileSync(process.env.P1E_ISSUE_JSON, "utf8"));
   assert.equal(issue.title, process.env.P1E_EXPECTED_TITLE, "issue title changed");
   const match = issue.body.match(/^Implementation specification: \[`([^`\n]+)`\]\(https:\/\/github\.com\/aiur-team\/architecture-docs\/blob\/([0-9a-f]{40})\/([^)\n]+)\)\n\nThis issue tracks implementation of the linked canonical specification\.$/);
   assert.ok(match, "issue body is not the exact two-paragraph pointer form");
   assert.equal(match[1], process.env.P1E_TICKET_PATH, "link label path changed");
   assert.equal(match[3], process.env.P1E_TICKET_PATH, "link target path changed");
   process.stdout.write(`${match[2]} ${match[3]}\n`);
   NODE
   )
   git show "$p1e_commit_sha:$p1e_linked_path" >"$p1e_linked_blob"
   cmp -s docs/tickets/P1-E.md "$p1e_linked_blob"
   rm -f "$p1e_issue_json" "$p1e_linked_blob"
   trap - EXIT
   echo "PASS  P1-E issue #5 points to the byte-identical canonical document"
   ```

   Expected: exit `0` and exactly `PASS  P1-E issue #5 points to the byte-identical canonical document`. The gate fails if the title changes, the body differs from the exact two-paragraph short form in `docs/prompts/rewrite-tickets.md`, the URL does not contain one full lowercase 40-character commit SHA and the exact canonical path, or that committed blob differs by one byte from the local document.

## Failure modes

### Handled

- The CLI receives bad arity: print help and exit `2`; a recognized `--site` build failure prints one normalized error and exits `1`.
- No publishable `doc.json` is found: fail explicitly instead of deploying an empty index.
- A source directory is hidden, generated, infrastructural, a template, or a reserved static page: do not discover it as a document.
- A symlink appears at any non-excluded discovery path, as `doc.json`, or inside a selected static tree: do not follow or ignore it; fail with the boundary-specific exact error before deleting the prior site or rebuilding artifacts.
- JSON is malformed or P1-A metadata is missing/wrongly typed: fail before replacing the previous `_site/` or rebuilding artifacts.
- Two documents share an ID, slug, or alias, or a route uses a reserved name: fail before output so one document cannot overwrite or shadow another.
- One artifact fails composition or tag balance: stop, print the document-specific error, and return nonzero so Netlify does not publish the partial site.
- `_site/` contains output from an older build: delete only that exact tree before writing new output.
- The enhancer is absent: emit no tag and no empty asset directory; the hosted page stays byte-identical to the artifact.
- The enhancer changes: derive a new deterministic name from its bytes and remove the old asset through the clean build.
- A preview build follows a production build, or the reverse: regenerate/remove `_headers` from `CONTEXT`, never from stale state.
- A document was renamed: permanent-ID and alias redirects lead to the new slug without changing state identity.
- A writer forgets to commit refreshed artifacts: the site build changes them and `templates/check-dist` fails against git.
- The edge declaration is deleted, retargeted, duplicated, or widened: CI fails before accepting the change.
- A commit changes only Markdown and/or committed artifacts: Netlify's ignore command may skip the deploy; comparison-ref failures build rather than silently skip.

### Deliberately not handled

- A missing P2-A gate implementation or live deploy-preview verification. The config deliberately points to the future file; P2-A/the phase integrator owns that deferred provider check and no placeholder is created.
- Authentication, authorization, login behavior, Identity setup, project visibility, or API response codes. P2-A and later access tickets own those security behaviors.
- A network-dependent site or artifact, a live-comment snapshot, or runtime recovery when APIs are down. Static reading must remain complete without them.
- Automatic repair of malformed document metadata, slug selection, ID generation, or redirect collision resolution. Source data must be corrected by its owner.
- Preserving an uncommitted `_site/` file across builds. `_site/` is disposable deploy output by contract.
- Serving prior rendered versions, one Netlify site per document, Pretty URLs post-processing, or site-specific composition logic.
- Provider credit accounting for skipped builds. The ignore rule is a cost lever; its billing effect is not a correctness dependency.
- Mode A upload/connect behavior and propagation back to a standalone source file.

## Settled decisions

- The builder is TypeScript, requires Node 18 or later for local authoring, has zero runtime dependencies, and does not require a Rust or Python toolchain.
- Repo-backed Netlify/CI uses Node 22 so the later root Functions package's Node `>=22.12.0` contract is also satisfied.
- There is one site entry point and one composition function: `templates/build --site` discovers documents and calls shared `build()`; no second script or static-site generator is added.
- Committed `<instance>/dist/<instance>.html` files are deliverable artifacts; `_site/` is ignored, disposable deploy output and is never committed.
- Artifact and hosted document bytes are identical except for the one optional hosted enhancer tag; `<meta name="doc-id">` belongs to P1-B's shared layout and is present in both.
- A permanent six-lowercase-hex document `id` is the storage and permanent-link identity; the mutable `slug` is the clean URL and `aliases` are retired URLs.
- The clean URL is `/<slug>/`; `/d/<id>` redirects forever to the current slug.
- Preview and branch deploys are noindex; production HTML revalidates and hashed assets are immutable.
- Netlify post-processing stays off, and generated document redirects stay in `_site/_redirects` rather than `netlify.toml`.
- One Edge Function named `gate` matches `/*`; only `/login/*`, `/api/*`, and `/_assets/*` are excluded. API Functions authorize themselves; the gate controls who receives HTML.
- Netlify project visibility is not the document authorization layer. The gate declaration is fail-closed and is asserted in CI even before the implementation lands.
- No state layout, role model, or authorization ticket is revisited here: state remains one blob per record, authority remains one owner plus three grantable document roles, and hosted realtime remains optional through the settled broker.
- `norm()` and the block scanner remain one shared P1-D implementation consumed through P1-B's hook; the site builder neither copies nor reimplements either function.
- CI runs the scrub gate first because the repository is intended to become public; invented examples are used throughout this ticket.

## Assumptions and open questions

### Assumptions

- **Plan-table omission:** The ruling plan's P1-E row omitted `templates/docbuild/src/cli.ts`, but the current CLI rejects `--site` and no other ticket owns that dispatch path. P1-E therefore amends the pre-existing CLI. This is the minimum contract-preserving correction and keeps P1-E and P1-B on disjoint files.
- **Workflow-path omission:** The ruling plan and older hosting research name `.github/workflows/build.yml`, but the repository already has `.github/workflows/check.yml`. P1-E amends the existing workflow and does not create a duplicate workflow.
- **Static-page publication:** With `publish = "_site"`, P2-A's root `login/index.html` and P4-K's root `invite/index.html` would otherwise never deploy. The optional copy seams belong in P1-E's site module; absence stays a no-op so the tickets remain parallel and file-disjoint.
- **Route grammar:** P1-E enforces P1-A's lowercase kebab-case slug/alias contract and reserves `api`, `d`, `login`, `invite`, and `_assets` to prevent generated output and platform routes from colliding.
- **Asset hash:** The old Rust research selected FNV-1a only because Rust's standard library had no digest. The final TypeScript ruling removes that constraint. SHA-256 from `node:crypto`, truncated to the existing eight-hex filename shape, is deterministic and adds no dependency.
- **No enhancer today:** `templates/enhance/enhance.js` does not exist and no P1-E file creates it. Absence therefore produces exact artifact/site parity now while preserving the optional, deterministic seam required by the ruling build contract.
- **Node selection:** `NODE_VERSION = "22"` selects the current Node 22 line on Netlify and GitHub Actions. That remains above P1-C's `>=22.12.0` minimum while not raising the builder package's local Node 18 contract.
- **Provider sequencing:** A provider may reject `netlify.toml` until P2-A creates `gate.ts`. That is an expected cross-ticket integration state, not a reason to remove or stub the gate. Protected deploy-preview verification is a deferred P2-A/phase-integration check and explicitly not P1-E acceptance.

### Open questions

None block implementation.
Whether Netlify charges credits for a build skipped by `[build].ignore` remains unverified, so correctness and the test plan do not depend on that billing behavior.
If Netlify's actual account selects a different Node 22 minor or reports a missing future gate differently, preserve the declared contracts and record the provider observation during P2-A integration rather than widening P1-E.

## References

- `docs/prompts/rewrite-tickets.md`, **The goal**, **Method**, and **The acceptance test for your own work** — the document-only canonical source and immutable short-pointer publication contract.
- `HANDOFF.md`, “Non-negotiable: this repository becomes public,” “What done means for a ticket here,” and “Decisions that are already made” — scrub-first CI, deterministic `dist/`, zero runtime dependencies, TypeScript, and settled system boundaries.
- `README.md`, “Checks” and “The platform” — current builder commands, Node 18 minimum, committed artifact contract, and ruling-plan authority.
- `docs/research/00-integration-plan.md` §1.2–§1.4 — exact edge-gate target/exclusions, permanent ID/slug/alias roles, and repo-backed versus standalone deployment boundaries.
- `docs/research/00-integration-plan.md` §3.3 — shared normalizer/scanner boundary; P1-E must not create another implementation.
- `docs/research/00-integration-plan.md` §4.1–§4.3 — P1-B extension contract, artifact/site parity, deterministic builds, P1-E scope, and Phase 1 file isolation.
- `docs/research/00-integration-plan.md` §6 rulings 1–3, 12, 20–22, 27, 39, and 40 — `_site`, clean URLs, persistent redirects, shared doc-ID meta, committed history input, parity, TypeScript, and no Rust toolchain.
- `docs/research/01-hosting-and-build.md` §§3–7 and §§9–10 — site discovery, Netlify blocks, clean URLs, index/redirect generation, optional hashed enhancer, CI staleness checks, and deploy previews. Its Rust code and `.github/workflows/build.yml` name are superseded by the ruling plan and current repository.
- `docs/research/02-auth.md` §§2, 3.3, and 5–7 — login publication, Functions configuration, edge declaration, Functions v2/Node constraint, and P2-A's later gate ownership. Its `/docs/*` layout is superseded by the ruling plan's `/*` gate and root clean URLs.
- `docs/research/09-sharing-and-roles.md` §9.2 — the edge gate is the whole read-control wall, so CI must assert one `/*` block with exactly the three settled exclusions and previews must remain gated.
- `templates/build` — current compile-if-stale wrapper and argument pass-through; no amendment is needed.
- `templates/check-dist` — current cross-document byte-stability acceptance test and portable shell constraints.
- `templates/docbuild/src/cli.ts` — current one-argument dispatch that must gain the single `--site` branch.
- `templates/docbuild/src/index.ts` — current `BuildError`, `build()`, `check()`, base resolution, and literal substitution behavior reused without amendment.
- `templates/docbuild/package.json` and `templates/docbuild/tsconfig.json` — Node `>=18`, zero runtime dependencies, strict checking, and compiler output contract.
- `.github/workflows/check.yml` — the actual pre-existing workflow P1-E amends while preserving scrub-first ordering.
