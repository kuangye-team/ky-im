import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// npm also invokes prepare during installation; license generation is manual.
if (
  process.env.npm_lifecycle_event === "prepare" &&
  !["run", "run-script"].includes(process.env.npm_command)
) {
  console.log("许可声明未自动生成；安装前端依赖后，可手动运行 npm run prepare。");
  process.exit(0);
}

const root = fileURLToPath(new URL("../ssg/", import.meta.url));
const output = resolve(root, "public/licenses");
const entries = [];
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function add(entry, text) {
  if (!text.trim()) throw new Error(`Missing license text: ${entry.name}`);
  entries.push({ ...entry, text });
}

// Include the frontend's runtime dependency tree, including nested package versions.
const visited = new Set();
async function collect(name, parent) {
  const require = createRequire(parent);
  let directory;
  try {
    directory = dirname(require.resolve(`${name}/package.json`));
  } catch {
    directory = dirname(require.resolve(name));
  }
  let pkg;
  while (true) {
    try {
      pkg = await json(resolve(directory, "package.json"));
      if (pkg.name === name) break;
    } catch {
      /* Walk up from packages that hide package.json in their exports. */
    }
    const next = dirname(directory);
    if (next === directory) throw new Error(`Cannot locate package ${name}`);
    directory = next;
  }
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  const files = (await readdir(directory))
    .filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
    .sort();
  // This package declares MIT but omits LICENSE. See licenses/web/sources.json
  // for the upstream license snapshot; this is not a source-version assertion.
  const fallback =
    key === "react-remove-scroll-bar@2.3.8"
      ? resolve(root, "licenses/web/react-remove-scroll-bar-2.3.8.txt")
      : null;
  if (!files.length && !fallback)
    throw new Error(`Missing runtime dependency license: ${key}`);
  const text = files.length
    ? (
        await Promise.all(
          files.map(
            async (file) =>
              `${file}\n\n${await readFile(resolve(directory, file), "utf8")}`,
          ),
        )
      ).join("\n\n")
    : await readFile(fallback, "utf8");
  const repo =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const url = repo
    ?.replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  await add(
    {
      id: key.replace(/[^a-zA-Z0-9._-]/g, "-"),
      name: pkg.name,
      version: pkg.version,
      license: pkg.license || "见许可原文",
      group: "web",
      projectUrl: url?.startsWith("https://")
        ? url
        : `https://www.npmjs.com/package/${pkg.name}`,
    },
    text,
  );
  for (const dependency of Object.keys(pkg.dependencies || {}).sort())
    await collect(dependency, resolve(directory, "package.json"));
}
const app = await json(resolve(root, "package.json"));
for (const name of Object.keys(app.dependencies).sort())
  await collect(name, resolve(root, "package.json"));

await writeFile(
  resolve(output, "index.json"),
  JSON.stringify({ entries }) + "\n",
);
console.log(`已整理 ${entries.length} 项第三方组件的许可声明。`);
