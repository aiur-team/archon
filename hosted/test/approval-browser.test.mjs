#!/usr/bin/env node
/**
 * The approval page's browser oracle.
 *
 *   node --test --test-timeout=1200000 hosted/test/approval-browser.test.mjs
 *
 * ## Why a real engine
 *
 * `/publish/authorize` is defined in terms of things a hand-written DOM cannot
 * be asked about without asking about my own approximation of one: whether
 * `location.hash` is gone after load and gone from history too, whether a cookie
 * with the `__Host-` prefix actually survives a full navigation out to a
 * provider and back, whether an agent-chosen title reaches the page as *text*,
 * and whether nothing at all reaches the decision route until a human presses a
 * button. Those are engine behaviours. So this drives Chromium.
 *
 * ## What is real here and what is a fixture
 *
 * Real: every hosted handler in the flow - session, bind, review, decision, and
 * both halves of the GitHub sign-in - running the same exported implementations
 * the deploy runs, over the real `AuthStore` and the real publication adapter.
 * Real: `public/publish/authorize.html` and `authorize.js`, served byte for
 * byte, under the same Content-Security-Policy `netlify.toml` puts on them.
 *
 * Fixtures: the blob provider is the in-memory double with real conditional
 * writes, the clock is hand-driven, and GitHub is a stand-in on this same
 * loopback origin - the start route's redirect out is rewritten to it, it
 * answers the way a consenting provider does, and the real callback route's
 * token exchange is answered by the same `githubProvider` fixture the auth
 * suite uses. The browser aborts every request that is not loopback, so a
 * fixture that stopped standing in fails loudly instead of reaching the
 * internet. No credential and no network beyond loopback.
 *
 * ## Why it is one case with its own timeout
 *
 * It installs a pinned Playwright and one Chromium into a `mkdtemp()` root
 * outside the worktree, never falling back to a system browser or another
 * version. That is minutes of network on a cold runner and has nothing to do
 * with any individual assertion, so the whole matrix runs as a single
 * `node:test` case carrying its own timeout - which overrides the runner's
 * `--test-timeout` rather than fighting it. The matrix collects every failure
 * and reports them together, so one run names all of them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LOCAL_TEST, readHostedConfig } from "../lib/config.mjs";
import { validatePublication } from "../lib/contracts.mjs";
import { withErrorBoundary } from "../lib/http.mjs";
import { createPublicationStore, PUBLICATION_KEY_PREFIX } from "../lib/publication-store.mjs";
import { createStartRoute } from "../functions/auth-github-start.mjs";
import { createCallbackRoute } from "../functions/auth-github-callback.mjs";
import { SESSION_COOKIE_MAX_AGE, serializeCookie } from "../lib/identity.mjs";
import { createSessionRoute } from "../functions/session.mjs";
import { createBindRoute } from "../functions/publications-bind.mjs";
import { createReviewRoute } from "../functions/publications-review.mjs";
import { createDecisionRoute } from "../functions/publications-decision.mjs";
import { MemoryBlobStore, fixedClock, githubProvider, memoryAuthStore } from "./fixtures/auth.mjs";
import { FIXTURE_NOW, FIXTURE_RECORD_BROWSER_SECRET, RECORDS } from "./fixtures/publications.mjs";
import { createClock, createProviderDouble, sequentialRandomBytes } from "./helpers/publication-store.mjs";

const SELF = fileURLToPath(import.meta.url);
const HOSTED = resolve(dirname(SELF), "..");
const PLAYWRIGHT = "playwright@1.55.0";
/* Per `spawnSync` call, and there are two of them - the package and the browser.
   Both have to fit inside `TEST_TIMEOUT_MS` with the matrix, or a genuinely cold
   runner reports "test timed out" when what actually happened is a slow
   download. */
const INSTALL_DEADLINE_MS = 600_000;
/* Two installs plus the matrix, with room. A per-test timeout overrides the
   runner's `--test-timeout` in both directions, so this number is the real
   budget whatever CI passes. */
const TEST_TIMEOUT_MS = 1_500_000;

/**
 * The exact policy `netlify.toml` serves the static tree under.
 *
 * Copied rather than parsed, for the same reason the header assertions in the
 * route suites are written out: a matrix that read the policy out of the file it
 * is meant to hold would pass no matter what the file said.
 */
const CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com";

/** The account the fixture provider signs in, and the id C1 derives for it. */
const ACCOUNT = { id: 1010, login: "alpha-example", accountId: "gh_1010" };

/** A second account, for the switch. A different numeric id is a different owner. */
const OTHER_ACCOUNT = { id: 2020, login: "beta-example", accountId: "gh_2020" };

/**
 * The deploy configuration this matrix serves the page under.
 *
 * The policy above is a hand copy on purpose - a matrix that read the header out
 * of the file it is meant to hold would pass whatever the file said. But nothing
 * else in the repository asserts that block exists: the workflow's deploy-config
 * step checks only absences, so deleting `[[headers]]`, dropping
 * `connect-src 'self'` or adding `'unsafe-inline'` to `script-src` would leave
 * every gate green while this matrix kept enforcing the old, stricter policy.
 * Reading the file *once*, to check it still declares the same string, closes
 * that loop without making the enforcement circular.
 */
async function assertDeployedPolicyMatches(failures) {
  const toml = await readFile(join(HOSTED, "netlify.toml"), "utf8");
  if (!toml.includes(`Content-Security-Policy = "${CSP}"`)) {
    failures.push("netlify.toml no longer declares the policy this matrix enforces");
  }
  /* And the rewrite that puts the page on the path C3 freezes. Netlify's
     extensionless serving is post-processing, which this deployment disables. */
  if (!/from = "\/publish\/authorize"/.test(toml) || !/to = "\/publish\/authorize\.html"/.test(toml)) {
    failures.push("netlify.toml no longer rewrites /publish/authorize to the committed page");
  }
}

/** Where the provider stand-in listens, on this deployment's own loopback origin. */
const PROVIDER_PATH = "/fixture-provider/authorize";

/**
 * A harness-only endpoint that signs the browser in as somebody else *without*
 * the page finding out.
 *
 * Chromium refuses a `__Host-` cookie set through CDP over `http://`, so the
 * only way to reach the tab-left-open case from a browser is to have the server
 * issue the cookie the way every real route does. The page fetches this without
 * navigating, so it keeps rendering the account it rendered before.
 */
const BECOME_PATH = "/fixture-provider/become";

/** The real endpoint the start route redirects to, and this matrix intercepts. */
const GITHUB_AUTHORIZE_PREFIX = "https://github.com/login/oauth/authorize";

/** A title an agent chose, carrying everything a naive renderer would execute. */
const HOSTILE_TITLE = 'Q3 <img src=x onerror="window.__pwned=1"> & "review" — <script>';

/** A failure in the harness itself, as distinct from a failure in the page. */
function die(message) {
  throw new Error(message);
}

/* ------------------------------------------------------------------ *
 * the pinned engine
 * ------------------------------------------------------------------ */

function install(root) {
  const browsers = join(root, "browsers");
  const npm = spawnSync(
    "npm",
    ["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--silent",
     "--prefix", root, PLAYWRIGHT],
    { stdio: ["ignore", "ignore", "pipe"], timeout: INSTALL_DEADLINE_MS, encoding: "utf8" },
  );
  if (npm.status !== 0) die(`could not install ${PLAYWRIGHT}: ${(npm.stderr || "").split("\n")[0]}`);

  const cli = join(root, "node_modules", "playwright", "cli.js");
  if (!existsSync(cli)) die(`the pinned ${PLAYWRIGHT} install produced no CLI`);
  const chromium = spawnSync(process.execPath, [cli, "install", "chromium"], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: INSTALL_DEADLINE_MS,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  if (chromium.status !== 0) {
    die(`could not install the pinned Chromium: ${(chromium.stderr || "").split("\n")[0]}`);
  }
  return browsers;
}

/* ------------------------------------------------------------------ *
 * the deployment under test
 * ------------------------------------------------------------------ */

/**
 * A publication record built from the pending fixture, with overrides applied
 * and re-validated, so a seed that stopped being a legal record fails here
 * rather than teaching the page a shape production cannot produce.
 */
function seedRecord(overrides = {}) {
  const { descriptor, ...rest } = overrides;
  return validatePublication({
    ...RECORDS.pending,
    ...rest,
    descriptor: { ...RECORDS.pending.descriptor, ...(descriptor ?? {}) },
  });
}

/** Every hosted route this flow touches, over one pair of stores and clocks. */
async function startDeployment(record) {
  const provider = createProviderDouble();
  provider.put(`${PUBLICATION_KEY_PREFIX}${record.id}`, JSON.stringify(record));

  const publicationClock = createClock(FIXTURE_NOW);
  const authClock = fixedClock(Date.parse(FIXTURE_NOW));
  const { store } = memoryAuthStore(authClock, new MemoryBlobStore());
  /* Which account the provider says it is, changeable mid-case so a test can
     drive the "use a different GitHub account" path through the real start and
     callback routes rather than around them. */
  const account = { current: ACCOUNT };
  const fetchImpl = githubProvider({
    user: () =>
      new Response(JSON.stringify({ id: account.current.id, login: account.current.login }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  const html = await readFile(join(HOSTED, "public/publish/authorize.html"), "utf8");
  const script = await readFile(join(HOSTED, "public/publish/authorize.js"), "utf8");

  /* Bound once the listener has a port, because the handlers are configured with
     the origin they must demand exactly. */
  let dependencies = null;
  const routes = new Map();
  const seen = [];

  const server = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, dependencies.origin);
    /* The query string and the request headers are recorded as well as the
       path, because the invariant this matrix has to hold is that the link's
       secret is exchanged in a same-origin POST body and reaches the server no
       other way. With only `{method, path}` kept, a bind URL carrying
       `?s=<browserSecret>` - or a secret copied into a header, or into a
       `Referer` - passed every case in this file. */
    seen.push({
      method: incoming.method,
      path: url.pathname,
      search: url.search,
      headers: { ...incoming.headers },
    });

    const asset = staticAsset(url.pathname);
    if (asset !== null) {
      outgoing.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "private, no-store",
        "content-security-policy": CSP,
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      });
      outgoing.end(asset.body);
      return;
    }

    /* GitHub's authorize endpoint, standing on loopback.
       The redirect to it is a *server* redirect on the same navigation as the
       form POST, and Playwright does not consult a route handler for those - so
       intercepting it in the browser silently reached the real github.com. The
       start route still runs in full: it mints and stores the state, sets its
       cookie, derives PKCE and validates the destination. Only the hop out is
       redirected here, and this answers it the way a consenting provider does. */
    if (url.pathname === PROVIDER_PATH) {
      const state = url.searchParams.get("state") ?? "";
      outgoing.writeHead(302, {
        location: `${dependencies.origin}/api/hosted/auth/github/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
        "cache-control": "private, no-store",
      });
      outgoing.end();
      return;
    }

    if (url.pathname === BECOME_PATH) {
      const { token } = await store.createSession({
        accountId: OTHER_ACCOUNT.accountId,
        provider: "github.com",
        providerUserId: String(OTHER_ACCOUNT.id),
        login: OTHER_ACCOUNT.login,
      });
      outgoing.writeHead(204, {
        "set-cookie": serializeCookie("__Host-archon_session", token, {
          maxAgeSeconds: SESSION_COOKIE_MAX_AGE,
        }),
        "cache-control": "private, no-store",
      });
      outgoing.end();
      return;
    }

    const handler = routes.get(routeKeyOf(url.pathname));
    if (handler === undefined) {
      outgoing.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("not found");
      return;
    }

    const body =
      incoming.method === "GET" || incoming.method === "HEAD" ? undefined : await readBody(incoming);
    const response = await handler(
      new Request(new URL(incoming.url, dependencies.origin), {
        method: incoming.method,
        headers: incoming.headers,
        body,
      }),
    );

    const headers = {};
    for (const [name, value] of response.headers) {
      if (name.toLowerCase() !== "set-cookie") headers[name] = value;
    }
    if (typeof headers.location === "string" && headers.location.startsWith(GITHUB_AUTHORIZE_PREFIX)) {
      headers.location = `${dependencies.origin}${PROVIDER_PATH}?${new URL(headers.location).searchParams}`;
    }
    /* `Set-Cookie` is the one header that must stay a list: joining two of them
       into one value is how a route that clears one cookie and sets another
       silently sets neither. */
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    outgoing.writeHead(response.status, headers);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });

  function staticAsset(pathname) {
    if (pathname === "/publish/authorize") return { type: "text/html; charset=utf-8", body: html };
    if (pathname === "/publish/authorize.js") {
      return { type: "text/javascript; charset=utf-8", body: script };
    }
    /* The sign-in page is where a failed callback lands. The matrix only ever
       asserts the URL it landed on, so a marker body is enough and importing the
       real page would test AHU-003's shell rather than this one's. */
    if (pathname === "/login/") return { type: "text/html; charset=utf-8", body: "<!doctype html><title>sign in</title>" };
    return null;
  }

  /** Collapse the one templated segment so a route lookup is a plain map. */
  function routeKeyOf(pathname) {
    return pathname.replace(/^\/api\/hosted\/publications\/[^/]+\/(review|decision)$/, "/api/hosted/publications/:id/$1");
  }

  const origin = await new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => ready(`http://127.0.0.1:${server.address().port}`));
  });

  const config = readHostedConfig(
    {
      HOSTED_APP_ORIGIN: origin,
      HOSTED_RENDER_ORIGIN: "http://127.0.0.1:1",
      GITHUB_CLIENT_ID: "Iv1.fixture0client",
      GITHUB_CLIENT_SECRET: "fixture-client-secret-value",
      HOSTED_PUBLISH_ENABLED: "true",
    },
    { mode: LOCAL_TEST },
  );

  const publications = {
    store: createPublicationStore({ getStore: provider.getStore }),
    appOrigin: origin,
    production: false,
    publishEnabled: true,
    now: publicationClock.now,
    randomBytes: sequentialRandomBytes(),
  };
  dependencies = { origin, config, store, publications };

  routes.set("/api/hosted/session", withErrorBoundary(createSessionRoute({ store })));
  routes.set("/api/hosted/auth/github/start", withErrorBoundary(createStartRoute({ store, config })));
  routes.set(
    "/api/hosted/auth/github/callback",
    withErrorBoundary(createCallbackRoute({ store, config, fetchImpl })),
  );
  routes.set("/api/hosted/publications/bind", createBindRoute(() => dependencies));
  routes.set("/api/hosted/publications/:id/review", createReviewRoute(() => dependencies));
  routes.set("/api/hosted/publications/:id/decision", createDecisionRoute(() => dependencies));

  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    origin,
    seen,
    publicationClock,
    authClock,
    /** What the provider answers with from the next exchange onwards. */
    switchTo(next) {
      account.current = next;
    },
    stored() {
      const raw = provider.raw(`${PUBLICATION_KEY_PREFIX}${record.id}`);
      return raw === null ? null : JSON.parse(raw.data);
    },
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy();
        server.close(done);
      }),
  };
}

async function readBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

/* ------------------------------------------------------------------ *
 * the matrix
 * ------------------------------------------------------------------ */

/**
 * Answer GitHub's authorize URL with a redirect straight back to the real
 * callback route, carrying the `state` the real start route just minted.
 *
 * This is the whole provider round trip, minus the provider: the browser really
 * navigates away and really comes back, which is the part that decides whether a
 * `SameSite=Lax` `__Host-` cookie and a `sessionStorage` entry survive.
 */
async function refuseTheInternet(context, origin) {
  await context.route(/.*/, async (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    /* Nothing in this matrix has any business leaving loopback. Aborting rather
       than allowing turns "the fixture stopped standing in for the provider"
       into a visible failure instead of a minute spent on github.com's real
       sign-in page, which is exactly how an earlier version of this file wasted
       one. */
    return route.abort();
  });
}

async function runMatrix(chromium) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(message);
  };
  const eq = (actual, expected, message) =>
    check(actual === expected, `${message} (saw ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)})`);

  await assertDeployedPolicyMatches(failures);

  const browser = await chromium.launch();
  try {

  /** One case: a fresh deployment, a fresh isolated browser context. */
  async function withCase(record, run, { contextOptions = {} } = {}) {
    const app = await startDeployment(record);
    const context = await browser.newContext(contextOptions);
    await refuseTheInternet(context, app.origin);
    const page = await context.newPage();
    try {
      await run({ app, page, context });
    } finally {
      /* Checked after every case rather than in one of them: the rule is about
         where the secret may appear at all, so the case most likely to break it
         is whichever one is added next. A fragment is never sent to a server, so
         any sighting here means some code put it somewhere a fragment is not -
         a query string, a header, a path - which is also where access logs and
         proxies would keep it. */
      for (const entry of app.seen) {
        check(
          !carriesTheSecret(entry),
          `no request may carry the browser secret outside its body: ${entry.method} ` +
            `${entry.path}${entry.search} ${JSON.stringify(entry.headers)}`,
        );
      }
      await context.close();
      await app.close();
    }
  }

  /** Does a recorded request carry the link's secret anywhere but its body? */
  const carriesTheSecret = (entry) =>
    entry.path.includes(FIXTURE_RECORD_BROWSER_SECRET) ||
    entry.search.includes(FIXTURE_RECORD_BROWSER_SECRET) ||
    Object.entries(entry.headers).some(([name, value]) =>
      `${name}: ${[value].flat().join(", ")}`.includes(FIXTURE_RECORD_BROWSER_SECRET),
    );

  const link = (app, record = null, secret = FIXTURE_RECORD_BROWSER_SECRET) =>
    `${app.origin}/publish/authorize#${(record ?? RECORDS.pending).id}.${secret}`;

  const statusOf = (page) => page.textContent("#status");

  /**
   * Wait until the page has finished deciding what to show.
   *
   * The marker is the status region's tone. The served HTML carries no
   * `data-tone` at all and `say()` is the only thing that ever sets one, so
   * `ok` or `error` means the bootstrap ran to one of its ends - which
   * "not pending" would not, because it is also true of the document before any
   * script has touched it.
   */
  async function settled(page, what) {
    try {
      await page.waitForFunction(
        () => ["ok", "error"].includes(document.getElementById("status")?.dataset.tone),
        undefined,
        { timeout: 20_000 },
      );
    } catch (error) {
      /* The most confusing failure in this file is a page that never lands, so
         it names where the browser actually ended up rather than which selector
         never appeared. */
      throw new Error(
        `${what} did not settle: at ${page.url()} showing ${JSON.stringify(
          await page.textContent("#status").catch(() => null),
        )}`,
        { cause: error },
      );
    }
  }

  /** Open the approval page and wait for its bootstrap to finish. */
  async function open(page, url) {
    await page.goto(url);
    await settled(page, "the approval page");
  }

  /** Follow the sign-in button all the way back to the approval page. */
  async function signIn(page) {
    await page.waitForSelector("#signin:not([hidden])");
    await Promise.all([page.waitForNavigation(), page.click("#signin-submit")]);
    await settled(page, "sign-in");
  }

  /* -------- 1. the fragment is gone, and gone from history too -------- */
  await withCase(seedRecord(), async ({ app, page, context }) => {
    /* From a real previous page, so "did the token become a history entry" is a
       question with an answer rather than a comparison against whatever a fresh
       context happens to start with. */
    await page.goto(`${app.origin}/login/`);
    const entriesBefore = await page.evaluate(() => window.history.length);

    await open(page, link(app));

    /* And the exchange must have *worked*. Without this, every other assertion
       in this case holds when bind is refused for every input - the fragment is
       stripped before any request either way - so the cheapest possible
       regression is the one it would not detect. */
    eq(await statusOf(page), "Sign in with GitHub to see what is being published.",
      "a bound, signed-out visitor must be asked to sign in");
    check(
      (await context.cookies()).some((cookie) => cookie.name === "__Host-archon_publish"),
      "the bind must leave the browser holding a pending binding",
    );

    eq(new URL(page.url()).hash, "", "the fragment must be removed from the address bar");
    eq(page.url(), `${app.origin}/publish/authorize`, "the URL must be the bare authorize path");
    check(
      !(await page.content()).includes(FIXTURE_RECORD_BROWSER_SECRET),
      "the browser secret must never be rendered into the page",
    );
    eq(await page.evaluate(() => window.history.length), entriesBefore + 1,
      "replaceState must replace the entry rather than add one");
    check(
      !(await page.evaluate(() => JSON.stringify(window.sessionStorage))).includes(
        FIXTURE_RECORD_BROWSER_SECRET,
      ),
      "the browser secret must never be persisted",
    );
    /* And the entry it replaced is gone for good: Back leaves the flow rather
       than returning to a URL that still carries the token. */
    await page.goBack();
    eq(page.url(), `${app.origin}/login/`, "Back must not return to the token-bearing URL");

    check(
      app.seen.some((entry) => entry.path === "/api/hosted/publications/bind"),
      "the bootstrap must exchange the fragment for a server-side binding",
    );
    check(
      !app.seen.some((entry) => entry.path.endsWith("/decision")),
      "nothing may reach the decision route before a human presses a button",
    );
  });

  /* -------- 2. sign-in continuation, account display, escaping -------- */
  await withCase(
    seedRecord({ descriptor: { title: HOSTILE_TITLE, contentBytes: 1_234_567 } }),
    async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);

    await page.waitForSelector("#review:not([hidden])");
    /* The rewrite in the harness is what keeps the sign-in on loopback. If it
       ever stops matching, the browser goes to the real github.com and the
       failure surfaces as a twenty-second timeout rather than as "the provider
       stand-in was bypassed". */
    check(
      app.seen.some((entry) => entry.path === PROVIDER_PATH),
      "the sign-in must have gone through the loopback provider stand-in",
    );
    eq(await page.textContent("#account"), `@${ACCOUNT.login} (${ACCOUNT.accountId})`,
      "the page must name the account that would become owner");
    eq(await page.textContent("#user-code"), RECORDS.pending.userCode, "the pairing code must be shown");
    eq(await page.textContent("#title"), HOSTILE_TITLE, "the title must arrive as text, unaltered");
    /* Grouped by hand rather than by locale, so the number beside a document
       about to be published under somebody's name reads the same everywhere. */
    eq(await page.textContent("#size"), "1,234,567 bytes", "the byte size must be shown");
    eq(await page.evaluate(() => window.__pwned ?? null), null, "a title must never execute");
    eq(await page.evaluate(() => document.querySelectorAll("#title *").length), 0,
      "a title must never become markup");
    check(
      await page.isVisible("#switch-submit"),
      "the different-account action must be available beside the decision",
    );
    eq(await page.isVisible("#signin"), false, "the sign-in prompt must go away once signed in");
    check(
      !app.seen.some((entry) => entry.path.endsWith("/decision")),
      "rendering the review must not decide anything",
    );
  });

  /* -------- 3. switching account keeps the operation and moves the owner ---- */
  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");
    eq(await page.textContent("#account"), `@${ACCOUNT.login} (${ACCOUNT.accountId})`,
      "the first account must be shown before the switch");

    app.switchTo(OTHER_ACCOUNT);
    await Promise.all([page.waitForNavigation(), page.click("#switch-submit")]);
    await settled(page, "the account switch");

    /* C1 keeps the publication binding through an account switch; without that
       the visitor who noticed the wrong account would land back here holding
       nothing. */
    await page.waitForSelector("#review:not([hidden])");
    eq(await page.textContent("#account"), `@${OTHER_ACCOUNT.login} (${OTHER_ACCOUNT.accountId})`,
      "the page must name the account it switched to");

    await page.click("#approve");
    await page.waitForSelector("#review", { state: "hidden" });
    await settled(page, "the decision");
    eq(app.stored().ownerAccountId, OTHER_ACCOUNT.accountId,
      "the owner must be the account that was on screen when the button was pressed");
  });

  /* -------- 3. an explicit approval, and only then -------- */
  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");

    eq(app.stored().state, "pending", "nothing may be approved before the click");
    await page.click("#approve");
    await page.waitForSelector("#review", { state: "hidden" });
    await settled(page, "the decision");

    const stored = app.stored();
    eq(stored.state, "approved", "the click must approve");
    eq(stored.ownerAccountId, ACCOUNT.accountId, "the owner must be the account that was displayed");
    check((await statusOf(page)).startsWith("Approved."), "the outcome must be reported");
    /* The binding is spent: a reload is no longer holding a pending operation. */
    await page.reload();
    await settled(page, "the reload");
    check(
      (await statusOf(page)).startsWith("No pending publication"),
      "the binding must be released once the operation has an answer",
    );
  });

  /* -------- 4. an explicit denial -------- */
  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");
    await page.click("#deny");
    await page.waitForSelector("#review", { state: "hidden" });
    await settled(page, "the decision");

    eq(app.stored().state, "denied", "the click must deny");
    eq(app.stored().html, null, "a denial publishes nothing");
    check((await statusOf(page)).startsWith("Denied."), "a denial must be reported as a normal answer");
  });

  /* -------- 5. failure states, each distinct -------- */
  await withCase(seedRecord({ state: "cancelled" }), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    check(
      (await statusOf(page)).includes("agent cancelled"),
      "a cancelled operation must say so, not fail as transport",
    );
    eq(await page.isVisible("#approve"), false, "a cancelled operation offers no decision");
  });

  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");
    /* The deadline passes while the tab sits open, which is the real case. */
    app.publicationClock.advanceSeconds(901);
    await page.click("#approve");
    await page.waitForSelector("#review", { state: "hidden" });
    await settled(page, "the decision");
    check((await statusOf(page)).includes("expired"), "an expired approval must say it expired");
    eq(app.stored().state, "pending", "an expired approval must write nothing");
  });

  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, `${app.origin}/publish/authorize`);
    check(
      (await statusOf(page)).startsWith("No pending publication"),
      "a bare visit with no link must say there is nothing to approve",
    );
    eq(await page.isVisible("#review"), false, "a bare visit must reveal no document");
  });

  /* -------- 6. a signed-in visitor whose browser refuses site data -------- */
  await withCase(seedRecord(), async ({ app, page, context }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");

    /* A second context carrying the same cookies, with the init script in place
       *before* any page exists. Adding it to a context that already had a page
       silently did not take, and a case that quietly stops blocking anything is
       worse than no case at all - the mutation run caught exactly that as a
       survivor, which is why the probe below now proves the premise. */
    const carried = await context.storageState();
    const blocked = await browser.newContext({
      storageState: { cookies: carried.cookies, origins: [] },
    });
    await refuseTheInternet(blocked, app.origin);
    await blocked.addInitScript(() => {
      /* Safari's cross-site modes, storage-partitioned embeds, private modes and
         an exhausted quota all make these throw. Reading the id back out of
         storage as its *only* source turned that into a permanent dead end: the
         bind had succeeded and the server was holding a real binding, but the
         page said "no pending publication" and every re-open repeated it. */
      for (const method of ["getItem", "setItem", "removeItem", "clear", "key"]) {
        Storage.prototype[method] = () => {
          throw new Error("site data is blocked");
        };
      }
    });

    const denied = await blocked.newPage();
    try {
      /* The same link again, on a load that can persist nothing. The fragment is
         the id's source here, which is the whole point. */
      await open(denied, link(app));

      check(
        await denied.evaluate(() => {
          try {
            window.sessionStorage.setItem("probe", "1");
            return false;
          } catch {
            return true;
          }
        }),
        "this case must actually run with site data blocked",
      );

      await denied.waitForSelector("#review:not([hidden])");
      await denied.click("#approve");
      await denied.waitForSelector("#review", { state: "hidden" });
      await settled(denied, "the decision");
      eq(app.stored().state, "approved",
        "a signed-in visitor whose browser blocks site data must still be able to approve");
    } finally {
      await blocked.close();
    }
  });

  /* -------- 6b. the account changed under an open tab -------- */
  await withCase(seedRecord(), async ({ app, page, context }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");
    eq(await page.textContent("#account"), `@${ACCOUNT.login} (${ACCOUNT.accountId})`,
      "the tab must be showing the first account");

    /* Another tab signed in as somebody else. A same-origin `fetch` rather than
       a navigation, so this tab keeps rendering the account it already rendered
       - which is the whole shape of the case. The click then means "publish as
       the account I can see", and that account is gone. */
    await page.evaluate(
      (path) => fetch(path, { credentials: "same-origin" }),
      "/fixture-provider/become",
    );

    await page.click("#approve");
    await settled(page, "the stale decision");

    eq(app.stored().state, "pending", "a decision against a stale account must publish nothing");
    eq(app.stored().ownerAccountId, null, "and must fix no owner");
    /* The adapter signals this with `csrf_failed`, the same code a wrong token
       gets. Reporting it as "Archon could not verify this page. Select Try
       again." would be the opposite advice for the one case this confirmation
       exists for. */
    check(
      (await statusOf(page)).includes(`now signed in as @${OTHER_ACCOUNT.login}`),
      "the page must say which account it is now, not that a retry might help",
    );
    await page.waitForSelector("#review:not([hidden])");
    eq(await page.textContent("#account"), `@${OTHER_ACCOUNT.login} (${OTHER_ACCOUNT.accountId})`,
      "and must re-render against the account that is actually signed in",
    );
  });

  /* -------- 7. the retry affordance, on a failure retrying can fix -------- */
  await withCase(seedRecord(), async ({ app, page, context }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");

    /* Every request fails at transport from here, which is what an offline
       visitor sees. The page must offer a retry rather than nothing. */
    await context.route(/.*/, (route) => route.abort());
    await page.click("#approve");
    await settled(page, "the failed decision");
    check((await statusOf(page)).includes("not reachable"), "an offline decision must say so");
    check(await page.isVisible("#retry"), "a retryable failure must offer a retry");

    await context.unroute(/.*/);
    await refuseTheInternet(context, app.origin);
    await page.click("#retry");
    await settled(page, "the retry");
    await page.waitForSelector("#review:not([hidden])");
    eq(app.stored().state, "pending", "a retry must not decide anything by itself");
  });

  /* -------- 8. a completed operation reads as published, not as an error ---- */
  await withCase(seedRecord({
    state: "complete",
    ownerAccountId: `gh_${ACCOUNT.id}`,
    uploadExpiresAt: RECORDS.complete.uploadExpiresAt,
    completedAt: RECORDS.complete.completedAt,
    receiptExpiresAt: RECORDS.complete.receiptExpiresAt,
    html: RECORDS.complete.html,
  }), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    check((await statusOf(page)).includes("already published"),
      "a completed operation must read as published");
    eq(await page.isVisible("#approve"), false, "a completed operation offers no decision");
    check(!(await page.content()).includes("<!doctype html>".slice(1)),
      "the approval page must never render the document");
  });

  /* -------- 9. with no JavaScript, the page says so -------- */
  await withCase(
    seedRecord(),
    async ({ app, page }) => {
      await page.goto(link(app));
      const noscript = await page.textContent("noscript");
      check(noscript !== null && noscript.includes("JavaScript is required"),
        "a no-JS visitor must be told why the page is empty");
      check(
        !app.seen.some((entry) => entry.path.startsWith("/api/hosted/")),
        "a no-JS visit must not reach any API route",
      );
    },
    { contextOptions: { javaScriptEnabled: false } },
  );

  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app, null, "not-the-browser-secret-but-long-enough-to-be-well-formed"));
    check(
      (await statusOf(page)).includes("cannot be used"),
      "a link whose secret does not match must be refused, without naming the document",
    );
    check(
      !(await page.content()).includes(RECORDS.pending.userCode),
      "a refused link must not leak the pairing code",
    );
  });

  /* -------- 11. a refused bind must not strand a live approval -------- */
  await withCase(seedRecord(), async ({ app, page }) => {
    await open(page, link(app));
    await signIn(page);
    await page.waitForSelector("#review:not([hidden])");

    /* A second link for the same operation whose secret does not verify. The
       server releases the browser's binding only *after* it has verified the
       new secret, so this leaves the earlier, still-pending operation bound.
       Dropping the remembered id before the request - which is where it used to
       happen - stranded that operation behind a "no pending publication" no
       reload could clear, with the visitor already signed in and the server
       still holding their binding. */
    /* Away first: navigating from `/publish/authorize` to the same path with a
       fragment is a same-document navigation, so the bootstrap would never run
       a second time and the case would assert against the first load. */
    await page.goto(`${app.origin}/login/`);
    await open(page, link(app, null, "not-the-browser-secret-but-long-enough-to-be-well-formed"));
    check(
      (await statusOf(page)).includes("cannot be used"),
      "a link whose secret does not verify must be refused",
    );
    eq(await page.isVisible("#review"), false, "a refused bind must reveal no document");

    /* Back to the page with no fragment, which is all the visitor has left. */
    await open(page, `${app.origin}/publish/authorize`);
    await page.waitForSelector("#review:not([hidden])");
    eq(await page.textContent("#user-code"), RECORDS.pending.userCode,
      "the operation the refused link never touched must still be the bound one");

    await page.click("#approve");
    await page.waitForSelector("#review", { state: "hidden" });
    await settled(page, "the decision");
    eq(app.stored().state, "approved",
      "and must still be approvable after the refusal");
  });

  } finally {
    /* Always, including when a case threw. A Chromium left running keeps the
       event loop alive and the whole run hangs after its own failure is
       printed - which is the worst possible way to report one. */
    await browser.close();
  }
  return failures;
}

/* ------------------------------------------------------------------ *
 * entry
 * ------------------------------------------------------------------ */

/**
 * One `node:test` case, with its own timeout.
 *
 * A per-test `timeout` overrides the runner's `--test-timeout`, which is what
 * lets this file live under the same runner as every other suite while still
 * being allowed the minutes a cold Playwright and Chromium install costs. It is
 * one case rather than a dozen because the install is the expensive part and
 * splitting it would either repeat it or leak state between cases; the matrix
 * inside collects every failure and reports them together, so a run still names
 * all of them rather than only the first.
 */
test("the approval page: fragment, sign-in, account, decision and failure matrix",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ahu007-browser-"));
    let failures;
    try {
      const browsers = install(root);
      process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
      const entry = join(root, "node_modules", "playwright", "index.js");
      assert.ok(existsSync(entry), `the pinned ${PLAYWRIGHT} install is not present`);
      const loaded = await import(pathToFileURL(entry).href);
      const playwright = loaded.chromium !== undefined ? loaded : loaded.default;
      failures = await runMatrix(playwright.chromium);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    assert.deepEqual(failures, [], `approval page matrix failures:\n  ${failures.join("\n  ")}`);
  });
