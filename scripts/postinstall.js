/**
 * Native sqlite3 must match host libc (Render build image).
 * Puppeteer does not ship Chrome in puppeteer-core; install browser into project .cache
 * so it is included in the deploy artifact and found at runtime via PUPPETEER_CACHE_DIR.
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const puppeteerCache = path.join(root, ".cache", "puppeteer");
const envWithCache = { ...process.env, PUPPETEER_CACHE_DIR: puppeteerCache };

console.log("[postinstall] rebuilding sqlite3 from source...");
execSync("npm rebuild sqlite3", {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, npm_config_build_from_source: "true" },
});

const skipBrowser =
  process.env.SKIP_PUPPETEER_DOWNLOAD === "1" || process.env.SKIP_PUPPETEER_DOWNLOAD === "true";

if (skipBrowser) {
  console.log("[postinstall] SKIP_PUPPETEER_DOWNLOAD set — skipping Chrome install.");
  process.exit(0);
}

console.log("[postinstall] installing Chrome for Puppeteer (this may take a minute)...");
execSync("npx puppeteer browsers install chrome", {
  stdio: "inherit",
  cwd: root,
  env: envWithCache,
});
