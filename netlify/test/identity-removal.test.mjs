/**
 * The removals ACN-006 promised, asserted against the repository itself.
 *
 * Every property here is one a grep would answer and a future edit could
 * silently undo. The password login, the password-setting invitation
 * acceptance and the pinned identity package are not deprecated, discouraged or
 * unreachable — they are gone, and "gone" is only a durable claim if something
 * fails when one comes back.
 *
 * The file list comes from `git ls-files`, so an installed dependency, a build
 * artifact and a scratch file are all outside the question by construction.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function trackedFiles() {
  return execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((path) => path !== "");
}

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Source with block and line comments stripped, so prose cannot fail a check. */
function code(path) {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const SOURCE_EXTENSIONS = [".mjs", ".js", ".ts", ".json"];
const DOCUMENTATION = ["docs/", "research/", "how-archon-works/", "README.md", "website/"];

/**
 * This file, excluded from its own scan.
 *
 * It has to name what it is looking for in order to look for it, so a scanner
 * that scanned itself would report itself: the first version of this suite
 * failed on `safeNext` the moment it was committed, having found the only
 * occurrence left in the repository — its own assertion.
 */
const SELF = "netlify/test/identity-removal.test.mjs";

function isProductionSource(path) {
  if (path === SELF) return false;
  if (DOCUMENTATION.some((prefix) => path.startsWith(prefix))) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/* -------------------------------------------------------------------------- */

test("no module imports the legacy identity package", () => {
  const offenders = trackedFiles()
    .filter(isProductionSource)
    .filter((path) => !path.endsWith("package-lock.json"))
    .filter((path) => /from\s*["']@netlify\/identity["']|require\(\s*["']@netlify\/identity["']/
      .test(code(path)));
  assert.deepEqual(offenders, [], "these files still import @netlify/identity");
});

test("the manifest and the lockfile no longer name the package", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.equal("@netlify/identity" in (manifest.dependencies ?? {}), false);
  assert.equal("@netlify/identity" in (manifest.devDependencies ?? {}), false);
  assert.equal(read("package-lock.json").includes("@netlify/identity"), false);
});

test("the password login and logout routes no longer exist", () => {
  const tracked = new Set(trackedFiles());
  for (const gone of [
    "netlify/functions/login.mjs",
    "netlify/functions/logout.mjs",
    "netlify/functions/accept.mjs",
  ]) {
    assert.equal(tracked.has(gone), false, `${gone} is deleted`);
  }
});

test("no function declares the removed routes", () => {
  const declared = trackedFiles()
    .filter((path) => path.startsWith("netlify/functions/") && path.endsWith(".mjs"))
    .filter((path) => !path.endsWith(".test.mjs"))
    .flatMap((path) => {
      const match = /export\s+const\s+config\s*=\s*({[\s\S]*?});/.exec(code(path));
      if (match === null) return [];
      const paths = [...match[1].matchAll(/["'`](\/[^"'`]*)["'`]/g)].map((m) => m[1]);
      return paths.map((route) => [route, path]);
    });
  const routes = new Map(declared);
  for (const gone of ["/api/login", "/api/logout", "/api/accept"]) {
    assert.equal(routes.has(gone), false, `${gone} is answered by ${routes.get(gone)}`);
  }
  assert.ok(routes.has("/api/session"), "and the surviving session route is still declared");
});

test("`safeNext` did not survive the file it lived in", () => {
  const offenders = trackedFiles()
    .filter(isProductionSource)
    .filter((path) => code(path).includes("safeNext"));
  assert.deepEqual(offenders, [], "the legacy destination allowlist is still live somewhere");
});

test("the publish tree holds exactly one sign-in page", () => {
  // A file collision, not only a routing one: both trees wrote
  // `login/index.html` into `_site/` and the copy order decided the winner.
  const pages = trackedFiles().filter((path) => path.endsWith("login/index.html"));
  assert.deepEqual(pages, ["netlify/public/login/index.html"]);
});

test("the site builder no longer copies a root login tree", () => {
  const source = code("templates/docbuild/src/site.ts");
  const match = /const STATIC_PAGES = (\[[^\]]*\]);/.exec(source);
  assert.notEqual(match, null, "STATIC_PAGES is still the list of root page trees");
  assert.equal(match[1].includes('"login"'), false, "and no longer names login");
  assert.ok(match[1].includes('"invite"'), "while the invitation page is still copied");
});

test("the organisation email setting is gone from every deployed module", () => {
  const offenders = trackedFiles()
    .filter((path) => path.startsWith("netlify/"))
    .filter(isProductionSource)
    .filter((path) => !path.endsWith(".test.mjs"))
    .filter((path) => /ORG_EMAIL_DOMAIN|isOrgEmail|\bisOrg\b/.test(code(path)));
  assert.deepEqual(offenders, [], "these deployed modules still read an organisation rule");
});

test("the invitation page is a sign-in prompt and carries no token anywhere", () => {
  const page = read("invite/index.html");
  assert.ok(page.includes('href="/login/"'), "it points at the one sign-in page");

  const markup = page.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(/<form/i.test(markup), false, "no form: the header set forbids form-action");
  assert.equal(/<script/i.test(markup), false, "and no script, because there is nothing to do");
  assert.equal(/type=["']password["']/i.test(markup), false, "and certainly no password field");
  assert.equal(/recovery_token/.test(markup), false, "the recovery token has no successor");
  assert.equal(/destination=|[?&]token=/.test(markup), false,
    "and nothing is carried onward in a query string");
});
