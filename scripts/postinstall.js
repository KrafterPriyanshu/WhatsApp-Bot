/**
 * Native sqlite3 must match host libc (Render build image).
 * Puppeteer does not ship Chrome in puppeteer-core; install browser into project .cache
 * so it is included in the deploy artifact and found at runtime via PUPPETEER_CACHE_DIR.
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

console.log("[postinstall] rebuilding sqlite3 from source...");
execSync("npm rebuild sqlite3", {
  stdio: "inherit",
  cwd: root,
  env: { ...process.env, npm_config_build_from_source: "true" },
});

require("./install-puppeteer-chrome");
