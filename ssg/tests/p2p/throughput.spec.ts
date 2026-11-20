import { test, expect } from "@playwright/test";

for (const [sender, receiver] of [["web", "web"], ["native", "web"], ["web", "native"]]) {
  test(`${sender} to ${receiver}: sustained WebRTC transfer stays connected`, async ({ browser, baseURL }, info) => {
    const ac = await browser.newContext(), bc = await browser.newContext();
    const a = await ac.newPage(), b = await bc.newPage();
    try {
      for (const page of [a, b]) {
        await page.goto(`${baseURL}/tests/browser/p2p.html`);
      }
      await a.evaluate(kind => (window as any).start("A", kind, "rtc"), sender);
      await b.evaluate(kind => (window as any).start("B", kind, "rtc"), receiver);
      for (const page of [a, b]) {
        await expect.poll(() => page.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(1);
        await page.evaluate(async () => {
          const e = (window as any).engine;
          await e.selectPeer(e.getSnapshot().peers[0]);
          await e.updatePeerAutoAcceptFiles(e.getSnapshot().peers[0].id, true);
        });
      }
      await a.evaluate(() => (window as any).engine.sendText("ready"));
      for (const page of [a, b]) await page.evaluate(() => {
        const e = (window as any).engine;
        const channel = e.network.transport.channels.get(e.getSnapshot().activePeerId);
        (window as any).transferClosed = 0;
        channel.addEventListener("close", () => (window as any).transferClosed++);
      });
      const size = Number(process.env.P2P_TRANSFER_MIB || 32) * 1024 * 1024 + 17;
      const result = await a.evaluate(async size => {
        const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
        const e = (window as any).engine;
        const start = performance.now();
        await e.sendFiles([new File([bytes], "sustained.bin")]);
        await new Promise<void>(resolve => {
          const check = () => {
            if (e.getSnapshot().messages.find((m: any) => m.fileName === "sustained.bin")?.status === "delivered") {
              unsubscribe();
              resolve();
            }
          };
          const unsubscribe = e.subscribe(check);
          check();
        });
        return { seconds: (performance.now() - start) / 1000 };
      }, size);
      await expect.poll(() => a.evaluate(() => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === "sustained.bin")?.status), { timeout: 60000 }).toBe("delivered");
      expect(await b.evaluate(async size => {
        const e = (window as any).engine;
        const m = e.getSnapshot().messages.find((m: any) => m.fileName === "sustained.bin");
        const bytes = new Uint8Array(await (await e.storage.getAttachment(m.id)).arrayBuffer());
        return bytes.length === size && bytes.every((v, i) => v === i % 251);
      }, size)).toBe(true);
      for (const page of [a, b]) expect(await page.evaluate(() => (window as any).transferClosed)).toBe(0);
      const metrics = { sender, receiver, size, ...result, MiBps: size / 1024 / 1024 / result.seconds };
      console.log(JSON.stringify(metrics));
      await info.attach("throughput.json", { body: JSON.stringify(metrics), contentType: "application/json" });
    } catch (error) {
      for (const page of [a, b]) console.log(await page.evaluate(() => ({ snapshot: (window as any).engine?.getSnapshot(), logs: localStorage.getItem("hummingbird.v2.runtime-logs") })));
      throw error;
    } finally {
      await ac.close();
      await bc.close();
    }
  });
}
