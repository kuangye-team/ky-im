// Interleave preserved baseline and current builds by scenario to reduce time drift.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../..", import.meta.url));
const tag = process.argv[2];
if (!tag || !/^[a-zA-Z0-9_-]+$/.test(tag)) throw new Error("Supply a unique run tag");
const cases = (process.argv[3] ?? "web-web,web-native,native-web,tcp,quic").split(",");
let current = process.env.TRANSFER_BENCH_CURRENT;
for (const scenario of cases) {
  for (const revision of ["before", "after"]) {
    const label = `${tag}-${revision}-${scenario}`;
    const replay = revision === "before" ? process.env.TRANSFER_BENCH_BASELINE || "baseline" : current;
    const env = { ...process.env, TRANSFER_BENCH_MIB: process.env.TRANSFER_BENCH_MIB || "64", TRANSFER_BENCH_REPEATS: process.env.TRANSFER_BENCH_REPEATS || "3" };
    if (replay) env.TRANSFER_BENCH_REPLAY = replay;
    else delete env.TRANSFER_BENCH_REPLAY;
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["ssg/tests/benchmark/run.mjs", label, scenario], { cwd: root, env, stdio: "inherit" });
      child.once("error", reject); child.once("exit", resolve);
    });
    if (code !== 0) process.exit(Number(code) || 1);
    if (revision === "after") current ??= label;
  }
}
