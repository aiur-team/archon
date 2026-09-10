/**
 * The site-hostname pre-flight, against an injected fetch.
 *
 *   node --test scripts/check-site-hostname.test.mjs
 *
 * The thing being guarded is a platform setting nobody here can write: whether
 * the site's default `*.netlify.app` hostname is redirected to the primary
 * domain. So what is testable is the gate itself, and the properties that matter
 * are the ones a silent pass would destroy — that it refuses a 3xx, that it does
 * not follow one, that it skips rather than guesses when there is no site to
 * ask, and that "skip" is never what a redirect produces.
 *
 * No probe leaves the runner: every case passes its own `fetch`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkSiteHostname, probeHostname, siteHostname } from "./check-site-hostname.mjs";

/**
 * A fetch that records what it was asked and answers one canned response.
 *
 * `location` is `undefined` for a response that carries no `Location` header,
 * which is what a 2xx looks like and what a malformed 3xx looks like too.
 */
const stubFetch = (status, location, calls = []) => {
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { status, headers: { get: (name) => (name === "location" ? location ?? null : null) } };
  };
  fetchFn.calls = calls;
  return fetchFn;
};

const NETLIFY = { NETLIFY: "true", SITE_NAME: "archon-fixture" };

test("the hostname comes from the Netlify site name", () => {
  assert.equal(siteHostname(NETLIFY), "archon-fixture.netlify.app");
});

test("off Netlify there is no site to ask", () => {
  assert.equal(siteHostname({ SITE_NAME: "archon-fixture" }), null);
  assert.equal(siteHostname({}), null);
});

test("on Netlify an unnamed site is an error, not a skip", () => {
  // The distinction this gate lives or dies on. Netlify always names the site,
  // so an unset SITE_NAME there is the gate losing its subject -- and a skip
  // would turn every deploy green on one unset variable, which is the exact
  // silent pass this file exists to prevent.
  for (const env of [{ NETLIFY: "true" }, { NETLIFY: "true", SITE_NAME: "   " }]) {
    const result = siteHostname(env);
    assert.ok(result instanceof Error, `an unnamed Netlify site produced ${result}`);
    assert.match(result.message, /SITE_NAME is unset/);
  }
});

test("an unnamed Netlify site fails the build without asking anything", async () => {
  const fetchFn = stubFetch(200);
  const { code, line } = await checkSiteHostname({ NETLIFY: "true" }, fetchFn);

  assert.equal(code, 1);
  assert.match(line, /^FAIL site hostname: /);
  assert.equal(fetchFn.calls.length, 0);
});

test("an explicit hostname is a local override and cannot redirect a deploy's aim", () => {
  assert.equal(siteHostname({ ARCHON_SITE_HOSTNAME: "other.netlify.app" }), "other.netlify.app");
  // On a Netlify build the site names itself. Honouring the override there
  // would let an operator aim this gate at the primary domain -- which answers
  // 200 for itself forever -- while the default hostname was folded into it.
  assert.equal(
    siteHostname({ ...NETLIFY, ARCHON_SITE_HOSTNAME: "somewhere-else.example.com" }),
    "archon-fixture.netlify.app",
  );
});

test("the probe asks over https and does not follow a redirect", async () => {
  const fetchFn = stubFetch(200);
  const result = await probeHostname("archon-fixture.netlify.app", fetchFn);

  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(fetchFn.calls.length, 1);
  assert.equal(fetchFn.calls[0].url, "https://archon-fixture.netlify.app/");
  // Following the redirect would report the custom domain's 200, which is
  // exactly the answer this check exists to disbelieve.
  assert.equal(fetchFn.calls[0].options.redirect, "manual");
});

test("every redirect status to another host fails the build", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const fetchFn = stubFetch(status, "https://archon.example.com/");
    const { code, line } = await checkSiteHostname(NETLIFY, fetchFn);
    assert.equal(code, 1, `${status} was not treated as a hostname redirect`);
    assert.match(line, /^FAIL site hostname: /);
    assert.match(line, new RegExp(`answered ${status}`));
    assert.match(line, /archon-fixture\.netlify\.app/);
    assert.match(line, /archon\.example\.com/, "the operator is not told which domain it was folded into");
  }
});

test("the site's own redirect is not the platform's, and passes", async () => {
  // The edge gate sends an unauthenticated visitor to `/login/`, and this probe
  // carries no session, so a same-host 3xx is the *ordinary* answer here.
  // Failing on it would fail every correct deploy -- and a check that fails
  // correct deploys gets switched off, which is how the real setting stops
  // being guarded at all.
  for (const location of [
    "/login/?next=%2F",
    "https://archon-fixture.netlify.app/login/",
    "/how-archon-works/",
  ]) {
    const { code, line } = await checkSiteHostname(NETLIFY, stubFetch(302, location));
    assert.equal(code, 0, `a same-host redirect to ${location} failed the build`);
    assert.match(line, /^PASS site hostname: /);
  }
});

test("a redirect with no target is not an answer to publish on", async () => {
  // A relative Location is not in this list: resolved against the probe URL it
  // stays on this hostname, which is the site routing itself and is fine.
  for (const location of [undefined, ""]) {
    const { code, line } = await checkSiteHostname(NETLIFY, stubFetch(302, location));
    assert.equal(code, 1, `a 302 with Location ${JSON.stringify(location)} passed`);
    assert.match(line, /^FAIL site hostname: /);
  }
});

test("the failure line carries no redirect path or query", async () => {
  // A redirect on this site can carry a `next` parameter naming a private
  // document path, and a deploy log is what gets pasted into an issue.
  const fetchFn = stubFetch(302, "https://archon.example.com/d/3c7f1a?next=%2Fprivate-doc%2F");
  const { line } = await checkSiteHostname(NETLIFY, fetchFn);

  assert.ok(!line.includes("private-doc"), `the failure line carried the redirect query: ${line}`);
  assert.ok(!line.includes("3c7f1a"), `the failure line carried the redirect path: ${line}`);
});

test("a non-redirect answer passes, including a 404 and a 500", async () => {
  // Not every unhappy status moves the renderer origin. A path that has not
  // deployed yet and an origin having an outage both leave the hostname where
  // it is, and failing a build on either would be a gate nobody could keep on.
  for (const status of [200, 204, 404, 500]) {
    const { code, line } = await checkSiteHostname(NETLIFY, stubFetch(status));
    assert.equal(code, 0, `${status} failed the build`);
    assert.match(line, /^PASS site hostname: /);
  }
});

test("an unreachable hostname fails rather than warns", async () => {
  const fetchFn = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };
  const { code, line } = await checkSiteHostname(NETLIFY, fetchFn);

  assert.equal(code, 1);
  assert.match(line, /^FAIL site hostname: /);
  assert.match(line, /could not be reached/);
});

test("with no site configured the check skips without asking anything", async () => {
  const fetchFn = stubFetch(301);
  const { code, line } = await checkSiteHostname({}, fetchFn);

  assert.equal(code, 0);
  assert.match(line, /^SKIP site hostname: /);
  assert.equal(fetchFn.calls.length, 0, "a build with no site made a network request");
});

