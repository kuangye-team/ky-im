import { resolve } from "node:path";
import { ssgRoot, suiteConfig } from "./shared";

export default suiteConfig("desktop", {
  testMatch: "updates.spec.ts",
  outputDir: resolve(ssgRoot, "../temp/artifacts/desktop-updates"),
  use: { baseURL: "http://127.0.0.1:4320" },
  webServer: {
    command: "npm run dev -- --mode desktop --host 127.0.0.1 --port 4320 --strictPort",
    cwd: ssgRoot,
    url: "http://127.0.0.1:4320",
    env: { VITE_DESKTOP_UPDATER_ENABLED: "true" },
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
