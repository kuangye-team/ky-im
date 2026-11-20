const devices = ["Win", "Mac", "IOS", "Android", "Linux", "Harmony"] as const;
export type Device = typeof devices[number];
export type ClientType = "web" | "desktop" | "mobile";

export function isDevice(value: unknown): value is Device {
  return devices.some(device => device === value);
}

export function isClientType(value: unknown): value is ClientType {
  return value === "web" || value === "desktop" || value === "mobile";
}

export function isMobileDevice(device?: Device) {
  return device === "IOS" || device === "Android" || device === "Harmony";
}

export function nativeClientType(device?: Device) {
  return isMobileDevice(device) ? "mobile" : "desktop";
}

export function nativeTargetDevice(target?: string): Device | undefined {
  switch (target) {
    case "windows": return "Win";
    case "darwin": case "macos": return "Mac";
    case "ios": return "IOS";
    case "android": case "androideabi": return "Android";
    case "linux": return "Linux";
    case "ohos": return "Harmony";
  }
}

export type DeviceHints = {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { platform: string };
};

export function detectDevice(device?: DeviceHints): Device | undefined {
  if (!device) return;
  const hints = [device.userAgentData?.platform, device.platform, device.userAgent].join(" ");
  if (/Harmony|\bOHOS\b/i.test(hints)) return "Harmony";
  if (/Android/i.test(hints)) return "Android";
  // iPadOS in desktop mode reports a Mac platform and a multi-touch screen.
  if (/iPhone|iPad|iPod|\biOS\b/i.test(hints) || (/Mac/i.test(hints) && (device.maxTouchPoints ?? 0) > 1)) return "IOS";
  if (/Win32|Win64|Windows/i.test(hints)) return "Win";
  if (/Mac/i.test(hints)) return "Mac";
  if (/Linux/i.test(hints) && !/CrOS|Chrome OS/i.test(hints)) return "Linux";
}
