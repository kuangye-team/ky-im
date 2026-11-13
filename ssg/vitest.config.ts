import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ cacheDir: fileURLToPath(new URL("../temp/cache/vitest", import.meta.url)), test: { include: ["src/**/*.test.ts", "build/**/*.test.ts"] } });
