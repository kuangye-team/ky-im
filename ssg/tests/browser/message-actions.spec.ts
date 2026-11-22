import { expect, test } from "@playwright/test";
import { capture, closeContact, expectNoHorizontalOverflow, openContact, openPeer } from "./helpers";

const short = "好呀，周六见！";
const prefix = "林".repeat(199) + "👩🏽‍🌾";
const longText = prefix + "沿溪边步道上山。".repeat(600);
const itinerary = [
  "周六去山里走一走，行程发在这里。",
  "09:00　在北门集合，一起出发。",
  "10:30　沿溪边步道上山，途中有两处观景台。",
  "12:00　在山顶草地吃午餐，记得带水。",
  "14:00　走东侧小路下山。",
  "15:30　到村口喝茶，等大家集合。",
  "如果下雨，我们就改去附近的书店。",
].join("\r\n");
const fileName = "周末路线图.pdf";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app-shell, .phone-shell")).toBeVisible();
  await page.evaluate(async ({ short, prefix, longText, itinerary, fileName }) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter();
    const me = await store.getProfile();
    const peer = { ...me, id: crypto.randomUUID(), name: "周末徒步" };
    const now = Date.now();
    await store.saveConversation({ peer, updatedAt: now, unread: 0 });
    const base = { peerId: peer.id, senderId: peer.id, status: "delivered" };
    for (const [i, text] of [prefix, longText, short, itinerary].entries()) {
      await store.saveMessage({ ...base, id: crypto.randomUUID(), createdAt: now + i, kind: "text", text,
        senderId: text === short ? me.id : peer.id });
    }
    const file = new File(["route"], fileName, { type: "application/pdf" });
    const id = crypto.randomUUID();
    await store.saveAttachment(id, file);
    await store.saveMessage({ ...base, id, kind: "file", fileName, size: file.size,
      mimeType: file.type, createdAt: now + 4 });
    await store.close();
  }, { short, prefix, longText, itinerary, fileName });
  await page.reload();
});

test("长消息按字符或换行折叠，气泡和弹窗都能复制整条原文", async ({ page, isMobile }) => {
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
    value: { writeText: async (value: string) => { document.documentElement.dataset.copiedText = value; } },
  }));
  await openPeer(page, "周末徒步");
  const rows = page.getByRole("log").locator(".message-row");
  const read = { name: "查看全文", exact: true };
  await expect(rows.nth(0).getByRole("button", read)).toHaveCount(0);
  await expect(rows.nth(1).locator(".text-bubble")).toHaveText(prefix + "…查看全文");
  await rows.nth(1).getByRole("button", read).click();
  const dialog = page.getByRole("dialog", { name: "消息全文" });
  const body = dialog.locator("pre").and(dialog.getByRole("region", { name: "消息内容" }));
  expect(await body.textContent()).toBe(longText);
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth === el.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(rows.nth(2).getByRole("button", read)).toHaveCount(0);
  const longRow = rows.nth(3);
  await expect(longRow.locator(".text-bubble")).toContainText("15:30");
  await expect(longRow.locator(".text-bubble")).not.toContainText("书店");
  await longRow.scrollIntoViewIfNeeded();
  await capture(page, "message-excerpt.png");
  for (const [row, original] of [[rows.nth(2), short], [longRow, itinerary]] as const) {
    if (isMobile) await row.getByRole("button", { name: "消息操作" }).click();
    await (isMobile ? page.getByRole("dialog") : row).getByRole("button", { name: "复制", exact: true }).click();
    expect(await page.locator("html").getAttribute("data-copied-text")).toBe(original);
  }
  await longRow.getByRole("button", read).click();
  expect(await body.textContent()).toBe(itinerary);
  const actions = dialog.locator(".modal-heading-actions").getByRole("button");
  await expect(actions).toHaveText(["", ""]);
  await expect(actions.first()).toHaveAccessibleName("复制全文");
  await expect(actions.last()).toHaveAccessibleName("关闭");
  await expect(actions.last()).toHaveCSS("border-top-style", "solid");
  await expectNoHorizontalOverflow(page);
  await capture(page, "full-message.png");
  await page.evaluate(() => { delete document.documentElement.dataset.copiedText; });
  await dialog.getByRole("button", { name: "复制全文" }).click();
  expect(await page.locator("html").getAttribute("data-copied-text")).toBe(itinerary);
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(longRow.getByRole("button", read)).toBeFocused();
});

test("剪贴板权限被拒绝时仍能从消息操作复制", async ({ page, isMobile }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        throw new DOMException("Denied", "NotAllowedError");
      },
    } });
    document.execCommand = command => {
      const field = document.activeElement;
      if (command !== "copy" || !(field instanceof HTMLTextAreaElement)) return false;
      document.documentElement.dataset.copiedText = field.value.slice(field.selectionStart, field.selectionEnd);
      return true;
    };
  });
  await openPeer(page, "周末徒步");
  const row = page.getByRole("log").locator(".message-row").nth(1);
  if (isMobile) await row.getByRole("button", { name: "消息操作" }).click();
  await (isMobile ? page.getByRole("dialog") : row).getByRole("button", { name: "复制", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-copied-text", longText);
});

test("打开文件需确认，打开方式直接选择应用", async ({ page, isMobile }) => {
  await page.evaluate(async () => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    // Record the native operation at the storage boundary without launching an external app.
    IndexedDBStorageAdapter.prototype.openAttachment = async (id: string, choose: boolean) => {
      const root = document.documentElement;
      root.dataset.openCalls = JSON.stringify([...JSON.parse(root.dataset.openCalls || "[]"), { id, choose }]);
    };
  });
  await openPeer(page, "周末徒步");
  const row = page.getByRole("log").locator(".message-row").filter({ hasText: fileName });
  const id = await row.getAttribute("data-message-id");
  const root = page.locator("html");
  const dialog = page.getByRole("dialog", { name: "打开这个文件？" });
  const clickChatAction = async (name: string) => {
    if (isMobile) await row.getByRole("button", { name: "消息操作" }).click();
    await (isMobile ? page.getByRole("dialog") : row).getByRole("button", { name, exact: true }).click();
  };
  await clickChatAction("打开");
  await expect(dialog).toContainText(fileName);
  await expectNoHorizontalOverflow(page);
  await capture(page, "open-attachment.png");
  await dialog.getByRole("button", { name: "取消" }).click();
  expect(await root.getAttribute("data-open-calls")).toBeNull();
  await clickChatAction("打开方式");
  await expect(dialog).toBeHidden();
  const calls = [{ id, choose: true }];
  await expect(root).toHaveAttribute("data-open-calls", JSON.stringify(calls));
  const shared = await openContact(page);
  await shared.getByRole("button", { name: "更多文件操作 " + fileName }).click();
  await page.getByRole("menuitem", { name: "打开", exact: true }).click();
  await expect(dialog).toContainText(fileName);
  await expect(root).toHaveAttribute("data-open-calls", JSON.stringify(calls));
  await dialog.getByRole("button", { name: "打开", exact: true }).click();
  calls.push({ id, choose: false });
  await expect(root).toHaveAttribute("data-open-calls", JSON.stringify(calls));
  await closeContact(page);
  if (isMobile) {
    await page.getByRole("button", { name: "返回列表" }).click();
    await page.getByRole("link", { name: "我的", exact: true }).click();
    await page.getByRole("link", { name: /存储空间/ }).click();
  } else {
    await page.getByRole("button", { name: "存储管理", exact: true }).click();
  }
  await page.getByRole("button", { name: "更多文件操作 " + fileName }).click();
  await page.getByRole("menuitem", { name: "打开", exact: true }).click();
  await expect(dialog).toContainText(fileName);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(root).toHaveAttribute("data-open-calls", JSON.stringify(calls));
});
