import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
import browser from "./playwright.browser.config";
import { ssgRoot } from "./shared";

const base = Array.isArray(browser.webServer)
  ? browser.webServer
  : browser.webServer
    ? [browser.webServer]
    : [];
const apiPort = Number(process.env.PLAYWRIGHT_API_PORT || 4311);
const disabledPort = Number(process.env.PLAYWRIGHT_RELAY_DISABLED_PORT || apiPort + 2);
export default defineConfig({
  ...browser,
  testDir: resolve(ssgRoot, "tests/relay"),
  outputDir: resolve(ssgRoot, "../temp/artifacts/relay-browser"),
  projects: browser.projects?.filter((project) => project.name === "desktop"),
  webServer: [
    ...base.map((server) =>
      server.env?.BIND_ADDR === `127.0.0.1:${apiPort}`
        ? { ...server, env: { ...server.env, RELAY_ENABLED: "true" } }
        : server,
    ),
    {
      command: "cargo run --manifest-path ../api/Cargo.toml --locked",
      cwd: ssgRoot,
      url: `http://127.0.0.1:${disabledPort}/api/health`,
      env: {
        BIND_ADDR: `127.0.0.1:${disabledPort}`,
        RELAY_ENABLED: "false",
        CORS_ORIGINS: `http://127.0.0.1:${process.env.PLAYWRIGHT_WEB_PORT || 4310}`,
      },
      timeout: 180_000,
    },
  ],
});
