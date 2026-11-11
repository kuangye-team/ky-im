import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initEnv } from "./init-env.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export function desktopEnv(projectRoot = root, processEnv = process.env) {
  initEnv(projectRoot, { desktopOnly: true });
  const path = resolve(projectRoot, "app/.env");
  return {
    ...parseEnv(readFileSync(resolve(projectRoot, "app/.env.example"), "utf8")),
    ...(existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {}),
    ...processEnv,
  };
}
export function httpsUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(`${name} must be an HTTPS URL without credentials or a fragment`);
  return url.href;
}
export function updaterConfig(env, release) {
  const endpoint = env.TAURI_UPDATER_URL?.trim();
  const pubkey = env.TAURI_UPDATER_PUBLIC_KEY?.trim();
  if (release && (!endpoint || !pubkey || !env.TAURI_SIGNING_PRIVATE_KEY?.trim()))
    throw new Error("Release builds require TAURI_UPDATER_URL, TAURI_UPDATER_PUBLIC_KEY and TAURI_SIGNING_PRIVATE_KEY. Configure desktop.app in .env.json (see .env.json.example), or set process environment variables.");
  if (endpoint) httpsUrl(endpoint, "TAURI_UPDATER_URL");
  return {
    bundle: { createUpdaterArtifacts: release },
    plugins: { updater: { endpoints: endpoint && pubkey ? [endpoint] : [], pubkey: pubkey || "" } },
  };
}
