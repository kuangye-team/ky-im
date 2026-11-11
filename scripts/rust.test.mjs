import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rustCacheEnv } from "./rust.mjs";

const artifacts = fileURLToPath(new URL("../temp/artifacts/rust-cache/", import.meta.url));
mkdirSync(artifacts, { recursive: true });

function fixture(t, commands = []) {
  const directory = mkdtempSync(join(artifacts, "test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const command of commands) {
    const executable = join(directory, command + (process.platform === "win32" ? ".exe" : ""));
    if (process.platform === "win32") copyFileSync(process.execPath, executable);
    else symlinkSync(process.execPath, executable);
  }
  return directory;
}

test("building without sccache preserves the normal Cargo environment", (t) => {
  const env = { PATH: fixture(t), CARGO_TARGET_DIR: "custom-target" };
  assert.deepEqual(rustCacheEnv(env), env);
});

test("an available sccache enables caching without changing the caller's environment", (t) => {
  const env = { PATH: fixture(t, ["sccache"]), SCCACHE_DIR: "custom-cache" };
  const result = rustCacheEnv(env);
  assert.equal(result.RUSTC_WRAPPER, "sccache");
  assert.equal(result.CARGO_INCREMENTAL, undefined);
  assert.equal(result.SCCACHE_ALLOW_INCREMENTAL, "1");
  assert.equal(result.SCCACHE_DIR, "custom-cache");
  assert.equal(env.RUSTC_WRAPPER, undefined);
});

test("explicit wrappers, opt-out, incremental compilation and CI remain in control", (t) => {
  const PATH = fixture(t, ["sccache"]);
  for (const settings of [
    { RUSTC_WRAPPER: "custom-wrapper" },
    { RUSTC_WRAPPER: "" },
    { CARGO_BUILD_RUSTC_WRAPPER: "custom-wrapper" },
    { CARGO_INCREMENTAL: "1" },
    { CI: "true" },
  ]) {
    const env = { PATH, ...settings };
    assert.deepEqual(rustCacheEnv(env), env);
  }
});

test("the Cargo launcher preserves arguments, working directory and failure status", (t) => {
  // Node stands in for Cargo so this checks process behavior without compiling.
  const directory = fixture(t, ["cargo", "sccache"]);
  const script = fileURLToPath(new URL("./rust.mjs", import.meta.url));
  const env = { ...process.env, PATH: directory, CI: "false" };
  for (const key of ["RUSTC_WRAPPER", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_INCREMENTAL", "SCCACHE_ALLOW_INCREMENTAL"])
    delete env[key];
  const result = spawnSync(process.execPath, [script, "-e", `
    console.log(JSON.stringify({
      args: process.argv.slice(1),
      cwd: process.cwd(),
      wrapper: process.env.RUSTC_WRAPPER,
      allowIncremental: process.env.SCCACHE_ALLOW_INCREMENTAL,
    }));
    process.exitCode = 23;
  `, "argument with spaces"], { cwd: directory, env, encoding: "utf8" });
  assert.equal(result.status, 23, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["argument with spaces"],
    cwd: directory,
    wrapper: "sccache",
    allowIncremental: "1",
  });
});
