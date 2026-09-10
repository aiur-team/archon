#!/usr/bin/env node
/**
 * Build the static renderer deployment.
 *
 *   node renderer/scripts/build.mjs [--out <dir>] [--local-test]
 *
 * There is nothing to compile. What this script exists for is the part of the
 * renderer that cannot be a committed file: the two places the exact configured
 * application origin has to appear, and the security headers that a static host
 * will not write on its own.
 *
 *  - `_headers` carries the response policy, and `frame-ancestors` in it names
 *    the one origin allowed to frame this renderer. That rule cannot be written
 *    in the HTML: a `meta` element may not express `frame-ancestors` at all, and
 *    the legacy `X-Frame-Options: SAMEORIGIN` the root deployment sets would be
 *    exactly wrong here, since the whole point is to be framed by a different
 *    site and by nobody else. So this build owns the header set, and the deployed
 *    `netlify.toml` sets none, leaving one authority rather than two that can
 *    disagree.
 *  - `renderer-config.js` carries the same origin into the page, where
 *    `mountRenderer` compares it against `event.origin` by exact string equality.
 *
 * Both are the reason the origin is parsed rather than pasted. A build-time
 * substitution that concatenated an operator-supplied string into a header line
 * or into script source would be an injection point in a file nobody reads
 * again: a newline in the value forges a header, a quote in it escapes the
 * string literal. So the value is parsed with `URL`, required to equal its own
 * origin serialization, held to a character allowlist that has no room for
 * either character, and then still JSON-encoded on the way into script.
 *
 * The relaxed mode is an argument, exactly as it is in `hosted/lib/config.mjs`.
 * No environment variable can select it, so no value an operator sets on a
 * deployed site -- deliberately, by accident, or "temporarily on a preview" --
 * can turn the HTTPS requirement off.
 *
 * What this build does NOT check is the registrable-site separation between the
 * two origins. That rule belongs to `hosted/lib/config.mjs`, which owns the
 * public-suffix list through a pinned dependency and refuses to start the
 * application when the two origins share a site. Restating it here without that
 * list would mean inventing a second, weaker policy for trusted origins, which
 * is the one thing this deployment must not do: two policies that disagree are
 * worse than one that lives somewhere else.
 */

import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
export const RENDERER_ROOT = resolve(dirname(SELF), "..");
const PUBLIC_DIR = join(RENDERER_ROOT, "public");

/** The two C6 keys this deployment reads. It reads no others, and no secrets. */
export const RENDERER_CONFIG_KEYS = Object.freeze(["HOSTED_APP_ORIGIN", "HOSTED_RENDER_ORIGIN"]);

/** The files copied verbatim from `public/`, and the two that are generated. */
export const STATIC_FILES = Object.freeze(["index.html", "renderer.js", "renderer.css"]);
export const GENERATED_FILES = Object.freeze(["renderer-config.js", "_headers"]);

/**
 * The characters an origin may contain once it has been through `URL`.
 *
 * Redundant with the origin round-trip above it and kept anyway: this is the
 * pattern that makes "cannot contain a newline or a quote" true by inspection
 * rather than true by a chain of reasoning about what `URL` normalises. A
 * bracketed IPv6 literal is admitted because `hosted/lib/contracts.mjs` admits
 * `[::1]` as a loopback host and a build that rejected it would fail on a
 * configuration the application accepts.
 */
const HEADER_SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?$/;

export class RendererBuildError extends Error {
  constructor(key, rule) {
    super(`${key} ${rule}`);
    this.name = "RendererBuildError";
    this.key = key;
  }
}

/**
 * One configured origin, canonical or a build failure.
 *
 * The rules are `validateOrigin` from `hosted/lib/contracts.mjs` minus the
 * public-suffix check, and `scripts/test-hosted-renderer.mjs` asserts the two
 * agree on every row of a shared table so the subset stays a subset.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} key
 * @param {boolean} production
 * @returns {string}
 */
export function readOrigin(env, key, production) {
  const value = env[key];
  if (typeof value !== "string" || value === "") throw new RendererBuildError(key, "is required");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new RendererBuildError(key, "must be an absolute URL");
  }
  if (url.origin !== value) {
    throw new RendererBuildError(
      key,
      "must be exactly a lowercase scheme://host[:port] origin with no path, query or credentials",
    );
  }
  if (url.hostname.endsWith(".")) throw new RendererBuildError(key, "must not end with a trailing dot");
  if (production) {
    if (url.protocol !== "https:") throw new RendererBuildError(key, "must use https in production");
  } else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RendererBuildError(key, "must use http or https");
  }
  if (!HEADER_SAFE_ORIGIN.test(url.origin)) {
    throw new RendererBuildError(key, "must contain only host, port and scheme characters");
  }
  return url.origin;
}

/**
 * The renderer's response policy, as ordered header lines.
 *
 * Every directive here is decided by what the nested artifact frame will inherit,
 * because a `srcdoc` document inherits its parent's policy and then intersects
 * whatever its own `meta` element adds. That inheritance is the reason this
 * outer policy is more permissive than a static page would otherwise need:
 * `'unsafe-inline'` is not for anything in `renderer.js`, which is an external
 * module and would be happy with `'self'` alone. It is the room the artifact's
 * own inline scripts and styles need one level down, and it can be given here
 * precisely because this origin is cookie-free, session-free and carries only
 * operator-owned static code. The account application's policy stays strict and
 * is never asked to make this allowance -- that separation is what the second
 * site buys.
 *
 * The denials are the load-bearing half:
 *
 *  - `frame-ancestors` names the application origin and nothing else, so no
 *    other site can frame this renderer and drive its message channel.
 *  - `connect-src 'none'`, `form-action 'none'`, `object-src 'none'` and
 *    `base-uri 'none'` are inherited by the artifact, so an artifact cannot beat
 *    them by shipping a more permissive `meta` policy of its own.
 *  - No remote source appears anywhere, so an inherited policy alone already
 *    stops a remote script, a remote stylesheet and a beacon image.
 *  - `X-Frame-Options` is deliberately absent. `SAMEORIGIN` would forbid the one
 *    framing this design requires, and there is no `X-Frame-Options` value that
 *    means "this specific other site" -- `frame-ancestors` is the only rule that
 *    can say it, and a stale header beside it would be a second answer.
 *
 * @param {string} appOrigin a canonical, header-safe origin
 * @returns {Array<[string, string]>}
 */
export function rendererHeaders(appOrigin) {
  if (!HEADER_SAFE_ORIGIN.test(appOrigin)) {
    throw new RendererBuildError("appOrigin", "is not a header-safe origin");
  }
  const csp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    /* No `'self'`: the shell has no images, and this directive is inherited by
       the artifact. If the artifact's own `meta` policy were ever not applied --
       an engine bug, or an edit that moved it after other content -- `'self'`
       would leave the artifact a beacon to this origin, visible in the host's
       access log. The fallback should be as tight as the intersection. */
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "frame-src 'self'",
    "child-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${appOrigin}`,
  ].join("; ");

  /* Every capability this document could ever be delegated, refused for this
     document and for every frame below it. The artifact's sandbox already denies
     most of them; a permissions policy denies the rest, and denies them in a
     place an operator can read without reasoning about sandbox tokens. */
  const permissions = [
    "accelerometer",
    "attribution-reporting",
    "autoplay",
    "bluetooth",
    "browsing-topics",
    "camera",
    "clipboard-read",
    "clipboard-write",
    "compute-pressure",
    "display-capture",
    "encrypted-media",
    "fullscreen",
    "geolocation",
    "gyroscope",
    "hid",
    "identity-credentials-get",
    "idle-detection",
    "local-fonts",
    "magnetometer",
    "microphone",
    "midi",
    "otp-credentials",
    "payment",
    "publickey-credentials-get",
    "screen-wake-lock",
    "serial",
    "shared-storage",
    "speaker-selection",
    "storage-access",
    "usb",
    "window-management",
    "xr-spatial-tracking",
  ]
    .map((feature) => `${feature}=()`)
    .join(", ");

  return [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", permissions],
    /* `frame-ancestors` already decides who may embed this document; this header
       is what keeps that permission usable if the account application ever
       adopts `Cross-Origin-Embedder-Policy: require-corp`, which would otherwise
       block the frame outright. It grants nothing `frame-ancestors` has not
       already granted. There is deliberately no `Cross-Origin-Opener-Policy`:
       it is ignored on a framed document, and the standalone page has no opener
       and no session to protect. */
    ["Cross-Origin-Resource-Policy", "cross-origin"],
    /* No private bytes are ever at rest on this origin, and the shell is the
       same three files for everybody. Revalidating on every load is what keeps a
       protocol change from being served to a page that has already moved on. */
    ["Cache-Control", "public, max-age=0, must-revalidate"],
  ];
}

/** The Netlify `_headers` file for that policy, applied to every path. */
export function headersFile(appOrigin) {
  const lines = ["/*"];
  for (const [name, value] of rendererHeaders(appOrigin)) lines.push(`  ${name}: ${value}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The generated configuration script.
 *
 * A classic script setting one frozen global, rather than a module export, so
 * the deployed tree stays static files with no bundler and no module graph. The
 * origin is JSON-encoded even though the allowlist above has already made a
 * quote impossible: the encoding is what makes the line safe to read, and
 * "safe because of a regular expression forty lines away" is not a property that
 * survives an edit.
 */
export function configScript(appOrigin) {
  if (!HEADER_SAFE_ORIGIN.test(appOrigin)) {
    throw new RendererBuildError("appOrigin", "is not a header-safe origin");
  }
  return [
    "/* Generated by renderer/scripts/build.mjs. Do not edit. */",
    `globalThis.__ARCHON_RENDERER_CONFIG__ = Object.freeze({ appOrigin: ${JSON.stringify(appOrigin)} });`,
    "",
  ].join("\n");
}

/**
 * Produce the deployable tree.
 *
 * @param {{outDir: string, env?: Record<string, string | undefined>, production?: boolean}} options
 * @returns {Promise<{appOrigin: string, renderOrigin: string, outDir: string, files: string[]}>}
 */
export async function buildRenderer({ outDir, env = process.env, production = true }) {
  const appOrigin = readOrigin(env, "HOSTED_APP_ORIGIN", production);
  const renderOrigin = readOrigin(env, "HOSTED_RENDER_ORIGIN", production);
  if (appOrigin === renderOrigin) {
    throw new RendererBuildError(
      "HOSTED_RENDER_ORIGIN",
      "must not be the same origin as HOSTED_APP_ORIGIN",
    );
  }

  const target = resolve(outDir);
  /* The next line deletes this directory, so it is worth being sure what it is.
     `--out .` from `renderer/` would otherwise delete `public/`, `scripts/` and
     `netlify.toml` and then fail copying a file it had just removed -- the
     working copy gone and nothing published. `--out ..` and `--out /` are the
     same shape. A target that contains the source is refused rather than
     emptied. */
  const forbidden = [RENDERER_ROOT, PUBLIC_DIR, resolve(RENDERER_ROOT, "scripts"), process.cwd()];
  for (const path of forbidden) {
    if (target === path || path.startsWith(`${target}/`)) {
      throw new RendererBuildError("--out", "must not be the renderer tree or a directory containing it");
    }
  }

  /* `STATIC_FILES` is what gets copied *and* what the output is checked
     against, so on its own the two sides would drift together in silence: add
     `public/print.css`, link it from the shell, and the build copies three
     files, passes its own five-file check and deploys a page that 404s its
     stylesheet. Holding the list equal to the directory makes adding a file a
     build failure until it is declared. */
  const present = (await readdir(PUBLIC_DIR)).sort();
  const declared = [...STATIC_FILES].sort();
  if (present.join("\n") !== declared.join("\n")) {
    throw new RendererBuildError(
      "public",
      `contains ${present.join(", ")} but STATIC_FILES declares ${declared.join(", ")}`,
    );
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const name of STATIC_FILES) {
    await cp(join(PUBLIC_DIR, name), join(target, name));
  }
  await writeFile(join(target, "renderer-config.js"), configScript(appOrigin), "utf8");
  await writeFile(join(target, "_headers"), headersFile(appOrigin), "utf8");

  /* The deployable tree is exactly the files named above. Reading the directory
     back rather than reporting the list that was just written is what makes a
     stray file -- a copy that brought a sibling along, an editor backup, a
     fixture someone left in `public/` -- a build failure instead of something
     that quietly ships on a public origin. */
  const produced = (await readdir(target)).sort();
  const expected = [...STATIC_FILES, ...GENERATED_FILES].sort();
  if (produced.join("\n") !== expected.join("\n")) {
    throw new RendererBuildError(
      "output",
      `must contain exactly ${expected.join(", ")} but contains ${produced.join(", ")}`,
    );
  }

  return { appOrigin, renderOrigin, outDir: target, files: produced };
}

function parseArguments(argv) {
  let out = "dist";
  let production = true;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local-test") {
      production = false;
      continue;
    }
    if (argument === "--out") {
      index += 1;
      /* A missing value and a following flag are the same mistake. Without the
         second check, `--out --local-test` writes into a directory literally
         named `--local-test` and silently builds in production mode. */
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new RendererBuildError("--out", "requires a directory");
      }
      out = argv[index];
      continue;
    }
    throw new RendererBuildError(argument, "is not a recognised argument");
  }
  return { out, production };
}

async function main(argv) {
  const { out, production } = parseArguments(argv);
  /* Relative to the working directory, which is `renderer/` when Netlify runs
     the build command from this deployment's base directory. */
  const result = await buildRenderer({
    outDir: resolve(out),
    env: process.env,
    production,
  });
  process.stdout.write(
    `PASS  renderer build: ${result.files.length} files for ${result.appOrigin} in ${result.outDir}\n`,
  );
}

if (process.argv[1] === SELF) {
  main(process.argv.slice(2)).catch((error) => {
    /* The message names the key and the rule and never the value: half of what a
       deploy log carries is copied into an alert or an issue comment without
       anybody rereading it first. */
    process.stderr.write(`FAIL renderer build: ${error.message}\n`);
    process.exitCode = 1;
  });
}
