// Screenshot baselines for archon.aiur.team's static pages, taken before the
// aiur-style migration so a structural change can be shown to move no pixel.
// Never run `--update-snapshots` without `-g <name>`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const FONTS = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fonts");
// Space Grotesk and JetBrains Mono are variable fonts: one file covers every weight the pages use.
const FONT_CSS = [
  ["Bungee", "400", "bungee-latin.woff2"],
  ["Space Grotesk", "300 700", "space-grotesk-latin.woff2"],
  ["JetBrains Mono", "100 800", "jetbrains-mono-latin.woff2"],
]
  .map(([family, weight, file]) =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;` +
    `src:url(https://fonts.gstatic.com/fixture/${file}) format('woff2');}`)
  .join("\n");

const ELEMENTS = [".banner", ".site-signin", ".install-box", ".cta", ".aside"];

test.beforeEach(async ({ page, colorScheme }) => {
  // Google Fonts is answered from the vendored copies; every other external request is refused.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: FONT_CSS });
    if (url.hostname === "fonts.gstatic.com" && url.pathname.startsWith("/fixture/")) {
      return route.fulfill({ contentType: "font/woff2", body: readFileSync(join(FONTS, url.pathname.slice(9))) });
    }
    return route.abort();
  });
  // A signed-out visitor: the static pages ask the hosted session route who is signed in.
  await page.route("**/api/hosted/session", (route) => route.fulfill({ json: { authenticated: false } }));
  await page.addInitScript((theme) => localStorage.setItem("archon.theme", theme), colorScheme);
});

async function open(page, path) {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  // The button is enabled once the session bootstrap has answered.
  const signin = page.locator("#siteSigninBtn");
  if (await signin.count()) {
    await expect(signin).toBeEnabled();
    await expect(signin).toHaveText("Sign in");
  }
}

async function shootElements(page, prefix) {
  for (const selector of ELEMENTS) {
    const el = page.locator(selector).first();
    if ((await el.count()) && (await el.isVisible())) {
      await expect(el).toHaveScreenshot(`${prefix}-${selector.slice(1)}.png`);
    }
  }
}

test("splash", async ({ page }) => {
  await open(page, "/");
  await expect(page.locator(".banner")).toBeVisible();
  await expect(page).toHaveScreenshot("splash.png", { fullPage: true });
  await shootElements(page, "splash");
});

test("splash, banner dismissed", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("archon.banner.aiur.dismissed", "1"));
  await open(page, "/");
  await expect(page.locator(".banner")).toBeHidden();
  await expect(page).toHaveScreenshot("splash-banner-dismissed.png", { fullPage: true });
});

test("splash, copy clicked", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
  await open(page, "/");
  // The page clears the "Copied" tooltip after 1.3s; dropping that one timer keeps it up.
  // (page.clock would also freeze requestAnimationFrame and the flow field behind the shot.)
  await page.evaluate(() => {
    const real = window.setTimeout;
    window.setTimeout = (fn, ms, ...args) => (ms === 1300 ? 0 : real(fn, ms, ...args));
  });
  await page.locator("#copyBtn").click();
  await expect(page.locator("#copyStatus")).toHaveText("Copied");
  await expect(page.locator("#copyStatus")).toHaveCSS("opacity", "1");
  // The tooltip sits above the box, so the shot is the box plus the room above it.
  const box = await page.locator(".install-box").boundingBox();
  const clip = { x: box.x - 8, y: box.y - 40, width: box.width + 16, height: box.height + 48 };
  await expect(page).toHaveScreenshot("splash-copied-install-box.png", { clip });
});

test("404", async ({ page }) => {
  await open(page, "/404.html");
  await expect(page).toHaveScreenshot("404.png", { fullPage: true });
});

test("welcome", async ({ page }) => {
  await open(page, "/welcome/");
  await expect(page).toHaveScreenshot("welcome.png", { fullPage: true });
  await shootElements(page, "welcome");
});

// The net must catch a drift too small to see: #1a4aa6 is 2 units off #1a4aa8,
// the real khala/archon button drift. The .cta baseline has to reject it.
test("self-test: a 2-unit --btn-bg drift fails the .cta baseline", async ({ page }, testInfo) => {
  test.skip(testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed",
    "would overwrite the real .cta baseline with the drifted one");
  expect(existsSync(testInfo.snapshotPath("splash-cta.png")), "the .cta baseline must exist").toBe(true);
  await open(page, "/");
  await page.addStyleTag({ content: ":root, :root[data-theme] { --btn-bg: #1a4aa6 !important; }" });
  const result = await expect(page.locator(".cta")).toHaveScreenshot("splash-cta.png", { timeout: 5000 })
    .then(() => "matched", (error) => String(error.message));
  expect(result).toContain("pixels");
});
