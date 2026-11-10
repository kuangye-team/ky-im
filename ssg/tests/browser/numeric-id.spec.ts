import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import {
  capture,
  closeContact,
  openPeer,
  selectContactAction,
  sendText,
  setProfile,
} from "./helpers";

type DiscoveryProbe = Window & { __socketCount: number };

async function useRoom(page: Page, room: string) {
  // Separate discovery rooms model different network groups; all traffic still
  // uses real WebSockets and WebRTC DataChannels.
  await page.addInitScript((roomName) => {
    const state = window as DiscoveryProbe;
    state.__socketCount = 0;
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        if (new URL(String(args[0]), location.href).pathname === "/api/ws")
          state.__socketCount++;
      }
      send(data: Parameters<WebSocket["send"]>[0]) {
        if (typeof data === "string") {
          try {
            const packet = JSON.parse(data);
            if (packet.type === "join") {
              super.send(JSON.stringify({ ...packet, room: roomName }));
              return;
            }
          } catch {
            // Preserve native behavior for non-JSON frames.
          }
        }
        super.send(data);
      }
    };
  }, room);
}

async function invite(page: Page) {
  await page.getByRole("button", { name: "在线设备", exact: true }).click();
  await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
  return page.getByRole("dialog", { name: "邀请朋友", exact: true });
}

async function ownNumber(page: Page) {
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "让朋友认识你", exact: true });
  const number = dialog.getByLabel("我的蜂鸟号", { exact: true });
  await expect(number).toHaveText(/^[1-9][0-9]{5}$/);
  const result = (await number.textContent())!;
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  return result;
}

async function connectTo(page: Page, numericId: string) {
  const dialog = await invite(page);
  await dialog.getByLabel("朋友的蜂鸟号", { exact: true }).fill(numericId);
  await dialog.getByRole("button", { name: "连接", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: /在线的朋友/ })).toBeVisible();
}

function deviceCard(page: Page, name: string) {
  return page.locator(".device-card").filter({
    has: page.getByRole("heading", { name, exact: true }),
  });
}

function status(page: Page) {
  return page
    .locator(".topbar")
    .getByRole("button", { name: "我的状态", exact: true });
}

async function exportCurrent(page: Page) {
  const downloading = page.waitForEvent("download");
  await selectContactAction(page, "导出文字记录");
  const download = await downloading;
  const result = JSON.parse(await readFile((await download.path())!, "utf8"));
  await closeContact(page);
  return result;
}

test("蜂鸟号连接整组及后续设备，保留自己的分组并分别保存同号联系人的历史", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all(
    [0, 1, 2, 3].map(() =>
      browser.newContext({
        locale: "zh-CN",
        viewport: { width: 1440, height: 980 },
      }),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [alice, bob, charlie, dora] = pages as [Page, Page, Page, Page];
  const suffix = Date.now().toString(36);
  const names = ["连接发起端", "同组电脑", "同组手机", "后上线设备"].map(
    (name) => `${name}-${suffix}`,
  );
  const pageErrors: string[] = [];
  try {
    for (const [index, page] of pages.entries()) {
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await useRoom(page, `group-${suffix}-${index === 0 ? "a" : "b"}`);
    }
    for (const [index, page] of [alice, bob, charlie].entries()) {
      await page.goto(baseURL!);
      await setProfile(page, names[index]!, `资料-${index}`);
    }
    const [aliceNumber, bobNumber, charlieNumber] = await Promise.all(
      [alice, bob, charlie].map(ownNumber),
    );
    expect(bobNumber).toBe(charlieNumber);
    expect(aliceNumber).not.toBe(bobNumber);
    await expect(
      alice.getByRole("button", { name: `与 ${names[1]} 聊天`, exact: true }),
    ).toHaveCount(0);

    const dialog = await invite(alice);
    await dialog.getByLabel("朋友的蜂鸟号", { exact: true }).fill(bobNumber!);
    await capture(alice, "desktop-invite.png");
    await dialog.getByRole("button", { name: "连接", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(deviceCard(alice, names[1]!)).toBeVisible();
    await expect(deviceCard(alice, names[2]!)).toBeVisible();
    await expect(alice.locator(".chat-heading")).toHaveCount(0);
    expect(await ownNumber(alice)).toBe(aliceNumber);

    await deviceCard(alice, names[1]!).click();
    await openPeer(bob, names[0]!);
    const originalText = `电脑的独立记录-${suffix}`;
    const originalReply = `电脑的回复-${suffix}`;
    await sendText(alice, originalText);
    await expect(bob.getByRole("log")).toContainText(originalText);
    await sendText(bob, originalReply);
    await expect(alice.getByRole("log")).toContainText(originalReply);
    const originalFileName = `电脑附件-${suffix}.txt`;
    const originalFile = Buffer.from(`电脑的文件内容-${suffix}`);
    await bob.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: originalFileName,
      mimeType: "text/plain",
      buffer: originalFile,
    });
    await alice.getByRole("button", { name: "接收", exact: true }).click();
    await expect(
      alice.getByRole("button", {
        name: `下载 ${originalFileName}`,
        exact: true,
      }),
    ).toBeEnabled();
    const computerHistory = await exportCurrent(alice);
    expect(computerHistory.peer.numericId).toBe(bobNumber);
    expect(computerHistory.messages).toHaveLength(3);

    await openPeer(alice, names[2]!);
    await openPeer(charlie, names[0]!);
    const phoneText = `手机的独立记录-${suffix}`;
    await sendText(alice, phoneText);
    await expect(charlie.getByRole("log")).toContainText(phoneText);
    for (const text of [originalText, originalReply, originalFileName]) {
      await expect(alice.getByRole("log")).not.toContainText(text);
      await expect(charlie.getByRole("log")).not.toContainText(text);
    }
    const phoneHistory = await exportCurrent(alice);
    expect(phoneHistory.peer.numericId).toBe(bobNumber);
    expect(phoneHistory.peer.id).not.toBe(computerHistory.peer.id);
    expect(phoneHistory.messages).toHaveLength(1);
    expect(phoneHistory.messages[0].text).toBe(phoneText);
    for (const history of [computerHistory, phoneHistory]) {
      expect(
        history.messages.every(
          (message: { peerId: string }) => message.peerId === history.peer.id,
        ),
      ).toBe(true);
    }

    // The lookup remains subscribed to the target group without moving Alice.
    await dora.goto(baseURL!);
    await setProfile(dora, names[3]!, "稍后加入同一网络");
    expect(await ownNumber(dora)).toBe(bobNumber);
    await alice.getByRole("button", { name: "在线设备", exact: true }).click();
    for (const name of names.slice(1)) {
      await expect(deviceCard(alice, name)).toBeVisible();
    }
    expect(await ownNumber(alice)).toBe(aliceNumber);
    await deviceCard(alice, names[3]!).click();
    await openPeer(dora, names[0]!);
    const laterText = `后上线设备也能直连-${suffix}`;
    await sendText(alice, laterText);
    await expect(dora.getByRole("log")).toContainText(laterText);

    // Offline is an intentional disconnect, including RTC and automatic retry.
    await status(alice).click();
    await alice
      .getByRole("menuitemradio", { name: "离线", exact: true })
      .click();
    await expect(status(alice)).toHaveAttribute("data-availability", "offline");
    await expect(bob.locator(".chat-heading")).toContainText("离线");
    await expect(charlie.locator(".chat-heading")).toContainText("离线");
    await expect(dora.locator(".chat-heading")).toContainText("离线");
    await expect(
      alice.getByRole("textbox", { name: "消息内容", exact: true }),
    ).toBeDisabled();
    const socketCount = await alice.evaluate(
      () => (window as DiscoveryProbe).__socketCount,
    );
    await alice.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(status(alice)).toHaveAttribute("data-availability", "offline");
    expect(
      await alice.evaluate(() => (window as DiscoveryProbe).__socketCount),
    ).toBe(socketCount);

    await alice.reload();
    await expect(status(alice)).toHaveAttribute("data-availability", "offline");
    await openPeer(alice, names[1]!);
    for (const text of [originalText, originalReply, originalFileName]) {
      await expect(alice.getByRole("log")).toContainText(text);
    }
    await expect(alice.getByRole("log")).not.toContainText(phoneText);
    const attachmentDownload = alice.waitForEvent("download");
    await alice
      .getByRole("button", { name: `下载 ${originalFileName}`, exact: true })
      .click();
    expect(await readFile((await (await attachmentDownload).path())!)).toEqual(
      originalFile,
    );
    await openPeer(alice, names[2]!);
    await expect(alice.getByRole("log")).toContainText(phoneText);
    expect(
      await alice.evaluate(() => (window as DiscoveryProbe).__socketCount),
    ).toBe(0);
    const offlineInvite = await invite(alice);
    await offlineInvite
      .getByLabel("朋友的蜂鸟号", { exact: true })
      .fill(bobNumber!);
    await expect(
      offlineInvite.getByRole("button", { name: "连接", exact: true }),
    ).toBeDisabled();
    await offlineInvite
      .getByRole("button", { name: "关闭", exact: true })
      .click();

    await status(alice).click();
    await alice
      .getByRole("menuitemradio", { name: "在线", exact: true })
      .click();
    await expect(status(alice).locator(".availability-value")).toHaveText(
      "在线",
    );
    // Returning online can restore a selected contact by UUID. Re-entering the
    // group number explicitly restores discovery of the complete device list.
    await connectTo(alice, bobNumber!);
    for (const name of names.slice(1)) {
      await expect(deviceCard(alice, name)).toBeVisible();
    }
    expect(await ownNumber(alice)).toBe(aliceNumber);
    await deviceCard(alice, names[2]!).click();
    await expect(alice.getByRole("log")).toContainText(phoneText);
    const restoredText = `重新在线后继续直连-${suffix}`;
    await sendText(alice, restoredText);
    await expect(charlie.getByRole("log")).toContainText(restoredText);
    expect(pageErrors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
