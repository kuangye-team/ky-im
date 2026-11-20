import { test, expect } from "@playwright/test";
import { createConnection, createServer, type Socket, type AddressInfo } from "node:net";
import { once } from "node:events";

for (const mode of ["rtc", "relay"] as const) {
  test(`desktop ${mode} after the signaling server disconnects`, async ({ browser, baseURL }) => {
    // Cut the real Rust WebSockets and keep reconnections out for the rest of the test.
    const sockets = new Set<Socket>();
    const proxy = createServer(client => {
      const upstream = createConnection(Number(process.env.PLAYWRIGHT_API_PORT || 4311), "127.0.0.1");
      sockets.add(client);
      client.on("close", () => { sockets.delete(client); upstream.destroy(); });
      upstream.on("close", () => client.destroy());
      client.on("error", () => client.destroy());
      upstream.on("error", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = new URL("/tests/browser/p2p.html", baseURL);
    url.searchParams.set("server", `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/api/ws`);
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const pages = await Promise.all(contexts.map(context => context.newPage()));
      for (const [index, page] of pages.entries()) {
        await page.goto(url.href);
        await page.evaluate(args => (window as any).start(args.name, "desktop", args.mode), { name: index ? "B" : "A", mode });
      }
      const [a, b] = pages;
      await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(1);
      await a.evaluate(async () => {
        const e = (window as any).engine;
        await e.selectPeer(e.getSnapshot().peers[0]);
        await e.sendText("before disconnect");
      });
      const lastStatus = () => a.evaluate(() => (window as any).engine.getSnapshot().messages.at(-1)?.status);
      await expect.poll(lastStatus).toBe("delivered");
      const connectionId = () => a.evaluate(() => {
        const e = (window as any).engine;
        return e.network.transport.channels.get(e.getSnapshot().activePeerId)?.connectionId;
      });
      const originalId = await connectionId();
      expect(originalId).toBeTruthy();
      expect(sockets.size).toBe(2);
      proxy.close();
      for (const socket of sockets) socket.destroy();
      for (const page of pages)
        await expect.poll(() => page.evaluate(() => (window as any).events.some((e: any) =>
          e.type === "socket" && e.state === "close"))).toBe(true);
      if (mode === "rtc") {
        expect(await a.evaluate(() => (window as any).engine.sendText("after disconnect"))).toBe(true);
        await expect.poll(lastStatus).toBe("delivered");
        expect(await connectionId()).toBe(originalId);
        await a.evaluate(() => (window as any).engine.setAvailability("offline"));
      }
      await expect.poll(() => b.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(0);
    } finally {
      if (proxy.listening) proxy.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(contexts.map(context => context.close()));
    }
  });
}

test("a failed WebRTC dial releases its resources while libp2p connects over an allowed relay", async ({
  browser,
  baseURL,
}) => {
  const ac = await browser.newContext(),
    bc = await browser.newContext();
  const a = await ac.newPage(),
    b = await bc.newPage();
  const errors: string[] = [];
  try {
    for (const page of [a, b]) {
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        RTCPeerConnection.prototype.createOffer = () =>
          Promise.reject(new Error("Test: WebRTC unavailable"));
      });
      await page.goto(`${baseURL}/tests/browser/p2p.html`);
    }
    await a.evaluate(() => (window as any).start("A", "web", "mixed"));
    await b.evaluate(() => (window as any).start("B", "native", "mixed"));
    await expect
      .poll(() =>
        a.evaluate(() => (window as any).engine.getSnapshot().peers.length),
      )
      .toBe(1);
    await a.evaluate(async () => {
      const e = (window as any).engine;
      await e.selectPeer(e.getSnapshot().peers[0]);
      await e.sendText("relay survives failed WebRTC");
    });
    await expect
      .poll(() =>
        a.evaluate(
          () => (window as any).engine.getSnapshot().messages[0]?.status,
        ),
      )
      .toBe("delivered");
    expect(
      await a.evaluate(
        () => (window as any).engine.network.transport.bridge.rtc.size,
      ),
    ).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await ac.close();
    await bc.close();
  }
});
