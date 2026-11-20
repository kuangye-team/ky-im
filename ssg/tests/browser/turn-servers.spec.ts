import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./helpers";

const title = "中转服务器（TURN）";
const turnRows = (page: Page) => page.getByRole("list", { name: "中转服务器列表" }).getByRole("listitem");
const storedServers = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird.network")!).iceServers);
async function addTurn(page: Page, name: string, urls: string, enabled = true) {
  await page.getByRole("region", { name: title }).getByRole("button", { name: "添加服务器", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加服务器", exact: true });
  await dialog.getByLabel("服务器名称", { exact: true }).fill(name);
  await dialog.getByLabel("服务器地址", { exact: true }).fill(urls);
  await dialog.getByLabel("账号（如需要）", { exact: true }).fill("demo-user");
  await dialog.getByLabel("密码（如需要）", { exact: true }).fill(" demo-password ");
  await dialog.getByRole("checkbox", { name: "启用", exact: true }).setChecked(enabled);
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("中转服务器支持添加、编辑、启停、删除，并保留独立的直连辅助设置", async ({ page }) => {
  const credentialRequests: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/ws/ice") credentialRequests.push(request.url()); });
  await page.goto("/settings");
  const card = page.getByRole("region", { name: title });
  const stun = page.getByRole("region", { name: "辅助服务器（STUN）" });
  await expect(card.getByText("还没有中转服务器")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /使用服务器提供的辅助线路/ })).toHaveCount(0);
  await addTurn(page, "我的中转", "TURNS:Relay.Example:5349?transport=tcp");
  await expect(turnRows(page)).toHaveCount(1);
  await expect(turnRows(page).first()).toContainText("turns:relay.example:5349?transport=tcp");
  await expect(turnRows(page).first()).not.toContainText("demo-password");
  await page.reload();
  await expect(turnRows(page).first()).toContainText("我的中转");
  await page.getByRole("button", { name: "编辑中转服务器 1", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "编辑中转服务器", exact: true });
  await expect(editor.getByLabel("密码（如需要）", { exact: true })).toHaveAttribute("type", "password");
  await expect(editor.getByLabel("密码（如需要）", { exact: true })).toHaveValue(" demo-password ");
  await editor.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(editor.getByLabel("密码（如需要）", { exact: true })).toHaveAttribute("type", "text");
  await editor.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await editor.getByLabel("服务器名称", { exact: true }).fill("主用中转");
  await editor.getByLabel("服务器地址", { exact: true }).fill("turn:primary.example:3478?transport=udp");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toBeHidden();
  const enabled = page.getByRole("checkbox", { name: "启用中转服务器 1", exact: true });
  await enabled.click();
  await expect(enabled).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "启用中转服务器 1", exact: true })).not.toBeChecked();
  await expect.poll(async () => (await storedServers(page)).find((s: any) => s.urls.startsWith("turn:"))).toMatchObject({
    name: "主用中转", enabled: false, username: "demo-user", credential: " demo-password ",
  });
  await stun.getByRole("button", { name: "编辑辅助服务器 1", exact: true }).click();
  const stunEditor = page.getByRole("dialog", { name: "编辑辅助服务器", exact: true });
  await stunEditor.getByLabel("服务器地址", { exact: true }).fill("stun:custom.example:3478");
  await stunEditor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(stunEditor).toBeHidden();
  await stun.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect(turnRows(page)).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "启用中转服务器 1", exact: true })).not.toBeChecked();
  await addTurn(page, "备用中转", "turns:backup.example:443?transport=tcp");
  await expect(turnRows(page)).toHaveCount(2);
  await expect(card.getByRole("button", { name: "复制服务器地址" })).toHaveCount(2);
  await card.screenshot({ path: "../temp/screenshot/turn-servers-desktop.png", animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoHorizontalOverflow(page);
  await card.screenshot({ path: "../temp/screenshot/turn-servers-mobile.png", animations: "disabled" });
  await page.getByRole("button", { name: "删除中转服务器 1", exact: true }).click();
  await expect(turnRows(page)).toHaveCount(1);
  await page.reload();
  await expect(turnRows(page).first()).toContainText("备用中转");
  expect((await storedServers(page)).filter((s: any) => s.urls.startsWith("stun:"))).toHaveLength(4);
  expect(credentialRequests).toEqual([]);
});

test("当前版本的已保存 TURN 配置继续可用，地址校验和重复检查保留编辑内容", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("hummingbird.network", JSON.stringify({
      managedTurn: true,
      servers: [{ id: "default", name: "", url: "", enabled: true }],
      discovery: { signaling: true, mdns: false }, transport: { tcp: false, webrtc: true },
      iceServers: [{ urls: "turn:legacy.example:3478", username: "old-user", credential: "old-password" }],
    }));
  });
  await page.goto("/settings");
  await expect(turnRows(page)).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: "启用中转服务器 1", exact: true })).toBeChecked();
  await expect(page.getByRole("region", { name: "辅助服务器（STUN）" }).getByText("还没有辅助服务器")).toBeVisible();
  await page.getByRole("button", { name: "编辑中转服务器 1", exact: true }).click();
  let editor = page.getByRole("dialog", { name: "编辑中转服务器", exact: true });
  await expect(editor.getByLabel("账号（如需要）")).toHaveValue("old-user");
  await expect(editor.getByLabel("密码（如需要）")).toHaveValue("old-password");
  await editor.getByLabel("服务器名称", { exact: true }).fill("原有服务器");
  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await expect(editor).toBeHidden();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hummingbird.network")!))).not.toHaveProperty("managedTurn");
  await page.getByRole("region", { name: title }).getByRole("button", { name: "添加服务器", exact: true }).click();
  editor = page.getByRole("dialog", { name: "添加服务器", exact: true });
  await editor.getByLabel("服务器名称", { exact: true }).fill("待修正");
  await editor.getByLabel("服务器地址", { exact: true }).fill("stun:wrong.example");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("中转服务器地址需以");
  await editor.getByLabel("服务器地址", { exact: true }).fill("TURN:LEGACY.EXAMPLE:3478");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("已经添加过了");
  await expect(editor.getByLabel("服务器名称", { exact: true })).toHaveValue("待修正");
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("region", { name: title }).getByRole("button", { name: "添加服务器", exact: true })).toBeFocused();
});

test("中转测试只接受 relay 候选，支持取消且不会更改启用状态", async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as typeof window & { __turnProbes: any[] };
    state.__turnProbes = [];
    class Peer {
      onicecandidate: ((event: unknown) => void) | null = null;
      onicegatheringstatechange = null;
      closed = false;
      constructor(readonly configuration: RTCConfiguration) { state.__turnProbes.push(this); }
      createDataChannel() { return {}; }
      async createOffer() { return { type: "offer", sdp: "probe" }; }
      async setLocalDescription() {}
      close() { this.closed = true; }
    }
    window.RTCPeerConnection = Peer as unknown as typeof RTCPeerConnection;
  });
  await page.goto("/settings");
  await addTurn(page, "测试线路", "turn:probe.example:3478", false);
  const card = page.getByRole("region", { name: title });
  await page.getByRole("button", { name: "测试中转服务器 1", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__turnProbes.at(-1).configuration)).toEqual({
    iceServers: [{ urls: "turn:probe.example:3478", username: "demo-user", credential: " demo-password " }], iceTransportPolicy: "relay",
  });
  await page.evaluate(() => (window as any).__turnProbes.at(-1).onicecandidate({ candidate: { type: "srflx" } }));
  await expect(card.getByText("正在测试…", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__turnProbes.at(-1).onicecandidate({ candidate: { type: "relay" } }));
  await expect(card.getByText(/可用 ·/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "启用中转服务器 1", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "测试中转服务器 1", exact: true }).click();
  await card.getByRole("button", { name: "取消测试", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__turnProbes.every((p: any) => p.closed))).toBe(true);
  await page.getByRole("button", { name: "测试中转服务器 1", exact: true }).click();
  await page.evaluate(() => (window as any).__turnProbes.at(-1).onicecandidate({ candidate: null }));
  await expect(card.getByText("暂不可用，请检查地址和账号密码")).toBeVisible();
  await page.getByRole("button", { name: "测试中转服务器 1", exact: true }).click();
  await page.getByRole("button", { name: "聊天消息", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__turnProbes.every((p: any) => p.closed))).toBe(true);
});

test("中转配置保存失败时保留表单和原有设置", async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "hummingbird.network") throw Error("storage unavailable");
      original.call(this, key, value);
    };
  });
  await page.goto("/settings");
  await page.getByRole("region", { name: title }).getByRole("button", { name: "添加服务器", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "添加服务器", exact: true });
  await editor.getByLabel("服务器名称", { exact: true }).fill("保留表单");
  await editor.getByLabel("服务器地址", { exact: true }).fill("turn:save.example:3478");
  await editor.getByLabel("密码（如需要）", { exact: true }).fill("unchanged");
  await editor.getByRole("button", { name: "添加", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("设置未保存，请重试");
  await expect(editor.getByLabel("服务器名称", { exact: true })).toHaveValue("保留表单");
  await expect(editor.getByLabel("密码（如需要）", { exact: true })).toHaveValue("unchanged");
  expect(await page.evaluate(() => localStorage.getItem("hummingbird.network"))).toBeNull();
});
