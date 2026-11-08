import { readFile } from "node:fs/promises";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  capture,
  closeContact,
  openContact,
  openPeer,
  enableAutoAcceptFiles,
  selectContactAction,
  sendText,
  setProfile,
} from "./helpers";

test("两个独立浏览器可发现、传输内容、更新资料，并保留离线历史", async ({
  browser,
  baseURL,
}) => {
  const aliceContext = await browser.newContext({
    locale: "zh-CN",
    acceptDownloads: true,
    viewport: { width: 1440, height: 980 },
  });
  const bobContext = await browser.newContext({
    locale: "zh-CN",
    acceptDownloads: true,
    viewport: { width: 1440, height: 980 },
  });
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();
  const pageErrors: string[] = [];
  for (const [label, page] of [
    ["alice", alice],
    ["bob", bob],
  ] as const) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    if (process.env.SEND_DEBUG) {
      page.on("websocket", (socket) => {
        if (!socket.url().includes("/api/ws")) return;
        socket.on("framesent", (frame) =>
          console.log(label, "sent", String(frame.payload)),
        );
        socket.on("framereceived", (frame) =>
          console.log(label, "received", String(frame.payload)),
        );
      });
      await page.addInitScript(() => {
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(config?: RTCConfiguration) {
            super(config);
            for (const event of [
              "connectionstatechange",
              "iceconnectionstatechange",
              "icegatheringstatechange",
              "signalingstatechange",
            ]) {
              this.addEventListener(event, () =>
                console.log(
                  "RTC",
                  event,
                  this.connectionState,
                  this.iceConnectionState,
                  this.iceGatheringState,
                  this.signalingState,
                ),
              );
            }
          }
        };
      });
      page.on("console", (message) => {
        if (message.text().startsWith("RTC"))
          console.log(label, message.text());
      });
    }
  }
  const unique = Date.now().toString(36);
  const aliceName = `Alice-${unique}`;
  const bobName = `Bob-${unique}`;
  let charlieContext: BrowserContext | undefined;

  try {
    await alice.goto(baseURL!);
    await expect(
      alice.getByRole("button", { name: "个人资料", exact: true }),
    ).toBeVisible();
    await capture(alice, "desktop-empty.png");
    await setProfile(alice, aliceName, "设计文件发送端");
    await bob.goto(baseURL!);
    await setProfile(bob, bobName, "设计文件接收端");
    await expect(
      alice.getByRole("button", { name: `与 ${bobName} 聊天`, exact: true }),
    ).toBeVisible();
    await expect(
      bob.getByRole("button", { name: `与 ${aliceName} 聊天`, exact: true }),
    ).toBeVisible();
    await openPeer(alice, bobName);
    await openPeer(bob, aliceName);
    await enableAutoAcceptFiles(bob);
    await enableAutoAcceptFiles(alice);

    const hello = `这是一条真实的 WebRTC 消息 ${unique}`;
    const reply = `收到，双向连接成功 ${unique}`;
    await sendText(alice, hello);
    await expect(bob.getByText(hello, { exact: true }).last()).toBeVisible();
    await sendText(bob, reply);
    await expect(alice.getByText(reply, { exact: true }).last()).toBeVisible();

    const fileName = `设计说明-${unique}.txt`;
    // Larger than one DataChannel chunk so the test exercises reassembly and backpressure.
    const fileContents = Buffer.from("局域网传输完整性验证\n".repeat(90_000));
    expect(fileContents.length).toBeGreaterThan(2 * 1024 * 1024);
    await alice.getByLabel("选择文件", { exact: true }).setInputFiles({
      name: fileName,
      mimeType: "text/plain",
      buffer: fileContents,
    });
    const receivedFile = bob.getByRole("button", {
      name: `下载 ${fileName}`,
      exact: true,
    });
    await expect(
      alice.getByRole("log").getByText("已送达", { exact: true }),
    ).toHaveCount(2);
    await expect(receivedFile).toBeVisible();
    const downloadPromise = bob.waitForEvent("download");
    await receivedFile.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(fileName);
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    expect(await readFile(downloadPath!)).toEqual(fileContents);

    const imageName = `局域网测试-${unique}.png`;
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
      "base64",
    );
    await bob
      .getByLabel("选择图片", { exact: true })
      .setInputFiles({ name: imageName, mimeType: "image/png", buffer: image });
    await expect(
      alice.getByRole("img", { name: imageName, exact: true }),
    ).toBeVisible();
    await expect(
      alice.getByRole("img", { name: imageName, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    await capture(alice, "desktop-chat.png");

    await alice.reload();
    await openPeer(alice, bobName);
    await expect(alice.getByText(hello, { exact: true }).last()).toBeVisible();
    await expect(alice.getByText(reply, { exact: true }).last()).toBeVisible();
    await expect(
      alice.getByRole("img", { name: imageName, exact: true }),
    ).toHaveJSProperty("naturalWidth", 1);
    // Receiver attachments must also survive a full reload, not only in-memory URLs.
    await bob.reload();
    await openPeer(bob, aliceName);
    await expect(
      bob.getByRole("button", { name: `下载 ${fileName}`, exact: true }),
    ).toBeVisible();
    const persistedDownloadPromise = bob.waitForEvent("download");
    await bob
      .getByRole("button", { name: `下载 ${fileName}`, exact: true })
      .click();
    const persistedDownload = await persistedDownloadPromise;
    expect(await readFile((await persistedDownload.path())!)).toEqual(
      fileContents,
    );

    const updatedBob = `Bob-新资料-${unique}`;
    await setProfile(bob, updatedBob, "资料已同步");
    await expect(
      alice.getByRole("button", { name: `与 ${updatedBob} 聊天`, exact: true }),
    ).toBeVisible();
    await bobContext.close();
    await alice.getByRole("button", { name: "在线设备", exact: true }).click();
    await expect(
      alice.getByRole("heading", { name: updatedBob, exact: true }),
    ).toHaveCount(0);
    await alice
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: /^聊天消息/ })
      .click();
    await alice.getByRole("button", { name: "最近聊天", exact: true }).click();
    await openPeer(alice, updatedBob);
    await expect(alice.getByText(hello, { exact: true }).last()).toBeVisible();
    await expect(alice.getByText(reply, { exact: true }).last()).toBeVisible();

    const sidebar = alice.getByRole("complementary", {
      name: "联系人资料",
      exact: true,
    });
    const contactDialog = alice.getByRole("dialog", {
      name: "联系人资料",
      exact: true,
    });
    await expect(sidebar).toBeVisible();
    await expect(contactDialog).toBeHidden();
    const detailsToggle = alice.getByRole("button", {
      name: "查看联系人资料",
      exact: true,
    });
    await detailsToggle.click();
    await expect(sidebar).toBeHidden();
    await expect(contactDialog).toBeHidden();
    await detailsToggle.click();
    await expect(sidebar).toBeVisible();
    await expect(contactDialog).toBeHidden();
    const contact = await openContact(alice);
    const actions = contact.getByRole("button", {
      name: "聊天操作",
      exact: true,
    });
    await actions.click();
    await expect(alice.getByRole("menu")).toBeVisible();
    await expect(alice.getByRole("menuitem")).toHaveCount(2);
    await capture(alice, "desktop-contact-menu.png");
    await alice.keyboard.press("Escape");
    await expect(alice.getByRole("menu")).toBeHidden();
    await expect(contact).toBeVisible();
    await expect(actions).toBeFocused();
    const exportPromise = alice.waitForEvent("download");
    await selectContactAction(alice, "导出文字记录");
    const exported = await exportPromise;
    const exportedData = JSON.parse(
      await readFile((await exported.path())!, "utf8"),
    );
    expect(exportedData.peer.name).toBe(updatedBob);
    expect(
      exportedData.messages.map((message: { text?: string }) => message.text),
    ).toEqual(expect.arrayContaining([hello, reply]));
    expect(
      exportedData.messages.map(
        (message: { fileName?: string }) => message.fileName,
      ),
    ).toContain(fileName);
    await expect(contact).toBeVisible();
    await closeContact(alice);

    // Keep a second conversation so deleting one can be checked independently
    // from clearing all remaining history.
    charlieContext = await browser.newContext({ locale: "zh-CN" });
    const charlie = await charlieContext.newPage();
    const charlieName = `Charlie-${unique}`;
    await charlie.goto(baseURL!);
    await setProfile(charlie, charlieName);
    await openPeer(charlie, aliceName);
    await openPeer(alice, charlieName);
    await sendText(alice, "这段会话稍后清空");
    await expect(
      charlie.getByText("这段会话稍后清空", { exact: true }),
    ).toBeVisible();
    await charlieContext.close();
    await openPeer(alice, updatedBob);
    await selectContactAction(alice, "删除聊天记录");
    const confirmation = alice.getByRole("dialog", {
      name: "删除这段聊天记录？",
      exact: true,
    });
    await expect(confirmation).toBeVisible();
    await confirmation
      .getByRole("button", { name: "取消", exact: true })
      .click();
    await closeContact(alice);
    await expect(alice.getByRole("log")).toContainText(hello);
    await selectContactAction(alice, "删除聊天记录");
    await confirmation
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(alice.getByRole("dialog")).toBeHidden();
    await expect(
      alice.getByRole("button", { name: `与 ${updatedBob} 聊天`, exact: true }),
    ).toHaveCount(0);
    await alice.reload();
    await expect(
      alice.getByRole("button", { name: "个人资料", exact: true }),
    ).toContainText(aliceName);
    await expect(
      alice.getByRole("button", { name: `与 ${updatedBob} 聊天`, exact: true }),
    ).toHaveCount(0);
    await expect(
      alice.getByRole("button", {
        name: `与 ${charlieName} 聊天`,
        exact: true,
      }),
    ).toBeVisible();
    await alice.getByRole("button", { name: "聊天记录", exact: true }).click();
    await alice.getByRole("button", { name: "清空记录", exact: true }).click();
    await alice
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除", exact: true })
      .click();
    await expect(alice.getByRole("dialog")).toBeHidden();
    await alice.reload();
    await expect(
      alice.getByRole("button", { name: "个人资料", exact: true }),
    ).toContainText(aliceName);
    await expect(
      alice.getByRole("button", {
        name: `与 ${charlieName} 聊天`,
        exact: true,
      }),
    ).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  } finally {
    await aliceContext.close();
    await bobContext.close();
    await charlieContext?.close();
  }
});
