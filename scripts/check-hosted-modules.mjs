#!/usr/bin/env node
/**
 * Load every module in the hosted deploy tree and prove it links, resolves only
 * where it is allowed to, and presents the entry-point shape Netlify invokes.
 *
 * This is `scripts/check-function-modules.mjs` for the second deployment. The
 * reasoning is the same and so is the output vocabulary, but it cannot be the
 * same script: the two deployments have separate lockfiles, separate dependency
 * sets and separate route prefixes, and the whole point of the hosted boundary
 * is that neither tree can quietly reach into the other.
 *
 * A dynamic `import()` of each module is most of the gate, because ESM resolves
 * and links named imports before it evaluates anything: an unresolvable
 * specifier and a missing named export are both link-time errors. Modules are
 * loaded, never called, so nothing here runs a handler, reads a credential,
 * opens a store or contacts a provider.
 *
 * On top of linking, seven rules hold the boundary. Each exists because a
 * plausible mistake would otherwise deploy:
 *
 *  1. **Nothing resolves outside `hosted/`.** A hosted module that reached into
 *     `netlify/lib/` would link here and 404 in production, because the hosted
 *     deploy carries only this directory - and it would undo the boundary this
 *     build exists to draw, since the legacy tree is where Netlify Identity,
 *     `DOC_OWNERS` and the organisation role defaults live.
 *  2. **Every bare import is a declared runtime dependency, installed under
 *     `hosted/node_modules`.** Node's resolution walks up, so with the root
 *     `npm ci` already run a hosted module can import a root-only package and
 *     link perfectly in CI while failing on a clean hosted install. Checking
 *     where the package actually resolved is what makes "a hosted function cold
 *     starts with nothing but its own `node_modules`" a fact rather than an
 *     artifact of the order of two CI steps.
 *  3. **No deployed module imports a fixture.** `hosted/test/` is test data.
 *     A handler that could import it is one edit away from returning a fake
 *     success, so the import is refused rather than discouraged.
 *  4. **No dynamic `import(`, anywhere in the tree.** The rules above are exact
 *     for a static import, because the resolver observes every one of them at
 *     link time. A dynamic import inside a function body is never evaluated by
 *     this gate and would therefore be invisible to all three - and a scanner
 *     cannot save us, since the specifier can be a template literal or a
 *     computed expression. Banning the construct outright is the only rule that
 *     actually holds, so this one is enforced on raw source and applies even
 *     inside a comment. It is lexical rather than a text search, because
 *     `import` and `(` are two tokens and JavaScript lets a comment sit between
 *     them: a whitespace-only pattern reads `import/*x*\/("...")` as prose.
 *     Hosted deploy modules have no need for one; write "dynamic import" in
 *     prose if you must mention it.
 *  5. **The deploy tree is explicit ESM: `.mjs` only.** Rules 1 to 3 are read
 *     off an ESM `resolve` hook, and Node never consults that hook for a
 *     CommonJS `require()`. A `hosted/lib/*.cjs` that required
 *     `netlify/lib/*.cjs` therefore linked, loaded and reported PASS with the
 *     boundary rules simply not applied - the exact escape rule 1 exists to
 *     stop, reached by changing a letter in a filename. `.js` is refused with
 *     it, because its module system is decided by the nearest `package.json`
 *     rather than by the file, and that manifest is not something this gate
 *     reads. Refusing both by extension keeps the rule where a reviewer can see
 *     it, in the filename.
 *  6. **No hosted module acquires a CommonJS `require`.** Rule 5 stops a
 *     `.cjs` file; it does not stop an allowed `.mjs` one from importing
 *     `createRequire` out of `node:module` and requiring
 *     `../../netlify/lib/legacy.cjs` through it. That is the same escape by a
 *     different door, so this rule shuts all three of them. Builtin imports are
 *     an allowlist, which refuses `node:module` and fails closed for every
 *     builtin nobody has argued for yet. The two names that hand out a builtin
 *     namespace without going through the resolver at all - `createRequire`
 *     itself and `process.getBuiltinModule` - are refused lexically, like rule
 *     4 and for the same reason: an acquisition inside a function body the gate
 *     never calls is invisible to any hook. The lexical half reads the source
 *     twice, once as written and once with `\uXXXX` and `\u{...}` escapes
 *     decoded, because JavaScript lets an identifier be spelled in escapes:
 *     `create\u0052equire` and `process.getBuiltin\u004dodule` are the same two
 *     names to the parser and were different text to a raw scan. And the hook
 *     is synchronous, so a `require()` that does execute is journaled and
 *     judged by rules 1 to 3 like any other edge.
 *  7. **The capability boundary covers everything the hosted tree loads, not
 *     just the files in it.** Rules 4 and 6 read first-party source, so they
 *     say nothing about a declared dependency that imports `createRequire`
 *     itself and re-exports it under an innocuous name for a hosted handler to
 *     call from a body this gate never invokes: no hosted file spells a banned
 *     name and no require executes here, so every rule above passed it. What
 *     does execute is the dependency's own top-level `import ... from
 *     "node:module"`, at the moment the hosted module links against it, and
 *     that resolution is a fact the hook already sees. So every module reached
 *     transitively from a hosted module is judged too - narrowly, on the one
 *     capability rather than on its internals: it may not resolve
 *     `node:module`, and it may not resolve a file outside `hosted/`. The
 *     second door, `process.getBuiltinModule`, goes through no resolver at all,
 *     so it is closed by capability rather than by text: the function is
 *     wrapped for the duration of the load and a request for `node:module`
 *     records a fault whoever makes it and however the call is spelled.
 *
 * The import graph comes from a `module.registerHooks` resolution hook that
 * records what Node actually resolved. An earlier version of this gate scanned
 * the source text instead, and got it wrong in both directions: a regular
 * expression has no state for regex literals, so `/\/\//` made the scanner
 * treat the rest of the line as a comment and drop a real import, while
 * `/["']/` flipped it into string state and turned a sentence in a doc comment
 * into a phantom specifier. Asking the resolver is exact by construction.
 *
 * The hook is the synchronous kind rather than the `register()` kind on
 * purpose. Asynchronous hooks run on their own thread and are consulted only
 * for ESM, so a `require()` edge never reached them and the boundary rules
 * simply did not apply to it; synchronous hooks run in-thread and see both
 * module systems, which is what makes rule 6's third door a fault rather than a
 * blind spot. They need Node 22.15 or newer; on anything older `registerHooks`
 * is not a function, which the handler at the foot of this file turns into a
 * one-line FAIL. That is the right answer for the runtime *running* this gate
 * and needs no guard of its own - a gate that cannot see the whole graph must
 * not report PASS, and a version check on the interpreter would be a branch no
 * test on a supported Node could reach. What does get a check is the manifest,
 * which is a claim rather than a fact: `hosted/package.json` must not declare
 * an `engines.node` floor below `MECHANISM_SINCE`, or the package advertises a
 * runtime on which the gate can only crash.
 *
 * Where rule 7 stops, stated so nobody has to rediscover it: a dependency that
 * acquires the require capability without resolving or calling anything at load
 * time - constructing the name at runtime inside a function only production
 * invokes - is reached by no load-time gate, because nothing it does happens
 * while this process is watching. That residue is the dependency trust
 * boundary, owned by the lockfile and by review of `hosted/package.json`, which
 * is where adding a package is visible; a package the hosted tree installs
 * already runs its own code at cold start. What rule 7 removes is the part that
 * *was* observable and was being ignored: the resolution edge, and the global
 * call.
 *
 * Functions must also present the shape Netlify invokes - a callable default
 * export and a `config` object - and must be routed under `/api/hosted/`,
 * keeping the hosted API in one namespace that operator routing and rate-limit
 * rules can name. A `config.path` may be an array, and every entry is checked.
 *
 * Finding no functions is not a failure while AHU-001 ships the shell alone;
 * finding no modules at all is, and so is a `hosted/functions/` directory that
 * exists but is empty. A gate that scans an empty tree and reports success is
 * inventing the one answer it must never invent, and scoping that guard to the
 * whole tree rather than to each directory once let a module moved out of
 * `functions/` lose every entry-point and route check while the gate kept
 * printing PASS.
 *
 * Output contract: one `PASS` line on stdout and exit 0, or one
 * `FAIL hosted modules:` line per fault on stderr and exit 1. Every module is
 * attempted before the process exits, so one broken import does not hide the
 * next.
 *
 *   node scripts/check-hosted-modules.mjs
 *   node scripts/check-hosted-modules.mjs --root <dir>   # for this gate's own tests
 *
 * `--root` points the scan at another checkout-shaped directory. It exists so
 * `scripts/check-hosted-modules.test.mjs` can plant a fault and prove this gate
 * fails - an untested gate is the one kind of code whose failure is permanently
 * silent. It narrows nothing and skips nothing: CI passes no flag.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, derived from this file's own location. */
const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The hosted deploy root, relative to whichever checkout is being scanned. */
const HOSTED = "hosted";

/** Directories inside the hosted root that carry deployable modules. */
const DEPLOY_DIRECTORIES = Object.freeze(["lib", "functions"]);

/** Test data. Never scanned; never importable from anything that deploys. */
const FIXTURE_DIRECTORY = "test";

/** Static assets. Served as committed and never imported by a function. */
const ASSET_DIRECTORY = "public";

/** The path prefix every hosted HTTP function is routed under. */
const ROUTED_PREFIX = "/api/hosted/";

/** The one source extension a hosted deploy directory may carry. */
const LOADABLE = ".mjs";

/**
 * Every other source extension, refused inside a deploy directory, with the
 * reason each one is refused. This is rule 5: the tree is explicit ESM.
 *
 * `.cjs` is the load-bearing entry. The gate reasons about the import graph
 * through an ESM `resolve` hook, and that hook is never consulted for a
 * CommonJS `require()`, so a `.cjs` module reaching into `netlify/lib/` linked
 * cleanly and the gate printed PASS - rules 1 to 3 silently did not apply to
 * it. `.js` is refused for the same reason one step removed: whether it is ESM
 * or CommonJS is decided by the nearest `package.json`, which is a file this
 * gate does not police, so the same `require()` graph can hide behind it.
 * Refusing both by extension keeps the rule local to the filename, which is the
 * only form of it that cannot be undone from somewhere else in the tree.
 */
const REFUSED = Object.freeze({
  ".cjs": "a CommonJS require() graph is invisible to the ESM resolution hook that enforces the boundary",
  ".js": "whether a .js file is ESM or CommonJS depends on the nearest package.json, so a require() graph can hide behind it",
  ".jsx": "JSX is not JavaScript this gate can load",
  ".ts": "TypeScript is not JavaScript this gate can load",
  ".mts": "TypeScript is not JavaScript this gate can load",
  ".cts": "TypeScript is not JavaScript this gate can load",
  ".tsx": "TypeScript is not JavaScript this gate can load",
});

/**
 * The Node builtins a hosted deploy module may import. An allowlist rather than
 * a denylist, so a builtin nobody has argued for is refused rather than
 * silently permitted the day Node adds it.
 *
 * `node:module` is the entry that matters and it can never join this list: it
 * exports `createRequire`, and a `require` built from it resolves CommonJS,
 * which is how an allowed `.mjs` file reached `netlify/lib/legacy.cjs` while
 * this gate printed PASS. The rest of the list is what the hosted tree actually
 * imports plus the neighbours a handler would reach for; adding one is a
 * deliberate edit a reviewer can see, which is the whole point of the shape.
 */
const ALLOWED_BUILTINS = Object.freeze(["node:buffer", "node:crypto", "node:url", "node:util"]);

/**
 * Identifiers that hand out a builtin namespace without the resolver seeing it,
 * refused lexically wherever they are spelled.
 *
 * `createRequire` is the function that turns an ESM module into a CommonJS
 * requirer, and `process.getBuiltinModule` fetches `node:module` off a global
 * with no import at all - so the builtin allowlist above, which reads
 * resolutions, cannot see the second one coming. Both are refused on raw source
 * for rule 4's reason: an acquisition inside a function body this gate never
 * calls is observed by no hook, synchronous or otherwise.
 *
 * `process.binding` is not here. It is deprecated, restricted to a handful of
 * internal tables, and none of them yields a `require`; banning the word
 * `binding` would fail builds over ordinary prose, which is the failure mode
 * the text-scanning version of this gate was replaced for.
 */
const REQUIRE_ESCAPES = Object.freeze(["createRequire", "getBuiltinModule"]);

/**
 * The builtins that hand out a CommonJS `require`, refused to every module the
 * hosted tree loads - first-party or dependency.
 *
 * This is the dependency half of rule 7, and it is deliberately one entry
 * rather than the allowlist above. A dependency's own use of `node:fs` or
 * `node:stream` is its business and policing it would be a boundary this gate
 * cannot honestly hold; `node:module` is the single capability whose whole
 * purpose is to reach a module system this gate cannot see.
 */
const REQUIRE_GRANTING_BUILTINS = Object.freeze(["node:module"]);

/**
 * The oldest Node that provides `module.registerHooks`, and therefore the
 * oldest runtime on which this gate can see the whole import graph.
 *
 * Synchronous hooks landed in 22.15.0. On anything older `registerHooks` is not
 * a function and this gate fails loudly, which is the right answer - but a
 * manifest that *permits* such a runtime is a claim the deploy does not keep,
 * and the failure would surface as a mysterious gate crash on a Node the
 * package said was supported. So the floor is checked rather than assumed, and
 * `hosted/package.json` is where the claim lives.
 */
const MECHANISM_SINCE = "22.15.0";

/** Extensions the placement and shape rules apply to at all. */
const SCANNED = Object.freeze([LOADABLE, ...Object.keys(REFUSED)]);

/**
 * Whether `candidate` is inside `root`.
 *
 * Both sides are resolved through the filesystem where they exist, because a
 * checkout reached through a symlinked parent would otherwise compare a
 * resolved root against an unresolved candidate and report a perfectly ordinary
 * import as an escape. A non-existent candidate is compared as written, which
 * is correct: an import that resolves nowhere is a link error, reported as one.
 *
 * The containment test uses `path.relative` rather than a string prefix, so
 * `hosted-other/` is not mistaken for a child of `hosted/`.
 */
function isInside(root, candidate) {
  const realRoot = existsSync(root) ? realpathSync(root) : root;
  const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (real === realRoot) return true;
  const rel = relative(realRoot, real);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep);
}

/** The package name a bare specifier belongs to, scoped names included. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Whether a specifier addresses a path rather than a package. */
function isRelative(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

/**
 * The index of the next thing after `index` that is not between-token filler.
 *
 * JavaScript allows whitespace *and* both comment forms wherever it allows a
 * space, so `import` and its `(` may legally be separated by either. The
 * pattern is sticky so it consumes filler from exactly `index` onward, and
 * every alternative is optional, so it always matches - possibly emptily, when
 * the next character is already real code. An unterminated comment matches no
 * alternative and simply ends the run at its opening slash, which is not a `(`
 * either way, so there is no separate case for it.
 *
 * A line comment ends at any of the four ECMAScript LineTerminators - LF, CR,
 * U+2028 and U+2029 - not at LF alone. Stopping only at LF is a bypass rather
 * than a rounding error: `import//x\r("../../netlify/lib/identity.mjs")` is a
 * dynamic import that JavaScript accepts and a LF-only run would swallow whole,
 * ending the filler at end of source and finding no `(`. The terminator is left
 * unconsumed here; the `\s+` alternative takes it on the next pass, since all
 * four are whitespace to `\s`.
 */
function afterTrivia(source, index) {
  const filler = /(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n\r\u2028\u2029]*)*/y;
  filler.lastIndex = index;
  filler.exec(source);
  return filler.lastIndex;
}

/** A character that can continue an identifier, so `reimport` is not `import`. */
const IDENTIFIER_PART = /[\p{ID_Continue}$\u200C\u200D]/u;

/**
 * Whether the raw source spells a dynamic `import(` anywhere.
 *
 * This is rule 4, and it is deliberately lexical rather than syntactic: it runs
 * on raw source including strings and comments, because an over-approximation
 * fails closed and a scanner that understood string context could be fed the
 * construct through a template literal. What it does understand is the one
 * thing a text search got wrong - `import` and `(` are separate tokens, so
 * a comment between them is the same dynamic import as `import(`, and a
 * whitespace-only text search let that spelling through into a function body
 * the resolution hook never observes.
 */
function usesDynamicImport(source) {
  const token = "import";
  let from = 0;
  for (;;) {
    const at = source.indexOf(token, from);
    if (at === -1) return false;
    from = at + token.length;
    const before = source[at - 1];
    if (before !== undefined && IDENTIFIER_PART.test(before)) continue;
    if (source[afterTrivia(source, from)] === "(") return true;
  }
}

/**
 * `source` with every `\uXXXX` and `\u{...}` escape replaced by the character it
 * denotes, or `null` when the source spells none.
 *
 * JavaScript allows an identifier to be written in escapes, so
 * `create\u0052equire` and `process.getBuiltin\u004dodule` are the two banned
 * names to the parser while being different text to a raw scan - a bypass of
 * rules 4 and 6 that costs one backslash. Decoding first and scanning the
 * result gives the scans the parser's spelling of every identifier without
 * either of them learning anything about escapes.
 *
 * The decode is as over-approximate as the scans it feeds: it runs on strings
 * and comments too, and it does not track whether a backslash was itself
 * escaped, so the literal text `\\u0052equire` decodes to a hit. That fails
 * closed, which is the direction this gate is wrong in everywhere else, and the
 * cost in a tree this size is a sentence rewritten.
 */
function decodeEscapes(source) {
  if (!source.includes("\\u")) return null;
  const decoded = source.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (whole, braced, plain) => {
    const code = Number.parseInt(braced ?? plain, 16);
    return code > 0x10ffff ? whole : String.fromCodePoint(code);
  });
  return decoded === source ? null : decoded;
}

/** Every spelling of `source` the lexical rules are read against. */
function spellings(source) {
  const decoded = decodeEscapes(source);
  return decoded === null ? [source] : [source, decoded];
}

/**
 * The require-granting names `source` spells, as whole identifiers.
 *
 * Whole identifiers, so a property named `createRequireToken` is not one, and
 * the same over-approximation as rule 4 otherwise: strings and comments count,
 * because a check that respected them could be fed the name through a template
 * literal. Both names are terms of art rather than English, so the cost of the
 * over-approximation in a tree this size is a sentence rewritten in a comment.
 */
function requireEscapes(source) {
  return REQUIRE_ESCAPES.filter((name) => {
    for (let at = source.indexOf(name); at !== -1; at = source.indexOf(name, at + name.length)) {
      const before = source[at - 1];
      const after = source[at + name.length];
      const bounded = (character) => character === undefined || !IDENTIFIER_PART.test(character);
      if (bounded(before) && bounded(after)) return true;
    }
    return false;
  });
}

/**
 * Every file under `directory`, recursively, with symlinks refused rather than
 * followed - a symlink is the obvious way for a scan to walk out of the tree it
 * is confined to, and the hosted deploy has no legitimate use for one.
 */
function filesUnder(directory, faults, repoRoot) {
  if (!existsSync(directory)) return [];
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        faults.push(`${relative(repoRoot, path)} is a symbolic link; the hosted tree carries no symlinks`);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(path);
        continue;
      }
      if (entry.isFile()) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/** A dotted version as numbers, so two of them compare a field at a time. */
function versionParts(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

/** Whether `version` is at or above `floor`, both dotted and numeric. */
function atLeast(version, floor) {
  const left = versionParts(version);
  const right = versionParts(floor);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/**
 * The lowest Node `range` admits, or `null` when the range is not a plain
 * `>=` floor.
 *
 * Anything cleverer than a floor is refused rather than approximated: this gate
 * has one question to ask of the field and no business implementing semver.
 */
function declaredFloor(range) {
  const match = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(String(range ?? "").trim());
  return match === null ? null : match[1];
}

/**
 * The names a deployed hosted module may import from the registry, plus the
 * manifest's claim about the runtime it supports.
 */
function readManifest(hostedRoot, faults) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(hostedRoot, "package.json"), "utf8"));
  } catch (error) {
    faults.push(`${HOSTED}/package.json could not be read: ${error.message.split("\n")[0]}`);
    return new Set();
  }

  const range = manifest.engines?.node;
  const floor = declaredFloor(range);
  if (floor === null) {
    faults.push(
      `${HOSTED}/package.json declares engines.node ${JSON.stringify(range ?? null)}; it must be a \`>=\` floor this gate can compare against ${MECHANISM_SINCE}`,
    );
  } else if (!atLeast(floor, MECHANISM_SINCE)) {
    faults.push(
      `${HOSTED}/package.json permits Node ${floor}, below the ${MECHANISM_SINCE} that provides module.registerHooks; this gate cannot see a require() edge on an older runtime`,
    );
  }
  return new Set(Object.keys(manifest.dependencies ?? {}));
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
    return { faults, paths: [] };
  }
  /* Netlify accepts a single path or an array of them. Flattening an array with
     `String()` produced `"/api/hosted/ok,/admin/secret"`, which starts with the
     routed prefix and so passed - a second route escaping both the namespace
     check and the duplicate-route map. */
  const declared = config.path === undefined ? [] : Array.isArray(config.path) ? config.path : [config.path];
  const paths = [];
  for (const path of declared) {
    if (typeof path !== "string") {
      faults.push(`declares a non-string route ${JSON.stringify(path)}`);
      continue;
    }
    if (!path.startsWith(ROUTED_PREFIX)) {
      faults.push(`is routed at ${path}, outside the ${ROUTED_PREFIX}* hosted API namespace`);
    }
    paths.push(path);
  }
  if (declared.length === 0 && config.schedule === undefined) {
    faults.push("declares neither a path nor a schedule");
  }
  return { faults, paths };
}

/**
 * Every module the hosted tree pulls in, transitively: the first-party modules
 * plus everything reached from one of them, and from one of those.
 *
 * Rule 7 needs this set because the boundary is a property of the graph the
 * deploy loads, not of the files that happen to live in `hosted/`. The fixpoint
 * is cheap - the records are already in memory and a hosted tree's graph is
 * small - and it is a fixpoint rather than one pass because a resolution can be
 * recorded before the record that puts its parent in the set.
 */
function reachableFrom(records, hostedModules) {
  const reached = new Set(hostedModules);
  for (let grew = true; grew; ) {
    grew = false;
    for (const record of records) {
      if (record.parentURL === null || !record.parentURL.startsWith("file:")) continue;
      if (!record.url.startsWith("file:")) continue;
      if (!reached.has(fileURLToPath(record.parentURL))) continue;
      const target = fileURLToPath(record.url);
      if (reached.has(target)) continue;
      reached.add(target);
      grew = true;
    }
  }
  return reached;
}

/**
 * Rule 7 for a module the hosted tree loaded but does not own.
 *
 * A dependency is judged on the capability and on nothing else: it may not
 * reach `node:module`, whose export list is how an ESM module obtains a
 * CommonJS `require`, and it may not resolve a file outside `hosted/`. Its
 * internals are its own business - refusing a dependency's `node:fs` would be a
 * boundary this gate has no standing to hold.
 */
function dependencyFault(record, { hostedRoot, repoRoot }) {
  const { specifier, parentURL, url } = record;
  const from = relative(repoRoot, fileURLToPath(parentURL));
  if (REQUIRE_GRANTING_BUILTINS.includes(url)) {
    return `${from}, loaded by the hosted tree, imports ${url}, which hands out a CommonJS require the hosted boundary cannot see`;
  }
  if (url.startsWith("file:") && !isInside(hostedRoot, fileURLToPath(url))) {
    return `${from}, loaded by the hosted tree, imports ${specifier}, which resolves outside ${HOSTED}/`;
  }
  return null;
}

/**
 * Turn one resolution record into a fault, or nothing.
 *
 * Records whose parent is a hosted deploy module get the full boundary; records
 * from anything else the hosted tree loaded get rule 7's narrow capability
 * check. The gate's own imports are neither, and are not this boundary's
 * business.
 */
function resolutionFault(record, { hostedRoot, hostedModules, reached, fixtureDir, dependencies, repoRoot }) {
  const { specifier, parentURL, url } = record;
  if (parentURL === null || !parentURL.startsWith("file:")) return null;
  const parent = fileURLToPath(parentURL);
  if (!hostedModules.has(parent)) {
    return reached.has(parent) ? dependencyFault(record, { hostedRoot, repoRoot }) : null;
  }

  const from = relative(repoRoot, parent);
  if (url.startsWith("node:")) {
    /* Rule 6, read off a resolution: `node:module` hands out `createRequire`,
       and a require built from it resolves a CommonJS graph. The list is an
       allowlist so an unargued builtin fails closed. */
    return ALLOWED_BUILTINS.includes(url)
      ? null
      : `${from} imports ${url}, which is not one of the builtins the hosted deploy tree may import (${ALLOWED_BUILTINS.join(", ")})`;
  }
  if (!url.startsWith("file:")) {
    return `${from} imports ${specifier}, which resolves to a non-file URL`;
  }

  const target = fileURLToPath(url);
  const inHosted = isInside(hostedRoot, target);
  const inModules = isInside(join(hostedRoot, "node_modules"), target);

  if (inModules) {
    /* A relative path into `node_modules` reaches an installed package while
       looking like a local file, which would sidestep the manifest rule
       entirely. */
    if (isRelative(specifier)) {
      return `${from} imports ${specifier}, reaching node_modules by path instead of by package name`;
    }
    const name = packageOf(specifier);
    return dependencies.has(name)
      ? null
      : `${from} imports ${name}, which is not a dependency in ${HOSTED}/package.json`;
  }

  if (!inHosted) {
    /* The two ways to get here are a relative import that climbs out of the
       tree, and a bare import that resolved to a package installed above it -
       a package a clean hosted install would not produce. */
    return isRelative(specifier)
      ? `${from} imports ${specifier}, which resolves outside ${HOSTED}/`
      : `${from} imports ${packageOf(specifier)}, which resolves outside ${HOSTED}/node_modules; a clean hosted install would not provide it`;
  }

  if (isInside(fixtureDir, target)) {
    return `${from} imports ${specifier} from ${HOSTED}/${FIXTURE_DIRECTORY}/; fixtures must not reach a deployed module`;
  }
  if (!isRelative(specifier)) {
    return `${from} imports ${specifier}, which resolves inside ${HOSTED}/ but is not a relative path`;
  }
  return null;
}

async function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const given = rootFlag === -1 ? DEFAULT_ROOT : argv[rootFlag + 1];
  if (rootFlag !== -1 && (given === undefined || !existsSync(given))) {
    process.stderr.write(`FAIL hosted modules: --root ${given ?? ""} does not exist\n`);
    return 1;
  }
  /* Absolute, always. Every scanned path is derived from this root, while the
     resolution records come back from Node as absolute file URLs, so a relative
     `--root` made the two vocabularies disagree: no scanned module matched its
     own resolution record, every boundary rule quietly judged nothing, and the
     gate reported PASS on a tree it had already read the escape out of. */
  const repoRoot = resolve(given);

  const hostedRoot = join(repoRoot, HOSTED);
  if (!existsSync(hostedRoot)) {
    process.stderr.write(`FAIL hosted modules: ${HOSTED}/ does not exist\n`);
    return 1;
  }

  const faults = [];
  const dependencies = readManifest(hostedRoot, faults);
  const fixtureDir = join(hostedRoot, FIXTURE_DIRECTORY);
  const assetDir = join(hostedRoot, ASSET_DIRECTORY);

  /* Placement first: the whole tree is walked, so a code file outside the two
     deploy directories is reported rather than quietly unscanned. */
  const deployModules = [];
  const functionModules = [];
  for (const path of filesUnder(hostedRoot, faults, repoRoot)) {
    if (isInside(fixtureDir, path) || isInside(assetDir, path)) continue;

    const name = path.slice(path.lastIndexOf(sep) + 1);
    const dot = name.lastIndexOf(".");
    const extension = dot === -1 ? "" : name.slice(dot);
    if (!SCANNED.includes(extension)) continue;

    const shown = relative(repoRoot, path);
    const directory = relative(hostedRoot, path).split(sep)[0];
    if (!DEPLOY_DIRECTORIES.includes(directory)) {
      faults.push(
        `${shown} is deployable code outside ${HOSTED}/{${DEPLOY_DIRECTORIES.join(",")}}/, where nothing checks it`,
      );
      continue;
    }
    if (extension !== LOADABLE) {
      faults.push(`${shown} is ${extension}; the hosted deploy tree is ${LOADABLE} only, because ${REFUSED[extension]}`);
      continue;
    }
    if (/\.test\.mjs$/.test(name)) {
      faults.push(`${shown} is a test file inside a deployed directory; it belongs in ${HOSTED}/${FIXTURE_DIRECTORY}/`);
      continue;
    }

    /* Rules 4 and 6, on raw source including comments. See the header: this is
       the only spelling of either rule that a template literal cannot slip
       past, and the only one that reaches a function body nothing calls. */
    const source = readFileSync(path, "utf8");
    const written = spellings(source);
    if (written.some(usesDynamicImport)) {
      faults.push(`${shown} uses dynamic import; the hosted deploy tree is static imports only`);
    }
    for (const name of new Set(written.flatMap(requireEscapes))) {
      faults.push(`${shown} names ${name}; the hosted deploy tree may not acquire a CommonJS require`);
    }

    deployModules.push(path);
    if (directory === "functions") functionModules.push(path);
  }

  if (deployModules.length === 0) {
    faults.push(`no modules found under ${HOSTED}/{${DEPLOY_DIRECTORIES.join(",")}}/`);
  }
  /* AHU-001 ships no functions at all, which is fine. A `functions/` directory
     that exists and is empty is not: it means the handlers moved somewhere this
     gate does not check. */
  if (existsSync(join(hostedRoot, "functions")) && functionModules.length === 0) {
    faults.push(`${HOSTED}/functions/ exists but contains no loadable module`);
  }

  /* Record what Node resolves, then reason about resolved URLs rather than
     about source text. Synchronous hooks run in-thread and are consulted for
     `require()` as well as `import`, so the records below are the whole graph
     rather than its ESM half. */
  const records = [];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      records.push({ specifier, parentURL: context.parentURL ?? null, url: result.url });
      return result;
    },
  });

  const hostedModules = new Set(deployModules);
  const routes = new Map();
  let loaded = 0;

  /* Rule 7's second door. `process.getBuiltinModule` reaches `node:module` off
     a global, so no resolver is consulted and no import is written down; the
     only thing that can observe it is the function itself. Wrapping it for the
     duration of the load catches the call whoever makes it - a dependency's own
     top level as readily as a hosted module - and whatever the spelling, since
     a computed property name or an escaped identifier still arrives here. It is
     restored afterwards so nothing else in this process inherits it. */
  const original = process.getBuiltinModule;
  const capabilityFaults = [];
  if (typeof original === "function") {
    process.getBuiltinModule = function getBuiltinModule(id) {
      const name = String(id).startsWith("node:") ? String(id) : `node:${String(id)}`;
      if (REQUIRE_GRANTING_BUILTINS.includes(name)) {
        capabilityFaults.push(
          `something the hosted tree loaded called process.getBuiltinModule(${JSON.stringify(id)}), which hands out a CommonJS require the hosted boundary cannot see`,
        );
      }
      return original.call(this, id);
    };
  }

  for (const path of deployModules) {
    const shown = relative(repoRoot, path);
    let module;
    try {
      module = await import(pathToFileURL(path).href);
    } catch (error) {
      /* Node's link errors quote absolute paths. The checkout root is noise in
         a CI log and an accident waiting to happen in a public one, so it is
         reduced to the same relative vocabulary as everything else. */
      faults.push(`${shown} ${error.message.split("\n")[0].split(`${repoRoot}${sep}`).join("")}`);
      continue;
    }
    loaded += 1;

    if (!functionModules.includes(path)) continue;
    const { faults: shapeFaults, paths } = entryPointFaults(module);
    for (const fault of shapeFaults) faults.push(`${shown} ${fault}`);
    for (const route of paths) {
      const owner = routes.get(route);
      if (owner !== undefined) faults.push(`${shown} claims ${route}, already claimed by ${owner}`);
      else routes.set(route, shown);
    }
  }

  if (typeof original === "function") process.getBuiltinModule = original;
  for (const fault of capabilityFaults) faults.push(fault);

  const reached = reachableFrom(records, hostedModules);
  const seen = new Set();
  for (const record of records) {
    /* NUL joins the two halves because neither a URL nor a specifier can
       contain one, so two different pairs can never collide into one key. */
    const key = `${record.parentURL}\u0000${record.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fault = resolutionFault(record, {
      hostedRoot,
      hostedModules,
      reached,
      fixtureDir,
      dependencies,
      repoRoot,
    });
    if (fault !== null) faults.push(fault);
  }

  if (faults.length > 0) {
    for (const fault of faults) process.stderr.write(`FAIL hosted modules: ${fault}\n`);
    return 1;
  }

  process.stdout.write(
    `PASS hosted modules: ${loaded} modules load and link (${functionModules.length} routed functions)\n`,
  );
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  /* A missing directory or an unreadable tree is still a failure of this gate,
     and it reports in the same one-line vocabulary as everything else rather
     than as a stack trace. */
  process.stderr.write(`FAIL hosted modules: ${error.message.split("\n")[0]}\n`);
  process.exitCode = 1;
}
