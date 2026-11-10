import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseEnv } from "node:util";
import { desktopEnv, root as projectRoot, updaterConfig } from "./desktop-config.mjs";
import { initEnv } from "./init-env.mjs";
import {
  collectArtifacts,
  releaseVersion,
  targetInfo,
  writeManifest,
} from "./desktop-release.mjs";

function envFixture() {
  const directory = mkdtempSync(join(tmpdir(), "hummingbird-env-"));
  for (const app of ["app", "api", "ssg"]) mkdirSync(join(directory, app));
  for (const file of [".env.example", "app/.env.example", "api/.env.example", "ssg/.env.example",
    "api/wrangler.jsonc.example", "ssg/wrangler.jsonc.example"])
    writeFileSync(join(directory, file), readFileSync(join(projectRoot, file)));
  const config = JSON.parse(readFileSync(join(projectRoot, ".env.json.example"), "utf8"));
  return { directory, config };
}

test("central configuration covers template variables and generates desktop env files", () => {
  const { directory, config } = envFixture();
  try {
    const templateKeys = (file) => [...readFileSync(join(directory, file), "utf8")
      .matchAll(/^(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    for (const key of templateKeys("app/.env.example"))
      assert.ok(Object.hasOwn(config.desktop.app, key), `desktop.app is missing ${key}`);
    for (const mode of ["local", "production", "compose"]) {
      for (const key of templateKeys("api/.env.example"))
        assert.ok(Object.hasOwn(config[mode].api, key), `${mode}.api is missing ${key}`);
      for (const key of templateKeys("ssg/.env.example")) {
        if (key === "API_HOST" || (mode !== "local" && key === "WEB_PORT")) continue;
        assert.ok(Object.hasOwn(config[mode].ssg, key), `${mode}.ssg is missing ${key}`);
      }
    }
    for (const key of templateKeys(".env.example"))
      assert.ok(Object.hasOwn({ ...config.compose.root, ...config.compose.ssg }, key), `compose is missing ${key}`);
    for (const key of templateKeys("ssg/.env.example").filter((key) => !["WEB_PORT", "API_HOST"].includes(key)))
      assert.ok(Object.hasOwn(config.desktop.ssg, key), `desktop.ssg is missing ${key}`);
    config.desktop.app.TAURI_UPDATER_PUBLIC_KEY = "test-public-key";
    config.desktop.app.TAURI_SIGNING_PRIVATE_KEY = "/secure folder/hummingbird.key";
    config.desktop.app.APPLE_SIGNING_IDENTITY = "Developer ID Application: Test (TEAMID)";
    config.desktop.ssg.VITE_SIGNAL_URL = "wss://desktop.example.com/api/ws";
    config.desktop.ssg.VITE_API_AUTH = "desktop-test-key";
    writeFileSync(join(directory, ".env.json"), JSON.stringify(config));
    const outputs = initEnv(directory);
    assert.ok(outputs.includes("app/.env"));
    assert.ok(outputs.includes("ssg/.env.desktop"));
    const env = desktopEnv(directory, { TAURI_UPDATER_PUBLIC_KEY: "process-public-key" });
    assert.equal(env.TAURI_UPDATER_PUBLIC_KEY, "process-public-key");
    assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, config.desktop.app.TAURI_SIGNING_PRIVATE_KEY);
    assert.equal(env.APPLE_SIGNING_IDENTITY, config.desktop.app.APPLE_SIGNING_IDENTITY);
    assert.equal(updaterConfig(env, true).bundle.createUpdaterArtifacts, true);
    const frontend = parseEnv(readFileSync(join(directory, "ssg/.env.desktop"), "utf8"));
    assert.equal(frontend.VITE_SIGNAL_URL, config.desktop.ssg.VITE_SIGNAL_URL);
    assert.equal(frontend.VITE_API_AUTH, config.desktop.ssg.VITE_API_AUTH);
    for (const mode of ["local", "production", "compose"]) {
      const generated = parseEnv(readFileSync(join(directory, `ssg/.env.${mode}`), "utf8"));
      assert.equal(generated.VITE_API_AUTH, config[mode].ssg.VITE_API_AUTH);
    }
    const compose = parseEnv(readFileSync(join(directory, ".env"), "utf8"));
    assert.equal(compose.VITE_API_AUTH, config.compose.ssg.VITE_API_AUTH);
    assert.equal(frontend.WEB_PORT, undefined);
    assert.equal(frontend.API_HOST, "http://127.0.0.1:8080");
    assert.equal(frontend.VITE_STORAGE_CHUNK_SIZE, "2097152");
    assert.equal(frontend.TAURI_SIGNING_PRIVATE_KEY, undefined);
    config.desktop.app.RELEASE_VERSION = "2.3.4";
    writeFileSync(join(directory, ".env.json"), JSON.stringify(config));
    assert.equal(desktopEnv(directory, {}).RELEASE_VERSION, "2.3.4");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("desktop commands support CI env and preserve legacy files without desktop sections", () => {
  const { directory, config } = envFixture();
  try {
    const signing = { TAURI_UPDATER_PUBLIC_KEY: "public", TAURI_SIGNING_PRIVATE_KEY: "private" };
    assert.equal(updaterConfig(desktopEnv(directory, signing), true).bundle.createUpdaterArtifacts, true);
    assert.equal(existsSync(join(directory, "app/.env")), false);
    writeFileSync(join(directory, "app/.env"), "RELEASE_VERSION=1.2.3\n");
    delete config.desktop;
    writeFileSync(join(directory, ".env.json"), JSON.stringify(config));
    initEnv(directory);
    assert.equal(desktopEnv(directory, {}).RELEASE_VERSION, "1.2.3");
    assert.equal(existsSync(join(directory, "ssg/.env.desktop")), false);
    writeFileSync(join(directory, ".env.json"), "bad json");
    assert.throws(() => desktopEnv(directory, {}), SyntaxError);
    assert.equal(readFileSync(join(directory, "app/.env"), "utf8"), "RELEASE_VERSION=1.2.3\n");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("versions and release targets fail closed", () => {
  assert.equal(releaseVersion("v1.2.3"), "1.2.3");
  for (const value of ["main", "v1.2", "1.2.3/../../x", "1.2.3-beta"])
    assert.throws(() => releaseVersion(value));
  assert.equal(targetInfo("universal-apple-darwin").bundles, "app,dmg");
  assert.throws(() => targetInfo(""));
});

test("publishes the current Windows installer directly and preserves its updater payload", () => {
  const root = mkdtempSync(join(tmpdir(), "hummingbird-release-"));
  try {
    mkdirSync(join(root, "bundle/nsis"), { recursive: true });
    writeFileSync(
      join(root, "bundle/nsis/Ky IM_0.9.0_x64-setup.exe"),
      "stale",
    );
    const collect = () =>
      collectArtifacts(
        join(root, "bundle"),
        join(root, "dist"),
        "x86_64-pc-windows-msvc",
        "v1.2.3",
      );
    assert.throws(collect, /Missing release artifact/);
    writeFileSync(
      join(root, "bundle/nsis/Ky IM_1.2.3_x64-setup.exe"),
      "current",
    );
    assert.throws(collect, /Missing release artifact/);
    writeFileSync(join(root, "bundle/nsis/Ky IM_1.2.3_x64-setup.exe.sig"), signature);
    const names = collect();
    assert.deepEqual(names, [
      "ky-im-1.2.3-windows-x64-setup.exe",
      "ky-im-1.2.3-windows-x64-setup.exe.sig",
    ]);
    assert.deepEqual(readdirSync(join(root, "dist")).sort(), names.flatMap((name) => [name, `${name}.sha256`]).sort());
    const [name] = names;
    assert.equal(readFileSync(join(root, "dist", name), "utf8"), "current");
    assert.equal(readFileSync(join(root, "dist", `${name}.sig`), "utf8"), signature);
    verifyChecksums(join(root, "dist"), names);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const signature = Buffer.from("untrusted comment: test signature\nfixture").toString("base64");
function verifyChecksums(directory, names) {
  for (const name of names) {
    const digest = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
    assert.equal(readFileSync(join(directory, `${name}.sha256`), "utf8"), `${digest}  ${name}\n`);
  }
}
test("release builds require signing and secure updater endpoints", () => {
  const env = { TAURI_UPDATER_URL: "https://example.com/latest.json", TAURI_UPDATER_PUBLIC_KEY: "public", TAURI_SIGNING_PRIVATE_KEY: "private" };
  assert.equal(updaterConfig(env, true).bundle.createUpdaterArtifacts, true);
  for (const key of Object.keys(env)) assert.throws(() => updaterConfig({ ...env, [key]: "" }, true), /require/);
  for (const url of ["http://example.com/latest.json", "https://user:pass@example.com", "https://example.com/#key"])
    assert.throws(() => updaterConfig({ ...env, TAURI_UPDATER_URL: url }, true), /HTTPS/);
  assert.deepEqual(updaterConfig({}, false).plugins.updater.endpoints, []);
});
test("publishes the macOS DMG directly, preserves signed update bytes and assembles all platform entries", () => {
  const root = mkdtempSync(join(tmpdir(), "hummingbird-updater-"));
  try {
    mkdirSync(join(root, "bundle/dmg"), { recursive: true });
    mkdirSync(join(root, "bundle/macos"));
    writeFileSync(join(root, "bundle/macos/Ky IM.app.tar.gz"), "signed archive bytes");
    writeFileSync(join(root, "bundle/macos/Ky IM.app.tar.gz.sig"), signature);
    const directory = join(root, "dist");
    assert.throws(() => collectArtifacts(join(root, "bundle"), directory, "universal-apple-darwin", "1.2.3"), /Missing release artifact: dmg\//);
    writeFileSync(join(root, "bundle/dmg/Ky IM_1.2.3_universal.dmg"), "dmg");
    const names = collectArtifacts(join(root, "bundle"), directory, "universal-apple-darwin", "1.2.3");
    assert.deepEqual(names, [
      "ky-im-1.2.3-macos-universal.dmg",
      "ky-im-1.2.3-macos-universal.app.tar.gz",
      "ky-im-1.2.3-macos-universal.app.tar.gz.sig",
    ]);
    assert.deepEqual(readdirSync(directory).sort(), names.flatMap((name) => [name, `${name}.sha256`]).sort());
    assert.equal(readFileSync(join(directory, names[0]), "utf8"), "dmg");
    assert.equal(readFileSync(join(directory, names[1]), "utf8"), "signed archive bytes");
    assert.equal(readFileSync(join(directory, names[2]), "utf8"), signature);
    verifyChecksums(directory, names);
    const env = { GITHUB_REPOSITORY: "example/hummingbird" };
    assert.throws(() => writeManifest(directory, "1.2.3", env), /Missing/);
    const partial = writeManifest(directory, "1.2.3", env, false, "universal-apple-darwin");
    assert.deepEqual(Object.keys(partial.platforms), ["darwin-aarch64", "darwin-x86_64"]);
    assert.equal(partial.platforms["darwin-aarch64"].url, "https://github.com/example/hummingbird/releases/download/v1.2.3/ky-im-1.2.3-macos-universal.app.tar.gz");
    const exe = "ky-im-1.2.3-windows-x64-setup.exe";
    mkdirSync(join(root, "bundle/nsis"));
    writeFileSync(join(root, "bundle/nsis/Ky IM_1.2.3_x64-setup.exe"), "installer");
    writeFileSync(join(root, "bundle/nsis/Ky IM_1.2.3_x64-setup.exe.sig"), signature);
    collectArtifacts(join(root, "bundle"), directory, "x86_64-pc-windows-msvc", "1.2.3");
    const manifest = writeManifest(directory, "v1.2.3", env);
    assert.equal(manifest.platforms["windows-x86_64"].url, `https://github.com/example/hummingbird/releases/download/v1.2.3/${exe}`);
    assert.equal(manifest.platforms["darwin-aarch64"].signature, signature);
    assert.equal(manifest.platforms["darwin-aarch64"].url, manifest.platforms["darwin-x86_64"].url);
    assert.equal(manifest.notes, "Ky IM 1.2.3");
    assert.deepEqual(JSON.parse(readFileSync(join(directory, "latest.json"), "utf8")), manifest);
    rmSync(join(directory, names[0]));
    assert.throws(() => writeManifest(directory, "1.2.3", env), /Missing or empty update artifact: .*\.dmg/);
    writeFileSync(join(directory, names[0]), "dmg");
    writeFileSync(join(directory, `${exe}.sig`), "invalid");
    assert.throws(() => writeManifest(directory, "1.2.3", env), /Invalid updater signature/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
