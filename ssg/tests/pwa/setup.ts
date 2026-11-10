import { execSync } from "node:child_process";
import { ssgRoot } from "../config/shared";

export default function setup() {
  // Build once per run; never test stale assets or connect to a deployment's API.
  execSync("npm run build", {
    cwd: ssgRoot,
    env: { ...process.env, VITE_ROOM: "browser-test", VITE_SIGNAL_URL: "" },
    stdio: "inherit",
  });
}
