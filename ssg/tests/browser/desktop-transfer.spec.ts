import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { openPeer, setProfile } from "./helpers";

test("桌面存储先征求接收，再以 2 MiB 分块保存并通过真实直连发送", async ({ browser, baseURL }) => {
  const sender = await browser.newContext({ locale: "zh-CN" });
  const receiver = await browser.newContext({ locale: "zh-CN" });
  try {
    // Run the real desktop payload adapter with an in-memory native boundary;
    // Rust tests cover the actual SQLite/filesystem side of this IPC contract.
    await sender.route("**/src/core/storage.ts", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `${await response.text()}
import { DesktopStorageAdapter } from "/src/core/storage/desktop.ts";
const nativeCalls = [];
const payloads = new Map();
window.desktopTransferTest = { nativeCalls };
registerStorageAdapter("browser", () => {
  const history = new IndexedDBStorageAdapter();
  const native = new DesktopStorageAdapter(async (request) => {
    nativeCalls.push({ op: request.op, bytes: request.op === "write" ? request.data.byteLength : 0 });
    if (request.op === "begin") {
      payloads.set(request.id, { parts: [], size: request.size });
      return request.id;
    }
    const pending = payloads.get(request.token);
    if (request.op === "write") pending.parts.push(new Uint8Array(request.data));
    else if (request.op === "finish") {
      const blob = new Blob(pending.parts);
      if (blob.size !== pending.size) throw new Error("Incomplete local copy");
      await history.saveAttachment(request.token, blob);
      payloads.delete(request.token);
    } else if (request.op === "abort") payloads.delete(request.token);
    else throw new Error("Unexpected storage operation: " + request.op);
  });
  history.createFileDestination = (message) => native.createFileDestination(message);
  return history;
});` });
    });
    // Lower only the browser persistence boundary for the transfer exercise.
    // The first offer still carries the exact reported 600 MiB size.
    for (const context of [sender, receiver])
      await context.route("**/src/config.ts", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/MAX_FILE_SIZE = [^;]+/, "MAX_FILE_SIZE = 1048576");
        await route.fulfill({ response, body });
      });
    await sender.addInitScript(() => {
      const frames: number[] = [];
      Object.assign(window, { binaryFrameSizes: frames });
      const send = RTCDataChannel.prototype.send;
      RTCDataChannel.prototype.send = function (data) {
        if (data instanceof ArrayBuffer) frames.push(data.byteLength);
        return send.call(this, data);
      };
      document.addEventListener("change", (event) => {
        for (const file of Array.from((event.target as HTMLInputElement).files || [])) {
          if (file.name !== "600MiB.bin") continue;
          Object.defineProperty(file, "size", { value: 600 * 1024 ** 2 });
          file.slice = () => { throw new Error("Content read before acceptance"); };
        }
      }, true);
    });
    await receiver.addInitScript(() => {
      Object.defineProperty(window, "showSaveFilePicker", {
        configurable: true,
        value: async () => (await navigator.storage.getDirectory())
          .getFileHandle("desktop-received.bin", { create: true }),
      });
    });
    const alice = await sender.newPage();
    const bob = await receiver.newPage();
    await alice.goto(baseURL!);
    await setProfile(alice, "客户端发送方");
    await bob.goto(baseURL!);
    await setProfile(bob, "网页接收方");
    await openPeer(alice, "网页接收方");
    await openPeer(bob, "客户端发送方");
    const calls = () => alice.evaluate(() =>
      (window as unknown as { desktopTransferTest: { nativeCalls: { op: string; bytes: number }[] } }).desktopTransferTest.nativeCalls);
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "600MiB.bin", mimeType: "application/octet-stream", buffer: Buffer.from("metadata only"),
    });
    await expect(bob.getByRole("button", { name: "接收并保存", exact: true })).toBeVisible();
    await expect(alice.getByText("等待对方确认", { exact: true })).toBeVisible();
    expect(await calls()).toEqual([]);
    await bob.screenshot({ path: resolve("../temp/screenshot/desktop-600MiB-receive-request.png"), fullPage: true });
    await bob.getByRole("button", { name: "拒收", exact: true }).click();
    await expect(alice.getByText("发送失败", { exact: true })).toBeVisible();
    expect(await calls()).toEqual([]);

    const bytes = Buffer.alloc(4 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "并行保存.bin", mimeType: "application/octet-stream", buffer: bytes,
    });
    await bob.getByRole("button", { name: "接收并保存", exact: true }).click();
    await expect(alice.getByText("已送达", { exact: true })).toBeVisible();
    expect(await alice.evaluate(() =>
      (window as unknown as { binaryFrameSizes: number[] }).binaryFrameSizes))
      .toEqual([...Array(32).fill(128 * 1024 + 44), 17 + 44]);
    expect(await calls()).toEqual([
      { op: "begin", bytes: 0 },
      { op: "write", bytes: 2 * 1024 * 1024 },
      { op: "write", bytes: 2 * 1024 * 1024 },
      { op: "write", bytes: 17 },
      { op: "finish", bytes: 0 },
    ]);
    const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    const remote = await bob.evaluate(async () => {
      const file = await (await (await navigator.storage.getDirectory())
        .getFileHandle("desktop-received.bin")).getFile();
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
    });
    expect(remote).toEqual(expected);
    const local = await alice.evaluate(async () => {
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const store = new IndexedDBStorageAdapter();
      const file = (await store.getFiles()).find((message: { fileName?: string }) => message.fileName === "并行保存.bin");
      const blob = await store.getAttachment(file.id);
      return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())));
    });
    expect(local).toEqual(expected);
    await bob.screenshot({ path: resolve("../temp/screenshot/desktop-transfer-complete.png"), fullPage: true });
  } finally {
    await sender.close();
    await receiver.close();
  }
});
