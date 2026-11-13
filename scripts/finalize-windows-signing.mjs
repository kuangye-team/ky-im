import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopEnv, root } from "./desktop-config.mjs";
import { releaseVersion, writeManifest } from "./desktop-release.mjs";

// Authenticode changes the installer bytes. Sign the returned file again for
// Tauri before replacing the original installer/signature pair in app/dist.
export function finalizeWindowsSigning(signedDirectory, output, version, env) {
  version = releaseVersion(version);
  const name = `ky-im-${version}-windows-x64-setup.exe`;
  const installer = resolve(signedDirectory, name);
  if (!statSync(installer, { throwIfNoEntry: false })?.isFile() || !statSync(installer).size)
    throw new Error(`Missing or empty SignPath installer: ${installer}`);
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error("TAURI_SIGNING_PRIVATE_KEY is required");
  const key = env.TAURI_SIGNING_PRIVATE_KEY;
  rmSync(`${installer}.sig`, { force: true });
  const result = spawnSync(process.execPath, [resolve(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "signer", "sign", "--app-version", version, installer], {
    cwd: root, stdio: "inherit", env: {
      ...env,
      TAURI_SIGNING_PRIVATE_KEY: existsSync(key) ? readFileSync(key, "utf8") : key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || "",
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Failed to sign the SignPath installer for Tauri updates");
  // Validate the new signature and create matching metadata before promotion.
  writeManifest(signedDirectory, version, env, false, "x86_64-pc-windows-msvc");
  const files = [name, `${name}.sig`];
  for (const file of [...files]) {
    const digest = createHash("sha256").update(readFileSync(resolve(signedDirectory, file))).digest("hex");
    writeFileSync(resolve(signedDirectory, `${file}.sha256`), `${digest}  ${file}\n`);
    files.push(`${file}.sha256`);
  }
  mkdirSync(output, { recursive: true });
  for (const file of [...files, "latest.json"])
    copyFileSync(resolve(signedDirectory, file), resolve(output, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [signedDirectory] = process.argv.slice(2);
    if (!signedDirectory) throw new Error("Usage: finalize-windows-signing.mjs <signed-directory>");
    const env = desktopEnv();
    finalizeWindowsSigning(signedDirectory, resolve(root, "app/dist"), env.RELEASE_VERSION || env.RELEASE_TAG, env);
    console.log("Updated Windows installer, updater signature, checksums, and manifest");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
