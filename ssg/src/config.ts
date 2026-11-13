/**
 * 前端配置入口。在根目录 .env.json 中修改对应环境，再运行 npm run init。
 * local 用于开发，production 用于正式构建，compose 用于 Docker 构建。
 * 下列源码配置随前端构建生效；字节上限和协议行为应在通信双方保持一致。
 * 开发端口、代理和构建选项见 vite.config.ts；测试选项见 tests/config/。
 */

/** 设备发现与信令；中转协议由独立传输适配器处理，默认不启用。 */
export const SIGNALING_CONFIG = {
  // 发现命名空间；仍在 join 消息中使用，1–64 位字母、数字、下划线或连字符。
  // 相同命名空间和服务端可见 IP 的设备自动发现。此值不提供访问控制。
  room: import.meta.env?.VITE_ROOM || "local",
  // 留空时跟随页面协议/域名连接 /api/ws；HTTPS 页面必须使用 wss://。
  url: import.meta.env?.VITE_SIGNAL_URL || "",
  // 默认服务器的构建时访问密钥；也适用于留空地址时的同源服务器。
  authorization: (import.meta.env?.VITE_API_AUTH || "").trim(),
  heartbeatIntervalMs: 20_000, // 发送心跳的间隔。
  heartbeatTimeoutMs: 55_000, // 超过此时间没有 pong 则断开并重连。
  heartbeatResumeGraceMs: 10_000, // 页面恢复后先探测，给对端回复的宽限时间。
  reconnectInitialDelayMs: 1_000, // 指数退避的起始等待时间。
  reconnectMaxDelayMs: 120_000, // 持续失败时，随机等待 60–120 秒。
  reconnectStableMs: 60_000, // 持续在线且收到心跳回复后，才重置退避。
  lookupTimeoutMs: 10_000, // 等待上线或蜂鸟号查询结果的时限。
  maxMessageChars: 512 * 1024, // 信令 JSON 的客户端接收字符上限。
} as const;

/** Web 与桌面互通的公开入口，随前端构建生效。 */
export const CLIENT_CONFIG = {
  webUrl: import.meta.env?.VITE_WEB_URL?.trim() || "https://im.kuangye.team/",
  downloadUrl: import.meta.env?.VITE_CLIENT_DOWNLOAD_URL?.trim() || "https://github.com/kuangye-team/ky-im/releases/latest",
  // Keep the scheme in sync with app/tauri.conf.json.
  launchUrl: "ky-im://open",
} as const;

/** 桌面客户端未配置有效信令地址时，邀请朋友使用的公开网页。 */
export const INVITE_CONFIG = {
  fallbackUrl: CLIENT_CONFIG.webUrl,
} as const;

/** Invalid public configuration falls back to 10 seconds; allow 1 second to 5 minutes. */
export function listHeartbeatInterval(value: string | undefined): number {
  const interval = Number(value);
  return Number.isSafeInteger(interval) && interval >= 1000 && interval <= 300_000 ? interval : 10_000;
}

/** 直连与中转共用的连接时限和本机缓冲。 */
export const CONNECTION_CONFIG = {
  rtc: { iceServers: [] } satisfies RTCConfiguration, // 默认仅使用本机 ICE 候选。
  listHeartbeatIntervalMs: listHeartbeatInterval(import.meta.env?.VITE_PEER_CHECK_INTERVAL_MS),
  peerHeartbeatIntervalMs: 10_000, // 已打开的聊天通道双向探测。
  peerHeartbeatTimeoutMs: 8_000, // 单次探测等待；静默且无在途内容时重协商。
  peerHeartbeatMissLimit: 3, // 连续三个探测周期未确认存活则离线，不限制发送。
  peerRetryMaxMs: 30_000, // 当前联系人的独立重试上限。
  readyTimeoutMs: 15_000, // 等待设备 DataChannel 就绪的时限。
  disconnectGraceMs: 8_000, // 短暂断网的恢复宽限时间。
  pollIntervalMs: 75, // 等待连接状态变化的轮询间隔。
  sendBufferHighBytes: 512 * 1024, // 发送缓冲高于此值时暂停读取下一块。
  sendBufferLowBytes: 128 * 1024, // 缓冲下降到此值时继续发送。
  maxReceiveQueueBytes: 8 * 1024 * 1024, // 所有异步接收队列的总字节上限。
  maxReceiveQueuePackets: 1024, // 单设备异步接收队列的包数上限。
  maxTotalReceiveQueuePackets: 2048, // 所有设备异步接收队列的总包数上限。
} as const;

/** 内容限制：各传输通道共用，修改时要兼顾对端版本和界面提示。 */
export const MAX_FILE_SIZE = 256 * 1024 ** 2; // 浏览器附件保存上限：256 MiB；自动接收需联系人授权，更大文件需确认并直接保存到磁盘。
export const FOLDER_CONFIG = {
  maxCompressedFiles: 256,
  maxEntries: 100_000,
  maxPathLength: 4096,
  maxDepth: 128,
  maxMetadataBytes: 16 * 1024 * 1024,
  supportTimeoutMs: 10_000,
} as const;
export const CHUNK_SIZE = 128 * 1024; // 单个文件数据块 128 KiB，不含协议头；WebRTC 可按对端上限缩小。
export const MAX_TRANSFER_SIZE = CHUNK_SIZE * 2 ** 32; // 32 位数据块序号的协议上限。
export const MAX_TEXT_BYTES = 32 * 1024; // 单条文字的 UTF-8 字节上限。
export const MAX_CONTROL_BYTES = 48 * 1024; // DataChannel 控制 JSON 的字节上限。
export const TRANSFER_CONFIG = {
  timeoutMs: 60_000, // 文件接收或发送缓冲等待超时。
  ackTimeoutMs: 30_000, // 等待对端确认已保存的时限。
  consentTimeoutMs: 5 * 60_000, // 等待接收方选择保存位置。
  streamWindowBytes: 1024 * 1024, // 大文件每写入 1 MiB 再允许发送下一批。
  maxIncomingFiles: 8, // 同时接收的附件数。
  maxReservedBytes: 2 * MAX_FILE_SIZE, // 接收缓存总预算；直接写入磁盘的文件只计一个窗口。
  maxFutureTimestampMs: 60_000, // 对端消息时间最多允许领先本机一分钟。
} as const;

const storageChunkBytes = Number(import.meta.env?.VITE_STORAGE_CHUNK_SIZE || 2 * 1024 * 1024);
if (!Number.isSafeInteger(storageChunkBytes) || storageChunkBytes < CHUNK_SIZE ||
    storageChunkBytes > 16 * 1024 * 1024 || storageChunkBytes % CHUNK_SIZE !== 0)
  throw new Error("VITE_STORAGE_CHUNK_SIZE must be a multiple of 131072 bytes between 131072 and 16777216");

/** 本地存储：更改 databaseName 会切换资料库，不会迁移既有聊天记录。 */
export const STORAGE_CONFIG = {
  databaseName: "send-chat",
  chunkBytes: storageChunkBytes, // 本地文件读取和 IPC 写入，默认 2 MiB；独立于网络分块。
  availabilityKey: "hummingbird.availability", // localStorage 中保存上线意图。
} as const;
export const LARGE_FILE_BYTES = 10 * 1024 * 1024; // 清理页面的大附件阈值，10 MiB。

/** 界面输入与头像选项；名称长度按 JavaScript 字符串长度计数。 */
export const MAX_REMARK_LENGTH = 32;
export const PROFILE_NAME_MAX_LENGTH = 32; // 编辑表单上限；协议兼容上限为 40。
export const PROFILE_BIO_MAX_LENGTH = 160;
export const COMPOSER_MAX_LENGTH = 16_000; // 输入框字符上限；发送仍校验 UTF-8 字节数。
export const PROFILE_AVATARS = [
  "🌿",
  "🪐",
  "🐼",
  "🦊",
  "🐳",
  "🍊",
  "🌻",
  "☕",
  "🎧",
  "🚀",
  "🐈",
  "🌈",
] as const;
export const PROFILE_COLORS = [
  "#7266ed",
  "#4d8dcd",
  "#51a68e",
  "#e3a44b",
  "#d77794",
  "#79849e",
] as const;

/** 语言、首屏与随机资料共用的配置；首屏配置由 Vite 内嵌进 HTML。 */
export const LANGUAGE_CONFIG = {
  storageKey: "hummingbird.language",
  defaultPreference: "system",
  fallback: "en",
  supported: ["en", "zh-CN"],
  options: [
    {
      value: "system",
      label: "系统",
      description: "系统默认",
      badge: "auto",
    },
    { value: "en", label: "English", description: "英语", badge: "EN" },
    { value: "zh-CN", label: "中文", description: "简体中文", badge: "中" },
  ],
} as const;
export type AppLanguage = (typeof LANGUAGE_CONFIG.supported)[number];
export type LanguagePreference =
  (typeof LANGUAGE_CONFIG.options)[number]["value"];

export const LOADING_CONFIG = {
  // 首屏沿用当前主题；在应用样式下载前也能显示正确配色。
  theme: {
    base: "var(--header-start)",
    blue: "var(--header-start)",
    sky: "var(--header-end)",
    pattern: "#ffffff14",
    ink: "#ffffff",
    muted: "#ffffffe6",
    accent: "#ffffff",
    orbit: "#ffffff40",
    surface: "#ffffff14",
    "pattern-size": "26px",
    "spin-duration": "1.2s",
  },
  copy: {
    "zh-CN": {
      brand: "蜂鸟",
      title: "蜂鸟 · 轻快连接，自在分享",
      tagline: "轻快连接，自在分享。",
      message: "正在打开蜂鸟…",
      reload: "重新加载",
      failed: "页面加载失败，请检查网络后重试。",
    },
    en: {
      brand: "Hummingbird",
      title: "Hummingbird · Connect and share freely",
      tagline: "Connect easily. Share freely.",
      message: "Opening Hummingbird…",
      reload: "Reload",
      failed: "The page could not load. Check your connection and try again.",
    },
  },
} as const;

/** 每次生成独立抽取昵称、数字尾缀和介绍；已保存的资料不会随语言切换改写。 */
export const PROFILE_GENERATION_CONFIG = {
  suffixRange: 100,
  suffixDigits: 2,
  copy: {
    "zh-CN": {
      names: [
        "山间的风",
        "橘子汽水",
        "月光旅人",
        "午后小猫",
        "向阳花",
        "蓝色鲸鱼",
        "薄荷云朵",
        "漫步星球",
      ],
      bios: [
        "在同一个网络，遇见彼此。",
        "带着一点好奇，和你打个招呼。",
        "把今天的小美好，分享给你。",
        "慢慢聊，让灵感轻轻抵达。",
        "收集生活里的微光，也分享快乐。",
        "一杯茶的时间，认识一个新朋友。",
        "让想说的话，顺着微风到你身边。",
        "此刻在线，期待一次有趣的相遇。",
      ],
      browser: "浏览器",
    },
    en: {
      names: [
        "Mountain Breeze",
        "Orange Soda",
        "Moonlight Wanderer",
        "Afternoon Cat",
        "Sunny Bloom",
        "Blue Whale",
        "Mint Cloud",
        "Planet Rover",
      ],
      bios: [
        "On the same network, ready to say hello.",
        "A little curious, always happy to connect.",
        "Sharing the little things that make today brighter.",
        "Good conversations give new ideas room to grow.",
        "Collecting small wonders and sharing a little joy.",
        "A cup of tea and a new friend sounds lovely.",
        "Sending a little hello your way.",
        "Here for a friendly chat and a happy discovery.",
      ],
      browser: "Browser",
    },
  },
} as const;
