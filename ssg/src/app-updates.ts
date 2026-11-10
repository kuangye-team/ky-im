import { isDesktop } from "./core/network/settings";
import type { ChatEngine } from "./core";
import { saveChatDrafts } from "./drafts";
import * as desktop from "./desktop-updates";
import * as web from "./pwa";

export const { startAppUpdates, getAppUpdate, subscribeAppUpdate, dismissAppUpdate, applyAppUpdate } =
  isDesktop() ? desktop : web;

export function beforeAppUpdate(engine: ChatEngine): string | null {
  if (engine.hasPendingTransfers()) return "内容传输中，请完成后再更新。";
  if (!saveChatDrafts()) return "未发送的文字暂时无法保存，请发送或复制后再更新。";
  return null;
}
