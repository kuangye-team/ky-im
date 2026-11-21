import { fetchClientRelease } from "./client-downloads";

export type AndroidUpdate =
  | { status: "unpublished" | "current" }
  | { status: "available"; version: string; url: string };

// Use the same numeric ordering and limits as the APK's versionCode.
function versionCode(version: string) {
  const parts = /^v?(\d+)\.(\d{1,3})\.(\d{1,3})$/.exec(version.trim());
  if (!parts) throw new Error("Invalid Android version");
  const code = Number(parts[1]) * 1_000_000 + Number(parts[2]) * 1000 + Number(parts[3]);
  if (code < 1 || code > 2_100_000_000) throw new Error("Invalid Android version");
  return code;
}

export async function checkAndroidUpdate(installedVersion: string): Promise<AndroidUpdate> {
  const { version, downloads } = await fetchClientRelease();
  if (!downloads.android) return { status: "unpublished" };
  if (versionCode(version) <= versionCode(installedVersion)) return { status: "current" };
  return { status: "available", version: version.trim().replace(/^v/, ""), url: downloads.android };
}
