import { expect, test } from "@playwright/test";

for (const kinds of [["web", "web"], ["desktop", "web"], ["web", "desktop"], ["desktop", "desktop"]]) {
  test(`${kinds.join(" → ")}: standard probes return RTT without application messages`, async ({ browser, baseURL }) => {
    const contexts = await Promise.all(kinds.map(() => browser.newContext()));
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    try {
      for (const [index, page] of pages.entries()) {
        await page.goto(`${baseURL}/tests/browser/p2p.html`);
        await page.evaluate(({ kind, index }) => (window as any).start(`Probe ${index}`, kind, "rtc"), { kind: kinds[index], index });
      }
      for (const page of pages) {
        await expect.poll(() => page.evaluate(() => (window as any).engine.getSnapshot().peers.length)).toBe(1);
        await page.evaluate(() => {
          const engine = (window as any).engine;
          return engine.selectPeer(engine.getSnapshot().peers[0]);
        });
      }
      await pages[0].evaluate(() => (window as any).engine.transfers.sendText("ready"));
      await expect.poll(() => pages[0].evaluate(() => (window as any).engine.getSnapshot().messages[0]?.status)).toBe("delivered");
      for (const page of pages) await page.evaluate(() => {
        const e = (window as any).engine;
        const channel = e.network.transport.channels.get(e.getSnapshot().activePeerId);
        const answered = channel.onpinganswered;
        (window as any).answeredCount = 0;
        channel.onpinganswered = (at: number) => {
          (window as any).answeredCount++;
          answered(at);
        };
      });
      const results = await Promise.all(pages.map(page => page.evaluate(async () => {
        const engine = (window as any).engine;
        const channel = engine.network.transport.channels.get(engine.getSnapshot().activePeerId);
        const frames: unknown[] = [];
        const send = channel.send.bind(channel);
        channel.send = (data: unknown) => { frames.push(data); send(data); };
        const health = await channel.probe(AbortSignal.timeout(channel.probeTimeoutMs ?? 8000));
        return { ...health, frames };
      })));
      for (const result of results) {
        expect(Number.isFinite(result.roundTripMs)).toBe(true);
        expect(result.roundTripMs).toBeGreaterThanOrEqual(0);
        expect(result.ageMs).toBeGreaterThanOrEqual(0);
        expect(result.ageMs).toBeLessThan(8000);
        expect(result.frames).toEqual([]);
      }
      for (const page of pages)
        await expect.poll(() => page.evaluate(() => (window as any).answeredCount)).toBeGreaterThan(0);
    } finally {
      await Promise.all(contexts.map(context => context.close()));
    }
  });
}
