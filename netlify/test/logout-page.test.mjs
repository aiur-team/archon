/**
 * The sign-out page at `/logout`, asserted against the repository itself.
 *
 *   node --test netlify/test/logout-page.test.mjs
 *
 * The page exists so that visiting `https://archon.aiur.team/logout` signs you
 * out. What it must never become is a GET that performs the sign-out:
 * `POST /api/hosted/auth/logout` refuses GET deliberately, because a logout on
 * GET can be triggered by any third-party page with an image tag. So the
 * properties this file holds are the ones that keep the address hittable and
 * the sign-out a first-party, token-carrying, browser-submitted POST:
 *
 *   * the page is a real `<form method="post">` at the route's own path,
 *     carrying a `csrfToken` hidden field, with a real submit button;
 *   * the token is read from `GET /api/hosted/session`, the same one request the
 *     splash nav makes, and from nowhere else;
 *   * the form is submitted on load once the token is in hand, so no click is
 *     needed, and the button remains for no-JavaScript and failed bootstrap;
 *   * an already-signed-out visitor gets a plain answer and a link home, and
 *     posts nothing;
 *   * the page never offers the route as a link or a GET of any kind;
 *   * `logout` is reserved by every layer that could otherwise let a document
 *     slug claim it, and the path is outside the session gate so a signed-out
 *     visitor reaches a page rather than a sign-in redirect.
 *
 * They are asserted here rather than in a browser because each one is a property
 * of the committed bytes, and a hand-written static page has nothing else that
 * would notice an edit that removed one.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RESERVED_FIRST_SEGMENTS } from "../lib/hosted/identity.mjs";
import { isApplicationPassThrough, isLandingPage } from "../lib/edge-host.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const PAGE = "netlify/public/logout/index.html";
const SCRIPT = "netlify/public/logout/logout.js";

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

test("the page posts to the logout route and carries the CSRF field", () => {
  const page = read(PAGE);
  assert.match(
    page,
    /<form id="logout" method="post" action="\/api\/hosted\/auth\/logout"/,
    "the sign-out is a real form POST at the route's own path",
  );
  assert.match(
    page,
    /<input type="hidden" name="csrfToken" id="csrf" value="" \/>/,
    "and it carries the field the route reads the token out of",
  );
  assert.match(
    page,
    /<button type="submit" id="submit">Log out<\/button>/,
    "with a real submit button as the no-script fallback",
  );
});

test("the page never offers the logout route as a GET", () => {
  /* The route answers 405 to GET on purpose. A link, a redirect or an image
     pointed at it would either be dead or -- on a route that ever relaxed --
     the CSRF sign-out the 405 exists to prevent. */
  const page = read(PAGE);
  const script = read(SCRIPT);
  for (const [name, source] of [[PAGE, page], [SCRIPT, script]]) {
    assert.equal(
      /href\s*=\s*["']\/api\/hosted\/auth\/logout/.test(source),
      false,
      `${name} must never link the logout route`,
    );
    assert.equal(
      source.includes('fetch("/api/hosted/auth/logout"'),
      false,
      `${name} must not fetch the logout route`,
    );
  }
  assert.equal(
    /method="(get|GET)"/.test(page),
    false,
    "and the page holds no GET form at all",
  );
});

test("the token comes from the session route, and that is the page's one request", () => {
  const script = read(SCRIPT);
  const fetched = [...script.matchAll(/fetch\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(fetched, ["/api/hosted/session"], "the page makes exactly one request");
  assert.ok(
    script.includes("session.csrfToken"),
    "and reads the session-bound token out of its answer",
  );
  assert.ok(script.includes('credentials: "same-origin"'), "same-origin, as the splash nav does");
  /* The page keeps no store of its own and reads no cookie: the token it posts
     is the one the server just derived from the session cookie, and nothing on
     this page outlives the navigation. */
  for (const name of ["XMLHttpRequest", "document.cookie", "localStorage", "sessionStorage"]) {
    assert.equal(script.includes(name), false, `the page must not use ${name}`);
  }
});

test("the form is submitted on load, not on a click", () => {
  const script = read(SCRIPT);
  assert.ok(
    script.includes("form.submit()"),
    "visiting the URL is the request to be signed out, so the submit happens on load",
  );
  assert.equal(
    /\bsubmit\.click\(\)/.test(script),
    false,
    "and it submits the form rather than synthesising a click on the fallback button",
  );
  /* The form starts hidden and is revealed only with a token in the field. A
     button that is only ever refused is worse than no button. */
  assert.match(read(PAGE), /<form id="logout"[^>]*\shidden>/, "the form starts hidden");
  assert.ok(script.includes("form.hidden = false"), "and is shown once the token is in hand");
});

test("a signed-out visitor is told so and posts nothing", () => {
  const page = read(PAGE);
  const script = read(SCRIPT);
  assert.match(page, /id="signed-out" hidden/, "the signed-out panel starts hidden");
  assert.ok(
    page.includes("You are already signed out of Archon."),
    "and says plainly that there is nothing to sign out of",
  );
  assert.match(
    page,
    /<p class="home"><a href="\/">Back to the home page<\/a><\/p>/,
    "and links back to the home page instead",
  );
  assert.ok(script.includes("function showSignedOut"), "the script has that branch");
  /* The branch is taken whenever no token was obtained -- signed out, or a
     signed-in answer with no token in it -- and it leaves the form hidden, so
     the page cannot post a request the route would refuse. */
  assert.ok(
    /if \(token === ""\) showSignedOut\(\);/.test(script),
    "and takes it whenever no token was obtained",
  );
});

test("the page carries no inline script, so it needs no inline-script grant", () => {
  /* It takes the first-party page header set, whose `script-src` is `'self'`
     with no `'unsafe-inline'`. An inline `<script>` here would be a page that
     silently does nothing on the live site, or a reason to loosen the set. */
  const page = read(PAGE);
  const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [' src="./logout.js"'], "one external, same-origin script");
  assert.equal(page.includes("</script>"), true, "and it is closed");
});

test("/logout is served with no session check, and is not a landing page", () => {
  /* A signed-out visitor has to reach the page to be told they are signed out,
     which means the path cannot be behind the session gate. It is a
     pass-through rather than a landing page because it takes the first-party
     page set: it holds a form and needs no inline script or font origin. */
  for (const path of ["/logout", "/logout/", "/logout/logout.js"]) {
    assert.ok(isApplicationPassThrough(path), `${path} passes through with no session check`);
    assert.equal(isLandingPage(path), false, `${path} is not a landing page`);
  }
});

test("the pass-through is exact paths, never a prefix", () => {
  /* `/logout-notes/` and `/logoutx/` are legal collaboration slugs under
     `[a-z0-9-]{1,64}`. A `"/logout"` prefix entry would have passed somebody
     else's document straight through the session gate, which is the same defect
     the exact `/admin` entry beside it exists to avoid. */
  for (const path of [
    "/logout-notes/",
    "/logoutx/",
    "/logout/index.html",
    "/logout/anything",
    "/logoutter",
  ]) {
    assert.equal(isApplicationPassThrough(path), false, `${path} must stay gated`);
  }
});

test("logout is reserved by every layer that names a first segment", () => {
  assert.ok(
    RESERVED_FIRST_SEGMENTS.includes("logout"),
    "so a sign-in destination can never be a document slug spelled `logout`",
  );
  /* The builder refuses the slug at build time, and the gate keeps its own copy
     of the list for the destination it offers a refused path. Both are read
     here as text, because neither is importable from this file: the builder is
     TypeScript compiled elsewhere and the gate is a Deno module. */
  const site = readFileSync(join(ROOT, "templates/docbuild/src/site.ts"), "utf8");
  const reserved = site.slice(site.indexOf("const RESERVED_ROUTES"));
  assert.match(
    reserved.slice(0, reserved.indexOf("]")),
    /"logout",/,
    "templates/docbuild/src/site.ts reserves the route so no document slug claims it",
  );
  const gate = readFileSync(join(ROOT, "netlify/edge-functions/gate.ts"), "utf8");
  const segments = gate.slice(gate.indexOf("const RESERVED_FIRST_SEGMENTS"));
  assert.match(
    segments.slice(0, segments.indexOf("]")),
    /"logout",/,
    "and the gate never offers /logout/ as a sign-in destination",
  );
});

test("the build rewrites the exact /logout spelling with no trailing-slash hop", () => {
  /* `/logout` is the address an operator types. Without the rewrite Netlify
     answers that spelling with a 301 to `/logout/`, which is a second path each
     layer has to classify for no gain. */
  const site = readFileSync(join(ROOT, "templates/docbuild/src/site.ts"), "utf8");
  assert.ok(
    site.includes('"/logout /logout/index.html 200"'),
    "the hosted rewrites name the page the pass-through list names",
  );
});
