import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import relay from "./playwright.relay.config";
import { ssgRoot } from "./shared";
export default defineConfig({
  ...relay,
  testDir: "../p2p",
  outputDir: resolve(ssgRoot, "../temp/artifacts/p2p-browser"),
  timeout: 90000,
  webServer: [
    ...(relay.webServer as []),
    ...(process.env.P2P_NATIVE_TURN ? [{
      command: "cargo run --manifest-path ../app/Cargo.toml --example turn-harness --locked",
      cwd: ssgRoot, url: "http://127.0.0.1:4321", timeout: 180000,
    }] : []),
    {
      command: "node tests/p2p-server.mjs",
      cwd: ssgRoot,
      url: "http://127.0.0.1:4320",
      reuseExistingServer: false,
    },
  ],
});
