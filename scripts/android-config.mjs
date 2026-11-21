import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requiredSigningKeys = ["ANDROID_KEY_BASE64", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"];

export function androidEnv(settings, processEnv, { release }) {
  const env = { ...processEnv };
  for (const [key, value] of Object.entries(settings.production?.ssg ?? {})) {
    if (key.startsWith("VITE_") && !env[key]?.trim() && value != null) env[key] = String(value);
  }

  const app = settings.android?.app ?? {};
  const keys = release ? ["RELEASE_VERSION", ...requiredSigningKeys] : ["RELEASE_VERSION"];
  for (const key of keys) {
    if (!env[key]?.trim() && typeof app[key] === "string" && app[key].trim()) env[key] = app[key];
  }
  if (!release) return env;

  const missing = requiredSigningKeys.filter((key) => !env[key]?.trim());
  if (missing.length) {
    throw new Error(`请在 .env.json 的 android.app 或环境变量中填写正式签名配置：${missing.join("、")}。本机测试可运行 npm run android:build -- --debug。`);
  }
  if (URL.parse(env.VITE_SIGNAL_URL)?.protocol !== "wss:") {
    throw new Error("请在 .env.json 的 production.ssg 或环境变量中将 VITE_SIGNAL_URL 设为 wss:// 开头的正式服务地址。");
  }
  return env;
}

export async function withAndroidSigning(env, release, build) {
  const { ANDROID_KEY_BASE64: encoded, ...childEnv } = env;
  delete childEnv.KY_IM_ANDROID_SIGNING_FILE;
  if (!release) return build(childEnv);

  const base64 = encoded.replace(/\s/g, "");
  const key = Buffer.from(base64, "base64");
  const canonical = key.toString("base64");
  if (!key.length || (base64 !== canonical && base64 !== canonical.replace(/=+$/, ""))) {
    throw new Error("ANDROID_KEY_BASE64 需要填写完整的签名密钥库 Base64。");
  }
  const directory = mkdtempSync(join(tmpdir(), "ky-im-android-signing-"));
  try {
    const path = join(directory, "release.keystore");
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
    return await build({ ...childEnv, KY_IM_ANDROID_SIGNING_FILE: path });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
