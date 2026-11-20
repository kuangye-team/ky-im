import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";

async function pair(browser: Browser, baseURL: string, kinds: string[], mode: string, authorized = false,
  configurePage?: (page: Page, index: number) => Promise<void>,
  initiator = mode.startsWith("webtransport") ? kinds.indexOf("web") : 0) {
  const contexts = await Promise.all(kinds.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  for (const [i, page] of pages.entries()) {
    page.on("pageerror", error => console.error(error.message));
    await configurePage?.(page, i);
    if (mode === "turn") await page.addInitScript(() => {
      const Original = RTCPeerConnection;
      window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super({ ...config, iceTransportPolicy: "relay" }); } };
    });
    const query = new URLSearchParams();
    if (mode === "turn") query.set("nativeTurn", "1");
    if (authorized) { query.set("server", "ws://127.0.0.1:4312/api/ws"); query.set("authorization", "Bearer browser-test-secret"); }
    await page.goto(`${baseURL}/tests/browser/p2p.html?${query}`);
    await page.evaluate(async ({ kind, mode, name }) => (window as any).start(name, kind, mode), { kind: kinds[i], mode, name: i ? "B" : "A" });
  }
  for (const page of pages) {
    await expect.poll(() => page.evaluate(() => (window as any).engine.getSnapshot().peers.length), { timeout: 20000 }).toBe(1);

  }
  await pages[initiator].evaluate(async () => { const e = (window as any).engine; await e.selectPeer(e.getSnapshot().peers[0]); await e.sendText("ready"); });
  await pages[1 - initiator].evaluate(async () => { const e = (window as any).engine; await e.selectPeer(e.getSnapshot().peers[0]); });
  return { pages, close: () => Promise.all(contexts.map(c => c.close())) };
}
function desktopRtcSample(page: Page) {
  return page.evaluate(() => {
    const engine = (window as any).engine;
    return engine.network.transport.channels.get(engine.getSnapshot().activePeerId).rtcSample();
  });
}
async function auto(page: Page) {
  await page.evaluate(async () => { const e = (window as any).engine; await e.updatePeerAutoAcceptFiles(e.getSnapshot().peers[0].id, true); });
}
async function verify(page: Page, name: string, length: number) {
  await expect.poll(() => page.evaluate(name => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === name)?.status, name), { timeout: 30000 }).toBe("delivered");
  expect(await page.evaluate(async ({ name, length }) => {
    const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === name);
    const source = await e.storage.getAttachmentSource?.(m.id) ?? await e.getAttachment(m.id);
    if (!source || source.size !== length) return false;
    const readBytes = 128 * 1024; // Supported by every storage configuration.
    for (let offset = 0; offset < length; offset += readBytes) {
      const end = Math.min(length, offset + readBytes);
      const bytes = new Uint8Array(await source.slice(offset, end).arrayBuffer());
      if (bytes.length !== end - offset || !bytes.every((v, i) => v === (offset + i) % 251)) return false;
    }
    return true;
  }, { name, length })).toBe(true);
}
for (const [sender, receiver, mode] of [
  ["web", "desktop", "rtc"], ["desktop", "web", "rtc"],
  ["desktop", "web", "webtransport"], ["web", "desktop", "webtransport"],
  ["web", "desktop", "relay"], ["desktop", "web", "relay"],
  ["desktop", "desktop", "tcp"], ["desktop", "desktop", "quic"],
  ...(process.env.P2P_NATIVE_TURN ? [["web", "desktop", "turn"], ["desktop", "web", "turn"]] : []),
]) {
  test(`${sender} → ${receiver} ${mode}: native bytes, consent, content and forwarding`, async ({ browser, baseURL }) => {
    const p = await pair(browser, baseURL!, [sender, receiver], mode), [a, b] = p.pages;
    try {
      await a.evaluate(() => {
        const bytes = Uint8Array.from({ length: 700 * 1024 + 17 }, (_, i) => i % 251);
        (window as any).sending = (window as any).engine.sendFiles([new File([bytes], "native.bin")]);
      });
      await expect.poll(() => b.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === "native.bin")?.status)).toBe("awaiting-acceptance");
      expect(await b.evaluate(() => { const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "native.bin"); return e.getTransferredBytes(m.id); })).toBe(0);
      await b.evaluate(() => { const e = (window as any).engine; return e.acceptFile(e.getSnapshot().messages.find((m: any) => m.fileName === "native.bin").id); });
      await a.evaluate(() => (window as any).sending);
      await verify(b, "native.bin", 700 * 1024 + 17);
      await auto(a);
      await b.evaluate(async () => { const e = (window as any).engine; await e.forwardMessage(e.getSnapshot().messages.find((m: any) => m.fileName === "native.bin"), e.getSnapshot().peers[0].id); });
      await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages.filter((m: any) => m.fileName === "native.bin" && m.status === "delivered").length)).toBe(2);
      for (const [i, page] of p.pages.entries()) if ([sender, receiver][i] === "desktop") {
        if (mode === "webtransport") {
          const web = sender === "web" ? a : b;
          const route = await web.evaluate(() => {
            const e = (window as any).engine;
            const conn = e.network.transport.channels.get(e.getSnapshot().activePeerId).connection;
            return {address: conn.remoteAddr.toString(), direction: conn.direction, peer: conn.remotePeer.toString(), expected: e.getSnapshot().activePeerId};
          });
          expect(route.direction).toBe("outbound");
          expect(route.address).toContain("/webtransport/certhash/");
          expect(route.peer).toBe(route.expected);
          if (sender === "desktop") {
            await web.evaluate(() => (window as any).render());
            await expect(web.getByRole("textbox", {name: "消息内容"})).toBeVisible();
            await mkdir(resolve("../temp/screenshot"), {recursive: true});
            await web.screenshot({path: resolve("../temp/screenshot/webtransport-transfer.png")});
          }
        }
        const usesWebView = mode === "rtc" || mode === "turn";
        const ipc = await page.evaluate(() => (window as any).events.filter((e: any) => e.type === "payloadIPC"));
        expect(ipc.some((event: any) => event.kind === "pipe_data")).toBe(usesWebView);
        expect(ipc.some((event: any) => event.frameKind === 2)).toBe(false);
        if (mode === "turn") {
          expect(await page.evaluate(async () => {
            const engine = (window as any).engine;
            const channel = engine.network.transport.channels.get(engine.getSnapshot().activePeerId);
            const rtc = engine.network.transport.central.rtc.get(channel.rtcSample().rtcSessionId);
            const stats: RTCStatsReport = await rtc.pc.getStats();
            return [...stats.values()].some(pair => pair.type === "candidate-pair" && pair.nominated &&
              pair.state === "succeeded" && stats.get(pair.localCandidateId)?.candidateType === "relay");
          })).toBe(true);
        }
      }
    } finally { await p.close(); }
  });
}

test("native folders preserve empty entries, nested files and save acknowledgments", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "desktop"], "tcp"), [a, b] = p.pages;
  try {
    await auto(b);
    await a.evaluate(async () => {
      const e = (window as any).engine;
      await e.sendFolder(async () => ({ name: "folder", entries: [
        { kind: "directory", path: "empty" }, { kind: "directory", path: "nested" },
        { kind: "file", path: "nested/zero", file: new File([], "zero") },
        { kind: "file", path: "nested/data.bin", file: new File([new Uint8Array(700 * 1024).fill(7)], "data.bin") },
      ] }), () => {}, new AbortController().signal);
    });
    await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.folder)?.status)).toBe("delivered");
    expect(await b.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.folder)?.status)).toBe("delivered");
    await b.evaluate(() => (window as any).render());
    await expect(b.getByRole("textbox", { name: "消息内容" })).toBeVisible();
    await mkdir(resolve("../temp/screenshot"), { recursive: true });
    await b.screenshot({ path: resolve("../temp/screenshot/native-folder-transfer.png"), fullPage: true });
  } finally { await p.close(); }
});

for (const kinds of [["web", "desktop"], ["desktop", "web"]]) {
  for (const [mode, folder] of [["relay", false], ["relay", true], ["webtransport", false]] as const)
    test(`${kinds.join(" → ")}: resumes a broken ${mode} with a ${folder ? "folder" : "file"}`, async ({ browser, baseURL }) => {
    const p = await pair(browser, baseURL!, kinds, mode), [a, b] = p.pages;
    const web = kinds[0] === "web" ? a : b;
    const webRoute = () => web.evaluate(() => {
      const e = (window as any).engine;
      return e.network.transport.channels.get(e.getSnapshot().activePeerId).connection.remoteAddr.toString();
    });
    try {
      await auto(b);
      if (mode === "webtransport") expect(await webRoute()).toContain("/webtransport/");
      await a.evaluate(folder => {
        const e = (window as any).engine, c = e.network.transport.channels.get(e.getSnapshot().activePeerId);
        if (c.fileTasks) {
          const progress = c.onfileprogress;
          c.onfileprogress = (event: any) => {
            progress?.(event);
            if (event.sent && !(window as any).interrupted) { (window as any).interrupted = true; c.close(); }
          };
        } else {
          const send = c.send.bind(c); let count = 0;
          c.send = (data: string | ArrayBuffer) => {
            if (data instanceof ArrayBuffer && ++count === 4) { (window as any).interrupted = true; c.close(); throw new Error("test disconnection"); }
            send(data);
          };
        }
        const bytes = Uint8Array.from({ length: 1800 * 1024 + 17 }, (_, i) => i % 251);
        const file = new File([bytes], "resume-native.bin");
        return folder ? e.sendFolder(async () => ({ name: "recovered", entries: [
          { kind: "directory", path: "nested" }, { kind: "file", path: "empty", file: new File([], "empty") },
          { kind: "file", path: "nested/data", file },
        ] }), () => {}, new AbortController().signal) : e.sendFiles([file]);
      }, folder);
      await expect.poll(() => a.evaluate(() => (window as any).interrupted)).toBe(true);
      if (folder) {
        const result = await b.evaluate(async kind => {
          const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.folder);
          if (m.status !== "delivered") throw new Error("Folder not committed");
          if (kind === "desktop") {
            const record = await e.storage.call({ op: "attachment", id: m.id });
            return (await e.storage.getStorageInfo()).directory + "/" + record.path + "/nested/data";
          }
          const record = await (await e.storage.database).get("attachments", m.id);
          const root = await (await e.storage.directory()).getDirectoryHandle(record.path);
          const file = await (await (await root.getDirectoryHandle("nested")).getFileHandle("data")).getFile();
          const bytes = new Uint8Array(await file.arrayBuffer());
          return bytes.length === 1800 * 1024 + 17 && bytes.every((v, i) => v === i % 251);
        }, kinds[1]);
        if (typeof result === "string") {
          const bytes = await readFile(result);
          expect(bytes.length).toBe(1800 * 1024 + 17);
          expect(bytes.every((v, i) => v === i % 251)).toBe(true);
        } else expect(result).toBe(true);
        return;
      }
      await verify(b, "resume-native.bin", 1800 * 1024 + 17);
      if (mode === "webtransport") expect(await webRoute()).toContain("/webtransport/");
      if (kinds[0] === "desktop") await verify(a, "resume-native.bin", 1800 * 1024 + 17);
    } finally { await p.close(); }
  });
}

test("desktop balances RTC fragments for the configured file record size", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "web"], "rtc"), [a, b] = p.pages;
  try {
    await auto(b);
    const limits = await b.evaluate(async () => {
      const { rtcMessageLimit } = await import("/src/core/network/libp2p/rtc-limits.ts");
      const host = window as any, e = host.engine;
      const channel = e.network.transport.channels.get(e.getSnapshot().activePeerId);
      const bulk = channel.bulk(), admit = bulk.admit.bind(bulk);
      const lengths: number[] = host.firstRecordLengths = [];
      let firstId: string | undefined;
      bulk.admit = (packet: Uint8Array) => {
        const id = String.fromCharCode(...packet.subarray(0, 12));
        firstId ??= id;
        if (id === firstId) lengths.push(packet.byteLength);
        return admit(packet);
      };
      return { ...channel.rtcSample(), messageLimit: rtcMessageLimit };
    });
    const size = 2 * 1024 * 1024 + 17;
    await a.evaluate(async size => {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      await (window as any).engine.sendFiles([new File([bytes], "balanced.bin")]);
    }, size);
    await verify(b, "balanced.bin", size);
    const route = await desktopRtcSample(a);
    // Both WebViews in this fixture use Chromium and support the configured limit.
    expect(route.rtcSliceBytes).toBe(limits.messageLimit);
    expect(limits.rtcSliceBytes).toBe(limits.messageLimit);
    expect(route.rtcFileChunkBytes).toBe(limits.rtcFileChunkBytes);
    expect(route.rtcHighBytes).toBe(limits.rtcHighBytes);
    expect(route.rtcLowBytes).toBe(limits.rtcLowBytes);
    const lengths: number[] = await b.evaluate(() => (window as any).firstRecordLengths);
    const record = route.rtcFileChunkBytes + 44;
    expect(route.rtcBulkSentBytes).toBe(size + 44 * Math.ceil(size / route.rtcFileChunkBytes));
    expect(lengths).toHaveLength(Math.ceil(record / (route.rtcSliceBytes - 16)));
    expect(lengths.reduce((total, n) => total + n - 16, 0)).toBe(record);
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);

    await auto(a);
    await b.evaluate(async size => {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      await (window as any).engine.sendFiles([new File([bytes], "return.bin")]);
    }, size);
    await verify(a, "return.bin", size);
    const after = await desktopRtcSample(a);
    expect(after.rtcBulkReceivedBytes).toBe(size + 44 * Math.ceil(size / limits.rtcFileChunkBytes));
  } finally { await p.close(); }
});

test("a DTLS certificate mismatch uses the authenticated ordered stream for the whole file", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["web", "desktop"], "rtc", false, async (page, i) => {
    if (i) return;
    await page.addInitScript(() => {
      const original = RTCPeerConnection.prototype.getStats;
      RTCPeerConnection.prototype.getStats = async function (selector) {
        const report = await original.call(this, selector);
        const copy = new Map(report);
        for (const t of report.values()) {
          const id = t.type === "transport" && t.remoteCertificateId;
          if (id && report.has(id)) copy.set(id, { ...report.get(id), fingerprint: Array(32).fill("AB").join(":") });
        }
        return copy;
      };
    });
  });
  const [a, b] = p.pages, length = 2 * 1024 * 1024 + 1;
  try {
    await auto(b);
    expect(await a.evaluate(async length => {
      const e = (window as any).engine;
      const bulk = e.network.transport.channels.get(e.getSnapshot().activePeerId).bulk();
      const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
      await e.sendFiles([new File([bytes], "binding-fallback.bin")]);
      return [bulk.enabled, await bulk.bound(), bulk.sentBytes];
    }, length)).toEqual([true, false, 0]);
    await verify(b, "binding-fallback.bin", length);
    await auto(a);
    await b.evaluate(async () => {
      const e = (window as any).engine;
      const msg = e.getSnapshot().messages.find((m: any) => m.fileName === "binding-fallback.bin");
      await e.forwardMessage(msg, e.getSnapshot().activePeerId);
    });
    await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages
      .filter((msg: any) => msg.fileName === "binding-fallback.bin" && msg.status === "delivered").length)).toBe(2);
    const route = await desktopRtcSample(b);
    expect(route.rtcBulkSentBytes).toBe(0);
    expect(route.rtcBulkReceivedBytes).toBe(0);
  } finally { await p.close(); }
});

test("chat passes a waiting unordered file record and the file resumes on a new RTC connection", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["web", "web"], "rtc"), [a, b] = p.pages;
  const length = 6 * 1024 * 1024 + 17;
  try {
    await auto(b);
    await b.evaluate(() => {
      const host = window as any, e = host.engine;
      const channel = e.network.transport.channels.get(e.getSnapshot().activePeerId);
      const bulk = channel.bulk(), receive = bulk.receive.bind(bulk);
      let records = 0;
      bulk.receive = async (descriptor: Uint8Array) => {
        const plain = await receive(descriptor);
        if (++records === 5) {
          await new Promise<void>(resolve => { host.dropFileConnection = resolve; });
          channel.close();
          throw new Error("forced RTC disconnect");
        }
        return plain;
      };
    });
    await a.evaluate(length => {
      const host = window as any;
      const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
      host.sending = host.engine.sendFiles([new File([bytes], "unordered-resume.bin")]);
    }, length);
    await expect.poll(() => b.evaluate(() => typeof (window as any).dropFileConnection)).toBe("function");
    await a.evaluate(() => (window as any).engine.sendText("file is waiting"));
    await expect.poll(() => b.evaluate(() => (window as any).engine.getSnapshot().messages.some(
      (m: any) => m.text === "file is waiting"))).toBe(true);
    await b.evaluate(() => (window as any).dropFileConnection());
    expect(await a.evaluate(() => (window as any).sending)).toBe(true);
    await verify(b, "unordered-resume.bin", length);
    expect(await b.evaluate(() => {
      const e = (window as any).engine;
      return e.network.transport.channels.get(e.getSnapshot().activePeerId).bulk().receivedBytes;
    })).toBeGreaterThan(0);
  } finally { await p.close(); }
});

for (const receiver of ["web", "desktop"]) {
  test("mid-transfer Save As writes one complete external file on " + receiver, async ({ browser, baseURL }) => {
    const pairState = await pair(browser, baseURL!, ["web", receiver], "relay");
    const [a, b] = pairState.pages;
    try {
      await auto(b);
      await b.evaluate(async kind => {
        const w = window as any;
        if (kind === "web") {
          w.showSaveFilePicker = async () => {
            const root = await navigator.storage.getDirectory();
            return root.getFileHandle("external.bin", { create: true });
          };
        }
        await w.render();
      }, receiver);
      await a.evaluate(() => {
        const w = window as any, bytes = Uint8Array.from({ length: 6 * 1024 * 1024 + 13 }, (_, i) => i % 251);
        const file = new File([bytes], "midway.bin"), slice = file.slice.bind(file);
        const gate = new Promise<void>(resolve => { w.resumeSource = resolve; });
        const source = { name: file.name, type: file.type, size: file.size, slice: (start: number, end: number) => ({
          async arrayBuffer() {
            if (start > 0) await gate;
            return slice(start, end).arrayBuffer();
          },
        }) };
        w.sending = w.engine.sendFiles([source]);
      });
      await expect.poll(() => b.evaluate(async kind => {
        const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "midway.bin");
        if (m?.status !== "sending") return false;
        // UI progress is sampled; a fast native receiver can finish a window between samples.
        const received = kind === "desktop"
          ? (await e.network.transport.channels.get(m.peerId).fileTasks.state(m.id)).received
          : e.transfers.getTransferredBytes(m.id);
        return received > 256 * 1024;
      }, receiver)).toBe(true);
      if (receiver === "web") {
        await b.getByRole("button", { name: "另存为", exact: true }).click();
      } else {
        await b.evaluate(async () => {
          const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "midway.bin");
          await e.transfers.saveFileAs(m, await e.storage.createExternalFileDestination(m, "external.bin"));
        });
      }
      await expect.poll(() => b.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === "midway.bin").attachmentStorage)).toBe("external");
      await a.evaluate(() => { const w = window as any; w.resumeSource(); return w.sending; });
      await expect(b.getByText("已保存到所选位置", { exact: true })).toBeVisible();
      const result = await b.evaluate(async kind => {
        const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "midway.bin");
        if (await e.storage.getAttachmentSource(m.id)) throw new Error("Unexpected managed copy");
        if (kind === "desktop") return (await e.storage.getStorageInfo()).directory as string;
        const root = await navigator.storage.getDirectory();
        const file = await (await root.getFileHandle("external.bin")).getFile();
        const data = new Uint8Array(await file.arrayBuffer());
        return data.length === m.size && data.every((v, i) => v === i % 251);
      }, receiver);
      if (typeof result === "string") {
        const data = await readFile(resolve(result, "../exports/external.bin"));
        expect(data.length).toBe(6 * 1024 * 1024 + 13);
        expect(data.every((v, i) => v === i % 251)).toBe(true);
      } else expect(result).toBe(true);
    } finally { await pairState.close(); }
  });
}

test("Save As exports the local attachment if reception finishes while the chooser is open", async ({ browser, baseURL }) => {
  const peers = await pair(browser, baseURL!, ["desktop", "web"], "relay");
  const [a, b] = peers.pages;
  try {
    await auto(b);
    await b.evaluate(async () => {
      const w = window as any, e = w.engine, create = e.storage.createFileDestination.bind(e.storage);
      const gate = new Promise<void>(resolve => { w.finishReceive = resolve; });
      e.storage.createFileDestination = async (message: any) => {
        const file = await create(message);
        return { ...file, close: async () => { await gate; await file.close(); } };
      };
      w.showSaveFilePicker = async () => {
        w.pickerCalls = (w.pickerCalls ?? 0) + 1;
        await new Promise<void>(resolve => { w.confirmLocation = resolve; });
        return (await navigator.storage.getDirectory()).getFileHandle("chosen.txt", { create: true });
      };
      await w.render();
    });
    await a.evaluate(() => {
      const w = window as any;
      w.sending = w.engine.sendFiles([new File(["already here"], "race.txt")]);
    });
    const button = b.getByRole("button", { name: "另存为", exact: true });
    await expect(button.locator("svg")).toBeVisible();
    await expect(b.getByRole("log").getByRole("button", { name: "取消", exact: true }).locator("svg")).toBeVisible();
    await mkdir(resolve("../temp/screenshot"), { recursive: true });
    await b.screenshot({ path: resolve("../temp/screenshot/receive-save-as.png"), fullPage: true });
    await button.click();
    await b.evaluate(() => (window as any).finishReceive());
    await a.evaluate(() => (window as any).sending);
    await b.evaluate(() => (window as any).confirmLocation());
    await expect.poll(() => b.evaluate(async () => {
      try {
        const root = await navigator.storage.getDirectory();
        return (await (await root.getFileHandle("chosen.txt")).getFile()).text();
      } catch { return ""; }
    })).toBe("already here");
    expect(await b.evaluate(async () => {
      const w = window as any, m = w.engine.getSnapshot().messages.find((m: any) => m.fileName === "race.txt");
      return [w.pickerCalls, m.attachmentStorage, await (await w.engine.getAttachment(m.id)).text()];
    })).toEqual([1, "managed", "already here"]);
  } finally { await peers.close(); }
});

test("native cancellation wakes a stalled window and discards the local partial copy", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "web"], "relay"), [a, b] = p.pages;
  try {
    await auto(b);
    await b.evaluate(() => {
      const e = (window as any).engine, c = e.network.transport.channels.get(e.getSnapshot().activePeerId), send = c.send.bind(c);
      c.send = (data: string | ArrayBuffer) => { if (typeof data !== "string" || JSON.parse(data).type !== "file-progress") send(data); };
    });
    await a.evaluate(() => { (window as any).sending = (window as any).engine.sendFiles([new File([new Uint8Array(3 * 1024 * 1024)], "cancel-native.bin")]).catch(() => false); });
    await expect.poll(() => b.evaluate(() => { const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "cancel-native.bin"); return m ? e.getTransferredBytes(m.id) : 0; })).toBe(1024 * 1024);
    await a.evaluate(async () => { const e = (window as any).engine; await e.cancelTransfer(e.getSnapshot().messages.find((m: any) => m.fileName === "cancel-native.bin").id); await (window as any).sending; });
    expect(await a.evaluate(async () => { const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === "cancel-native.bin"); return { status: m.status, missing: !(await e.getAttachment(m.id)), cache: (await e.storage.getStorageInfo()).cacheUsage }; })).toEqual({ status: "failed", missing: true, cache: 0 });
  } finally { await p.close(); }
});

test("native sender waits for the browser's final save before delivery", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "web"], "rtc"), [a, b] = p.pages;
  try {
    await auto(b);
    await b.evaluate(() => {
      const store = (window as any).engine.storage, create = store.createFileDestination.bind(store);
      store.createFileDestination = async (...args: any[]) => {
        const destination = await create(...args);
        return { ...destination, close: async () => {
          (window as any).saving = true;
          await new Promise(resolve => { (window as any).finishSave = resolve; });
          await destination.close();
        } };
      };
    });
    await a.evaluate(() => { (window as any).sending = (window as any).engine.sendFiles([new File(["save me"], "save-native.txt")]); });
    await expect.poll(() => b.evaluate(() => (window as any).saving)).toBe(true);
    expect(await a.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === "save-native.txt")?.status)).toBe("sent");
    await b.evaluate(() => (window as any).finishSave());
    await a.evaluate(() => (window as any).sending);
    expect(await a.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === "save-native.txt")?.status)).toBe("delivered");
  } finally { await p.close(); }
});


test("native central socket authenticates with its first packet", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "web"], "relay", true), [a, b] = p.pages;
  try {
    await b.evaluate(() => (window as any).engine.sendText("authorized reply"));
    await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages.some((m: any) => m.text === "authorized reply" && m.status === "delivered"))).toBe(true);
  } finally { await p.close(); }
});


test("desktop sends to an idle browser over reverse-dialed WebTransport", async ({ browser, baseURL }) => {
  const p = await pair(browser, baseURL!, ["desktop", "web"], "webtransport-rtc", false, undefined, 0);
  try {
    const address = await p.pages[1].evaluate(() => {
      const e = (window as any).engine;
      return e.network.transport.channels.get(e.getSnapshot().activePeerId).connection.remoteAddr.toString();
    });
    expect(address).toContain("/webtransport/");
    await expect.poll(() => p.pages[1].evaluate(() => (window as any).engine.getSnapshot().messages.some(
      (message: any) => message.text === "ready" && message.status === "delivered",
    ))).toBe(true);
  } finally { await p.close(); }
});

for (const failure of ["unreachable", "wrong certificate", "unsupported"] as const) {
  test(`webtransport falls back to WebRTC when ${failure}`, async ({ browser, baseURL }) => {
    const p = await pair(browser, baseURL!, ["desktop", "web"], "webtransport-rtc", false, async (page, index) => {
      if (index !== 1) return;
      await page.addInitScript(failure => {
        if (failure === "unsupported") {
          Object.defineProperty(window, "WebTransport", {value: undefined});
          return;
        }
        const Original = window.WebTransport;
        window.WebTransport = class extends Original {
          constructor(url: string, options?: WebTransportOptions) {
            (window as any).attemptedWebTransport = true;
            const target = new URL(url);
            if (failure === "unreachable") {
              target.hostname = "127.0.0.1";
              // No listener on this UDP port. Exercise the dial timeout.
              target.port = "49201";
            } else {
              options = {serverCertificateHashes: [{algorithm: "sha-256", value: new Uint8Array(32)}]};
            }
            super(target.toString(), options);
          }
        };
      }, failure);
    });
    try {
      const result = await p.pages[1].evaluate(() => {
        const e = (window as any).engine;
        return {attempted: (window as any).attemptedWebTransport === true,
          address: e.network.transport.channels.get(e.getSnapshot().activePeerId).connection.remoteAddr.toString()};
      });
      expect(result.attempted).toBe(failure !== "unsupported");
      expect(result.address).toContain("/webrtc");
    } finally { await p.close(); }
  });
}
