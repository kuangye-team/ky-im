import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// rust-cache persists Cargo artifacts in Actions; sccache adds a local compiler
// cache without making it a prerequisite for development.
export function rustCacheEnv(source = process.env) {
  const env = { ...source };
  if (
    Object.hasOwn(env, "RUSTC_WRAPPER") ||
    Object.hasOwn(env, "CARGO_BUILD_RUSTC_WRAPPER") ||
    env.CARGO_INCREMENTAL === "1" ||
    env.CI === "true"
  ) return env;

  const probe = spawnSync("sccache", ["--version"], {
    env,
    stdio: "ignore",
    timeout: 5000,
  });
  if (probe.status === 0) {
    env.RUSTC_WRAPPER = "sccache";
    env.SCCACHE_DIR ??= fileURLToPath(new URL("../temp/cache/sccache", import.meta.url));
    // Keep fast local edit/rebuild cycles: dependencies are cached, while Cargo
    // still handles incremental workspace crates in development profiles.
    env.SCCACHE_ALLOW_INCREMENTAL ??= "1";
  }
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const child = spawn("cargo", process.argv.slice(2), {
    env: rustCacheEnv(),
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? 128 + constants.signals[signal];
  });
}
