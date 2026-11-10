import { CONNECTION_CONFIG } from "../../config";
import type {
  TransportAdapter,
  TransportConnection,
  TransportOptions,
} from "./types";

export class WebRTCTransportAdapter implements TransportAdapter {
  readonly name = "webrtc";
  constructor(
    private readonly configuration: RTCConfiguration = CONNECTION_CONFIG.rtc,
  ) {}
  create(options: TransportOptions): TransportConnection {
    if (typeof RTCPeerConnection === "undefined")
      throw new Error(
        "当前浏览器暂时无法聊天，请更新浏览器或换一个浏览器重试。",
      );
    return new WebRTCConnection(
      new RTCPeerConnection(this.configuration),
      options,
    );
  }
}

class WebRTCConnection implements TransportConnection {
  channel?: RTCDataChannel;
  private candidates: RTCIceCandidateInit[] = [];
  private queue = Promise.resolve();
  private offerRequested = false;
  private ignoreOffer = false;
  private closed = false;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly options: TransportOptions,
  ) {
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.closed) return;
      try {
        options.sendSignal({ candidate: candidate.toJSON() });
      } catch {
        /* Discovery owns reconnection. */
      }
    };
    pc.ondatachannel = ({ channel }) => this.attach(channel);
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = pc.connectionState;
      if (state === "connected" || state === "disconnected")
        options.onState(state);
      else if (state === "closed" || state === "failed")
        options.onState("failed");
    };
  }

  private attach(channel: RTCDataChannel, replace = false) {
    if (this.closed || (this.channel && !replace)) {
      channel.close();
      return;
    }
    Object.defineProperty(channel, "maxMessageSize", {
      get: () => this.pc.sctp?.maxMessageSize,
      configurable: true,
    });
    this.channel = channel;
    this.options.onChannel(channel, replace);
  }

  start() {
    if (
      this.offerRequested ||
      this.channel ||
      this.pc.remoteDescription ||
      this.closed
    )
      return;
    this.offerRequested = true;
    this.queue = this.queue
      .then(async () => {
        if (this.closed || this.pc.remoteDescription) return;
        this.attach(this.pc.createDataChannel("send", { ordered: true }));
        await this.pc.setLocalDescription(await this.pc.createOffer());
        if (!this.closed)
          this.options.sendSignal({ description: this.pc.localDescription });
      })
      .catch((error) => this.options.onError(error));
  }

  signal(value: unknown): Promise<void> {
    const signal = value as {
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
    };
    this.queue = this.queue
      .then(async () => {
        if (this.closed || !signal || typeof signal !== "object") return;
        if (
          signal.description &&
          ["offer", "answer"].includes(signal.description.type) &&
          typeof signal.description.sdp === "string" &&
          signal.description.sdp.length < 128 * 1024
        ) {
          const collision =
            signal.description.type === "offer" &&
            this.pc.signalingState !== "stable";
          this.ignoreOffer =
            collision && this.options.localId < this.options.peerId;
          if (this.ignoreOffer) {
            this.candidates.length = 0;
            return;
          }
          if (collision && this.channel) {
            // Detach callbacks before closing the rolled-back channel.
            this.channel.onclose = null;
            this.channel.onerror = null;
            this.channel.close();
            this.channel = undefined;
          }
          await this.pc.setRemoteDescription(signal.description);
          for (const candidate of this.candidates.splice(0))
            await this.pc.addIceCandidate(candidate);
          if (signal.description.type === "offer") {
            await this.pc.setLocalDescription(await this.pc.createAnswer());
            if (!this.closed)
              this.options.sendSignal({
                description: this.pc.localDescription,
              });
          }
        } else if (
          signal.candidate &&
          typeof signal.candidate.candidate === "string" &&
          signal.candidate.candidate.length < 4096
        ) {
          if (this.ignoreOffer) return;
          if (this.pc.remoteDescription)
            await this.pc.addIceCandidate(signal.candidate);
          else if (this.candidates.length < 128)
            this.candidates.push(signal.candidate);
        }
      })
      .catch((error) => this.options.onError(error));
    return this.queue;
  }

  close() {
    this.closed = true;
    this.channel?.close();
    this.pc.close();
  }
}
