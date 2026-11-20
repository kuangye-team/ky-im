import { test, expect } from "@playwright/test";
for (const [sender, receiver, mode] of [
  ["web", "web", "rtc"],
  ["web", "native", "relay"],
  ["native", "web", "relay"],
]) {
  test(`${sender} to ${receiver} ${mode}: resumes the same file after the connection closes`, async ({
    browser,
    baseURL,
  }) => {
    const ac = await browser.newContext(),
      bc = await browser.newContext(),
      a = await ac.newPage(),
      b = await bc.newPage();
    try {
      for (const page of [a, b])
        await page.goto(`${baseURL}/tests/browser/p2p.html`);
      await a.evaluate(
        async (args) => {
          await (window as any).start("A", args.sender, args.mode);
        },
        { sender, mode },
      );
      await b.evaluate(
        async (args) => {
          await (window as any).start("B", args.receiver, args.mode);
        },
        { receiver, mode },
      );
      for (const page of [a, b])
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as any).engine.getSnapshot().peers.length,
            ),
          )
          .toBe(1);
      for (const page of [a, b])
        await page.evaluate(async () => {
          const e = (window as any).engine;
          await e.selectPeer(e.getSnapshot().peers[0]);
        });
      await a.evaluate(() => (window as any).engine.sendText("ready"));
      await b.evaluate(() => {
        const e = (window as any).engine;
        return e.updatePeerAutoAcceptFiles(e.getSnapshot().peers[0].id, true);
      });
      await a.evaluate(() => {
        const e = (window as any).engine,
          c = e.network.transport.channels.get(e.getSnapshot().activePeerId),
          send = c.send.bind(c);
        let chunks = 0;
        c.send = (data: string | ArrayBuffer) => {
          if (data instanceof ArrayBuffer && ++chunks === 4) {
            (window as any).interrupted = true;
            c.close();
            throw new Error("Test disconnection");
          }
          send(data);
        };
      });
      await a.evaluate(() => {
        const bytes = Uint8Array.from(
          { length: 3 * 1024 * 1024 + 17 },
          (_, i) => i % 251,
        );
        return (window as any).engine.sendFiles([
          new File([bytes], "resume.bin"),
        ]);
      });
      expect(await a.evaluate(() => (window as any).interrupted)).toBe(true);
      await expect
        .poll(
          () =>
            a.evaluate(
              () =>
                (window as any).engine
                  .getSnapshot()
                  .messages.find((m: any) => m.fileName === "resume.bin")
                  ?.status,
            ),
          { timeout: 55000 },
        )
        .toBe("delivered");
      expect(
        await b.evaluate(async () => {
          const e = (window as any).engine,
            m = e
              .getSnapshot()
              .messages.find((m: any) => m.fileName === "resume.bin");
          const data = new Uint8Array(
            await (await e.storage.getAttachment(m.id)).arrayBuffer(),
          );
          return (
            data.length === 3 * 1024 * 1024 + 17 &&
            data.every((v, i) => v === i % 251)
          );
        }),
      ).toBe(true);
      expect(
        await a.evaluate(
          () =>
            (window as any).engine
              .getSnapshot()
              .messages.filter((m: any) => m.fileName === "resume.bin").length,
        ),
      ).toBe(1);
    } finally {
      await ac.close();
      await bc.close();
    }
  });
}
