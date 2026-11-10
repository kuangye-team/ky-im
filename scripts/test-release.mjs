// Exercise the shipped launcher, including x64 via Rosetta and paths with spaces.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(process.argv[2] || fileURLToPath(new URL("../release", import.meta.url)));
const platform = process.platform;
const testArch = process.env.RELEASE_TEST_ARCH || process.arch;
const arch = { x64: "amd64", arm64: "arm64" }[testArch];
const useRosetta = platform === "darwin" && process.arch === "arm64" && testArch === "x64";
assert(testArch === process.arch || useRosetta, `Cannot test ${testArch} on ${platform}/${process.arch}`);
if (useRosetta) {
  const probe = spawnSync("/usr/bin/arch", ["-x86_64", "/bin/sh", "-c", "uname -m"], { encoding: "utf8", timeout: 5000 });
  assert(probe.status === 0 && probe.stdout.trim() === "x86_64", "Install Rosetta on the Apple Silicon runner before testing the x64 release");
}
const launcher = { darwin: "start_mac.sh", linux: "start_linux.sh", win32: "start_win.bat" }[platform];
assert(arch && launcher, "Unsupported test host");
const binary = platform === "win32" ? "server_windows_amd64.exe" : `server_${platform}_${arch}`;
const temporary = await mkdtemp(join(tmpdir(), "ky-im-smoke-"));
const directory = join(temporary, "release with spaces");
try {
  await mkdir(join(directory, "bin"), { recursive: true });
  for (const name of [launcher, ".env.example", `bin/${binary}`]) {
    await copyFile(join(source, name), join(directory, name));
  }
  await cp(join(source, "dist"), join(directory, "dist"), { recursive: true });
  const example = (await readFile(join(directory, ".env.example"), "utf8"))
    .replace(/^BIND_ADDR=.*$/m, "BIND_ADDR=127.0.0.1:0");
  await writeFile(join(directory, ".env.example"), example);

  for (const firstRun of [true, false]) {
    // A second launch must preserve custom settings, CRLF, spaces and empty values.
    const expectedEnv = firstRun ? example : example
      .replace(/^MAX_ROOMS=.*$/m, "MAX_ROOMS=2")
      .replace(/^STATIC_DIR=.*$/m, "STATIC_DIR=./assets with spaces")
      .replace(/\r?\n/g, "\r\n");
    if (!firstRun) {
      await cp(join(directory, "dist"), join(directory, "assets with spaces"), { recursive: true });
      await rm(join(directory, "dist"), { recursive: true });
      await writeFile(join(directory, ".env"), expectedEnv);
    }
    const script = join(directory, launcher);
    const child = platform === "win32"
      ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", "call", script], { cwd: temporary })
      : useRosetta
        ? spawn("/usr/bin/arch", ["-x86_64", "/bin/sh", script], { cwd: temporary })
        : spawn("sh", [script], { cwd: temporary });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    try {
      const deadline = Date.now() + 20_000;
      let url;
      while (!(url = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1])) {
        if (spawnError) throw spawnError;
        assert.equal(child.exitCode, null, `Launcher exited early:\n${output}`);
        assert(Date.now() < deadline, `Server startup timed out:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const get = async (path) => {
        const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200, `GET ${path}`);
        return response;
      };
      assert.equal((await (await get("/api/health")).json()).ok, true);
      const html = await (await get("/")).text();
      assert.equal(html, await (await get("/chat")).text(), "SPA fallback");
      assert.match(html, /<html/);
      const asset = /src="(\/assets\/[^" ]+\.js)"/.exec(html)?.[1];
      assert(asset, "Built frontend JavaScript is linked");
      await (await get(asset)).arrayBuffer();
      assert((await (await get("/licenses/index.json")).json()).entries.length > 0);
      assert.equal(await readFile(join(directory, ".env"), "utf8"), expectedEnv);
      console.log(`Verified ${binary}: ${firstRun ? "first launch" : "existing configuration"}`);
    } finally {
      if (child.pid && child.exitCode === null) {
        const exited = once(child, "exit");
        if (platform === "win32") {
          const stopped = spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { timeout: 5000 });
          assert.equal(stopped.status, 0, "Stop the Windows server process tree");
        } else {
          child.kill("SIGTERM");
        }
        const forceStop = setTimeout(() => child.kill("SIGKILL"), 5000);
        try {
          await exited;
        } finally {
          clearTimeout(forceStop);
        }
      }
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
