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
const INSTALL_DEADLINE_MS = 900_000;
/* The install is minutes of network on a cold runner and the matrix itself is
   seconds; one budget covers both, and it overrides the runner default. */
const TEST_TIMEOUT_MS = 1_200_000;

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

/** Where the provider stand-in listens, on this deployment's own loopback origin. */
const PROVIDER_PATH = "/fixture-provider/authorize";

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
    seen.push({ method: incoming.method, path: url.pathname });

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

  const browser = await chromium.launch();
  try {

  /** One case: a fresh deployment, a fresh isolated browser context. */
  async function withCase(record, run) {
    const app = await startDeployment(record);
    const context = await browser.newContext();
    await refuseTheInternet(context, app.origin);
    const page = await context.newPage();
    try {
      await run({ app, page, context });
    } finally {
      await context.close();
      await app.close();
    }
  }

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
  await withCase(seedRecord(), async ({ app, page }) => {
    /* From a real previous page, so "did the token become a history entry" is a
       question with an answer rather than a comparison against whatever a fresh
       context happens to start with. */
    await page.goto(`${app.origin}/login/`);
    const entriesBefore = await page.evaluate(() => window.history.length);

    await open(page, link(app));

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
