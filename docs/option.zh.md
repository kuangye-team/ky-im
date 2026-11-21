# 配置参考

[English](option.md) | 简体中文 · [项目首页](../README.zh.md)

## 选择配置文件

从源码开发或部署时，首次将 `.env.json.example` 复制为 `.env.json`。编辑对应部署方式的分区后，在仓库根目录运行 `npm run init`。初始化脚本用分区中的值覆盖模板，并重新生成下表中的文件。需要长期保留的修改写在 JSON 或源模板中。[统一配置示例](../.env.json.example)

| 部署方式 | `.env.json` 分区 | 生成文件与生效时机 |
| --- | --- | --- |
| 本地开发 | `local.api`、`local.ssg` | `api/.env.local` 供 API 使用，`ssg/.env.local` 供 Vite 开发服务使用。 |
| 原生服务与正式网页 | `production.api`、`production.ssg` | `api/.env.production` 用于原生构建和预览，`ssg/.env.production` 用于网页构建。 |
| 从源码构建 Docker 镜像 | `compose.root`、`compose.api`、`compose.ssg` | 根目录 `.env` 汇总宿主机端口、npm 镜像源和前端构建参数。`api/.env.compose` 供容器内的服务启动时读取。初始化脚本还会生成 `ssg/.env.compose`。 |
| 桌面客户端 | `desktop.app`、`desktop.ssg` | `app/.env` 配置打包，`ssg/.env.desktop` 配置前端。桌面命令会刷新这两个文件，进程环境变量优先。 |
| Android 客户端 | `android.app`、`production.ssg` | Android 命令直接读取版本、签名和前端配置。非空环境变量优先。 |
| Cloudflare | `wrangler.api`、`wrangler.ssg` | `api/wrangler.jsonc` 为 Worker 提供运行时变量。Cloudflare 模式的前端构建读取 `ssg/wrangler.jsonc` 中的 `vars`。 |

使用 **Docker 预构建镜像**时，将 `docker/.env.example` 复制为 `docker/.env`。修改后在 `docker/` 目录运行 `docker compose up -d`。使用**服务端发布包**时，启动脚本会在首次运行时创建 `release/.env`。每行写一个 `KEY=value`，值按原文读取，省略引号、`export` 和行尾注释。修改后重启服务。这两个文件均独立于 `npm run init` 管理。[Docker 模板](../docker/.env.example) · [服务端发布包模板](../release/.env.example)

## 信令服务

原生服务在启动时读取这些参数。同一参数在不同部署示例中取值有差异时，表中分别列出。[API 模板](../api/.env.example)

| 参数 | 取值与作用 |
| --- | --- |
| `BIND_ADDR` | 原生 HTTP 和 WebSocket 的监听地址。本地开发和正式部署的源码示例使用 `127.0.0.1:8080`，容器和发布包使用 `0.0.0.0:8080`。 |
| `STATIC_DIR` | 网页静态资源目录。可填绝对路径，相对路径以服务启动目录为准。从 `api/` 启动的源码示例使用 `../ssg/dist`，Docker 使用 `/app/static`，发布包使用 `./dist`。 |
| `CORS_ORIGINS` | 允许的网页来源，以逗号分隔，每项只写来源，省略路径和末尾斜杠。分开部署时加入网页来源，如 `https://chat.example.com`。模板已列出桌面 WebView 的来源。 |
| `API_AUTH` | 可选的完整访问凭据，例如 `Bearer your-key`。留空时无需密钥。统一配置中的演示密钥请在部署前替换或清空。配置后，客户端在首条 WebSocket 消息中鉴权，访问 `/api/health/details` 需要携带认证头。网页和 `/api/health` 仍然公开。 |
| `TRUST_PROXY_HEADERS` | 在反向代理后使用转发的来源 IP 对设备分组。源码示例为 `true`，预构建镜像和发布包模板为 `false`。仅在受控代理后启用，限制对源站的直接访问，并让代理清除或覆盖包括 `Forwarded` 在内的来源 IP 转发头。Workers 使用 Cloudflare 提供的来源 IP。 |
| `RELAY_ENABLED` | 默认为 `false`。开启后，双方可在同一服务器上共同启用加密中转。 |
| `MAX_CONNECTIONS` | 原生服务的连接数上限，含等待注册的连接。范围 2–4096，源码及发布包示例为 4096。在 Workers 上用于全站健康快照告警。 |
| `MAX_ROOMS` | 原生服务的发现组数量上限。范围 1–256，源码及发布包示例为 256。在 Workers 上用于全站健康快照告警。 |
| `MAX_PEERS_PER_ROOM` | 每个发现房间、每个号码组各自的设备数量上限。默认为 128，原生服务范围为 2–512，Workers 每组最多允许 128 台。 |
| `LATEST_JSON_URL` | `/api/latest` 使用的上游桌面发布清单，默认指向本项目 GitHub 上的 `releases/latest/download/latest.json`。 |

对外提供原生服务时，通过 HTTPS 发布网页，将 `/api` 转发到服务端，并允许 `/api/ws` 升级为 WebSocket。例如，网页在 `https://chat.example.com`、API 在 `https://signal.example.com` 时，客户端的 `VITE_SIGNAL_URL` 填 `wss://signal.example.com/api/ws`，API 的 `CORS_ORIGINS` 加入 `https://chat.example.com`。

## 网页与桌面客户端

前端在构建时写入 `VITE_*` 的值。修改默认配置后，需重新构建网页、镜像或桌面安装包。随客户端分发的预设访问密钥和 TURN 密码可从产物中读取，通过 CI Secret 提供的值也一样。用户可以在各自设备上调整信令和 ICE 服务器配置。[前端模板](../ssg/.env.example)

| 参数 | 取值与作用 |
| --- | --- |
| `VITE_SIGNAL_URL` | 默认信令 WebSocket 地址。留空时，网页连接同源 `/api/ws`，桌面安装包连接 `ws://127.0.0.1:8080/api/ws`。统一示例的正式网页、桌面和 Worker 分区预填了托管地址。 |
| `VITE_API_AUTH` | 默认信令服务器的预设密钥，同源部署也适用。需随客户端预设时填写完整的 `API_AUTH` 值，也可留空并在各设备上配置。 |
| `VITE_ROOM` | 发现命名空间，默认为 `local`，允许 1–64 个 ASCII 字母、数字、下划线或连字符。自动发现按命名空间和服务端观察到的来源 IP 分组。访问控制需单独配置。 |
| `VITE_ICE_SERVERS` | 逗号分隔的 STUN/TURN 地址。未设置时使用小米、哔哩哔哩、Cloudflare、Google 的 STUN 服务，显式设为空字符串会停用外部 ICE 服务器。带凭据的示例为 `turn:turn.example.com:3478?u=user&p=password`，特殊字符需做 URL 编码。 |
| `VITE_API_LATEST` | 发布清单地址，默认为 `/api/latest`。若填写其他来源的完整 URL，该来源需允许跨域请求。 |
| `VITE_WEB_URL` | 网页公开地址，也用于生成备用邀请链接，默认为 `https://im.kuangye.team/`。 |
| `VITE_CLIENT_DOWNLOAD_URL` | 桌面客户端下载页，默认为本仓库的 GitHub 最新发布页。 |
| `VITE_P2P_ANNOUNCE_LOOPBACK` | 默认为 `false`。同机测试时在 `.env.json` 的 `desktop.ssg` 中设为 `true`，重新启动桌面开发进程或重新构建，即可公告回环地址。桌面按网卡掩码过滤 IPv4 子网地址和广播地址，保留合法的 `.0` 主机地址。 |
| `VITE_PEER_CHECK_INTERVAL_MS` | 列表设备的探测间隔，默认 10000 毫秒，范围 1000–300000 毫秒。 |
| `VITE_SHOW_TRANSFER_SPEED` | 默认为 `true`。设为 `false` 可隐藏传输速度。 |
| `WEB_PORT`、`API_HOST` | Vite 开发端口及 `/api` 的开发代理目标，默认为 `5173` 和 `http://127.0.0.1:8080`。桌面开发端口固定为 `1420`。 |

### 文件与 WebRTC 参数

下表大小均以字节为单位，分别控制本地文件读写、文件正文分块和 WebRTC 消息。[文件传输设计](arch.zh.md#文件传输职责与数据边界)

| 参数 | 默认值 | 作用 |
| --- | ---: | --- |
| `VITE_RTC_MAX_MESSAGE_SIZE` | 65536 | 单条 WebRTC 消息的上限，范围 1–131072。发送时还受双方能力及 SCTP 协商值约束。 |
| `VITE_RTC_MAX_BUFFERED_AMOUNT` | 1048576 | WebRTC 发送队列高水位，应至少容纳一条最大消息。 |
| `VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD` | 262144 | WebRTC 发送队列低水位，队列回落时唤醒等候发送的任务。 |
| `VITE_RTC_FILE_CHUNK_SIZE` | 262144 | WebRTC 无序通道上大文件每块的正文大小，范围 1–1048576。 |
| `VITE_MACOS_SEND_ACTIVITY` | `true` | macOS 将超过 2 MiB 的文件发送任务标记为用户发起的活动，允许系统空闲睡眠。在 `desktop.ssg` 中设为 `false` 可关闭。 |
| `VITE_WINDOWS_SEND_ACTIVITY` | `true` | Windows 发送超过 2 MiB 的文件时请求 HighQoS，允许系统空闲睡眠。在 `desktop.ssg` 中设为 `false` 可关闭。 |
| `VITE_STORAGE_CHUNK_SIZE` | 2097152 | 本地文件读写块大小，取 131072 到 16777216 之间的 131072 的整数倍，含两端。 |

## 构建与 Docker

| 参数 | 配置位置 | 作用 |
| --- | --- | --- |
| `RELEASE_VERSION` | 构建进程环境变量，或对应的 API、前端、桌面构建分区 | 网页、桌面和 API 构建时写入的应用发布版本。本地构建默认为 `0.1.0`。Docker 源码构建的两个阶段均使用 `compose.ssg.RELEASE_VERSION`。编译 Worker API 时，在 Rust 构建进程环境中设置。 |
| `SERVER_PORT` | `compose.root` 或 `docker/.env` | 映射到容器 8080 端口的宿主机端口，默认 8080。 |
| `NPM_REGISTRY` | `compose.root` | 构建镜像时使用的 npm 镜像源，默认为 `https://registry.npmjs.org/`。 |
| `IMAGE_NAME`、`IMAGE_TAG` | `docker/.env` | 预构建镜像的仓库和标签。仓库模板使用 `kyteam/ky-im:latest`，服务端发布包内的模板固定为对应的发布标签。 |

预构建镜像在同一来源提供网页与信令服务。定制前端默认值时，修改 `compose.ssg`，用 `npm run prepare` 生成许可声明，再用 `npm run compose` 重新构建。本地用 OrbStack 测试时，在仓库根目录运行 `npm run init`，再运行 `docker --context orbstack compose up -d --build`。[源码 Compose 文件](../compose.yml) · [镜像 Compose 文件](../docker/compose.yml)

## Cloudflare Workers

在 Wrangler 模板中设置 Worker 名称和域名路由。在 `.env.json` 的 `wrangler.api.CORS_ORIGINS` 中加入网页来源，并将 `wrangler.ssg.VITE_SIGNAL_URL` 设为 API 的公网 WebSocket 地址。若网页和 API 使用不同域名，将 `wrangler.ssg.VITE_API_LATEST` 指向 API 的完整清单地址，或将 `/api/latest` 路由到 API。用 Wrangler Secret 管理访问密钥时，从 `wrangler.api` 移除 `API_AUTH`，并在 API Worker 上设置该 Secret。[API 模板](../api/wrangler.jsonc.example) · [网页模板](../ssg/wrangler.jsonc.example)

完成源码环境准备后，安装 Worker 构建工具并登录。部署命令会生成两份配置、构建网页资源并部署 API 和网页。

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --version 0.8.7 --locked
(cd api && npx wrangler login)
npm run deploy
```

可用 `npm run deploy:api`、`npm run deploy:ssg` 分别部署。修改前端默认值后需重新部署网页。`/api/health/details` 提供全站快照，`/api/health/details?room=<name>@<ip>` 返回指定房间的实时计数。

## 桌面打包

在 `desktop.app` 或构建进程的环境变量中设置打包参数，私钥和密码请放在版本控制之外。安装包的前端默认值放在 `desktop.ssg` 中。[桌面模板](../app/.env.example)

| 参数 | 作用 |
| --- | --- |
| `TAURI_UPDATER_URL` | 必填，HTTPS 更新清单地址。模板指向本项目的 GitHub 发布清单。 |
| `TAURI_UPDATER_PUBLIC_KEY`、`TAURI_SIGNING_PRIVATE_KEY` | 必填，校验更新的公钥与配对的签名私钥。公钥填写内容，私钥存放在安全文件或构建密钥中。 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 加密签名私钥的密码。 |
| `RELEASE_NOTES`、`TAURI_RELEASE_BASE_URL` | 更新清单中的发布说明，以及可选的签名产物 HTTPS 下载目录。 |
| `GITHUB_REPOSITORY` | 未指定下载目录时，用于生成发布下载链接的仓库。 |
| `CARGO_TARGET_DIR` | Cargo 产物目录，桌面构建默认为仓库根目录下的 `temp/cache/cargo`。 |
| `APPLE_SIGNING_IDENTITY` | macOS 代码签名身份。系统代码签名和应用更新签名各用各自的密钥。 |
| `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID` | macOS 公证使用的 Apple 账号、应用专用密码和团队标识。 |

构建 macOS 通用安装包前运行 `rustup target add aarch64-apple-darwin x86_64-apple-darwin`。在 macOS 或 Windows 上运行 `npm run desktop:build`，安装包、签名更新产物、校验文件和更新清单会写入 `app/dist/`。

通过 GitHub Actions 发布桌面端时，使用仓库的 **Settings → Secrets and variables → Actions**。工作流将仓库设置传给构建进程，独立于本地配置文件。[发布工作流](../.github/workflows/release.yml)

| Actions 配置来源 | 桌面前端参数 |
| --- | --- |
| 优先 Secret，其次 Variable | `VITE_SIGNAL_URL`、`VITE_API_AUTH`、`VITE_ROOM`、`VITE_ICE_SERVERS`、`VITE_API_LATEST`、`VITE_STORAGE_CHUNK_SIZE` |
| Variable | `VITE_WEB_URL`、`VITE_CLIENT_DOWNLOAD_URL`、`VITE_RTC_MAX_MESSAGE_SIZE`、`VITE_RTC_MAX_BUFFERED_AMOUNT`、`VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD`、`VITE_RTC_FILE_CHUNK_SIZE`、`VITE_MACOS_SEND_ACTIVITY`、`VITE_WINDOWS_SEND_ACTIVITY`、`VITE_SHOW_TRANSFER_SPEED` |

未配置仓库参数时，Actions 使用空信令地址和空预设密钥、`local` 命名空间，以及上文的 ICE 和传输默认值。更新签名私钥及密码应存放在 Actions Secrets 中。

Android 构建、签名变量及设备验收见 [Android 客户端](android.zh.md)。
