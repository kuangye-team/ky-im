import { test, expect } from "@playwright/test";

for (const webFirst of [true, false]) {
  test(`idle WebTransport reverse dial, ${webFirst ? "web" : "desktop"} online first`, async ({browser, baseURL}) => {
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const [web, desktop] = await Promise.all(contexts.map(c => c.newPage()));
      let requestedDials = 0;
      for (const page of webFirst ? [web, desktop] : [desktop, web]) {
        let welcomed = false;
        page.on("websocket", ws => ws.on("framereceived", ({payload}) => {
          if (typeof payload !== "string") return;
          const packet = JSON.parse(payload);
          const message = packet.event?.type === "socket" && packet.event.state === "message"
            ? JSON.parse(packet.event.message) : packet;
          if (message.type === "welcome") welcomed = true;
          if (page === web && message.type === "signal" && message.data.dial === "connect") requestedDials++;
        }));
        await page.goto(`${baseURL}/tests/browser/p2p.html`);
        await page.evaluate(kind => (window as any).start(kind === "web" ? "A" : "B", kind, "webtransport-rtc"),
          page === web ? "web" : "desktop");
        await expect.poll(() => welcomed).toBe(true);
      }
      const connection = () => web.evaluate(() => {
        const engine = (window as any).engine;
        const peer = engine.getSnapshot().peers[0]?.id;
        const channel = engine.network.transport.channels.get(peer);
        if (channel?.readyState === "open") return {id: channel.connection.id, address: channel.connection.remoteAddr.toString()};
      });
      await expect.poll(connection).toMatchObject({address: expect.stringContaining("/webtransport/")});
      const original = (await connection())!;
      expect(await web.evaluate(() => (window as any).engine.getSnapshot().activePeerId)).toBeNull();
      expect(requestedDials).toBe(0);

      if (webFirst) {
        // Retire the idle business link without disconnecting either discovery session.
        await desktop.evaluate(() => {
          const engine = (window as any).engine;
          engine.connections.closeLink(engine.getSnapshot().peers[0].id, "idle");
        });
        await expect.poll(connection).toBeUndefined();
        await desktop.evaluate(async () => {
          const engine = (window as any).engine;
          await engine.selectPeer(engine.getSnapshot().peers[0]);
          await engine.sendText("reverse dial after idle");
        });
        await expect.poll(connection).toMatchObject({address: expect.stringContaining("/webtransport/")});
        expect((await connection())!.id).not.toBe(original.id);
        expect(requestedDials).toBe(1);
        await expect.poll(() => web.evaluate(async () => {
          const engine = (window as any).engine;
          return (await engine.storage.getMessages(engine.getSnapshot().peers[0].id)).some(m => m.text === "reverse dial after idle");
        })).toBe(true);
      } else {
        // Ask the RTC transport for a connection while the pinned WT carrier is still usable.
        const results = await web.evaluate(async () => {
          const engine = (window as any).engine;
          const peer = engine.getSnapshot().peers[0].id;
          const bridge = engine.network.transport.bridge;
          const address = bridge.addresses(peer).find(a => a.toString().includes("/webrtc"));
          const openRtc = async () => {
            const raw = await bridge.dial("rtc", address, AbortSignal.timeout(20000));
            const id = bridge.sessionByTimeline.get(raw.timeline);
            const source = bridge.rtc.get(id).source.id;
            await raw.close();
            return {id, source};
          };
          const direct = await openRtc();
          let failedSession: string | undefined;
          bridge.webTransportExchange = () => async offer => {
            failedSession = offer.session;
            throw new Error("RTC signaling stream closed");
          };
          const fallback = await openRtc();
          return {direct, failedSession, fallback};
        });
        expect(results.direct.source).toBe("authenticated-stream");
        expect(results.failedSession).toBeTruthy();
        expect(results.fallback.source).toBe("s0");
        expect(results.fallback.id).not.toBe(results.failedSession);
        expect((await connection())!.id).toBe(original.id);
      }
    } finally { await Promise.all(contexts.map(c => c.close())); }
  });
}

test("unreachable background addresses retry locally until the desktop requests a connection", async ({browser, baseURL}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [web, desktop] = await Promise.all(contexts.map(c => c.newPage()));
    await web.addInitScript(() => {
      const Original = WebTransport;
      (window as any).directAttempts = 0;
      window.WebTransport = class extends Original {
        constructor() {
          (window as any).directAttempts++;
          throw new Error("Unreachable desktop address");
        }
      };
      (window as any).centerOffers = 0;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string" && JSON.parse(data).data?.description?.type === "offer")
          (window as any).centerOffers++;
        return send.call(this, data);
      };
    });
    for (const page of [web, desktop]) {
      await page.goto(`${baseURL}/tests/browser/p2p.html`);
      await page.evaluate(kind => (window as any).start(kind === "web" ? "A" : "B", kind, "webtransport-rtc"),
        page === web ? "web" : "desktop");
    }
    await expect.poll(() => web.evaluate(() => (window as any).directAttempts)).toBeGreaterThan(0);
    await expect.poll(() => web.evaluate(() => {
      const e = (window as any).engine;
      return e.network.transport.warmupRetries.get(e.getSnapshot().peers[0]?.id)?.delay;
    }), {timeout: 25000}).toBeGreaterThanOrEqual(10000);
    expect(await web.evaluate(() => (window as any).centerOffers)).toBe(0);
    await desktop.evaluate(async () => {
      const e = (window as any).engine;
      await e.selectPeer(e.getSnapshot().peers[0]);
      await e.sendText("use fallback");
    });
    expect(await web.evaluate(() => (window as any).centerOffers)).toBe(1);
    await expect.poll(() => web.evaluate(async () => {
      const e = (window as any).engine;
      return (await e.storage.getMessages(e.getSnapshot().peers[0].id)).some(m => m.text === "use fallback");
    })).toBe(true);
  } finally { await Promise.all(contexts.map(c => c.close())); }
});
