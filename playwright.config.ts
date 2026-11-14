import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1120, height: 680 };

/**
 * Browser tests for the web UI, run against the Vite dev server with the
 * development gallery and the simulated backend compiled in. They check what
 * jsdom cannot: real layout (alignment, overlap, truncation), real focus,
 * real contrast.
 *
 * The app's web view is WebKit, so that is the engine that counts; Chromium
 * runs the same tests to keep the interface from leaning on one engine's
 * quirks. What only the real window can show (the video layer, the traffic
 * lights, HDR) is checked with scripts/shot.sh, which photographs the app.
 *
 *   pnpm exec playwright install webkit chromium   # once
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
  },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport, deviceScaleFactor: 2 } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport, deviceScaleFactor: 2 } },
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    // Always a fresh server: a running one does not reliably pick up changes
    // to tailwind.config.ts, and a stale theme makes layout tests lie.
    reuseExistingServer: false,
    env: { VITE_LUMEN_DEVTOOLS: "1" },
  },
});
