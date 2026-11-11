import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopEnv, httpsUrl, root } from "./desktop-config.mjs";

const { productName } = JSON.parse(readFileSync(resolve(root, "app/tauri.conf.json"), "utf8"));

export function releaseVersion(value) {
  const version = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(value || "")?.[1];
  if (!version) throw new Error("Release version must be x.y.z or vx.y.z");
  return version;
}

export function targetInfo(target) {
  const targets = {
    "universal-apple-darwin": {
      platform: "macos",
      arch: "universal",
      bundles: "app,dmg",
    },
    "aarch64-apple-darwin": {
      platform: "macos",
      arch: "aarch64",
      bundles: "app,dmg",
    },
    "x86_64-apple-darwin": {
      platform: "macos",
      arch: "x64",
      bundles: "app,dmg",
    },
    "x86_64-pc-windows-msvc": {
      platform: "windows",
      arch: "x64",
      bundles: "nsis",
    },
  };
  if (!targets[target])
    throw new Error(`Unsupported desktop release target: ${target}`);
  return targets[target];
}

export function collectArtifacts(bundleDir, output, target, version) {
  version = releaseVersion(version);
  const { platform, arch } = targetInfo(target);
  const prefix = `ky-im-${version}-${platform}-${arch}`;
  const installer = platform === "macos"
    ? `dmg/${productName}_${version}_${arch}.dmg`
    : `nsis/${productName}_${version}_x64-setup.exe`;
  const sources =
    platform === "macos"
      ? [
          [installer, `${prefix}.dmg`],
          [`macos/${productName}.app.tar.gz`, `${prefix}.app.tar.gz`],
          [`macos/${productName}.app.tar.gz.sig`, `${prefix}.app.tar.gz.sig`],
        ]
      : [
          [installer, `${prefix}-setup.exe`],
          [`${installer}.sig`, `${prefix}-setup.exe.sig`],
        ];
  // Exact product/version paths prevent silently publishing stale bundles.
  for (const [source] of sources) {
    const info = statSync(resolve(bundleDir, source), { throwIfNoEntry: false });
    if (!info?.isFile() || !info.size)
      throw new Error(`Missing release artifact: ${source}`);
  }
  mkdirSync(output, { recursive: true });
  // Copy installers, updater payloads and signatures unchanged; Windows updates use the EXE directly.
  const names = [];
  for (const [source, name] of sources) {
    copyFileSync(resolve(bundleDir, source), resolve(output, name));
    names.push(name);
  }
  for (const name of names) {
    const digest = createHash("sha256")
      .update(readFileSync(resolve(output, name)))
      .digest("hex");
    writeFileSync(resolve(output, `${name}.sha256`), `${digest}  ${name}\n`);
  }
  return names;
}

// The macOS archive must be copied byte-for-byte: repacking invalidates its signature.
export function writeManifest(directory, version, env, complete = true, target) {
  version = releaseVersion(version);
  const repository = env.GITHUB_REPOSITORY || "kuangye-team/ky-im";
  const base = httpsUrl(env.TAURI_RELEASE_BASE_URL?.trim() ||
    `https://github.com/${repository}/releases/download/v${version}`, "TAURI_RELEASE_BASE_URL");
  if (new URL(base).search) throw new Error("TAURI_RELEASE_BASE_URL must be a directory URL without a query");
  const targets = complete ? ["universal-apple-darwin", "x86_64-pc-windows-msvc"] : [target];
  const platforms = {};
  const downloads = {};
  for (const target of targets) {
    const { platform, arch } = targetInfo(target);
    const prefix = `ky-im-${version}-${platform}-${arch}`;
    const mac = platform === "macos";
    const name = `${prefix}${mac ? ".app.tar.gz" : "-setup.exe"}`;
    const installer = mac ? `${prefix}.dmg` : name;
    for (const file of new Set([name, installer, `${name}.sig`])) {
      const info = statSync(resolve(directory, file), { throwIfNoEntry: false });
      if (!info?.isFile() || !info.size) throw new Error(`Missing or empty update artifact: ${file}`);
    }
    const signature = readFileSync(resolve(directory, `${name}.sig`), "utf8").trim();
    if (!Buffer.from(signature, "base64").toString("utf8").startsWith("untrusted comment:"))
      throw new Error(`Invalid updater signature: ${name}.sig`);
    downloads[platform] = `${base.replace(/\/$/, "")}/${installer}`;
    const entry = { signature, url: `${base.replace(/\/$/, "")}/${name}` };
    const keys = mac ? (arch === "universal" ? ["darwin-aarch64", "darwin-x86_64"] : [arch === "aarch64" ? "darwin-aarch64" : "darwin-x86_64"]) : ["windows-x86_64"];
    for (const key of keys) platforms[key] = entry;
  }
  const manifest = { version, notes: env.RELEASE_NOTES || `${productName} ${version}`, pub_date: new Date().toISOString(), platforms, downloads };
  writeFileSync(resolve(directory, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = desktopEnv();
    writeManifest(resolve(root, "app/dist"), env.RELEASE_VERSION || JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version, env);
    console.log("Generated app/dist/latest.json for macOS universal and Windows x64");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
