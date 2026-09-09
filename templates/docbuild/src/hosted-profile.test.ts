/**
 * Unit coverage for the explicit hosted/offline build profile (AHU-002).
 *
 * The builder composes one document two ways. The normal profile is the
 * published artifact whose bytes `templates/check-dist` freezes. The hosted
 * profile is for a private hosted reader: same inline theme, navigation and
 * section content, but no Google-font request and none of the legacy session,
 * comment, edit, realtime, presence or share client code.
 *
 * Compiled by the existing package and run with Node's built-in test runner:
 *
 *     npm --prefix templates/docbuild run build
 *     node --test templates/docbuild/dist/hosted-profile.test.js
 *
 * CI runs it alongside the other unit tests; see .github/workflows/check.yml.
 *
 * Tests build throwaway roots in a temporary directory and never touch a
 * committed document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { build, FONT_LINKS, repoRoot, resolveBase } from "./index.js";

const COMPILED = dirname(fileURLToPath(import.meta.url));
const CLI = join(COMPILED, "cli.js");

const SECTION = `<!--
id: problem
label: The problem
summary: A one-line summary.
nav: Problem
-->
<!-- body -->

<h2>A heading</h2>

<p>A paragraph.</p>
`;

/**
 * The instance directory is `sample`; the slug is deliberately something else.
 * Output is named after the directory basename, and the README used to claim
 * the slug — a fixture where the two agree could not tell them apart.
 */
const DOC_JSON = `${JSON.stringify(
  {
    id: "a2e912",
    slug: "a-different-slug",
    title: "Sample",
    heading: "Sample",
    lede: "A sample document.",
    meta: { Owner: "you" },
    footer: "Sample",
  },
  null,
  2,
)}\n`;

/**
 * Every base asset the hosted profile must leave out, and every one it must
 * keep. Both slot kinds are substituted verbatim, so the asset's own bytes are
 * the assertion — no per-file marker string to drift out of date.
 *
 * `history.*` is on the kept side on purpose: the changelog client reads the
 * embedded `#doc-history` block and has no network, import or endpoint, so it
 * survives isolation the way the theme toggle does.
 */
const OMITTED_ASSETS = [
  "session.css",
  "comments.css",
  "edit.css",
  "presence.css",
  "share.css",
  "edit.js",
  "comments.js",
  "realtime.js",
  "presence.js",
  "share.js",
  "session.js",
] as const;

const KEPT_ASSETS = ["theme.css", "components.css", "history.css", "app.js", "history.js"] as const;

/**
 * Fresh history generation is gated on the origin slug, and the committed
 * fallback is a second branch. Keep both off so a result never depends on the
 * repository the tests happen to run inside.
 */
const isolate = (t: { after: (fn: () => void) => void }): void => {
  const approved = process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
  const netlify = process.env.NETLIFY;
  delete process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
  delete process.env.NETLIFY;
  t.after(() => {
    if (approved === undefined) delete process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
    else process.env.DOCBUILD_PUBLIC_HISTORY_APPROVED = approved;
    if (netlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = netlify;
  });
};

/** The base assets this repository has committed. */
const baseDir = (): string => resolveBase(repoRoot(COMPILED));

const asset = (name: string): string => readFileSync(join(baseDir(), name), "utf8");

/**
 * A throwaway root carrying the real base assets and one instance, removed when
 * the test finishes. `legacyLayout` rewrites the staged layout back to the
 * pre-`{{FONT_LINKS}}` shape an already-installed package still carries.
 */
const root = (t: { after: (fn: () => void) => void }, legacyLayout = false): string => {
  const dir = mkdtempSync(join(tmpdir(), "ahu002-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const base = join(dir, "templates", "base");
  cpSync(baseDir(), base, { recursive: true });
  if (legacyLayout) {
    const layout = join(base, "layout.html");
    const src = readFileSync(layout, "utf8");
    assert.ok(src.includes("{{FONT_LINKS}}"), "the committed layout should carry the font slot");
    writeFileSync(layout, src.split("{{FONT_LINKS}}").join(FONT_LINKS));
  }

  const inst = join(dir, "sample");
  mkdirSync(join(inst, "sections"), { recursive: true });
  writeFileSync(join(inst, "doc.json"), DOC_JSON);
  writeFileSync(join(inst, "sections", "01-problem.html"), SECTION);
  return dir;
};

const built = (dir: string, hosted: boolean): { path: string; html: string } => {
  const path = build(dir, "sample", { hosted });
  return { path, html: readFileSync(path, "utf8") };
};

test("the hosted profile makes no font request", (t) => {
  isolate(t);
  const { html } = built(root(t), true);

  // Anchor on real output first: a bare absence assertion would also pass for a
  // document that rendered nothing at all.
  assert.match(html, /<h2[^>]*>A heading<\/h2>/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
  assert.doesNotMatch(html, /<link\b[^>]*\brel="preconnect"/);
  assert.doesNotMatch(html, /<link\b[^>]*\brel="stylesheet"/);

  // Readable without the CDN: the mono stack still names local fallbacks.
  assert.match(html, /--mono:[^;]*\bui-monospace\b/);
  assert.match(html, /--sans:[^;]*\bsystem-ui\b/);
});

test("the hosted profile omits every legacy account and collaboration client", (t) => {
  isolate(t);
  const { html } = built(root(t), true);

  for (const name of OMITTED_ASSETS) {
    const source = asset(name);
    assert.ok(source.trim() !== "", `${name} should be a non-empty base asset`);
    assert.ok(!html.includes(source), `hosted output still embeds ${name}`);
  }
  // No activation either. Each optional client is its own `type="module"`
  // wrapper, so a hosted document has exactly two left — the anchor core and
  // the local changelog client. A leftover wrapper for any omitted module, or
  // an empty wrapper standing where one used to be, changes this count.
  const modules = html.match(/<script type="module">/g) ?? [];
  assert.equal(modules.length, 2, "hosted output kept a legacy module wrapper");
});

test("the hosted profile keeps what makes the document readable offline", (t) => {
  isolate(t);
  const { html } = built(root(t), true);

  for (const name of KEPT_ASSETS) {
    assert.ok(html.includes(asset(name)), `hosted output dropped ${name}`);
  }
  // Theme control, section navigation, both theme states, and the generated
  // anchors the section content is addressed by.
  assert.match(html, /<button class="tt" id="tt"/);
  assert.match(html, /<nav class="jump"/);
  assert.match(html, /<a href="#problem">Problem<\/a>/);
  assert.match(html, /\[data-theme="dark"\]/);
  assert.match(html, /prefers-color-scheme/);
  assert.match(html, /<details class="sec">/);
  assert.match(html, /\sdata-aid="a[0-9a-f]{8}"/);
  assert.match(html, /window\.doc\.anchor = \{ BLOCK, norm, scanBlocks \};/);
});

test("the normal profile still carries the font links and every optional client", (t) => {
  isolate(t);
  const { html } = built(root(t), false);

  // A future-regression guard for the normal artifact, not coverage of the
  // hosted omissions: `templates/check-dist` is what freezes the real bytes.
  assert.ok(html.includes(FONT_LINKS), "normal output lost the font markup");
  for (const name of [...OMITTED_ASSETS, ...KEPT_ASSETS]) {
    assert.ok(html.includes(asset(name)), `normal output dropped ${name}`);
  }
});

test("a layout without the font slot still builds both profiles correctly", (t) => {
  isolate(t);
  // An installed package staged before `{{FONT_LINKS}}` existed still carries
  // the literal markup. Normal builds of it must be untouched, and a hosted
  // build of it must still come out without a font request.
  const legacy = root(t, true);
  const normal = built(legacy, false);
  assert.ok(normal.html.includes(FONT_LINKS));

  const hosted = built(legacy, true);
  assert.doesNotMatch(hosted.html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(hosted.html, /fonts\.gstatic\.com/);
  assert.match(hosted.html, /<h2[^>]*>A heading<\/h2>/);

  // The same bytes as a hosted build from the current layout: the two paths to
  // omission converge rather than producing two different artifacts.
  assert.equal(hosted.html, built(root(t), true).html);
});

test("each profile writes its own file, named after the instance basename", (t) => {
  isolate(t);
  const dir = root(t);

  const normal = built(dir, false);
  assert.equal(normal.path, join(dir, "sample", "dist", "sample.html"));

  const hosted = built(dir, true);
  assert.equal(hosted.path, join(dir, "sample", "dist", "sample.hosted.html"));

  // The slug is `a-different-slug`; nothing is named after it.
  assert.ok(!existsSync(join(dir, "sample", "dist", "a-different-slug.html")));

  // A hosted build leaves the committed normal artifact alone.
  assert.equal(readFileSync(normal.path, "utf8"), normal.html);
  assert.notEqual(hosted.html, normal.html);
});

/** Run the compiled CLI from `dir`, capturing stdout and the exit code. */
const cli = (dir: string, args: string[]): { code: number; stdout: string; stderr: string } => {
  const env = { ...process.env };
  delete env.DOCBUILD_PUBLIC_HISTORY_APPROVED;
  delete env.NETLIFY;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

test("the CLI profile is the library profile, and reports the file it wrote", (t) => {
  isolate(t);
  const viaLibrary = built(root(t), true);

  const dir = root(t);
  const result = cli(dir, ["sample", "--hosted"]);
  assert.equal(result.code, 0, result.stderr);

  // The reported path is the file that actually exists, not a slug-shaped guess.
  const reported = result.stdout.match(/^built (.+)$/m);
  assert.ok(reported, `expected a built line, got: ${result.stdout}`);
  assert.equal(reported[1], join("sample", "dist", "sample.hosted.html"));
  assert.ok(existsSync(join(dir, reported[1]!)));

  assert.equal(readFileSync(join(dir, reported[1]!), "utf8"), viaLibrary.html);
});

test("the CLI reports the normal artifact by its instance basename too", (t) => {
  isolate(t);
  const dir = root(t);
  const result = cli(dir, ["sample"]);
  assert.equal(result.code, 0, result.stderr);
  const reported = result.stdout.match(/^built (.+)$/m);
  assert.ok(reported);
  assert.equal(reported[1], join("sample", "dist", "sample.html"));
  assert.ok(existsSync(join(dir, reported[1]!)));
});

test("unknown and incompatible flags fail with help and a nonzero exit", (t) => {
  isolate(t);
  const dir = root(t);

  for (const args of [["sample", "--hostedd"], ["sample", "-x"], ["--site", "--hosted"], ["--site", "sample"], []]) {
    const result = cli(dir, args);
    assert.notEqual(result.code, 0, `expected a nonzero exit for: ${args.join(" ")}`);
    assert.match(result.stderr, /^error: /m, `expected an error line for: ${args.join(" ")}`);
    assert.match(result.stderr, /docbuild <instance> --hosted/, `expected help for: ${args.join(" ")}`);
    assert.equal(result.stdout, "", `help must not go to stdout for: ${args.join(" ")}`);
  }

  // --help is still the one spelling that succeeds, and it documents --hosted.
  const help = cli(dir, ["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /docbuild <instance> --hosted/);
  assert.match(help.stdout, /docbuild --site/);
});
