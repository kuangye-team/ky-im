import type { NativePeerNode } from "./native";
import { newId } from "../../protocol";

/** WebSocket-shaped control surface. Binary tunnel frames never reach this object. */
export class NativeSocket {
  readonly id = newId();
  readyState = 0;
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onactivity: (() => void) | null = null;
  private pending: Promise<void> = Promise.resolve();
  constructor(private node: NativePeerNode, source: string, address: string, permitted: boolean) {
    node.sockets.set(this.id, this);
    void (async () => {
      await node.socketReady(() => this.readyState === 3);
      if (this.readyState === 3) return;
      await node.call({
        op: "socket_open", socketId: this.id, source, address, permitted,
        useSystemProxy: node.settings.proxyMode !== "direct",
      });
      if (this.readyState === 3) await node.call({ op: "socket_close", socketId: this.id });
    })().catch(() => { this.event("error"); this.event("close"); });
  }
  event(state: string, message?: string) {
    if (this.readyState === 3) return;
    if (state === "open") { this.readyState = 1; this.onopen?.(new Event("open")); }
    else if (state === "message") this.onmessage?.({ data: message });
    else if (state === "activity") this.onactivity?.();
    else if (state === "error") this.onerror?.(new Event("error"));
    else if (state === "close") { this.readyState = 3; this.node.sockets.delete(this.id); this.onclose?.(new Event("close")); }
  }
  send(message: string) {
    if (this.readyState !== 1 || typeof message !== "string" || this.bufferedAmount + message.length > 512 * 1024)
      throw new Error("连接繁忙，请稍后重试");
    this.bufferedAmount += message.length;
    this.pending = this.pending.then(async () => {
      if (this.readyState === 1) await this.node.call({ op: "socket_send", socketId: this.id, message });
    }).catch(() => { this.event("error"); this.close(); }).finally(() => { this.bufferedAmount -= message.length; });
  }
  close() {
    if (this.readyState === 3) return;
    this.event("close");
    void this.node.call({ op: "socket_close", socketId: this.id }).catch(() => {});
  }
}
