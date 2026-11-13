// Exercise the production updater and dialogs, mocking only the native boundary.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import type { ChatEngine } from "../../src/core";
import { UpdateBanner } from "../../src/components/UpdateBanner";
import { DesktopVersion } from "../../src/components/DesktopVersion";
import { DesktopUpdateDialog } from "../../src/components/DesktopUpdateDialog";
import { Modal } from "../../src/components/Modal";
import { checkDesktopUpdate } from "../../src/desktop-updates";
import { i18n } from "../../src/i18n";
import { THEME_CONFIG } from "../../src/theme-config";
import "../../src/styles.css";
import "../../src/themes.css";

for (const [name, value] of Object.entries(THEME_CONFIG.options[0].colors))
  document.documentElement.style.setProperty(name, value);
document.documentElement.dataset.theme = "sky";

export const calls: string[] = [];
let channel: Channel<DownloadEvent>;
let finishDownload: () => void;
let failDownload: (reason: string) => void;
let finishInstall: () => void;
let nextRid = 10;
mockIPC((command, args) => {
  calls.push(command);
  if (command === "plugin:app|version") return "1.0.0";
  if (command === "plugin:updater|check") return { rid: 1, version: "1.1.0", currentVersion: "1.0.0", rawJson: {} };
  if (command === "prepare_update_download") return nextRid++;
  if (command === "download_update") {
    channel = args!.onEvent as Channel<DownloadEvent>;
    return new Promise<void>((resolve, reject) => { finishDownload = resolve; failDownload = reject; });
  }
  if (command === "plugin:resources|close") { failDownload?.("Update cancelled"); return; }
  if (command === "install_update") return new Promise<void>((resolve) => { finishInstall = resolve; });
  if (command === "plugin:process|restart") return;
  throw new Error(`Unexpected command: ${command}`);
});
export function progress(total: number | null, received: number) {
  channel.onmessage({ event: "Started", data: { contentLength: total ?? undefined } });
  channel.onmessage({ event: "Progress", data: { chunkLength: received } });
}
export function completeDownload() { channel.onmessage({ event: "Finished" }); finishDownload(); }
export function completeInstall() { finishInstall(); }
export function fail() { failDownload("Signature verification failed"); }
export function language(value: string) { return i18n.changeLanguage(value); }

const snapshot = {};
const engine = { hasPendingTransfers: () => false, subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as ChatEngine;
function Harness() {
  const [about, setAbout] = useState(false);
  return <main className="app-shell">
    <header className="topbar"><span className="brand">蜂鸟</span><button className="secondary-button" onClick={() => setAbout(true)}>关于蜂鸟</button></header>
    <UpdateBanner engine={engine} />
    <label>消息内容<input className="form-input" aria-label="消息内容" placeholder="发送消息…" /></label>
    <DesktopUpdateDialog />
    <Modal open={about} onClose={() => setAbout(false)} title="关于蜂鸟"><DesktopVersion engine={engine} /></Modal>
  </main>;
}
createRoot(document.getElementById("update-test")!).render(<Harness />);
void checkDesktopUpdate();
