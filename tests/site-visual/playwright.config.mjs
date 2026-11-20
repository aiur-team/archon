// Screenshot baselines for the static site pages (`templates/build --site`
// output in `_site/`). Run with `npm run test:site-visual` inside the pinned
// Playwright container, so the rasteriser matches the one that made the baselines.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const PORT = 43129;
const desktop = { width: 1280, height: 800 };
const mobile = { width: 390, height: 844 };

export default defineConfig({
  testDir: ".",
  testMatch: "visual.spec.mjs",
  // Outside the repository so a run leaves no untracked files; diffs land here.
  outputDir: process.env.SITE_VISUAL_OUTPUT ?? join(tmpdir(), "archon-site-visual"),
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  // Zero tolerance: a 2-unit colour drift on one element must fail (the self-test proves it).
  expect: { toHaveScreenshot: { threshold: 0, maxDiffPixels: 0 } },
  use: { baseURL: `http://127.0.0.1:${PORT}`, reducedMotion: "reduce" },
  projects: [
    { name: "light-desktop", use: { colorScheme: "light", viewport: desktop } },
    { name: "dark-desktop", use: { colorScheme: "dark", viewport: desktop } },
    { name: "light-mobile", use: { colorScheme: "light", viewport: mobile } },
    { name: "dark-mobile", use: { colorScheme: "dark", viewport: mobile } },
  ],
  webServer: {
    command: `node scripts/serve-static.mjs _site ${PORT}`,
    cwd: "../..",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
  },
});
