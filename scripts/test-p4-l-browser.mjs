#!/usr/bin/env node
/**
 * P4-L — the rendered access-panel accessibility and privacy oracle.
 *
 *   node scripts/test-p4-l-browser.mjs
 *
 * One entry point, no arguments, one line of output. The contract runner
 * proves the state machine against a stubbed transport; this one proves the
 * things only a real engine can answer -- laid-out geometry at three widths,
 * the tab order the DOM actually produces, focus after each transition, the
 * forced-colors, dark, reduced-motion and print environments, and the fact
 * that no address or write control survives printing.
 *
 * It supervises itself: the pinned Playwright and its browser are installed
 * into one mode-0700 temporary root outside the worktree, the matrix runs as a
 * direct child in its own process group with a deadline and TERM escalated to
 * KILL, the loopback server and browser belong to that child, and the root is
 * removed and proven gone before the PASS line is printed.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const SHARE_JS = join(ROOT, "templates", "base", "share.js");
const SHARE_CSS = join(ROOT, "templates", "base", "share.css");

const PLAYWRIGHT = "playwright@1.55.0";
const WORKER_DEADLINE_MS = 240_000;
const INSTALL_DEADLINE_MS = 900_000;
const KILL_GRACE_MS = 5_000;
const OUTPUT_LIMIT = 65_536;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

const DOC = "4b7d2a";
const OWNER_EMAIL = "owner@example.com";
const EDITOR_EMAIL = "ada@example.com";
const VIEWER_EMAIL = "blake@example.com";
const INVITE_EMAIL = "cleo@example.com";
const ADDRESSES = [OWNER_EMAIL, EDITOR_EMAIL, VIEWER_EMAIL, INVITE_EMAIL];

const OWNER_SESSION = {
  sub: "owner-1", email: OWNER_EMAIL, name: "",
  canComment: true, canEdit: true, doc: DOC, role: "owner", shared: true,
  canSuggest: true, canAccept: true, canShare: true, canSeeMembers: true,
};
const EDITOR_SESSION = { ...OWNER_SESSION, sub: "member-1", email: EDITOR_EMAIL, role: "editor", canShare: false };
const ROSTER = {
  doc: DOC,
  allowedDomains: ["listed.example"],
  members: [
    { sub: "owner-1", email: OWNER_EMAIL, name: "", role: "owner" },
    { sub: "member-1", email: EDITOR_EMAIL, name: "Ada Sample", role: "editor" },
    { sub: "member-2", email: VIEWER_EMAIL, name: "", role: "viewer" },
  ],
  invitations: [{ email: INVITE_EMAIL, role: "commenter", expiresAt: "2030-01-05T00:00:00.000Z" }],
};

/* ------------------------------------------------------------ supervisor */

class Capture {
  constructor() {
    this.parts = [];
    this.size = 0;
  }

  push(chunk) {
    if (this.size >= OUTPUT_LIMIT) return;
    const text = chunk.toString("utf8");
    this.parts.push(text.slice(0, OUTPUT_LIMIT - this.size));
    this.size += text.length;
  }

  toString() {
    return this.parts.join("");
  }
}

function runChild(command, args, { deadline, cwd = ROOT, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const out = new Capture();
    const err = new Capture();
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

    const forwarded = [];
    for (const name of Object.keys(SIGNALS)) {
      const handler = () => stop(name);
      forwarded.push([name, handler]);
      process.on(name, handler);
    }

    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => err.push(Buffer.from(`spawn failed: ${error.message}\n`)));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      for (const [name, handler] of forwarded) process.removeListener(name, handler);
      let orphaned = false;
      try {
        process.kill(-child.pid, 0);
        orphaned = true;
      } catch (error) {
        orphaned = false;
      }
      resolve({
        code: expired ? 124 : code !== null ? code : 128 + (SIGNALS[signal] || 0),
        signal,
        stdout: out.toString(),
        stderr: err.toString(),
        orphaned,
      });
    });
  });
}

function fail(label, result) {
  process.stderr.write(`FAIL  ${label}\n`);
  if (result !== undefined) {
    process.stderr.write(`      exit ${result.code}${result.signal ? ` (${result.signal})` : ""}\n`);
    if (result.stdout !== "") process.stderr.write(`      stdout: ${result.stdout.slice(0, 4000)}\n`);
    if (result.stderr !== "") process.stderr.write(`      stderr: ${result.stderr.slice(0, 4000)}\n`);
  }
  process.exit(1);
}

async function supervise() {
  const root = mkdtempSync(join(tmpdir(), "p4l-render-"));
  chmodSync(root, 0o700);
  try {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const install = await runChild(npm,
      ["install", "--ignore-scripts", "--no-save", "--no-audit", "--no-fund", "--silent", "--prefix", root, PLAYWRIGHT], {
        deadline: INSTALL_DEADLINE_MS,
        env: { npm_config_yes: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
      });
    if (install.code !== 0) fail(`P4-L could not install ${PLAYWRIGHT}`, install);

    const browsers = await runChild(join(root, "node_modules", ".bin", "playwright"), ["install", "chromium"], {
      deadline: INSTALL_DEADLINE_MS,
      cwd: root,
      env: { PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers") },
    });
    if (browsers.code !== 0) fail("P4-L could not install the pinned browser", browsers);

    const result = await runChild(process.execPath, [SELF, "--render"], {
      deadline: WORKER_DEADLINE_MS,
      cwd: root,
      env: {
        TMPDIR: root,
        P4L_INSTALL: root,
        PLAYWRIGHT_BROWSERS_PATH: join(root, "browsers"),
      },
    });
    if (result.code !== 0) fail("P4-L rendered matrix", result);
    if (result.orphaned) fail("P4-L rendered matrix left its process group behind", result);
    if (result.stdout !== "") fail("P4-L rendered matrix wrote to stdout", result);
    if (result.stderr !== "") fail("P4-L rendered matrix wrote to stderr", result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  if (existsSync(root)) fail(`P4-L left fixture state behind: ${root}`);
  process.stdout.write("PASS  P4-L rendered owner/editor access panel\n");
}

/* ---------------------------------------------------------------- worker */

const INIT_SCRIPT = `(() => {
  const state = { queue: [], holds: [], calls: 0 };
  window.__p4l = state;
  const encoder = new TextEncoder();
  function makeResponse(spec) {
    const headers = new Map();
    if (typeof spec.contentType === "string") headers.set("content-type", spec.contentType);
    const response = {
      status: spec.status,
      redirected: false,
      headers: { get: (name) => {
        const value = headers.get(String(name).toLowerCase());
        return value === undefined ? null : value;
      } },
    };
    if (spec.json === undefined) {
      response.body = null;
      return response;
    }
    const bytes = encoder.encode(JSON.stringify(spec.json));
    response.body = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    response.json = () => Promise.resolve(spec.json);
    return response;
  }
  window.fetch = (input, init) => {
    const options = init || {};
    state.calls += 1;
    const spec = state.queue.shift();
    if (spec === undefined) return Promise.reject(new TypeError("unqueued request"));
    if (spec.kind === "hold") {
      return new Promise((resolve, reject) => {
        const hold = { resolve: (later) => resolve(makeResponse(later)) };
        state.holds.push(hold);
        if (options.signal) options.signal.addEventListener("abort", () => {
          const at = state.holds.indexOf(hold);
          if (at !== -1) state.holds.splice(at, 1);
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return Promise.resolve(makeResponse(spec));
  };
  state.release = (spec) => {
    const hold = state.holds.shift();
    if (hold === undefined) throw new Error("no held request");
    hold.resolve(spec);
  };
})()`;

const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="doc-id" content="${DOC}">
<title>Access</title>
<link rel="stylesheet" href="/share.css">
<style>
  :root { color-scheme: light dark; --ink-2: #49525f; --surface: #fff; --surface-2: #eef1f4;
    --border: #e2e6eb; --border-strong: #cbd2da; --accent: #c0122a; }
  @media (prefers-color-scheme: dark) {
    :root { --ink-2: #d7dce3; --surface: #14181e; --surface-2: #1e242c;
      --border: #2a313a; --border-strong: #3a424c; --accent: #ff6b81; }
  }
  html, body { margin: 0; background: var(--surface); color: var(--ink-2);
    font-family: system-ui, sans-serif; }
  .head-top { display: flex; justify-content: flex-end; gap: .5rem; padding: .5rem; }
  main { padding: 1rem; }
</style>
</head><body>
<header><div class="head-top"><span>Doc</span></div></header>
<main><p>An invented fixture document.</p></main>
</body></html>`;

function serveFixture(css) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const path = request.url.split("?")[0];
      if (path === "/share.css") {
        response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
        response.end(css);
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(PAGE_HTML);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function mount(browser, origin, source, options, detail, queue) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.addInitScript(INIT_SCRIPT);
  await page.goto(`${origin}/`);
  await page.addScriptTag({ content: source });
  await page.evaluate((list) => { window.__p4l.queue.push(...list); }, queue);
  await page.evaluate((value) => {
    document.dispatchEvent(new CustomEvent("session", { detail: value }));
  }, detail);
  return { context, page };
}

function openPanel(page) {
  return page.click("#doc-share-button", { timeout: 10_000 });
}

function waitControls(page) {
  return page.waitForFunction(() => document.querySelector("#doc-share-panel .share-invite") !== null,
    undefined, { timeout: 10_000 });
}

async function renderMatrix() {
  const source = readFileSync(SHARE_JS, "utf8");
  const css = readFileSync(SHARE_CSS, "utf8");
  const { server, origin } = await serveFixture(css);
  const install = process.env.P4L_INSTALL;
  const { chromium } = await import(pathToFileURL(join(install, "node_modules", "playwright", "index.mjs")).href);
  const browser = await chromium.launch();
  try {
    /* Geometry: three real widths, laid out, with no horizontal overflow and
       every control still inside the panel box. */
    for (const width of [320, 390, 1280]) {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width, height: 800 } }, OWNER_SESSION, [{ status: 200, contentType: "application/json", json: ROSTER }]);
      await openPanel(page);
      await waitControls(page);
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector("#doc-share-panel");
        const box = panel.getBoundingClientRect();
        const overflowing = Array.from(panel.querySelectorAll(".share-op"))
          .filter((node) => {
            const rect = node.getBoundingClientRect();
            return rect.width === 0 || rect.left < box.left - 1 || rect.right > box.right + 1;
          }).length;
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          left: box.left,
          right: box.right,
          clientWidth: document.documentElement.clientWidth,
          overflowing,
          controls: panel.querySelectorAll(".share-op").length,
          coversToggle: (() => {
            const toggle = document.querySelector("#doc-share-button").getBoundingClientRect();
            return !(box.bottom <= toggle.top || box.top >= toggle.bottom
              || box.right <= toggle.left || box.left >= toggle.right);
          })(),
        };
      });
      assert.equal(geometry.controls, 18, `expected every owner control at ${width}px`);
      /* ACN-009 added a third section, and a panel tall enough to reach its own
         toggle would cover the one control that closes it. */
      assert.equal(geometry.coversToggle, false, `the panel covers its toggle at ${width}px`);
      assert.ok(geometry.documentOverflow <= 0, `the document scrolls sideways at ${width}px`);
      assert.ok(geometry.panelOverflow <= 0, `the panel scrolls sideways at ${width}px`);
      assert.ok(geometry.left >= -1 && geometry.right <= geometry.clientWidth + 1,
        `the panel escapes the viewport at ${width}px`);
      assert.equal(geometry.overflowing, 0, `a control escapes the panel at ${width}px`);
      await context.close();
    }

    /* Keyboard order is DOM order, and every control is reachable by Tab. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 } }, OWNER_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }]);
      await openPanel(page);
      await waitControls(page);
      /* A disabled control is deliberately unreachable, so the order Tab must
         produce is DOM order over the enabled controls only. */
      const expected = await page.evaluate(() => {
        const order = Array.from(document.querySelectorAll(
          "#doc-share-panel button, #doc-share-panel input, #doc-share-panel select"));
        return { total: order.length, enabled: order.map((n, i) => (n.disabled ? -1 : i)).filter((i) => i !== -1) };
      });
      assert.equal(expected.total, 19,
        "the owner panel has one close button and eighteen controls");
      const seen = [];
      for (let step = 0; step < expected.total + 2; step += 1) {
        await page.keyboard.press("Tab");
        const index = await page.evaluate(() => {
          const order = Array.from(document.querySelectorAll(
            "#doc-share-panel button, #doc-share-panel input, #doc-share-panel select"));
          return order.indexOf(document.activeElement);
        });
        if (index === -1) break;
        seen.push(index);
      }
      assert.deepEqual(seen, expected.enabled,
        "tab order must follow DOM order over every enabled control and skip the disabled ones");

      /* Focus is visible on each control rather than merely present. */
      const outline = await page.evaluate(() => {
        const node = document.querySelector("#doc-share-panel .share-invite-email");
        node.focus();
        const style = getComputedStyle(node);
        return { width: style.outlineWidth, style: style.outlineStyle };
      });
      assert.notEqual(outline.style, "none", "a focused control must show an outline");
      await context.close();
    }

    /* Both close paths stay operable while a write is held, and the focus
       transitions around the confirmation are deterministic. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 } }, OWNER_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }, { kind: "hold" }]);
      await openPanel(page);
      await waitControls(page);
      assert.equal(await page.evaluate(() => document.activeElement.id), "doc-share-title");

      await page.click("#doc-share-panel .share-members li:nth-of-type(2) .share-transfer");
      assert.equal(await page.evaluate(() =>
        document.activeElement.className.includes("share-transfer-yes")), true);
      await page.click("#doc-share-panel .share-transfer-no");
      assert.equal(await page.evaluate(() =>
        document.activeElement.className.includes("share-transfer") &&
        !document.activeElement.className.includes("share-transfer-no")), true);

      await page.click("#doc-share-panel .share-members li:nth-of-type(2) .share-revoke");
      await page.waitForFunction(() => window.__p4l.holds.length > 0, undefined, { timeout: 10_000 });
      const held = await page.evaluate(() => {
        const panel = document.querySelector("#doc-share-panel");
        return {
          busy: panel.getAttribute("aria-busy"),
          status: panel.querySelector(".share-status").textContent,
          close: panel.querySelector(".share-close").disabled,
          toggle: document.querySelector("#doc-share-button").disabled,
          enabledOps: Array.from(panel.querySelectorAll(".share-op")).filter((n) => !n.disabled).length,
        };
      });
      assert.deepEqual(held, {
        busy: "true", status: "Updating access…", close: false, toggle: false, enabledOps: 0,
      });
      await page.click("#doc-share-panel .share-close");
      await page.waitForFunction(() => document.querySelector("#doc-share-panel").hidden === true,
        undefined, { timeout: 10_000 });
      assert.equal(await page.evaluate(() => document.activeElement.id), "doc-share-button");
      await context.close();
    }

    /* The masthead toggle is the second enabled close path during a write. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 } }, OWNER_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }, { kind: "hold" }]);
      await openPanel(page);
      await waitControls(page);
      await page.click("#doc-share-panel .share-members li:nth-of-type(2) .share-revoke");
      await page.waitForFunction(() => window.__p4l.holds.length > 0, undefined, { timeout: 10_000 });
      await page.click("#doc-share-button");
      await page.waitForFunction(() => document.querySelector("#doc-share-panel").hidden === true,
        undefined, { timeout: 10_000 });
      assert.equal(await page.evaluate(() => document.querySelector("#doc-share-panel").getAttribute("aria-busy")), null);
      await context.close();
    }

    /* The roster read phase is held: the panel says so and shows no roster. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 } }, OWNER_SESSION, [{ kind: "hold" }]);
      await openPanel(page);
      await page.waitForFunction(() => window.__p4l.holds.length > 0, undefined, { timeout: 10_000 });
      const loading = await page.evaluate(() => ({
        status: document.querySelector("#doc-share-panel .share-status").textContent,
        rows: document.querySelectorAll("#doc-share-panel .share-members li").length,
        ops: document.querySelectorAll("#doc-share-panel .share-op").length,
      }));
      assert.deepEqual(loading, { status: "Loading access…", rows: 0, ops: 0 });
      await page.evaluate((roster) => window.__p4l.release({ status: 200, contentType: "application/json", json: roster }), ROSTER);
      await waitControls(page);
      await context.close();
    }

    /* Every environment the stylesheet claims to support. */
    for (const [label, options] of [
      ["light", { colorScheme: "light" }],
      ["dark", { colorScheme: "dark" }],
      ["forced-colors", { forcedColors: "active" }],
      ["reduced-motion", { reducedMotion: "reduce" }],
    ]) {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 }, ...options }, OWNER_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }]);
      await openPanel(page);
      await waitControls(page);
      const style = await page.evaluate(() => {
        const panel = document.querySelector("#doc-share-panel");
        const control = panel.querySelector(".share-invite-email");
        const button = panel.querySelector(".share-revoke");
        const computed = getComputedStyle(control);
        const buttonStyle = getComputedStyle(button);
        const transparent = (value) => value === "rgba(0, 0, 0, 0)" || value === "transparent";
        return {
          colorSet: !transparent(computed.color),
          backgroundSet: !transparent(getComputedStyle(panel).backgroundColor),
          borderWidth: parseFloat(computed.borderTopWidth),
          transition: buttonStyle.transitionDuration,
          animation: buttonStyle.animationName,
          disabledBorderStyle: (() => {
            button.disabled = true;
            return getComputedStyle(button).borderTopStyle;
          })(),
        };
      });
      assert.equal(style.colorSet, true, `${label}: a control must inherit a readable foreground`);
      assert.equal(style.backgroundSet, true, `${label}: the panel must have an opaque background`);
      assert.ok(style.borderWidth >= 1, `${label}: a control must keep a visible border`);
      assert.equal(style.disabledBorderStyle, "dashed",
        `${label}: disabled must be distinguishable without colour`);
      if (label === "reduced-motion") {
        assert.equal(style.transition, "0s", "reduced motion must remove transitions");
        assert.equal(style.animation, "none", "reduced motion must remove animations");
      }
      await context.close();
    }

    /* Print hides the whole Share surface, so no address and no write control
       can reach paper. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 1280, height: 900 } }, OWNER_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }]);
      await openPanel(page);
      await waitControls(page);
      await page.emulateMedia({ media: "print" });
      const printed = await page.evaluate(() => {
        const panel = document.querySelector("#doc-share-panel");
        const button = document.querySelector("#doc-share-button");
        const visible = (node) => {
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        };
        const walk = (node) => {
          if (!visible(node)) return "";
          let text = "";
          for (const child of node.childNodes) {
            if (child.nodeType === 3) text += child.data;
            else if (child.nodeType === 1) text += walk(child);
          }
          return text;
        };
        return {
          panel: visible(panel),
          button: visible(button),
          text: walk(document.body),
        };
      });
      assert.equal(printed.panel, false, "the panel must not print");
      assert.equal(printed.button, false, "the Share button must not print");
      for (const address of ADDRESSES) {
        assert.equal(printed.text.includes(address), false, `${address} reached the printed page`);
      }
      assert.equal(printed.text.includes("Transfer ownership"), false, "a write control reached the printed page");
      await page.emulateMedia({ media: "screen" });
      await context.close();
    }

    /* A validated editor gets exactly the read-only roster, rendered. */
    {
      const { context, page } = await mount(browser, origin, source,
        { viewport: { width: 320, height: 800 } }, EDITOR_SESSION,
        [{ status: 200, contentType: "application/json", json: ROSTER }]);
      await openPanel(page);
      await page.waitForFunction(() => document.querySelectorAll("#doc-share-panel .share-members li").length === 3,
        undefined, { timeout: 10_000 });
      const state = await page.evaluate(() => ({
        ops: document.querySelectorAll("#doc-share-panel .share-op").length,
        forms: document.querySelectorAll("#doc-share-panel form").length,
        selects: document.querySelectorAll("#doc-share-panel select").length,
        defaultText: document.querySelector("#doc-share-panel .share-default").textContent,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.deepEqual(state, {
        ops: 0, forms: 0, selects: 0, defaultText: "Anyone with a verified address at listed.example can read this document.", overflow: 0,
      });
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
}

function worker(run) {
  run().then(() => process.exit(0), (error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}

const MODE = process.argv[2];
if (MODE === "--render") worker(renderMatrix);
else if (MODE === undefined) worker(supervise);
else fail(`P4-L takes no argument, not ${JSON.stringify(MODE)}`);
