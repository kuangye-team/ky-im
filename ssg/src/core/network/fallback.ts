import { runtimeLog } from "../../runtime-logs";
import type {
  TransportAdapter,
  TransportChannel,
  TransportConnection,
  TransportOptions,
} from "./types";

/** Do not expose a failed TCP attempt to the engine. Payloads start only once a channel is selected. */
export class PreferredTransportAdapter implements TransportAdapter {
  readonly name = "tcp+webrtc";
  constructor(
    private readonly tcp: TransportAdapter,
    private readonly rtc: TransportAdapter,
    private readonly timeoutMs = 4000,
  ) {}
  set onIncoming(callback: ((peerId: string) => void) | undefined) {
    this.tcp.onIncoming = callback;
  }
  create(options: TransportOptions): TransportConnection {
    let current: TransportConnection | undefined;
    let probing: TransportChannel | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let started = false;
    let selected = false;
    let usingRtc = false;
    const clearProbe = () => {
      clearTimeout(timer);
      if (probing) probing.onopen = probing.onerror = probing.onclose = null;
      probing = undefined;
    };
    const fallback = (initiate: boolean) => {
      if (closed || usingRtc || selected) return;
      runtimeLog("info", "connection", "正在尝试兼容传输", { peerId: options.peerId });
      usingRtc = true;
      clearProbe();
      current?.close();
      try {
        current = this.rtc.create(options);
        if (current.channel) options.onChannel(current.channel);
        if (initiate) current.start();
      } catch (error) {
        options.onError(error);
      }
    };
    const watch = (channel: TransportChannel) => {
      if (closed || usingRtc) {
        channel.close();
        return;
      }
      probing = channel;
      channel.onopen = () => {
        if (closed || usingRtc) return;
        selected = true;
        clearProbe();
        options.onChannel(channel);
      };
      channel.onerror = channel.onclose = () => fallback(true);
      if (channel.readyState === "open")
        queueMicrotask(() => channel.onopen?.(new Event("open")));
    };
    current = this.tcp.create({
      ...options,
      onChannel: watch,
      onError: () => fallback(true),
      onState: (state) => {
        if (selected) options.onState(state);
        else if (state === "failed") fallback(true);
      },
    });
    if (current.channel) watch(current.channel);
    const thisTimeout = this.timeoutMs;
    return {
      start() {
        if (closed || started) return;
        started = true;
        if (!usingRtc && !selected)
          timer = setTimeout(() => fallback(true), thisTimeout);
        current?.start();
      },
      async signal(data) {
        if (closed || selected) return;
        fallback(false);
        await current?.signal(data);
      },
      close() {
        closed = true;
        clearProbe();
        current?.close();
      },
    };
  }
}
