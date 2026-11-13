import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { openPeer, setProfile } from "./helpers";

test("多个文件同时等待确认，可追加、独立拒收、交错接收及双向发送", async ({ browser, baseURL }) => {
  const a = await browser.newContext({ locale: "zh-CN" });
  const b = await browser.newContext({ locale: "zh-CN" });
  try {
    const alice = await a.newPage();
    const bob = await b.newPage();
    const errors: string[] = [];
    for (const page of [alice, bob]) page.on("pageerror", (error) => errors.push(error.message));
    await alice.goto(baseURL!);
    await setProfile(alice, "并行发送方");
    await bob.goto(baseURL!);
    await setProfile(bob, "并行接收方");
    await openPeer(alice, "并行接收方");
    await openPeer(bob, "并行发送方");
    const row = (page: Page, name: string) => page.locator(".message-row").filter({ hasText: name });
    const files = ["先保留.txt", "可拒收.txt", "后接收一.bin", "后接收二.bin", "追加.txt"].map((name, index) => ({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(384 * 1024 + index, index + 1),
    }));
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles(files.slice(0, 4));
    await expect(bob.getByRole("button", { name: "接收", exact: true })).toHaveCount(4);
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles(files[4]);
    await expect(bob.getByRole("button", { name: "接收", exact: true })).toHaveCount(5);
    await expect(alice.getByText("等待对方确认", { exact: true })).toHaveCount(5);
    for (const [page, name] of [[alice, "sender"], [bob, "receiver"]] as const)
      await page.screenshot({ path: `../temp/screenshot/concurrent-files-${name}.png`, fullPage: true });

    await row(bob, files[1].name).getByRole("button", { name: "拒收", exact: true }).click();
    await expect(row(alice, files[1].name).getByText("发送失败", { exact: true })).toBeVisible();
    for (const file of [files[4], files[3], files[2]])
      await row(bob, file.name).getByRole("button", { name: "接收", exact: true }).click();
    for (const file of files.slice(2)) {
      await expect(row(alice, file.name).getByText("已送达", { exact: true })).toBeVisible();
      const downloading = bob.waitForEvent("download");
      await row(bob, file.name).getByRole("button", { name: `下载 ${file.name}`, exact: true }).click();
      const download = await downloading;
      expect(await readFile((await download.path())!)).toEqual(file.buffer);
    }
    await expect(row(bob, files[0].name).getByRole("button", { name: "接收", exact: true })).toBeEnabled();
    await bob.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: "回复.txt", mimeType: "text/plain", buffer: Buffer.from("双向发送"),
    });
    await row(alice, "回复.txt").getByRole("button", { name: "接收", exact: true }).click();
    await expect(row(bob, "回复.txt").getByText("已送达", { exact: true })).toBeVisible();
    await row(bob, files[0].name).getByRole("button", { name: "接收", exact: true }).click();
    await expect(row(alice, files[0].name).getByText("已送达", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await a.close();
    await b.close();
  }
});
