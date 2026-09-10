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
const RESERVED_ROUTES = new Set(["api", "d", "login", "invite", "skills", "_assets"]);
const NEVER_DESCEND = new Set(["_site", "node_modules", "dist", "netlify"]);

/**
 * Root static page trees, copied under their own name: `_site/login/...`.
 */
const STATIC_PAGES = ["login", "invite"];

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

/** Permanent-ID and alias redirects, grouped in ascending slug order. */
function renderRedirects(docs: SiteMetadata[]): string {
  const lines: string[] = [];
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
export function buildSite(root: string): SiteBuildResult {
  // Preflight everything before the previous _site/ is deleted or any
  // committed artifact is rebuilt: enhancer type, the document inventory, and
  // every entry in an existing login/ or invite/ tree.
  const enhancer = preflightEnhancer(root);

  const instances = collectDocuments(root);
  if (instances.length === 0) {
    fail("found no site documents (no publishable directory contains doc.json)");
  }

  const docs = instances.map((instance) => parseMetadata(root, instance));
  docs.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  validateInventory(docs);

  for (const page of STATIC_PAGES) validateStaticTree(root, page);
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
    writeFileSync(join(outDir, "_redirects"), renderRedirects(docs));
  } catch (e) {
    return fail(`_site: ${osError(e)}`);
  }

  // Last, so the committed homepage overrides the generated list page.
  copyServedContent(root, outDir);

  // Previews and branch deploys must not be indexed; production output has no
  // _headers file (the clean rebuild already removed any stale one).
  const context = process.env.CONTEXT ?? "production";
  if (context !== "production") {
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
