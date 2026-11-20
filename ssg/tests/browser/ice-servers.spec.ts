import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

const card = (page: Page) => page.getByRole("region", { name: "辅助服务器（STUN）", exact: true });
const rows = (page: Page) => card(page).getByRole("list", { name: "辅助服务器列表" }).getByRole("listitem");
const storedServers = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird.network")!).iceServers);
async function openAdd(page: Page) {
  await card(page).getByRole("button", { name: "添加服务器", exact: true }).click();
  return page.getByRole("dialog", { name: "添加服务器", exact: true });
}

async function mockProbes(page: Page) {
  await page.addInitScript(() => {
    const state = window as typeof window & { __probes: FakePeer[] };
    state.__probes = [];
    class FakePeer {
      onicecandidate: ((event: unknown) => void) | null = null;
      onicegatheringstatechange = null;
      closed = false;
      constructor(readonly configuration?: RTCConfiguration) {
        if (configuration?.iceServers?.length) state.__probes.push(this);
      }
      createDataChannel() { return {}; }
      async createOffer() { return { type: "offer", sdp: "test" }; }
      async setLocalDescription() {}
      close() { this.closed = true; }
    }
    window.RTCPeerConnection = FakePeer as unknown as typeof RTCPeerConnection;
  });
}

test("辅助服务器支持逐项添加、编辑、启停、删除和恢复默认", async ({ page }) => {
  await page.goto("/settings");
  const defaults = [
    "stun:stun.miwifi.com:3478", "stun:stun.chat.bilibili.com:3478",
    "stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302",
  ];
  await expect(rows(page)).toHaveCount(4);
  for (const [index, address] of defaults.entries()) await expect(rows(page).nth(index)).toContainText(address);
  await expect(card(page).getByRole("textbox")).toHaveCount(0);
  const editor = await openAdd(page);
  await expect(editor.getByLabel("服务器名称", { exact: true })).toBeFocused();
  await editor.getByLabel("服务器名称", { exact: true }).fill("我的辅助服务器");
  await editor.getByLabel("服务器地址", { exact: true }).fill("turn:wrong.example:3478");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("辅助服务器地址需以 stun:");
  await editor.getByLabel("服务器地址", { exact: true }).fill("STUN:STUN.MIWIFI.COM:3478");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("已经添加过了");
  await expect(editor.getByLabel("服务器名称", { exact: true })).toHaveValue("我的辅助服务器");
  await editor.getByLabel("服务器地址", { exact: true }).fill("STUN:Custom.Example:3478");
  await editor.getByLabel("账号（如需要）", { exact: true }).fill("demo-user");
  await editor.getByLabel("密码（如需要）", { exact: true }).fill(" secret password ");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(rows(page)).toHaveCount(5);
  await page.reload();
  await expect(rows(page).last()).toContainText("我的辅助服务器");
  await expect(rows(page).last()).not.toContainText("secret password");
  await card(page).getByRole("button", { name: "编辑辅助服务器 5", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "编辑辅助服务器", exact: true });
  await expect(edit.getByLabel("服务器地址", { exact: true })).toHaveValue("stun:custom.example:3478");
  await expect(edit.getByLabel("账号（如需要）", { exact: true })).toHaveValue("demo-user");
  await expect(edit.getByLabel("密码（如需要）", { exact: true })).toHaveValue(" secret password ");
  await expect(edit.getByLabel("密码（如需要）", { exact: true })).toHaveAttribute("type", "password");
  await edit.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(edit.getByLabel("密码（如需要）", { exact: true })).toHaveAttribute("type", "text");
  await edit.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await edit.getByLabel("服务器名称", { exact: true }).fill("备用辅助服务器");
  await edit.getByLabel("服务器地址", { exact: true }).fill("stuns:backup.example:5349");
  await edit.getByRole("checkbox", { name: "启用", exact: true }).uncheck();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: "../temp/screenshot/settings-ice-editor-mobile.png", animations: "disabled" });
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await expect(edit).toBeHidden();
  await page.reload();
  await expect(card(page).getByRole("checkbox", { name: "启用辅助服务器 5", exact: true })).not.toBeChecked();
  expect((await storedServers(page)).at(-1)).toEqual({
    urls: "stuns:backup.example:5349", name: "备用辅助服务器", enabled: false, username: "demo-user", credential: " secret password ",
  });
  const enabled = card(page).getByRole("checkbox", { name: "启用辅助服务器 5", exact: true });
  await enabled.click();
  await expect(enabled).toBeChecked();
  await expect.poll(async () => (await storedServers(page)).at(-1).enabled).toBe(true);
  await expect(card(page).getByRole("button", { name: "复制服务器地址" })).toHaveCount(5);
  await expectNoHorizontalOverflow(page);
  await card(page).evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "../temp/screenshot/settings-ice-mobile.png", animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 980 });
  await card(page).screenshot({ path: "../temp/screenshot/settings-ice-desktop.png", animations: "disabled" });
  for (let remaining = 5; remaining > 0; remaining--) {
    await card(page).getByRole("button", { name: "删除辅助服务器 1", exact: true }).click();
    await expect(rows(page)).toHaveCount(remaining - 1);
  }
  await page.reload();
  await expect(card(page).getByText("还没有辅助服务器")).toBeVisible();
  await expect(card(page).getByRole("button", { name: "测试全部", exact: true })).toBeDisabled();
  expect(await storedServers(page)).toEqual([]);
  await card(page).getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  expect((await storedServers(page)).map((server: any) => server.urls)).toEqual(defaults);
});

test("辅助服务器同时测试，首个成功立即显示，其余可取消并关闭", async ({ page }) => {
  await mockProbes(page);
  await page.goto("/settings");
  await card(page).getByRole("button", { name: "测试全部", exact: true }).click();
  await expect(rows(page)).toHaveCount(4);
  expect(await page.evaluate(() => (window as any).__probes.length)).toBe(4);
  await page.evaluate(() => {
    (window as any).__probes[0].onicecandidate({ candidate: { type: "host" } });
    (window as any).__probes[1].onicecandidate({ candidate: { type: "srflx" } });
  });
  await expect(card(page).getByText(/率先响应/)).toBeVisible();
  await expect(card(page).getByText("正在测试…", { exact: true })).toHaveCount(3);
  await card(page).screenshot({ path: "../temp/screenshot/settings-ice-race.png", animations: "disabled" });
  await card(page).getByRole("button", { name: "取消测试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__probes.every((p: any) => p.closed))).toBe(true);
  await card(page).getByRole("button", { name: "测试全部", exact: true }).click();
  await page.getByRole("button", { name: "聊天消息", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__probes.every((p: any) => p.closed))).toBe(true);
});

test("逐项测试携带辅助服务器账号密码，保留停用状态并在网络变化时清除结果", async ({ page }) => {
  await mockProbes(page);
  await page.goto("/settings");
  const editor = await openAdd(page);
  await editor.getByLabel("服务器名称", { exact: true }).fill("测试线路");
  await editor.getByLabel("服务器地址", { exact: true }).fill("stun:probe.example:3478");
  await editor.getByLabel("账号（如需要）", { exact: true }).fill("probe-user");
  await editor.getByLabel("密码（如需要）", { exact: true }).fill(" probe-secret ");
  await editor.getByRole("checkbox", { name: "启用", exact: true }).uncheck();
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor).toBeHidden();
  const probe = card(page).getByRole("button", { name: "测试辅助服务器 5", exact: true });
  await probe.click();
  expect(await page.evaluate(() => (window as any).__probes.at(-1).configuration)).toEqual({
    iceServers: [{ urls: "stun:probe.example:3478", username: "probe-user", credential: " probe-secret " }], iceTransportPolicy: "all",
  });
  await page.evaluate(() => (window as any).__probes.at(-1).onicecandidate({ candidate: { type: "host" } }));
  await expect(rows(page).last()).toContainText("正在测试…");
  await page.evaluate(() => (window as any).__probes.at(-1).onicecandidate({ candidate: { type: "srflx" } }));
  await expect(rows(page).last()).toContainText(/可用 ·/);
  await expect(card(page).getByRole("checkbox", { name: "启用辅助服务器 5", exact: true })).not.toBeChecked();
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(rows(page).last()).toContainText("已停用");
  await probe.click();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(rows(page).last()).toContainText("已停用");
  await expect.poll(() => page.evaluate(() => (window as any).__probes.every((p: any) => p.closed))).toBe(true);
});

test("辅助服务器保存失败时保留表单和原有设置", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hummingbird.network") throw Error("storage unavailable");
      original.call(this, key, value);
    };
  });
  await page.goto("/settings");
  const editor = await openAdd(page);
  await editor.getByLabel("服务器名称", { exact: true }).fill("待保存服务器");
  await editor.getByLabel("服务器地址", { exact: true }).fill("stun:retry.test:3478");
  await editor.getByLabel("密码（如需要）", { exact: true }).fill("keep-this");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("设置未保存，请重试");
  await expect(editor.getByLabel("服务器地址", { exact: true })).toHaveValue("stun:retry.test:3478");
  await expect(editor.getByLabel("密码（如需要）", { exact: true })).toHaveValue("keep-this");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(card(page).getByRole("button", { name: "添加服务器", exact: true })).toBeFocused();
  await page.reload();
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).first()).toContainText("stun:stun.miwifi.com:3478");
});

test("辅助和中转服务器共享数量上限，恢复默认失败时保留两份列表", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hummingbird.network", JSON.stringify({
    servers: [{ id: "default", name: "", url: "", enabled: true }],
    discovery: { signaling: true, mdns: false }, transport: { tcp: false, webrtc: true },
    iceServers: [{ urls: "stun:custom.example" }, ...Array.from({ length: 15 }, (_, i) => ({ urls: `turn:relay-${i}.example` }))],
  })));
  await page.goto("/settings");
  const relay = page.getByRole("region", { name: "中转服务器（TURN）", exact: true });
  await expect(card(page).getByRole("button", { name: "添加服务器", exact: true })).toBeDisabled();
  await expect(relay.getByRole("button", { name: "添加服务器", exact: true })).toBeDisabled();
  await card(page).getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(card(page).getByRole("alert")).toContainText("最多可添加 16 个");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("stun:custom.example");
  await expect(relay.getByRole("listitem")).toHaveCount(15);
});
