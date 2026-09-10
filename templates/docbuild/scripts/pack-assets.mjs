#!/usr/bin/env node
// Stage the runtime assets into dist/ so the published package is self-contained.
//
//   node scripts/pack-assets.mjs copy    stage the base, skeleton and skill assets
//   node scripts/pack-assets.mjs clean   remove the staged copies again
//
// The builder inlines every asset in templates/base/ at build time, a new
// document starts as a copy of templates/skeleton/, and the agent instructions
// that teach the whole flow are skills/archon-doc/ at the repository root. None
// of the three live under this package, so a tarball built from the package
// root cannot carry them without a staging step.
//
// They are staged into dist/ rather than the package root on purpose:
//
//   * site discovery never descends a directory named dist/ at any depth, so a
//     staged skeleton can never be mistaken for a publishable document;
//   * dist/ is already gitignored, so the copies cannot drift in git;
//   * dist/ is already the one path in "files", so nothing else has to change.
//
// The copies are a build artifact of `npm pack`, not a second source of truth:
// prepack writes them, postpack removes them, and the checkout is unchanged.
import { cpSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoTemplates = resolve(pkgRoot, "..");
const repoRoot = resolve(repoTemplates, "..");
const staged = join(pkgRoot, "dist");

/**
 * Every asset this package stages, as a repository-root-relative source and the
 * path under dist/ it is staged at.
 *
 * `to` is spelled out rather than derived from `from`'s basename because
 * `skills/archon-doc` has to arrive at exactly
 * `dist/skills/archon-doc/SKILL.md` — that installed path is quoted in the
 * skill itself, in the package README and in the consumer regression, so it is
 * a published interface rather than an implementation detail.
 *
 * These are the only paths under dist/ this script owns. `clean` removes
 * exactly them; it must never be given a path it did not write, because the
 * same `cp -R` that installs the skill is what a user runs to put a copy in
 * their own `.claude/skills/`.
 */
const ASSETS = [
  { from: "templates/base", to: "base" },
  { from: "templates/skeleton", to: "skeleton" },
  { from: "skills/archon-doc", to: "skills/archon-doc" },
];

const mode = process.argv[2];
if (mode !== "copy" && mode !== "clean") {
  console.error("usage: pack-assets.mjs copy|clean");
  process.exit(2);
}

for (const { from, to } of ASSETS) {
  const target = join(staged, to);
  rmSync(target, { recursive: true, force: true });
  if (mode === "copy") {
    cpSync(join(repoRoot, from), target, { recursive: true, dereference: true });
    continue;
  }
  /* A nested `to` creates intermediate directories that `copy` never named, so
     `clean` has to unwind them or `npm pack` leaves an empty `dist/skills/`
     behind and the checkout is not the one it started with. `rmdirSync` refuses
     a non-empty directory, which is the guard: a parent still holding anything
     this script did not stage is left exactly as it is. */
  for (let parent = dirname(target); parent !== staged; parent = dirname(parent)) {
    try {
      rmdirSync(parent);
    } catch {
      break;
    }
  }
}
