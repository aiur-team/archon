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

test("the onboarding page walks the four steps, in order", () => {
  const page = read(WELCOME);
  const steps = [
    "Tell your agent:",
    "Your agent redirects you to an authorise page to approve the publication.",
    "Your agent uploads your artifact to Archon.",
    "Share your doc with others and collaborate.",
  ];
  let cursor = -1;
  for (const step of steps) {
    const at = page.indexOf(step, cursor + 1);
    assert.notEqual(at, -1, `the onboarding page no longer says: ${step}`);
    assert.ok(at > cursor, `the onboarding steps are out of order at: ${step}`);
    cursor = at;
  }
});

test("the onboarding page holds no session and reaches no network but the fonts", () => {
  const page = read(WELCOME);
  for (const name of ["fetch(", "XMLHttpRequest", "document.cookie"]) {
    assert.equal(page.includes(name), false, `the onboarding page must not use ${name}`);
  }
  const origins = [...page.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
  for (const origin of origins) {
    assert.ok(
      ["fonts.googleapis.com", "fonts.gstatic.com", "github.com", "archon.aiur.team"].includes(origin),
      `the onboarding page names an unexpected origin: ${origin}`,
    );
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
