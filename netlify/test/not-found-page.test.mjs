/**
 * The not-found page, asserted against the repository itself.
 *
 *   node --test netlify/test/not-found-page.test.mjs
 *
 * `site/404.html` is published at the root of the publish tree, which is where
 * Netlify looks for the answer to an unmatched static path. Two groups of
 * property are worth holding.
 *
 * The page itself: the logo, the title and the italic subtitle are the whole
 * content, it draws them in the splash's own typefaces and tokens, and it runs
 * no script. That last one is load-bearing rather than stylistic --
 * `notFoundPageHeaders` grants no `script-src` in any form, so a script added
 * here would silently not run on the live site.
 *
 * And the header set: a page that draws an image and links two font origins
 * cannot take `firstPartyPageHeaders`, which grants neither, and does not need
 * `landingPageHeaders`, which grants inline script it has no use for. The gate's
 * own behaviour -- which paths reach this page and which still get a sign-in
 * redirect -- is asserted in `netlify/test/edge-host.test.mjs`, against the real
 * gate control flow.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  firstPartyPageHeaders,
  landingPageHeaders,
  notFoundPageHeaders,
} from "../lib/edge-host.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const NOT_FOUND = "site/404.html";
const SPLASH = "site/index.html";

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function csp(headers) {
  const found = headers.find(([name]) => name === "Content-Security-Policy");
  assert.ok(found !== undefined, "the set carries a Content-Security-Policy");
  return found[1];
}

test("the page is the logo, the title and the italic subtitle", () => {
  const page = read(NOT_FOUND);
  assert.match(
    page,
    /<img class="logo" src="\/assets\/aiur-logo\.png"/,
    "the logo is the one the splash already serves, at its public path",
  );
  assert.match(page, /<h1>404 Page Not Found<\/h1>/, "the title is exact");
  assert.match(
    page,
    /<p class="subtitle"><em>I sense a soul in search of answers\.<\/em><\/p>/,
    "and the subtitle is exact, and italic",
  );
  assert.match(page, /font-style: italic;/, "italic in the styles as well as the markup");
  assert.match(page, /<a class="home" href="\/">/, "with one link home");
});

test("the page speaks the splash's visual language", () => {
  const page = read(NOT_FOUND);
  const splash = read(SPLASH);
  /* The same two families, loaded from the same stylesheet host the splash
     uses, and the same token names -- so a palette change on the splash is one
     a reader of this file can follow rather than a divergence nobody notices. */
  for (const family of ["Bungee", "Space Grotesk"]) {
    assert.ok(page.includes(family), `the page uses ${family}`);
    assert.ok(splash.includes(family), `and so does the splash`);
  }
  for (const token of ["--bg", "--fg", "--muted", "--accent"]) {
    assert.ok(page.includes(`${token}:`), `the page defines ${token}`);
  }
  /* Light is the bare `:root` and dark is the media override, the same way
     round as the splash, so no colour exists only inside a media block. */
  assert.ok(
    page.indexOf("@media (prefers-color-scheme: dark)") > page.indexOf(":root {"),
    "light is defined first, at the bare :root",
  );
  assert.match(page, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.ok(page.includes("clamp("), "and it sizes responsively");
});

test("the page runs no script at all", () => {
  const page = read(NOT_FOUND);
  assert.equal(page.includes("<script"), false, "no script element");
  assert.equal(page.includes("onload"), false, "no inline handler");
  assert.equal(page.includes("fetch("), false, "and it reaches no network of its own");
});

test("the not-found header set grants what the page needs and no script", () => {
  const policy = csp(notFoundPageHeaders());
  assert.ok(policy.startsWith("default-src 'none'"), "it denies by default");
  assert.equal(
    /script-src/.test(policy),
    false,
    "and names no script-src in any form, so no script runs on the page",
  );
  assert.ok(policy.includes("img-src 'self'"), "the logo is same-origin");
  assert.ok(policy.includes("font-src https://fonts.gstatic.com"), "the fonts it links");
  assert.ok(policy.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com"));
  assert.ok(policy.includes("form-action 'none'"), "the page posts nothing");
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("base-uri 'none'"));

  /* The same four security headers every other set carries, so a not-found
     answer is no more exposed than an API answer. */
  const names = notFoundPageHeaders().map(([name]) => name);
  assert.deepEqual(names, [
    "Content-Security-Policy",
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
  ]);
});

test("neither existing page set would serve the page correctly", () => {
  /* This is why the set exists at all, stated as a test rather than as a
     comment: the first-party set would black out the logo and the fonts, and
     the landing set would hand a page with no script an inline-script grant. */
  const firstParty = csp(firstPartyPageHeaders(null));
  assert.equal(/img-src/.test(firstParty), false, "the first-party set grants no img-src");
  assert.equal(/font-src/.test(firstParty), false, "and no font-src");

  const landing = csp(landingPageHeaders(null));
  assert.ok(
    landing.includes("script-src 'self' 'unsafe-inline'"),
    "the landing set grants inline script the not-found page has no use for",
  );
});
