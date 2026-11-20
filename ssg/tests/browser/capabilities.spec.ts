import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import capabilities from "../../../shared/capabilities.json" with { type: "json" };
import { readFile } from "node:fs/promises";
import { enableAutoAcceptFiles, openPeer, sendText, setProfile } from "./helpers";

test("服务器缺少必要能力时显示通用提示和按需原因", async ({ page }) => {
  await page.clock.install();
  const sent: string[] = [];
  await page.routeWebSocket(url => url.pathname === "/api/ws", socket => {
    socket.onMessage(raw => {
      const packet = JSON.parse(String(raw)); sent.push(packet.type);
      if (packet.type === "auth") socket.send(JSON.stringify({ type: "capabilities", version: "0.1.0", capabilities: [capabilities.query] }));
    });
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("暂时无法连接");
  await page.getByRole("button", { name: "查看连接失败原因" }).click();
  const dialog = page.getByRole("dialog", { name: "暂时无法连接" });
  await expect(dialog).toContainText("当前服务器可能需要更新");
  await expect(dialog).toContainText("这个服务器可能不支持当前应用");
  await expect(dialog).not.toContainText("对方可能使用了修改版");
  expect(sent).not.toContain("join");
  await page.screenshot({ path: resolve(import.meta.dirname, "../../../temp/screenshot/capabilities-server-help.png"), fullPage: true, animations: "disabled" });
  await page.clock.fastForward(4500);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(dialog).toBeVisible();
});

test("当前能力协商支持网页之间聊天并发布版本信息", async ({ browser, baseURL, request }) => {
  const info = await (await request.get("/api/capabilities")).json();
  expect(info.version).toBeTruthy();
  expect(info.capabilities).toContain(capabilities.signaling);
  expect(info.capabilities).not.toContain(capabilities.relay);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN", baseURL })));
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await a.goto("/"); await setProfile(a, "能力协商甲");
    await b.goto("/"); await setProfile(b, "能力协商乙");
    await openPeer(a, "能力协商乙"); await openPeer(b, "能力协商甲");
    await sendText(a, "双方能力确认后继续分享");
    await expect(b.getByRole("log")).toContainText("双方能力确认后继续分享");
    await b.screenshot({ path: resolve(import.meta.dirname, "../../../temp/screenshot/capabilities-chat.png"), fullPage: true, animations: "disabled" });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("对方缺少必要能力时仅显示对方相关原因", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN", baseURL })));
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    await a.routeWebSocket(url => url.pathname === "/api/ws", socket => {
      const server = socket.connectToServer();
      server.onMessage(raw => {
        if (typeof raw !== "string") { socket.send(raw); return; }
        const packet = JSON.parse(raw);
        const removeChat = (peer: { capabilities?: string[] }) => {
          if (Array.isArray(peer?.capabilities)) peer.capabilities = peer.capabilities.filter(cap => cap !== capabilities.chat);
        };
        if (Array.isArray(packet.peers)) packet.peers.forEach(removeChat);
        if (packet.peer) removeChat(packet.peer);
        socket.send(JSON.stringify(packet));
      });
    });
    await b.goto("/");
    const peerName = await b.locator(".my-profile strong").innerText();
    await a.goto("/");
    await openPeer(a, peerName);
    await a.getByRole("button", { name: "查看连接失败原因" }).click();
    const dialog = a.getByRole("dialog", { name: "暂时无法连接" });
    await expect(dialog).toContainText("请让对方更新应用后重试");
    await expect(dialog).toContainText("对方可能使用了修改版应用");
    await expect(dialog).not.toContainText("当前服务器");
    await a.screenshot({ path: resolve(import.meta.dirname, "../../../temp/screenshot/capabilities-peer-help.png"), fullPage: true, animations: "disabled" });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});

test("两个网页按当前能力向已保存的联系人发送文本和文件", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN", baseURL })));
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    const negotiation: { session: string; kind: string; includesCandidates: boolean }[] = [];
    a.on("websocket", socket => {
      if (new URL(socket.url()).pathname !== "/api/ws") return;
      const record = ({ payload }: { payload: string | Buffer }) => {
        if (typeof payload !== "string") return;
        const packet = JSON.parse(payload);
        if (packet.type !== "signal" || !packet.data?.session) return;
        const { session, description } = packet.data;
        negotiation.push({ session, kind: description?.type ?? "other",
          includesCandidates: /^a=candidate:/m.test(description?.sdp ?? "") });
      };
      socket.on("framesent", record);
      socket.on("framereceived", record);
    });
    await b.goto("/");
    await setProfile(b, "网页接收方");
    const current = await b.evaluate(async () => {
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const store = new IndexedDBStorageAdapter();
      try { return await store.getProfile(); } finally { await store.close(); }
    });
    await a.goto("/api/capabilities");
    await a.evaluate(async ({ profile, webrtc, file }) => {
      const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
      const store = new IndexedDBStorageAdapter();
      try {
        await store.savePeerProfile({ ...profile, revision: profile.revision - 1,
          capabilities: profile.capabilities.filter((cap: string) => cap !== webrtc && cap !== file) });
      } finally { await store.close(); }
    }, { profile: current, webrtc: capabilities.webrtc, file: capabilities.file });
    await a.goto("/");
    const sender = await a.locator(".my-profile strong").innerText();
    const firstSendAt = performance.now();
    await openPeer(a, "网页接收方");
    await sendText(a, "重新上线后的第一条消息");
    await expect(a.getByRole("log").getByText("已送达", { exact: true })).toBeVisible();
    await openPeer(b, sender);
    await expect(b.getByRole("log")).toContainText("重新上线后的第一条消息");
    const firstDeliveryMs = Math.round(performance.now() - firstSendAt);
    await sendText(b, "收到，回给你");
    await expect(a.getByRole("log")).toContainText("收到，回给你");
    await enableAutoAcceptFiles(b);
    const contents = Buffer.from("两端逐字节核对。".repeat(16384));
    const fileStart = performance.now();
    await a.getByLabel("选择文件", { exact: true }).setInputFiles({ name: "消息.txt", mimeType: "text/plain", buffer: contents });
    const download = b.waitForEvent("download");
    await b.getByRole("button", { name: "下载 消息.txt", exact: true }).click();
    expect(await readFile((await (await download).path())!)).toEqual(contents);
    await expect(a.getByRole("log").getByText("已送达", { exact: true })).toHaveCount(2);
    expect(negotiation.map(frame => frame.kind)).toEqual(["offer", "answer"]);
    expect(negotiation[1].session).toBe(negotiation[0].session);
    expect(negotiation.every(frame => frame.includesCandidates)).toBe(true);
    await test.info().attach("delivery-timing", { contentType: "application/json",
      body: JSON.stringify({ firstDeliveryMs, fileAndDownloadMs: Math.round(performance.now() - fileStart), fileBytes: contents.length }) });
    await a.screenshot({ path: resolve(import.meta.dirname, "../../../temp/screenshot/web-chat-reconnect.png") });
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
