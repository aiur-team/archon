/**
 * Regressions for `scripts/check-function-modules.mjs`.
 *
 * A verification mechanism with no test of its own is the one kind of code
 * whose failure is permanently silent: an edit that empties the fault list or
 * inverts the exit condition leaves CI green forever, and the only signal would
 * be a hosted deploy 404ing or a handler quietly importing the legacy identity
 * tree. The hosted gate shipped without a test and three planted faults - a
 * module outside the functions directory, a handler routed outside the API
 * namespace, and an import of the legacy tree hidden behind a regex literal -
 * were all reported as `PASS`.
 *
 * So every rule the gate claims gets a tree that violates exactly that rule and
 * an assertion that the gate fails on it, plus a clean tree that must pass. The
 * clean-tree case is not a formality: it is what stops a gate that fails on
 * everything from looking healthy.
 *
 * ## Why this file is still named after a script that no longer exists
 *
 * ACN-003 folded the hosted deployment into `netlify/` and merged
 * `scripts/check-hosted-modules.mjs` into `scripts/check-function-modules.mjs`.
 * These cases came across with the rules they guard rather than being deleted
 * with the script: each one still plants the fault it always planted, in the
 * place that fault now lives. The name is kept so the merge is reviewable as a
 * retarget rather than as a deletion and a rewrite.
 *
 * ## The two scopes
 *
 * The merged gate holds whole-tree rules over every deployed module and
 * hosted-scoped rules over `netlify/lib/hosted/` and
 * `netlify/functions/hosted-*.mjs` only. The scoping is itself asserted, in
 * "the hosted-only rules are scoped to the hosted tree": the collaboration
 * deployment imports `node:fs` and keeps `*.test.mjs` beside its sources, and a
 * merged gate that reported either as a fault would be turned off within a week.
 *
 * Each case runs the gate as a child process against a temporary checkout-shaped
 * directory, because the gate registers a module-resolution hook and a hook is
 * process-wide.
 *
 *   node --test scripts/check-hosted-modules.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "check-function-modules.mjs");

/** The deploy tree the gate scans, relative to a checkout-shaped root. */
const DEPLOY_DIR = "netlify";

/**
 * A directory outside the deploy tree, standing in for everything the deploy
 * does not carry.
 *
 * Before the merge this was `netlify/`, which the hosted tree was forbidden to
 * reach. There is no second first-party tree now, so the fixture names one: an
 * import that lands here is an import the P4-S connect tool would not copy, and
 * that is exactly the defect the containment rule exists for (#117).
 */
const OUTSIDE_DIR = "elsewhere";

/** Every temporary tree this file makes, removed when the suite finishes. */
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Write `contents` to `path`, creating parent directories as needed. */
function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/**
 * A tiny installed package, so dependency resolution has something to find.
 *
 * `source` exists for the transitive capability rule: the cases below need a
 * dependency that does something, not just one that resolves.
 */
function installPackage(nodeModules, name, source = "export const value = 1;\n") {
  write(join(nodeModules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.mjs" }));
  write(join(nodeModules, name, "index.mjs"), source);
}

/**
 * The runtime floor a fixture manifest declares.
 *
 * The gate refuses a manifest that permits a Node without
 * `module.registerHooks`, so every fixture carries a real floor and the one test
 * that cares plants a lower one.
 */
const FIXTURE_ENGINES = { node: ">=22.15.0" };

/** The root manifest a fixture checkout carries, with `dependencies` supplied. */
function writeManifest(root, dependencies, engines = FIXTURE_ENGINES) {
  write(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", private: true, type: "module", engines, dependencies }),
  );
}

/**
 * A checkout-shaped tree that the gate should pass.
 *
 * It carries what a real repository has and a naive fixture would not: both
 * halves of the merged deploy tree, a `netlify/test/` directory to import by
 * mistake, a static asset directory, an edge function in TypeScript that the
 * placement rule must skip rather than refuse, a collaboration test file sitting
 * beside its source, and a directory outside the deploy tree to escape into.
 */
function cleanTree() {
  const root = mkdtempSync(join(tmpdir(), "deploy-gate-"));
  roots.push(root);
  const deploy = join(root, DEPLOY_DIR);

  /* `tldts` by name, not a stand-in: the hosted dependency subset is a literal list
     in the gate, so a fixture that invented a package name could not exercise it. */
  installPackage(join(root, "node_modules"), "allowed-pkg");
  installPackage(join(root, "node_modules"), "undeclared-pkg");
  installPackage(join(root, "node_modules"), "tldts");
  writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0" });

  write(join(root, OUTSIDE_DIR, "legacy.mjs"), "export const legacy = true;\n");
  write(join(deploy, "test", "fixtures.mjs"), "export const FIXTURE = 1;\n");
  write(join(deploy, "public", "index.html"), "<!doctype html><html><body></body></html>\n");
  write(join(deploy, "public", "app.js"), "// a browser asset, not a deploy module\n");
  write(join(deploy, "edge-functions", "gate.ts"), "export default async () => new Response();\n");

  /* The collaboration half: `node:fs` and a test file beside its source, both of
     which the hosted rules refuse and neither of which is a defect here. */
  write(
    join(deploy, "lib", "ok.mjs"),
    'import { value } from "allowed-pkg";\nimport { existsSync } from "node:fs";\nexport const ok = value && typeof existsSync === "function";\n',
  );
  write(join(deploy, "lib", "ok.test.mjs"), "export const spec = 1;\n");
  write(
    join(deploy, "functions", "handler.mjs"),
    'import { ok } from "../lib/ok.mjs";\nexport default async () => new Response(String(ok));\nexport const config = { path: "/api/thing" };\n',
  );

  /* The hosted half. */
  write(
    join(deploy, "lib", "hosted", "ok.mjs"),
    'import { value } from "tldts";\nimport { createHash } from "node:crypto";\nexport const ok = value && typeof createHash === "function";\n',
  );
  write(
    join(deploy, "functions", "hosted-handler.mjs"),
    'import { ok } from "../lib/hosted/ok.mjs";\nexport default async () => new Response(String(ok));\nexport const config = { path: "/api/hosted/thing" };\n',
  );
  return root;
}

/** Run the gate against `root` and return its exit code and streams. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Build a clean tree, apply `plant`, and assert the gate still passes. */
function assertAccepted(plant) {
  const root = cleanTree();
  plant(root, join(root, DEPLOY_DIR));
  const { status, stdout, stderr } = runGate(root);
  assert.equal(status, 0, `expected the gate to pass; it printed:\n${stderr}`);
  return stdout;
}

/**
 * Build a clean tree, apply `plant`, and assert the gate fails with `pattern`.
 *
 * `what` names the planted fault when a case loops over several, so a failure says
 * which spelling slipped through rather than only which assertion ran.
 */
function assertRejected(plant, pattern, what = "") {
  const root = cleanTree();
  plant(root, join(root, DEPLOY_DIR));
  const { status, stderr } = runGate(root);
  const naming = what === "" ? "" : ` (${what})`;
  assert.equal(status, 1, `expected the gate to fail${naming}; it printed:\n${stderr}`);
  assert.match(stderr, pattern, `expected the fault to name the rule${naming}`);
  return stderr;
}

test("a clean merged tree passes, and the count is real", () => {
  const { status, stdout, stderr } = runGate(cleanTree());
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^PASS netlify modules: 4 modules load and link \(2 routed functions, 2 hosted\)$/m);
});

test("the hosted-only rules are scoped to the hosted tree", () => {
  /* The clean tree already carries both: `netlify/lib/ok.mjs` imports `node:fs`,
     which the hosted builtin allowlist refuses, and `netlify/lib/ok.test.mjs`
     sits beside its source, which the hosted placement rule refuses. Asserting
     the scope directly means a later edit that widens either rule fails here
     rather than in a build that has to be reverted. */
  const root = cleanTree();
  write(
    join(root, DEPLOY_DIR, "lib", "spawner.mjs"),
    'import { spawnSync } from "node:child_process";\nexport const run = spawnSync;\n',
  );
  const { status, stderr } = runGate(root);
  assert.equal(status, 0, stderr);
});

test("the edge function is skipped rather than refused for being TypeScript", () => {
  /* `netlify/edge-functions/gate.ts` is Deno TypeScript this process cannot
     import at all, and `scripts/test-access-row.mjs` is what drives it. It sits
     in the clean tree so that the exclusion is a fact rather than an accident of
     nobody having written a `.ts` file there yet. */
  assertAccepted((root, deploy) =>
    write(join(deploy, "edge-functions", "second.ts"), "export const another = true;\n"),
  );
});

test("a hosted module that reaches outside the deploy tree is refused", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "leak.mjs"),
        `import { legacy } from "../../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
      ),
    /resolves outside netlify\//,
  );
});

test("a hosted module cannot reach the collaboration tree", () => {
  /* The rule the merge would have dissolved by itself. Under two deploy trees this
     was "nothing under `hosted/` resolves outside `hosted/`", and containment
     against the deploy root said the same thing. After the move it does not:
     `netlify/lib/access.mjs` carries `DOC_OWNERS` and the organisation role
     defaults, it is one relative segment from every hosted module, and it is
     *inside* `netlify/` - so whole-tree containment passes it and the hosted
     handler deploys reading the legacy authority. */
  assertRejected(
    (root, deploy) => {
      write(join(deploy, "lib", "access.mjs"), "export const DOC_OWNERS = [];\n");
      write(
        join(deploy, "lib", "hosted", "leak.mjs"),
        'import { DOC_OWNERS } from "../access.mjs";\nexport const owners = DOC_OWNERS;\n',
      );
    },
    /leak\.mjs imports \.\.\/access\.mjs, which resolves to netlify\/lib\/access\.mjs, outside the hosted subtree/,
  );
  /* And the same barrier for a hosted function reaching a collaboration one. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-borrow.mjs"),
        'import "./handler.mjs";\nexport default async () => new Response();\nexport const config = { path: "/api/hosted/borrow" };\n',
      ),
    /hosted-borrow\.mjs imports \.\/handler\.mjs, which resolves to netlify\/functions\/handler\.mjs, outside the hosted subtree/,
  );
});

test("a hosted module cannot import a package the hosted tree may not use", () => {
  /* One merged manifest is the union of two dependency sets, so root-declared is
     necessary and not sufficient: `allowed-pkg` below is declared, resolves, and
     links, and is still refused for hosted code. The union used to carry
     `@netlify/identity` - the legacy authority this barrier was written to keep
     out - and no longer does, because ACN-006 deleted the last import of it.
     The rule stays: the union is still wider than the hosted subset, and a
     package added to the root manifest for a collaboration handler must not
     silently become importable by hosted code. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "borrows.mjs"),
        'import { value } from "allowed-pkg";\nexport const v = value;\n',
      ),
    /borrows\.mjs imports allowed-pkg, which is not one of the packages the hosted deploy tree may import/,
  );
  /* The same package in a collaboration module is ordinary and stays ordinary. */
  assertAccepted((root, deploy) =>
    write(join(deploy, "lib", "borrows.mjs"), 'import { value } from "allowed-pkg";\nexport const v = value;\n'),
  );
});

test("a path that reads as hosted but is not in the hosted set is refused", () => {
  /* Membership is two exact shapes, so anything that looks hosted and matches
     neither would silently lose every hosted rule while still deploying as a hosted
     route. Both spellings below are what an ordinary tidying refactor produces. */
  for (const [where, what] of [
    [["functions", "hosted", "publish.mjs"], "a hosted function moved into a subdirectory"],
    [["lib", "hosted-helper.mjs"], "a hosted library placed beside the hosted tree"],
  ]) {
    assertRejected(
      (root, deploy) =>
        write(
          join(deploy, ...where),
          'import { createRequire } from "node:module";\nexport default async () => new Response();\nexport const config = { path: "/api/anywhere" };\n',
        ),
      /reads as hosted code but is not in the hosted deploy set/,
      what,
    );
  }
});

test("a JavaScript module in the edge directory is refused rather than skipped", () => {
  /* The edge directory is excluded for `gate.ts`, which is Deno TypeScript this
     process cannot import. Excluding it wholesale would leave a `.mjs` handler
     there unscanned and unloaded - the "deployable code where nothing checks it"
     hole the placement rule exists to close - so the exclusion is by extension. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "edge-functions", "leak.mjs"),
        `import { legacy } from "../../${OUTSIDE_DIR}/legacy.mjs";\nexport default async () => new Response(String(legacy));\n`,
      ),
    /leak\.mjs is \.mjs inside netlify\/edge-functions\/, which carries the Deno TypeScript edge function and nothing else/,
  );
});

test("a collaboration module that reaches outside the deploy tree is refused too", () => {
  /* Containment is a whole-tree rule: the connect tool copies `netlify/` and
     nothing else, so an escape from either half deploys broken. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "leak.mjs"),
        `import { legacy } from "../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
      ),
    /resolves outside netlify\//,
  );
});

test("a regex literal cannot hide an escaping import", () => {
  /* The exact input the old text scanner mis-read: `//` inside a regex literal
     made it treat the rest of the line as a comment, so the import below was
     never seen and the gate printed PASS. Asking the resolver has no such
     blind spot. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "sneaky.mjs"),
        `export const SCHEME = /^https?:\\/\\//;\nimport { legacy } from "../../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
      ),
    /resolves outside netlify\//,
  );
});

test("a quote inside a regex literal does not invent an import", () => {
  /* The mirror-image failure: the old scanner flipped into string state here
     and extracted a specifier out of the following comment, failing a build
     over prose. */
  const root = cleanTree();
  write(
    join(root, DEPLOY_DIR, "lib", "hosted", "quoted.mjs"),
    'export const QUOTES = /["\']/;\n/* prose that mentions from "netlify-identity" on purpose */\nexport const fine = true;\n',
  );
  const { status, stderr } = runGate(root);
  assert.equal(status, 0, stderr);
});

test("a deployed module cannot import a test fixture", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "fake.mjs"),
        'import { FIXTURE } from "../../test/fixtures.mjs";\nexport const fake = FIXTURE;\n',
      ),
    /fixtures must not reach a deployed module/,
  );
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "fake.mjs"),
        'import { FIXTURE } from "../test/fixtures.mjs";\nexport const fake = FIXTURE;\n',
      ),
    /fixtures must not reach a deployed module/,
  );
});

test("a package installed inside the deploy tree is refused", () => {
  /* Before the merge the equivalent defect was a package installed at the
     repository root while the hosted tree had its own install. There is one
     install now, so the shape inverts: an install *inside* `netlify/` is the one
     a deploy's own `npm ci` would never produce, and it links perfectly here
     because Node's resolution walks up from the importing file. */
  assertRejected(
    (root, deploy) => {
      installPackage(join(deploy, "node_modules"), "inner-pkg");
      writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0", "inner-pkg": "1.0.0" });
      write(
        join(deploy, "lib", "hosted", "inner.mjs"),
        'import { value } from "inner-pkg";\nexport const v = value;\n',
      );
    },
    /resolves inside netlify\/ but is not a relative path/,
  );
});

test("an installed package that the manifest does not declare is refused", () => {
  /* This is the rule that makes `tldts` a declared root dependency rather than
     something `netlify/lib/hosted/contracts.mjs` happens to find. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "undeclared.mjs"),
        'import { value } from "undeclared-pkg";\nexport const v = value;\n',
      ),
    /undeclared-pkg, which is not a dependency in package\.json/,
  );
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "undeclared.mjs"),
        'import { value } from "undeclared-pkg";\nexport const v = value;\n',
      ),
    /undeclared-pkg, which is not a dependency in package\.json/,
  );
});

test("reaching node_modules by relative path is refused", () => {
  /* A relative path into `node_modules` looks like a local file and would
     otherwise skip the manifest rule entirely. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "byPath.mjs"),
        'import { value } from "../../../node_modules/allowed-pkg/index.mjs";\nexport const v = value;\n',
      ),
    /reaching node_modules by path instead of by package name/,
  );
});

test("dynamic import is refused however its specifier is spelled", () => {
  for (const body of [
    'export async function load() { return import("../../test/fixtures.mjs"); }\n',
    `export async function load() { return import(\`../../../${OUTSIDE_DIR}/legacy.mjs\`); }\n`,
    'export async function load(n) { return import("./" + n); }\n',
  ]) {
    assertRejected(
      (root, deploy) => write(join(deploy, "lib", "hosted", "dynamic.mjs"), body),
      /uses dynamic import/,
    );
  }
});

test("dynamic import is refused when a comment separates the two tokens", () => {
  /* `import` and `(` are separate tokens, so every form below is the same
     dynamic import as `import(`. A whitespace-only text search reads them as
     prose, and because the expression sits in a function nobody calls, the
     resolution hook never sees the escape out of the deploy tree either - the
     file would deploy with both the ban and the boundary rules bypassed. */
  for (const body of [
    `export async function load() { return import/* legacy */("../../../${OUTSIDE_DIR}/legacy.mjs"); }\n`,
    'export async function load() { return import /*\n multi\n line\n*/ ("../../test/fixtures.mjs"); }\n',
    `export async function load() { return import // trailing\n("../../../${OUTSIDE_DIR}/legacy.mjs"); }\n`,
    'export async function load() { return import/*a*/ /*b*/\t("../../test/fixtures.mjs"); }\n',
  ]) {
    assertRejected(
      (root, deploy) => write(join(deploy, "lib", "hosted", "commented.mjs"), body),
      /uses dynamic import/,
    );
  }
});

test("a line comment between the tokens ends at every line terminator", () => {
  /* JavaScript ends a line comment at any of four LineTerminators, not at LF
     alone. Each spelling below is a dynamic import the engine accepts - proven
     here rather than asserted - so a filler run that stops only at LF would
     swallow the rest of the file, end at end of source and find no `(`,
     reopening the same escape out of the deploy tree that the comment forms
     above close. The terminators are written as escapes because the character
     they produce is invisible in a source listing. */
  for (const [what, terminator] of [
    ["a carriage return", "\r"],
    ["U+2028", "\u2028"],
    ["U+2029", "\u2029"],
  ]) {
    const expression = `import // ${what}${terminator}("../../../${OUTSIDE_DIR}/legacy.mjs")`;
    assert.doesNotThrow(
      () => new Function(`return async function () { return ${expression}; };`),
      `${what} should spell a legal dynamic import`,
    );
    assertRejected(
      (root, deploy) =>
        write(
          join(deploy, "lib", "hosted", "terminated.mjs"),
          `export async function load() { return ${expression}; }\n`,
        ),
      /uses dynamic import/,
    );
  }
});

test("a name merely ending in import is not a dynamic import", () => {
  /* The clean tree must stay clean: a rule that fires on `reimport(` would make
     the gate fail on ordinary code, and a gate that fails on everything teaches
     everyone to ignore it. */
  const root = cleanTree();
  write(
    join(root, DEPLOY_DIR, "lib", "hosted", "named.mjs"),
    "function reimport(x) { return x; }\nexport const v = reimport(1);\n",
  );
  const { status, stderr } = runGate(root);
  assert.equal(status, 0, stderr);
});

test("deployable code outside lib/ and functions/ is refused rather than unscanned", () => {
  for (const where of ["handlers", "middleware"]) {
    assertRejected(
      (root, deploy) =>
        write(
          join(deploy, where, "leak.mjs"),
          `import { legacy } from "../../${OUTSIDE_DIR}/legacy.mjs";\nexport default async () => new Response(String(legacy));\n`,
        ),
      /is deployable code outside netlify\/\{lib,functions\}\//,
    );
  }
});

test("an empty functions directory is a failure, and so is a missing one", () => {
  /* Both spellings, because gating the guard on the directory existing is the same
     silent pass one step removed: a `functions/` renamed away leaves nothing to
     check and nothing to say about it. */
  assertRejected((root, deploy) => {
    rmSync(join(deploy, "functions", "handler.mjs"));
    rmSync(join(deploy, "functions", "hosted-handler.mjs"));
  }, /netlify\/functions\/ contains no loadable module/);
  assertRejected(
    (root, deploy) => rmSync(join(deploy, "functions"), { recursive: true, force: true }),
    /netlify\/functions\/ contains no loadable module/,
  );
});

test("a hosted tree that has emptied out is a failure, per directory", () => {
  /* Scoping the hosted rules by path is what makes the merge honest, so a hosted
     tree that has quietly emptied out - every hosted rule now judging nothing -
     must not read as success. Two counts, because the libraries and the functions
     retire different rules and either can go alone. */
  assertRejected(
    (root, deploy) => rmSync(join(deploy, "lib", "hosted"), { recursive: true, force: true }),
    /netlify\/lib\/hosted\/ contains no loadable module; the hosted rules would judge nothing/,
  );
  assertRejected(
    (root, deploy) => rmSync(join(deploy, "functions", "hosted-handler.mjs")),
    /netlify\/functions\/hosted-\*\.mjs matches no loadable module; the hosted route and entry-point rules would judge nothing/,
  );
});

test("a tree with no deployable modules at all is a failure", () => {
  assertRejected((root, deploy) => {
    rmSync(join(deploy, "lib"), { recursive: true, force: true });
    rmSync(join(deploy, "functions"), { recursive: true, force: true });
  }, /no modules found under netlify\/\{lib,functions\}\//);
});

test("a function must present the entry point Netlify invokes", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-noHandler.mjs"),
        'export const config = { path: "/api/hosted/other" };\n',
      ),
    /does not export a callable default handler/,
  );
  assertRejected(
    (root, deploy) =>
      write(join(deploy, "functions", "hosted-noConfig.mjs"), "export default async () => new Response();\n"),
    /does not export a config object/,
  );
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-unrouted.mjs"),
        "export default async () => new Response();\nexport const config = {};\n",
      ),
    /declares neither a path nor a schedule/,
  );
});

test("a route outside its namespace is refused, arrays included", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-admin.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/admin/secret" };\n',
      ),
    /is routed at \/admin\/secret, outside the \/api\/hosted\/\* hosted API namespace/,
  );
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "admin.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/admin/secret" };\n',
      ),
    /is routed at \/admin\/secret, outside the \/api\/\* edge-gate exclusion/,
  );
  /* An array of paths was flattened with `String()`, producing one comma-joined
     string that started with the allowed prefix - so the second route escaped
     both the namespace check and the duplicate-route map. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-both.mjs"),
        'export default async () => new Response();\nexport const config = { path: ["/api/hosted/ok", "/admin/secret"] };\n',
      ),
    /is routed at \/admin\/secret/,
  );
});

test("the page-route allowlist is a closed list, not a second prefix", () => {
  /* The contract-frozen document address is allowed to sit outside the API
     namespace. Nothing else under `/docs/` is, because the allowlist holds exact
     strings: a prefix rule would have let any future page route appear with no
     review, which is the whole reason the exception is spelled as a literal. */
  assertAccepted((root, deploy) =>
    write(
      join(deploy, "functions", "hosted-page.mjs"),
      'export default async () => new Response();\nexport const config = { path: "/docs/:documentId" };\n',
    ),
  );
  for (const path of ["/docs/:id", "/docs/", "/docs/:documentId/raw", "/docs"]) {
    assertRejected(
      (root, deploy) =>
        write(
          join(deploy, "functions", "hosted-page.mjs"),
          `export default async () => new Response();\nexport const config = { path: ${JSON.stringify(path)} };\n`,
        ),
      new RegExp(`is routed at ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, outside the`),
      path,
    );
  }
  /* And the allowlist is the hosted application's alone. The collaboration rule is
     that *every* routed function sits under `/api/`, because `netlify.toml` excludes
     exactly `/api/*` from the edge gate - so offering the exception to both halves
     would publish a collaboration function from behind a gate the workflow's config
     check still reports as fail-closed. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "pages.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/docs/:documentId" };\n',
      ),
    /pages\.mjs is routed at \/docs\/:documentId, outside the \/api\/\* edge-gate exclusion/,
  );
});

test("two functions cannot claim the same route", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-duplicate.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/api/hosted/thing" };\n',
      ),
    /already claimed by/,
  );
  /* A single-element array is the spelling the old string-only route map skipped
     entirely: `typeof path === "string"` is false, so the route was never
     recorded and a collision with it was never reported. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "hosted-arrayed.mjs"),
        'export default async () => new Response();\nexport const config = { path: ["/api/hosted/thing"] };\n',
      ),
    /claims \/api\/hosted\/thing, already claimed by/,
  );
  /* And one map across both halves, not two: before the merge each deployment had
     its own gate, so nothing could have said that a collaboration function and a
     hosted one collide. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "functions", "poacher.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/api/hosted/thing" };\n',
      ),
    /claims \/api\/hosted\/thing, already claimed by/,
  );
});

test("an unresolvable import and a missing named export both fail", () => {
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "missing.mjs"),
        'import { x } from "./nowhere.mjs";\nexport const y = x;\n',
      ),
    /FAIL netlify modules: netlify\/lib\/hosted\/missing\.mjs/,
  );
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "absent.mjs"),
        'import { notThere } from "./ok.mjs";\nexport const y = notThere;\n',
      ),
    /FAIL netlify modules: netlify\/lib\/hosted\/absent\.mjs/,
  );
});

test("a CommonJS module cannot smuggle a require() past the resolution hook", () => {
  /* The gate reads the boundary rules off an ESM `resolve` hook, and Node never
     consults that hook for a `require()`. So this exact tree - a `.cjs` module in
     a deploy directory requiring something outside the tree - loaded, linked and
     printed PASS while reaching straight out. The escape is closed at the
     filename, so the assertion is on the extension rule rather than on the
     boundary message: there is no reading of a `.cjs` file that this gate can
     check, so it never gets that far. */
  assertRejected(
    (root, deploy) => {
      write(join(root, OUTSIDE_DIR, "legacy.cjs"), "module.exports = { legacy: true };\n");
      write(
        join(deploy, "lib", "hosted", "leak.cjs"),
        `module.exports = require("../../../${OUTSIDE_DIR}/legacy.cjs");\n`,
      );
    },
    /leak\.cjs is \.cjs; the deploy tree is \.mjs only, because a CommonJS require\(\) graph is invisible/,
  );
});

test("an .mjs module cannot build a require() with createRequire", () => {
  /* The extension rule stops `leak.cjs`; it does not stop an allowed `.mjs` file
     from importing `createRequire` out of `node:module` and requiring the same
     file through it. That tree printed PASS. All three doors are asserted here,
     because each one closes a case the others do not: the lexical name reaches a
     function body nothing calls, the builtin allowlist is what makes
     `node:module` unreachable by import, and the resolution fault is the
     synchronous hook seeing a `require()` edge at all - the thing the
     asynchronous hook this gate used to register could not do. */
  const stderr = assertRejected(
    (root, deploy) => {
      write(join(root, OUTSIDE_DIR, "legacy.cjs"), "module.exports = { legacy: true };\n");
      write(
        join(deploy, "lib", "hosted", "leak.mjs"),
        'import { createRequire } from "node:module";\n' +
          "const require = createRequire(import.meta.url);\n" +
          `export const leak = require("../../../${OUTSIDE_DIR}/legacy.cjs").legacy;\n`,
      );
    },
    /leak\.mjs names createRequire; the hosted deploy tree may not acquire a CommonJS require/,
  );
  assert.match(stderr, /leak\.mjs imports node:module, which is not one of the builtins/);
  assert.match(
    stderr,
    new RegExp(`leak\\.mjs imports \\.\\./\\.\\./\\.\\./${OUTSIDE_DIR}/legacy\\.cjs, which resolves outside netlify/`),
  );
});

test("a require() acquired inside a function nothing calls is still refused", () => {
  /* No hook, synchronous or otherwise, observes this: the module links, the body
     never runs, and the escape waits for the first production request. Which is
     why the rule is spelled lexically as well as read off resolutions.
     `process.getBuiltinModule` is the sharper half of the pair - it reaches
     `node:module` off a global, so there is no resolution for the builtin
     allowlist to judge even when the code does run. */
  for (const [name, body] of [
    ["createRequire", "const build = createRequire;"],
    ["getBuiltinModule", 'const { createRequire: build } = process.getBuiltinModule("node:module");'],
  ]) {
    assertRejected(
      (root, deploy) => {
        write(join(root, OUTSIDE_DIR, "legacy.cjs"), "module.exports = { legacy: true };\n");
        write(
          join(deploy, "lib", "hosted", "later.mjs"),
          "export async function onRequest() {\n" +
            `  ${body}\n` +
            `  return build(import.meta.url)("../../../${OUTSIDE_DIR}/legacy.cjs");\n` +
            "}\n",
        );
      },
      new RegExp(`later\\.mjs names ${name}; the hosted deploy tree may not acquire a CommonJS require`),
    );
  }
});

test("a builtin nobody argued for is refused rather than allowed by default", () => {
  /* The rule is an allowlist so that the next builtin with a hole in it is
     refused before anyone notices it exists. `node:child_process` is the
     illustration: nothing in a hosted deploy needs it, and a denylist written
     around `node:module` would have let it through. */
  assertRejected(
    (root, deploy) =>
      write(
        join(deploy, "lib", "hosted", "spawner.mjs"),
        'import { spawnSync } from "node:child_process";\nexport const run = spawnSync;\n',
      ),
    /spawner\.mjs imports node:child_process, which is not one of the builtins the hosted deploy tree may import/,
  );
});

test("a .js module is refused, because its module system is not in the filename", () => {
  /* `.js` is whatever the nearest `package.json` says it is, and that manifest is
     not a file this gate reads - a nested `{"type":"commonjs"}` would turn the
     module below back into the `require()` graph the rule above closes, with the
     deploy tree untouched. */
  assertRejected(
    (root, deploy) => {
      write(join(deploy, "lib", "hosted", "nested", "package.json"), JSON.stringify({ type: "commonjs" }));
      write(
        join(deploy, "lib", "hosted", "nested", "leak.js"),
        `module.exports = require("../../../../${OUTSIDE_DIR}/legacy.mjs");\n`,
      );
    },
    /leak\.js is \.js; the deploy tree is \.mjs only/,
  );
});

test("TypeScript in a deploy directory, and a test file in the hosted tree, are refused", () => {
  assertRejected(
    (root, deploy) => write(join(deploy, "lib", "typed.ts"), "export const typed: boolean = true;\n"),
    /is \.ts; the deploy tree is \.mjs only, because TypeScript is not JavaScript/,
  );
  for (const path of [
    ["lib", "hosted", "ok.test.mjs"],
    ["functions", "hosted-handler.test.mjs"],
  ]) {
    assertRejected(
      (root, deploy) => write(join(deploy, ...path), "export const spec = 1;\n"),
      /is a test file inside a deployed directory; it belongs in netlify\/test\//,
    );
  }
});

test("a symlink inside the deploy tree is refused rather than followed", () => {
  assertRejected(
    (root, deploy) => symlinkSync(join(root, OUTSIDE_DIR), join(deploy, "lib", "hosted", "legacy")),
    /is a symbolic link/,
  );
});

test("a missing --root is a failure, not an empty successful scan", () => {
  const result = spawnSync(process.execPath, [GATE, "--root", join(tmpdir(), "does-not-exist-here")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not exist/);
});

test("a dependency cannot launder a require to a handler nothing calls", () => {
  /* The transitive capability rule, and the exact tree that passed every rule
     before it: no hosted file spells `createRequire` or `getBuiltinModule`, the
     require is built inside a handler this gate never invokes, and the package is
     properly declared - so the lexical rules saw nothing and the resolution rules
     judged only first-party parents. What the dependency cannot hide is its own
     top-level import of `node:module`, which happens the moment the hosted module
     links against it, and that edge is now judged like any other. */
  assertRejected(
    (root, deploy) => {
      write(join(root, OUTSIDE_DIR, "legacy.cjs"), "module.exports = { legacy: true };\n");
      installPackage(
        join(root, "node_modules"),
        "loader-pkg",
        'import { createRequire } from "node:module";\nexport const makeLoader = createRequire;\n',
      );
      writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0", "loader-pkg": "1.0.0" });
      write(
        join(deploy, "lib", "hosted", "launder.mjs"),
        'import { makeLoader as build } from "loader-pkg";\n' +
          "export async function onRequest() {\n" +
          `  return build(import.meta.url)("../../../${OUTSIDE_DIR}/legacy.cjs");\n` +
          "}\n",
      );
    },
    /loader-pkg\/index\.mjs, loaded by the hosted tree, imports node:module, which hands out a CommonJS require/,
  );
});

test("a dependency that fetches node:module off the global is caught by capability, not by text", () => {
  /* `process.getBuiltinModule` consults no resolver, so the first half of the
     rule cannot see it and the dependency's source is not something this gate
     reads. The call itself is the only observer, so the function is wrapped while
     the tree loads. The name is assembled at runtime here on purpose: any check
     that read the package's text would miss this, and the point of the door is
     that it does not read text. */
  assertRejected(
    (root, deploy) => {
      installPackage(
        join(root, "node_modules"),
        "sneaky-pkg",
        'const name = "mod" + "ule";\nexport const mod = process.getBuiltinModule(name);\n',
      );
      writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0", "sneaky-pkg": "1.0.0" });
      write(
        join(deploy, "lib", "hosted", "uses.mjs"),
        'import { mod } from "sneaky-pkg";\nexport const held = mod;\n',
      );
    },
    /called process\.getBuiltinModule\("module"\), which hands out a CommonJS require/,
  );
});

test("a dependency cannot resolve out of the deploy tree either", () => {
  assertRejected(
    (root, deploy) => {
      installPackage(
        join(root, "node_modules"),
        "climber-pkg",
        `export { legacy } from "../../${OUTSIDE_DIR}/legacy.mjs";\n`,
      );
      writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0", "climber-pkg": "1.0.0" });
      write(
        join(deploy, "lib", "hosted", "climbs.mjs"),
        'import { legacy } from "climber-pkg";\nexport const held = legacy;\n',
      );
    },
    new RegExp(
      `climber-pkg/index\\.mjs, loaded by the hosted tree, imports \\.\\./\\.\\./${OUTSIDE_DIR}/legacy\\.mjs, which resolves outside the hosted subtree`,
    ),
  );
});

test("an identifier spelled in escapes is the same identifier", () => {
  /* `createRequire` and `process.getBuiltinModule` are what the parser reads as
     the two banned names, and were different text to a raw scan - the whole
     bypass costs one backslash. Both spellings are written here as escapes on
     purpose; the assertion is that the gate reports the decoded name. */
  for (const [name, source] of [
    [
      "createRequire",
      "export async function onRequest(here, mod) {\n" +
        "  const { create\\u0052equire: build } = mod;\n" +
        `  return build(here)("../../../${OUTSIDE_DIR}/legacy.cjs");\n` +
        "}\n",
    ],
    [
      "getBuiltinModule",
      "export async function onRequest(here) {\n" +
        '  const m = process.getBuiltin\\u004dodule("node:module");\n' +
        `  return m.mk(here)("../../../${OUTSIDE_DIR}/legacy.cjs");\n` +
        "}\n",
    ],
    /* The braced form is a separate branch of the decoding pattern, and a separate
       spelling of the same identifier: `\u{52}` needs no leading zeros, so a
       four-hex-digit pattern alone reads it as prose. */
    [
      "createRequire",
      "export async function onRequest(here, mod) {\n" +
        "  const { c\\u{72}eateRequire: build } = mod;\n" +
        `  return build(here)("../../../${OUTSIDE_DIR}/legacy.cjs");\n` +
        "}\n",
    ],
  ]) {
    assertRejected(
      (root, deploy) => write(join(deploy, "lib", "hosted", "escaped.mjs"), source),
      new RegExp(`escaped\\.mjs names ${name}; the hosted deploy tree may not acquire a CommonJS require`),
    );
  }
});

test("a --root reached through a symlink is judged, not silently skipped", () => {
  /* `path.resolve` makes a root absolute; it does not canonicalise it. Node
     reports realpath'd URLs, so an absolute-but-symlinked root disagreed with
     every scanned path exactly as a relative one did, and the gate printed PASS
     over a planted escape. This is not exotic: `os.tmpdir()` is a symlink on
     macOS, so the whole suite would have run against a gate judging nothing. */
  const root = cleanTree();
  write(
    join(root, DEPLOY_DIR, "lib", "hosted", "leak.mjs"),
    `import { legacy } from "../../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
  );
  const link = mkdtempSync(join(tmpdir(), "deploy-gate-link-"));
  roots.push(link);
  const alias = join(link, "checkout");
  symlinkSync(root, alias);

  const { status, stdout, stderr } = runGate(alias);
  assert.equal(status, 1, `expected the gate to fail; it printed:\n${stdout}${stderr}`);
  assert.match(stderr, /resolves outside netlify\//);
});

test("a module that loads while naming no resolution record fails closed", () => {
  /* The backstop behind every root-spelling bug, provoked here by a `netlify`
     directory that is itself a symlink. Placement passes, because containment
     resolves both sides; the module links, because its escape resolves at the
     real location. But the scan walked `<root>/netlify/...` while Node reports
     the link target, so no record names any scanned module, every boundary rule
     judges an empty set - and the escape goes unreported while the gate prints
     PASS. Asserting the invariant directly means the next spelling that disagrees
     does not have to be predicted first. */
  const root = mkdtempSync(join(tmpdir(), "deploy-gate-alias-"));
  const away = mkdtempSync(join(tmpdir(), "deploy-gate-away-"));
  roots.push(root, away);

  writeManifest(root, {});
  write(join(away, OUTSIDE_DIR, "legacy.mjs"), "export const legacy = true;\n");
  write(
    join(away, DEPLOY_DIR, "lib", "hosted", "leak.mjs"),
    `import { legacy } from "../../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
  );
  symlinkSync(join(away, DEPLOY_DIR), join(root, DEPLOY_DIR));

  const { status, stdout, stderr } = runGate(root);
  assert.equal(status, 1, `expected the gate to fail; it printed:\n${stdout}${stderr}`);
  assert.match(stderr, /loaded but names no resolution record/);
});

test("a relative --root is judged, not silently skipped", () => {
  /* Every scanned path is derived from `--root` while the resolution records come
     back as absolute file URLs, so a relative root made no scanned module match
     its own record: each boundary rule judged an empty set and the gate printed
     PASS over a tree it had already read the escape out of. */
  const root = cleanTree();
  write(
    join(root, DEPLOY_DIR, "lib", "hosted", "leak.mjs"),
    `import { legacy } from "../../../${OUTSIDE_DIR}/legacy.mjs";\nexport const leak = legacy;\n`,
  );
  const result = spawnSync(process.execPath, [GATE, "--root", "."], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 1, `expected the gate to fail; it printed:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /resolves outside netlify\//);
});

test("the manifest may not permit a Node the gate cannot run on", () => {
  /* The mechanism the whole gate rests on - synchronous resolution hooks -
     arrived in Node 22.15.0. A manifest that permits an older runtime is a claim
     the deploy does not keep, and the symptom on such a Node would be this gate
     crashing rather than a readable answer. */
  assertRejected(
    (root) => writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0" }, { node: ">=22.12.0" }),
    /permits Node 22\.12\.0, below the 22\.15\.0 that provides module\.registerHooks/,
  );
  assertRejected(
    (root) => writeManifest(root, { "allowed-pkg": "1.0.0", tldts: "1.0.0" }, { node: "^22" }),
    /declares engines\.node "\^22"; it must be a `>=` floor/,
  );
});

test("the real manifest, lockfile and deploy runtime agree on that floor", () => {
  /* The checks above are planted trees; this one is the shipping tree. All three
     places that name a runtime have to admit only Nodes that carry the mechanism,
     or a green gate here says nothing about the runtime the deploy actually
     gets. */
  const repo = dirname(HERE);
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.match(manifest.engines.node, /^>=22\.15\.0$/);

  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  assert.deepEqual(lock.packages[""].engines, manifest.engines);

  const toml = readFileSync(join(repo, "netlify.toml"), "utf8");
  const declared = /^\s*NODE_VERSION\s*=\s*"([^"]+)"/m.exec(toml);
  assert.notEqual(declared, null, "netlify.toml declares no NODE_VERSION");
  const [major, minor] = declared[1].split(".");
  assert.ok(
    Number(major) > 22 || (Number(major) === 22 && (minor === undefined || Number(minor) >= 15)),
    `netlify.toml pins NODE_VERSION ${declared[1]}, which can resolve below 22.15.0`,
  );

  /* And the interpreter running this suite satisfies the same floor, so a passing
     run is evidence about a supported runtime rather than about whatever happened
     to be installed. */
  assert.equal(typeof registerHooks, "function");
  assert.ok(Number(process.versions.node.split(".")[0]) >= 22);
});
