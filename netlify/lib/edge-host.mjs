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
 * the built assets, the admin console, the sign-in and invitation pages, the
 * hosted viewer and the publish flow. Each one is served by a function that
 * makes its own authorisation decision - `/admin` answers a signed-out visitor
 * with a redirect to sign in and a signed-in non-admin with a 403, which is a
 * decision only the route holding `ARCHON_ADMINS` can make. `excludedPath` used to carve these out of the gate in TOML; the
 * gate runs on every path now, so it names them itself. A path here that a
 * function serves keeps the function's own headers; a static one gains the
 * application header set.
 */
const APP_PASS_THROUGH_PREFIXES = Object.freeze([
  "/api/",
  "/_assets/",
  "/admin/",
  "/login/",
  "/docs/",
  "/publish/",
  "/invite/",
]);

/**
 * The pass-through paths that are a whole path rather than a prefix.
 *
 * `/admin` is the admin console's own address and has no trailing slash, so it
 * cannot be spelled in the list above: every entry there is tested with
 * `startsWith`, and a bare `"/admin"` would also match `/adminfoo/` and
 * `/admin-x/` - both of which are legal collaboration slugs, since the grammar
 * is `[a-z0-9-]{1,64}`. That would have passed somebody else's document straight
 * through the session gate to whoever asked for it.
 *
 * So the exact page is matched by equality and its asset tree by the `/admin/`
 * prefix above, and nothing between the two is reachable.
 */
const APP_PASS_THROUGH_PATHS = Object.freeze(["/admin"]);

/**
 * The landing page's own subresources, readable with no session at all.
 *
 * #229 made the splash at `/` public; it did not make what the page *loads*
 * public with it, and every one of those is a deeper path that still reaches the
 * session gate. The visible symptom is a landing page whose logo and favicons
 * each answer a sign-in redirect to an anonymous visitor - the page is public and
 * looks broken.
 *
 * So this is deliberately *only* the subresources. `/` is not here and must not
 * be: `isLandingPage` below owns the landing pages themselves and gives them the
 * landing-page policy, and a second opinion about the root would be two answers
 * to one question.
 *
 * Exact strings, plus one prefix for the image tree. A prefix of `/` would make
 * the whole application host anonymous, which is why the root is not expressible
 * here at all. Nothing that reads a document, a session or a store is reachable
 * through this set.
 */
const APP_PUBLIC_PATHS = Object.freeze([
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
]);

/** The one public tree: the homepage's images, which land at `_site/assets/`. */
const APP_PUBLIC_PREFIXES = Object.freeze(["/assets/"]);

/**
 * The public landing pages: the splash at the bare root (`site/index.html`) and
 * the onboarding page at `/welcome` (`netlify/public/welcome/index.html`), which
 * is where a sign-in with no pending publication lands.
 *
 * They are their own set rather than entries in the pass-through lists above
 * because the two sets answer different questions. A pass-through is served with
 * no session check and gains whichever header set its content type earns; a
 * landing page is served with no session check *and* takes
 * `landingPageHeaders`, which is the only set that admits the inline copy button
 * and the two Google Font origins both pages need. Under the first-party page
 * set the onboarding page would render unstyled with a dead copy button.
 *
 * The root is matched exactly and only, so no other path is made public by it.
 * `/welcome` is matched exactly and its own directory by prefix, so `/welcome`,
 * `/welcome/` and `/welcome/index.html` are one page rather than three
 * differently-gated spellings. The prefix carries its trailing slash for the
 * same reason `/admin` above is an exact path: a bare `"/welcome"` prefix would
 * also match `/welcomer/` and `/welcome-x/`, both legal collaboration slugs,
 * and would serve somebody else's document to whoever asked for it.
 *
 * `netlify/lib/hosted/contracts.mjs` names the same `/welcome` as
 * `HOSTED_LIMITS.WELCOME_PATH`. It is restated here rather than imported because
 * that module reaches a blob store and this one runs on Deno at the edge with
 * Web globals only; `netlify/test/welcome-page.test.mjs` holds the two equal. A
 * wrong copy fails in the safe direction: the page is gated rather than exposed.
 */
const LANDING_PAGE_PATHS = Object.freeze(["/", "/welcome"]);
const LANDING_PAGE_PREFIXES = Object.freeze(["/welcome/"]);

/**
 * Whether an application-host path is a public landing page.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isLandingPage(pathname) {
  if (LANDING_PAGE_PATHS.includes(pathname)) return true;
  return LANDING_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}


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
  if (APP_PASS_THROUGH_PATHS.includes(pathname)) return true;
  return APP_PASS_THROUGH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Whether an application-host path is public: readable with no session at all.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isApplicationPublic(pathname) {
  if (APP_PUBLIC_PATHS.includes(pathname)) return true;
  return APP_PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
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
 * Header set for the public landing pages: the splash at the application host's
 * bare root (`site/index.html`) and the onboarding page at `/welcome`
 * (`netlify/public/welcome/index.html`). Unlike the sign-in page, a landing page
 * is a marketing document: it pulls Google Fonts and runs small inline scripts
 * (copy button, entrance animation, dismissible banner). It holds no session, no
 * credential form and no user data, so it may take a looser CSP than
 * firstPartyPageHeaders -- the framing and base-uri denials and the same
 * security headers still hold. The extra grants are exactly what these static
 * pages need: inline script, the two Google Font origins, and same-origin
 * images.
 *
 * @returns {Array<[string, string]>}
 */
export function landingPageHeaders() {
  const csp = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
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
 * Apply the landing header set to a response, only when it carries no CSP of its
 * own. Same in-place contract as its siblings; the caller decides a response is
 * a public landing page before calling this.
 *
 * @param {Response} response
 * @returns {Response}
 */
export function withLandingPageHeaders(response) {
  let headers;
  try {
    headers = response.headers;
  } catch {
    return response;
  }
  if (!(headers instanceof Headers)) return response;
  if (headers.has("Content-Security-Policy")) return response;
  for (const [name, value] of landingPageHeaders()) headers.set(name, value);
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
