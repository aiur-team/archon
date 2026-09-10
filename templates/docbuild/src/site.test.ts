/**
 * Unit coverage for the served content of a repo-backed site build: the
 * committed homepage, the served root files, and the copied skill.
 *
 * The generated root index used to be the only page a consumer could get at
 * `/`, and the skill file was served by proxying another repository. Both are
 * now decided by what the repository commits, which makes three things worth
 * asserting mechanically: a committed `site/index.html` is what `_site/`
 * publishes at the root, a repository that commits none of this still gets the
 * generated list page it got before, and the served skill is byte-identical to
 * the one source the package publishes.
 *
 * Compiled by the existing package and run with Node's built-in test runner:
 *
 *     npm --prefix templates/docbuild run build
 *     node --test templates/docbuild/dist/site.test.js
 *
 * CI runs it alongside the other unit tests; see .github/workflows/check.yml.
 *
 * No runtime dependency, no package or tsconfig change. Tests build throwaway
 * roots in a temporary directory and never touch a committed document.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BuildError, repoRoot, resolveBase } from "./index.js";
import { buildSite } from "./site.js";

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

const docJson = (slug: string): string =>
  `${JSON.stringify(
    {
      id: "a2e912",
      slug,
      aliases: [],
      title: "Sample",
      heading: "Sample",
      lede: "A sample document.",
      meta: { Owner: "you" },
      footer: "Sample",
    },
    null,
    2,
  )}\n`;

/** The homepage bytes, deliberately unlike anything `renderIndex` emits. */
const HOMEPAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Archon</title>
<link rel="alternate" type="text/markdown" href="/AGENTS.md"></head>
<body><img src="assets/logo.png" alt=""></body>
</html>
`;

const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const AGENTS = "# Archon, for agents\n\nnpx @aiur-team/archon\n";
const LLMS = "# Archon\n\n> One self-contained HTML file.\n";
const SKILL = "---\nname: archon-doc\n---\n\nThe complete instruction set.\n";

interface Ctx {
  after: (fn: () => void) => void;
}

/**
 * A throwaway root carrying the real base assets and one document. `served`
 * adds the committed homepage tree, the skill tree and the served root files;
 * omitting it is the repository that commits none of them.
 */
const root = (t: Ctx, options: { served?: boolean; slug?: string } = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "acn010-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const compiled = dirname(fileURLToPath(import.meta.url));
  cpSync(resolveBase(repoRoot(compiled)), join(dir, "templates", "base"), { recursive: true });

  // The instance directory and the slug are deliberately separable: a document
  // that claims a reserved route does so in its doc.json, from an ordinary
  // directory that site discovery still walks.
  const slug = options.slug ?? "sample";
  const inst = join(dir, "sample");
  mkdirSync(join(inst, "sections"), { recursive: true });
  writeFileSync(join(inst, "doc.json"), docJson(slug));
  writeFileSync(join(inst, "sections", "01-problem.html"), SECTION);

  if (options.served === true) {
    mkdirSync(join(dir, "site", "assets"), { recursive: true });
    writeFileSync(join(dir, "site", "index.html"), HOMEPAGE);
    writeFileSync(join(dir, "site", "assets", "logo.png"), LOGO);
    mkdirSync(join(dir, "skills", "archon-doc"), { recursive: true });
    writeFileSync(join(dir, "skills", "archon-doc", "SKILL.md"), SKILL);
    writeFileSync(join(dir, "AGENTS.md"), AGENTS);
    writeFileSync(join(dir, "llms.txt"), LLMS);
  }
  return dir;
};

/**
 * Fresh history generation is gated on the origin slug, and the
 * committed-history fallback reads the surrounding checkout. Keep both off so
 * the result never depends on the repository the tests happen to run inside.
 */
const isolate = (t: Ctx): void => {
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

const bytes = (...parts: string[]): Buffer => readFileSync(join(...parts));

test("the committed homepage and agent files are what the site serves", (t) => {
  isolate(t);
  const dir = root(t, { served: true });

  const { outDir } = buildSite(dir);

  // The bytes, not the call order: the generated index is written first and the
  // committed file has to be what survives into the publish tree.
  assert.deepEqual(bytes(outDir, "index.html"), bytes(dir, "site", "index.html"));
  assert.equal(readFileSync(join(outDir, "index.html"), "utf8"), HOMEPAGE);
  assert.deepEqual(bytes(outDir, "assets", "logo.png"), bytes(dir, "site", "assets", "logo.png"));

  assert.deepEqual(bytes(outDir, "AGENTS.md"), bytes(dir, "AGENTS.md"));
  assert.deepEqual(bytes(outDir, "llms.txt"), bytes(dir, "llms.txt"));

  // One source of truth: the served skill is a build-time copy of the file the
  // package publishes, so it cannot drift from it.
  assert.deepEqual(
    bytes(outDir, "skills", "archon-doc", "SKILL.md"),
    bytes(dir, "skills", "archon-doc", "SKILL.md"),
  );

  // The document still builds, and its permanent-id redirect still falls out of
  // the ordinary generator rather than a hand-written rule.
  assert.match(readFileSync(join(outDir, "sample", "index.html"), "utf8"), /A heading/);
  assert.match(
    readFileSync(join(outDir, "_redirects"), "utf8"),
    /^\/d\/a2e912 \/sample\/ 301$/m,
  );
});

test("with no committed homepage the generated list page still stands", (t) => {
  isolate(t);
  const dir = root(t);

  const { outDir } = buildSite(dir);

  const index = readFileSync(join(outDir, "index.html"), "utf8");
  assert.match(index, /<title>Architecture docs<\/title>/);
  assert.match(index, /<a href="\/sample\/">/);
});

test("a symbolic link inside the homepage tree fails the build", (t) => {
  isolate(t);
  const dir = root(t, { served: true });
  symlinkSync(join(dir, "AGENTS.md"), join(dir, "site", "linked.md"));

  assert.throws(
    () => buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /site\/linked\.md: symbolic links are not supported in static page trees/.test(error.message),
  );
});

test("a document that claims the skills route fails as a reserved route", (t) => {
  isolate(t);
  const dir = root(t, { served: true, slug: "skills" });

  assert.throws(
    () => buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError && /reserved site route: skills/.test(error.message),
  );
});
