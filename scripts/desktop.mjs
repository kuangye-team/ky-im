import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { desktopEnv, root, updaterConfig } from "./desktop-config.mjs";
import {
  collectArtifacts,
  releaseVersion,
  targetInfo,
  writeManifest,
} from "./desktop-release.mjs";

try {
  const [command = "dev", ...args] = process.argv.slice(2);
  if (!["dev", "build"].includes(command))
    throw new Error("Use desktop.mjs dev or build");
  const env = {
    ...desktopEnv(),
    TAURI_APP_PATH: resolve(root, "app"),
    TAURI_FRONTEND_PATH: root,
  };
  // Cargo runs from app/, while the collector runs from the repository root.
  env.CARGO_TARGET_DIR = resolve(root, env.CARGO_TARGET_DIR || "app/target");
  for (const key of [
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "APPLE_SIGNING_IDENTITY",
  ])
    if (!env[key]) delete env[key];
  const version = releaseVersion(
    env.RELEASE_VERSION ||
      JSON.parse(readFileSync(resolve(root, "package.json"))).version,
  );
  const config = { ...updaterConfig(env, command === "build"), version };
  env.VITE_DESKTOP_UPDATER_ENABLED = String(Boolean(config.plugins.updater.pubkey && config.plugins.updater.endpoints.length));
  const options = [command, "--config", JSON.stringify(config)];
  let target;
  if (command === "build") {
    if (
      args.some((arg) =>
        [
          "--config",
          "-c",
          "--bundles",
          "-b",
          "--debug",
          "--no-bundle",
        ].includes(arg),
      )
    )
      throw new Error(
        "desktop:build produces release installers. Use the Tauri CLI directly for custom bundles.",
      );
    const index = args.indexOf("--target");
    target =
      index >= 0
        ? args[index + 1]
        : process.platform === "darwin"
          ? "universal-apple-darwin"
          : process.platform === "win32"
            ? "x86_64-pc-windows-msvc"
            : "";
    const { bundles } = targetInfo(target);
    if (index < 0) options.push("--target", target);
    options.push("--bundles", bundles);
  }
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
      ...options,
      ...args,
    ],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  if (command === "build") {
    const targetDir = resolve(root, env.CARGO_TARGET_DIR || "app/target");
    const names = collectArtifacts(
      resolve(targetDir, target, "release/bundle"),
      resolve(root, "app/dist"),
      target,
      version,
    );
    writeManifest(resolve(root, "app/dist"), version, env, false, target);
    console.log(
      `Desktop artifacts: ${names.map((name) => `app/dist/${name}`).join(", ")}`,
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
