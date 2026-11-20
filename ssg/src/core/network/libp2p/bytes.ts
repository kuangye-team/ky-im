import { AbstractMultiaddrConnection } from "@libp2p/utils";
import { logger } from "@libp2p/logger";
import type { Multiaddr } from "@multiformats/multiaddr";
import type { Uint8ArrayList } from "uint8arraylist";

/** The transport owns bounded delivery; libp2p owns authentication and multiplexing. */
export class ByteConnection extends AbstractMultiaddrConnection {
  managed = false; // Set once libp2p owns the connection, directly or through the native pipe.
  constructor(
    remoteAddr: Multiaddr,
    direction: "inbound" | "outbound",
    private write: (data: Uint8Array) => boolean,
    private shutdown: () => void,
    private sliceSize = () => 16 * 1024,
  ) {
    super({
      remoteAddr,
      direction,
      log: logger("hummingbird:transport"),
      maxReadBufferLength: 256 * 1024,
      maxWriteBufferLength: 512 * 1024,
      inactivityTimeout: 0,
    });
  }
  sendData(data: Uint8ArrayList) {
    let sentBytes = 0;
    while (sentBytes < data.byteLength) {
      const end = Math.min(data.byteLength, sentBytes + this.sliceSize());
      if (!this.write(data.subarray(sentBytes, end)))
        return { sentBytes, canSendMore: false };
      sentBytes = end;
    }
    return { sentBytes, canSendMore: true };
  }
  drain() {
    if (this.status !== "open") return;
    // A DataChannel low-water event only frees the socket. Flush our pending
    // bytes before waking Noise/Yamux; otherwise each layer adds another burst
    // while this connection is still full.
    this.writableNeedsDrain = false;
    if (this.processSendQueue()) this.onMuxerDrain();
  }
  sendReset() {
    this.shutdown();
  }
  sendPause() {
    /* bounded receive window at the transport */
  }
  sendResume() {
    /* bounded receive window at the transport */
  }
  async sendClose() {
    this.shutdown();
    this.onTransportClosed();
  }
}
