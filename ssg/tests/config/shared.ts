import { defineConfig, type PlaywrightTestConfig } from "@playwright/test";
import { resolve } from "node:path";

export const ssgRoot = resolve(import.meta.dirname, "../..");

export function suiteConfig(name: string, config: PlaywrightTestConfig) {
  return defineConfig({
    testDir: resolve(ssgRoot, "tests", name),
    outputDir: resolve(ssgRoot, "../temp/test-results", name),
    timeout: 60_000,
    expect: { timeout: 15_000 },
    fullyParallel: false,
    workers: 1,
    reporter: "list",
    use: {
      // Existing behavior tests use Chinese; language switching is tested separately.
      locale: "zh-CN",
      channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
      viewport: { width: 1440, height: 980 },
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      serviceWorkers: "block",
      // Keep real WebRTC, using host IP candidates across isolated browser contexts.
      launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
    },
  }, config);
}
