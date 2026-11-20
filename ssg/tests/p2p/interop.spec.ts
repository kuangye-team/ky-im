import { test, expect } from "@playwright/test";
test("mDNS announces number changes and a restarted desktop with the same PeerId", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [a, b] = await Promise.all(contexts.map(context => context.newPage()));
    for (const [index, page] of [a, b].entries()) {
      await page.goto(`${baseURL}/tests/browser/p2p.html`);
      await page.evaluate(name => (window as any).start(name, "desktop", "mdns"), index ? "B" : "A");
    }
    const id = await b.evaluate(() => (window as any).engine.getSnapshot().profile.id);
    const joined = () => a.evaluate(id => (window as any).events.some((e: any) =>
      e.type === "peer" && e.source === "mdns" && e.profile.id === id && e.joined), id);
    await expect.poll(joined).toBe(true);
    const number = await b.evaluate(async () => {
      const engine = (window as any).engine;
      await engine.updateProfile({ name: "北岸工作室" });
      await engine.refreshNumericId();
      return engine.getSnapshot().profile.numericId;
    });
    await expect.poll(() => a.evaluate(({id, number}) => (window as any).events.some((event: any) =>
      event.type === "peer" && event.source === "mdns" && event.profile.id === id &&
      event.profile.numericId === number && event.profile.name === "北岸工作室" && !event.joined), {id, number})).toBe(true);
    await a.evaluate(() => { (window as any).events.length = 0; });
    await b.reload();
    await b.evaluate(() => (window as any).start("B", "desktop", "mdns"));
    expect(await b.evaluate(() => (window as any).engine.getSnapshot().profile.id)).toBe(id);
    await expect.poll(joined).toBe(true);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

for (const [aKind, bKind, mode] of [
  ["web", "native", "relay"],
  ["native", "web", "relay"],
  ["web", "native", "rtc"],
  ["native", "web", "rtc"],
  ["native", "native", "tcp"],
  ["native", "native", "quic"],
  ["native", "native", "mdns"],
  ["desktop", "desktop", "mdns-rtc"],
  ["desktop", "desktop", "mixed"],
  ["desktop", "desktop", "rtc"],
  ["desktop", "desktop", "fallback"],
  ...(process.env.P2P_TURN
    ? [
        ["web", "web", "turn"],
        ["web", "native", "turn"],
        ["native", "web", "turn"],
      ]
    : []),
]) {
  test(`${aKind} → ${bKind} ${mode}: identity, streams, profile and file`, async ({
    browser,
    baseURL,
  }) => {
    const ac = await browser.newContext(),
      bc = await browser.newContext(),
      a = await ac.newPage(),
      b = await bc.newPage();
    try {
      if (mode === "turn")
        for (const context of [ac, bc])
          await context.addInitScript(() => {
            const Original = RTCPeerConnection;
            window.RTCPeerConnection = class extends Original {
              constructor(config?: RTCConfiguration) {
                super({ ...config, iceTransportPolicy: "relay" });
              }
            };
          });
      for (const page of [a, b]) {
        page.on("pageerror", (error) => console.error(error.message));
        const url = new URL("/tests/browser/p2p.html", baseURL);
        if (process.env.P2P_WORKER) url.searchParams.set("server", "ws://127.0.0.1:4314/api/ws");
        if (mode === "turn" && process.env.P2P_NATIVE_TURN) url.searchParams.set("nativeTurn", "1");
        await page.goto(url.href);
      }
      await a.evaluate(
        async ({ kind, mode }) => {
          await (window as any).start("A", kind, mode);
        },
        { kind: aKind, mode },
      );
      await b.evaluate(
        async ({ kind, mode }) => {
          await (window as any).start("B", kind, mode);
        },
        { kind: bKind, mode },
      );
      await expect
        .poll(() =>
          a.evaluate(() => (window as any).engine.getSnapshot().peers.length),
        )
        .toBe(1);
      await expect
        .poll(() =>
          b.evaluate(() => (window as any).engine.getSnapshot().peers.length),
        )
        .toBe(1);
      await a.evaluate(async () => {
        const e = (window as any).engine;
        await e.selectPeer(e.getSnapshot().peers[0]);
      });
      await a.evaluate(() =>
        (window as any).engine.sendText("hello authenticated peer"),
      );
      await expect
        .poll(() =>
          a.evaluate(
            () =>
              (window as any).engine
                .getSnapshot()
                .messages.find(
                  (m: any) => m.text === "hello authenticated peer",
                )?.status,
          ),
        )
        .toBe("delivered");
      await b.evaluate(async () => {
        const e = (window as any).engine;
        await e.selectPeer(e.getSnapshot().peers[0]);
        await e.updatePeerAutoAcceptFiles(e.getSnapshot().peers[0].id, true);
      });
      await expect
        .poll(() =>
          b.evaluate(() =>
            (window as any).engine
              .getSnapshot()
              .messages.some((m: any) => m.text === "hello authenticated peer"),
          ),
        )
        .toBe(true);
      await b.evaluate(() => (window as any).engine.sendText("reply"));
      await expect
        .poll(() =>
          a.evaluate(() =>
            (window as any).engine
              .getSnapshot()
              .messages.some((m: any) => m.text === "reply"),
          ),
        )
        .toBe(true);
      if (["tcp", "quic"].includes(mode))
        expect(
          await a.evaluate(() =>
            ((window as any).events as any[])
              .filter((e) => e.type === "connected")
              .map((e) => e.address),
          ),
        ).toEqual(
          expect.arrayContaining([
            expect.stringContaining(mode === "tcp" ? "/tcp/" : "/quic-v1"),
          ]),
        );
      if (mode === "turn")
        expect(
          await a.evaluate(async () => {
            const t = (window as any).engine.network.transport,
              bridge = t.central ?? t.bridge;
            for (const rtc of bridge.rtc.values()) {
              const stats = await rtc.pc.getStats();
              for (const stat of stats.values())
                if (
                  stat.type === "candidate-pair" &&
                  stat.state === "succeeded" &&
                  stat.nominated &&
                  stats.get(stat.localCandidateId)?.candidateType === "relay"
                )
                  return true;
            }
            return false;
          }),
        ).toBe(true);
      await a.evaluate(() =>
        (window as any).engine.updateProfile({ name: "A updated" }),
      );
      await expect
        .poll(() =>
          b.evaluate(() => (window as any).engine.getSnapshot().peers[0].name),
        )
        .toBe("A updated");
      await a.evaluate(async () => {
        const bytes = Uint8Array.from(
          { length: 512 * 1024 + 17 },
          (_, i) => i % 251,
        );
        await (window as any).engine.sendFiles([
          new File([bytes], "bytes.bin"),
        ]);
      });
      await expect
        .poll(() =>
          a.evaluate(
            () =>
              (window as any).engine
                .getSnapshot()
                .messages.find((m: any) => m.fileName === "bytes.bin")?.status,
          ),
        )
        .toBe("delivered");
      expect(
        await b.evaluate(async () => {
          const e = (window as any).engine,
            m = e
              .getSnapshot()
              .messages.find((m: any) => m.fileName === "bytes.bin");
          const bytes = new Uint8Array(
            await (await e.storage.getAttachment(m.id)).arrayBuffer(),
          );
          return (
            bytes.length === 512 * 1024 + 17 &&
            bytes.every((v, i) => v === i % 251)
          );
        }),
      ).toBe(true);
      if (mode === "fallback") {
        const paths = await a.evaluate(() => (window as any).events
          .filter((e: any) => e.type === "connected").map((e: any) => e.address));
        expect(paths).toEqual([expect.stringContaining("/webrtc")]);
      }
      if (mode === "mdns-rtc" || mode === "mixed") {
        await expect.poll(() => a.evaluate(() => (window as any).events
          .filter((e: any) => e.type === "connected").map((e:any) => e.address)))
          .toEqual(expect.arrayContaining([expect.stringContaining("/webrtc"),expect.stringContaining(mode === "mixed" ? ".relay." : "/tcp/")]));
      }
    } catch (error) {
      for (const page of [a, b])
        console.log(
          JSON.stringify(
            await page.evaluate(() => ({
              snapshot: (window as any).engine?.getSnapshot(),
              events: (window as any).events
                ?.filter((e: any) => e.type !== "pipe_data")
                .slice(-8),
            })),
          ),
        );
      throw error;
    } finally {
      await ac.close();
      await bc.close();
    }
  });
}
