/**
 * Regressions for `scripts/check-hosted-modules.mjs`.
 *
 * A verification mechanism with no test of its own is the one kind of code
 * whose failure is permanently silent: an edit that empties the fault list or
 * inverts the exit condition leaves CI green forever, and the only signal would
 * be a hosted deploy 404ing or a handler quietly importing the legacy identity
 * tree. This gate shipped without a test and three planted faults - a module
 * outside `hosted/functions/`, a handler routed outside the API namespace, and
 * an import of `netlify/lib/` hidden behind a regex literal - were all reported
 * as `PASS`.
 *
 * So every rule the gate claims gets a tree that violates exactly that rule and
 * an assertion that the gate fails on it, plus a clean tree that must pass. The
 * clean-tree case is not a formality: it is what stops a gate that fails on
 * everything from looking healthy.
 *
 * Each case runs the gate as a child process against a temporary checkout-shaped
 * directory, because the gate registers a module-resolution hook and a hook is
 * process-wide.
 *
 *   node --test scripts/check-hosted-modules.test.mjs
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "check-hosted-modules.mjs");

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

/** A tiny installed package, so dependency resolution has something to find. */
function installPackage(nodeModules, name) {
  write(join(nodeModules, name, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.mjs" }));
  write(join(nodeModules, name, "index.mjs"), "export const value = 1;\n");
}

/**
 * A checkout-shaped tree that the gate should pass.
 *
 * It carries the two things a real repository has and a naive fixture would
 * not: a package installed at the *root* (which Node's upward resolution puts
 * on the hosted module's path) and a `hosted/test/` directory to import by
 * mistake.
 */
function cleanTree() {
  const root = mkdtempSync(join(tmpdir(), "hosted-gate-"));
  roots.push(root);
  const hosted = join(root, HOSTED_DIR);

  installPackage(join(root, "node_modules"), "hoisted-pkg");
  installPackage(join(hosted, "node_modules"), "allowed-pkg");
  installPackage(join(hosted, "node_modules"), "undeclared-pkg");

  write(
    join(hosted, "package.json"),
    JSON.stringify({ name: "hosted", private: true, type: "module", dependencies: { "allowed-pkg": "1.0.0" } }),
  );
  write(join(root, "netlify", "lib", "identity.mjs"), "export const legacy = true;\n");
  write(join(hosted, "test", "fixtures.mjs"), "export const FIXTURE = 1;\n");
  write(join(hosted, "public", "index.html"), "<!doctype html><html><body></body></html>\n");
  write(join(hosted, "public", "app.js"), "// a browser asset, not a deploy module\n");
  write(
    join(hosted, "lib", "ok.mjs"),
    'import { value } from "allowed-pkg";\nimport { createHash } from "node:crypto";\nexport const ok = value && typeof createHash === "function";\n',
  );
  write(
    join(hosted, "functions", "handler.mjs"),
    'import { ok } from "../lib/ok.mjs";\nexport default async () => new Response(String(ok));\nexport const config = { path: "/api/hosted/thing" };\n',
  );
  return root;
}

const HOSTED_DIR = "hosted";

/** Run the gate against `root` and return its exit code and stderr. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Build a clean tree, apply `plant`, and assert the gate fails with `pattern`. */
function assertRejected(plant, pattern) {
  const root = cleanTree();
  plant(root, join(root, HOSTED_DIR));
  const { status, stderr } = runGate(root);
  assert.equal(status, 1, `expected the gate to fail; it printed:\n${stderr}`);
  assert.match(stderr, pattern);
  return stderr;
}

test("a clean hosted tree passes, and the count is real", () => {
  const { status, stdout, stderr } = runGate(cleanTree());
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^PASS hosted modules: 2 modules load and link \(1 routed functions\)$/m);
});

test("a module that reaches into the legacy tree is refused", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "leak.mjs"),
        'import { legacy } from "../../netlify/lib/identity.mjs";\nexport const leak = legacy;\n',
      ),
    /resolves outside hosted\//,
  );
});

test("a regex literal cannot hide an escaping import", () => {
  /* The exact input the old text scanner mis-read: `//` inside a regex literal
     made it treat the rest of the line as a comment, so the import below was
     never seen and the gate printed PASS. Asking the resolver has no such
     blind spot. */
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "sneaky.mjs"),
        'export const SCHEME = /^https?:\\/\\//;\nimport { legacy } from "../../netlify/lib/identity.mjs";\nexport const leak = legacy;\n',
      ),
    /resolves outside hosted\//,
  );
});

test("a quote inside a regex literal does not invent an import", () => {
  /* The mirror-image failure: the old scanner flipped into string state here
     and extracted a specifier out of the following comment, failing a build
     over prose. */
  const root = cleanTree();
  write(
    join(root, HOSTED_DIR, "lib", "quoted.mjs"),
    'export const QUOTES = /["\']/;\n/* prose that mentions from "netlify-identity" on purpose */\nexport const fine = true;\n',
  );
  const { status, stderr } = runGate(root);
  assert.equal(status, 0, stderr);
});

test("a deployed module cannot import a test fixture", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "fake.mjs"),
        'import { FIXTURE } from "../test/fixtures.mjs";\nexport const fake = FIXTURE;\n',
      ),
    /fixtures must not reach a deployed module/,
  );
});

test("a package installed only at the repository root is refused", () => {
  /* This is the property the CI step ordering was wrongly claimed to provide.
     Node resolution walks up, so with the root install already done this module
     links perfectly - and would fail on a clean hosted install. */
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "hoisted.mjs"),
        'import { value } from "hoisted-pkg";\nexport const v = value;\n',
      ),
    /hoisted-pkg, which resolves outside hosted\/node_modules/,
  );
});

test("an installed package that the manifest does not declare is refused", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "undeclared.mjs"),
        'import { value } from "undeclared-pkg";\nexport const v = value;\n',
      ),
    /undeclared-pkg, which is not a dependency/,
  );
});

test("reaching node_modules by relative path is refused", () => {
  /* A relative path into `node_modules` looks like a local file and would
     otherwise skip the manifest rule entirely. */
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "lib", "byPath.mjs"),
        'import { value } from "../node_modules/allowed-pkg/index.mjs";\nexport const v = value;\n',
      ),
    /reaching node_modules by path instead of by package name/,
  );
});

test("dynamic import is refused however its specifier is spelled", () => {
  for (const body of [
    'export async function load() { return import("../test/fixtures.mjs"); }\n',
    "export async function load() { return import(`../../netlify/lib/identity.mjs`); }\n",
    'export async function load(n) { return import("../lib/" + n); }\n',
  ]) {
    assertRejected(
      (root, hosted) => write(join(hosted, "lib", "dynamic.mjs"), body),
      /uses dynamic import/,
    );
  }
});

test("dynamic import is refused when a comment separates the two tokens", () => {
  /* `import` and `(` are separate tokens, so every form below is the same
     dynamic import as `import(`. A whitespace-only text search reads them as
     prose, and because the expression sits in a function nobody calls, the
     resolution hook never sees the escape out of `hosted/` either - the file
     would deploy with both the ban and the boundary rules bypassed. */
  for (const body of [
    'export async function load() { return import/* legacy */("../../netlify/lib/identity.mjs"); }\n',
    'export async function load() { return import /*\n multi\n line\n*/ ("../test/fixtures.mjs"); }\n',
    'export async function load() { return import // trailing\n("../../netlify/lib/identity.mjs"); }\n',
    'export async function load() { return import/*a*/ /*b*/\t("../test/fixtures.mjs"); }\n',
  ]) {
    assertRejected(
      (root, hosted) => write(join(hosted, "lib", "commented.mjs"), body),
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
    join(root, HOSTED_DIR, "lib", "named.mjs"),
    "function reimport(x) { return x; }\nexport const v = reimport(1);\n",
  );
  const { status, stderr } = runGate(root);
  assert.equal(status, 0, stderr);
});

test("deployable code outside lib/ and functions/ is refused rather than unscanned", () => {
  for (const where of ["edge-functions", "handlers", "middleware"]) {
    assertRejected(
      (root, hosted) =>
        write(
          join(hosted, where, "leak.mjs"),
          'import { legacy } from "../../netlify/lib/identity.mjs";\nexport default async () => new Response(String(legacy));\n',
        ),
      /is deployable code outside hosted\/\{lib,functions\}\//,
    );
  }
});

test("a functions directory that exists and is empty is a failure", () => {
  assertRejected((root, hosted) => {
    rmSync(join(hosted, "functions", "handler.mjs"));
  }, /hosted\/functions\/ exists but contains no loadable module/);
});

test("a tree with no deployable modules at all is a failure", () => {
  assertRejected((root, hosted) => {
    rmSync(join(hosted, "lib"), { recursive: true, force: true });
    rmSync(join(hosted, "functions"), { recursive: true, force: true });
  }, /no modules found under hosted\/\{lib,functions\}\//);
});

test("a function must present the entry point Netlify invokes", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "functions", "noHandler.mjs"),
        'export const config = { path: "/api/hosted/other" };\n',
      ),
    /does not export a callable default handler/,
  );
  assertRejected(
    (root, hosted) =>
      write(join(hosted, "functions", "noConfig.mjs"), "export default async () => new Response();\n"),
    /does not export a config object/,
  );
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "functions", "unrouted.mjs"),
        "export default async () => new Response();\nexport const config = {};\n",
      ),
    /declares neither a path nor a schedule/,
  );
});

test("a route outside the hosted API namespace is refused, arrays included", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "functions", "admin.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/admin/secret" };\n',
      ),
    /is routed at \/admin\/secret, outside the \/api\/hosted\/\* hosted API namespace/,
  );
  /* An array of paths was flattened with `String()`, producing one comma-joined
     string that started with the allowed prefix - so the second route escaped
     both the namespace check and the duplicate-route map. */
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "functions", "both.mjs"),
        'export default async () => new Response();\nexport const config = { path: ["/api/hosted/ok", "/admin/secret"] };\n',
      ),
    /is routed at \/admin\/secret/,
  );
});

test("two functions cannot claim the same route", () => {
  assertRejected(
    (root, hosted) =>
      write(
        join(hosted, "functions", "duplicate.mjs"),
        'export default async () => new Response();\nexport const config = { path: "/api/hosted/thing" };\n',
      ),
    /already claimed by/,
  );
});

test("an unresolvable import and a missing named export both fail", () => {
  assertRejected(
    (root, hosted) =>
      write(join(hosted, "lib", "missing.mjs"), 'import { x } from "./nowhere.mjs";\nexport const y = x;\n'),
    /FAIL hosted modules: hosted\/lib\/missing\.mjs/,
  );
  assertRejected(
    (root, hosted) =>
      write(join(hosted, "lib", "absent.mjs"), 'import { notThere } from "./ok.mjs";\nexport const y = notThere;\n'),
    /FAIL hosted modules: hosted\/lib\/absent\.mjs/,
  );
});

test("TypeScript and test files inside a deployed directory are refused", () => {
  assertRejected(
    (root, hosted) => write(join(hosted, "lib", "typed.ts"), "export const typed: boolean = true;\n"),
    /is \.ts; the hosted deploy tree is plain JavaScript/,
  );
  assertRejected(
    (root, hosted) => write(join(hosted, "lib", "ok.test.mjs"), "export const spec = 1;\n"),
    /is a test file inside a deployed directory/,
  );
});

test("a symlink inside the hosted tree is refused rather than followed", () => {
  assertRejected(
    (root, hosted) => symlinkSync(join(root, "netlify", "lib"), join(hosted, "lib", "legacy")),
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
