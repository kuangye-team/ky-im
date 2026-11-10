import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = /^v?(\d+\.\d+\.\d+)$/.exec(process.argv[2] || "")?.[1];
if (!version) throw new Error("Usage: node scripts/package-release.mjs <version, e.g. v0.2.20>");

const binaries = [
  "server_darwin_amd64",
  "server_darwin_arm64",
  "server_linux_amd64",
  "server_linux_arm64",
  "server_windows_amd64.exe",
];
const source = resolve(process.argv[3] || join(root, "release"));
const output = resolve(process.argv[4] || join(root, "artifacts"));
// Fail before writing an archive if any platform or essential frontend file is missing.
for (const path of [
  ...binaries.map((name) => `bin/${name}`),
  "dist/index.html",
  "dist/licenses/index.json",
]) {
  const info = await stat(join(source, path));
  if (!info.isFile() || !info.size) throw new Error(`Missing or empty release input: ${path}`);
}

const staging = await mkdtemp(join(tmpdir(), "ky-im-package-"));
try {
  await mkdir(join(staging, "release/bin"), { recursive: true });
  await mkdir(join(staging, "docker"));
  // Copy an explicit allowlist. Local .env files, old binaries and archives stay out.
  for (const path of [
    "docker/compose.yml",
    "docker/.env.example",
    "release/.env.example",
    "release/start_win.bat",
    "release/start_linux.sh",
    "release/start_mac.sh",
    "LICENSE",
  ]) {
    await copyFile(join(root, path), join(staging, path));
  }
  for (const name of binaries) {
    const destination = join(staging, "release/bin", name);
    await copyFile(join(source, "bin", name), destination);
    await chmod(destination, 0o755);
  }
  for (const name of ["start_linux.sh", "start_mac.sh"]) {
    await chmod(join(staging, "release", name), 0o755);
  }
  // Always ship a cmd.exe-compatible batch file, regardless of the packaging host.
  const batch = join(staging, "release/start_win.bat");
  await writeFile(batch, (await readFile(batch, "utf8")).replace(/\r?\n/g, "\r\n"));
  await cp(join(source, "dist"), join(staging, "release/dist"), { recursive: true });

  const imageName = process.env.IMAGE_NAME || "kyteam/ky-im";
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(imageName)) {
    throw new Error("IMAGE_NAME must be a Docker Hub repository without a tag");
  }
  const dockerEnv = join(staging, "docker/.env.example");
  await writeFile(dockerEnv, (await readFile(dockerEnv, "utf8"))
    .replace(/^IMAGE_NAME=.*$/m, `IMAGE_NAME=${imageName}`)
    .replace(/^IMAGE_TAG=.*$/m, `IMAGE_TAG=v${version}`));

  await mkdir(output, { recursive: true });
  const filename = `ky-im-${version}-bin.tar.gz`;
  const archive = join(output, filename);
  execFileSync("tar", ["-czf", archive, "-C", staging, "docker", "release", "LICENSE"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "inherit",
  });
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${filename}\n`);
  console.log(`Created ${archive} and SHA-256 checksum`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
