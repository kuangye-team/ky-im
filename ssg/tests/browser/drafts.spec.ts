import { expect, test } from "@playwright/test";
import { openPeer, setProfile } from "./helpers";

test("未发送文字在切换页面和刷新后恢复，发出后不再恢复", async ({
  page,
  browser,
}) => {
  const context = await browser.newContext({ locale: "zh-CN" });
  const other = await context.newPage();
  try {
    await page.goto("/");
    await other.goto("/");
    await setProfile(page, "草稿甲");
    await setProfile(other, "草稿乙");
    await openPeer(page, "草稿乙");
    const composer = page.getByRole("textbox", {
      name: "消息内容",
      exact: true,
    });
    await composer.fill("这一段先留着，更新之后继续写");
    await page.getByRole("button", { name: "聊天记录", exact: true }).click();
    await page.getByRole("button", { name: "聊天消息", exact: true }).click();
    await expect(composer).toHaveValue("这一段先留着，更新之后继续写");
    await page.reload();
    await openPeer(page, "草稿乙");
    await expect(composer).toHaveValue("这一段先留着，更新之后继续写");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(
      page.getByRole("log").getByText("已送达", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await openPeer(page, "草稿乙");
    await expect(composer).toHaveValue("");
  } finally {
    await context.close();
  }
});
