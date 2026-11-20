import { expect, test } from "@playwright/test";

test("a late outgoing ICE failure leaves the incoming connection, file and receipts intact", async ({browser, baseURL}) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [a, b] = await Promise.all(contexts.map(c => c.newPage()));
    for (const [i, page] of [a,b].entries()) {
      await page.goto(`${baseURL}/tests/browser/p2p.html`);
      await page.evaluate(i => (window as any).start(i ? "B" : "A", "web", "rtc"), i);
    }
    await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(1);
    await a.evaluate(async () => {
      const host = window as any;
      const engine = host.engine;
      const bridge = engine.network.transport.bridge;
      const gather = bridge.gathered.bind(bridge);
      bridge.gathered = (rtc: {inbound: boolean}) => rtc.inbound ? gather(rtc) :
        new Promise((_,reject) => { host.expireDial = () => reject(new Error("late ICE timeout")); });
      await engine.selectPeer(engine.getSnapshot().peers[0]);
    });
    await expect.poll(() => a.evaluate(() => typeof (window as any).expireDial)).toBe("function");
    await b.evaluate(async () => {
      const engine = (window as any).engine;
      const peer = engine.getSnapshot().peers[0];
      await engine.selectPeer(peer);
      await engine.updatePeerAutoAcceptFiles(peer.id, true);
    });
    const id = () => a.evaluate(() => {
      const engine = (window as any).engine;
      const channel = engine.network.transport.channels.get(engine.getSnapshot().activePeerId);
      return channel?.readyState === "open" ? channel.connectionId : null;
    });
    await expect.poll(id).toBeTruthy();
    const original = await id();
    await a.evaluate(() => (window as any).engine.sendText("before timeout"));
    await b.evaluate(() => {
      const host = window as any;
      const channel = host.engine.network.transport.channels.get(host.engine.getSnapshot().activePeerId);
      const receive = channel.onmessage;
      channel.onmessage = (event: {data: unknown}) => {
        if (event.data instanceof ArrayBuffer) {
          channel.onmessage = receive;
          host.resumeFile = () => receive(event);
        } else receive(event);
      };
    });
    await a.evaluate(() => {
      const host = window as any;
      host.sending = host.engine.sendFiles([new File([new Uint8Array(700000).fill(37)], "race.bin")]);
    });
    await expect.poll(() => b.evaluate(() => typeof (window as any).resumeFile)).toBe("function");
    await a.evaluate(() => (window as any).expireDial());
    await expect.poll(() => a.evaluate(() => (localStorage.getItem("hummingbird.v2.runtime-logs") ?? "").includes("late ICE timeout"))).toBe(true);
    expect(await id()).toBe(original);
    await b.evaluate(() => (window as any).resumeFile());
    await a.evaluate(() => (window as any).sending);
    await a.evaluate(async () => {
      const engine = (window as any).engine;
      const channel = engine.network.transport.channels.get(engine.getSnapshot().activePeerId);
      await channel.probe(AbortSignal.timeout(8000));
      await engine.sendText("after timeout");
      await engine.sendFiles([new File([Uint8Array.of(19)], "second.bin")]);
    });
    await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages.filter((m: any) => m.status === "delivered").length)).toBe(4);
    expect(await b.evaluate(async () => {
      const engine = (window as any).engine;
      const file = engine.getSnapshot().messages.find((m: any) => m.fileName === "race.bin");
      const bytes = new Uint8Array(await (await engine.getAttachment(file.id)).arrayBuffer());
      return bytes.length === 700000 && bytes.every(v => v === 37);
    })).toBe(true);
    expect(await id()).toBe(original);
  } finally {
    await Promise.all(contexts.map(c => c.close()));
  }
});
