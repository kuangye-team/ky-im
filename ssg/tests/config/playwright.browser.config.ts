import { devices } from "@playwright/test";
import { ssgRoot, suiteConfig } from "./shared";

function port(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return value;
}

const webPort = port("PLAYWRIGHT_WEB_PORT", 4310);
const apiPort = port("PLAYWRIGHT_API_PORT", 4311);
const authPort = port("PLAYWRIGHT_AUTH_PORT", 4312);
const baseURL = `http://127.0.0.1:${webPort}`;
const apiURL = `http://127.0.0.1:${apiPort}`;

export default suiteConfig("browser", {
  use: { baseURL },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 980 },
      },
      testIgnore: "**/mobile.spec.ts",
    },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
      testMatch: "**/mobile.spec.ts",
    },
  ],
  webServer: [
    {
      command: "cargo run --manifest-path ../api/Cargo.toml --locked",
      cwd: ssgRoot,
      url: `http://127.0.0.1:${authPort}/api/health`,
      env: {
        BIND_ADDR: `127.0.0.1:${authPort}`,
        API_AUTH: "Bearer browser-test-secret",
        CORS_ORIGINS: baseURL,
        RELAY_ENABLED: "true",
      },
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: "cargo run --manifest-path ../api/Cargo.toml --locked",
      cwd: ssgRoot,
      url: `${apiURL}/api/health`,
      env: {
        BIND_ADDR: `127.0.0.1:${apiPort}`,
        API_AUTH: "",
        RELAY_ENABLED: "false",
      },
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort} --strictPort`,
      cwd: ssgRoot,
      url: baseURL,
      env: {
        API_HOST: apiURL,
        VITE_ROOM: "browser-test",
        // Deployment environment files may point at a remote API; tests use the local proxy.
        VITE_SIGNAL_URL: "",
        VITE_API_AUTH: "",
      },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
