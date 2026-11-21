import { invoke } from "@tauri-apps/api/core";

let prompt: Promise<boolean> | undefined;

export function nearbyPermission(mode: "check" | "automatic" | "manual"): Promise<boolean> {
  if (mode === "check") return invoke("request_nearby", { mode });
  return prompt ??= invoke<boolean>("request_nearby", { mode }).finally(() => { prompt = undefined; });
}
