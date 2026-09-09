#!/usr/bin/env node
/**
 * Load every module in the hosted deploy tree and prove it links.
 *
 * This is `scripts/check-function-modules.mjs` for the second deployment. The
 * reasoning is the same and so is the output vocabulary, but it cannot be the
 * same script: the two deployments have separate lockfiles, separate
 * dependency sets and separate route prefixes, and the whole point of the
 * hosted boundary is that neither tree can quietly reach into the other.
 *
 * A dynamic `import()` is most of the gate, because ESM resolves and links
 * named imports before it evaluates anything: an unresolvable specifier and a
 * missing named export are both link-time errors. Modules are loaded, never
 * called, so nothing here runs a handler, reads a credential, opens a store or
 * contacts a provider. `hosted/lib/config.mjs` in particular reads its
 * environment from an argument rather than `process.env`, which is exactly what
 * makes importing it at CI time a safe thing to do.
 *
 * Three static rules sit on top of linking, because a specifier can be wrong in
 * ways that still resolve on a developer's machine:
 *
 *  1. **Nothing escapes `hosted/`.** Every scanned path, and every relative
 *     import inside one, must resolve inside the hosted root after symlinks are
 *     followed. A hosted module that reached into `netlify/lib/` would link
 *     here and 404 in production, because the hosted deploy carries only this
 *     directory -- and it would also undo the boundary this build exists to
 *     draw, since the legacy tree is where Netlify Identity, `DOC_OWNERS` and
 *     the organisation role defaults live.
 *  2. **Every bare import is a declared runtime dependency.** A bare specifier
 *     must be `node:*` or listed in `hosted/package.json` `dependencies` --
 *     not `devDependencies`, and not merely present in a hoisted
 *     `node_modules` that a clean install would not produce.
 *  3. **No deployed module imports a fixture.** `hosted/test/` is test data.
 *     A handler that could import it is one edit away from returning a fake
 *     success, so the import is refused rather than discouraged.
 *
 * Functions must also present the entry-point shape Netlify invokes -- a
 * callable default export and a `config` object -- and must be routed under
 * `/api/hosted/`, keeping the hosted API in one namespace that operator
 * routing and rate-limit rules can name.
 *
 * This ticket (AHU-001) ships the shell, so `hosted/functions/` does not exist
 * yet and finding no functions is not a failure. Finding no modules at all is:
 * a gate that scans an empty tree and reports success is inventing the one
 * answer it must never invent.
 *
 * Output contract: one `PASS` line on stdout and exit 0, or one
 * `FAIL hosted modules:` line per fault on stderr and exit 1. Every module is
 * attempted before the process exits, so one broken import does not hide the
 * next.
 *
 *   node scripts/check-hosted-modules.mjs
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, derived from this file's own location. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The hosted deploy root. Nothing this gate touches may resolve outside it. */
const HOSTED = "hosted";
const HOSTED_ROOT = join(REPO_ROOT, HOSTED);

/** Directories inside the hosted root that carry deployable modules. */
const DEPLOY_DIRECTORIES = Object.freeze(["lib", "functions"]);

/** Test data. Scanned for nothing; importable from nothing that deploys. */
const FIXTURE_DIRECTORY = "test";

/** The path prefix every hosted HTTP function is routed under. */
const ROUTED_PREFIX = "/api/hosted/";

/**
 * Import specifiers, read statically.
 *
 * Deliberately a scanner rather than a parser. A specifier it misses is still
 * caught by the dynamic import below, so under-matching is survivable; what is
 * not survivable is over-matching, because a phantom specifier fails a build
 * over a sentence in a comment. These files carry long comments, so `stripComments`
 * runs first and this pattern only ever sees code.
 */
const SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g;

/**
 * `source` with its comments blanked out and its string literals intact.
 *
 * Written as a small state machine rather than a pair of regular expressions
 * because the naive `//.*$` rule eats the tail of every line containing an
 * `https://` URL, and these files contain several.
 */
function stripComments(source) {
  let out = "";
  let state = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        index += 1;
      } else if (char === "/" && next === "*") {
        state = "block";
        index += 1;
      } else {
        if (char === '"' || char === "'" || char === "`") state = char;
        out += char;
      }
    } else if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
    } else if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      } else if (char === "\n") {
        out += char;
      }
    } else {
      /* Inside a string or template literal: copy verbatim, honour escapes. */
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === state) {
        state = "code";
      }
    }
  }
  return out;
}

/** Whether `candidate` is inside `root`, after symlinks are resolved. */
function isInside(root, candidate) {
  const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
  const realRoot = realpathSync(root);
  if (real === realRoot) return true;
  return real.startsWith(`${realRoot}/`);
}

/**
 * Every `.mjs` module under `directory`, recursively, excluding test modules
 * and installed dependencies.
 *
 * Symlinks are refused rather than followed: a symlink is the obvious way for a
 * scan to walk out of the tree it is supposed to be confined to, and the hosted
 * deploy has no legitimate use for one.
 */
function modulesUnder(directory, faults) {
  const absolute = join(HOSTED_ROOT, directory);
  if (!existsSync(absolute)) return [];

  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        faults.push(`${relative(REPO_ROOT, path)} is a symbolic link; the hosted tree carries no symlinks`);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        if (!isInside(HOSTED_ROOT, path)) {
          faults.push(`${relative(REPO_ROOT, path)} resolves outside ${HOSTED}/`);
          continue;
        }
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".mjs") || entry.name.endsWith(".test.mjs")) continue;
      found.push(path);
    }
  };
  walk(absolute);
  return found;
}

/** The names a deployed hosted module is allowed to import from the registry. */
function runtimeDependencies(faults) {
  const manifestPath = join(HOSTED_ROOT, "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return new Set(Object.keys(manifest.dependencies ?? {}));
  } catch (error) {
    faults.push(`${HOSTED}/package.json could not be read: ${error.message.split("\n")[0]}`);
    return new Set();
  }
}

/** The package name a bare specifier belongs to, scoped names included. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Static faults in one module's import specifiers. */
function importFaults(absolutePath, dependencies) {
  const relativePath = relative(REPO_ROOT, absolutePath);
  const faults = [];
  const source = stripComments(readFileSync(absolutePath, "utf8"));

  for (const match of source.matchAll(SPECIFIER_PATTERN)) {
    const specifier = match[1];

    if (specifier.startsWith("node:")) continue;

    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const target = specifier.startsWith("/")
        ? join(REPO_ROOT, specifier)
        : resolve(dirname(absolutePath), specifier);
      if (!isInside(HOSTED_ROOT, target)) {
        faults.push(`${relativePath} imports ${specifier}, which resolves outside ${HOSTED}/`);
        continue;
      }
      if (isInside(join(HOSTED_ROOT, FIXTURE_DIRECTORY), target)) {
        faults.push(`${relativePath} imports ${specifier} from ${HOSTED}/${FIXTURE_DIRECTORY}/; fixtures must not reach a deployed module`);
      }
      continue;
    }

    const name = packageOf(specifier);
    if (!dependencies.has(name)) {
      faults.push(`${relativePath} imports ${name}, which is not a dependency in ${HOSTED}/package.json`);
    }
  }
  return faults;
}

/**
 * The Netlify entry-point shape. A module that links but exports no handler is
 * a function that cannot be invoked, which the deploy would accept silently.
 */
function entryPointFaults(module) {
  const faults = [];
  if (typeof module.default !== "function") {
    faults.push("does not export a callable default handler");
  }
  const config = module.config;
  if (config === null || typeof config !== "object") {
    faults.push("does not export a config object");
    return faults;
  }
  if (config.path !== undefined && !String(config.path).startsWith(ROUTED_PREFIX)) {
    faults.push(`is routed at ${config.path}, outside the ${ROUTED_PREFIX}* hosted API namespace`);
  }
  if (config.path === undefined && config.schedule === undefined) {
    faults.push("declares neither a path nor a schedule");
  }
  return faults;
}

async function main() {
  const faults = [];

  if (!existsSync(HOSTED_ROOT)) {
    process.stderr.write(`FAIL hosted modules: ${HOSTED}/ does not exist\n`);
    return 1;
  }

  const dependencies = runtimeDependencies(faults);
  const functions = modulesUnder("functions", faults);
  const libraries = modulesUnder("lib", faults);
  const modules = [...functions, ...libraries];

  /* No functions yet is the shape AHU-001 ships: the app shell is real and the
     upload route is deliberately absent until its producer lands. No modules at
     all means the layout moved, not that the code is sound. */
  if (modules.length === 0) {
    process.stderr.write(`FAIL hosted modules: no modules found under ${HOSTED}/{${DEPLOY_DIRECTORIES.join(",")}}/\n`);
    return 1;
  }

  const routes = new Map();
  let loaded = 0;

  for (const absolutePath of modules) {
    const relativePath = relative(REPO_ROOT, absolutePath);
    faults.push(...importFaults(absolutePath, dependencies));

    let module;
    try {
      module = await import(pathToFileURL(absolutePath).href);
    } catch (error) {
      /* Node's link errors quote absolute paths. The repository root is noise
         in a CI log and an accident waiting to happen in a public one, so it is
         reduced to the same repository-relative vocabulary as everything else
         this script prints. */
      faults.push(`${relativePath} ${error.message.split("\n")[0].split(`${REPO_ROOT}/`).join("")}`);
      continue;
    }
    loaded += 1;

    if (!functions.includes(absolutePath)) continue;

    for (const fault of entryPointFaults(module)) faults.push(`${relativePath} ${fault}`);

    const path = module.config?.path;
    if (typeof path === "string") {
      const owner = routes.get(path);
      if (owner !== undefined) faults.push(`${relativePath} claims ${path}, already claimed by ${owner}`);
      else routes.set(path, relativePath);
    }
  }

  if (faults.length > 0) {
    for (const fault of faults) process.stderr.write(`FAIL hosted modules: ${fault}\n`);
    return 1;
  }

  process.stdout.write(
    `PASS hosted modules: ${loaded} modules load and link (${functions.length} routed functions)\n`,
  );
  return 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  /* A missing directory or an unreadable tree is still a failure of this gate,
     and it reports in the same one-line vocabulary as everything else rather
     than as a stack trace. */
  process.stderr.write(`FAIL hosted modules: ${error.message.split("\n")[0]}\n`);
  process.exitCode = 1;
}
