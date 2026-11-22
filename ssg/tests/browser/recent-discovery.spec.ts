import { expect, test, type Page } from "@playwright/test";
import { openPeer, sendText, setProfile, useRoom } from "./helpers";

async function ownNumber(page: Page) {
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "让朋友认识你", exact: true });
  const number = dialog.getByLabel("我的蜂鸟号", { exact: true });
  await expect(number).toHaveText(/^[1-9][0-9]{5}$/);
  const value = (await number.textContent())!;
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  return value;
}

async function lookup(page: Page, number: string) {
  await page.getByRole("button", { name: "在线设备", exact: true }).click();
  await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请朋友", exact: true });
  await dialog.getByLabel("朋友的蜂鸟号", { exact: true }).fill(number);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function availability(page: Page, status: "在线" | "离线") {
  await page.locator(".topbar").getByRole("button", { name: "我的状态", exact: true }).click();
  await page.getByRole("menuitemradio", { name: status, exact: true }).click();
  await expect(page.locator(".topbar .availability-value")).toHaveText(status);
}

test("蜂鸟号查到的设备即使没有聊天也会保存，刷新后自动恢复", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ locale: "zh-CN" })));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [alice, bob] = pages;
  let recentNumericIds: string[] | undefined;
  alice.on("websocket", socket => {
    if (new URL(socket.url()).pathname !== "/api/ws") return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const packet = JSON.parse(payload);
      if (packet.type === "join") recentNumericIds = packet.recentNumericIds;
    });
  });
  const suffix = Date.now();
  const names = ["最近联系人本机", "最近聊过的朋友", "只查询过的设备"];
  try {
    for (let index = 0; index < pages.length; index++) {
      await useRoom(pages[index], `recent-${suffix}-${index}`);
      await pages[index].goto(baseURL!);
      await setProfile(pages[index], names[index]);
    }
    const [mine, number, queriedNumber] = await Promise.all(pages.map(ownNumber));
    await lookup(alice, number);
    await alice.locator(".device-card").filter({ hasText: names[1] }).click();
    await openPeer(bob, names[0]);
    await sendText(alice, "刷新前保留的消息");
    await expect(bob.getByRole("log")).toContainText("刷新前保留的消息");
    await lookup(alice, queriedNumber);
    await expect(alice.locator(".device-card").filter({ hasText: names[2] })).toBeVisible();
    await alice.reload();
    await alice.getByRole("button", { name: "在线设备", exact: true }).click();
    await expect(alice.locator(".device-card").filter({ hasText: names[1] })).toBeVisible();
    await expect(alice.locator(".device-card").filter({ hasText: names[2] })).toBeVisible();
    expect(recentNumericIds).toEqual([queriedNumber, number]);
    expect(await ownNumber(alice)).toBe(mine);
    await alice.screenshot({ path: "../temp/screenshot/recent-discovery-reload.png", animations: "disabled" });
    await alice.locator(".device-card").filter({ hasText: names[1] }).click();
    await expect(alice.getByRole("log")).toContainText("刷新前保留的消息");
    await sendText(alice, "刷新后无需重新查询");
    await expect(bob.getByRole("log")).toContainText("刷新后无需重新查询");
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("刷新时为空的最近号码分组保留订阅，对方上线立即恢复", async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ locale: "zh-CN" })));
  const [alice, bob] = await Promise.all(contexts.map((context) => context.newPage()));
  const suffix = Date.now();
  try {
    await useRoom(alice, `empty-${suffix}-a`);
    await useRoom(bob, `empty-${suffix}-b`);
    await alice.goto(baseURL!);
    await bob.goto(baseURL!);
    await setProfile(alice, "空分组本机");
    await setProfile(bob, "暂时离线的朋友");
    const number = await ownNumber(bob);
    await lookup(alice, number);
    await alice.locator(".device-card").filter({ hasText: "暂时离线的朋友" }).click();
    await availability(bob, "离线");
    await expect(alice.locator(".composer-presence-hint")).toBeVisible();
    await alice.reload();
    await alice.getByRole("button", { name: "在线设备", exact: true }).click();
    await expect(alice.locator(".topbar .availability-value")).toHaveText("在线");
    await expect(alice.locator(".device-card")).toHaveCount(0);
    await availability(bob, "在线");
    // Subscription intent survives an empty group; no reload or manual lookup is needed.
    await expect(alice.locator(".device-card")).toHaveCount(1);
    await alice.screenshot({ path: "../temp/screenshot/recent-discovery-empty.png", animations: "disabled" });
    await alice.reload();
    await alice.getByRole("button", { name: "在线设备", exact: true }).click();
    await expect(alice.locator(".device-card").filter({ hasText: "暂时离线的朋友" })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
