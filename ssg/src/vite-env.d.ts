/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** 构建时公开给浏览器的配置；不能在 VITE_* 变量中放置密钥。 */
interface ImportMetaEnv {
  /** 自动发现命名空间，默认 local。 */
  readonly VITE_ROOM?: string;
  /** 完整 ws(s):// 信令地址；空值使用同源 /api/ws。 */
  readonly VITE_SIGNAL_URL?: string;
}
