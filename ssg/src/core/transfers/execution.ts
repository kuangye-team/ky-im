import type { TransportChannel } from "../network/types";
import type { ControlPacket } from "../protocol";
import type { OutgoingTransfer } from "./state";
import type { TransferHost, TransferLink } from "./types";

/** Shared task coordination. Backends retain their own source reads and data loops. */
export interface TransferExecution {
  readonly host: TransferHost;
  readonly outgoing: ReadonlyMap<string, OutgoingTransfer>;
  sendControl(channel: TransportChannel, packet: ControlPacket): void;
  waitForBuffer(channel: TransportChannel): Promise<void>;
  waitForTransfer(id: string, ready: (task: OutgoingTransfer) => boolean,
    timeout: number, reason: string, metric?: string): Promise<void>;
  progress(id: string, value: number | null): void;
  failOutgoing(id: string, reason: string): Promise<void>;
  armAck(id: string): void;
  resumeOutgoing(task: OutgoingTransfer, deadline: number): Promise<{
    channel: TransportChannel;
    reply: Extract<ControlPacket, { type: "file-resumed"; }>;
  }>;
  handleData(link: TransferLink, raw: unknown): Promise<void>;
}
