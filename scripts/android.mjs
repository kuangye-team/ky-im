import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { root } from "./desktop-config.mjs";
import { androidEnv, withAndroidSigning } from "./android-config.mjs";

const [command = "build", ...args] = process.argv.slice(2);
if (!["build", "dev"].includes(command)) throw new Error("Expected android build or dev");
const debug = command === "dev" || args.includes("--debug") || args.includes("-d");
const configFile = resolve(root, ".env.json");
const settings = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
let env;
try {
  env = androidEnv(settings, process.env, { release: !debug });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const version = (env.RELEASE_VERSION?.trim() || JSON.parse(readFileSync(resolve(root, "package.json"))).version).replace(/^v/, "");
const versionParts = /^(\d+)\.(\d{1,3})\.(\d{1,3})$/.exec(version);
if (!versionParts) throw new Error("Expected numeric major.minor.patch for Android");
const [, major, minor, patch] = versionParts.map(Number);
const versionCode = major * 1_000_000 + minor * 1000 + patch;
if (versionCode < 1 || versionCode > 2100000000) throw new Error("Android versionCode out of range");
Object.assign(env, {
  TAURI_APP_PATH: resolve(root, "app"), TAURI_FRONTEND_PATH: root, RELEASE_VERSION: version,
  CARGO_TARGET_DIR: resolve(root, env.CARGO_TARGET_DIR || "temp/cache/cargo"),
  GRADLE_USER_HOME: env.GRADLE_USER_HOME || resolve(root, "temp/cache/gradle"),
});
const config = { version, bundle: { android: { versionCode } } };
const cli = resolve(root, "node_modules/@tauri-apps/cli/tauri.js");
try {
  process.exitCode = await withAndroidSigning(env, !debug, async buildEnv => {
    const child = spawn(process.execPath, [cli, "android", command, "--config", JSON.stringify(config),
      ...(command === "build" ? ["--apk", "--target", "aarch64", "armv7"] : []), ...args],
    { env: buildEnv, cwd: root, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      const [status] = await once(child, "exit");
      return status ?? 1;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  });
  if (command === "build" && process.exitCode === 0) console.log(`APK 输出目录：${resolve(root, "app/android-dist")}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
