#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const DEV_ONLY = new Set(["WEB_PORT", "API_HOST"]);

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  return value;
}

function section(config, path) {
  let value = config;
  for (const part of path.split(".")) {
    value = object(value, path)[part] ?? {};
  }
  return object(value, path);
}

function envValues(values, label) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`${label} 中的变量名无效：${key}`);
    }
    if (
      value !== null &&
      !["string", "boolean", "number"].includes(typeof value)
    ) {
      throw new TypeError(`${label}.${key} 必须是字符串、数字、布尔值或 null`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${label}.${key} 必须是有限数字`);
    }
  }
  return values;
}

function formatEnvValue(value) {
  const text = value === null ? "" : String(value);
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(text) ? text : JSON.stringify(text);
}

export function renderEnv(template, overrides, excluded = new Set()) {
  envValues(overrides, "环境配置");
  const eol = template.includes("\r\n") ? "\r\n" : "\n";
  const lines = template.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const output = [];
  const seen = new Set();

  for (const line of lines) {
    const match = line.match(ENV_LINE);
    if (!match) {
      output.push(line);
      continue;
    }
    const key = match[1];
    if (excluded.has(key)) {
      // 同时去掉紧邻变量的说明，避免正式构建文件残留开发代理说明。
      while (output.at(-1)?.trimStart().startsWith("#")) output.pop();
      continue;
    }
    seen.add(key);
    // 未覆盖的模板值原样保留，避免给已有引号再次加引号。
    output.push(Object.hasOwn(overrides, key) ? `${key}=${formatEnvValue(overrides[key])}` : line);
  }

  const extra = Object.keys(overrides).filter((key) => !seen.has(key) && !excluded.has(key));
  if (extra.length && output.length && output.at(-1) !== "") output.push("");
  for (const key of extra) output.push(`${key}=${formatEnvValue(overrides[key])}`);
  while (output[0] === "") output.shift();
  return output.length ? `${output.join(eol)}${eol}` : "";
}

export function renderWrangler(template, overrides) {
  const errors = [];
  const parsed = parse(template, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`Wrangler 模板格式错误：${printParseErrorCode(errors[0].error)}`);
  }
  object(parsed, "Wrangler 模板");
  object(parsed.vars ?? {}, "Wrangler vars");
  envValues(overrides, "Wrangler vars");
  // 仅修改顶层 vars，保留 JSONC 注释、尾随逗号和部署配置。
  let result = template;
  for (const [key, value] of Object.entries(overrides)) {
    result = applyEdits(result, modify(result, ["vars", key], value, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: template.includes("\r\n") ? "\r\n" : "\n",
      },
    }));
  }
  return result;
}

export function initEnv(root = ROOT) {
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  let config;
  try {
    config = object(JSON.parse(read(".env.json")), ".env.json 顶层");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("缺少 .env.json，请先复制 .env.json.example 并按需修改。");
    }
    throw error;
  }

  const files = [];
  const env = (template, output, values, excluded) => {
    files.push([output, renderEnv(read(template), values, excluded)]);
  };

  // Compose 的 build.args 从根目录 .env 取值；前端配置只在 compose.ssg 维护。
  env(".env.example", ".env", {
    ...section(config, "compose.root"),
    ...section(config, "compose.ssg"),
  }, DEV_ONLY);
  for (const mode of ["local", "production", "compose"]) {
    env("api/.env.example", `api/.env.${mode}`, section(config, `${mode}.api`));
    env("ssg/.env.example", `ssg/.env.${mode}`, section(config, `${mode}.ssg`),
      mode === "local" ? new Set() : DEV_ONLY);
  }
  for (const app of ["api", "ssg"]) {
    files.push([
      `${app}/wrangler.jsonc`,
      renderWrangler(read(`${app}/wrangler.jsonc.example`), section(config, `wrangler.${app}`)),
    ]);
  }
  // 所有模板和配置检查通过后再写入，避免格式错误导致只更新了一部分文件。
  for (const [path, content] of files) writeFileSync(resolve(root, path), content, "utf8");
  return files.map(([path]) => path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const path of initEnv()) console.log(`generated ${path}`);
  } catch (error) {
    console.error(`init-env failed: ${error.message}`);
    process.exitCode = 1;
  }
}
