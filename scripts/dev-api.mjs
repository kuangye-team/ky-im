import { spawn } from "node:child_process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const child = spawn("cargo", ["run", "--locked", ...process.argv.slice(2)], {
  cwd: fileURLToPath(new URL("../api/", import.meta.url)),
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`启动信令服务失败：${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? 128 + constants.signals[signal];
});
