import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import type { UserConfig } from "vite";

export function cloudflareEnv(root: string): Pick<UserConfig, "envDir" | "envPrefix" | "define"> {
  const errors: ParseError[] = [];
  const config = parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length || !config || typeof config !== "object" || Array.isArray(config))
    throw new Error("ssg/wrangler.jsonc 格式错误，请检查后重新构建。");
  const vars = config.vars ?? {};
  if (typeof vars !== "object" || Array.isArray(vars))
    throw new Error("ssg/wrangler.jsonc 的 vars 必须是对象。");
  const define: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!/^VITE_[A-Za-z0-9_]+$/.test(key)) continue;
    if (value !== null && !["string", "boolean", "number"].includes(typeof value))
      throw new Error(`ssg/wrangler.jsonc 的 ${key} 必须是字符串、数字、布尔值或 null。`);
    define[`import.meta.env.${key}`] = JSON.stringify(value === null ? "" : String(value));
  }
  // Wrangler 会将 .env.local 加入进程环境；Cloudflare 构建只使用 vars。
  return { envDir: false, envPrefix: [], define };
}
