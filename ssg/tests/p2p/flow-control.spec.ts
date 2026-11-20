import { test, expect } from "@playwright/test";

for (const mode of ["rtc", "relay"]) {
  test(`native ${mode}: a slow file consumer keeps receive credit bounded and control responsive`, async ({ browser, baseURL }) => {
    const ac = await browser.newContext(), bc = await browser.newContext();
    const a = await ac.newPage(), b = await bc.newPage();
    const errors: string[] = [];
    try {
      for (const page of [a, b]) {
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${baseURL}/tests/browser/p2p.html`);
      }
      await a.evaluate(mode => (window as any).start("A", "web", mode), mode);
      await b.evaluate(mode => (window as any).start("B", "native", mode), mode);
      for (const page of [a, b]) {
        await expect.poll(() => page.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(1);
        await page.evaluate(async () => {
          const e = (window as any).engine;
          await e.selectPeer(e.getSnapshot().peers[0]);
          await e.updatePeerAutoAcceptFiles(e.getSnapshot().peers[0].id, true);
        });
      }
      await a.evaluate(() => (window as any).engine.sendText("ready"));
      await b.evaluate(() => {
        const e = (window as any).engine, channel = e.network.transport.channels.get(e.getSnapshot().activePeerId);
        const receive = channel.onmessage;
        const state = (window as any).slow = { pending: 0, peak: 0, closed: 0 };
        let delivery = Promise.resolve();
        channel.addEventListener("close", () => state.closed++);
        channel.onmessage = (event: any) => {
          if ((window as any).priorityControl(event.data)) return receive(event);
          const binary = event.data instanceof ArrayBuffer;
          if (binary) { state.pending++; state.peak = Math.max(state.peak, state.pending); }
          // Delay file boundaries too: letting file-end overtake delayed bytes would corrupt the test transport.
          delivery = delivery.then(async () => {
            await new Promise(resolve => setTimeout(resolve, 40));
            if (binary) state.pending--;
            receive(event);
          });
        };
      });
      await a.evaluate(() => {
        const e = (window as any).engine;
        (window as any).sending = e.sendFiles([
          new File([new Uint8Array(8 * 1048576 + 17).fill(29)], "slow.bin"),
          new File([new Uint8Array(8 * 1048576 + 37).fill(73)], "concurrent.bin"),
        ]);
      });
      await expect.poll(() => b.evaluate(() => (window as any).slow.peak)).toBeGreaterThan(1);
      await a.evaluate(() => (window as any).engine.sendText("control during slow transfer"));
      await expect.poll(() => b.evaluate(() => (window as any).engine.getSnapshot().messages.some((m: any) => m.text === "control during slow transfer"))).toBe(true);
      expect(await a.evaluate(() => (window as any).sending)).toBe(true);
      for (const [name, value, size] of [["slow.bin", 29, 8 * 1048576 + 17], ["concurrent.bin", 73, 8 * 1048576 + 37]] as const) {
        await expect.poll(() => a.evaluate(name => (window as any).engine.getSnapshot().messages.find((m: any) => m.fileName === name)?.status, name)).toBe("delivered");
        expect(await b.evaluate(async ({ name, value, size }) => {
          const e = (window as any).engine, m = e.getSnapshot().messages.find((m: any) => m.fileName === name);
          const data = new Uint8Array(await (await e.storage.getAttachment(m.id)).arrayBuffer());
          return data.length === size && data.every(byte => byte === value);
        }, { name, value, size })).toBe(true);
      }
      const state = await b.evaluate(() => (window as any).slow);
      expect(state.peak).toBeLessThanOrEqual(4);
      expect(state.closed).toBe(0);
      expect(errors).toEqual([]);
    } catch (error) {
      for (const page of [a, b]) console.log(await page.evaluate(() => ({
        logs: JSON.parse(localStorage.getItem("hummingbird.v2.runtime-logs") || "[]").slice(-20).map((entry: any) => ({ message: entry.message, detail: entry.detail })),
        events: (window as any).events?.slice(-15),
      })));
      throw error;
    } finally {
      await ac.close(); await bc.close();
    }
  });
}
