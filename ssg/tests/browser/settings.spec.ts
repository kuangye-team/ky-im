import { expect, test } from "@playwright/test";

test("系统配置自动应用，服务器通过弹窗添加和编辑", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "系统配置", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "保存设置", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /附近查找/ })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /快速直连/ })).toBeDisabled();
  const list = page.getByRole("list", { name: "服务器列表" });
  await expect(list.getByRole("textbox")).toHaveCount(0);
  await expect(list.getByText("默认服务器", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "编辑服务器 1", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "删除服务器 1", exact: true }),
  ).toBeDisabled();

  // Invalid changes retain the applied state without requiring a save action.
  await page.getByLabel("启用服务器 1", { exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "使用在线查找时，请至少启用一个服务器",
  );
  await expect(page.getByLabel("启用服务器 1", { exact: true })).toBeChecked();

  const add = page.getByRole("button", { name: "添加服务器", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("服务器名称", { exact: true })).toBeFocused();
  await dialog.getByLabel("服务器名称", { exact: true }).fill("取消的服务器");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await expect(list.getByRole("listitem")).toHaveCount(1);

  await add.click();
  await dialog.getByLabel("服务器名称", { exact: true }).fill("我的服务器");
  await dialog
    .getByLabel("服务器地址", { exact: true })
    .fill("https://invalid.example.com");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "请输入完整的 ws:// 或 wss:// 服务器地址",
  );
  await expect(dialog.getByLabel("服务器名称", { exact: true })).toHaveValue(
    "我的服务器",
  );
  await dialog
    .getByLabel("服务器地址", { exact: true })
    .fill("ws://127.0.0.1:9/api/ws");
  await dialog.getByLabel("启用", { exact: true }).uncheck();
  await page.screenshot({
    path: "../temp/screenshot/settings-add-server.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("设置已生效。");
  await expect(list.getByText("我的服务器", { exact: true })).toBeVisible();
  await page.reload();
  await expect(list.getByText("我的服务器", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("启用服务器 2", { exact: true }),
  ).not.toBeChecked();

  await page.getByRole("button", { name: "编辑服务器 2", exact: true }).click();
  await expect(dialog).toHaveAccessibleName("编辑服务器");
  await expect(dialog.getByLabel("服务器名称", { exact: true })).toHaveValue(
    "我的服务器",
  );
  await dialog.getByLabel("服务器名称", { exact: true }).fill("不会保存的名称");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(list.getByText("我的服务器", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑服务器 2", exact: true }).click();
  await dialog.getByLabel("服务器名称", { exact: true }).fill("更新的服务器");
  await dialog
    .getByLabel("服务器地址", { exact: true })
    .fill("ws://127.0.0.1:9/updated");
  await page.screenshot({
    path: "../temp/screenshot/settings-edit-server.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(list.getByText("更新的服务器", { exact: true })).toBeVisible();
  await expect(
    list.getByText("ws://127.0.0.1:9/updated", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("启用服务器 2", { exact: true }).check();
  await expect(page.getByRole("status")).toHaveText("设置已生效。");
  await page.getByLabel("启用服务器 1", { exact: true }).uncheck();
  await expect(
    page.getByLabel("启用服务器 1", { exact: true }),
  ).not.toBeChecked();
  await page.reload();
  await expect(
    page.getByLabel("启用服务器 1", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel("启用服务器 2", { exact: true })).toBeChecked();
  await page.getByRole("button", { name: "删除服务器 2", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "使用在线查找时，请至少启用一个服务器",
  );
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await page.getByLabel("启用服务器 1", { exact: true }).check();
  await page.getByRole("button", { name: "删除服务器 2", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await page.screenshot({
    path: "../temp/screenshot/settings-desktop.png",
    fullPage: true,
  });
});

test("应用失败保留原设置，弹窗保留输入以便重试", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "hummingbird.network.v1",
      JSON.stringify({
        discovery: { signaling: true, mdns: false },
        transport: { tcp: false, webrtc: true },
        servers: [
          { id: "default", name: "", url: "", enabled: true },
          {
            id: "custom",
            name: "备用服务器",
            url: "ws://127.0.0.1:9/api/ws",
            enabled: false,
          },
        ],
      }),
    );
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hummingbird.network.v1")
        throw new Error("Storage unavailable");
      setItem.call(this, key, value);
    };
  });
  await page.goto("/settings");
  await page.getByLabel("启用服务器 2", { exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("设置未保存，请重试");
  await expect(
    page.getByLabel("启用服务器 2", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByText("设置已生效。", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "编辑服务器 2", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑服务器" });
  await dialog.getByLabel("服务器名称", { exact: true }).fill("保存失败的名称");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("设置未保存，请重试");
  await expect(dialog.getByLabel("服务器名称", { exact: true })).toHaveValue(
    "保存失败的名称",
  );
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "服务器列表" }).getByText("备用服务器"),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("hummingbird.network.v1")!).servers[1],
    ),
  ).toMatchObject({ name: "备用服务器", enabled: false });
});

test("一个服务器连不上时仍能通过另一个服务器发现和聊天", async ({
  browser,
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "hummingbird.network.v1",
      JSON.stringify({
        discovery: { signaling: true, mdns: false },
        transport: { tcp: false, webrtc: true },
        servers: [
          {
            id: "offline",
            name: "offline",
            url: "ws://127.0.0.1:9/api/ws",
            enabled: true,
          },
          { id: "default", name: "", url: "", enabled: true },
        ],
      }),
    ),
  );
  const { setProfile, openPeer, sendText } = await import("./helpers");
  const context = await browser.newContext({ locale: "zh-CN" });
  const other = await context.newPage();
  try {
    await page.goto("/");
    await other.goto("/");
    await setProfile(page, "多通道设备");
    await setProfile(other, "单通道设备");
    await openPeer(page, "单通道设备");
    await sendText(page, "在线服务器可以继续连接");
    await openPeer(other, "多通道设备");
    await expect(
      other.getByText("在线服务器可以继续连接", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("系统配置列表和编辑弹窗在手机宽度下不会横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings");
  const { expectNoHorizontalOverflow } = await import("./helpers");
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("服务器名称", { exact: true })
    .fill("手机上的连接服务器");
  const address = `wss://example.com/${"long-path-".repeat(20)}`;
  await dialog.getByLabel("服务器地址", { exact: true }).fill(address);
  await dialog.getByLabel("启用", { exact: true }).uncheck();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: "../temp/screenshot/settings-mobile-dialog.png",
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page
      .getByRole("list", { name: "服务器列表" })
      .getByText(address, { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: "../temp/screenshot/settings-mobile.png",
    animations: "disabled",
    fullPage: true,
  });
});

test("不支持中转时置灰，默认服务器可保存访问密钥", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("button", { name: "测试服务器 1", exact: true }).click();
  await expect(
    page.getByText("连接成功 · 不支持中转", { exact: true }),
  ).toBeVisible();
  const relay = page.getByLabel("启用服务器 1 的中转", { exact: true });
  await expect(relay).toBeDisabled();
  await expect(relay.locator("..")).toHaveCSS("opacity", "0.5");
  await expect(
    page.getByRole("button", { name: "测试服务器 1", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "../temp/screenshot/settings-relay-disabled.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "编辑服务器 1", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByLabel("服务器名称", { exact: true }),
  ).toHaveAttribute("readonly", "");
  await expect(
    dialog.getByLabel("服务器地址", { exact: true }),
  ).toHaveAttribute("readonly", "");
  const key = dialog.getByLabel("访问密钥", { exact: true });
  await expect(key).toHaveAttribute("type", "password");
  await key.fill("Bearer default-secret");
  await page.screenshot({
    path: "../temp/screenshot/settings-server-auth.png",
    fullPage: true,
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("测试后可查看中转支持情况")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "编辑服务器 1", exact: true }).click();
  await expect(key).toHaveValue("Bearer default-secret");
});

test("鉴权服务器拒绝错误密钥，正确密钥可测试、重连和聊天", async ({
  page,
  browser,
}) => {
  const authURL = `ws://127.0.0.1:${process.env.PLAYWRIGHT_AUTH_PORT || 4312}/api/ws`;
  await page.goto("/settings");
  await page.getByRole("button", { name: "添加服务器", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("服务器名称", { exact: true }).fill("我的私有服务器");
  await dialog.getByLabel("服务器地址", { exact: true }).fill(authURL);
  await dialog.getByLabel("访问密钥", { exact: true }).fill("Bearer wrong");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "测试服务器 2", exact: true }).click();
  await expect(
    page.getByText("访问密钥不正确或无权访问，请检查后重试", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("启用服务器 2 的中转", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "编辑服务器 2", exact: true }).click();
  await dialog
    .getByLabel("访问密钥", { exact: true })
    .fill("Bearer browser-test-secret");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "测试服务器 2", exact: true }).click();
  await expect(
    page.getByText("连接成功 · 支持中转", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("启用服务器 2 的中转", { exact: true }).check();
  await expect(page.getByRole("status")).toHaveText("设置已生效。");
  await page.getByLabel("启用服务器 1", { exact: true }).uncheck();
  await expect(page.getByRole("status")).toHaveText("设置已生效。");
  await page.reload();
  await expect(
    page.getByLabel("启用服务器 2 的中转", { exact: true }),
  ).toBeChecked();
  await page.screenshot({
    path: "../temp/screenshot/settings-authorized-server.png",
    fullPage: true,
    animations: "disabled",
  });

  const settings = await page.evaluate(
    () => localStorage.getItem("hummingbird.network.v1")!,
  );
  const context = await browser.newContext({ locale: "zh-CN" });
  await context.addInitScript(
    (value) => localStorage.setItem("hummingbird.network.v1", value),
    settings,
  );
  const other = await context.newPage();
  const { setProfile, openPeer, sendText } = await import("./helpers");
  try {
    await page.goto("/");
    await other.goto("/");
    await setProfile(page, "鉴权设备一");
    await setProfile(other, "鉴权设备二");
    await openPeer(page, "鉴权设备二");
    await sendText(page, "鉴权连接正常");
    await openPeer(other, "鉴权设备一");
    await expect(
      other.getByText("鉴权连接正常", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
