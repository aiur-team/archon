/**
 * Compose an architecture doc into one self-contained HTML file.
 *
 * A published artifact runs under a strict CSP that blocks every external host
 * except the font CDN, so relative CSS and JS fail silently. This inlines
 * everything into one file.
 *
 * Zero runtime dependencies, on purpose. `tsc` is the only devDependency, so a
 * writer never installs a package to build a document.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { anchorSections } from "./anchors.js";
import { markEditable } from "./editable.js";
import { changelogSection, refresh } from "./history.js";

const CHEVRON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

export const USAGE = `docbuild — compose an architecture doc into one self-contained HTML file

    docbuild <instance>
    docbuild <instance> --hosted

--hosted builds the same document for private hosted reading instead: the same
inline theme, navigation and section content, but no Google-font request and
none of the session, comment, edit, realtime, presence or share client code.
It writes <instance>/dist/<instance-basename>.hosted.html and leaves the normal
<instance-basename>.html untouched.

An instance directory holds:
    doc.json          document metadata
    sections/*.html   one file per section, ordered by filename
    extra.css         optional, per-document CSS appended last
    dist/             build output

A section file starts with a metadata comment, then an optional peek block,
then the body:

    <!--
    id: architecture
    label: Architecture
    summary: One or two sentences, shown while the section is closed.
    -->
    <!-- peek -->
      ...closed-state markup...
    <!-- body -->
      ...open markup...
`;

/** Raised for every expected failure, so the CLI never prints a stack trace. */
export class BuildError extends Error {}

const fail = (message: string): never => {
  throw new BuildError(message);
};

// ------------------------------------------------------------------- doc.json

/**
 * `doc.json` is a flat map of strings plus one nested `meta` object.
 *
 * The Rust builder this replaces hand-rolled a scanner because Rust has no
 * std JSON. `JSON.parse` is exact here, and it removes the three gaps that
 * scanner had: no array support, non-string values reading as absent, and
 * manual UTF-8 length handling.
 */
export interface Doc {
  get(key: string): string | undefined;
  getOr(key: string, fallback: string): string;
  meta(): Array<[string, string]>;
}

export function parseDoc(src: string, label: string): Doc {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    return fail(`${label}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return fail(`${label}: expected a JSON object`);
  }
  const fields = raw as Record<string, unknown>;

  // Only string values are addressable, matching the previous builder: a
  // non-string is treated as present-but-empty rather than crashing a build.
  const get = (key: string): string | undefined => {
    const v = fields[key];
    if (typeof v === "string") return v;
    if (v !== undefined && !(typeof v === "object" && v !== null)) return "";
    return undefined;
  };

  return {
    get,
    getOr: (key, fallback) => get(key) ?? fallback,
    meta: () => {
      const m = fields.meta;
      if (m === null || typeof m !== "object" || Array.isArray(m)) return [];
      return Object.entries(m as Record<string, unknown>)
        .filter((pair): pair is [string, string] => typeof pair[1] === "string");
    },
  };
}

// ------------------------------------------------------------------- sections

export interface Section {
  id: string;
  label: string;
  summary: string;
  nav: string;
  peek: string;
  body: string;
  /** Source filename. The manifest row for inline editing needs it. */
  file: string;
}

const BODY_MARKER = "<!-- body -->";

export function parseSection(path: string): Section {
  const name = path.split(sep).pop() ?? path;
  const raw = read(path, name);

  const open = raw.indexOf("<!--");
  if (open === -1) fail(`${name}: missing the metadata comment at the top`);
  if (raw.slice(0, open).trim() !== "") fail(`${name}: content before the metadata comment`);

  const closeAt = raw.indexOf("-->", open);
  if (closeAt === -1) fail(`${name}: metadata comment is never closed`);

  let id: string | undefined;
  let label: string | undefined;
  let summary: string | undefined;
  let nav: string | undefined;
  for (const line of raw.slice(open + 4, closeAt).split("\n")) {
    const trimmed = line.trim();
    const at = trimmed.indexOf(":");
    if (at === -1) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (key === "id") id = value;
    else if (key === "label") label = value;
    else if (key === "summary") summary = value;
    else if (key === "nav") nav = value;
  }
  if (id === undefined) fail(`${name}: metadata is missing 'id'`);
  if (label === undefined) fail(`${name}: metadata is missing 'label'`);
  if (summary === undefined) fail(`${name}: metadata is missing 'summary'`);

  const rest = raw.slice(closeAt + 3);
  let peek = "";
  let body: string;
  const at = rest.indexOf(BODY_MARKER);
  if (at !== -1) {
    peek = rest.slice(0, at).split("<!-- peek -->").join("").trim();
    body = rest.slice(at + BODY_MARKER.length).trim();
  } else {
    body = rest.trim();
  }
  if (body === "") fail(`${name}: the body is empty`);

  return { id: id!, label: label!, summary: summary!, nav: nav ?? label!, peek, body, file: name };
}

export function renderSection(s: Section): string {
  const peek = s.peek === "" ? "" : `\n        <div class="sec-peek">${s.peek}</div>`;
  return `<section id="${s.id}">
  <details class="sec">
    <summary>
      <div class="wrap">
        <div class="sec-top">
          <p class="sec-label">${s.label}</p>
          <span class="sec-toggle"><span>Expand</span>${CHEVRON}</span>
        </div>
        <p class="sec-sum">${s.summary}</p>${peek}
      </div>
    </summary>
    <div class="sec-body"><div class="wrap">
${s.body}
    </div></div>
  </details>
</section>`;
}

// ---------------------------------------------------------------------- build

function read(path: string, label = path): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    return fail(`${label}: ${(e as NodeJS.ErrnoException).message}`);
  }
}

/** Inline templates/base/<name> if it exists, else nothing. */
const slot = (base: string, name: string): string =>
  existsSync(join(base, name)) ? readFileSync(join(base, name), "utf8") : "";

/**
 * Every optional feature asset is an inline ES module, never `async`, so
 * document order is execution order: the anchor core installs the shared
 * scanner first and the session probe fires last, after every listener exists.
 *
 * An empty slot emits nothing at all — not an empty wrapper, not a blank line.
 */
const moduleScript = (src: string): string =>
  src.trim() === "" ? "" : `\n<script type="module">\n${src}\n</script>`;

/**
 * Layout code owned here, not by the core: the compiled module is deliberately
 * free of `window`, the DOM and Node, so the builder can also import it.
 */
const ANCHOR_ADAPTER = "window.doc.anchor = { BLOCK, norm, scanBlocks };";

/** The anchor pass's build report. Silent until it has something to say. */
function printAnchorReport(anchors: { report: string[]; orphans: Array<[string, string]> }): void {
  if (anchors.report.length === 0 && anchors.orphans.length === 0) return;
  console.log("anchors");
  for (const line of anchors.report) console.log(`  ${line}`);
  if (anchors.orphans.length > 0) {
    const sample = anchors.orphans.slice(0, 8).map(([id, aid]) => `${id}/${aid}`);
    console.log(`  orphans          ${anchors.orphans.length} (${sample.join(", ")})`);
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Find the base assets. Two layouts are supported on purpose: a repository
 * that vendors `templates/base/`, and an installed package that carries
 * `base/` beside its own code. The package must keep working after it is
 * split out of the repository it grew up in.
 *
 * The vendored copy is tried first, so a checkout always builds from the
 * assets it has committed. The published package stages them next to the
 * compiled modules, in `dist/base/`, which is where `npm pack` can reach them
 * and where site discovery will never mistake them for a document.
 */
export function resolveBase(root: string): string {
  const vendored = join(root, "templates", "base");
  if (existsSync(join(vendored, "layout.html"))) return vendored;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "base"), join(here, "..", "base"), join(here, "..", "..", "base")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "layout.html"))) return resolve(candidate);
  }
  return fail("cannot find base assets: no templates/base/layout.html and none beside the package");
}

/** Walk up for the marker directory, so the CLI works from any subdirectory. */
export function repoRoot(from: string = process.cwd()): string {
  let p = resolve(from);
  for (;;) {
    if (existsSync(join(p, "templates", "base", "layout.html"))) return p;
    const up = dirname(p);
    if (up === p) return resolve(from);
    p = up;
  }
}

// ------------------------------------------------------------------- profiles

/**
 * How one build composes a document. `hosted` is the explicit profile for a
 * privately hosted artifact; everything else is the normal profile, whose bytes
 * are frozen by `templates/check-dist`.
 *
 * This is an option, never an inference. The builder must not read the
 * environment, the document URL, or where the package happens to be installed
 * to decide which artifact a caller asked for: the CLI flag and the library
 * option are the same switch, so `docbuild <instance> --hosted` and
 * `build(root, instance, { hosted: true })` produce the same file.
 */
export interface BuildOptions {
  /** Compose the hosted/offline profile instead of the normal one. */
  readonly hosted?: boolean;
}

/**
 * The font markup the normal profile emits, kept here rather than in
 * `layout.html` so the hosted profile can omit it without a second template.
 *
 * The value is the exact three lines the layout carried before `{{FONT_LINKS}}`
 * existed, so a normal build is byte-identical across the change.
 */
export const FONT_LINKS =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2' +
  '?family=JetBrains+Mono:wght@400;500;700&display=swap">';

const FONT_SLOT = "{{FONT_LINKS}}";

const FONT_LINK_LINES = FONT_LINKS.split("\n");

/** A `<link>` line requesting one of the Google font hosts. */
const FONT_LINK_LINE = /^\s*<link\b[^>]*\bhref="https:\/\/fonts\.(?:googleapis|gstatic)\.com/;

/** Any surviving reference to a Google font host, in any position. */
const FONT_HOST = /fonts\.(?:googleapis|gstatic)\.com/;

/**
 * `{{FONT_LINKS}}` is the one placeholder that may legitimately be absent, but
 * absence still has to be *earned*. An installed package staged before the slot
 * existed carries the literal font markup instead, and a hosted build of that
 * layout must still come out without a font request — so both shapes are
 * accepted and a layout carrying neither is a missing placeholder like any
 * other. Without that check the two failures are indistinguishable: a layout
 * that simply lost its font markup would build clean and ship a normal artifact
 * with no font at all.
 *
 * The two removal mechanisms are additive rather than exclusive, because a
 * merge can leave a layout holding the slot *and* the literal lines. Filling or
 * clearing the slot happens first; in the hosted profile the line filter then
 * runs over whatever is left, and a post-condition refuses to return a layout
 * that still names a font host in a shape neither mechanism recognised.
 */
function applyFontProfile(html: string, hosted: boolean): string {
  const hasSlot = html.includes(FONT_SLOT);
  const hasLegacyMarkup = FONT_LINK_LINES.every((line) => html.includes(line));
  if (!hasSlot && !hasLegacyMarkup) fail(`layout.html is missing placeholders: ${FONT_SLOT}`);

  if (!hosted) return hasSlot ? html.split(FONT_SLOT).join(FONT_LINKS) : html;

  // Take the line the slot sits on with it, so a hosted head composed from this
  // layout matches one composed from a layout that never had the markup.
  const cleared = hasSlot ? html.split(`${FONT_SLOT}\n`).join("").split(FONT_SLOT).join("") : html;
  const stripped = cleared
    .split("\n")
    .filter((line) => !FONT_LINK_LINE.test(line))
    .join("\n");
  // Only the layout template is in hand here — sections, `extra.css` and the
  // base assets are substituted later — so a surviving font host is markup this
  // function failed to remove, never authored content.
  if (FONT_HOST.test(stripped)) {
    fail("layout.html: the hosted profile could not remove the font markup");
  }
  return stripped;
}

/**
 * The slots the hosted profile leaves empty: every legacy account and
 * collaboration client, plus the styles that only exist to dress their
 * controls. A hosted artifact is read by its owner through a renderer that
 * offers none of those endpoints, so shipping the code would only mean dead
 * bytes attempting requests that cannot succeed.
 *
 * Theme, components, extra CSS/JS, the anchor core, the local changelog client
 * and `app.js` are deliberately absent from this list: they are what makes the
 * artifact readable and navigable offline. They are named in
 * `HOSTED_KEPT_SLOTS`, because a denylist alone fails open — a slot added later
 * and forgotten here would simply ship.
 */
export const HOSTED_OMITTED_SLOTS: readonly string[] = [
  "{{SESSION_CSS}}",
  "{{COMMENTS_CSS}}",
  "{{EDIT_CSS}}",
  "{{PRESENCE_CSS}}",
  "{{SHARE_CSS}}",
  "{{EDIT_JS}}",
  "{{COMMENTS_JS}}",
  "{{REALTIME_JS}}",
  "{{PRESENCE_JS}}",
  "{{SHARE_JS}}",
  "{{SESSION_JS}}",
];

/**
 * The slots the hosted profile deliberately keeps. Every one of them is either
 * the document's own content, its chrome, or a client with no network, import
 * or endpoint of any kind.
 *
 * This exists so the pair is a partition rather than a denylist. There is no
 * runtime guard: `build()` does not check the partition, because both sides of
 * that comparison are source constants and it could never fire for any build
 * input. The partition is enforced by
 * `hosted-profile.test.ts` ("every layout slot is classified as kept or omitted
 * exactly once"), which compares the two lists against the committed
 * `layout.html`. Adding a slot to the layout without deciding which side it
 * falls on fails that test rather than quietly shipping in the next hosted
 * artifact, and a renamed slot fails the same way instead of turning its
 * denylist entry into a silent no-op.
 */
export const HOSTED_KEPT_SLOTS: readonly string[] = [
  "{{TITLE}}",
  "{{THEME_CSS}}",
  "{{COMPONENTS_CSS}}",
  "{{HISTORY_CSS}}",
  "{{EXTRA_CSS}}",
  "{{DOC_ID}}",
  "{{EYEBROW}}",
  "{{STATUS}}",
  "{{HEADING}}",
  "{{LEDE}}",
  "{{META}}",
  "{{NAV}}",
  "{{SECTIONS}}",
  "{{FOOTER}}",
  "{{APP_JS}}",
  "{{EXTRA_JS}}",
  "{{HISTORY_JSON}}",
  "{{ANCHOR_CORE_JS}}",
  "{{HISTORY_JS}}",
];

export function build(root: string, instance: string, options: BuildOptions = {}): string {
  const hosted = options.hosted === true;
  const inst = join(root, instance);
  if (!isDir(inst)) fail(`no such instance directory: ${instance}`);
  const base = resolveBase(root);

  const doc = parseDoc(read(join(inst, "doc.json")), `${instance}/doc.json`);
  const title = doc.get("title");
  if (title === undefined) fail(`${instance}/doc.json: missing 'title'`);
  const id = doc.get("id");

  const dir = join(inst, "sections");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    return fail(`${instance}/sections: ${(e as NodeJS.ErrnoException).message}`);
  }
  const files = names
    .filter((n) => n.endsWith(".html"))
    .map((n) => join(dir, n))
    .sort();
  if (files.length === 0) fail(`${instance}: no section files under sections/`);

  const sections = files.map(parseSection);

  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.id)) dupes.add(s.id);
    seen.add(s.id);
  }
  if (dupes.size > 0) fail(`duplicate section ids: ${[...dupes].sort().join(", ")}`);

  // History, then anchors, then editability. The changelog has to exist before
  // anchoring so it is anchored like any other section, and editability needs
  // the `data-aid` attributes anchoring adds.
  const labels: Array<[string, string]> = sections.map((s) => [s.id, s.label]);

  const history = refresh(inst);
  let historyJson = "";
  if (history !== null) {
    sections.push(changelogSection(history, labels));
    // `</` inside a data script would close the element early.
    const data = JSON.stringify(history).split("</").join("<\\/");
    // The head version rides on the element as an attribute so a client can
    // read it without parsing the payload. It is the validated seven-hex
    // `head`, so it needs no escaping. No history means no element at all,
    // which is the documented "no version metadata" state downstream.
    historyJson =
      `<script type="application/json" id="doc-history" data-head="${history.head}">` +
      `${data}</script>\n`;
  }

  const anchors = anchorSections(inst, sections);
  markEditable(sections, doc, inst);

  const nav = sections.map((s) => `<a href="#${s.id}">${s.nav}</a>`).join("\n    ");
  const meta = doc
    .meta()
    .map(([k, v]) => `<span><b>${k}</b> &nbsp;${v}</span>`)
    .join("\n      ");
  const bodies = sections.map(renderSection).join("\n\n");

  const optional = (p: string): string => (existsSync(p) ? read(p) : "");

  // The composition surface for every planned client asset. An absent optional
  // file is absence, not empty feature chrome: it contributes zero bytes, so a
  // document built with no features is byte-for-byte what it was before the
  // slots existed.
  //
  // The compiled anchor core is resolved from the running module rather than
  // from `base`, because an installed package has no templates/ directory.
  const compiledDir = dirname(fileURLToPath(import.meta.url));
  const anchorCoreSource = slot(compiledDir, "anchor-core.js");
  // The newline matters: a trailing line comment in the compiled core would
  // otherwise swallow the adapter.
  const anchorCore = anchorCoreSource === "" ? "" : `${anchorCoreSource}\n${ANCHOR_ADAPTER}`;

  let html = read(join(base, "layout.html"));
  const subs: Array<[string, string]> = [
    ["{{TITLE}}", title!],
    ["{{THEME_CSS}}", read(join(base, "theme.css"))],
    ["{{COMPONENTS_CSS}}", read(join(base, "components.css"))],
    ["{{SESSION_CSS}}", slot(base, "session.css")],
    ["{{COMMENTS_CSS}}", slot(base, "comments.css")],
    ["{{EDIT_CSS}}", slot(base, "edit.css")],
    ["{{HISTORY_CSS}}", slot(base, "history.css")],
    ["{{PRESENCE_CSS}}", slot(base, "presence.css")],
    ["{{SHARE_CSS}}", slot(base, "share.css")],
    ["{{EXTRA_CSS}}", optional(join(inst, "extra.css"))],
    // Structural, not an attribute value: absent metadata emits no element.
    ["{{DOC_ID}}", id ? `<meta name="doc-id" content="${id}">\n` : ""],
    ["{{EYEBROW}}", doc.getOr("eyebrow", "")],
    ["{{STATUS}}", doc.getOr("status", "")],
    ["{{HEADING}}", doc.getOr("heading", title!)],
    ["{{LEDE}}", doc.getOr("lede", "")],
    ["{{META}}", meta],
    ["{{NAV}}", nav],
    ["{{SECTIONS}}", bodies],
    ["{{FOOTER}}", doc.getOr("footer", "")],
    ["{{APP_JS}}", read(join(base, "app.js"))],
    ["{{EXTRA_JS}}", optional(join(inst, "extra.js"))],
    ["{{HISTORY_JSON}}", historyJson],
    ["{{ANCHOR_CORE_JS}}", moduleScript(anchorCore)],
    ["{{EDIT_JS}}", moduleScript(slot(base, "edit.js"))],
    ["{{COMMENTS_JS}}", moduleScript(slot(base, "comments.js"))],
    ["{{HISTORY_JS}}", moduleScript(slot(base, "history.js"))],
    ["{{REALTIME_JS}}", moduleScript(slot(base, "realtime.js"))],
    ["{{PRESENCE_JS}}", moduleScript(slot(base, "presence.js"))],
    ["{{SHARE_JS}}", moduleScript(slot(base, "share.js"))],
    ["{{SESSION_JS}}", moduleScript(slot(base, "session.js"))],
  ];
  // A slot silently dropped from layout.html would never fail a build: the
  // unfilled-placeholder scan only sees tokens that survive, never ones that
  // went missing. Every feature that lands later depends on its slot existing,
  // so assert that before substituting anything away.
  const missing = subs.map(([token]) => token).filter((token) => !html.includes(token));
  if (missing.length > 0) fail(`layout.html is missing placeholders: ${missing.sort().join(", ")}`);

  // Profile selection happens after the integrity assertion, never instead of
  // it: the hosted artifact omits a feature the layout still has to declare.
  //
  // That the two hosted slot lists partition every slot exactly once is an
  // invariant over source constants, so it cannot vary with any build input and
  // is asserted from `hosted-profile.test.ts` rather than re-checked on every
  // build. A slot added to `layout.html` without being classified fails that
  // test; a slot this file never substitutes fails `findPlaceholders` below.
  html = applyFontProfile(html, hosted);
  if (hosted) {
    const omitted = new Set(HOSTED_OMITTED_SLOTS);
    for (const sub of subs) {
      if (omitted.has(sub[0])) sub[1] = "";
    }
  }

  for (const [token, value] of subs) {
    // split/join, never replaceAll: a string replacement in replaceAll treats
    // `$&`, `$'` and `` $` `` as capture references, and real section bodies
    // here contain `$`. This must stay a literal substitution.
    html = html.split(token).join(value);
  }

  const left = findPlaceholders(html);
  if (left.length > 0) fail(`unfilled placeholders: ${left.join(", ")}`);

  printAnchorReport(anchors);

  const outDir = join(inst, "dist");
  try {
    mkdirSync(outDir, { recursive: true });
  } catch (e) {
    fail(`${outDir}: ${(e as NodeJS.ErrnoException).message}`);
  }
  const name = inst.split(sep).filter(Boolean).pop();
  if (name === undefined) fail("instance path has no final component");
  // The output is named after the instance directory's basename, not the
  // document slug. The hosted profile gets its own suffix so a hosted build can
  // never overwrite the committed normal artifact `templates/check-dist`
  // rebuilds — both files coexist in dist/.
  const out = join(outDir, hosted ? `${name}.hosted.html` : `${name}.html`);
  try {
    writeFileSync(out, html);
  } catch (e) {
    fail(`${out}: ${(e as NodeJS.ErrnoException).message}`);
  }
  return out;
}

/** Any surviving `{{NAME}}` token. */
export function findPlaceholders(html: string): string[] {
  const out = new Set<string>();
  for (let i = 0; i + 1 < html.length; i++) {
    if (html[i] !== "{" || html[i + 1] !== "{") continue;
    let j = i + 2;
    let name = "";
    while (j < html.length && /[A-Z_]/.test(html[j]!)) {
      name += html[j];
      j++;
    }
    if (name !== "" && html[j] === "}" && html[j + 1] === "}") {
      out.add(`{{${name}}}`);
      i = j + 1;
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------- check

const PAIRED = [
  "div", "details", "section", "summary", "p", "span", "table", "tr", "td", "th", "ul", "li",
  "pre", "h2", "h3", "h4", "header", "footer", "main", "nav", "button", "style",
];

export interface CheckResult {
  lines: string[];
  ok: boolean;
}

/**
 * Cheap guards against the two bugs that actually bite: an unbalanced tag, and
 * a colour that only exists inside a theme block.
 */
export function check(path: string): CheckResult {
  const t = read(path);
  const countable = withoutJsonData(t);
  const bad = PAIRED.filter((tag) => countOpen(countable, tag) !== countClose(countable, tag));

  const media = countOccurrences(t, "prefers-color-scheme");
  const stamped = countOccurrences(t, '[data-theme="dark"]');

  return {
    ok: bad.length === 0,
    lines: [
      `  tag balance      ${bad.length === 0 ? "OK" : `MISMATCH ${bad.join(", ")}`}`,
      `  theme states     ${media > 0 && stamped > 0 ? "OK" : "REVIEW"} (bare :root + ${media} media + ${stamped} stamped)`,
      // Byte length, not UTF-16 length: a multi-byte character must count as
      // the bytes a reader downloads.
      `  size             ${(Buffer.byteLength(t, "utf8") / 1024).toFixed(1)} KB`,
    ],
  };
}

/**
 * Drop `application/json` data blocks before counting tags. Their payload is
 * escaped text, not markup: serialized history holds `<\/p>`, which the close
 * counter would miss while the open counter still saw `<p>`.
 */
function withoutJsonData(t: string): string {
  const OPEN = '<script type="application/json"';
  let out = "";
  let at = 0;
  for (;;) {
    const start = t.indexOf(OPEN, at);
    if (start === -1) return out + t.slice(at);
    const end = t.indexOf("</script>", start);
    if (end === -1) return out + t.slice(at);
    out += t.slice(at, start);
    at = end + "</script>".length;
  }
}

function countOccurrences(t: string, needle: string): number {
  let n = 0;
  let i = t.indexOf(needle);
  while (i !== -1) {
    n++;
    i = t.indexOf(needle, i + needle.length);
  }
  return n;
}

function countOpen(t: string, tag: string): number {
  const needle = `<${tag}`;
  let n = 0;
  let i = t.indexOf(needle);
  while (i !== -1) {
    const next = t[i + needle.length];
    // `<p` must not match `<pre`: only `>` or whitespace ends a tag name.
    if (next === ">" || (next !== undefined && /[ \t\n\r\f\v]/.test(next))) n++;
    i = t.indexOf(needle, i + needle.length);
  }
  return n;
}

function countClose(t: string, tag: string): number {
  return countOccurrences(t, `</${tag}>`);
}
