# 能力协商

[English](capabilities.md) | 简体中文 · [项目首页](../README.zh.md)

`version` 是发布版本 `RELEASE_VERSION`，`capabilities` 是协议与功能集合。三端共享 [`shared/capabilities.json`](../shared/capabilities.json)。

| 能力 | 协议标识 | 用途 |
| --- | --- | --- |
| 运行端 | `client.web.v1` / `client.app.v1` | 区分网页和原生客户端的传输能力 |
| 中心 | `server.signaling.v1` | 设备发现服务 |
| 发现与协调 | `discovery.v1`、`signaling.v1`、`capabilities.query.v1` | 连接信令服务的必需能力 |
| 网页反拨 | `signaling.reverse-dial.v1` | 网页与中心均支持时，桌面在地址公告中附带后台或按需反拨请求。 |
| 原生传输 | `transfer.tcp.v1` | 原生 TCP/QUIC 设置与候选 |
| 网页直连桌面 | `transfer.webtransport.v1` | 网页可拨号、桌面启用快速直连时，两端使用 HTTP/3 可靠流 |
| WebRTC | `transfer.webrtc.v1` | 已配置 ICE 的字节流 Transport |
| 中转 | `transport.ws-relay.v1` | 端到端加密的 WS 隧道，须双方在同一中心许可 |
| 业务 | `chat.v1`、`file.v1`、`folder.v1` | 对应业务协议 |
| 恢复 | `file-resume.v1`、`folder-resume.v1`、`receipts.v1` | 进程内单文件、文件夹续传和保存回执查询 |

双方能力集合的交集决定可共同使用的功能。设备间连接需要查询与聊天能力，以及至少一种共同支持的传输方式。连接调度由 libp2p 负责。聊天与文件各用独立协议流。设备通过 `/hummingbird/ping/2.0.0` 核对资料版本、按需交换正文。

中心公布能力集合和本次连接的随机挑战。客户端检查必需能力后签名注册，中心验证 PeerId 和签名后将设备加入目录。

设备在每次修改资料时保存递增的 `profile.revision`。对端用它核对缓存，用 `profile.runtime.version` 读取应用发布版本。身份是经过握手验证的 PeerId，号码只用于发现，连接、消息和文件任务仍使用各自独立 ID。

完整资料和发现摘要可分别带 JSON 对象 `extend`。设备间资料响应上限为 32 KiB，中心摘要的扩展上限为 8 KiB。

设备注册前即可通过信令 WebSocket 查询服务能力，配置了访问凭据时须先鉴权。公开的 HTTP 端点 `/api/capabilities` 也提供服务能力列表。所有列表、字段长度、流与缓冲都有上限。未知能力不会自动获得权限。

[通信设计](arch.zh.md) · [配置参考](option.zh.md)
