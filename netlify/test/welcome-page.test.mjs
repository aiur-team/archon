/**
 * The onboarding page, asserted against the repository itself.
 *
 *   node --test netlify/test/welcome-page.test.mjs
 *
 * The page at `netlify/public/welcome/index.html` shows the same agent prompt
 * the splash at `site/index.html` shows, and "the same" has to mean *the same
 * string* rather than a string somebody copied once. Two hand-written HTML files
 * cannot share a constant — neither is generated, and a static page cannot
 * import one — so the equality is enforced here instead: the `#agentPrompt` text
 * is read out of both files and compared. Change the prompt on one page without
 * the other and this fails, which is the only thing that stops the two from
 * drifting apart in silence.
 *
 * The rest of the file asserts the properties the ticket's four steps and the
 * route wiring are made of, each one a thing a future edit could remove without
 * any other test noticing: the four steps are present and in order, the path
 * every layer names is the same `/welcome`, and the page reaches no network and
 * holds no session.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HOSTED_LIMITS } from "../lib/hosted/contracts.mjs";
import { RESERVED_FIRST_SEGMENTS, validateDestination } from "../lib/hosted/identity.mjs";
import { isLandingPage } from "../lib/edge-host.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const SPLASH = "site/index.html";
const WELCOME = "netlify/public/welcome/index.html";

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

/**
 * The text inside the one `id="agentPrompt"` element, or a failure naming the
 * file. It is a regular expression rather than a parser because the assertion is
 * about one line of one hand-written file, and a parse would introduce a
 * dependency whose behaviour then has to be trusted for a single `<span>`.
 */
function agentPrompt(path) {
  const source = read(path);
  const matches = [...source.matchAll(/<span[^>]*\bid="agentPrompt"[^>]*>([^<]*)<\/span>/g)];
  assert.equal(matches.length, 1, `${path} must hold exactly one #agentPrompt element`);
  return matches[0][1];
}

test("the onboarding page shows the splash's agent prompt, byte for byte", () => {
  const splash = agentPrompt(SPLASH);
  assert.equal(
    agentPrompt(WELCOME),
    splash,
    "the onboarding prompt and the splash prompt have drifted apart",
  );
  assert.equal(
    splash,
    "Turn my artifact into an Archon doc: https://archon.aiur.team",
    "and the prompt is still the one the product tells people to paste",
  );
});

test("the onboarding page walks the three steps, in order", () => {
  const page = read(WELCOME);
  const steps = [
    "Tell your agent:",
    /* The redirect and the upload are one step, in one sentence. Asserted as the
       exact string because "roughly this" is what let the two halves drift into
       two steps in the first place. */
    "Your agent redirects you to authorize and uploads your artifact to Archon.",
    "Share your doc with others and collaborate.",
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = page.indexOf(step, cursor + 1);
    assert.notEqual(at, -1, `the onboarding page no longer says: ${step}`);
    assert.ok(at > cursor, `the onboarding steps are out of order at: ${step}`);
    cursor = at;
  }
  /* The numbers are hand-written, so a merged step leaves a stale "4" behind
     unless something reads them back. */
  const numbers = [...page.matchAll(/<span class="step-no" aria-hidden="true">(\d+)<\/span>/g)]
    .map((m) => m[1]);
  assert.deepEqual(numbers, ["1", "2", "3"], "the onboarding steps are misnumbered");
});

test("the onboarding page reaches no network but the fonts and its own session route", () => {
  const page = read(WELCOME);
  /* The page reads no cookie and keeps no store of its own. It does make one
     request, and exactly one: the session route, same-origin, which is the only
     way a static page can learn whether to draw a Sign in pill or an account.
     Anything else - a second endpoint, a third-party beacon - fails here. */
  for (const name of ["XMLHttpRequest", "document.cookie", "localStorage", "sessionStorage"]) {
    assert.equal(page.includes(name), false, `the onboarding page must not use ${name}`);
  }
  const fetched = [...page.matchAll(/fetch\(\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(fetched, ["/api/hosted/session"], "the onboarding page fetches one path");

  const origins = [...page.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
  for (const origin of origins) {
    assert.ok(
      ["fonts.googleapis.com", "fonts.gstatic.com", "github.com", "archon.aiur.team"].includes(origin),
      `the onboarding page names an unexpected origin: ${origin}`,
    );
  }
});

/**
 * One marked region out of a file, or a failure naming the file and the marker.
 *
 * The markers are the ordinary comment syntax of whichever language the region
 * is written in, so the same helper reads the CSS block, the HTML block and the
 * script block: it takes the text strictly between `<marker>:start` and
 * `<marker>:end` and leaves the comment lines that carry those words out of the
 * comparison, because only one of the two files can name the other first.
 */
function markedRegion(path, marker) {
  const source = read(path);
  const start = source.indexOf(`${marker}:start`);
  const end = source.indexOf(`${marker}:end`, start + 1);
  assert.notEqual(start, -1, `${path} has no ${marker}:start marker`);
  assert.notEqual(end, -1, `${path} has no ${marker}:end marker`);
  const from = source.indexOf("\n", start);
  return source.slice(from + 1, source.lastIndexOf("\n", end) + 1);
}

test("the signed-in nav is one component, written identically on both pages", () => {
  /* The splash and the onboarding page show the same nav: a Sign in pill when
     nobody is signed in, and the visitor's avatar, handle and a Log out menu
     when somebody is. Neither page is generated and neither can import the
     other, so the three blocks that make up the component - its styles, its
     markup and the script that drives it - are written twice and compared here,
     exactly as the agent prompt above is. A change to one page that is not made
     to the other fails CI instead of leaving the two pages disagreeing about
     who the visitor is. */
  for (const marker of ["nav", "nav-script"]) {
    assert.equal(
      markedRegion(WELCOME, marker),
      markedRegion(SPLASH, marker),
      `the ${marker} block has drifted apart between the splash and the onboarding page`,
    );
  }
});

test("the nav's Log out is a POST that carries its CSRF token, on both pages", () => {
  for (const path of [SPLASH, WELCOME]) {
    const page = read(path);
    /* A link would not do: the route answers 405 to GET, deliberately, so that a
       third-party page cannot sign a visitor out with an image tag. And a POST
       with no token is refused, so the field has to be there and has to be
       filled from the session response. */
    assert.match(
      page,
      /<form method="post" action="\/api\/hosted\/auth\/logout">/,
      `${path} signs out with a real form POST`,
    );
    assert.match(
      page,
      /<input type="hidden" name="csrfToken" id="siteLogoutCsrf" value="">/,
      `${path} carries the CSRF field the logout route reads`,
    );
    assert.ok(
      page.includes("logoutCsrf.value = typeof session.csrfToken"),
      `${path} fills it from the session response`,
    );
    assert.ok(
      !/href="\/api\/hosted\/auth\/logout"/.test(page),
      `${path} never offers logout as a link`,
    );
  }
});

test("the nav renders the account with textContent, never as markup", () => {
  /* `login` and `avatarUrl` are provider-supplied strings. The nav writes them
     through `textContent` and `.value`; an `innerHTML` on either page would be
     the one way a display name could become an element. */
  for (const path of [SPLASH, WELCOME]) {
    const page = read(path);
    assert.equal(page.includes("innerHTML"), false, `${path} assigns no innerHTML`);
    assert.ok(page.includes("accountName.textContent = login"), `${path} writes the handle as text`);
  }
});

test("/welcome is one path, spelled the same by every layer that names it", () => {
  assert.equal(HOSTED_LIMITS.WELCOME_PATH, "/welcome");
  assert.equal(
    validateDestination(HOSTED_LIMITS.WELCOME_PATH),
    HOSTED_LIMITS.WELCOME_PATH,
    "the sign-in destination grammar accepts the page it now defaults to",
  );
  assert.ok(
    isLandingPage(HOSTED_LIMITS.WELCOME_PATH),
    "and the edge gate serves it publicly, as a landing page",
  );
  assert.ok(
    RESERVED_FIRST_SEGMENTS.includes("welcome"),
    "so no collaboration document may claim the slug",
  );
});
