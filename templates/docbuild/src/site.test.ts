/**
 * Unit coverage for the publish tree of a repo-backed site build.
 *
 * This unit is packaging, so what is asserted is an inventory: which files a
 * build puts where. `_site/` is deleted and rebuilt every time, so a surface
 * this module does not copy is a surface that silently stops being served, and
 * an inventory test is the only shape of assertion that catches a missing one.
 *
 * Three groups of property. The served committed content -- a committed
 * `site/index.html` is what `_site/` publishes at the root, a repository that
 * commits none of it still gets the generated list page it got before, and the
 * served skill is byte-identical to the one source the package publishes. The
 * merged hosted surfaces -- the hosted application's static tree, the hosted
 * sign-in page winning the `login/` collision, the `/publish/authorize` rewrite,
 * and the reserved routes that stop a document slug shadowing any of them. And
 * the renderer shell, which is a build rather than a copy: exactly four files
 * under `_render/`, no `_headers` beside them, and nothing at all when the
 * deployment is not configured for one.
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
const AGENTS = "# Archon, for agents\n\nnpx aiur-archon\n";
const LLMS = "# Archon\n\n> One self-contained HTML file.\n";
const SKILL = "---\nname: archon-doc\n---\n\nThe complete instruction set.\n";

/** The root sign-in page, and the hosted one that has to beat it. */
const ROOT_LOGIN = "<!doctype html><title>root login</title>\n";
const HOSTED_LOGIN = "<!doctype html><title>hosted login</title>\n";

/** Two origins on two registrable sites, which is what the renderer requires. */
const APP_ORIGIN = "https://app.example.com";
const RENDER_ORIGIN = "https://render.example.net";

interface Ctx {
  after: (fn: () => void) => void;
}

/** The repository this test was compiled inside, for the trees it copies in. */
const checkout = (): string => repoRoot(dirname(fileURLToPath(import.meta.url)));

/**
 * Set the renderer's two configuration keys for one test, or clear them.
 *
 * They are read from `process.env` at build time, and a value left behind would
 * decide a later test's answer, so every case that cares states both.
 */
const origins = (t: Ctx, values: { app?: string; render?: string } = {}): void => {
  const previous = {
    HOSTED_APP_ORIGIN: process.env.HOSTED_APP_ORIGIN,
    HOSTED_RENDER_ORIGIN: process.env.HOSTED_RENDER_ORIGIN,
  };
  const set = (key: keyof typeof previous, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set("HOSTED_APP_ORIGIN", values.app);
  set("HOSTED_RENDER_ORIGIN", values.render);
  t.after(() => {
    set("HOSTED_APP_ORIGIN", previous.HOSTED_APP_ORIGIN);
    set("HOSTED_RENDER_ORIGIN", previous.HOSTED_RENDER_ORIGIN);
  });
};

/**
 * A throwaway root carrying the real base assets and one document. `served`
 * adds the committed homepage tree, the skill tree and the served root files;
 * omitting it is the repository that commits none of them.
 */
const root = (
  t: Ctx,
  options: {
    served?: boolean;
    slug?: string;
    hosted?: boolean;
    renderer?: boolean;
    /** `doc.json`'s `public`, omitted entirely when undefined. */
    documentPublic?: unknown;
    /** The `APP_PUBLIC_DOCUMENT_PATHS` a stand-in edge module exports, or no module. */
    publicPaths?: string[];
  } = {},
): string => {
  const dir = mkdtempSync(join(tmpdir(), "acn001-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  cpSync(resolveBase(checkout()), join(dir, "templates", "base"), { recursive: true });

  // The instance directory and the slug are deliberately separable: a document
  // that claims a reserved route does so in its doc.json, from an ordinary
  // directory that site discovery still walks.
  const slug = options.slug ?? "sample";
  const inst = join(dir, "sample");
  mkdirSync(join(inst, "sections"), { recursive: true });
  writeFileSync(
    join(inst, "doc.json"),
    options.documentPublic === undefined
      ? docJson(slug)
      : docJson(slug).replace('"aliases": [],', `"aliases": [],\n  "public": ${JSON.stringify(options.documentPublic)},`),
  );
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

  /* A stand-in for the deployed gate's own module, carrying only the export the
     public-route preflight reads. The real one is a Deno edge function's helper
     and importing it here would drag the whole header matrix into a packaging
     test; what is under test is that the two lists are held equal, not what
     else that file says. */
  if (options.publicPaths !== undefined) {
    mkdirSync(join(dir, "netlify", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "netlify", "lib", "edge-host.mjs"),
      `export const APP_PUBLIC_DOCUMENT_PATHS = Object.freeze(${JSON.stringify(options.publicPaths)});\n`,
    );
  }

  if (options.hosted === true) {
    // A root login/ tree and a hosted one, so the collision is real rather than
    // assumed. The hosted copy runs second and is the page the merged site has
    // to serve.
    mkdirSync(join(dir, "login"), { recursive: true });
    writeFileSync(join(dir, "login", "index.html"), ROOT_LOGIN);
    mkdirSync(join(dir, "netlify", "public", "login"), { recursive: true });
    mkdirSync(join(dir, "netlify", "public", "publish"), { recursive: true });
    writeFileSync(join(dir, "netlify", "public", "viewer.js"), "export const viewer = 1;\n");
    writeFileSync(join(dir, "netlify", "public", "viewer.css"), ":root { color: red }\n");
    writeFileSync(join(dir, "netlify", "public", "login", "index.html"), HOSTED_LOGIN);
    writeFileSync(join(dir, "netlify", "public", "login", "login.js"), "export const login = 1;\n");
    writeFileSync(join(dir, "netlify", "public", "publish", "authorize.html"), "<!doctype html>\n");
    writeFileSync(join(dir, "netlify", "public", "publish", "authorize.js"), "export const go = 1;\n");
  }

  // The real renderer tree, not a stand-in: `buildRenderer` resolves its own
  // root from its own location and holds `public/` equal to its declared file
  // list, so a copy is the only way to drive the build this deployment runs.
  if (options.renderer === true) {
    cpSync(join(checkout(), "renderer"), join(dir, "renderer"), { recursive: true });
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

test("the committed homepage and agent files are what the site serves", async (t) => {
  isolate(t);
  const dir = root(t, { served: true });

  const { outDir } = await buildSite(dir);

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

test("with no committed homepage the generated list page still stands", async (t) => {
  isolate(t);
  const dir = root(t);

  const { outDir } = await buildSite(dir);

  const index = readFileSync(join(outDir, "index.html"), "utf8");
  assert.match(index, /<title>Architecture docs<\/title>/);
  assert.match(index, /<a href="\/sample\/">/);
});

test("a symbolic link inside the homepage tree fails the build", async (t) => {
  isolate(t);
  const dir = root(t, { served: true });
  symlinkSync(join(dir, "AGENTS.md"), join(dir, "site", "linked.md"));

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /site\/linked\.md: symbolic links are not supported in static page trees/.test(error.message),
  );
});

test("a document that claims the skills route fails as a reserved route", async (t) => {
  isolate(t);
  const dir = root(t, { served: true, slug: "skills" });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError && /reserved site route: skills/.test(error.message),
  );
});

// -------------------------------------------------- the merged hosted surfaces

test("the hosted static tree is published at the root of the site", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, hosted: true });

  const { outDir } = await buildSite(dir);

  // The tree's contents land at the root, which is what makes
  // `/publish/authorize.html` the path the generated rewrite can name.
  assert.deepEqual(bytes(outDir, "viewer.js"), bytes(dir, "netlify", "public", "viewer.js"));
  assert.deepEqual(bytes(outDir, "viewer.css"), bytes(dir, "netlify", "public", "viewer.css"));
  assert.deepEqual(
    bytes(outDir, "publish", "authorize.html"),
    bytes(dir, "netlify", "public", "publish", "authorize.html"),
  );
  assert.deepEqual(
    bytes(outDir, "publish", "authorize.js"),
    bytes(dir, "netlify", "public", "publish", "authorize.js"),
  );
  assert.deepEqual(
    bytes(outDir, "login", "login.js"),
    bytes(dir, "netlify", "public", "login", "login.js"),
  );

  // The collision, decided by copy order: two trees carry `login/index.html`
  // and the hosted sign-in page is the one a merged site serves.
  assert.equal(readFileSync(join(outDir, "login", "index.html"), "utf8"), HOSTED_LOGIN);

  // And the hosted root shell, whatever a future one says, never becomes the
  // site's homepage.
  assert.equal(readFileSync(join(outDir, "index.html"), "utf8"), HOMEPAGE);
});

test("the /publish/authorize rewrite is generated into _redirects", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, hosted: true });

  const { outDir } = await buildSite(dir);

  const redirects = readFileSync(join(outDir, "_redirects"), "utf8");
  // A rewrite, not a redirect: the visitor stays on the path C3 freezes.
  assert.match(redirects, /^\/publish\/authorize \/publish\/authorize\.html 200$/m);
  // Ahead of every document rule, so no alias line can claim it first.
  assert.equal(redirects.split("\n")[0], "/publish/authorize /publish/authorize.html 200");
  // And the page that rule points at is really in the publish tree.
  assert.ok(existsSync(join(outDir, "publish", "authorize.html")));
});

test("a hosted page at an unreserved top-level name fails the build", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, hosted: true });
  mkdirSync(join(dir, "netlify", "public", "status"), { recursive: true });
  writeFileSync(join(dir, "netlify", "public", "status", "index.html"), "<!doctype html>\n");

  // The hosted tree is copied over the same root the documents were written
  // into, and a copy overwrites without asking. Left unreserved, a document
  // with the slug `status` would be silently replaced by this page on a green
  // build, so the list is held equal to the directory instead.
  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /netlify\/public publishes status at the site root, which RESERVED_ROUTES does not reserve/.test(
        error.message,
      ),
  );
});

test("a public document builds only when the gate's public set names its route", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, {
    served: true,
    slug: "example",
    documentPublic: true,
    publicPaths: ["/example/"],
  });

  const { outDir } = await buildSite(dir);
  assert.ok(existsSync(join(outDir, "example", "index.html")), "the public document is published");
});

test("a public document the deployed gate does not serve is a build failure", async (t) => {
  isolate(t);
  origins(t);
  // The silent half of the drift: a document starts declaring itself public and
  // nobody adds its route to the edge module, so it deploys still gated with no
  // diagnostic anywhere.
  const dir = root(t, { served: true, slug: "example", documentPublic: true, publicPaths: [] });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /netlify\/lib\/edge-host\.mjs serves nothing without a session, but the documents declaring 'public': true are \/example\//.test(
        error.message,
      ),
  );
});

test("a gate public route no document declares is a build failure", async (t) => {
  isolate(t);
  origins(t);
  /* The dangerous half. `/example/` stands in the edge module with no document
     behind it, so whatever claims the `example` slug next inherits a route that
     is served with no session check. Holding the two lists equal is what makes
     this a failed build rather than a quietly published private document. */
  const dir = root(t, { served: true, slug: "sample", publicPaths: ["/example/"] });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /serves \/example\/ without a session, but the documents declaring 'public': true are none/.test(
        error.message,
      ),
  );
});

test("a public document with no edge module to serve it is a build failure", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, slug: "example", documentPublic: true });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /\/example\/ declare 'public': true, but netlify\/lib\/edge-host\.mjs is absent/.test(error.message),
  );
});

test("'public' must be a boolean when a document states it", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, documentPublic: "yes" });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /sample\/doc\.json: invalid 'public' \(expected a boolean when present\)/.test(error.message),
  );
});

test("a document that says nothing about publicity is gated, and needs no edge module", async (t) => {
  isolate(t);
  origins(t);
  // The default every existing document and every installed consumer relies on:
  // absent means gated, and a deployment with no public surface is unaffected.
  const dir = root(t, { served: true });

  const { outDir } = await buildSite(dir);
  assert.ok(existsSync(join(outDir, "sample", "index.html")), "the gated document still publishes");
});

test("with no hosted tree the site publishes no rewrite to a page it lacks", async (t) => {
  isolate(t);
  origins(t);
  // An installed consumer building their own documents has no netlify/public.
  const dir = root(t, { served: true });

  const { outDir } = await buildSite(dir);

  const redirects = readFileSync(join(outDir, "_redirects"), "utf8");
  assert.ok(!redirects.includes("/publish/authorize"), `a rewrite named a page that was never copied: ${redirects}`);
  assert.equal(existsSync(join(outDir, "publish")), false);
  assert.ok(existsSync(join(outDir, "sample", "index.html")));
});

test("a document that claims a hosted top-level route fails as a reserved route", async (t) => {
  isolate(t);
  origins(t);

  for (const slug of ["docs", "publish"]) {
    const dir = root(t, { served: true, hosted: true, slug });
    await assert.rejects(
      buildSite(dir),
      (error: unknown) =>
        error instanceof BuildError &&
        new RegExp(`reserved site route: ${slug} \\(sample\\)`).test(error.message),
      `a slug of ${slug} was allowed to shadow a hosted route`,
    );
  }
});

test("a document cannot claim the renderer route at all", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, hosted: true, slug: "_render" });

  // `_render` is in the reserved set, but a slug can never reach that check:
  // the slug grammar admits no leading underscore, so the build refuses it one
  // step earlier. Either way it is refused, and this is which way.
  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError && /sample\/doc\.json: missing or invalid 'slug'/.test(error.message),
  );
});

// ----------------------------------------------------------- the render shell

test("the renderer shell is published as exactly four files under _render", async (t) => {
  isolate(t);
  origins(t, { app: APP_ORIGIN, render: RENDER_ORIGIN });
  const dir = root(t, { served: true, hosted: true, renderer: true });

  const { outDir } = await buildSite(dir);

  // No `_headers`: on one site the edge gate is the only header authority, and
  // a file here would be a second one the gate cannot see.
  assert.deepEqual(readdirSync(join(outDir, "_render")).sort(), [
    "index.html",
    "renderer-config.js",
    "renderer.css",
    "renderer.js",
  ]);
  assert.deepEqual(
    bytes(outDir, "_render", "renderer.js"),
    bytes(dir, "renderer", "public", "renderer.js"),
  );
  assert.match(
    readFileSync(join(outDir, "_render", "renderer-config.js"), "utf8"),
    new RegExp(`appOrigin: ${JSON.stringify(APP_ORIGIN)}`),
  );

  // The shell is published beside the documents, not instead of them.
  assert.ok(existsSync(join(outDir, "sample", "index.html")));
  assert.equal(readFileSync(join(outDir, "index.html"), "utf8"), HOMEPAGE);
});

test("with no HOSTED_* variables the site builds and publishes no renderer shell", async (t) => {
  isolate(t);
  origins(t);
  const dir = root(t, { served: true, hosted: true, renderer: true });

  const { outDir } = await buildSite(dir);

  // A self-hosted document site is not a half-broken hosted one. It gets the
  // site it got before the renderer existed, with no configuration at all.
  assert.equal(existsSync(join(outDir, "_render")), false);
  assert.ok(existsSync(join(outDir, "sample", "index.html")));
  assert.equal(readFileSync(join(outDir, "index.html"), "utf8"), HOMEPAGE);
});

test("one configured origin without the other fails the build", async (t) => {
  isolate(t);
  origins(t, { app: APP_ORIGIN });
  const dir = root(t, { served: true, hosted: true, renderer: true });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError && /HOSTED_RENDER_ORIGIN is required/.test(error.message),
  );
});

test("two equal origins fail before the previous _site is touched", async (t) => {
  isolate(t);
  origins(t, { app: APP_ORIGIN, render: RENDER_ORIGIN });
  const dir = root(t, { served: true, hosted: true, renderer: true });

  // A first, good build, so the failure below has a previous publish tree to
  // cost. A site that framed its renderer from the same origin would have given
  // the artifact the application's cookies to reach, so this is refused -- and
  // refused in the preflight pass, because `buildRenderer`'s own refusal lands
  // after `_site/` is gone and every document has been rebuilt.
  const { outDir } = await buildSite(dir);
  origins(t, { app: APP_ORIGIN, render: APP_ORIGIN });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError &&
      /HOSTED_RENDER_ORIGIN must not be the same origin as HOSTED_APP_ORIGIN/.test(error.message),
  );
  assert.ok(existsSync(join(outDir, "_render", "index.html")));
  assert.ok(existsSync(join(outDir, "sample", "index.html")));
});

test("a malformed origin fails before the previous _site is touched", async (t) => {
  isolate(t);
  origins(t, { app: APP_ORIGIN, render: RENDER_ORIGIN });
  const dir = root(t, { served: true, hosted: true, renderer: true });

  // A first, good build, so the failure below has a previous publish tree to
  // cost. The origins are parsed in the preflight pass, which is what keeps a
  // typo in an operator's environment from emptying the deploy.
  const { outDir } = await buildSite(dir);
  origins(t, { app: `${APP_ORIGIN}/embed`, render: RENDER_ORIGIN });

  await assert.rejects(
    buildSite(dir),
    (error: unknown) =>
      error instanceof BuildError && /HOSTED_APP_ORIGIN must be exactly a lowercase/.test(error.message),
  );
  assert.ok(existsSync(join(outDir, "_render", "index.html")));
  assert.ok(existsSync(join(outDir, "sample", "index.html")));
});
