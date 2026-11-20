// node ssg/tests/benchmark/run.mjs <label> [web-web,web-native,native-web,tcp,quic,webtransport]
import { build } from "vite";
import { chromium } from "@playwright/test";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, writeFile, rm, cp } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const label = process.argv[2];
if (!label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Supply a new result label");
const selected = (process.argv[3] ?? "web-web,web-native,native-web,tcp,quic").split(",");
const output = resolve(root, "temp/artifacts/transfer-opt", label);
await mkdir(resolve(root, "temp/artifacts/transfer-opt"), { recursive: true });
await mkdir(output); // Never overwrite a baseline.
const size = process.env.TRANSFER_BENCH_BYTES === undefined ? Number(process.env.TRANSFER_BENCH_MIB ?? 128) * 1048576 + 17 : Number(process.env.TRANSFER_BENCH_BYTES);
const checkBulk = process.env.TRANSFER_BENCH_CHECK_BULK;
assert([undefined, "1", "ordered"].includes(checkBulk), "Invalid file-channel expectation");
const repeats = Number(process.env.TRANSFER_BENCH_REPEATS ?? 3);
const warmup = process.env.TRANSFER_BENCH_WARMUP !== "0";
const replay = process.env.TRANSFER_BENCH_REPLAY;
const activityOption = process.env.TRANSFER_BENCH_MACOS_SEND_ACTIVITY;
assert([undefined, "0", "1"].includes(activityOption), "Invalid macOS activity setting");
const macosSendActivity = activityOption === undefined ? undefined : activityOption === "1";
if (replay && !/^[a-zA-Z0-9_-]+$/.test(replay)) throw new Error("Invalid replay label");
assert(Number.isSafeInteger(size) && size > 0 && size <= 3 * 1024 ** 3);
assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
// Keep the small historical benchmark comparable. Large runs use a real disk file at both ends.
const diskSource = size > 256 * 1048576 ? resolve(output, "source.bin") : undefined;
if (diskSource) {
  const block = Buffer.alloc(251 * 8192);
  for (let i = 0; i < block.length; i++) block[i] = i % 251;
  const file = await open(diskSource, "wx");
  try {
    for (let offset = 0; offset < size; offset += block.length)
      await file.writeFile(block.subarray(0, Math.min(block.length, size - offset)));
  } finally { await file.close(); }
}
const children = new Set(), contexts = new Set(), pending = new Map(), clients = new Map();
let browser, secondBrowser, server, wss, sequence = 0, activeToken;
function child(command, args, env, logName) {
  const log = createWriteStream(resolve(output, logName));
  const process = spawn(command, args, { cwd: root, env: { ...globalThis.process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(process);
  process.stdout.pipe(log); process.stderr.pipe(log);
  process.once("exit", () => { children.delete(process); log.end(); });
  return process;
}
async function stop(process) {
  if (!children.has(process)) return;
  process.kill("SIGTERM");
  for (let i = 0; i < 50 && children.has(process); i++) await delay(100);
  if (children.has(process)) process.kill("SIGKILL");
}
async function waitFor(check, timeout = 45000) {
  const end = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > end) throw new Error("Benchmark startup timed out");
    await delay(100);
  }
}
function call(role, op, arg = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${role} ${op} timed out`)); }, diskSource && op === "send" ? 900000 : 180000);
    pending.set(id, { resolve, reject, timer });
    clients.get(role).socket.send(JSON.stringify({ id, op, arg }));
  });
}
function nativeResources(processes) {
  return processes.map(process => {
    const [cpuTime, rssKiB] = execFileSync("ps", ["-p", String(process.pid), "-o", "time=", "-o", "rss="], { encoding: "utf8" }).trim().split(/\s+/);
    const parts = cpuTime.split(":").map(Number);
    return { pid: process.pid, cpuSeconds: parts.reduce((total, part) => total * 60 + part, 0), rssKiB: Number(rssKiB) };
  });
}
function rssKiB(pids) {
  const result = spawnSync("ps", ["-p", pids.join(","), "-o", "rss="], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) return;
  return result.stdout.trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
}
const results = [];
try {
  for (const port of [4330, 4331]) {
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(error => error ? reject(error) : resolve()));
    });
  }
  if (replay) await cp(resolve(root, "temp/artifacts/transfer-opt", replay, "web"), resolve(output, "web"), { recursive: true });
  else await build({ configFile: false, publicDir: false, root: resolve(root, "ssg"), logLevel: "warn",
    envPrefix: "TRANSFER_BENCH_UNUSED_", define: { "import.meta.env.VITE_DESKTOP": "false", "import.meta.env.VITE_ROOM": '"transfer-benchmark"' },
    build: { outDir: resolve(output, "web"), emptyOutDir: true, minify: true,
      rollupOptions: { input: resolve(root, "ssg/tests/benchmark/index.html") } } });
  await cp(replay ? resolve(root, "temp/artifacts/transfer-opt", replay, "native-benchmark")
    : resolve(root, process.env.TRANSFER_BENCH_NATIVE ?? "temp/cache/cargo/release/examples/transfer-benchmark"), resolve(output, "native-benchmark"));
  child("cargo", ["run", "--manifest-path", "api/Cargo.toml", "--locked"],
    { BIND_ADDR: "127.0.0.1:4331", API_AUTH: "", RELAY_ENABLED: "false", CORS_ORIGINS: "http://127.0.0.1:4330" }, "api.log");
  await waitFor(async () => { try { return (await fetch("http://127.0.0.1:4331/api/health")).ok; } catch { return false; } }, 180000);
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://127.0.0.1:4330").pathname;
      const file = resolve(output, "web", "." + (path === "/" ? "/tests/benchmark/index.html" : path));
      if (!file.startsWith(resolve(output, "web") + "/")) throw new Error("Invalid path");
      response.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream");
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  wss = new WebSocketServer({ server, path: "/control", maxPayload: 8 * 1048576 });
  wss.on("connection", (socket, request) => {
    const query = new URL(request.url, "http://127.0.0.1:4330").searchParams;
    const role = query.get("role");
    if (query.get("token") !== activeToken || !["A", "B"].includes(role) || clients.has(role)) return socket.close();
    socket.on("message", data => {
      const value = JSON.parse(String(data));
      if (value.hello) clients.set(role, { socket, ...value });
      else {
        const item = pending.get(value.id);
        if (!item) return;
        clearTimeout(item.timer); pending.delete(value.id);
        if (value.error) item.reject(new Error(JSON.stringify(value)));
        else item.resolve(value.result);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(4330, "127.0.0.1", resolve); });
  const launchOptions = { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    args: selected.every(name => name === "webtransport") ? [] : ["--disable-features=WebRtcHideLocalIpsWithMdns", "--disable-background-timer-throttling"] };
  const separateBrowsers = selected.includes("web-web") && (diskSource !== undefined || process.env.TRANSFER_BENCH_SEPARATE_BROWSERS === "1");
  if (!diskSource) {
    browser = await chromium.launch(launchOptions);
    if (separateBrowsers) secondBrowser = await chromium.launch(launchOptions);
  }
  const environment = { os: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
    arch: process.arch, browser: browser?.version(), separateBrowsers,
    stages: process.env.TRANSFER_BENCH_METRICS !== "0", size, repeats, warmup, replay,
    macosSendActivity, checkBulk,
    native: "release Tauri example, real IPC + SQLite/filesystem; production frontend bundle",
    network: "same host; selected addresses recorded per run, not two-device LAN",
    source: diskSource ? "source.bin on disk, native path or browser file input" : "web File; native managed disk attachment (prepared before timing)",
    resources: "native process CPU time and RSS exclude WebKit child processes; Noise is synchronous wall time; GC not separately measured",
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
  await writeFile(resolve(output, "environment.json"), JSON.stringify(environment, null, 2));
  const cases = { "web-web": ["web", "web", "rtc"], "web-native": ["web", "native", "rtc"],
    webtransport: ["native", "web", "webtransport"],
    "native-web": ["native", "web", "rtc"], tcp: ["native", "native", "tcp"], quic: ["native", "native", "quic"] };
  for (const name of selected) {
    const [sender, receiver, mode] = cases[name];
    activeToken = randomUUID(); clients.clear();
    const nativeProcesses = [], pages = [], sessions = [];
    const browserCpu = async () => (await Promise.all(sessions.map(s => s.send("SystemInfo.getProcessInfo"))))
      .flatMap(s => s.processInfo.map(({ id, type, cpuTime }) => ({ id, type, cpuTime })));
    try {
      for (const [role, kind] of [["A", sender], ["B", receiver]]) {
        const url = `http://127.0.0.1:4330/?token=${activeToken}&role=${role}&api=ws://127.0.0.1:4331/api/ws`;
        if (kind === "native") nativeProcesses.push(child(resolve(output, "native-benchmark"), [],
          { TRANSFER_BENCH_URL: url, TRANSFER_BENCH_DATA: resolve(output, "data", `${name}-${role}`),
            ...(diskSource && role === "A" ? { TRANSFER_BENCH_FILE: diskSource } : {}) }, `${name}-${role}.log`));
        else {
          const instance = name === "web-web" && role === "B" && secondBrowser ? secondBrowser : browser;
          // A temporary on-disk profile exercises normal OPFS quota and file writes for GiB transfers.
          const context = diskSource ? await chromium.launchPersistentContext("", launchOptions) : await instance.newContext();
          contexts.add(context);
          if (!sessions.length || (separateBrowsers && name === "web-web"))
            sessions.push(await context.browser().newBrowserCDPSession());
          if (!environment.browser) {
            environment.browser = context.browser().version();
            await writeFile(resolve(output, "environment.json"), JSON.stringify(environment, null, 2));
          }
          const page = await context.newPage(); pages.push(page);
          page.on("pageerror", error => console.error(`${name} ${role}: ${error.message}`));
          await page.goto(url);
        }
      }
      await waitFor(() => clients.size === 2);
      if (diskSource && !clients.get("A").diskFixture)
        throw new Error("GiB runs need a benchmark build with disk fixture support. Build it before using replay.");
      const diagnostics = process.env.TRANSFER_BENCH_DIAGNOSTICS === "1";
      const peers = await Promise.all(["A", "B"].map(role => call(role, "start", { name: role, mode, diagnostics, stages: environment.stages, macosSendActivity })));
      const connectionStarted = performance.now();
      const setupErrors = [];
      for (let attempt = 1; ; attempt++) {
        const connected = await Promise.allSettled([call("A", "connect"), call("B", "connect")]);
        const errors = connected.filter(result => result.status === "rejected");
        if (!errors.length) break;
        setupErrors.push({ attempt, errors: errors.map(result => String(result.reason)) });
        await writeFile(resolve(output, `${name}-setup-errors.json`), JSON.stringify(setupErrors, null, 2));
        if (attempt === 3) throw errors[0].reason;
        await delay(500);
      }
      const connectionMs = performance.now() - connectionStarted;
      if (diskSource && sender === "web") await pages[0].locator("#source").setInputFiles(diskSource);
      await call("A", "prepare", { size, diskSource });
      let previousBulkSent = 0, previousBulkReceived = 0, previousMessages = 0;
      for (let run = warmup ? 0 : 1; run <= repeats; run++) {
        const fileName = `${name}-${run}.bin`;
        await Promise.all([call("A", "reset", { name: fileName }), call("B", "reset", { name: fileName })]);
        const resourcesBefore = nativeResources(nativeProcesses);
        const browserBefore = await browserCpu();
        const pids = [...browserBefore.map(p => p.id), ...nativeProcesses.map(p => p.pid)];
        let peakRssKiB;
        const udpDrops = [];
        const sampleStart = performance.now();
        const sampleMemory = () => {
          const value = rssKiB(pids);
          if (value !== undefined) peakRssKiB = Math.max(peakRssKiB ?? 0, value);
          if (diskSource && diagnostics) {
            const udp = spawnSync("netstat", ["-s", "-p", "udp"], { encoding: "utf8" });
            const full = udp.stdout?.match(/(\d+) dropped due to full socket buffers/);
            if (full) udpDrops.push({ elapsedMs: Math.round(performance.now() - sampleStart), hostFullSocketDrops: Number(full[1]) });
          }
        };
        sampleMemory();
        const rssTimer = setInterval(sampleMemory, 1000);
        let sent;
        const sendStartedUnixMs = Date.now();
        try { sent = await call("A", "send", { name: fileName }); }
        finally { clearInterval(rssTimer); }
        sampleMemory();
        const browserAfter = await browserCpu();
        const resourcesAfter = nativeResources(nativeProcesses);
        const [a, b] = await Promise.all([call("A", "metrics"), call("B", "metrics")]);
        if (a.closed + b.closed > 0) {
          const verified = await call("B", "verify", {name: fileName, size});
          await writeFile(resolve(output, `${name}-${run}-interrupted.json`), JSON.stringify({sent, sender: a, receiver: b, verified}, null, 2));
        }
        assert.equal(a.closed + b.closed, 0, "No reconnection during transfer");
        if (mode === "webtransport") {
          assert(Object.values(a.routes.native).some(addr => addr.includes("/webtransport")), "Expected a native WebTransport connection");
          assert(b.routes.web.some(addr => addr.includes("/webtransport/certhash/")), "Expected a pinned browser WebTransport connection");
        }
        if (mode === "rtc") for (const side of [a, b]) {
          assert(side.routes.rtc.some(s => s.state === "connected" && s.local?.type === "host" && s.remote?.type === "host"), "Expected direct host candidates");
        }
        if (mode === "rtc" && checkBulk) {
          const totals = (side, key) => side.routes.rtc.reduce((sum, route) => sum + (route[key] ?? 0), 0);
          const sent = totals(a, "bulkSent"), received = totals(b, "bulkReceived");
          const sentDelta = sent - previousBulkSent, receivedDelta = received - previousBulkReceived;
          assert.equal(sentDelta, receivedDelta, "Unordered channel sender/receiver counts differ");
          if (checkBulk === "1" && size > 2 * 1048576) {
            const route = a.routes.rtc.find(r => r.bulkSent > 0);
            const stride = route?.rtcSliceBytes - 16;
            assert(Number.isInteger(stride) && stride > 0 && stride <= 65520, "Expected negotiated bulk message limit");
            const chunk = route.rtcFileChunkBytes;
            assert(Number.isSafeInteger(chunk) && chunk > 0, "Expected configured RTC file chunk size");
            const tail = size % chunk;
            const expectedMessages = Math.ceil((chunk + 44) / stride) * Math.floor(size / chunk) + (tail ? Math.ceil((tail + 44) / stride) : 0);
            const messages = b.routes.rtc.flatMap(r => r.dataChannels)
              .filter(c => c.label === "hummingbird-file-v2").reduce((n, c) => n + c.messagesReceived, 0);
            assert.equal(messages - previousMessages, expectedMessages, "Unexpected RTC fragment count");
            previousMessages = messages;
            assert.equal(sentDelta, size + Math.ceil(size / chunk) * 44, "Unexpected business record count");
          } else assert.equal(sentDelta, 0, "Expected the ordered channel");
          previousBulkSent = sent; previousBulkReceived = received;
        }
        if (diagnostics) for (const side of [a, b]) {
          assert(side.fileLogs.some(log => log.outcome === "delivered" && log.samples.at(-1).transferredBytes === size), "Missing final per-file diagnostics");
        }
        assert(await call("B", "verify", { name: fileName, size }));
        const result = { case: name, run, warmup: run === 0, peers, connectionMs, setupRetries: setupErrors.length, ...sent, sender: a, receiver: b,
          resourcesBefore, resourcesAfter, browserBefore, browserAfter, peakRssKiB, udpDrops, sendStartedUnixMs, verified: true };
        results.push(result);
        await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
        console.log(JSON.stringify({ label, case: name, run, MiBps: sent.MiBps, verified: true }));
        if (pages.length) await pages[0].screenshot({ path: resolve(root, `temp/screenshot/transfer-${label}-${name}.png`) });
        await Promise.all([call("A", "cleanup"), call("B", "cleanup")]);
      }
    } finally {
      for (const process of nativeProcesses) await stop(process);
      for (const page of pages) { contexts.delete(page.context()); await page.context().close(); }
      for (const client of clients.values()) client.socket.close();
      await rm(resolve(output, "data"), { recursive: true, force: true });
      await delay(500);
    }
  }
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  for (const context of contexts) await context.close();
  await browser?.close();
  await secondBrowser?.close();
  for (const process of [...children]) await stop(process);
  for (const socket of wss?.clients ?? []) socket.terminate();
  wss?.close(); server?.close();
}
