# P1-B — The keystone: every placeholder and hook call site

## Outcome

The builder has a complete, type-safe extension surface for all planned client assets and build hooks, while missing feature inputs remain inert and existing documents keep deterministic self-contained output.

## Context

Several later tickets need the same builder and layout files, so letting each feature add its own integration point would serialize otherwise independent work and create merge conflicts. P1-B lands those integration points once, before feature behavior exists, so later tickets can stay inside their own modules. This ticket is the phase-1 keystone: it must be independently buildable, typecheckable, and safe to merge before its consumers.

## Scope

### In scope

- Add the exact `slot()` helper and substitutions for every optional client asset listed below, including the compiled browser-facing anchor core.
- Add conditional `{{DOC_ID}}` and `{{HISTORY_JSON}}` substitutions.
- Add the one shared `window.doc` namespace before any module that reads it.
- Emit optional feature JavaScript as ordered inline ES modules, with the anchor core installed before every feature module and the session probe last.
- Add statically imported call sites for history generation, stable anchors, and editable-block marking in the required order.
- Create no-op TypeScript stubs for the three hook modules so this ticket compiles and runs before P1-D, P2-D, and P2-E add behavior.
- Preserve literal `split()`/`join()` placeholder substitution and the existing unfilled-placeholder failure.
- Preserve deterministic committed HTML, with only the two structural additions allowed by the output-delta rule below.

### Out of scope

- Implementing the string-only `anchor-core.ts`, anchor scanning, `norm()`, alignment, move detection, anchor persistence, or anchor reports; P1-D creates the core and amends the Node-facing anchor stub.
- Implementing inline-Markdown conversion, editable-block policy, or edit-manifest persistence; P2-D amends the editable stub.
- Reading git, refreshing `history.json`, generating a changelog section, or enforcing the history budget; P2-E amends the history stub.
- Implementing session, comments, editing, history, realtime, presence, or sharing behavior or styles.
- Adding static share or presence markup to `.head-top`; those controls are created by their client modules after their runtime guards pass.
- Adding an id to any `doc.json`; P1-A owns document metadata.
- Adding `--site`, Netlify configuration, or CI; P1-E owns those surfaces.
- Editing `templates/base/app.js` or `templates/base/components.css`.
- Adding a runtime dependency, a browser bundle, a second normalizer, or a second block scanner.

## Interface contract

### Optional-file helper

`templates/docbuild/src/index.ts` must define this exact helper:

```ts
/** Inline templates/base/<name> if it exists, else nothing. */
const slot = (base: string, name: string): string =>
  existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8") : "";
```

An absent optional file resolves to the empty string. A file that exists but cannot be read is not treated as absent; the read error propagates as an unexpected build failure.

For optional feature JavaScript, an empty slot must emit no `<script>` element and no whitespace-only wrapper. A non-empty slot must be wrapped in one ordered inline `<script type="module">` element with no `async` attribute. Optional CSS remains inside the existing `<style>` element. Empty optional slots must therefore add zero bytes to the built file.

`{{ANCHOR_CORE_JS}}` does not read from `templates/base/`. Resolve the compiled sibling from the directory of the running builder module:

```ts
const compiledDir = dirname(fileURLToPath(import.meta.url));
const anchorCoreSource = slot(compiledDir, "anchor-core.js");
```

This is the same path rule in both supported layouts. In a vendored checkout, the running module and core are `templates/docbuild/dist/index.js` and `templates/docbuild/dist/anchor-core.js`. In an installed `@aiur-team/archon` package, both are siblings under that package's `dist/`. Do not derive the compiled path from the repository root or from `resolveBase()`, because an installed package has neither the vendored repository layout nor a root-level `templates/docbuild/` directory.

When `anchorCoreSource` is non-empty, its module element contains the compiled ESM followed by this adapter in the same module scope:

```js
window.doc.anchor = { BLOCK, norm, scanBlocks };
```

The adapter is layout code owned by P1-B. The compiled core owned by P1-D does not refer to `window`, the DOM, or Node. Ensure there is a newline between the compiled source and adapter so a trailing line comment cannot consume the assignment.

The adapter depends on this exact P1-D export contract:

```ts
export const BLOCK = [
  "p", "li", "h2", "h3", "h4", "td", "th", "pre", "blockquote", "figcaption", "dd", "dt",
] as const;

export type BlockTag = (typeof BLOCK)[number];

export interface ScannedBlock {
  readonly tag: BlockTag;
  readonly openStart: number;
  readonly openEnd: number;
  readonly innerStart: number;
  readonly innerEnd: number;
  readonly closeEnd: number;
  readonly text: string;
}

export const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
export function scanBlocks(fragment: string): ScannedBlock[];
```

All offsets are zero-based UTF-16 string offsets and every `*End` is exclusive. `openEnd === innerStart`; `innerEnd` points to the `<` of the matching close tag; `closeEnd` points immediately after that close tag's `>`. Only `BLOCK`, `norm`, and `scanBlocks` are runtime values exposed on `window.doc.anchor`; `BlockTag` and `ScannedBlock` are compile-time types.

### Placeholder and file mapping

| Placeholder | Source and exact empty behavior | Downstream owner |
|---|---|---|
| `{{SESSION_JS}}` | `slot(base, "session.js")`; no script element when absent | P2-C |
| `{{SESSION_CSS}}` | `slot(base, "session.css")`; zero bytes when absent | P2-C |
| `{{COMMENTS_JS}}` | `slot(base, "comments.js")`; no script element when absent | P3-C, then P4-A and P4-Q amend the file |
| `{{COMMENTS_CSS}}` | `slot(base, "comments.css")`; zero bytes when absent | P3-C, then P4-Q amends the file |
| `{{EDIT_JS}}` | `slot(base, "edit.js")`; no script element when absent | P4-B, then P4-I and P4-P amend the file |
| `{{EDIT_CSS}}` | `slot(base, "edit.css")`; zero bytes when absent | P4-B, then P4-P amends the file |
| `{{HISTORY_JS}}` | `slot(base, "history.js")`; no script element when absent | P3-D |
| `{{HISTORY_CSS}}` | `slot(base, "history.css")`; zero bytes when absent | P3-D |
| `{{HISTORY_JSON}}` | Empty while `refresh(inst)` returns `null`; otherwise one `<script type="application/json" id="doc-history">…</script>` containing the serialized `History` with every `</` escaped as `<\/` | P2-E supplies the data through the history hook |
| `{{DOC_ID}}` | `""` when `doc.get("id")` is absent or empty; otherwise exactly `<meta name="doc-id" content="<id>">\n`, including the trailing newline | P1-A supplies the six-lowercase-hex id in `doc.json` |
| `{{ANCHOR_CORE_JS}}` | `slot(dirname(fileURLToPath(import.meta.url)), "anchor-core.js")`; no module element when the compiled sibling is absent; otherwise install `{ BLOCK, norm, scanBlocks }` as `window.doc.anchor` | P1-D creates `templates/docbuild/src/anchor-core.ts`; P1-B owns only this integration slot |
| `{{REALTIME_JS}}` | `slot(base, "realtime.js")`; no script element when absent | P3-F |
| `{{PRESENCE_JS}}` | `slot(base, "presence.js")`; no script element when absent | P3-G |
| `{{PRESENCE_CSS}}` | `slot(base, "presence.css")`; zero bytes when absent | P3-G |
| `{{SHARE_JS}}` | `slot(base, "share.js")`; no script element when absent | P3-I, then P4-L amends the file |
| `{{SHARE_CSS}}` | `slot(base, "share.css")`; zero bytes when absent | P3-I |

`{{DOC_ID}}` and `{{HISTORY_JSON}}` are structural slots: their non-empty values include the complete HTML element, not only an attribute value or raw JSON. This lets an absent value emit zero bytes and keeps offline output free of empty feature markup.

The head-opening order and placement are exact:

1. `{{DOC_ID}}` is the first token in `layout.html`, immediately followed by the existing title with no intervening template byte: `{{DOC_ID}}<title>{{TITLE}}</title>`.
2. `<title>{{TITLE}}</title>` remains the first element when `{{DOC_ID}}` is empty.
3. The existing `fonts.googleapis.com` preconnect remains next.
4. The existing `fonts.gstatic.com` preconnect remains next.
5. The existing Google Fonts stylesheet remains next.
6. The existing `<style>` element follows, with the CSS inputs in the order below.

The non-empty `{{DOC_ID}}` substitution owns its trailing newline, so the meta and title are separate lines. The empty substitution owns no bytes, so it creates neither a blank line nor indentation before the title.

The CSS order inside the existing `<style>` element is fixed:

1. `{{THEME_CSS}}`
2. `{{COMPONENTS_CSS}}`
3. `{{SESSION_CSS}}`
4. `{{COMMENTS_CSS}}`
5. `{{EDIT_CSS}}`
6. `{{HISTORY_CSS}}`
7. `{{PRESENCE_CSS}}`
8. `{{SHARE_CSS}}`
9. `{{EXTRA_CSS}}`

`{{EXTRA_CSS}}` remains last so per-document CSS keeps its existing precedence.

The emitted script/data order is fixed:

1. `{{HISTORY_JSON}}`
2. `<script>window.doc = { rail: null, panel: null };</script>`
3. `{{APP_JS}}` in its existing classic inline script
4. `{{EXTRA_JS}}` in its existing classic inline script
5. `{{ANCHOR_CORE_JS}}` as an inline module when its compiled sibling exists
6. `{{EDIT_JS}}` as an inline module when present
7. `{{COMMENTS_JS}}` as an inline module when present
8. `{{HISTORY_JS}}` as an inline module when present
9. `{{REALTIME_JS}}` as an inline module when present
10. `{{PRESENCE_JS}}` as an inline module when present
11. `{{SHARE_JS}}` as an inline module when present
12. `{{SESSION_JS}}` as the final inline feature module when present

The namespace must exist before optional modules execute. The anchor core is the first feature module, so comments and editing read the same `BLOCK`, `norm()`, and `scanBlocks()` implementation used by the Node hook. `EDIT_JS` precedes `COMMENTS_JS` so an initial overlay is applied before comment anchors resolve. `REALTIME_JS` precedes `PRESENCE_JS`. `SESSION_JS` comes after every feature listener so the one `session` event cannot be missed.

`{{APP_JS}}` remains a classic inline script with its current bytes and immediate theme/deep-link behavior. `{{EXTRA_JS}}` also remains a classic inline script, immediately after `APP_JS`, so existing per-instance scripts keep classic-script semantics, top-level global behavior, and their existing execution order relative to the theme script. They are not converted to modules. Feature modules execute afterward in document order.

The only cross-module surfaces introduced here are the existing `session` event and this exact namespace object:

```html
<script>window.doc = { rail: null, panel: null };</script>
```

P1-D later fills `window.doc.anchor` with the core's three runtime exports. P4-Q later fills `window.doc.rail` and `window.doc.panel`; P1-B must not define their methods or add another global.

### Hook signatures and no-op stubs

P1-B creates the three modules with the exact source-level contracts below. These implementations are deliberately copyable: they compile under the repository's strict TypeScript settings and define all stub behavior without an inferred data shape.

```ts
// templates/docbuild/src/anchors.ts — created by P1-B, amended by P1-D
import type { Section } from "./index.js";

export function anchorSections(
  inst: string,
  sections: Section[],
): { report: string[]; orphans: Array<[string, string]> } {
  void inst;
  void sections;
  return { report: [], orphans: [] };
}
```

```ts
// templates/docbuild/src/editable.ts — created by P1-B, amended by P2-D
import type { Doc, Section } from "./index.js";

export type ManifestRow = Readonly<Record<string, never>>;

export function markEditable(
  sections: Section[],
  doc: Doc,
  inst: string,
): ManifestRow[] {
  void sections;
  void doc;
  void inst;
  return [];
}
```

```ts
// templates/docbuild/src/history.ts — created by P1-B, amended by P2-E
import { BuildError } from "./index.js";
import type { Section } from "./index.js";

export type History = Readonly<Record<string, never>>;

export function refresh(inst: string): History | null {
  void inst;
  return null;
}

/** Return a Section that renderSection() can consume. */
export function changelogSection(
  h: History,
  labels: Array<[string, string]>,
): Section {
  void h;
  void labels;
  throw new BuildError("history hook is unavailable until P2-E");
}
```

`ManifestRow` and `History` are intentionally opaque, compile-only stub aliases. P1-B constructs no value of either type: `markEditable()` returns an empty array and `refresh()` returns `null`. P2-D replaces the `ManifestRow` alias with its concrete manifest-row shape while preserving the exported name and `markEditable(sections, doc, inst): ManifestRow[]`; P2-E replaces the `History` alias with its concrete history shape while preserving the exported name and both history function signatures. Neither later ticket changes the call sites in `index.ts`.

The `BuildError` value import in `history.ts` creates an ESM cycle with `index.ts`, but the stub does not read that live binding during module initialization. It is read only if the guarded `changelogSection()` path is called. In the P1-B stub state, that direct call must throw a `BuildError` whose exact message is `history hook is unavailable until P2-E`.

The remaining exact observable behaviors are:

- `anchorSections(inst, sections)` does not read or write files, does not mutate `sections`, and returns `{ report: [], orphans: [] }`.
- `markEditable(sections, doc, inst)` does not read or write files, does not mutate `sections`, and returns `[]`.
- `refresh(inst)` does not read or write files and returns `null`.

### Hook order, guards, and errors

After parsing sections and rejecting duplicate section ids, but before building navigation or rendering section bodies, `build()` must execute this sequence:

1. Capture `[section.id, section.label]` pairs from the source sections.
2. Call `refresh(inst)`. If it returns `null`, leave `sections` unchanged and substitute `{{HISTORY_JSON}}` with `""`. If it returns a `History`, append exactly one `changelogSection(history, labels)` and serialize the same value for `{{HISTORY_JSON}}`.
3. Call `anchorSections(inst, sections)` on the complete section list, including a changelog when present. Keep its `report` and `orphans` for the build report.
4. Call `markEditable(sections, doc, inst)` only after `anchorSections` returns, because editability requires `data-aid`. Its eventual implementation owns edit-manifest persistence; `index.ts` does not duplicate that logic.
5. Build navigation and rendered bodies from the final mutated `sections` array.

The hook modules are statically imported and always compiled. There is no optional-import guard and no `try/catch` that interprets a missing module as a disabled feature. Before feature tickets land, the no-op stubs are the guard. Afterward, each hook handles its own absent input: first-run anchoring may create `anchors.json`; history returns `null` only when neither git nor committed history is available; editable marking runs only after anchors are present.

Every expected hook failure must be a `BuildError`, so `templates/docbuild/src/cli.ts` prints one `error: …` line and exits 1 without a stack trace. Unexpected programming errors continue to propagate. A surviving `{{NAME}}` token remains an expected `BuildError` with the existing sorted `unfilled placeholders: …` message.

The anchor report is silent for the P1-B stub. When P1-D supplies entries, `build()` prints an `anchors` heading, its report lines, and an orphan warning containing at most the first eight `sectionId/aid` pairs plus the total count. Reporting must not change the returned output path or the CLI exit status.

### Byte-output behavior

All missing feature assets, a missing compiled anchor core, and all no-op hook results contribute zero bytes. Do not emit empty `<style>`, `<script>`, history-data, anchor-core, share, or presence wrappers, and do not add blank lines solely for empty slots.

Relative to the pre-P1-B committed artifacts, the only permitted generated-HTML additions are:

```html
<script>window.doc = { rail: null, panel: null };</script>
<meta name="doc-id" content="a1b2c3">
```

The id above is invented; the actual value comes from each document's `doc.json`. The namespace line is always present after P1-B. The meta line is present only after P1-A supplies a non-empty id. After deleting those complete lines from a post-change artifact, its bytes must equal the pre-P1-B artifact exactly. Any other byte change is a bug.

P1-A integrates first. Because the pre-P1-B builder ignores P1-A's new ids, P1-A keeps committed generated HTML byte-identical and passes its out-of-surface and `check-dist` criteria without a generated-HTML change. P1-B then consumes those ids and owns the serialized generated-HTML refresh that introduces both the doc-id meta lines and namespace lines. The P1-B integrator runs the build; neither ticket hand-edits the shared artifacts.

When present, the doc-id meta is the artifact's first line and the existing title immediately follows it. When absent, the title remains the artifact's first line. This placement is part of the byte-output contract, not a browser-only semantic equivalence.

`templates/docbuild/dist/anchor-core.js` is absent in the P1-B stub state, so `{{ANCHOR_CORE_JS}}` produces no output and does not widen this delta. P1-D owns the later generated-HTML change that embeds the core and installs `window.doc.anchor`.

After P1-A is integrated, P1-B's build must refresh committed generated `dist/*.html` files with the expected structural additions before the candidate commit is tested. Once they match the source, `templates/check-dist` must report byte identity on a rebuild.

## Files owned

- `templates/docbuild/src/index.ts` — **amended**; pre-existing before the Build Order, so there is no creator ticket.
- `templates/base/layout.html` — **amended**; pre-existing before the Build Order, so there is no creator ticket.
- `templates/docbuild/src/anchors.ts` — **new no-op stub**; P1-D later amends it.
- `templates/docbuild/src/editable.ts` — **new no-op stub**; P2-D later amends it.
- `templates/docbuild/src/history.ts` — **new no-op stub**; P2-E later amends it.

These five paths are P1-B's complete and exclusive **source** ownership. `templates/docbuild/dist/*`, `example/dist/example.html`, and `templates/components/dist/components.html` are shared generated products, not additional source ownership. After P1-A lands its source-only metadata change, the P1-B integrator regenerates and includes the JavaScript, declarations, source maps, and HTML produced from the integrated source state. Those files must be changed only by the repository's compiler/build commands and never hand-edited. A generated diff does not grant permission to amend another ticket's source.

Because generated products are shared across otherwise disjoint tickets, each branch that affects them must rebase onto the latest merged source and regenerate compiler, document, and site outputs immediately before its merge check. Source and configuration authoring can proceed concurrently where the table below says it can; final output generation and repository gates are serialized by integration order.

## Dependencies

P1-B has no upstream dependency for isolated source authoring and must compile with an absent document id, but its integration dependency is P1-A. P1-A merges first without changing generated HTML; P1-B then merges as the keystone ticket and owns the generated refresh that begins consuming P1-A's ids.

The downstream contracts are:

| Ticket | Exact contract received from P1-B | Scheduling boundary |
|---|---|---|
| P1-A | `{{DOC_ID}}` reads only the permanent `doc.json` id and remains empty before the id exists | Author in parallel on disjoint `doc.json` files; merge before P1-B, leaving generated HTML byte-identical for P1-B to refresh |
| P1-C | No direct P1-B interface; its identity/session API is a separate prerequisite for P2-C, which consumes P1-B's session slots | May author and merge independently on `package.json` and `netlify/` source files |
| P1-D | The `anchors.ts` stub, exact `anchorSections()` signature, call site, report channel, `Section` type, compiled-sibling slot, and `window.doc.anchor` adapter for `{ BLOCK, norm, scanBlocks }` | Must start from or rebase onto P1-B; it amends a P1-B-created file and creates `anchor-core.ts` |
| P1-E | Builder integration points are stable; P1-E may add site mode without adding feature placeholders | Author in parallel on disjoint configuration and `site.ts`; merge and run full site acceptance only after P1-A and P1-B are integrated |
| P2-C | Session asset slots and late script order | Phase 2; no builder/layout edit |
| P2-D | The `editable.ts` stub and exact `markEditable()` call after anchoring | Phase 2; amends only the P1-B stub plus its own fixture/converter files |
| P2-E | The `history.ts` stub, exact two-function history interface, history-before-anchor ordering, and `{{HISTORY_JSON}}` serialization slot | Phase 2; amends only the P1-B stub and creates its owned history input |
| P3-C, P4-A, P4-Q | Comment asset slots, ordered module execution, `window.doc.anchor`, and `EDIT_JS`-before-`COMMENTS_JS` order | Later phases; amend `comments.js`/`comments.css`, not P1-B files |
| P3-D | History asset slots and history data emitted before `HISTORY_JS` | Phase 3; no builder/layout edit |
| P3-F, P3-G | Realtime and presence asset slots with realtime-before-presence order | Phase 3; no builder/layout edit |
| P3-I, P4-L | Share asset slots and the pre-created namespace/session-listener order | Later phases; amend `share.js`, not P1-B files |
| P4-B, P4-I, P4-P | Edit asset slots, ordered module execution, `window.doc.anchor`, namespace, and edit-before-comments order | Phase 4; amend edit assets, not P1-B files |

Safe implementation waves are:

1. **Four-way isolated authoring:** P1-A, P1-B, P1-C, and P1-E may author source and configuration concurrently in isolated worktrees because their owned source paths are disjoint. This parallel authoring does not imply arbitrary integration order.
2. **Phase-1 integration floor:** merge P1-A first, with its generated HTML still byte-identical because the old builder ignores the new ids. Merge P1-B second; its integrator rebuilds from the P1-A source state and owns the shared generated-HTML diff containing the doc-id meta and namespace lines. Only after both are integrated may P1-E merge or claim full site acceptance, because P1-E's CI invokes the site build and needs P1-A's permanent document metadata plus P1-B's complete composition surface. P1-C has no direct dependency on P1-A, P1-B, or P1-E and may merge independently.
3. **P1-B-gated anchor work:** P1-D begins from or rebases onto merged P1-B because it amends the P1-B-created `anchors.ts` and relies on the compiled-sibling slot. It may then proceed in parallel with unfinished work in the other disjoint phase-1 sources. If P1-E was validated before P1-D landed, rerun P1-E's full site acceptance after P1-D integrates so the site includes and verifies the compiled anchor core.
4. **Later parallel waves:** P2-C starts after P1-B and P1-C; P2-D starts after P1-B and P1-D; P2-E starts after P1-B. Once ready, P2-D and P2-E may amend their separate stubs concurrently, while P2-C and other asset-only consumers work in their own source files. No consumer reopens `index.ts` or `layout.html` to add integration.
5. **Serialized integration products:** final compiler output, per-document generated HTML, P1-E site output, and all repository gates are produced and run against the integrated source state in merge order. Parallel branches do not hand-resolve generated artifacts; the later branch rebases, regenerates, and reruns the complete applicable gate set.

This sequencing couples downstream tickets only to stable signatures and slots. It does not impose a shared implementation branch or make generated artifacts exclusive to P1-B.

## Acceptance criteria

- [ ] All 16 placeholders in the mapping exist in `layout.html` and have exactly one substitution path in `index.ts`.
- [ ] Missing optional CSS/JS files, a missing document id, and a `null` history result add zero bytes and no empty wrappers.
- [ ] `{{DOC_ID}}` is the first layout token, directly adjacent to `<title>`; its non-empty substitution ends in exactly one newline, while its empty substitution leaves the title as the first artifact byte with no blank line.
- [ ] `window.doc` is initialized exactly once, before all optional feature modules, with only `rail` and `panel` set to `null`.
- [ ] A missing compiled `anchor-core.js` emits zero bytes; a present compiled sibling is read relative to the running `index.js`, emitted as the first ordered inline feature module, and installs exactly `{ BLOCK, norm, scanBlocks }` on `window.doc.anchor`.
- [ ] Every optional feature JavaScript slot emits an inline `type="module"` script without `async`; document order is execution order and `SESSION_JS` is last.
- [ ] `APP_JS` and `EXTRA_JS` remain classic scripts with their existing behavior and relative order; `EXTRA_CSS` remains the final CSS input.
- [ ] The remaining CSS and script/data ordering matches the interface contract.
- [ ] The three hook modules compile as the exact no-op stubs above under the repository's strict TypeScript settings; `ManifestRow` and `History` are exported as `Readonly<Record<string, never>>` until their owner tickets replace them.
- [ ] A direct call to the stub `changelogSection({}, [])` throws `BuildError("history hook is unavailable until P2-E")`.
- [ ] Hook calls run history, anchors, and editability in that order after duplicate-id validation and before nav/body rendering.
- [ ] `changelogSection()` is guarded by a non-null `History`; `markEditable()` never runs before `anchorSections()`.
- [ ] Expected hook errors use `BuildError`; unfilled placeholders still fail with a sorted token list and no output write.
- [ ] Placeholder substitution still uses literal `split()`/`join()` and preserves `$&`, `$'`, and `` $` `` in document content.
- [ ] The only pre-P1-B output deltas are the namespace script and, for documents with an id, the doc-id meta element.
- [ ] P1-A is integrated first with byte-identical generated HTML; the P1-B integrator then runs the compiler/document builds and owns the resulting shared generated-product refresh without hand edits.
- [ ] Both committed documents rebuild deterministically, contain no unresolved uppercase placeholder, and pass tag-balance checks.
- [ ] No runtime dependency is added; Node 18 remains supported.
- [ ] No source file outside the five owned paths is edited; compiler/build output is regenerated rather than hand-edited and does not expand source ownership.
- [ ] GitHub issue #2 retains the exact ticket title and exact two-paragraph canonical-document pointer; its parsed full commit SHA and path resolve through `git show` to bytes identical to `docs/tickets/P1-B.md`.

## Test plan

Run every command from the repository root. The final P1-B integration check runs on a base containing merged P1-A, so both committed real documents already have permanent ids while their pre-P1-B generated HTML is still byte-identical.

1. Typecheck the builder and all stubs:

   ```bash
   npm --prefix templates/docbuild run check
   ```

   Expected: exit 0 and no TypeScript diagnostics. In particular, there must be no unresolved import, unused-parameter, exact-optional-property, or unchecked-index error.

2. Compile and prove the initial stub contract:

   ```bash
   npm --prefix templates/docbuild run build
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { BuildError } from "./templates/docbuild/dist/index.js";
   import { anchorSections } from "./templates/docbuild/dist/anchors.js";
   import { markEditable } from "./templates/docbuild/dist/editable.js";
   import { changelogSection, refresh } from "./templates/docbuild/dist/history.js";

   const sections = [{ id: "overview", label: "Overview", summary: "Invented.", nav: "Overview", peek: "", body: "<p>Invented text.</p>", file: "01-overview.html" }];
   const doc = { get: () => undefined, getOr: (_key, fallback) => fallback, meta: () => [] };
   assert.deepEqual(anchorSections("invented-instance", sections), { report: [], orphans: [] });
   assert.deepEqual(markEditable(sections, doc, "invented-instance"), []);
   assert.equal(refresh("invented-instance"), null);
   assert.throws(
     () => changelogSection({}, []),
     (error) =>
       error instanceof BuildError &&
       error.message === "history hook is unavailable until P2-E",
   );
   assert.equal(sections[0].body, "<p>Invented text.</p>");
   console.log("PASS  P1-B hooks are inert");
   NODE
   test ! -e templates/docbuild/dist/anchor-core.js
   ```

   Expected: `PASS  P1-B hooks are inert` and exit 0. The direct `changelogSection()` probe confirms both the `BuildError` class and exact stub message. The final shell assertion confirms that P1-B did not create P1-D's compiled core. No file named `anchors.json`, `history.json`, or `*.edit.json` is created by this probe.

3. Build both committed documents and inspect their normal builder reports:

   ```bash
   templates/build example
   templates/build templates/components
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";
   const layout = readFileSync("templates/base/layout.html", "utf8");
   assert.ok(layout.startsWith(
     '{{DOC_ID}}<title>{{TITLE}}</title>\n' +
     '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
     '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
     '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">\n' +
     '<style>\n',
   ));
   for (const path of ["example/dist/example.html", "templates/components/dist/components.html"]) {
     const html = readFileSync(path, "utf8");
     assert.match(html, /^<meta name="doc-id" content="[0-9a-f]{6}">\n<title>/);
     assert.equal((html.match(/window\.doc = \{ rail: null, panel: null \}/g) ?? []).length, 1);
     assert.equal(html.includes("window.doc.anchor ="), false);
     assert.equal(/<script type="module">\s*<\/script>/.test(html), false);
   }
   console.log("PASS  head placement and optional anchor-core absence are exact");
   NODE
   ```

   Expected: each build exits 0, names its `dist/*.html` output, reports `tag balance      OK`, and prints no anchor report while the P1-B stub is active. The probe prints `PASS  head placement and optional anchor-core absence are exact` and exits 0.

4. Exercise the compiled-sibling adapter with an invented temporary ESM file, then restore the normal P1-B output:

   ```bash
   anchor_probe="templates/docbuild/dist/anchor-core.js"
   trap 'rm -f "$anchor_probe"; templates/build example >/dev/null' EXIT
   printf '%s\n' \
     'export const BLOCK = ["p"];' \
     'export const norm = (s) => s;' \
     'export const scanBlocks = () => [];' > "$anchor_probe"
   templates/build example >/dev/null
   node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";
   const html = readFileSync("example/dist/example.html", "utf8");
   const core = html.indexOf('export const BLOCK = ["p"];');
   const adapter = html.indexOf("window.doc.anchor = { BLOCK, norm, scanBlocks };");
   assert.ok(core >= 0 && adapter > core);
   const containingScript = html.slice(html.lastIndexOf("<script", core), html.indexOf("</script>", adapter));
   assert.match(containingScript, /^<script type="module">/);
   assert.doesNotMatch(containingScript, /\basync\b/);
   console.log("PASS  compiled sibling precedes its window.doc.anchor adapter");
   NODE
   rm -f "$anchor_probe"
   trap - EXIT
   templates/build example >/dev/null
   ```

   Expected: `PASS  compiled sibling precedes its window.doc.anchor adapter` and exit 0. The temporary compiled sibling is removed, and the final build restores the P1-B stub-state artifact with no `window.doc.anchor` assignment.

5. Verify the output-delta rule against the merged-P1-A, pre-P1-B base. Set `P1B_BASE` to that exact commit when it is not `origin/main`:

   ```bash
   p1b_base="${P1B_BASE:-origin/main}"
   for artifact in example/dist/example.html templates/components/dist/components.html; do
     diff -u \
       <(git show "$p1b_base:$artifact") \
       <(sed -E '/^<meta name="doc-id" content="[0-9a-f]{6}">$/d; /^<script>window\.doc = \{ rail: null, panel: null \};<\/script>$/d' "$artifact")
   done
   ```

   Expected: no diff output and exit 0. Each of the two committed real documents has exactly one doc-id meta line supplied from merged P1-A. The builder's general missing-id path still emits zero bytes, but absence is not the final P1-B integration state. Empty feature slots must not leave blank wrappers or whitespace that causes this comparison to differ.

6. Verify that no placeholder survived either build:

   ```bash
   if rg -n '\{\{[A-Z_]+\}\}' example/dist/example.html templates/components/dist/components.html; then
     echo "FAIL  unresolved placeholder" >&2
     exit 1
   else
     echo "PASS  no unresolved placeholder"
   fi
   ```

   Expected: `PASS  no unresolved placeholder` and exit 0.

7. After the expected generated artifacts are included in the candidate commit, verify deterministic rebuilds:

   ```bash
   templates/check-dist
   ```

   Expected output ends with `PASS  every committed document is byte-identical after a rebuild`; exit 0. Any `FAIL  a rebuild changed committed output` result blocks completion.

8. Run the publication scrub and patch hygiene checks:

   ```bash
   scripts/scrub-check.sh
   git diff --check
   ```

   Expected: the scrub exits 0 with no denied term, and `git diff --check` exits 0 with no output.

9. After the canonical document is committed, pushed, and linked from the tracker, verify the immutable issue pointer:

   ```bash
   set -euo pipefail
   p1b_issue_json="$(mktemp "${TMPDIR:-/tmp}/p1-b-issue.XXXXXX")"
   p1b_linked_blob="$(mktemp "${TMPDIR:-/tmp}/p1-b-linked.XXXXXX")"
   trap 'rm -f "$p1b_issue_json" "$p1b_linked_blob"' EXIT
   gh issue view 2 --repo aiur-team/architecture-docs --json title,body >"$p1b_issue_json"
   read -r p1b_commit_sha p1b_linked_path < <(
     P1B_ISSUE_JSON="$p1b_issue_json" \
     P1B_TICKET_PATH="docs/tickets/P1-B.md" \
     P1B_EXPECTED_TITLE="P1-B — The keystone: every placeholder and hook call site" \
       node --input-type=module <<'NODE'
   import assert from "node:assert/strict";
   import { readFileSync } from "node:fs";

   const issue = JSON.parse(readFileSync(process.env.P1B_ISSUE_JSON, "utf8"));
   assert.equal(issue.title, process.env.P1B_EXPECTED_TITLE, "issue title changed");
   const match = issue.body.match(/^Implementation specification: \[`([^`\n]+)`\]\(https:\/\/github\.com\/aiur-team\/architecture-docs\/blob\/([0-9a-f]{40})\/([^)\n]+)\)\n\nThis issue tracks implementation of the linked canonical specification\.$/);
   assert.ok(match, "issue body is not the exact two-paragraph pointer form");
   assert.equal(match[1], process.env.P1B_TICKET_PATH, "link label path changed");
   assert.equal(match[3], process.env.P1B_TICKET_PATH, "link target path changed");
   process.stdout.write(`${match[2]} ${match[3]}\n`);
   NODE
   )
   git show "$p1b_commit_sha:$p1b_linked_path" >"$p1b_linked_blob"
   cmp -s docs/tickets/P1-B.md "$p1b_linked_blob"
   rm -f "$p1b_issue_json" "$p1b_linked_blob"
   trap - EXIT
   echo "PASS  P1-B issue #2 points to the byte-identical canonical document"
   ```

   Expected: exit `0` and exactly `PASS  P1-B issue #2 points to the byte-identical canonical document`. The gate fails if the title changes, the body differs from the exact two-paragraph short form in `docs/prompts/rewrite-tickets.md`, the URL does not contain one full lowercase 40-character commit SHA and the exact canonical path, or that committed blob differs by one byte from the local document.

## Failure modes

### Handled

- An optional base asset does not exist: `slot()` returns `""`, and no wrapper or whitespace is emitted.
- P1-D's compiled `anchor-core.js` does not exist: `{{ANCHOR_CORE_JS}}` is empty, `window.doc.anchor` is not assigned, and all unrelated scripts continue normally.
- During isolated P1-B authoring before P1-A lands, `doc.json` has no id: no meta element is emitted and the directory name is not used as a fallback identity. This fallback-safe state is testable but is not the final integration order.
- The history stub or later history implementation returns `null`: no changelog and no `#doc-history` element are emitted.
- The P1-B history stub's `changelogSection()` is called directly despite its non-null guard: it throws `BuildError("history hook is unavailable until P2-E")`.
- A hook reports an expected read, parse, alignment, or write failure: it throws `BuildError`; the CLI prints one concise error and exits 1.
- A hook leaves a `{{NAME}}` token in composed HTML: the existing final placeholder scan fails before the output is written.
- A future anchor run reports more than eight orphans: the total is retained, while the printed sample is capped at eight pairs.
- A feature file contains dollar replacement sequences such as `$&`: literal split/join substitution preserves them byte-for-byte.

### Deliberately not handled

- A file exists but becomes unreadable between `existsSync()` and `readFileSync()`: this is an unexpected filesystem failure, not an absent optional feature.
- A present compiled anchor core has invalid ESM or does not export `BLOCK`, `norm`, and `scanBlocks`: P1-D owns that module contract and its tests; P1-B does not parse or rewrite compiled JavaScript.
- A trusted optional module contains a literal `</script>` sequence: source escaping is not added here; feature owners must not place a closing script tag in an inlined module.
- Syntax or runtime errors inside future browser modules: their feature tickets own fail-closed browser behavior.
- Malformed `history.json`, `anchors.json`, or edit-manifest data: the ticket that implements the corresponding hook owns validation and `BuildError` messages.
- Duplicate or malformed document ids: P1-A owns id generation and repository-wide uniqueness checks.
- Network availability, authentication, authorization, broker setup, comments, edits, presence, or sharing behavior.
- Updating another module's implementation through a P1-B call-site change; the call sites and signatures are frozen after this ticket.

## Settled decisions

- The builder is TypeScript, targets Node 18 or later, uses strict typechecking, and has zero runtime dependencies.
- P1-B creates always-compiled no-op modules. Optional dynamic imports, import-error suppression, and temporarily broken imports are rejected.
- The P1-B-only `ManifestRow` and `History` declarations are the exact opaque aliases `Readonly<Record<string, never>>`; their owner tickets replace the shapes but preserve the exported type names and function signatures.
- Later tickets amend their stubs behind stable signatures and do not edit `index.ts` or `layout.html` for feature integration.
- Hook order is history, anchors, then editable marking. The history section therefore participates in the same anchoring pass as all other rendered sections.
- P1-D separates the string-only shared implementation into `anchor-core.ts` and keeps filesystem/alignment work in Node-facing `anchors.ts`. The core exports `BLOCK`, `norm()`, and `scanBlocks()`; a client-side reimplementation and a second scanner are rejected.
- The builder reads compiled `anchor-core.js` beside the running `index.js`, which works for both vendored and installed-package layouts without a repository-root assumption.
- Optional feature JavaScript runs as ordered inline ES modules. The anchor adapter is first and the session probe is last; no optional feature module uses `async`.
- The `window.doc` object is the only global namespace introduced for feature coordination; the `session` custom event remains the other shared client mechanism.
- `EDIT_JS` loads before `COMMENTS_JS`; later overlays dispatch `doc:overlay` so comments can re-resolve affected blocks.
- Missing optional assets and a missing compiled anchor core are absence, not empty feature chrome. Share and presence controls are created by their scripts after guards pass.
- Existing `APP_JS` and per-instance `EXTRA_JS` remain classic inline scripts in their existing relative order. Only the planned optional feature slots use module scripts.
- `templates/base/app.js` and `templates/base/components.css` do not receive feature changes.
- Placeholder replacement remains literal `split()`/`join()`, not `replaceAll()`.
- Existing committed HTML stays a deterministic pure function of committed inputs and remains readable from `file://` and in an artifact with no network.
- Phase-1 source/configuration authoring is four-way parallel, but integration is P1-A then P1-B: P1-A leaves generated HTML untouched, and P1-B's integrator regenerates and owns the first HTML diff that consumes the ids.

## Assumptions and open questions

### Assumptions

- The detailed statement in integration plan §4.1 that P1-B lands three always-compiled no-op modules controls over the §4.3 summary table that lists only `index.ts` and `layout.html`. P1-B therefore creates `anchors.ts`, `editable.ts`, and `history.ts`; P1-D, P2-D, and P2-E amend those files later. This is the minimum resolution that lets the keystone land alone with a passing typecheck.
- Integration plan §3.3's original statement that one `anchors.ts` module is both Node-facing and browser-safe is resolved at the P1-D boundary: P1-D creates import-free `anchor-core.ts` for `BLOCK`, `norm()`, and `scanBlocks()`, while the P1-B-created `anchors.ts` stub becomes the Node-facing orchestration module. P1-B owns only the compiled-core slot and adapter.
- The namespace requirement was added after the older byte-parity sentence was written. The exact namespace script is therefore an allowed structural delta alongside the conditional doc-id meta line; no feature asset or hook stub may produce another delta.
- `{{DOC_ID}}` emits no fallback value during isolated authoring before P1-A. Using the instance directory as an id would violate the permanent-key decision; the final P1-B integration nevertheless waits for P1-A.
- `{{HISTORY_JSON}}` denotes the complete guarded data-script element, even though its name refers to the serialized content. Treating it as raw JSON would leave an empty script element on a build with no history and would break the zero-byte rule.
- Inline module scripts without `async` execute in document order. That platform guarantee is the basis for installing `window.doc.anchor` before edit/comments and attaching every listener before the final session probe runs.

### Open questions

None. If implementation shows that any stable signature, hook order, or output-delta rule cannot be met inside the five owned source files, stop rather than widening the ticket again.

## References

- `docs/prompts/rewrite-tickets.md`, **The goal**, **Method**, and **The acceptance test for your own work** — the document-only canonical source and immutable short-pointer publication contract.
- `HANDOFF.md`, “What done means for a ticket here” and “Decisions that are already made.”
- `README.md`, “Checks” and “The platform.”
- `docs/research/00-integration-plan.md` §§1.3, 3.2–3.4, 4.1–4.3, and 4.7. This is the ruling source when a numbered research document differs; the `anchor-core.ts` split resolves §3.3's incompatible Node-I/O/browser-safe responsibilities without changing its one-implementation decision.
- `docs/research/02-auth.md` §3.2 for the single `session` event mechanism.
- `docs/research/04-comments-and-discussion.md` §§4.1–4.2 and 8 for the anchor hook and comments slots.
- `docs/research/05-inline-editing.md` §§5 and 11–12 for editable marking and the manifest boundary; language and block-id details there are superseded by the integration plan.
- `docs/research/06-history.md` §§4 and 10 for history refresh, changelog generation, and the data-script guard; Rust syntax there is superseded by the TypeScript ruling.
- `docs/research/07-realtime-and-presence.md` §§8.3–8.4 and 12–13 for realtime/presence slots, degradation, and ordering.
- `docs/research/08-suggestions-and-editing-model.md` §§7.2, 7.5, and 16 for `window.doc`, edit-before-comments ordering, and `doc:overlay`.
- `docs/research/09-sharing-and-roles.md` §§7, 10, and 12 for share-slot behavior and the absent-until-session contract.
