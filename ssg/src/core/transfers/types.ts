import type { RuntimeInfo } from "../capabilities";
import type { TransportChannel } from "../network/types";
import type { AttachmentSource, ChatSnapshot, Message, Profile, StorageAdapter } from "../types";

export type FileState = { received: number; sequence: number; sent?: number; written?: number; destinationWriteMs?: number; };
export type FileProgress = { id: string; sent?: number; received?: number; confirmed?: number; written?: number;
  windowWaitMs?: number; destinationWriteMs?: number; sequence?: number; message?: string; };

/** Optional task execution beside the transport/storage, without moving payloads through the UI. */
export interface FileTaskExecutor {
  sender(id: string, file: AttachmentSource, token?: string): Promise<void>;
  receive(id: string, token: string, size: number): Promise<void>;
  retarget(id: string, token: string): Promise<void>;
  state(id: string, resume?: boolean): Promise<FileState>;
  send(id: string, offset: number, sequence: number, base?: number, singleFile?: boolean): Promise<{ sent: number; sequence: number; }>;
  cancel(id: string): void;
  release(id: string): Promise<void>;
}

/** Only the session information needed by transfer tasks. */
export interface TransferLink {
  peerId: string;
  profile: Profile;
  channel?: TransportChannel;
  receipts?: boolean;
  recoveryPending?: boolean;
  cancelledTransfers?: Set<string>;
}

interface TransferHistory {
  readonly revision: number;
  readonly peerRevisions: ReadonlyMap<string, number>;
  readonly deletedMessages: ReadonlySet<string>;
  readonly knownMessages: ReadonlyMap<string, Message>;
  readonly cache: ReadonlyMap<string, Message[]>;
  readonly writing: Promise<void>;
  recordMessage(message: Message, incoming?: boolean): Promise<void>;
  write<T>(task: () => Promise<T>): Promise<T>;
  alreadyReceived(id: string, peerId: string): Promise<boolean>;
}

/** Chat/history and connection operations supplied by the application coordinator. */
export interface TransferHost {
  readonly storage: StorageAdapter;
  readonly snapshot: ChatSnapshot;
  readonly movingStorage: boolean;
  readonly history: TransferHistory;
  readonly links: ReadonlyMap<string, TransferLink>;
  patch(values: Partial<ChatSnapshot>): void;
  showError(error: unknown): void;
  withFileLane(peerId: string, id: string, action: () => Promise<void>): Promise<void>;
  readyChannel(peerId: string): Promise<{ link: TransferLink; channel: TransportChannel; }>;
  ensureLink(peerId: string, initiate?: boolean, background?: boolean): TransferLink | undefined;
  failLink(link: TransferLink, reason: string, offline?: boolean): void;
  receivedFromPeer(link: TransferLink): void;
  getRuntimeInfo(): RuntimeInfo;
  peerProfile(peerId: string): Profile | undefined;
  retryAt(peerId: string): number;
}
