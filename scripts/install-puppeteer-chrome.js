/**
 * Download Puppeteer-managed Chrome into project .cache/puppeteer (same path as server.js / postinstall).
 * Run: npm run install-chrome
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const puppeteerCache = path.join(root, ".cache", "puppeteer");

const skipBrowser =
  process.env.SKIP_PUPPETEER_DOWNLOAD === "1" || process.env.SKIP_PUPPETEER_DOWNLOAD === "true";

if (skipBrowser) {
  console.log("[install-chrome] SKIP_PUPPETEER_DOWNLOAD set — skipping Chrome install.");
  process.exit(0);
}

console.log("[install-chrome] Installing Chrome for Puppeteer (may take a minute)...");
execSync("npx puppeteer browsers install chrome", {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, PUPPETEER_CACHE_DIR: puppeteerCache },
});
