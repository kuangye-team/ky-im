import { emit, TauriEvent } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

export const actions: string[] = [];
export const requestClose = () => emit(TauriEvent.WINDOW_CLOSE_REQUESTED);
let failHide = false;
export function failNextHide() { failHide = true; }

mockWindows("main");
mockIPC((command, args) => {
  if (["plugin:window|hide", "plugin:window|destroy", "plugin:process|exit"].includes(command)) {
    actions.push(command);
    if (command === "plugin:window|hide" && failHide) {
      failHide = false;
      throw new Error("Window unavailable");
    }
  }
  if (command === "storage_request") {
    const { op } = args!.request as { op: string };
    if (op === "getConversations" || op === "getPeerProfiles") return [];
  }
  if (command === "plugin:app|version") return "0.1.0";
}, { shouldMockEvents: true });
