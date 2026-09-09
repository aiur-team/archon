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

import {
  build,
  BuildError,
  findPlaceholders,
  FONT_LINKS,
  HOSTED_KEPT_SLOTS,
  HOSTED_OMITTED_SLOTS,
  repoRoot,
  resolveBase,
} from "./index.js";

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
 * Per-instance content the hosted profile keeps. These are not base assets —
 * they come from the instance directory — and no committed document in this
 * repository has any of them, so `templates/check-dist` cannot cover them
 * either. Without a fixture that writes them, widening `HOSTED_OMITTED_SLOTS`
 * to swallow `{{EXTRA_CSS}}`, `{{EXTRA_JS}}` or `{{HISTORY_JSON}}` leaves every
 * test green while every hosted artifact silently loses the author's own CSS,
 * JS and changelog data.
 */
const EXTRA_CSS = ".authored-marker{outline:1px solid red}\n";
const EXTRA_JS = 'window.authoredMarker = "authored-extra-js";\n';

const HISTORY_HEAD = "0a1b2c3";
const HISTORY_JSON = `${JSON.stringify(
  {
    doc: "sample",
    head: HISTORY_HEAD,
    versions: [
      {
        sha: HISTORY_HEAD,
        date: "2026-01-02T03:04:05.000Z",
        author: "A Person",
        subject: "A commit subject",
        url: "",
        // Empty on purpose: a non-empty `changed` renders `&minus;`, which the
        // anchor scanner's named-entity table does not know. That is a
        // pre-existing defect, not this test's subject — see index.test.ts.
        changed: [],
      },
    ],
  },
  null,
  2,
)}\n`;

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

/**
 * Read a base asset, refusing to return an empty one. `html.includes("")` is
 * unconditionally true, so an emptied asset would turn every kept-side
 * assertion into a silent no-op — the one failure the kept-side checks exist
 * to catch.
 */
const asset = (name: string): string => {
  const source = readFileSync(join(baseDir(), name), "utf8");
  assert.ok(source.trim() !== "", `${name} should be a non-empty base asset`);
  return source;
};

/**
 * The four shapes `layout.html` can take with respect to the font markup.
 *
 * - `slot` is what this repository commits.
 * - `legacy` is a package staged before `{{FONT_LINKS}}` existed: literal
 *   markup, no slot.
 * - `both` is what a merge across this change can leave behind.
 * - `none` is a layout that has lost its font markup altogether, which must be
 *   a loud failure rather than a silently fontless artifact.
 */
type LayoutShape = "slot" | "legacy" | "both" | "none";

interface Fixture {
  /** Font-markup shape to stage into `layout.html`. Defaults to `slot`. */
  readonly layout?: LayoutShape;
  /** Write `extra.css`, `extra.js` and `history.json` into the instance. */
  readonly authored?: boolean;
}

/**
 * A throwaway root carrying the real base assets and one instance, removed when
 * the test finishes.
 */
const root = (t: { after: (fn: () => void) => void }, fixture: Fixture = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "ahu002-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const base = join(dir, "templates", "base");
  cpSync(baseDir(), base, { recursive: true });

  const shape = fixture.layout ?? "slot";
  if (shape !== "slot") {
    const layout = join(base, "layout.html");
    const src = readFileSync(layout, "utf8");
    assert.ok(src.includes("{{FONT_LINKS}}"), "the committed layout should carry the font slot");
    const replacement =
      shape === "legacy" ? FONT_LINKS : shape === "both" ? `{{FONT_LINKS}}\n${FONT_LINKS}` : "";
    writeFileSync(layout, src.split("{{FONT_LINKS}}").join(replacement));
  }

  const inst = join(dir, "sample");
  mkdirSync(join(inst, "sections"), { recursive: true });
  writeFileSync(join(inst, "doc.json"), DOC_JSON);
  writeFileSync(join(inst, "sections", "01-problem.html"), SECTION);
  if (fixture.authored === true) {
    writeFileSync(join(inst, "extra.css"), EXTRA_CSS);
    writeFileSync(join(inst, "extra.js"), EXTRA_JS);
    writeFileSync(join(inst, "history.json"), HISTORY_JSON);
  }
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
  const legacy = root(t, { layout: "legacy" });
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

test("a layout carrying both the slot and the literal links is fully stripped", (t) => {
  isolate(t);
  // A branch cut before the slot existed and merged after it can resolve to a
  // layout holding both shapes. If the two removal mechanisms were exclusive,
  // the slot branch would win and the literal links would survive into a
  // document whose whole point is that it makes no font request.
  const { html } = built(root(t, { layout: "both" }), true);

  assert.match(html, /<h2[^>]*>A heading<\/h2>/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/);
  assert.doesNotMatch(html, /fonts\.gstatic\.com/);
});

test("a layout with neither the slot nor the font markup fails both profiles", (t) => {
  isolate(t);
  // The tolerated-missing placeholder is tolerated because the legacy markup
  // stands in for it. A layout carrying neither has genuinely lost a feature,
  // and it must fail the way every other missing slot does rather than quietly
  // producing a fontless artifact.
  const dir = root(t, { layout: "none" });

  for (const hosted of [false, true]) {
    assert.throws(
      () => build(dir, "sample", { hosted }),
      (error: Error) => {
        assert.ok(error instanceof BuildError, `expected a BuildError, got ${error.name}`);
        assert.match(error.message, /missing placeholders: \{\{FONT_LINKS\}\}/);
        return true;
      },
      `expected a missing-placeholder failure with hosted=${hosted}`,
    );
  }
});

test("the hosted profile keeps the author's own CSS, JS and changelog data", (t) => {
  isolate(t);
  // No committed document in this repository has an `extra.css`, `extra.js` or
  // `history.json`, so `templates/check-dist` covers none of them. Without this
  // fixture, widening HOSTED_OMITTED_SLOTS to swallow any of the three leaves
  // the whole suite green while every hosted artifact loses authored content.
  const { html } = built(root(t, { authored: true }), true);

  assert.ok(html.includes(EXTRA_CSS.trim()), "hosted output dropped extra.css");
  assert.ok(html.includes(EXTRA_JS.trim()), "hosted output dropped extra.js");

  // The embedded changelog data the retained history client reads. Without it
  // that client is inert, so keeping one without the other is not "kept".
  const block = html.match(
    /<script type="application\/json" id="doc-history"[^>]*>(.*?)<\/script>/s,
  );
  assert.ok(block, "hosted output dropped the embedded history block");
  assert.match(block[0]!, new RegExp(` data-head="${HISTORY_HEAD}"`));
  const parsed = JSON.parse(block[1]!.split("<\\/").join("</")) as { head: string };
  assert.equal(parsed.head, HISTORY_HEAD);
  assert.ok(html.includes(asset("history.js")), "hosted output dropped the changelog client");
});

test("every layout slot is classified as kept or omitted exactly once", (t) => {
  isolate(t);
  // The pair is a partition, not a denylist. A slot added to layout.html and
  // forgotten here would otherwise ship in hosted artifacts by default, and a
  // renamed slot would turn its omission entry into a silent no-op. The
  // production build asserts this too; asserting it against the committed
  // layout is what names the offending token at review time.
  const layout = readFileSync(join(baseDir(), "layout.html"), "utf8");
  const inLayout = new Set(findPlaceholders(layout));
  // Composed here rather than declared in the layout, so it has no slot.
  inLayout.delete("{{FONT_LINKS}}");

  const omitted = new Set(HOSTED_OMITTED_SLOTS);
  const kept = new Set(HOSTED_KEPT_SLOTS);
  assert.equal(omitted.size, HOSTED_OMITTED_SLOTS.length, "duplicate entry in the omitted list");
  assert.equal(kept.size, HOSTED_KEPT_SLOTS.length, "duplicate entry in the kept list");

  const both = [...omitted].filter((token) => kept.has(token));
  assert.deepEqual(both, [], "a slot is classified as both kept and omitted");

  const classified = new Set([...omitted, ...kept]);
  const unclassified = [...inLayout].filter((token) => !classified.has(token)).sort();
  assert.deepEqual(unclassified, [], "layout.html has a slot the hosted profile does not classify");

  const unknown = [...classified].filter((token) => !inLayout.has(token)).sort();
  assert.deepEqual(unknown, [], "the hosted profile classifies a slot layout.html does not have");
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

  const rejected = [
    ["sample", "--hostedd"],
    ["sample", "-x"],
    ["--site", "--hosted"],
    ["--site", "sample"],
    ["--site", "--site"],
    ["sample", "--hosted", "--hosted"],
    ["a", "b"],
    [],
    // Help is the whole request or it is a mistake. These exited 2 before the
    // parser was rewritten, and a `docbuild "$doc" $FLAGS && upload ...` script
    // depends on that: exiting 0 while writing nothing would upload the
    // previous run's artifact.
    ["sample", "--help"],
    ["sample", "-h"],
    ["--site", "--help"],
  ];
  for (const args of rejected) {
    const result = cli(dir, args);
    assert.notEqual(result.code, 0, `expected a nonzero exit for: ${args.join(" ")}`);
    assert.match(result.stderr, /^error: /m, `expected an error line for: ${args.join(" ")}`);
    assert.match(result.stderr, /docbuild <instance> --hosted/, `expected help for: ${args.join(" ")}`);
    assert.equal(result.stdout, "", `help must not go to stdout for: ${args.join(" ")}`);
    assert.ok(
      !existsSync(join(dir, "sample", "dist")),
      `a rejected invocation must write nothing: ${args.join(" ")}`,
    );
  }

  // A lone help flag is the one spelling that succeeds, in both spellings, and
  // it documents every mode.
  for (const flag of ["-h", "--help"]) {
    const help = cli(dir, [flag]);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /docbuild <instance> --hosted/);
    assert.match(help.stdout, /docbuild --site/);
  }
});
