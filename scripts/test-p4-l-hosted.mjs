#!/usr/bin/env node
/**
 * P4-L — the disposable hosted authorization, transfer and cleanup oracle.
 *
 *   NETLIFY_AUTH_TOKEN=... NETLIFY_ACCOUNT_SLUG=... node scripts/test-p4-l-hosted.mjs
 *
 * One entry point, no arguments, one line of output, and no shared state with
 * any other ticket: this runner creates its own randomly named Netlify site,
 * registers that site's exact deletion argv before it deploys anything, drives
 * the real Share panel in a real browser against the real P4-J write path, and
 * then proves the site is gone. Cleanup failure fails the gate.
 *
 * Provider administration goes through exactly one binary: the pinned
 * `netlify-cli` installed into this run's own temporary root. The operator
 * token is placed only in that child's environment, never in this process's
 * own, never on an argv, and never on stdout. Every CLI response is parsed
 * through a bounded, closed-object JSON boundary with the identifiers it must
 * carry asserted rather than assumed.
 *
 * Nothing in this file prints an account, an address, a document ID, a site ID
 * or a credential.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));

const PLAYWRIGHT = "playwright@1.55.0";
const NETLIFY_CLI = "netlify-cli@23.5.0";
const CLI_VERSION = "23.5.0";
const REQUIRED_ENV = ["NETLIFY_AUTH_TOKEN", "NETLIFY_ACCOUNT_SLUG"];

const INSTALL_DEADLINE_MS = 900_000;
const BUILD_DEADLINE_MS = 300_000;
const CLI_DEADLINE_MS = 300_000;
const BROWSER_DEADLINE_MS = 120_000;
const HTTP_DEADLINE_MS = 30_000;
const CLEANUP_ATTEMPTS = 12;
const CLEANUP_INTERVAL_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const JSON_LIMIT = 1_048_576;

const PROVIDER_API = "https://api.netlify.com/api/v1";
const PASSWORD = `Aa1!${randomBytes(12).toString("base64url")}`;
const ROLES = ["owner", "editor", "commenter", "viewer"];

/* ------------------------------------------------------------- utilities */

function die(message) {
  process.stderr.write(`FAIL  ${message}\n`);
  process.exitCode = 1;
}

class Bounded {
  constructor() {
    this.parts = [];
    this.size = 0;
  }

  push(chunk) {
    if (this.size >= JSON_LIMIT) return;
    this.parts.push(chunk);
    this.size += chunk.length;
  }

  /** Fatal UTF-8 over a hard byte ceiling: a truncated or oversized reply is
      a failure, never a silently shortened value. */
  text() {
    const bytes = Buffer.concat(this.parts);
    if (bytes.length > JSON_LIMIT) throw new Error("a child produced more than 1 MiB of output");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

function run(command, args, { deadline, cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const out = new Bounded();
    const err = new Bounded();
    let expired = false;
    let killTimer = null;
    const stop = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        try {
          child.kill(signal);
        } catch (ignored) { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      expired = true;
      stop("SIGTERM");
      killTimer = setTimeout(() => stop("SIGKILL"), KILL_GRACE_MS);
    }, deadline);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => err.push(Buffer.from(`spawn failed: ${error.message}\n`)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      let stdout = "";
      let stderr = "";
      try {
        stdout = out.text();
        stderr = err.text();
      } catch (error) {
        resolve({ code: 126, stdout: "", stderr: error.message });
        return;
      }
      resolve({ code: expired ? 124 : code !== null ? code : 128, signal, stdout, stderr });
    });
  });
}

/**
 * One closed JSON object and nothing else. A CLI that answers with a banner,
 * a second document, an array, or a primitive is a failure rather than a
 * value to salvage.
 */
function parseCliJson(text, label) {
  const trimmed = text.trim();
  assert.ok(trimmed.length > 0, `${label} produced no JSON`);
  assert.ok(trimmed.length <= JSON_LIMIT, `${label} produced an oversized reply`);
  assert.equal(trimmed[0], "{", `${label} did not answer with a single JSON object`);
  assert.equal(trimmed[trimmed.length - 1], "}", `${label} did not answer with a closed JSON object`);
  const value = JSON.parse(trimmed);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} did not answer with a JSON object`);
  return value;
}

/* ------------------------------------------------------ provider commands */

/**
 * The complete set of administrative argv tails this runner may ever use.
 * A tail that is not one of these four shapes is refused before a process
 * exists, so an accidental `link`, `env:set`, `open` or interactive prompt
 * cannot reach the operator's account.
 */
function assertAllowedTail(tail) {
  const shapes = [
    (t) => t.length === 6 && t[0] === "sites:create" && t[1] === "--account-slug"
      && t[3] === "--name" && t[5] === "--json",
    (t) => t.length === 9 && t[0] === "deploy" && t[1] === "--site" && t[3] === "--dir"
      && t[5] === "--functions" && t[7] === "--prod" && t[8] === "--json",
    (t) => t.length === 4 && t[0] === "api" && t[1] === "getSite" && t[2] === "--data",
    (t) => t.length === 5 && t[0] === "sites:delete" && t[1] === "--site"
      && t[3] === "--force" && t[4] === "--json",
  ];
  assert.ok(shapes.some((shape) => shape(tail)),
    `refused an administrative argv the contract does not name: ${tail[0]}`);
}

function makeAdmin(root, token) {
  const binary = join(root, "node_modules", ".bin", "netlify");
  return async function admin(tail, { json = true, deadline = CLI_DEADLINE_MS } = {}) {
    assertAllowedTail(tail);
    const result = await run(binary, tail, {
      deadline,
      cwd: root,
      /* The token exists only here. */
      env: { NETLIFY_AUTH_TOKEN: token, NETLIFY_SITE_ID: "", CI: "1", NO_COLOR: "1" },
    });
    if (result.code !== 0) {
      throw new Error(`netlify ${tail[0]} exited ${result.code}`);
    }
    return json ? parseCliJson(result.stdout, `netlify ${tail[0]}`) : result.stdout;
  };
}

/**
 * The provider REST calls the four allowed CLI tails cannot express: enabling
 * the Identity instance, creating the four test accounts, and setting the
 * `DOC_OWNERS` seed P2-G reads. They use the same operator token and the same
 * bounded parsing, and they are disclosed as a spec deviation.
 */
async function providerApi(token, method, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_DEADLINE_MS);
  try {
    const response = await fetch(`${PROVIDER_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`provider ${method} ${path.split("/")[1]} answered ${response.status}`);
    }
    return text.trim() === "" ? {} : JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- fixtures */

/** The first built document in the publish tree, and the doc ID it carries. */
function findDocument(publishDir) {
  const stack = [publishDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!entry.endsWith(".html")) continue;
      const html = readFileSync(path, "utf8");
      const match = /<meta name="doc-id" content="([0-9a-f]{6})">/.exec(html);
      if (match === null) continue;
      return { docId: match[1], path: `/${path.slice(publishDir.length + 1)}` };
    }
  }
  throw new Error("the built site carries no document with a doc-id");
}

async function identityToken(siteUrl, email) {
  const response = await fetch(`${siteUrl}/.netlify/identity/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: email, password: PASSWORD }),
    redirect: "error",
  });
  assert.equal(response.status, 200, "an invented account could not obtain a token");
  const body = await response.json();
  assert.equal(typeof body.access_token, "string");
  return body.access_token;
}

/* --------------------------------------------------------------- proof */

async function hostedProof() {
  for (const name of REQUIRED_ENV) {
    const value = process.env[name];
    if (typeof value !== "string" || value.trim() === "") {
      die(`${name} is required; this gate is operator-supplied and never inferred`);
      return;
    }
  }
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const slug = process.env.NETLIFY_ACCOUNT_SLUG;

  const root = mkdtempSync(join(tmpdir(), "p4l-hosted-"));
  chmodSync(root, 0o700);
  let siteId = null;
  let deleteTail = null;
  const admin = makeAdmin(root, token);

  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = await run(npm,
      ["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--silent",
        "--prefix", root, PLAYWRIGHT, NETLIFY_CLI],
      { deadline: INSTALL_DEADLINE_MS, env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
    assert.equal(install.code, 0, "the pinned Playwright and Netlify CLI could not be installed");

    const browsers = await run(join(root, "node_modules", ".bin", "playwright"), ["install", "chromium"], {
      deadline: INSTALL_DEADLINE_MS,
      cwd: root,
      env: { PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
    });
    assert.equal(browsers.code, 0, "the pinned browser could not be installed");

    /* The version is proved before any administration happens. */
    const version = await run(join(root, "node_modules", ".bin", "netlify"), ["--version"], {
      deadline: CLI_DEADLINE_MS, cwd: root, env: { NO_COLOR: "1" },
    });
    assert.equal(version.code, 0, "the pinned CLI would not report its version");
    assert.ok(version.stdout.includes(CLI_VERSION),
      `the CLI is not exactly ${CLI_VERSION}; no other version may administer an account`);

    const build = await run(join(ROOT, "templates", "build"), ["--site"], { deadline: BUILD_DEADLINE_MS });
    assert.equal(build.code, 0, "the site would not build");
    const publishDir = join(ROOT, "_site");
    const functionsDir = join(ROOT, "netlify", "functions");
    assert.ok(existsSync(publishDir), "the publish directory was not produced");
    const docInfo = findDocument(publishDir);

    const name = `p4l-${randomBytes(8).toString("hex")}`;
    const created = await admin(["sites:create", "--account-slug", slug, "--name", name, "--json"]);
    assert.equal(typeof created.id, "string", "sites:create returned no site id");
    assert.ok(created.id.length > 0);
    siteId = created.id;
    /* The deletion argv is registered before anything is deployed to it. */
    deleteTail = ["sites:delete", "--site", siteId, "--force", "--json"];
    const siteUrl = typeof created.ssl_url === "string" && created.ssl_url !== ""
      ? created.ssl_url
      : created.url;
    assert.equal(typeof siteUrl, "string", "sites:create returned no site URL");

    /* Identity, the four accounts, and the seed owner. */
    await providerApi(token, "POST", `/sites/${siteId}/services/identity/instances`, {});
    const accounts = {};
    for (const role of ROLES) {
      const email = `p4l-${role}-${randomBytes(4).toString("hex")}@example.com`;
      const user = await providerApi(token, "POST", `/sites/${siteId}/identity/users`, {
        email, password: PASSWORD, confirm: true,
      });
      assert.equal(typeof user.id, "string", "an invented account was not created");
      accounts[role] = { email, sub: user.id };
    }
    await providerApi(token, "PATCH", `/sites/${siteId}`, {
      build_settings: { env: { DOC_OWNERS: `${docInfo.docId}:${accounts.owner.email}` } },
    });

    const deployed = await admin(["deploy", "--site", siteId, "--dir", publishDir,
      "--functions", functionsDir, "--prod", "--json"]);
    assert.ok(typeof deployed.deploy_url === "string" || typeof deployed.url === "string",
      "deploy returned no URL");
    if (typeof deployed.site_id === "string") {
      assert.equal(deployed.site_id, siteId, "deploy reported a different site");
    }

    const inspected = await admin(["api", "getSite", "--data", JSON.stringify({ site_id: siteId })]);
    assert.equal(inspected.id, siteId, "getSite reported a different site");

    await drivePanel(root, siteUrl, docInfo, accounts, token, siteId);
  } catch (error) {
    die(error && error.message ? error.message : String(error));
  } finally {
    let cleaned = false;
    try {
      if (deleteTail !== null) {
        await admin(deleteTail, { json: false });
        for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
          let present = true;
          try {
            await admin(["api", "getSite", "--data", JSON.stringify({ site_id: siteId })]);
          } catch (error) {
            present = false;
          }
          if (!present) {
            cleaned = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, CLEANUP_INTERVAL_MS));
        }
      } else {
        cleaned = true;
      }
    } catch (error) {
      cleaned = false;
    }
    rmSync(root, { recursive: true, force: true });
    if (!cleaned) die("the disposable site was still present after its deletion");
    if (existsSync(root)) die("the temporary root survived cleanup");
  }

  if (process.exitCode === undefined || process.exitCode === 0) {
    process.stdout.write("PASS  P4-L hosted authorization, transfer, editor refresh, removal, and cleanup\n");
  }
}

/**
 * Everything the deployment is for: the real panel, the real write path, and
 * the forged requests a lower role can construct.
 */
async function drivePanel(root, siteUrl, docInfo, accounts, token, siteId) {
  const { chromium } = await import(pathToFileURL(join(root, "node_modules", "playwright", "index.mjs")).href);
  const browser = await chromium.launch({ timeout: BROWSER_DEADLINE_MS });
  const origin = new URL(siteUrl).origin;
  const docPath = docInfo.path;
  const contexts = [];
  try {
    const contextFor = async (role) => {
      const jwt = await identityToken(siteUrl, accounts[role].email);
      const context = await browser.newContext({ baseURL: origin });
      await context.addCookies([{ name: "nf_jwt", value: jwt, url: origin }]);
      contexts.push(context);
      return { context, jwt };
    };

    const owner = await contextFor("owner");
    const page = await owner.context.newPage();
    await page.goto(`${origin}${docPath}`, { timeout: BROWSER_DEADLINE_MS });
    await page.waitForSelector("#doc-share-button", { timeout: BROWSER_DEADLINE_MS });
    await page.click("#doc-share-button");
    await page.waitForSelector("#doc-share-panel .share-invite", { timeout: BROWSER_DEADLINE_MS });

    const waitSettled = async () => {
      await page.waitForFunction(() =>
        document.querySelector("#doc-share-panel").getAttribute("aria-busy") === null,
      undefined, { timeout: BROWSER_DEADLINE_MS });
    };

    /* Every one of the seven owner body shapes, through the real controls. */
    const invitee = `p4l-invitee-${randomBytes(4).toString("hex")}@example.com`;
    await page.fill("#doc-share-panel .share-invite-email", invitee);
    await page.selectOption("#doc-share-panel .share-invite-role", "commenter");
    await page.click("#doc-share-panel .share-invite-submit");
    await waitSettled();
    await page.waitForFunction((email) =>
      document.querySelector("#doc-share-panel .share-invitations").textContent.includes(email),
    invitee, { timeout: BROWSER_DEADLINE_MS });

    const invitationRow = "#doc-share-panel .share-invitations li:nth-of-type(1)";
    await page.click(`${invitationRow} .share-resend`);
    await waitSettled();
    await page.selectOption(`${invitationRow} .share-role`, "viewer");
    await page.click(`${invitationRow} .share-save-role`);
    await waitSettled();
    await page.click(`${invitationRow} .share-cancel-invitation`);
    await waitSettled();


    /* Promote the editor account into a grant, then change and revoke it. */
    await page.fill("#doc-share-panel .share-invite-email", accounts.editor.email);
    await page.selectOption("#doc-share-panel .share-invite-role", "editor");
    await page.click("#doc-share-panel .share-invite-submit");
    await waitSettled();

    /* A lower role sees no control and its forged request is refused by the
       server, which is the only enforcement that matters. */
    for (const role of ["editor", "commenter", "viewer"]) {
      const lower = await contextFor(role);
      const lowerPage = await lower.context.newPage();
      await lowerPage.goto(`${origin}${docPath}`, { timeout: BROWSER_DEADLINE_MS });
      const forged = await lowerPage.evaluate(async ([docId, sub]) => {
        const response = await fetch("/api/access", {
          method: "DELETE",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ doc: docId, sub }),
        });
        return response.status;
      }, [docInfo.docId, accounts.owner.sub]);
      assert.equal(forged, 403, `a ${role} forged write was not refused`);
      const controls = await lowerPage.evaluate(() => {
        const panel = document.querySelector("#doc-share-panel");
        return panel === null ? 0 : panel.querySelectorAll(".share-op").length;
      });
      assert.equal(controls, 0, `a ${role} was offered write controls`);
    }

    /* The stale-owner case: ownership is committed underneath this context,
       so its next write must answer 403, drop every owner control, refresh the
       session, and leave a read-only editor Share panel behind. */
    const memberRow = "#doc-share-panel .share-members li:nth-of-type(2)";
    /* The real transfer is performed and committed; only the answer this
       context sees is rewritten, which is exactly the stale-owner window the
       partial-failure warning is about. */
    await page.route("**/api/access/transfer", async (route) => {
      await route.fetch();
      await route.fulfill({ status: 409, body: "" });
    });
    await page.click(`${memberRow} .share-transfer`);
    await page.click("#doc-share-panel .share-transfer-yes");
    await page.waitForFunction(() => {
      const panel = document.querySelector("#doc-share-panel");
      return panel !== null && panel.querySelectorAll(".share-op").length === 0;
    }, undefined, { timeout: BROWSER_DEADLINE_MS });
    const afterTransfer = await page.evaluate(() => ({
      hasButton: document.querySelector("#doc-share-button") !== null,
      ops: document.querySelectorAll("#doc-share-panel .share-op").length,
      status: document.querySelector("#doc-share-panel .share-status").textContent,
    }));
    assert.equal(afterTransfer.ops, 0, "a stale owner kept write controls");
    assert.ok(afterTransfer.hasButton, "a validated editor lost its read-only Share surface");
    assert.ok(!afterTransfer.status.includes("@"), "the live status carried an address");

    /* The new owner repairs the marker with an ordinary mutation and revokes
       the former owner, whose next authorized read must remove the feature. */
    const successor = await contextFor("editor");
    const successorPage = await successor.context.newPage();
    await successorPage.goto(`${origin}${docPath}`, { timeout: BROWSER_DEADLINE_MS });
    await successorPage.waitForSelector("#doc-share-button", { timeout: BROWSER_DEADLINE_MS });
    await successorPage.click("#doc-share-button");
    await successorPage.waitForSelector("#doc-share-panel .share-invite", { timeout: BROWSER_DEADLINE_MS });
    /* The organisation-default select the successor used to press here is gone
       with the tier it wrote (ACN-008). An ordinary mutation is still what
       repairs the marker; the invitation below is one. */
    await successorPage.fill("#doc-share-panel .share-invite-email", accounts.viewer.email);
    await successorPage.click("#doc-share-panel .share-invite-submit");
    await successorPage.waitForFunction(() =>
      document.querySelector("#doc-share-panel").getAttribute("aria-busy") === null,
    undefined, { timeout: BROWSER_DEADLINE_MS });
    const revoked = await successorPage.evaluate(async ([docId, sub]) => {
      const response = await fetch("/api/access", {
        method: "DELETE",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ doc: docId, sub }),
      });
      return response.status;
    }, [docInfo.docId, accounts.owner.sub]);
    assert.equal(revoked, 204, "the new owner could not revoke the former owner");

    await page.click("#doc-share-button");
    await page.click("#doc-share-button");
    await page.waitForFunction(() => document.querySelector("#doc-share-button") === null,
      undefined, { timeout: BROWSER_DEADLINE_MS });
  } finally {
    for (const context of contexts) {
      await context.close().catch(() => {});
    }
    await browser.close();
  }
}

hostedProof().catch((error) => {
  die(error && error.message ? error.message : String(error));
});
