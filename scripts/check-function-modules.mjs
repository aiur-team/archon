#!/usr/bin/env node
/**
 * Load every deployable server module and prove it links, resolves only where it
 * is allowed to, and presents the entry-point shape Netlify invokes.
 *
 * Nothing in CI imported `netlify/functions/**` or `netlify/lib/**` before this
 * check existed, so a module could name an import that does not resolve, or
 * destructure a named export that its dependency does not emit, and every gate
 * would still go green. That is not hypothetical: PR #104 added
 * `./suggestions.mjs` and `withAccessWriteLease` to `netlify/functions/retention.mjs`
 * while `node -e 'import("./netlify/functions/retention.mjs")'` failed
 * immediately (#107).
 *
 * A dynamic `import()` is most of the gate, because ESM resolves and links named
 * imports before it evaluates anything: an unresolvable specifier and a missing
 * named export are both link-time errors, which is exactly the class of failure
 * that was shipping. Modules are loaded, never called, so no handler runs and
 * nothing here reads a credential, opens a store, or contacts a remote service.
 *
 * This runs against a plain checkout on purpose, before anything compiles, because
 * that is the shape of a deploy: the P4-S connect tool copies only `netlify/`,
 * `netlify.toml`, `package.json` and `package-lock.json`. A module that links only
 * on a machine where some other tree happens to have been built does not link in
 * production. `scripts/vendor-netlify-lib.mjs` is the static counterpart, refusing
 * any relative import under `netlify/` that resolves outside it; this gate is the
 * dynamic one, and catches what a specifier alone cannot say.
 *
 * ## One tree, two contracts
 *
 * ACN-003 folded the second deployment into this one. `netlify/lib/hosted/` and
 * `netlify/functions/hosted-*.mjs` are the hosted publishing application; the rest
 * of `netlify/` is the collaboration deployment. They share a manifest, a lockfile
 * and this gate, and they do not share a boundary: the hosted tree was built to be
 * unable to reach Netlify Identity, `DOC_OWNERS` and the organisation role
 * defaults, which live in `netlify/lib/access.mjs` and `netlify/lib/identity.mjs`
 * one directory up.
 *
 * So the rules below come in two scopes, and the distinction is load-bearing
 * rather than tidy. Whole-tree rules hold for every deployed module. Hosted-scoped
 * rules are the retired hosted gate's, enforced over exactly the files they
 * governed before the move and at the strength they had — scoped rather than
 * widened, because widening one would fail correct collaboration code that predates
 * the hosted boundary and was never asked to keep it. `netlify/lib/store.mjs`
 * imports `node:fs`, which the hosted builtin allowlist refuses;
 * `netlify/lib/notify.test.mjs` sits beside its source, which the hosted placement
 * rule refuses. Neither is a defect, and a merged gate that reported them as ones
 * would be turned off within a week.
 *
 * Two of those rules had to be *restated* rather than copied, because the move
 * changed what their old wording meant rather than where it applied — H0 and H0b
 * below. Both are the same barrier addressed to the same code; copying either one
 * verbatim would have retired it silently, which is the precise failure this whole
 * file exists to make impossible. Membership in the hosted set is therefore
 * fail-closed too: `looksHosted` refuses a path that reads as hosted code and is
 * not in the set, because a rule that only applies to files it recognises is a rule
 * a rename turns off.
 *
 * ### Whole-tree rules
 *
 *  W1. **Nothing relative resolves outside `netlify/`.** Netlify's esbuild bundler
 *      follows a relative import anywhere in the checked-out repository, so a
 *      module that reached outside the deploy tree would be bundled and would
 *      deploy while the connect tool copied none of it (#117).
 *  W2. **Every bare import is a declared runtime dependency.** One manifest and
 *      one lockfile travel with the deploy tree, so a package the root
 *      `package.json` does not declare is one a deploy's `npm ci` never installs.
 *      `netlify/lib/hosted/contracts.mjs` imports `tldts` and would link on a
 *      developer machine that happened to have it hoisted.
 *  W3. **No deployed module imports a fixture.** `netlify/test/` is test data. A
 *      handler that could import it is one edit away from returning a fake
 *      success, so the import is refused rather than discouraged.
 *  W4. **The deploy directories are explicit ESM: `.mjs` only.** The boundary
 *      rules are read off an ESM `resolve` hook, and Node never consults that hook
 *      for a CommonJS `require()`, so a `.cjs` module reaching outside the tree
 *      linked cleanly with rules W1 to W3 silently not applied. `.js` is refused
 *      with it, because its module system is decided by the nearest `package.json`
 *      rather than by the file.
 *  W5. **Functions present the entry point Netlify invokes** — a callable default
 *      export and a `config` object — and every declared route is either an
 *      `/api/*` address, because `netlify.toml` excludes exactly `/api/*` from the
 *      edge gate, or a member of the closed `ALLOWED_PAGE_ROUTES` list.
 *  W6. **No two functions claim the same route**, whether `config.path` is a
 *      string or an array of them.
 *
 * ### Hosted-scoped rules
 *
 *  H0. **Nothing first-party under the hosted subtree resolves outside it.** This
 *      is the rule the merge would have dissolved by itself, and it was the old
 *      gate's "sole barrier". Under two trees it read "nothing under `hosted/`
 *      resolves outside `hosted/`", and containment against the deploy root said
 *      the same thing. It does not any more: `netlify/lib/access.mjs` and
 *      `netlify/lib/identity.mjs` - Netlify Identity, `DOC_OWNERS`, the
 *      organisation role defaults - are now *inside* the deploy tree and one
 *      relative segment away, so `import { DOC_OWNERS } from "../access.mjs"` in a
 *      hosted handler passes W1 and deploys. So the barrier is restated against the
 *      hosted subtree: a hosted module's relative imports must land in
 *      `netlify/lib/hosted/` or on another `netlify/functions/hosted-*.mjs`.
 *      Membership is fail-closed - see `looksHosted` - because a rule that only
 *      applies to files it recognises is a rule a rename turns off.
 *  H0b. **A hosted bare import is one of `HOSTED_DEPENDENCIES`.** One manifest is
 *      the union of two dependency sets, and the union contains
 *      `@netlify/identity`. Root-declared is necessary and not sufficient.
 *  H1. **No dynamic `import(`.** The rules above are exact for a static import,
 *      because the resolver observes every one of them at link time. A dynamic
 *      import inside a function body is never evaluated by this gate and would
 *      therefore be invisible to all of them - and a scanner cannot save us, since
 *      the specifier can be a template literal or a computed expression. Banning
 *      the construct outright is the only rule that actually holds, so this one is
 *      enforced on raw source and applies even inside a comment. It is lexical
 *      rather than a text search, because `import` and `(` are two tokens and
 *      JavaScript lets a comment sit between them: a whitespace-only pattern reads
 *      `import/*x*\/("...")` as prose. Hosted deploy modules have no need for one;
 *      write "dynamic import" in prose if you must mention it.
 *  H2. **No hosted module acquires a CommonJS `require`.** W4 stops a `.cjs` file;
 *      it does not stop an allowed `.mjs` one from importing `createRequire` out of
 *      `node:module` and requiring `../../access.mjs` through it. Builtin imports
 *      are therefore an allowlist, which refuses `node:module` and fails closed for
 *      every builtin nobody has argued for yet. The two names that hand out a
 *      builtin namespace without going through the resolver at all -
 *      `createRequire` itself and `process.getBuiltinModule` - are refused
 *      lexically, like H1 and for the same reason. The lexical half reads the
 *      source twice, once as written and once with `\uXXXX` and `\u{...}` escapes
 *      decoded, because JavaScript lets an identifier be spelled in escapes:
 *      `createRequire` and `process.getBuiltinModule` are the same two
 *      names to the parser and were different text to a raw scan.
 *  H3. **The capability boundary covers everything the hosted tree loads, not just
 *      the files in it.** H1 and H2 read first-party source, so they say nothing
 *      about a declared dependency that imports `createRequire` itself and
 *      re-exports it under an innocuous name for a hosted handler to call from a
 *      body this gate never invokes. What does execute is the dependency's own
 *      top-level `import ... from "node:module"`, at the moment the hosted module
 *      links against it, and that resolution is a fact the hook already sees. So
 *      every module reached transitively from a hosted module is judged too -
 *      narrowly, on the one capability rather than on its internals: it may not
 *      resolve `node:module`, and it may not resolve a first-party file outside
 *      the deploy tree. The second door, `process.getBuiltinModule`, goes through
 *      no resolver at all, so it is closed by capability rather than by text: the
 *      function is wrapped for the duration of the load and a request for
 *      `node:module` records a fault whoever makes it and however it is spelled.
 *  H4. **Hosted routes live under `/api/hosted/`**, keeping the hosted API in one
 *      namespace that operator routing and rate-limit rules can name, with
 *      `ALLOWED_PAGE_ROUTES` as the one exception.
 *  H5. **No test file inside a hosted deploy directory.** A deployed module that
 *      can import a fixture is one edit away from returning a fake success, and
 *      Netlify would publish `netlify/functions/hosted-*.test.mjs` as a live route.
 *      The hosted suites live in `netlify/test/hosted/` for that reason.
 *
 * Read every lexical rule as "this cannot happen by accident or in passing", never
 * as "this cannot happen": they do not stop a determined author inside the tree,
 * who has `eval`, `new Function` and any number of computed names, nor a hostile
 * declared dependency. Those are stopped by review of the diff and of the lockfile.
 * Where H3 stops, stated so nobody has to rediscover it: a dependency that acquires
 * the require capability without resolving or calling anything at load time is
 * reached by no load-time gate, because nothing it does happens while this process
 * is watching. That residue is the dependency trust boundary, owned by the lockfile
 * and by review of `package.json`.
 *
 * The import graph comes from a `module.registerHooks` resolution hook that records
 * what Node actually resolved. An earlier version of the hosted gate scanned the
 * source text instead, and got it wrong in both directions: a regular expression has
 * no state for regex literals, so `/\/\//` made the scanner treat the rest of the
 * line as a comment and drop a real import, while `/["']/` flipped it into string
 * state and turned a sentence in a doc comment into a phantom specifier. Asking the
 * resolver is exact by construction. The hook is the synchronous kind rather than
 * the `register()` kind on purpose: asynchronous hooks run on their own thread and
 * are consulted only for ESM, so a `require()` edge never reached them. Synchronous
 * hooks need Node 22.15 or newer; on anything older `registerHooks` is not a
 * function, which the handler at the foot of this file turns into a one-line FAIL.
 * What gets a check of its own is the manifest, which is a claim rather than a fact:
 * `package.json` must not declare an `engines.node` floor below `MECHANISM_SINCE`,
 * or the package advertises a runtime on which the gate can only crash.
 *
 * Output contract: one `PASS` line on stdout and exit 0, or one
 * `FAIL netlify modules:` line per fault on stderr and exit 1. Every module is
 * attempted before the process exits, so one unresolvable import does not hide the
 * next. A failure that matches a live entry in `ALLOWED_LOAD_FAILURES` prints one
 * `ALLOW netlify modules:` line and does not change the exit code; any other
 * failure in the same module still fails.
 *
 *   node scripts/check-function-modules.mjs
 *   node scripts/check-function-modules.mjs --root <dir>   # for this gate's own tests
 *
 * `--root` points the scan at another checkout-shaped directory. It exists so
 * `scripts/check-hosted-modules.test.mjs` can plant a fault and prove this gate
 * fails - an untested gate is the one kind of code whose failure is permanently
 * silent. It narrows nothing and skips nothing: CI passes no flag.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The repository root, derived from this file's own location. */
const DEFAULT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The deploy tree: exactly what the P4-S connect tool copies, minus config. */
const DEPLOY = "netlify";

/** Directories inside the deploy tree that carry loadable Node modules. */
const DEPLOY_DIRECTORIES = Object.freeze(["lib", "functions"]);

/** Test data. Never scanned; never importable from anything that deploys. */
const FIXTURE_DIRECTORY = "test";

/** Static assets. Served as committed and never imported by a function. */
const ASSET_DIRECTORY = "public";

/**
 * The edge function, which is Deno TypeScript rather than Node JavaScript.
 *
 * It cannot be imported by this process at all, and `scripts/test-access-row.mjs`
 * is what drives it - transpiled with the TypeScript the typecheck step installs.
 * Naming it here rather than letting the placement rule below trip over it keeps
 * the exclusion visible instead of implicit in an extension list.
 */
const EDGE_DIRECTORY = "edge-functions";

/**
 * The one extension the edge directory may carry.
 *
 * The exclusion above is for `gate.ts` and nothing else. Skipping the directory
 * wholesale would let a `.mjs` handler sit there unscanned and unloaded, which is
 * the "deployable code where nothing checks it" hole the placement rule exists to
 * close - so the exclusion is by extension, and anything else there is a fault.
 */
const EDGE_EXTENSION = ".ts";

/** Directories under the deploy tree that carry no loadable Node module at all. */
const UNSCANNED_DIRECTORIES = Object.freeze([FIXTURE_DIRECTORY, ASSET_DIRECTORY]);

/** Where the hosted publishing application's libraries live, under the deploy tree. */
const HOSTED_LIB = `lib/hosted`;

/** What every hosted function file is named, so a basename cannot collide. */
const HOSTED_FUNCTION_PREFIX = "hosted-";

/**
 * The packages a *hosted* deploy module may import.
 *
 * The old `hosted/package.json` declared exactly these two, and "every bare import
 * is a declared hosted dependency" was rule 2. One merged manifest would have
 * quietly widened that to the union: the root manifest also declares
 * `@netlify/identity`, which is the legacy authority the hosted boundary exists to
 * keep out, and `import { ... } from "@netlify/identity"` inside a hosted handler
 * would have linked and deployed. So the hosted subset stays a list here, where
 * adding to it is a deliberate edit a reviewer can see, on top of the whole-tree
 * rule that every bare import be root-declared.
 */
const HOSTED_DEPENDENCIES = Object.freeze(["@netlify/blobs", "jose", "tldts"]);

/** The path prefix `netlify.toml` excludes from the edge gate. */
const ROUTED_PREFIX = "/api/";

/** The path prefix every hosted HTTP *API* function is routed under. */
const HOSTED_ROUTED_PREFIX = "/api/hosted/";

/**
 * The closed set of non-API page routes a function may serve.
 *
 * The namespace rule above exists so that operator routing and per-route rate
 * limits have one prefix to name, and it is the right rule for every endpoint that
 * returns a JSON envelope. It is the wrong rule for exactly one thing: the stable,
 * human-typed address of a document. `/docs/<id>` is printed in a CLI receipt,
 * saved in a browser's history and pasted between machines, and
 * `netlify/lib/hosted/contracts.mjs` freezes it as `DOCUMENT_PATH_PREFIX` -- it is
 * part of C1's destination grammar, not a URL this deployment is free to move
 * under a prefix.
 *
 * So it is an allowlist of exact strings rather than a second prefix. A prefix such
 * as `/docs/` would let any future `/docs/anything` route appear with no review; a
 * literal means a new page route is a diff in this file, next to this paragraph,
 * which is the only place the reasoning above is written down.
 */
const ALLOWED_PAGE_ROUTES = Object.freeze(["/docs/:documentId"]);

/** The one source extension a deploy directory may carry. */
const LOADABLE = ".mjs";

/**
 * Every other source extension, refused inside a deploy directory, with the reason
 * each one is refused. This is rule W4: the tree is explicit ESM.
 *
 * `.cjs` is the load-bearing entry. The gate reasons about the import graph through
 * an ESM `resolve` hook, and that hook is never consulted for a CommonJS
 * `require()`, so a `.cjs` module reaching outside the deploy tree linked cleanly
 * and the gate printed PASS - the boundary rules silently did not apply to it.
 * `.js` is refused for the same reason one step removed: whether it is ESM or
 * CommonJS is decided by the nearest `package.json`, which is a file this gate does
 * not police, so the same `require()` graph can hide behind it. Refusing both by
 * extension keeps the rule local to the filename, which is the only form of it that
 * cannot be undone from somewhere else in the tree.
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
 * The Node builtins a *hosted* deploy module may import. An allowlist rather than a
 * denylist, so a builtin nobody has argued for is refused rather than silently
 * permitted the day Node adds it.
 *
 * `node:module` is the entry that matters and it can never join this list: it
 * exports `createRequire`, and a `require` built from it resolves CommonJS, which is
 * how an allowed `.mjs` file reached a legacy `.cjs` module while this gate printed
 * PASS. The rest of the list is what the hosted tree actually imports plus the
 * neighbours a handler would reach for; adding one is a deliberate edit a reviewer
 * can see, which is the whole point of the shape.
 *
 * The collaboration half of the deploy tree is not held to it. Those modules import
 * `node:fs`, `node:path` and `node:util/types` and were written years before this
 * boundary existed; refusing them here would say nothing true about the hosted
 * boundary and would only teach a reader to widen the list.
 */
const ALLOWED_BUILTINS = Object.freeze(["node:buffer", "node:crypto", "node:url", "node:util"]);

/**
 * Identifiers that hand out a builtin namespace without the resolver seeing it,
 * refused lexically wherever the hosted tree spells them.
 *
 * `createRequire` is the function that turns an ESM module into a CommonJS
 * requirer, and `process.getBuiltinModule` fetches `node:module` off a global with
 * no import at all - so the builtin allowlist above, which reads resolutions,
 * cannot see the second one coming. Both are refused on raw source for H1's reason:
 * an acquisition inside a function body this gate never calls is observed by no
 * hook, synchronous or otherwise.
 *
 * `process.binding` is not here. It is deprecated, restricted to a handful of
 * internal tables, and none of them yields a `require`; banning the word `binding`
 * would fail builds over ordinary prose, which is the failure mode the
 * text-scanning version of this gate was replaced for.
 */
const REQUIRE_ESCAPES = Object.freeze(["createRequire", "getBuiltinModule"]);

/**
 * The builtins that hand out a CommonJS `require`, refused to every module the
 * hosted tree loads - first-party or dependency.
 *
 * This is the dependency half of H3, and it is deliberately one entry rather than
 * the allowlist above. A dependency's own use of `node:fs` or `node:stream` is its
 * business and policing it would be a boundary this gate cannot honestly hold;
 * `node:module` is the single capability whose whole purpose is to reach a module
 * system this gate cannot see.
 */
const REQUIRE_GRANTING_BUILTINS = Object.freeze(["node:module"]);

/**
 * The oldest Node that provides `module.registerHooks`, and therefore the oldest
 * runtime on which this gate can see the whole import graph.
 *
 * Synchronous hooks landed in 22.15.0. On anything older `registerHooks` is not a
 * function and this gate fails loudly, which is the right answer - but a manifest
 * that *permits* such a runtime is a claim the deploy does not keep, and the failure
 * would surface as a mysterious gate crash on a Node the package said was
 * supported. So the floor is checked rather than assumed, and `package.json` is
 * where the claim lives.
 */
const MECHANISM_SINCE = "22.15.0";

/** Extensions the placement and shape rules apply to at all. */
const SCANNED = Object.freeze([LOADABLE, ...Object.keys(REFUSED)]);

/**
 * Load failures this gate reports without failing on, each naming the issue that
 * removes it and the date it was granted.
 *
 * Empty, and meant to stay that way. The one entry this table was created with
 * covered `netlify/functions/edit.mjs` importing gitignored docbuild build output;
 * #117 vendored those modules into `netlify/lib/`, the module links, and the
 * allowance went stale exactly as it was designed to.
 *
 * An allowance is a hole held open on a promise. Add one only with the issue that
 * closes it, and expect this gate to fail the moment the entry stops describing
 * real code.
 */
const ALLOWED_LOAD_FAILURES = new Map([]);

/**
 * Whether an allowance still describes the code it was granted for. A stale entry
 * is a hole left open in a gate, so this is checked on every run rather than left
 * to whoever lands the fix to remember.
 */
function allowanceApplies(repoRoot, modulePath, allowance) {
  try {
    return allowance.whileSourceMatches.test(readFileSync(join(repoRoot, modulePath), "utf8"));
  } catch {
    /* The module named by an allowance is gone. The entry is stale either way. */
    return false;
  }
}

/**
 * Whether `candidate` is inside `root`.
 *
 * Both sides are resolved through the filesystem where they exist, because a
 * checkout reached through a symlinked parent would otherwise compare a resolved
 * root against an unresolved candidate and report a perfectly ordinary import as an
 * escape. A non-existent candidate is compared as written, which is correct: an
 * import that resolves nowhere is a link error, reported as one.
 *
 * The containment test uses `path.relative` rather than a string prefix, so
 * `netlify-other/` is not mistaken for a child of `netlify/`.
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
 * Whether a deploy module belongs to the hosted publishing application.
 *
 * Two shapes rather than one directory, because the move that merged the trees had
 * to keep thirteen function basenames from colliding with a collaboration function
 * of the same name - `session.mjs` claimed two different routes in the two trees -
 * and prefixing the files was the way to do that without renaming a route.
 */
function isHosted(deployRoot, path) {
  const rel = relative(deployRoot, path).split(sep).join("/");
  if (rel.startsWith(`${HOSTED_LIB}/`)) return true;
  return rel.startsWith(`functions/${HOSTED_FUNCTION_PREFIX}`);
}

/**
 * Whether a deploy path *reads* as hosted code without being in the hosted set.
 *
 * `isHosted` is a membership test over two exact shapes, so anything that looks
 * hosted and matches neither silently loses every hosted rule while still
 * deploying as a hosted route. Two spellings do it without trying:
 * `netlify/functions/hosted/publish.mjs` (a directory Netlify accepts, and
 * `"functions/hosted/"` is not `"functions/hosted-"`) and
 * `netlify/lib/hosted-helper.mjs` (beside the hosted tree rather than inside it).
 * Neither is exotic - both are what a tidying refactor produces.
 *
 * So membership fails closed: a path that carries a `hosted` segment or a
 * `hosted-` basename and is not in the set is a fault, and the only way to add
 * hosted code is to put it where the rules reach it.
 */
function looksHosted(deployRoot, path) {
  const parts = relative(deployRoot, path).split(sep);
  return parts.some((part) => part === "hosted" || part.startsWith(HOSTED_FUNCTION_PREFIX));
}

/**
 * The index of the next thing after `index` that is not between-token filler.
 *
 * JavaScript allows whitespace *and* both comment forms wherever it allows a space,
 * so `import` and its `(` may legally be separated by either. The pattern is sticky
 * so it consumes filler from exactly `index` onward, and every alternative is
 * optional, so it always matches - possibly emptily, when the next character is
 * already real code. An unterminated comment matches no alternative and simply ends
 * the run at its opening slash, which is not a `(` either way, so there is no
 * separate case for it.
 *
 * A line comment ends at any of the four ECMAScript LineTerminators - LF, CR, U+2028
 * and U+2029 - not at LF alone. Stopping only at LF is a bypass rather than a
 * rounding error: `import//x\r("../../access.mjs")` is a dynamic import that
 * JavaScript accepts and a LF-only run would swallow whole, ending the filler at end
 * of source and finding no `(`. The terminator is left unconsumed here; the `\s+`
 * alternative takes it on the next pass, since all four are whitespace to `\s`.
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
 * This is rule H1, and it is deliberately lexical rather than syntactic: it runs on
 * raw source including strings and comments, because an over-approximation fails
 * closed and a scanner that understood string context could be fed the construct
 * through a template literal. What it does understand is the one thing a text search
 * got wrong - `import` and `(` are separate tokens, so a comment between them is the
 * same dynamic import as `import(`, and a whitespace-only text search let that
 * spelling through into a function body the resolution hook never observes.
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
 * JavaScript allows an identifier to be written in escapes, so `createRequire`
 * and `process.getBuiltinModule` are the two banned names to the parser while
 * being different text to a raw scan - a bypass of H1 and H2 that costs one
 * backslash. Decoding first and scanning the result gives the scans the parser's
 * spelling of every identifier without either of them learning anything about
 * escapes.
 *
 * The decode is as over-approximate as the scans it feeds: it runs on strings and
 * comments too, and it does not track whether a backslash was itself escaped, so the
 * literal text `\\u0052equire` decodes to a hit. That fails closed, which is the
 * direction this gate is wrong in everywhere else, and the cost in a tree this size
 * is a sentence rewritten.
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
 * Whole identifiers, so a property named `createRequireToken` is not one, and the
 * same over-approximation as H1 otherwise: strings and comments count, because a
 * check that respected them could be fed the name through a template literal. Both
 * names are terms of art rather than English, so the cost of the over-approximation
 * in a tree this size is a sentence rewritten in a comment.
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
 * followed - a symlink is the obvious way for a scan to walk out of the tree it is
 * confined to, and the deploy tree has no legitimate use for one.
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
        faults.push(`${relative(repoRoot, path)} is a symbolic link; the deploy tree carries no symlinks`);
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
 * The lowest Node `range` admits, or `null` when the range is not a plain `>=`
 * floor.
 *
 * Anything cleverer than a floor is refused rather than approximated: this gate has
 * one question to ask of the field and no business implementing semver.
 */
function declaredFloor(range) {
  const match = /^>=\s*(\d+(?:\.\d+){0,2})$/.exec(String(range ?? "").trim());
  return match === null ? null : match[1];
}

/**
 * The names a deployed module may import from the registry, plus the manifest's
 * claim about the runtime it supports.
 */
function readManifest(repoRoot, faults) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch (error) {
    faults.push(`package.json could not be read: ${error.message.split("\n")[0]}`);
    return new Set();
  }

  const range = manifest.engines?.node;
  const floor = declaredFloor(range);
  if (floor === null) {
    faults.push(
      `package.json declares engines.node ${JSON.stringify(range ?? null)}; it must be a \`>=\` floor this gate can compare against ${MECHANISM_SINCE}`,
    );
  } else if (!atLeast(floor, MECHANISM_SINCE)) {
    faults.push(
      `package.json permits Node ${floor}, below the ${MECHANISM_SINCE} that provides module.registerHooks; this gate cannot see a require() edge on an older runtime`,
    );
  }
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

/**
 * The Netlify entry-point shape. A module that links but exports no handler is a
 * function that cannot be invoked, which the deploy would accept silently.
 *
 * `hosted` picks the namespace the declared routes are held to: `/api/hosted/` for
 * the hosted application and `/api/` for the collaboration deployment.
 *
 * The page-route allowlist belongs to the hosted application alone. Offering it to
 * both would have relaxed a rule nobody asked to relax: the collaboration rule is
 * that *every* routed function sits under `/api/`, because `netlify.toml` excludes
 * exactly `/api/*` from the edge gate, so a collaboration function at
 * `/docs/:documentId` would be served from behind a gate the workflow's config
 * check still reports as fail-closed.
 */
function entryPointFaults(module, hosted) {
  const prefix = hosted ? HOSTED_ROUTED_PREFIX : ROUTED_PREFIX;
  const outside = hosted
    ? `outside the ${prefix}* hosted API namespace`
    : `outside the ${prefix}* edge-gate exclusion`;
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
     `String()` produced `"/api/ok,/admin/secret"`, which starts with the routed
     prefix and so passed - a second route escaping both the namespace check and the
     duplicate-route map. */
  const declared = config.path === undefined ? [] : Array.isArray(config.path) ? config.path : [config.path];
  const paths = [];
  for (const path of declared) {
    if (typeof path !== "string") {
      faults.push(`declares a non-string route ${JSON.stringify(path)}`);
      continue;
    }
    if (!path.startsWith(prefix) && !(hosted && ALLOWED_PAGE_ROUTES.includes(path))) {
      faults.push(`is routed at ${path}, ${outside}`);
    }
    paths.push(path);
  }
  if (declared.length === 0 && config.schedule === undefined) {
    faults.push("declares neither a path nor a schedule");
  }
  return { faults, paths };
}

/**
 * Every module the hosted tree pulls in, transitively: the hosted modules plus
 * everything reached from one of them, and from one of those.
 *
 * H3 needs this set because the boundary is a property of the graph the hosted
 * application loads, not of the files that happen to live in its directories. The
 * fixpoint is cheap - the records are already in memory and the graph is small - and
 * it is a fixpoint rather than one pass because a resolution can be recorded before
 * the record that puts its parent in the set.
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
 * H3 for a module the hosted tree loaded but does not own.
 *
 * A dependency is judged on the capability and on nothing else: it may not reach
 * `node:module`, whose export list is how an ESM module obtains a CommonJS
 * `require`, and it may not resolve a first-party file outside the hosted subtree.
 * Its internals are its own business - refusing a dependency's `node:fs` would be a
 * boundary this gate has no standing to hold.
 */
function dependencyFault(record, { deployRoot, installedRoot, repoRoot }) {
  const { specifier, parentURL, url } = record;
  const from = relative(repoRoot, fileURLToPath(parentURL));
  if (REQUIRE_GRANTING_BUILTINS.includes(url)) {
    return `${from}, loaded by the hosted tree, imports ${url}, which hands out a CommonJS require the hosted boundary cannot see`;
  }
  if (url.startsWith("file:")) {
    const target = fileURLToPath(url);
    if (!isInside(installedRoot, target) && !isHosted(deployRoot, target)) {
      return `${from}, loaded by the hosted tree, imports ${specifier}, which resolves outside the hosted subtree`;
    }
  }
  return null;
}

/**
 * Turn one resolution record into a fault, or nothing.
 *
 * Records whose parent is a deploy module get the whole-tree boundary, plus the
 * hosted builtin allowlist when that parent is a hosted module. Records from
 * anything else the hosted tree loaded get H3's narrow capability check. The gate's
 * own imports are neither, and are not this boundary's business.
 */
function resolutionFault(record, context) {
  const { deployRoot, installedRoot, deployModules, hostedModules, reached, fixtureDir, dependencies, repoRoot } =
    context;
  const { specifier, parentURL, url } = record;
  if (parentURL === null || !parentURL.startsWith("file:")) return null;
  const parent = fileURLToPath(parentURL);
  if (!deployModules.has(parent)) {
    return reached.has(parent) ? dependencyFault(record, { deployRoot, installedRoot, repoRoot }) : null;
  }

  const from = relative(repoRoot, parent);
  const hosted = hostedModules.has(parent);
  if (url.startsWith("node:")) {
    /* H2, read off a resolution: `node:module` hands out `createRequire`, and a
       require built from it resolves a CommonJS graph. The list is an allowlist so
       an unargued builtin fails closed. */
    if (!hosted) return null;
    return ALLOWED_BUILTINS.includes(url)
      ? null
      : `${from} imports ${url}, which is not one of the builtins the hosted deploy tree may import (${ALLOWED_BUILTINS.join(", ")})`;
  }
  if (!url.startsWith("file:")) {
    return `${from} imports ${specifier}, which resolves to a non-file URL`;
  }

  const target = fileURLToPath(url);
  const inDeploy = isInside(deployRoot, target);
  const inModules = isInside(installedRoot, target);

  if (inModules) {
    /* A relative path into `node_modules` reaches an installed package while
       looking like a local file, which would sidestep the manifest rule entirely. */
    if (isRelative(specifier)) {
      return `${from} imports ${specifier}, reaching node_modules by path instead of by package name`;
    }
    const name = packageOf(specifier);
    if (!dependencies.has(name)) return `${from} imports ${name}, which is not a dependency in package.json`;
    /* And the hosted subset on top, because one merged manifest is the union of two
       dependency sets. `@netlify/identity` is root-declared and is exactly the
       legacy authority the hosted boundary exists to keep out. */
    if (hosted && !HOSTED_DEPENDENCIES.includes(name)) {
      return `${from} imports ${name}, which is not one of the packages the hosted deploy tree may import (${HOSTED_DEPENDENCIES.join(", ")})`;
    }
    return null;
  }

  if (!inDeploy) {
    /* The two ways to get here are a relative import that climbs out of the tree,
       and a bare import that resolved to a package installed somewhere the deploy's
       own `npm ci` would not put one. */
    return isRelative(specifier)
      ? `${from} imports ${specifier}, which resolves outside ${DEPLOY}/`
      : `${from} imports ${packageOf(specifier)}, which resolves outside the install the deploy tree carries`;
  }

  if (isInside(fixtureDir, target)) {
    return `${from} imports ${specifier} from ${DEPLOY}/${FIXTURE_DIRECTORY}/; fixtures must not reach a deployed module`;
  }
  if (!isRelative(specifier)) {
    return `${from} imports ${specifier}, which resolves inside ${DEPLOY}/ but is not a relative path`;
  }

  /* The hosted boundary, at the strength it had before the merge. Under two deploy
     trees this was "nothing under `hosted/` resolves outside `hosted/`", and the
     move alone would have dissolved it: `netlify/lib/access.mjs` and
     `netlify/lib/identity.mjs` - Netlify Identity, `DOC_OWNERS` and the
     organisation role defaults - are now one relative segment from every hosted
     module and are inside the deploy tree, so containment says nothing about them.
     A hosted handler importing `../access.mjs` would have deployed green. The rule
     is therefore restated against the hosted subtree rather than the deploy root,
     which is the same barrier addressed to the same code. */
  if (hosted && !isHosted(deployRoot, target)) {
    return `${from} imports ${specifier}, which resolves to ${relative(repoRoot, target)}, outside the hosted subtree (${DEPLOY}/${HOSTED_LIB}/ and ${DEPLOY}/functions/${HOSTED_FUNCTION_PREFIX}*${LOADABLE})`;
  }
  return null;
}

async function main(argv) {
  const rootFlag = argv.indexOf("--root");
  const given = rootFlag === -1 ? DEFAULT_ROOT : argv[rootFlag + 1];
  if (rootFlag !== -1 && (given === undefined || !existsSync(given))) {
    process.stderr.write(`FAIL netlify modules: --root ${given ?? ""} does not exist\n`);
    return 1;
  }
  /* Absolute *and* canonical. Every scanned path is derived from this root, while
     the resolution records come back from Node as absolute, realpath'd file URLs, so
     any root that is spelled differently from what Node reports made the two
     vocabularies disagree: no scanned module matched its own resolution record,
     every boundary rule quietly judged nothing, and the gate reported PASS on a tree
     it had already read the escape out of. A relative root did it, and so did an
     absolute one reached through a symlink - which is not exotic, since
     `os.tmpdir()` is a symlink on macOS. */
  const repoRoot = realpathSync(given);

  const deployRoot = join(repoRoot, DEPLOY);
  if (!existsSync(deployRoot)) {
    process.stderr.write(`FAIL netlify modules: ${DEPLOY}/ does not exist\n`);
    return 1;
  }

  const faults = [];
  const dependencies = readManifest(repoRoot, faults);
  const installedRoot = join(repoRoot, "node_modules");
  const fixtureDir = join(deployRoot, FIXTURE_DIRECTORY);
  const edgeDir = join(deployRoot, EDGE_DIRECTORY);
  const unscanned = UNSCANNED_DIRECTORIES.map((name) => join(deployRoot, name));

  /* Staleness is decided up front and independently of what loads, so the report is
     the same on a clean checkout and on a developer machine that happens to have
     build output lying around. */
  const applicable = new Set();
  for (const [path, allowance] of ALLOWED_LOAD_FAILURES) {
    if (allowanceApplies(repoRoot, path, allowance)) applicable.add(path);
    else faults.push(`${path} no longer matches its ALLOWED_LOAD_FAILURES entry; delete it (#${allowance.issue})`);
  }

  /* Placement first: the whole tree is walked, so a code file outside the deploy
     directories is reported rather than quietly unscanned. */
  const deployModules = [];
  const functionModules = [];
  const hostedModulePaths = [];
  const hostedLibModules = [];
  const hostedFunctionModules = [];
  for (const path of filesUnder(deployRoot, faults, repoRoot)) {
    if (unscanned.some((directory) => isInside(directory, path))) continue;

    const name = path.slice(path.lastIndexOf(sep) + 1);
    const dot = name.lastIndexOf(".");
    const extension = dot === -1 ? "" : name.slice(dot);
    if (!SCANNED.includes(extension)) continue;

    const shown = relative(repoRoot, path);
    if (isInside(edgeDir, path)) {
      /* The edge directory is excluded by extension rather than wholesale, so a
         `.mjs` handler cannot sit there unscanned and unloaded. */
      if (extension === EDGE_EXTENSION) continue;
      faults.push(
        `${shown} is ${extension} inside ${DEPLOY}/${EDGE_DIRECTORY}/, which carries the Deno TypeScript edge function and nothing else`,
      );
      continue;
    }

    const hosted = isHosted(deployRoot, path);
    if (!hosted && looksHosted(deployRoot, path)) {
      faults.push(
        `${shown} reads as hosted code but is not in the hosted deploy set (${DEPLOY}/${HOSTED_LIB}/ and ${DEPLOY}/functions/${HOSTED_FUNCTION_PREFIX}*${LOADABLE}), so no hosted rule would reach it`,
      );
      continue;
    }
    const directory = relative(deployRoot, path).split(sep)[0];
    if (!DEPLOY_DIRECTORIES.includes(directory)) {
      faults.push(
        `${shown} is deployable code outside ${DEPLOY}/{${DEPLOY_DIRECTORIES.join(",")}}/, where nothing checks it`,
      );
      continue;
    }
    if (extension !== LOADABLE) {
      faults.push(`${shown} is ${extension}; the deploy tree is ${LOADABLE} only, because ${REFUSED[extension]}`);
      continue;
    }
    if (/\.test\.mjs$/.test(name)) {
      /* H5, and hosted-scoped for a reason worth stating: `netlify/lib/` has
         carried `identity.test.mjs` and `notify.test.mjs` beside their sources
         since long before the hosted boundary existed, CI names both literally,
         and neither is deployed as a route. Refusing them here would report two
         known-good files as faults. Either way a test file is never loaded as a
         deploy module. */
      if (hosted) {
        faults.push(
          `${shown} is a test file inside a deployed directory; it belongs in ${DEPLOY}/${FIXTURE_DIRECTORY}/`,
        );
      }
      continue;
    }

    if (hosted) {
      /* H1 and H2, on raw source including comments, and on the source with
         identifier escapes decoded. Scanning raw text rather than string-aware text
         is what stops a template literal carrying the construct past in passing, and
         it is the only form of either rule that reaches a function body nothing
         calls. It is not a barrier against a computed name - see the threat model in
         the header; nothing lexical is. */
      const source = readFileSync(path, "utf8");
      const written = spellings(source);
      if (written.some(usesDynamicImport)) {
        faults.push(`${shown} uses dynamic import; the hosted deploy tree is static imports only`);
      }
      for (const spelled of new Set(written.flatMap(requireEscapes))) {
        faults.push(`${shown} names ${spelled}; the hosted deploy tree may not acquire a CommonJS require`);
      }
      hostedModulePaths.push(path);
      if (directory === "lib") hostedLibModules.push(path);
    }

    deployModules.push(path);
    if (directory === "functions") {
      functionModules.push(path);
      if (hosted) hostedFunctionModules.push(path);
    }
  }

  /* A gate that finds nothing to check reports success, which is the one result it
     must never invent, and every guard here is unconditional rather than gated on
     the directory existing. Gating on existence is the same silent pass one step
     removed: a `functions/` that is renamed away leaves nothing to check and, under
     an `existsSync` guard, nothing to say about it either. Four counts, because
     four different things can empty out - the tree, the functions, the hosted
     libraries and the hosted functions - and each one silently retires a different
     set of rules. */
  if (deployModules.length === 0) {
    faults.push(`no modules found under ${DEPLOY}/{${DEPLOY_DIRECTORIES.join(",")}}/`);
  }
  if (functionModules.length === 0) {
    faults.push(`${DEPLOY}/functions/ contains no loadable module`);
  }
  if (hostedLibModules.length === 0) {
    faults.push(`${DEPLOY}/${HOSTED_LIB}/ contains no loadable module; the hosted rules would judge nothing`);
  }
  if (hostedFunctionModules.length === 0) {
    faults.push(
      `${DEPLOY}/functions/${HOSTED_FUNCTION_PREFIX}*${LOADABLE} matches no loadable module; the hosted route and entry-point rules would judge nothing`,
    );
  }

  /* Record what Node resolves, then reason about resolved URLs rather than about
     source text. Synchronous hooks run in-thread and are consulted for `require()`
     as well as `import`, so the records below are the whole graph rather than its
     ESM half. */
  const records = [];
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      records.push({ specifier, parentURL: context.parentURL ?? null, url: result.url });
      return result;
    },
  });

  const deployModuleSet = new Set(deployModules);
  const hostedModules = new Set(hostedModulePaths);
  const routes = new Map();
  const linked = [];
  let allowed = 0;

  /* H3's second door. `process.getBuiltinModule` reaches `node:module` off a global,
     so no resolver is consulted and no import is written down; the only thing that
     can observe it is the function itself. Wrapping it for the duration of the load
     catches the call whoever makes it - a dependency's own top level as readily as a
     hosted module - and whatever the spelling, since a computed property name or an
     escaped identifier still arrives here. It is restored afterwards so nothing else
     in this process inherits it. */
  const original = process.getBuiltinModule;
  const capabilityFaults = [];
  if (typeof original === "function") {
    process.getBuiltinModule = function getBuiltinModule(id) {
      const name = String(id).startsWith("node:") ? String(id) : `node:${String(id)}`;
      if (REQUIRE_GRANTING_BUILTINS.includes(name)) {
        capabilityFaults.push(
          `something the deploy tree loaded called process.getBuiltinModule(${JSON.stringify(id)}), which hands out a CommonJS require the hosted boundary cannot see`,
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
      /* Node's link errors quote absolute paths. The checkout root is noise in a CI
         log and an accident waiting to happen in a public one, so it is reduced to
         the same relative vocabulary as everything else. */
      const reason = error.message.split("\n")[0].split(`${repoRoot}${sep}`).join("");
      const allowance = ALLOWED_LOAD_FAILURES.get(shown);
      if (allowance === undefined || !applicable.has(shown) || !allowance.excusesErrorMatching.test(reason)) {
        faults.push(`${shown} ${reason}`);
        continue;
      }
      allowed += 1;
      process.stderr.write(
        `ALLOW netlify modules: ${shown} ${reason} (allowed ${allowance.since}, removed by #${allowance.issue})\n`,
      );
      continue;
    }
    linked.push(path);

    if (!functionModules.includes(path)) continue;
    const { faults: shapeFaults, paths } = entryPointFaults(module, hostedModules.has(path));
    for (const fault of shapeFaults) faults.push(`${shown} ${fault}`);
    for (const route of paths) {
      const owner = routes.get(route);
      if (owner !== undefined) faults.push(`${shown} claims ${route}, already claimed by ${owner}`);
      else routes.set(route, shown);
    }
  }

  if (typeof original === "function") process.getBuiltinModule = original;
  for (const fault of capabilityFaults) faults.push(fault);

  /* Fail closed if this gate and Node disagree about how to spell a path. Every
     module above was imported by absolute URL, so each one must appear as the target
     of a resolution record; if it does not, the records are in a vocabulary the
     boundary rules below cannot match and they will judge nothing while every module
     loads and links. That combination reports PASS and means nothing, which is the
     one answer this gate must never give. */
  const resolvedTargets = new Set(
    records.filter((record) => record.url.startsWith("file:")).map((record) => fileURLToPath(record.url)),
  );
  for (const path of linked) {
    if (resolvedTargets.has(path)) continue;
    faults.push(
      `${relative(repoRoot, path)} loaded but names no resolution record; this gate and Node disagree about how to spell it, so no boundary rule can judge it`,
    );
  }

  const reached = reachableFrom(records, hostedModules);
  const seen = new Set();
  for (const record of records) {
    /* NUL joins the two halves because neither a URL nor a specifier can contain
       one, so two different pairs can never collide into one key. */
    const key = `${record.parentURL}\u0000${record.specifier}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const fault = resolutionFault(record, {
      deployRoot,
      installedRoot,
      deployModules: deployModuleSet,
      hostedModules,
      reached,
      fixtureDir,
      dependencies,
      repoRoot,
    });
    if (fault !== null) faults.push(fault);
  }

  if (faults.length > 0) {
    for (const fault of faults) process.stderr.write(`FAIL netlify modules: ${fault}\n`);
    return 1;
  }

  const note = allowed === 0 ? "" : `, ${allowed} allowed`;
  process.stdout.write(
    `PASS netlify modules: ${linked.length} modules load and link${note} (${functionModules.length} routed functions, ${hostedModulePaths.length} hosted)\n`,
  );
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  /* A missing directory or an unreadable tree is still a failure of this gate, and it
     reports in the same one-line vocabulary as everything else rather than as a
     stack trace. */
  process.stderr.write(`FAIL netlify modules: ${error.message.split("\n")[0]}\n`);
  process.exitCode = 1;
}
