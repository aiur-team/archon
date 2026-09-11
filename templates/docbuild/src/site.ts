/**
 * Repo-backed site builder.
 *
 * The single-instance command produces one self-contained artifact at a time;
 * a repo-backed deployment needs one discoverable site containing every
 * document, permanent links that survive slug changes, protected deploy
 * previews, and a root index. This module adds that second output mode
 * *through* the same builder: it discovers publishable documents, calls the
 * shared `build()` for each one, and writes `_site/` from scratch so no
 * removed document, alias, preview header, or old hashed asset can survive
 * into a later deploy.
 *
 * `_site/` is disposable deploy output. It is never committed, and every
 * expected failure happens in a preflight pass before the previous `_site/`
 * is touched or any committed artifact is rebuilt.
 *
 * One site, one build command, one publish tree. This module is the only thing
 * that writes `_site/`, so every surface the deployment serves is produced here
 * or it is not served at all: the composed documents, the root static pages, the
 * hosted application's static tree, the committed homepage and agent files, the
 * renderer shell under `/_render/`, and the generated index and redirects.
 * Nothing about that inventory is expressed in `netlify.toml`, which is what
 * keeps a missed copy step a visibly missing page rather than a configuration
 * that disagrees with a build.
 */

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build, BuildError, check } from "./index.js";

export interface SiteDocument {
  instance: string;
  id: string;
  slug: string;
  aliases: string[];
}

export interface SiteBuildResult {
  outDir: string;
  documents: SiteDocument[];
  enhancerUrl: string | null;
}

/** First eight lower-case hexadecimal characters of SHA-256(bytes). */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

const fail = (message: string): never => {
  throw new BuildError(message);
};

const osError = (e: unknown): string => (e as NodeJS.ErrnoException).message;

const ID_RE = /^[0-9a-f]{6}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Top-level names the one site owns, so no document slug or alias can shadow
 * one. `docs` and `publish` are the only additions a slug can actually claim —
 * `_render`, `viewer.js` and `viewer.css` are not spellable as a slug, since
 * `SLUG_RE` admits neither a leading underscore nor a dot, and a document that
 * tries fails on the slug grammar before it ever reaches this set. They are
 * listed anyway: this set is where a reader looks for "what does the publish
 * tree already serve at the root", and a route that is reserved only by an
 * accident of another regular expression is one edit away from not being.
 */
const RESERVED_ROUTES = new Set([
  "admin",
  "api",
  "assets",
  "d",
  "login",
  "invite",
  "skills",
  "docs",
  "publish",
  "welcome",
  "_assets",
  "_render",
  "viewer.js",
  "viewer.css",
]);
const NEVER_DESCEND = new Set(["_site", "node_modules", "dist", "netlify"]);

/**
 * Root static page trees, copied under their own name: `_site/invite/...`.
 *
 * `login` used to be here too, and the repository carried two sign-in pages:
 * the collaboration layer's email-and-password form at the root, and the hosted
 * Auth0 page under `netlify/public/`. Both wrote `login/index.html` and the
 * copy order decided which one a visitor actually got — a real file collision
 * standing in for a decision nobody had written down. ACN-006 deleted the root
 * page along with the password login it posted to, so the hosted tree is now
 * the only source of `login/index.html`.
 */
const STATIC_PAGES = ["invite"];

/**
 * The hosted application's static tree. Its contents land at the root of the
 * publish tree, so `netlify/public/viewer.js` becomes `_site/viewer.js` and
 * `netlify/public/login/index.html` becomes `_site/login/index.html`.
 *
 * It is still copied after `STATIC_PAGES`, but nothing rests on the order any
 * more: there is one `login/index.html` in the repository now, and it is this
 * tree's.
 */
const HOSTED_TREE = "netlify/public";

/**
 * The renderer shell's home inside the publish tree. `buildRenderer` deletes
 * its own target before writing, so this must be a subdirectory of `_site/` and
 * never `_site/` itself.
 */
const RENDER_DIR = "_render";

/**
 * The hand-written homepage tree. Its contents land at the root of the publish
 * tree, so `site/index.html` becomes `_site/index.html` and `site/assets/x.png`
 * becomes `_site/assets/x.png`. Absent, the generated list page stands.
 */
const SITE_TREE = "site";

/**
 * The agent skill, served at `/skills/archon-doc/SKILL.md` from the one source
 * the package also publishes. There is no second committed copy of the file.
 */
const SKILLS_TREE = "skills";

/** Root files the site serves verbatim at their own name. */
const SERVED_ROOT_FILES = ["AGENTS.md", "llms.txt"];

interface SiteMetadata {
  instance: string;
  id: string;
  slug: string;
  aliases: string[];
  title: string;
  heading: string | undefined;
  lede: string | undefined;
}

function readUtf8(path: string, label = path): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    return fail(`${label}: ${osError(e)}`);
  }
}

// ---------------------------------------------------------------- discovery

/** True when a directory named `name` under the repo path `rel` is skipped. */
function isExcluded(rel: string, name: string): boolean {
  if (name.startsWith(".")) return true;
  if (NEVER_DESCEND.has(name)) return true;
  // Root static content is copied, never walked for documents: a symlink in one
  // of these trees must reach the static-tree error, not the discovery error.
  if (rel === "" && STATIC_PAGES.includes(name)) return true;
  if (rel === "" && (name === SITE_TREE || name === SKILLS_TREE)) return true;
  // templates/skeleton/ is a copy source, not a published document.
  if (rel === "templates" && name === "skeleton") return true;
  return false;
}

/**
 * Recursively collect every publishable document as a repo-relative,
 * `/`-separated path. A publishable document is any visited directory holding
 * a regular `doc.json`. The walk reads directory entries (lstat semantics) in
 * lexicographic order and never follows a symlink: an excluded path is neither
 * opened nor followed, and any other symlink is a hard error.
 */
function collectDocuments(root: string): string[] {
  const documents: string[] = [];

  const walk = (abs: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return fail(`${rel === "" ? "." : rel}: ${osError(e)}`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // A symlinked doc.json is the specific metadata error, not the general one.
    for (const ent of entries) {
      if (ent.name !== "doc.json") continue;
      if (ent.isSymbolicLink()) {
        return fail(`${rel}/doc.json: symbolic links are not supported for document metadata`);
      }
      if (ent.isFile()) documents.push(rel);
      break;
    }

    for (const ent of entries) {
      const name = ent.name;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      if (name === "doc.json") continue;
      // Name-based exclusions apply before traversal, so an excluded path is
      // neither opened, followed, nor treated as a visited symlink.
      if (isExcluded(rel, name)) continue;
      if (ent.isSymbolicLink()) {
        return fail(`${childRel}: symbolic links are not supported in site discovery`);
      }
      if (!ent.isDirectory()) continue;
      walk(join(abs, name), childRel);
    }
  };

  walk(root, "");
  return documents;
}

// --------------------------------------------------------------- validation

function parseMetadata(root: string, instance: string): SiteMetadata {
  const raw = readUtf8(join(root, instance, "doc.json"), `${instance}/doc.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail(`${instance}/doc.json: ${osError(e)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(`${instance}/doc.json: expected a JSON object`);
  }
  const fields = parsed as Record<string, unknown>;

  const id = fields.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return fail(`${instance}/doc.json: missing or invalid 'id' (expected six lowercase hexadecimal characters)`);
  }
  const slug = fields.slug;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    return fail(`${instance}/doc.json: missing or invalid 'slug' (expected one lowercase kebab-case path segment)`);
  }
  const aliases = fields.aliases;
  if (
    !Array.isArray(aliases) ||
    aliases.some((alias) => typeof alias !== "string" || !SLUG_RE.test(alias))
  ) {
    return fail(`${instance}/doc.json: missing or invalid 'aliases' (expected an array of lowercase kebab-case path segments)`);
  }
  const title = fields.title;
  if (typeof title !== "string" || title === "") {
    return fail(`${instance}/doc.json: missing or invalid 'title' (expected a non-empty string)`);
  }
  const heading = fields.heading;
  if (heading !== undefined && typeof heading !== "string") {
    return fail(`${instance}/doc.json: invalid 'heading' (expected a string when present)`);
  }
  const lede = fields.lede;
  if (lede !== undefined && typeof lede !== "string") {
    return fail(`${instance}/doc.json: invalid 'lede' (expected a string when present)`);
  }

  return {
    instance,
    id,
    slug,
    aliases: aliases as string[],
    title,
    heading: typeof heading === "string" ? heading : undefined,
    lede: typeof lede === "string" ? lede : undefined,
  };
}

/**
 * Validate the complete inventory: globally unique IDs, globally unique slug
 * and alias routes, no reserved route, and no alias that duplicates its own
 * slug or its own array. Documents arrive in ascending slug order so the
 * duplicate message names the earlier doc first.
 */
function validateInventory(docs: SiteMetadata[]): void {
  const idOwner = new Map<string, string>();
  for (const doc of docs) {
    const prev = idOwner.get(doc.id);
    if (prev !== undefined) fail(`duplicate document id: ${doc.id} (${prev}, ${doc.instance})`);
    idOwner.set(doc.id, doc.instance);
  }

  const routeOwner = new Map<string, string>();
  for (const doc of docs) {
    const routes = [doc.slug, ...doc.aliases];
    for (const route of routes) {
      if (RESERVED_ROUTES.has(route)) fail(`reserved site route: ${route} (${doc.instance})`);
      const prev = routeOwner.get(route);
      if (prev !== undefined) fail(`duplicate site route: ${route} (${prev}, ${doc.instance})`);
      routeOwner.set(route, doc.instance);
    }
  }
}

// ------------------------------------------------------------- static pages

function lstat(root: string, rel: string) {
  try {
    return lstatSync(join(root, rel));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return fail(`${rel}: ${osError(e)}`);
  }
}

/**
 * Reject every symlink or unsupported file type in a root static tree before
 * `_site/` is deleted, so a bad static page cannot cost the previous output.
 */
function validateStaticTree(root: string, rel: string): void {
  const stat = lstat(root, rel);
  if (stat === null) return;
  if (stat.isSymbolicLink()) fail(`${rel}: symbolic links are not supported in static page trees`);
  if (!stat.isDirectory()) fail(`${rel}: expected a directory in static page trees`);
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch (e) {
    return fail(`${rel}: ${osError(e)}`);
  }
  names.sort();
  for (const name of names) {
    const childRel = `${rel}/${name}`;
    const child = lstat(root, childRel);
    if (child === null) continue;
    if (child.isSymbolicLink()) fail(`${childRel}: symbolic links are not supported in static page trees`);
    if (child.isDirectory()) validateStaticTree(root, childRel);
    else if (!child.isFile()) fail(`${childRel}: unsupported file type in static page tree`);
  }
}

/**
 * Copy a root static tree byte-for-byte into `_site/`, directories sorted.
 *
 * `destRel` is where the tree lands inside `_site/`, and defaults to its own
 * repository path. Passing `""` publishes the tree's *contents* at the root,
 * which is how the committed homepage replaces the generated index.
 */
function copyStaticTree(root: string, outDir: string, rel: string, destRel: string = rel): void {
  const stat = lstat(root, rel);
  if (stat === null) return;
  if (!stat.isDirectory()) return fail(`${rel}: expected a directory in static page trees`);
  const dest = join(outDir, destRel);
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    return fail(`${rel}: ${osError(e)}`);
  }
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch (e) {
    return fail(`${rel}: ${osError(e)}`);
  }
  names.sort();
  for (const name of names) {
    const childRel = `${rel}/${name}`;
    const child = lstat(root, childRel);
    if (child === null) continue;
    if (child.isSymbolicLink()) fail(`${childRel}: symbolic links are not supported in static page trees`);
    if (child.isDirectory()) {
      copyStaticTree(root, outDir, childRel, destRel === "" ? name : `${destRel}/${name}`);
      continue;
    }
    if (!child.isFile()) fail(`${childRel}: unsupported file type in static page tree`);
    try {
      writeFileSync(join(dest, name), readFileSync(join(root, childRel)));
    } catch (e) {
      return fail(`${childRel}: ${osError(e)}`);
    }
  }
}

// ----------------------------------------------------------- served content

/**
 * Hold `RESERVED_ROUTES` equal to what the hosted tree actually publishes.
 *
 * The hosted tree is copied over the same root the documents were written into,
 * and a copy overwrites without asking. So a hosted page whose top-level name no
 * document may claim, but which nobody added to `RESERVED_ROUTES`, is a document
 * that disappears from the site on a green build with no diagnostic -- exactly
 * the class of silent loss a rebuilt-from-scratch publish tree is prone to.
 *
 * Reading the directory rather than trusting the list is what makes adding
 * `netlify/public/status/` a build failure until the route is declared. It is
 * the same shape as the renderer build holding `STATIC_FILES` equal to
 * `renderer/public/`, and for the same reason: a list that is both the input and
 * the check drifts in silence.
 */
function preflightHostedRoutes(root: string): void {
  const stat = lstat(root, HOSTED_TREE);
  if (stat === null) return;
  let names: string[];
  try {
    names = readdirSync(join(root, HOSTED_TREE));
  } catch (e) {
    return fail(`${HOSTED_TREE}: ${osError(e)}`);
  }
  const undeclared = names.filter((name) => !RESERVED_ROUTES.has(name)).sort();
  if (undeclared.length > 0) {
    fail(
      `${HOSTED_TREE} publishes ${undeclared.join(", ")} at the site root, ` +
        "which RESERVED_ROUTES does not reserve: a document slug could claim it and be overwritten",
    );
  }
}

/**
 * Preflight everything the repository serves as committed content, before the
 * previous `_site/` is deleted: the homepage tree, the skill tree, and each
 * served root file. Every one of them is optional, so a repository that carries
 * none of them builds exactly the site it built before they existed.
 */
function preflightServedContent(root: string): void {
  validateStaticTree(root, SITE_TREE);
  validateStaticTree(root, SKILLS_TREE);
  for (const rel of SERVED_ROOT_FILES) {
    const stat = lstat(root, rel);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) fail(`${rel}: symbolic links are not supported in served root files`);
    if (!stat.isFile()) fail(`${rel}: expected a regular file when present`);
  }
}

/**
 * Copy the committed served content into the publish tree: the homepage tree at
 * the root, the skill tree under its own name, and the served root files.
 *
 * This runs after the generated index and redirects are written, so a committed
 * `site/index.html` is what `_site/index.html` ends up containing. The property
 * to assert is the bytes of the built file, not the order of these two writes.
 *
 * One helper holds every copy step, so a deployment that serves more committed
 * content adds a line here rather than another pass over the publish tree.
 */
function copyServedContent(root: string, outDir: string): void {
  // The homepage tree publishes its *contents* at the root: site/index.html is
  // /index.html, site/assets/aiur-logo.png is /assets/aiur-logo.png.
  copyStaticTree(root, outDir, SITE_TREE, "");
  // The skill is copied from the package's own source. A second committed copy
  // of SKILL.md would be free to drift; a build-time copy cannot.
  copyStaticTree(root, outDir, SKILLS_TREE);
  for (const rel of SERVED_ROOT_FILES) {
    const stat = lstat(root, rel);
    if (stat === null) continue;
    if (!stat.isFile()) return fail(`${rel}: expected a regular file when present`);
    try {
      writeFileSync(join(outDir, rel), readFileSync(join(root, rel)));
    } catch (e) {
      return fail(`_site/${rel}: ${osError(e)}`);
    }
  }
}

// ------------------------------------------------------------- render shell

/** The two keys the renderer build reads. It reads no others, and no secrets. */
const RENDERER_KEYS = ["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"] as const;

const RENDERER_BUILD = "renderer/scripts/build.mjs";

/** The part of `renderer/scripts/build.mjs` this builder calls. */
interface RendererBuild {
  buildRenderer(options: {
    outDir: string;
    env: NodeJS.ProcessEnv;
    production: boolean;
  }): Promise<{ files: string[] }>;
  readOrigin(env: NodeJS.ProcessEnv, key: string, production: boolean): string;
}

/**
 * Load the renderer build, or decide there is no renderer shell to publish.
 *
 * The module is loaded by path rather than imported, for two reasons that both
 * have to hold. It lives outside this package, so a static import would put a
 * file the published tarball does not carry on the package's module graph; and
 * an installed consumer building their own repository has no `renderer/` at all,
 * which is an absence to skip rather than a build failure.
 *
 * The other skip is configuration: a repository with neither `HOSTED_APP_ORIGIN`
 * nor `HOSTED_RENDER_ORIGIN` set is a self-hosted document site, and it gets the
 * site it got before the renderer existed. Setting exactly one of them is not
 * that case — it is a half-configured deployment, and `readOrigin` below fails
 * it by name.
 *
 * Both origins are parsed here, in the preflight pass, so a malformed one costs
 * nothing: the previous `_site/` is still on disk when it throws.
 */
async function preflightRenderShell(root: string, production: boolean): Promise<RendererBuild | null> {
  const stat = lstat(root, RENDERER_BUILD);
  if (stat === null) return null;
  if (!stat.isFile()) return fail(`${RENDERER_BUILD}: expected a regular file when present`);
  if (RENDERER_KEYS.every((key) => (process.env[key] ?? "") === "")) return null;

  let module: RendererBuild;
  try {
    module = (await import(pathToFileURL(join(root, RENDERER_BUILD)).href)) as RendererBuild;
  } catch (e) {
    return fail(`${RENDERER_BUILD}: ${osError(e)}`);
  }
  if (typeof module.buildRenderer !== "function" || typeof module.readOrigin !== "function") {
    return fail(`${RENDERER_BUILD}: expected buildRenderer and readOrigin exports`);
  }
  const origins: string[] = [];
  for (const key of RENDERER_KEYS) {
    try {
      origins.push(module.readOrigin(process.env, key, production));
    } catch (e) {
      return fail(`${RENDERER_BUILD}: ${(e as Error).message}`);
    }
  }
  /* `buildRenderer` refuses two equal origins itself, and that refusal is the
     authority -- it is what a `--out` invocation from a shell hits, and its
     message is the one quoted everywhere. It just refuses too late for this
     builder: by the time it runs, `_site/` has been deleted and every document
     rebuilt, so a typo in one operator variable costs the previous publish tree.
     Asking the same question here is a duplicated *check*, not a duplicated
     rule; the message defers to the one that owns it. */
  if (origins[0] === origins[1]) {
    fail(`${RENDERER_BUILD}: HOSTED_RENDER_ORIGIN must not be the same origin as HOSTED_APP_ORIGIN`);
  }
  return module;
}

/**
 * Write the renderer shell into `_site/_render/`.
 *
 * Every rule the renderer build already makes survives the change of output
 * directory: it refuses two equal origins, it refuses a target that contains its
 * own source tree, it holds `renderer/public/` equal to its declared file list,
 * and it reads the written directory back and requires it to be exactly the
 * expected set. What it no longer writes is `_headers`: on one site the edge
 * gate is the only header authority, and a `_headers` file beside it would be a
 * second one that a reader of either cannot see.
 */
async function buildRenderShell(
  module: RendererBuild,
  outDir: string,
  production: boolean,
): Promise<void> {
  try {
    await module.buildRenderer({ outDir: join(outDir, RENDER_DIR), env: process.env, production });
  } catch (e) {
    return fail(`_site/${RENDER_DIR}: ${(e as Error).message}`);
  }
}

// ------------------------------------------------------------------- output

function escapeHtml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;");
}

/**
 * The deterministic root index: theme.css inlined, one row per document in
 * ascending slug order, no external request, no script, no generated state.
 */
function renderIndex(root: string, docs: SiteMetadata[]): string {
  const theme = readUtf8(join(root, "templates", "base", "theme.css"));
  const rows = docs
    .map((doc) => {
      const name = escapeHtml(doc.heading ?? doc.title);
      const lede = escapeHtml(doc.lede ?? "");
      return `<li><a href="/${doc.slug}/"><b>${name}</b><span>${lede}</span></a></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Architecture docs</title>
<style>
${theme}</style>
</head>
<body>
<main>
<h1>Architecture docs</h1>
<ul>
${rows}
</ul>
</main>
</body>
</html>
`;
}

/**
 * The two static rewrites the merged site carries, and both exist because
 * something else names an exact path.
 *
 * C3 freezes the browser URL at `/publish/authorize` with no query string, and
 * `validateStartResponse` refuses a start response whose URL is anything else.
 * The page is committed at `netlify/public/publish/authorize.html`, and serving
 * a flat `.html` asset at its extensionless path is Netlify *post-processing* —
 * which `[build.processing] skip_processing = true` turns off. Relying on it
 * would make the one path the contract names 404, and the whole approval flow
 * unreachable, on a setting whose stated purpose is unrelated.
 *
 * Status 200 is a rewrite rather than a redirect: the visitor stays on the
 * contract path, so no token-bearing fragment is carried through a `Location`
 * and no extra hop appears in history.
 *
 * It is generated here rather than declared in `netlify.toml` because the
 * publish tree already carries a generated `_redirects` and a rule split across
 * two files is a rule nobody reads in one place. Netlify applies `_redirects`
 * after the TOML rules, and the document routes below cannot match this path:
 * `/publish` is a reserved route.
 *
 * `/welcome` is the same shape for the same reason. It is the destination an
 * ordinary sign-in lands on, so the sign-in grammar names it exactly and with
 * no trailing slash; without this rule Netlify would answer that spelling with
 * a 301 to `/welcome/`, and the extra hop lands on a path the edge gate has to
 * classify separately. The rewrite keeps the visitor on the path the grammar
 * named and serves the committed `netlify/public/welcome/index.html`.
 *
 * They are emitted only when the hosted tree was actually copied. A repository
 * without one -- an installed consumer building their own documents -- would
 * otherwise get rewrites pointing at files that are not in its publish tree,
 * which turns a page that simply does not exist into a page that exists and
 * 404s through a rule.
 */
export const HOSTED_REWRITES = [
  "/publish/authorize /publish/authorize.html 200",
  "/welcome /welcome/index.html 200",
];

/** Permanent-ID and alias redirects, grouped in ascending slug order. */
function renderRedirects(docs: SiteMetadata[], hosted: boolean): string {
  const lines: string[] = hosted ? [...HOSTED_REWRITES] : [];
  for (const doc of docs) {
    lines.push(`/d/${doc.id} /${doc.slug}/ 301`);
    lines.push(`/d/${doc.id}/* /${doc.slug}/ 301`);
    for (const alias of doc.aliases) {
      lines.push(`/${alias} /${doc.slug}/ 301!`);
      lines.push(`/${alias}/* /${doc.slug}/:splat 301!`);
    }
  }
  return `${lines.join("\n")}\n`;
}

// --------------------------------------------------------------------- site

interface Enhancer {
  hash: string;
  bytes: Uint8Array;
}

function preflightEnhancer(root: string): Enhancer | null {
  const rel = "templates/enhance/enhance.js";
  const stat = lstat(root, rel);
  if (stat === null) return null;
  if (!stat.isFile()) fail(`${rel}: expected a regular file when present`);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(root, rel));
  } catch (e) {
    return fail(`${rel}: ${osError(e)}`);
  }
  return { hash: contentHash(bytes), bytes };
}

/** Build the complete repo-backed site and refresh each artifact copy. */
export async function buildSite(root: string): Promise<SiteBuildResult> {
  // Previews and branch deploys are not production, and the renderer build
  // holds its origins to https in production exactly as the application does.
  const context = process.env.CONTEXT ?? "production";
  const production = context === "production";

  // Preflight everything before the previous _site/ is deleted or any
  // committed artifact is rebuilt: enhancer type, the document inventory,
  // every entry in an existing invite/ tree, and the two renderer origins.
  const enhancer = preflightEnhancer(root);
  const renderer = await preflightRenderShell(root, production);

  const instances = collectDocuments(root);
  if (instances.length === 0) {
    fail("found no site documents (no publishable directory contains doc.json)");
  }

  const docs = instances.map((instance) => parseMetadata(root, instance));
  docs.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  validateInventory(docs);

  for (const page of STATIC_PAGES) validateStaticTree(root, page);
  validateStaticTree(root, HOSTED_TREE);
  preflightHostedRoutes(root);
  preflightServedContent(root);

  const outDir = resolve(root, "_site");
  try {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return fail(`${outDir}: ${osError(e)}`);
  }

  const tag =
    enhancer === null ? null : `<script defer src="/_assets/enhance.${enhancer.hash}.js"></script>\n`;

  const documents: SiteDocument[] = [];
  for (const doc of docs) {
    // The shared builder refreshes <instance>/dist/<basename>.html and runs the
    // common hook chain; nothing here re-implements composition.
    const artifactPath = build(root, doc.instance);
    if (!check(artifactPath).ok) {
      fail(`${doc.instance}: unbalanced tags in the built document`);
    }
    let hosted = readUtf8(artifactPath);
    if (tag !== null) {
      if (!hosted.endsWith("\n")) hosted += "\n";
      hosted += tag;
    }
    const pageDir = join(outDir, doc.slug);
    try {
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, "index.html"), hosted);
    } catch (e) {
      return fail(`_site/${doc.slug}/index.html: ${osError(e)}`);
    }
    documents.push({ instance: doc.instance, id: doc.id, slug: doc.slug, aliases: doc.aliases });
  }

  for (const page of STATIC_PAGES) copyStaticTree(root, outDir, page);
  // The tree's *contents* land at the root: `netlify/public/viewer.js` is
  // `/viewer.js`, `netlify/public/publish/authorize.html` is
  // `/publish/authorize.html`, which is the path the rewrite above names.
  const hosted = lstat(root, HOSTED_TREE) !== null;
  copyStaticTree(root, outDir, HOSTED_TREE, "");

  if (renderer !== null) await buildRenderShell(renderer, outDir, production);

  if (enhancer !== null) {
    const assetsDir = join(outDir, "_assets");
    try {
      mkdirSync(assetsDir, { recursive: true });
      writeFileSync(join(assetsDir, `enhance.${enhancer.hash}.js`), enhancer.bytes);
    } catch (e) {
      return fail(`_site/_assets/enhance.${enhancer.hash}.js: ${osError(e)}`);
    }
  }

  try {
    writeFileSync(join(outDir, "index.html"), renderIndex(root, docs));
    writeFileSync(join(outDir, "_redirects"), renderRedirects(docs, hosted));
  } catch (e) {
    return fail(`_site: ${osError(e)}`);
  }

  // Last, so the committed homepage overrides the generated list page.
  copyServedContent(root, outDir);

  // Previews and branch deploys must not be indexed; production output has no
  // _headers file (the clean rebuild already removed any stale one).
  if (!production) {
    try {
      writeFileSync(join(outDir, "_headers"), "/*\n  X-Robots-Tag: noindex\n");
    } catch (e) {
      return fail(`_site/_headers: ${osError(e)}`);
    }
  }

  return {
    outDir,
    documents,
    enhancerUrl: enhancer === null ? null : `/_assets/enhance.${enhancer.hash}.js`,
  };
}
