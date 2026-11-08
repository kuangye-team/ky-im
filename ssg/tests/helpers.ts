import { expect, test, type Locator, type Page } from "@playwright/test";

export async function capture(page: Page, filename: string) {
  if (!process.env.SEND_CAPTURE) return;
  const dismiss = page.getByRole("button", { name: "关闭提示", exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  await page.screenshot({
    path: test.info().outputPath(filename),
    fullPage: true,
    scale: "css",
    animations: "disabled",
  });
}

export async function setProfile(
  page: Page,
  name: string,
  bio = "局域网自动化测试",
) {
  await page.getByRole("button", { name: "个人资料", exact: true }).click();
  await page.getByLabel("显示名称", { exact: false }).fill(name);
  await page.getByLabel("个性签名", { exact: false }).fill(bio);
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

export async function openPeer(page: Page, name: string) {
  await page
    .getByRole("button", { name: `与 ${name} 聊天`, exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "消息内容", exact: true }),
  ).toBeVisible();
}

export function contactDetails(page: Page) {
  return page
    .getByRole("complementary", { name: "联系人资料", exact: true })
    .or(page.getByRole("dialog", { name: "联系人资料", exact: true }));
}

export async function openContact(page: Page) {
  const contact = contactDetails(page);
  if (!(await contact.isVisible())) {
    await page
      .getByRole("button", { name: "查看联系人资料", exact: true })
      .click();
  }
  await expect(contact).toBeVisible();
  return contact;
}

export async function closeContact(page: Page) {
  const contact = page.getByRole("dialog", {
    name: "联系人资料",
    exact: true,
  });
  if (await contact.isVisible()) {
    await contact.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(contact).toBeHidden();
    return;
  }
  const sidebar = page.getByRole("complementary", {
    name: "联系人资料",
    exact: true,
  });
  if (await sidebar.isVisible()) {
    await page
      .getByRole("button", { name: "查看联系人资料", exact: true })
      .click();
    await expect(sidebar).toBeHidden();
  }
}

export async function selectContactAction(
  page: Page,
  action: "导出文字记录" | "删除聊天记录",
) {
  const contact = await openContact(page);
  await contact.getByRole("button", { name: "聊天操作", exact: true }).click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
  await expect(page.getByRole("menu")).toBeHidden();
}

export async function sendText(page: Page, content: string) {
  await page
    .getByRole("textbox", { name: "消息内容", exact: true })
    .fill(content);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
}

export async function setPeerRemark(scope: Page | Locator, remark: string) {
  await scope.getByRole("button", { name: /^(设置|修改)备注$/ }).click();
  const input = scope.getByRole("textbox", {
    name: "备注名称",
    exact: true,
  });
  await input.fill(remark);
  await scope.getByRole("button", { name: "保存备注", exact: true }).click();
  await expect(input).toBeHidden();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

export async function enableAutoAcceptFiles(page: Page) {
  const contact = await openContact(page);
  const toggle = contact.getByRole("switch", {
    name: "自动接收文件",
    exact: true,
  });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await closeContact(page);
}
