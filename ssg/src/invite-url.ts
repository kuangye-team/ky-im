import { INVITE_CONFIG, SIGNALING_CONFIG } from "./config";

export function getInviteUrl(pageOrigin: string): string {
  if (!import.meta.env.VITE_DESKTOP) return pageOrigin;

  try {
    const url = new URL(SIGNALING_CONFIG.url);
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    else return INVITE_CONFIG.fallbackUrl;
    return url.origin;
  } catch {
    return INVITE_CONFIG.fallbackUrl;
  }
}
