import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    // Existing behavior tests use Chinese; language switching is tested separately.
    locale: "zh-CN",
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    baseURL: "http://127.0.0.1:4310",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Isolated browser contexts cannot resolve each other's mDNS candidates in
    // some headless/CI networks. Keep real WebRTC, using host IP candidates.
    launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 980 },
      },
      testIgnore: ["**/mobile.spec.ts", "**/pwa*.spec.ts"],
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
      testMatch: "**/mobile.spec.ts",
    },
    {
      name: "pwa",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 980 },
      },
      testMatch: "**/pwa*.spec.ts",
    },
  ],
  webServer: [
    {
      command: "cargo run --manifest-path ../api/Cargo.toml --locked",
      url: "http://127.0.0.1:4311/api/health",
      env: { BIND_ADDR: "127.0.0.1:4311" },
      timeout: 180_000,
    },
    {
      command: "npm run dev -- --host 127.0.0.1 --port 4310 --strictPort",
      url: "http://127.0.0.1:4310",
      env: {
        API_HOST: "http://127.0.0.1:4311",
        VITE_ROOM: "browser-test",
        // 部署时的 .env.local 可能指向线上 API；测试固定使用本地代理。
        VITE_SIGNAL_URL: "",
      },
      timeout: 60_000,
    },
  ],
});
