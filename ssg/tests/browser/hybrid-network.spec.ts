import { expect, test } from "@playwright/test";

for (const mode of ["fallback", "mdns"] as const) {
  test(
    mode === "fallback"
      ? "客户端 TCP 失败后与网页通过真实 WebRTC 双向通信"
      : "仅附近查找和 WebRTC 时客户端仍可双向通信",
    async ({ page }) => {
      await page.goto("/tests/browser/hybrid.html");
      await page.evaluate(async (mode) => {
        const harness = await import("/tests/browser/hybrid-harness.ts");
        (window as any).harness = harness;
        await harness.start(mode);
      }, mode);
      try {
        await expect
          .poll(() =>
            page.evaluate(() =>
              (window as any).harness.engines.map(
                (e: any) => e.getSnapshot().peers.length,
              ),
            ),
          )
          .toEqual([1, 1]);
        expect(await page.evaluate(() =>
          (window as any).harness.engines.map((e: any) =>
            e.getSnapshot().peers[0].clientType),
        )).toEqual(mode === "fallback" ? ["web", "app"] : ["app", "app"]);
        await page.evaluate(() => (window as any).harness.send());
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as any).harness.engines[1].getSnapshot().messages[0]
                  ?.text,
            ),
          )
          .toBe("真实 WebRTC 通道");
        await page.evaluate(() => (window as any).harness.reply());
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as any).harness.engines[0].getSnapshot().messages[1]
                  ?.text,
            ),
          )
          .toBe("双向连接成功");
        const calls = await page.evaluate(
          () => (window as any).harness.calls as string[],
        );
        expect(calls.includes("tcp_connect")).toBe(mode === "fallback");
        expect(calls.includes("lan_signal")).toBe(mode === "mdns");
        expect(calls).not.toContain("tcp_send");
      } finally {
        await page.evaluate(() => (window as any).harness.stop());
      }
    },
  );
}
