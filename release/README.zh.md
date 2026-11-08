# ky-im 发布包

[English](README.md) | 简体中文

从 GitHub Releases 下载 `ky-im-<版本>.tar.gz`，例如 `ky-im-0.2.20.tar.gz`，解压后即可启动网站与信令服务，无需安装 Node.js、Rust 或 Docker。另附同名 `.sha256` 文件用于校验下载内容。

## 目录结构

```text
docker/
  compose.yml
  .env.example
release/
  README.md
  README.zh.md
  start_win.bat
  start_linux.sh
  start_mac.sh
  .env.example
  dist/
  bin/
    server_darwin_amd64
    server_darwin_arm64
    server_linux_amd64
    server_linux_arm64
    server_windows_amd64.exe
LICENSE
```

## 在主机运行

将压缩包解压到有写入权限的目录。在解压目录执行对应命令，或在 Windows 双击 `release/start_win.bat`：

| 系统 | 启动命令 | 支持的架构 |
| --- | --- | --- |
| Windows | `.\release\start_win.bat` | x64 / amd64 |
| Linux | `sh release/start_linux.sh` | x64 / amd64、ARM64 |
| macOS | `sh release/start_mac.sh` | Intel、Apple Silicon |

Linux 和 macOS 脚本自动识别架构。

启动后访问 <http://localhost:8080>，终端显示运行日志；按 Ctrl+C 停止。局域网设备可访问 `http://主机IP:8080`，需允许该端口通过主机防火墙。对外部署时使用反向代理提供 HTTPS，并转发 `/api/ws` 的 WebSocket 连接。

首次启动自动复制 `release/.env.example` 为 `release/.env`；已有配置会被保留。编辑 `.env` 后重启服务生效。这套配置独立于源码仓库的 `.env.json`，无需执行 `npm run init`。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `BIND_ADDR` | `0.0.0.0:8080` | 网站和信令服务的监听地址、端口 |
| `STATIC_DIR` | `./dist` | 前端目录，相对路径以 `release/` 为基准 |
| `CORS_ORIGINS` | 空 | 默认仅允许网页同源访问；多个完整来源用逗号分隔 |
| `TRUST_PROXY_HEADERS` | `false` | 仅在受控反向代理后启用 |
| `MAX_CONNECTIONS` | `4096` | 最大连接数，范围 2–4096 |
| `MAX_ROOMS` | `256` | 最大发现组数，范围 1–256 |
| `MAX_PEERS_PER_ROOM` | `128` | 每组最大在线设备数，范围 2–512 |

`.env` 使用字面量 `KEY=value` 格式：不加引号、`export` 或行尾注释；注释独占一行并以 `#` 开头。值可包含空格。文件中的配置覆盖同名进程环境变量。前端已经构建为 `VITE_ROOM=local` 和同源信令地址，修改 `VITE_*` 需要从源码重新构建前端。

更新时先停止旧服务，将新版本解压到新目录，把旧的 `release/.env` 复制过去，再启动新版本。

## 使用 Docker

在解压目录执行：

```sh
cd docker
cp .env.example .env
docker compose pull
docker compose up -d
```

Windows 可使用 `copy .env.example .env`。已有 `.env` 时保留原文件。发布包内的示例默认使用本次发布的镜像版本；`IMAGE_NAME` 指定镜像仓库，`IMAGE_TAG` 指定版本，`SERVER_PORT` 指定主机端口。Docker 镜像由独立工作流发布，使用前需等待该工作流成功。停止服务执行 `docker compose down`。

## 从源码准备发布包

GitHub Actions 在推送 `v<主版本>.<次版本>.<补丁版本>` 标签时构建五个平台的二进制、前端及许可声明，验证各平台启动脚本后自动上传压缩包和校验文件到对应的 GitHub Release。镜像仓库可通过可选 Secret `DOCKERHUB_IMAGE` 配置，未设置时为 `kyteam/ky-im`。

本地打包需先将五个平台的实际编译产物放入 `release/bin/`，将构建好的前端（包括 `licenses/`）放入 `release/dist/`，然后在源码根目录执行：

```sh
node scripts/package-release.mjs v0.2.20
```

输出为 `artifacts/ky-im-0.2.20.tar.gz` 和 `.tar.gz.sha256`。脚本只复制指定的部署文件；不会包含本地的 `release/.env`、`docker/.env`。可运行 `node scripts/test-release.mjs` 验证本机对应的二进制、启动脚本、配置加载和网页服务。
