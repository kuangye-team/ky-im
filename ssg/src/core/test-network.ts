/** Controllable byte-channel fixture for business tests. Real transport interoperability is tested in tests/p2p. */
import type {
  NetworkAdapters,
  TransportChannel,
  DiscoverySession,
} from "./network/types";
export function testNetwork(): NetworkAdapters {
  return {
    discovery: {
      name: "test",
      supportsNumericIds: true,
      usesBrowserNetworkStatus: true,
      open: () => new WebSocket("ws://test.invalid/api/ws") as DiscoverySession,
    },
    transport: {
      name: "test",
      create: (options) => {
        const pc = new RTCPeerConnection();
        const channel = pc.createDataChannel(
          "test",
        ) as unknown as TransportChannel;
        Object.defineProperty(channel, "maxMessageSize", {
          configurable: true,
          get: () => pc.sctp?.maxMessageSize,
        });
        channel.probe ??= async signal => {
          signal.throwIfAborted();
          if (channel.readyState !== "open") throw new Error("closed");
          return { roundTripMs: 1, ageMs: 0 };
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") options.onState("failed");
          else if (pc.connectionState === "disconnected")
            options.onState("disconnected");
          else if (pc.connectionState === "connected")
            options.onState("connected");
        };
        return {
          channel,
          start: () => {
            void pc
              .createOffer()
              .then((offer) => pc.setLocalDescription(offer))
              .then(() =>
                options.sendSignal({ description: pc.localDescription }),
              )
              .catch(options.onError);
          },
          signal: async (data) => {
            const value = data as {
              description?: RTCSessionDescriptionInit;
              candidate?: RTCIceCandidateInit;
            };
            if (value.description) {
              await pc.setRemoteDescription(value.description);
              if (value.description.type === "offer") {
                await pc.setLocalDescription(await pc.createAnswer());
                options.sendSignal({ description: pc.localDescription });
              }
            } else if (value.candidate)
              await pc.addIceCandidate(value.candidate);
          },
          close: () => {
            channel.close();
            pc.close();
          },
        };
      },
    },
  };
}
