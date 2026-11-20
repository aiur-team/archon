#!/usr/bin/env node
// Serve a built tree on loopback for the site screenshot tests. No dependencies.
//
//   node scripts/serve-static.mjs _site 43129
//
// A directory path serves its index.html (`/` -> index.html); anything missing
// serves the tree's 404.html with status 404, as Netlify does.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const [dir, port] = process.argv.slice(2);
if (!dir || !port) {
  console.error("usage: node scripts/serve-static.mjs <dir> <port>");
  process.exit(2);
}
const root = resolve(dir);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
};

async function file(path) {
  // Refuse anything that resolves outside the served root.
  if (path !== root && !path.startsWith(root + sep)) return null;
  const info = await stat(path).catch(() => null);
  if (info?.isDirectory()) return file(join(path, "index.html"));
  return info?.isFile() ? path : null;
}

createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const found = await file(join(root, pathname));
  const path = found ?? (await file(join(root, "404.html")));
  if (!path) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(found ? 200 : 404, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
  res.end(await readFile(path));
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
