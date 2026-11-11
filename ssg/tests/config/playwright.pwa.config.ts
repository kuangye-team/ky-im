import { devices } from "@playwright/test";
import { resolve } from "node:path";
import { ssgRoot, suiteConfig } from "./shared";

export default suiteConfig("pwa", {
  globalSetup: resolve(ssgRoot, "tests/pwa/setup.ts"),
  use: { serviceWorkers: "allow" },
  projects: [
    {
      name: "pwa",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 980 },
      },
    },
  ],
  // The release-server fixture serves each test's production assets on its own port.
});
