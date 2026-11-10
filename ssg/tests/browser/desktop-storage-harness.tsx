// Real storage UI + ChatEngine/desktop adapter. Rust storage tests exercise the actual filesystem.
import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { ChatEngine } from "../../src/core/engine";
import {
  DesktopStorageAdapter,
  type StorageInvoke,
} from "../../src/core/storage/desktop";
import { StoragePage } from "../../src/components/StoragePage";
import { i18n } from "../../src/i18n";
import { THEME_CONFIG } from "../../src/theme-config";
import "../../src/styles.css";
import "../../src/themes.css";

for (const [name, value] of Object.entries(THEME_CONFIG.options[0].colors))
  document.documentElement.style.setProperty(name, value);
document.documentElement.dataset.theme = "sky";

let directory = "/Users/test/Hummingbird/data";
let selected = "/Volumes/External/Hummingbird";
let failure = true;
let finish: (() => void) | undefined;
export const moves: string[] = [];
const info = () => ({ directory, usage: 4096, cacheUsage: 1024 });
const invoke = (async (request) => {
  if (request.op === "info") return info();
  if (request.op === "getFiles") return [];
  if (request.op === "move") {
    moves.push(String(request.directory));
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    if (failure) throw new Error("请选择空文件夹，避免覆盖已有数据");
    directory = String(request.directory);
    return info();
  }
  throw new Error(`Unexpected storage operation: ${request.op}`);
}) as StorageInvoke;
mockIPC((command) => {
  if (command === "plugin:dialog|open") return selected;
  throw new Error(`Unexpected command: ${command}`);
});
const profile = {
  id: "10000000-0000-4000-8000-000000000000",
  name: "Test",
  avatar: "🌿",
  color: "#123456",
  bio: "",
  device: "Mac",
  clientType: "app" as const,
};
const engine = new ChatEngine(new DesktopStorageAdapter(invoke), profile, []);
export function completeMove(fail: boolean) {
  failure = fail;
  finish?.();
}
export function select(path: string) {
  selected = path;
}
export function language(value: string) {
  return i18n.changeLanguage(value);
}
function Harness() {
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const [notice, setNotice] = useState("");
  return (
    <main style={{ maxWidth: 1000, margin: "30px auto", padding: 24 }}>
      <StoragePage engine={engine} snap={snap} onNotice={setNotice} />
      <div role="status">{notice}</div>
    </main>
  );
}
createRoot(document.getElementById("storage-test")!).render(<Harness />);
