import { expect, test } from "@playwright/test";
import { openPeer, sendText, setProfile, enableAutoAcceptFiles } from "./helpers";

test("双向文件等待磁盘时仍可聊天和取消，控制消息使用独立通道", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN", baseURL })));
  try {
    for (const context of contexts) {
      await context.route("**/src/core/storage.ts", async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: `${await response.text()}
window.slowTransfer = { pending: [], writes: 0, aborted: 0, frames: [] };
registerStorageAdapter("browser", () => {
  const store = new IndexedDBStorageAdapter();
  store.createFileDestination = async () => ({
    write: async () => { window.slowTransfer.writes++; await new Promise(resolve => window.slowTransfer.pending.push(resolve)); },
    close: async () => {},
    abort: async () => { window.slowTransfer.aborted++; }
  });
  return store;
});` });
      });
    }
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    await a.goto("/"); await setProfile(a, "双向传输甲");
    await b.goto("/"); await setProfile(b, "双向传输乙");
    for (const page of [a, b]) {
      await page.evaluate(async () => {
        const { ProtocolChannel } = await import("/src/core/network/libp2p/channel.ts");
        const attach = ProtocolChannel.prototype.attach;
        ProtocolChannel.prototype.attach = function (protocol, stream, connection) {
          const send = stream.send.bind(stream);
          stream.send = (frame) => {
            // Application frames are visible here before libp2p encrypts the stream.
            if (frame instanceof Uint8Array && frame[4] === 1) {
              const { type } = JSON.parse(new TextDecoder().decode(frame.subarray(5)));
              (window as any).slowTransfer.frames.push({ protocol, type });
            }
            return send(frame);
          };
          return attach.call(this, protocol, stream, connection);
        };
      });
    }
    await openPeer(a, "双向传输乙"); await openPeer(b, "双向传输甲");
    await enableAutoAcceptFiles(a); await enableAutoAcceptFiles(b);
    for (const [page, name] of [[a, "甲的文件.bin"], [b, "乙的文件.bin"]] as const)
      await page.getByLabel("选择文件", { exact: true }).setInputFiles({ name, mimeType: "application/octet-stream", buffer: Buffer.alloc(4 * 1024 * 1024, 17) });
    for (const page of [a, b]) await expect.poll(() => page.evaluate(() => (window as any).slowTransfer.writes)).toBeGreaterThanOrEqual(2);
    await sendText(a, "文件还在保存，聊天可以继续");
    await expect(b.getByRole("log")).toContainText("文件还在保存，聊天可以继续");
    await sendText(b, "双向传输也能及时回复");
    await expect(a.getByRole("log")).toContainText("双向传输也能及时回复");
    await a.getByRole("log").getByRole("button", { name: "取消", exact: true }).first().click();
    for (const page of [a, b]) await expect.poll(() => page.evaluate(() => (window as any).slowTransfer.aborted)).toBeGreaterThan(0);
    for (const page of [a, b]) {
      const frames = await page.evaluate(() => (window as any).slowTransfer.frames as { protocol: string; type: string }[]);
      for (const type of ["text", "file-accept", "ack"]) {
        expect(frames).toContainEqual({ type, protocol: "/hummingbird/chat/2.0.0" });
      }
      expect(frames).toContainEqual({ type: "file-start", protocol: "/hummingbird/file/2.0.0" });
      await page.evaluate(() => { for (const release of (window as any).slowTransfer.pending.splice(0)) release(); });
    }
    await a.screenshot({ path: "../temp/screenshot/split-transfer-slow-disk.png", fullPage: true });
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});
