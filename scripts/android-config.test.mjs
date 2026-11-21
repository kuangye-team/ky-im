import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";
import { androidEnv, withAndroidSigning } from "./android-config.mjs";

const example = JSON.parse(readFileSync(new URL("../.env.json.example", import.meta.url), "utf8"));
const signing = {
  ANDROID_KEY_BASE64: Buffer.from("test keystore").toString("base64"),
  ANDROID_KEY_ALIAS: "release",
  ANDROID_KEY_PASSWORD: "test password",
};
const release = { release: true };

test("the example lists the signing settings and explains missing release credentials", () => {
  for (const key of [...Object.keys(signing), "RELEASE_VERSION"]) {
    assert.equal(example.android.app[key], "");
  }
  assert.throws(() => androidEnv(example, {}, release), /android\.app.*ANDROID_KEY_BASE64.*ANDROID_KEY_ALIAS.*ANDROID_KEY_PASSWORD.*--debug/);
});

test("Android uses local release settings and non-empty environment overrides", () => {
  const app = { ...signing, RELEASE_VERSION: "v1.2.3" };
  const settings = { ...example, android: { app } };
  const env = androidEnv(settings, {
    ANDROID_KEY_ALIAS: "CI",
    ANDROID_KEY_PASSWORD: "",
  }, release);
  assert.equal(env.ANDROID_KEY_BASE64, signing.ANDROID_KEY_BASE64);
  assert.equal(env.ANDROID_KEY_ALIAS, "CI");
  assert.equal(env.ANDROID_KEY_PASSWORD, signing.ANDROID_KEY_PASSWORD);
  assert.equal(env.RELEASE_VERSION, "v1.2.3");
  assert.equal(env.VITE_SIGNAL_URL, example.production.ssg.VITE_SIGNAL_URL);
});

test("a CI release can use only environment variables and requires a WSS address", () => {
  const env = { ...signing, VITE_SIGNAL_URL: "wss://ci.example.com/ws" };
  assert.deepEqual(androidEnv({}, env, release), env);
  assert.throws(() => androidEnv({}, { ...env, VITE_SIGNAL_URL: "ws://localhost" }, release), /production\.ssg.*VITE_SIGNAL_URL/);
});

test("debug accepts existing config files without an Android section", () => {
  const settings = { production: { ssg: { VITE_SIGNAL_URL: "ws://localhost", VITE_SHOW_TRANSFER_SPEED: false } } };
  assert.deepEqual(androidEnv(settings, {}, { release: false }), { VITE_SIGNAL_URL: "ws://localhost", VITE_SHOW_TRANSFER_SPEED: "false" });
});

test("release signing decodes wrapped Base64 privately and cleans up after success or failure", async () => {
  for (const fails of [true, false]) {
    let file;
    const env = { ...signing, ANDROID_KEY_BASE64: signing.ANDROID_KEY_BASE64.match(/.{1,4}/g).join("\n") };
    const build = withAndroidSigning(env, true, async childEnv => {
      assert.equal(childEnv.ANDROID_KEY_BASE64, undefined);
      file = childEnv.KY_IM_ANDROID_SIGNING_FILE;
      assert.equal(readFileSync(file, "utf8"), "test keystore");
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
      if (fails) throw new Error("build failed");
      return 0;
    });
    if (fails) await assert.rejects(build, /build failed/);
    else assert.equal(await build, 0);
    assert.equal(existsSync(file), false);
  }
});

test("invalid Base64 stops before building and debug never receives the signing file or Base64", async () => {
  const env = { ANDROID_KEY_BASE64: "%%invalid%%", KY_IM_ANDROID_SIGNING_FILE: "/unrelated" };
  await assert.rejects(withAndroidSigning(env, true, () => assert.fail("unexpected build")), /ANDROID_KEY_BASE64/);
  await withAndroidSigning(env, false, childEnv => assert.deepEqual(childEnv, {}));
});
