/**
 * Host classification, the refusal matrix and the two security header sets for
 * the one Archon site.
 *
 * This is the single authority on which hostname the site is answering on and
 * what security headers each answer carries. `gate.ts` imports it and applies
 * it: the application host serves the collaboration app, the hosted viewer and
 * the APIs; the renderer host serves exactly four shell files under an internal
 * rewrite and refuses everything else; every other host is a not-found the
 * crawlers are told to skip.
 *
 * It lives in `netlify/lib/` rather than beside `gate.ts`: the edge-functions
 * directory carries the one Deno TypeScript entry point and nothing else, and
 * this is the plain-ESM helper the edge function imports. `gate.ts` links it the
 * same way it links `../lib/identity.mjs`, and `node --test` imports it directly
 * with no TypeScript step. It uses only Web-standard globals — `URL`, `Response`,
 * `Headers` — and no Node-only API, so the same source runs on Deno in the edge
 * runtime and on Node in the test harness. It reads a request URL and a plain
 * environment object, never a global, so a test drives it with data.
 *
 * The renderer header set below is the one from `renderer/scripts/build.mjs`'s
 * `rendererHeaders`, copied here unchanged in content and order. It cannot be
 * imported from there: `renderer/` is outside the deploy tree, and every
 * relative import under `netlify/` must resolve under `netlify/` so the bundle
 * Netlify ships is self-contained (`scripts/vendor-netlify-lib.mjs`). The build
 * keeps its own copy for the renderer oracle, which serves fixtures under it;
 * the gate is the one authority that emits these headers on the live site.
 */

/** The four renderer shell paths, matched exactly and only with no query. */
export const RENDERER_SHELL = Object.freeze({
  "/": "/_render/index.html",
  "/renderer.js": "/_render/renderer.js",
  "/renderer.css": "/_render/renderer.css",
  "/renderer-config.js": "/_render/renderer-config.js",
});

/** The internal-rewrite prefix the renderer shell is published under. */
export const RENDER_PREFIX = "/_render/";

/**
 * The application-host paths that pass through with no session check: the API,
 * the built assets, the sign-in and invitation pages, the hosted viewer and the
 * publish flow. `excludedPath` used to carve these out of the gate in TOML; the
 * gate runs on every path now, so it names them itself. A path here that a
 * function serves keeps the function's own headers; a static one gains the
 * application header set.
 */
const APP_PASS_THROUGH_PREFIXES = Object.freeze([
  "/api/",
  "/_assets/",
  "/login/",
  "/docs/",
  "/publish/",
  "/invite/",
]);

/**
 * A header-safe origin serialization, the same shape `renderer/scripts/build.mjs`
 * requires before it will write an origin into a header line: scheme, host or
 * bracketed IPv6 literal, optional port, and nothing that could forge a header.
 */
const HEADER_SAFE_ORIGIN = /^https?:\/\/(\[[0-9a-fA-F:.]+\]|[a-z0-9.-]+)(:[0-9]{1,5})?$/;

/**
 * The application host's Permissions-Policy denial list, kept identical to the
 * renderer's so the two answers deny the same capabilities.
 */
const PERMISSIONS_DENIED = [
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

/**
 * Parse one configured origin into its lowercase hostname, or `null` when the
 * value is absent, empty or not an absolute origin. A malformed value is a
 * `null` here, which classifies as "no configuration" rather than a silent
 * third host — the connect fallback keeps consumer sites serving.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function originHostname(value) {
  if (typeof value !== "string" || value === "") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.origin !== value.replace(/\/$/, "") && url.origin !== value) {
    /* The value must be an origin, not an origin with a path. A trailing slash
       is the one difference `URL` normalizes away, so it is tolerated. */
    return null;
  }
  if (!url.hostname || url.hostname.endsWith(".")) return null;
  return url.hostname.toLowerCase();
}

/**
 * The application origin serialization, or `null` when it is absent or not
 * header-safe. `rendererHeaders` needs this exact string for `frame-ancestors`.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {string | null}
 */
export function applicationOrigin(env) {
  const value = env?.HOSTED_APP_ORIGIN;
  if (typeof value !== "string" || value === "") return null;
  let origin;
  try {
    origin = new URL(value).origin;
  } catch {
    return null;
  }
  return HEADER_SAFE_ORIGIN.test(origin) ? origin : null;
}

/**
 * Classify a request URL's hostname against the two configured origins.
 *
 * Returns exactly one of `"app"`, `"render"` or `"other"`. When either origin
 * is absent or malformed the site has no host configuration, and every host
 * classifies as `"app"`: a tree vendored by `scripts/connect.mjs` with no
 * `HOSTED_*` variables therefore keeps serving on whatever hostname it is
 * deployed to, and the render and other branches are unreachable there.
 *
 * The comparison is on `url.hostname`, which the URL parser has already
 * lowercased and stripped of any port, so it is case-insensitive and
 * port-insensitive without further work.
 *
 * @param {URL} url
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {"app" | "render" | "other"}
 */
export function classifyHost(url, env) {
  const appHost = originHostname(env?.HOSTED_APP_ORIGIN);
  const renderHost = originHostname(env?.HOSTED_RENDER_ORIGIN);
  if (appHost === null || renderHost === null) return "app";
  const host = url.hostname.toLowerCase();
  if (host === appHost) return "app";
  if (host === renderHost) return "render";
  return "other";
}

/**
 * The internal-rewrite target for a renderer-host request, or `null` when the
 * request is not one of the four shell files served with no query string.
 * A rewrite keeps the browser-visible URL unchanged, which is what lets the
 * renderer refuse to mount against a URL that carries a query or a fragment.
 *
 * @param {string} pathname
 * @param {string} search
 * @returns {string | null}
 */
export function rendererRewriteTarget(pathname, search) {
  if (search !== "" && search !== "?") return null;
  return Object.prototype.hasOwnProperty.call(RENDERER_SHELL, pathname)
    ? RENDERER_SHELL[pathname]
    : null;
}

/**
 * Whether an application-host path passes through with no session check.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isApplicationPassThrough(pathname) {
  return APP_PASS_THROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Whether an application-host path is a renderer shell prefix the application
 * host must refuse rather than serve, so artifact HTML is never a first-party
 * page on the application origin.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isRenderPrefix(pathname) {
  return pathname === "/_render" || pathname.startsWith(RENDER_PREFIX);
}

/**
 * The renderer host's response header set, `frame-ancestors` naming the one
 * application origin allowed to frame it and deliberately no `X-Frame-Options`.
 * Copied unchanged in content and order from `renderer/scripts/build.mjs`.
 *
 * @param {string} appOrigin a header-safe origin
 * @returns {Array<[string, string]>}
 */
export function rendererHeaders(appOrigin) {
  if (typeof appOrigin !== "string" || !HEADER_SAFE_ORIGIN.test(appOrigin)) {
    throw new Error("rendererHeaders: appOrigin is not a header-safe origin");
  }
  const csp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
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

  return [
    ["Content-Security-Policy", csp],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Permissions-Policy", PERMISSIONS_DENIED],
    ["Cross-Origin-Resource-Policy", "cross-origin"],
    ["Cache-Control", "public, max-age=0, must-revalidate"],
  ];
}

/**
 * The application host's response header set for a response that carries no
 * `Content-Security-Policy` of its own: `frame-ancestors 'none'` and the
 * matching `X-Frame-Options: DENY`, `nosniff`, and a referrer policy. A
 * function response that already carries a CSP — the hosted viewer's
 * `frame-src <render>` among them — keeps it and gains no second one.
 *
 * @returns {Array<[string, string]>}
 */
export function applicationHeaders() {
  return [
    [
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ],
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
  ];
}

/**
 * Apply the application header set to a response, but only when it carries no
 * `Content-Security-Policy` of its own. Returns the same response instance,
 * mutated in place; the caller owns a response whose headers are mutable.
 *
 * @param {Response} response
 * @returns {Response}
 */
export function withApplicationHeaders(response) {
  let headers;
  try {
    headers = response.headers;
  } catch {
    return response;
  }
  if (!(headers instanceof Headers)) return response;
  if (headers.has("Content-Security-Policy")) return response;
  for (const [name, value] of applicationHeaders()) headers.set(name, value);
  return response;
}

/**
 * The application host's response header set for a first-party static HTML page
 * it serves directly — the sign-in page today, and any other `text/html` file
 * under `netlify/public/`. These are trusted first-party documents, not API
 * answers, so they cannot take the `applicationHeaders` set: that set's CSP is
 * `default-src 'none'` with no `script-src`, `style-src`, `connect-src` or
 * `form-action`, which leaves each of those directives falling back to `'none'`.
 * On the sign-in page that blocks its `login.js`, its inline `<style>`, the
 * `fetch` that obtains the CSRF binding and the form post that starts sign-in —
 * the page freezes at "Preparing sign-in…" with a disabled button.
 *
 * This set names each directive such a page needs and nothing more: its own
 * same-origin scripts and inline style, its same-origin `fetch` and its
 * same-origin form post. `script-src` is `'self'` with no `'unsafe-inline'`
 * because these pages carry no inline `<script>`. The framing and base-uri
 * denials, and the same `X-Frame-Options`, `nosniff` and referrer policy, are
 * kept identical to `applicationHeaders` so a page is no more exposed than an
 * API answer in any respect but the four directives it must have to work.
 *
 * @returns {Array<[string, string]>}
 */
export function firstPartyPageHeaders() {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");

  return [
    ["Content-Security-Policy", csp],
    ["X-Frame-Options", "DENY"],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
  ];
}

/**
 * Apply the first-party page header set to a response, but only when it carries
 * no `Content-Security-Policy` of its own. Returns the same response instance,
 * mutated in place, exactly as `withApplicationHeaders` does; the caller decides
 * a response is a first-party HTML page before calling this.
 *
 * @param {Response} response
 * @returns {Response}
 */
export function withFirstPartyPageHeaders(response) {
  let headers;
  try {
    headers = response.headers;
  } catch {
    return response;
  }
  if (!(headers instanceof Headers)) return response;
  if (headers.has("Content-Security-Policy")) return response;
  for (const [name, value] of firstPartyPageHeaders()) headers.set(name, value);
  return response;
}

/**
 * The refusal a hostname that is neither the application nor the renderer host
 * gets: 404, no body, and `X-Robots-Tag: noindex` so a deploy preview that runs
 * the production functions is never indexed. Answered before any store read.
 *
 * @returns {Response}
 */
export function notFoundForeignHost() {
  return new Response(null, {
    status: 404,
    headers: {
      "X-Robots-Tag": "noindex",
      "Cache-Control": "private, no-store",
    },
  });
}

/**
 * The renderer host's refusal for any path that is not one of the four shell
 * files: 404, no body, and no `Set-Cookie`. Indistinguishable across paths from
 * outside, and it never reaches the session or identity path.
 *
 * @returns {Response}
 */
export function notFoundRenderer() {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}
