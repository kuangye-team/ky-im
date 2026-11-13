import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { build } from "vite";
import { cloudflareEnv } from "./cloudflare-env";

const artifacts = fileURLToPath(new URL("../../temp/artifacts/", import.meta.url));
const directories: string[] = [];

function fixture(config: string) {
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(artifacts, "cloudflare-env-"));
  directories.push(root);
  writeFileSync(join(root, "wrangler.jsonc"), config);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("builds with Wrangler vars without leaking dotenv or process values into the browser", async () => {
  const root = fixture(`{
    // JSONC comments and trailing commas are supported.
    "vars": {
      "VITE_SIGNAL_URL": "wss://cloudflare.example.com/api/ws",
      "VITE_API_AUTH": "",
      "VITE_STORAGE_CHUNK_SIZE": 2097152,
      "VITE_FLAG": false,
      "VITE_NULL": null,
      "API_AUTH": "server-only",
    },
  }`);
  for (const name of [".env", ".env.local", ".env.production", ".env.cloudflare", ".env.cloudflare.local"])
    writeFileSync(join(root, name), "VITE_SIGNAL_URL=wss://dotenv.invalid\nVITE_API_AUTH=dotenv-key\nVITE_LOCAL_ONLY=dotenv-only\n");
  vi.stubEnv("VITE_SIGNAL_URL", "wss://inherited.invalid");
  vi.stubEnv("VITE_API_AUTH", "inherited-key");
  vi.stubEnv("VITE_PROCESS_ONLY", "inherited-only");
  writeFileSync(join(root, "entry.js"), "globalThis.result = { ...import.meta.env, url: import.meta.env.VITE_SIGNAL_URL };");
  const result = await build({
    configFile: false,
    root,
    mode: "cloudflare",
    ...cloudflareEnv(root),
    logLevel: "silent",
    build: { write: false, minify: false, lib: { entry: join(root, "entry.js"), formats: ["iife"], name: "Test" } },
  });
  const bundle = Array.isArray(result) ? result[0] : result;
  if (!("output" in bundle)) throw new Error("Expected build output");
  const chunk = bundle.output.find((output) => output.type === "chunk");
  if (!chunk) throw new Error("Expected JavaScript output");
  const context: { result?: Record<string, unknown> } = {};
  runInNewContext(chunk.code, context);
  expect(context.result).toMatchObject({
    VITE_SIGNAL_URL: "wss://cloudflare.example.com/api/ws",
    url: "wss://cloudflare.example.com/api/ws",
    VITE_API_AUTH: "",
    VITE_STORAGE_CHUNK_SIZE: "2097152",
    VITE_FLAG: "false",
    VITE_NULL: "",
  });
  for (const key of ["API_AUTH", "VITE_LOCAL_ONLY", "VITE_PROCESS_ONLY"])
    expect(context.result).not.toHaveProperty(key);
});

it.each(["{ broken", '{"vars":[]}', '{"vars":{"VITE_SIGNAL_URL":{}}}'])(
  "rejects invalid Wrangler configuration: %s", (config) => {
    expect(() => cloudflareEnv(fixture(config))).toThrow("ssg/wrangler.jsonc");
  },
);
