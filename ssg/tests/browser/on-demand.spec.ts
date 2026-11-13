import { expect, test, type Page } from "@playwright/test";
import { openPeer, sendText, setProfile } from "./helpers";

type Probe = Window & {
  __identity: string;
  __rtc: RTCPeerConnection[];
  __holdSignals: boolean;
  __pendingSignals: (() => void)[];
  __offers: number;
};

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const state = window as Probe;
    state.__rtc = [];
    state.__identity = "";
    state.__holdSignals = false;
    state.__pendingSignals = [];
    state.__offers = 0;
    const OriginalPeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(config?: RTCConfiguration) {
        super(config);
        state.__rtc.push(this);
      }
    };
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      send(data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string") {
          const packet = JSON.parse(data);
          if (packet.type === "join") state.__identity = packet.profile.id;
          if (packet.type === "signal") {
            if (packet.data.description?.type === "offer") state.__offers++;
            if (state.__holdSignals) {
              state.__pendingSignals.push(() => super.send(data));
              return;
            }
          }
        }
        super.send(data);
      }
    };
  });
}

test("列表在首次检查前保持在线，任一方可立即发起，双方同时打开也能收发", async ({
  browser,
  baseURL,
}) => {
  const contexts = await Promise.all(
    [0, 1, 2].map(() => browser.newContext({ locale: "zh-CN" })),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const names = pages.map((_, n) => `按需-${n}-${Date.now()}`);
  const errors: string[] = [];
  try {
    for (const [n, page] of pages.entries()) {
      page.on("pageerror", (error) => errors.push(error.message));
      await instrument(page);
      await page.goto(baseURL!);
      await setProfile(page, names[n]!);
    }
    for (const [n, page] of pages.entries()) {
      for (const name of names.filter((_, other) => n !== other)) {
        await expect(
          page.getByRole("button", { name: `与 ${name} 聊天`, exact: true }),
        ).toBeVisible();
      }
      expect(await page.evaluate(() => (window as Probe).__rtc.length)).toBe(0);
    }
    await pages[2]!
      .getByRole("button", { name: "在线设备", exact: true })
      .click();
    await expect(pages[2]!.locator(".device-card-online").first()).toHaveText(
      "在线",
    );
    // Start from the higher ID while the other side remains on discovery.
    const identities = await Promise.all(
      pages.map((page) => page.evaluate(() => (window as Probe).__identity)),
    );
    const from = identities[0]! > identities[1]! ? 0 : 1;
    const to = 1 - from;
    await openPeer(pages[from]!, names[to]!);
    await expect(pages[from]!.locator(".chat-heading")).toContainText(
      "可以聊天了",
    );
    expect(
      await pages[to]!.evaluate(() => (window as Probe).__rtc.length),
    ).toBe(1);
    expect(await pages[2]!.evaluate(() => (window as Probe).__rtc.length)).toBe(
      0,
    );
    await sendText(pages[from]!, "单方打开后发送");
    await openPeer(pages[to]!, names[from]!);
    await expect(pages[to]!.getByRole("log")).toContainText("单方打开后发送");

    // Force both offers to exist before either is delivered, exercising glare.
    const a = pages[0]!;
    const b = pages[2]!;
    const before = await Promise.all(
      [a, b].map((page) =>
        page.evaluate(() => {
          const state = window as Probe;
          state.__holdSignals = true;
          return state.__offers;
        }),
      ),
    );
    await Promise.all([
      openPeer(a, names[2]!),
      b
        .locator(".device-card")
        .filter({
          has: b.getByRole("heading", { name: names[0]!, exact: true }),
        })
        .click(),
    ]);
    for (const [n, page] of [a, b].entries()) {
      await expect
        .poll(() => page.evaluate(() => (window as Probe).__offers))
        .toBe(before[n]! + 1);
    }
    await Promise.all(
      [a, b].map((page) =>
        page.evaluate(() => {
          const state = window as Probe;
          state.__holdSignals = false;
          state.__pendingSignals.splice(0).forEach((send) => send());
        }),
      ),
    );
    for (const page of [a, b])
      await expect(page.locator(".chat-heading")).toContainText("可以聊天了");
    await sendText(a, "同时打开也能发送");
    await expect(b.getByRole("log")).toContainText("同时打开也能发送");
    await sendText(b, "同时打开后的回复");
    await expect(a.getByRole("log")).toContainText("同时打开后的回复");
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
