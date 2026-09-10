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

/** A fetch that records what it was asked and answers one canned status. */
const stubFetch = (status, calls = []) => {
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { status };
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
  assert.equal(siteHostname({ NETLIFY: "true" }), null);
  assert.equal(siteHostname({ NETLIFY: "true", SITE_NAME: "   " }), null);
  assert.equal(siteHostname({}), null);
});

test("an explicit hostname overrides the derivation", () => {
  assert.equal(siteHostname({ ARCHON_SITE_HOSTNAME: "other.netlify.app" }), "other.netlify.app");
  assert.equal(
    siteHostname({ ...NETLIFY, ARCHON_SITE_HOSTNAME: "other.netlify.app" }),
    "other.netlify.app",
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

test("every redirect status fails the build", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { code, line } = await checkSiteHostname(NETLIFY, stubFetch(status));
    assert.equal(code, 1, `${status} was not treated as a redirect`);
    assert.match(line, /^FAIL site hostname: /);
    assert.match(line, new RegExp(`answered ${status}`));
    assert.match(line, /archon-fixture\.netlify\.app/);
  }
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

test("the failure line names no redirect target", async () => {
  // A deploy log gets pasted into an issue. The hostname and the status are
  // enough to act on; the operator-configured destination is not this gate's to
  // republish.
  const fetchFn = async () => ({ status: 301, headers: { get: () => "https://private.example.com/" } });
  const { line } = await checkSiteHostname(NETLIFY, fetchFn);

  assert.ok(!line.includes("private.example.com"), `the failure line carried the target: ${line}`);
});
