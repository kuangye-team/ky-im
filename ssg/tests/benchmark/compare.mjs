// node ssg/tests/benchmark/compare.mjs baseline,baseline-repeat stage2,stage2-repeat
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../../temp/artifacts/transfer-opt", import.meta.url));
async function load(labels) {
  assert(labels && labels.split(",").every(label => /^[a-zA-Z0-9_-]+$/.test(label)));
  return (await Promise.all(labels.split(",").map(async label => {
    const rows = JSON.parse(await readFile(resolve(root, label, "results.json"), "utf8"));
    return rows.filter(row => !row.warmup).map(row => ({ ...row, label }));
  }))).flat();
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
function resources(rows) {
  const cpu = [], rss = [];
  for (const row of rows) {
    if (row.peakRssKiB !== undefined) rss.push(row.peakRssKiB / 1024);
    if (!row.browserBefore || !row.browserAfter) continue;
    const before = new Map(row.browserBefore.map(p => [p.id, p.cpuTime]));
    const native = new Map(row.resourcesBefore.map(p => [p.pid, p.cpuSeconds]));
    if (before.size !== row.browserAfter.length || native.size !== row.resourcesAfter.length) continue;
    if (row.browserAfter.some(p => !before.has(p.id)) || row.resourcesAfter.some(p => !native.has(p.pid))) continue;
    const browserCpu = row.browserAfter.reduce((sum, p) => sum + p.cpuTime - before.get(p.id), 0);
    const nativeCpu = row.resourcesAfter.reduce((sum, p) => sum + p.cpuSeconds - native.get(p.pid), 0);
    cpu.push((browserCpu + nativeCpu) / (row.size / 1024 ** 3));
  }
  return { cpuSecondsPerGiB: cpu.length ? median(cpu) : null, sampledPeakRssMiB: rss.length ? median(rss) : null };
}
const before = await load(process.argv[2]), after = await load(process.argv[3]);
const result = [];
for (const name of new Set(before.map(row => row.case))) {
  const a = before.filter(row => row.case === name), b = after.filter(row => row.case === name);
  assert(a.length && b.length, `Missing ${name}`);
  for (const row of [...a, ...b]) {
    assert(row.verified && row.sender.closed + row.receiver.closed === 0);
    assert.equal(row.size, a[0].size);
    for (const side of ["sender", "receiver"]) {
      const routes = row[side].routes;
      if (["tcp", "quic"].includes(name)) {
        assert(Object.values(routes.native).some(address => address.includes(name === "tcp" ? "/tcp/" : "/quic-v1")));
      } else {
        assert(routes.rtc.some(rtc => rtc.state === "connected"));
        assert(routes.rtc.every(rtc => rtc.local?.type === "host" && rtc.remote?.type === "host"));
      }
    }
  }
  const speed = rows => ({ median: median(rows.map(row => row.MiBps)), min: Math.min(...rows.map(row => row.MiBps)), max: Math.max(...rows.map(row => row.MiBps)), samples: rows.length, ...resources(rows) });
  const old = speed(a), next = speed(b);
  const details = {};
  for (const side of ["sender", "receiver"]) {
    details[side] = {};
    for (const name of ["ipc.write.pipe", "ipc.write.frame", "ipc.request.consumed", "ipc.request.pipe_consumed",
      "file.bufferWait", "file.windowWait", "file.sourceRead", "file.destinationWrite", "noise.encrypt", "noise.decrypt", "storage.read", "storage.write", "pipe.pending"]) {
      const values = rows => {
        const samples = rows.map(row => row[side].frontend.samples[name]).filter(Boolean);
        if (!samples.length) return null;
        return { count: median(samples.map(s => s.count)), totalMs: median(samples.map(s => s.totalMs)),
          averageBytes: median(samples.map(s => s.count ? s.bytes / s.count : 0)), maxBytes: Math.max(...samples.map(s => s.maxBytes)) };
      };
      details[side][name] = { before: values(a), after: values(b) };
    }
  }
  result.push({ case: name, before: old, after: next, percent: (next.median / old.median - 1) * 100, details });
}
const report = { before: process.argv[2], after: process.argv[3],
  caveats: ["Same-host release Tauri IPC/filesystem and Chrome, not two-device LAN", "One warmup excluded per connection", "Timings at different layers overlap and must not be summed", "GC and WebKit child CPU are not measured"], result };
await writeFile(resolve(root, "comparison.json"), JSON.stringify(report, null, 2));
console.log("| 场景 | 优化前 MiB/s | 优化后 MiB/s | 变化 | 样本数（前/后） |\n|---|---:|---:|---:|---:|");
for (const row of result) console.log(`| ${row.case} | ${row.before.median.toFixed(2)} | ${row.after.median.toFixed(2)} | ${row.percent.toFixed(1)}% | ${row.before.samples}/${row.after.samples} |`);
