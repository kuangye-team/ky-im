import { expect, test } from "@playwright/test";
import { openPeer, sendText, setProfile } from "./helpers";

test("发现服务断开时聊天继续，WebRTC 连接失败后重新建立通道", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN" })));
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  try {
    for (const page of pages) {
      await page.addInitScript(() => {
        const state = { sockets: [] as WebSocket[], peers: [] as RTCPeerConnection[] };
        (window as any).recoveryTest = state;
        const Socket = window.WebSocket;
        window.WebSocket = class extends Socket {
          constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols);
            if (new URL(url, location.href).pathname === "/api/ws") state.sockets.push(this); }
        };
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
          constructor(config?: RTCConfiguration) { super(config);
            if (config?.iceServers) state.peers.push(this); }
        };
      });
      await page.goto(baseURL!);
    }
    await setProfile(pages[0], "恢复测试甲"); await setProfile(pages[1], "恢复测试乙");
    await openPeer(pages[0], "恢复测试乙"); await openPeer(pages[1], "恢复测试甲");
    await sendText(pages[0], "断线前已连接");
    await expect(pages[1].getByRole("log")).toContainText("断线前已连接");
    const counts = await Promise.all(pages.map((p) => p.evaluate(() => (window as any).recoveryTest.peers.length)));
    await pages[0].evaluate(() => (window as any).recoveryTest.sockets.at(-1).close());
    await sendText(pages[0], "发现暂时中断，聊天继续");
    await expect(pages[1].getByRole("log")).toContainText("发现暂时中断，聊天继续");
    await expect.poll(() => pages[0].evaluate(() => (window as any).recoveryTest.sockets.at(-1).readyState)).toBe(1);
    expect(await Promise.all(pages.map((p) => p.evaluate(() => (window as any).recoveryTest.peers.length)))).toEqual(counts);

    await pages[0].evaluate(() => {
      const peers: RTCPeerConnection[] = (window as any).recoveryTest.peers;
      const pc = peers.find(peer => peer.connectionState === "connected")!;
      Object.defineProperty(pc, "connectionState", { configurable: true, value: "failed" });
      pc.dispatchEvent(new Event("connectionstatechange"));
      delete (pc as any).connectionState;
    });
    for (const [index, page] of pages.entries()) {
      await expect.poll(() => page.evaluate(before => {
        const peers: RTCPeerConnection[] = (window as any).recoveryTest.peers;
        return peers.slice(before).some(pc => pc.connectionState === "connected");
      }, counts[index])).toBe(true);
    }
    await sendText(pages[1], "恢复后可以继续发送");
    await expect(pages[0].getByRole("log")).toContainText("恢复后可以继续发送");
    await pages[0].screenshot({ path: "../temp/screenshot/network-recovery.png", animations: "disabled" });
  } finally { await Promise.all(contexts.map((c) => c.close())); }
});
