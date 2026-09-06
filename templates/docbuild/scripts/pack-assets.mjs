#!/usr/bin/env node
// Stage the runtime assets into dist/ so the published package is self-contained.
//
//   node scripts/pack-assets.mjs copy    stage templates/base and templates/skeleton
//   node scripts/pack-assets.mjs clean   remove the staged copies again
//
// The builder inlines every asset in templates/base/ at build time, and a new
// document starts as a copy of templates/skeleton/. Both live one level above
// this package in the repository, so a tarball built from the package root
// cannot carry them without a staging step.
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
import { cpSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoTemplates = resolve(pkgRoot, "..");
const staged = join(pkgRoot, "dist");

// Source directory under templates/, staged under dist/ with the same name.
const ASSETS = ["base", "skeleton"];

const mode = process.argv[2];
if (mode !== "copy" && mode !== "clean") {
  console.error("usage: pack-assets.mjs copy|clean");
  process.exit(2);
}

for (const name of ASSETS) {
  const target = join(staged, name);
  rmSync(target, { recursive: true, force: true });
  if (mode === "copy") {
    cpSync(join(repoTemplates, name), target, { recursive: true, dereference: true });
  }
}
