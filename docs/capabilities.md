# Capability negotiation

English | [简体中文](capabilities.zh.md) · [Project overview](../README.md)

The `version` field reports the application release set by `RELEASE_VERSION`. The `capabilities` field lists the protocols and features a participant supports. The browser, desktop app, and signaling server share one [capability catalog](../shared/capabilities.json).

| Capability | Protocol identifier | Purpose |
| --- | --- | --- |
| Client runtime | `client.web.v1` / `client.app.v1` | Identifies the browser or native transport role |
| Server | `server.signaling.v1` | Identifies a device discovery service |
| Discovery and coordination | `discovery.v1`, `signaling.v1`, `capabilities.query.v1` | Required to connect to a signaling server |
| Browser reverse dialing | `signaling.reverse-dial.v1` | The desktop attaches a background or on-demand dial request to an address announcement when the browser and the server advertise support. |
| Native transport | `transfer.tcp.v1` | Native TCP/QUIC settings and candidates |
| Browser to desktop | `transfer.webtransport.v1` | HTTP/3 streams between a dial-capable browser and a desktop with direct transfer enabled |
| WebRTC | `transfer.webrtc.v1` | Byte-stream transport using the configured ICE servers |
| Relay | `transport.ws-relay.v1` | End-to-end encrypted WebSocket tunnel with both peers' consent on the same server |
| Messaging and transfers | `chat.v1`, `file.v1`, `folder.v1` | Chat, single-file, and folder protocols |
| Recovery | `file-resume.v1`, `folder-resume.v1`, `receipts.v1` | Resume files and folders in the same running session and query save receipts |

The intersection of the advertised capabilities determines which features two participants can use. A peer connection requires the query and chat capabilities and at least one common transport. libp2p schedules connections. Chat and file transfers use separate protocol streams. Peers compare profile revisions over `/hummingbird/ping/2.0.0` and exchange the full profile when needed.

The server announces its capabilities and a random challenge for the connection. The client checks the required capabilities and signs its registration. Once the server verifies the PeerId and signature, it adds the device to the directory.

Each profile change increments the stored `profile.revision`. Peers use this value to validate a cached profile and read the application release from `profile.runtime.version`. The handshake authenticates the PeerId. The six-digit number allows discovery, while connections, messages, and file tasks each have separate IDs.

Both full profiles and discovery summaries can carry an optional JSON object named `extend`. A peer profile response is limited to 32 KiB. The extension in a server discovery summary is limited to 8 KiB.

Clients can query capabilities over the signaling WebSocket before registering a device, using the configured server credentials. The public HTTP endpoint `/api/capabilities` also lists the server capabilities. Lists, field lengths, streams, and buffers are bounded. An unrecognized capability grants no additional permissions.

[Communication architecture](arch.md) · [Configuration reference](option.md)
