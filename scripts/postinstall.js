/**
 * On Render (Linux), sqlite3 is rebuilt from source so the native addon matches the host libc.
 * Local/dev installs skip this and use sqlite3 prebuilds when available (no Python / MSVC needed).
 * Puppeteer: Chrome is installed into project .cache for deploy/runtime via PUPPETEER_CACHE_DIR.
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const forceSqliteFromSource =
  process.env.RENDER === "true" ||
  process.env.SQLITE_BUILD_FROM_SOURCE === "true";

if (forceSqliteFromSource) {
  console.log(
    "[postinstall] rebuilding sqlite3 from source (RENDER or SQLITE_BUILD_FROM_SOURCE)...",
  );
  execSync("npm rebuild sqlite3", {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, npm_config_build_from_source: "true" },
  });
} else {
  console.log("[postinstall] sqlite3: skipping forced source rebuild (OK for local Windows/macOS/Linux)");
}

require("./install-puppeteer-chrome");
