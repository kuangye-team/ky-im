import type { MouseEvent } from "react";
import { isDesktop } from "./core/network/settings";

export async function openExternalUrl(url: string): Promise<void> {
  if (!["https:", "http:", "mailto:"].includes(new URL(url).protocol))
    throw new Error("Unsupported external URL");
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/** Route public links, including portal content, through the desktop system opener. */
export function handleExternalLinkClick(event: MouseEvent<HTMLElement>, onError: () => void) {
  if (!isDesktop() || event.defaultPrevented || event.button > 1) return;
  const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!anchor || anchor.hasAttribute("download") || !/^(https?:|mailto:)/i.test(anchor.href)) return;
  // Internal routes retain normal router behavior.
  if (anchor.origin === window.location.origin && anchor.protocol !== "mailto:") return;
  event.preventDefault();
  void openExternalUrl(anchor.href).catch(onError);
}
