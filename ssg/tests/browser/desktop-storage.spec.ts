import { expect, test } from "@playwright/test";
import { capture, expectNoHorizontalOverflow } from "./helpers";

test("客户端目录迁移显示占用、阻止重复提交，并允许失败后重试", async ({
  page,
}) => {
  await page.goto("/tests/browser/desktop-storage.html");
  await expect(
    page.getByRole("heading", { name: "数据存储目录" }),
  ).toBeVisible();
  await expect(
    page.locator(".storage-metrics > div").filter({ hasText: "缓存占用" }),
  ).toContainText("1.0 KB");
  await expect(
    page.getByText("/Users/test/Hummingbird/data", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await capture(page, "native-storage-directory.png");
  await page.getByRole("button", { name: "修改目录", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "迁移数据存储目录" });
  await expect(modal).toContainText("/Volumes/External/Hummingbird");
  await modal.getByRole("button", { name: "开始迁移" }).click();
  await expect(modal.getByRole("button", { name: "正在迁移…" })).toBeDisabled();
  await expect(
    modal.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await page.evaluate(async () =>
    (await import("/tests/browser/desktop-storage-harness.tsx")).completeMove(
      true,
    ),
  );
  await expect(modal.getByRole("alert")).toHaveText(
    "请选择空文件夹，避免覆盖已有数据",
  );
  await modal.getByRole("button", { name: "开始迁移" }).click();
  await expect(modal.getByRole("button", { name: "正在迁移…" })).toBeDisabled();
  await page.evaluate(async () =>
    (await import("/tests/browser/desktop-storage-harness.tsx")).completeMove(
      false,
    ),
  );
  await expect(modal).toBeHidden();
  await expect(
    page.getByText("/Volumes/External/Hummingbird", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "数据存储目录已迁移" }),
  ).toBeVisible();
  await page.evaluate(async () =>
    (await import("/tests/browser/desktop-storage-harness.tsx")).language("en"),
  );
  await expect(
    page.getByRole("heading", { name: "Data storage directory" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 800, height: 600 });
  await expectNoHorizontalOverflow(page);
  await capture(page, "native-storage-directory-english.png");
});
