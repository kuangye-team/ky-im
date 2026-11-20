import type { RuntimeInfo, CompatibilityReason } from "./capabilities";
import type { ClientType, Device } from "../device-platform";
export type Profile = RuntimeInfo & {
  /** Persistent libp2p PeerId. Used internally for identity/history; hidden in the UI. */
  id: string;
  /** Locally allocated device number; a discovery group independent of network location. */
  numericId?: string;
  revision?: number;
  maxMessageSize?: number;
  extend?: Record<string, unknown>;
  name: string;
  bio: string;
  color: string;
  avatar: string;
  device?: Device;
  clientType: ClientType;
};
export type Message = {
  id: string;
  peerId: string;
  senderId: string;
  kind: "text" | "image" | "file";
  text?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  createdAt: number;
  status: "awaiting-acceptance" | "sending" | "sent" | "delivered" | "failed";
  /** External exports retain metadata only; managed payloads belong to local storage. */
  attachmentStorage?: "external" | "managed";
  /** A folder retains its directory structure in managed storage or an external destination. */
  folder?: { fileCount: number; directoryCount: number };
  error?: string;
};
export interface FileDestination {
  readonly nativeToken?: string;
  copyPrefixTo?(target: FileDestination): Promise<void>;
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FolderDestination {
  readonly nativeToken?: string;
  createDirectory(path: string): Promise<void>;
  createFile(path: string, size?: number): Promise<FileDestination>;
  close?(): Promise<void>;
  abort?(): Promise<void>;
}
/** A file that can be read in bounded chunks, including native files accessed over IPC. */
export interface AttachmentSource {
  readonly nativeSource?: { path: string } | { attachmentId: string };
  name: string;
  type: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
export type StorageInfo = {
  directory: string;
  usage: number;
  cacheUsage: number;
  cleanupPending?: boolean;
};
export type StorageMove = { directory: string; cleanupWarning?: boolean };
export type StorageUsage = {
  completedAt: number;
  usage?: number;
  info?: StorageInfo;
  files: Message[];
};
export type Conversation = {
  peer: Profile;
  /** A local display name; never included in a peer's shared profile. */
  remark?: string;
  /** Local permission for automatic receiving into this device's managed storage; off when absent. */
  autoAcceptFiles?: boolean;
  updatedAt: number;
  lastDeliveredAt?: number;
  unread: number;
};
export interface StorageAdapter {
  readonly name: string;
  close?(): Promise<void>;
  onDatabaseDelete?: () => Promise<void>;
  getIdentity?(): Promise<Uint8Array | undefined>;
  saveIdentity?(key: Uint8Array): Promise<void>;
  getProfile(): Promise<Profile | undefined>;
  saveProfile(profile: Profile): Promise<void>;
  getPeerProfiles?(): Promise<Profile[]>;
  savePeerProfile?(profile: Profile): Promise<void>;
  getConversations(): Promise<Conversation[]>;
  saveConversation(conversation: Conversation): Promise<void>;
  getMessages(peerId: string): Promise<Message[]>;
  saveMessage(message: Message): Promise<void>;
  getAttachment(id: string): Promise<Blob | undefined>;
  saveAttachment(id: string, blob: Blob): Promise<void>;
  createExternalFileDestination?(message: Message, path: string): Promise<FileDestination>;
  createFileDestination?(message: Message): Promise<FileDestination>;
  createFolderDestination?(message: Message): Promise<FolderDestination>;
  getAttachmentSource?(id: string): Promise<AttachmentSource | undefined>;
  exportAttachment?(message: Message, target?: FileDestination): Promise<void>;
  getStorageInfo?(): Promise<StorageInfo>;
  moveStorage?(directory: string): Promise<StorageMove>;
  getCachedUsage?(): Promise<StorageUsage | null>;
  scanUsage?(previous?: number): Promise<StorageUsage>;
  /** Saved attachments at or above the size limit, largest first. */
  getFiles(minSize?: number): Promise<Message[]>;
  /** Deletes local messages together with their attachment payloads. */
  deleteMessages(ids: string[]): Promise<void>;
  deleteConversation(peerId: string): Promise<void>;
  clearHistory(): Promise<void>;
  /** Clears identity, history, and managed attachments. External exports are untouched. */
  resetData?(): Promise<void>;
}
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export type Availability = "online" | "offline";
export type ChatSnapshot = {
  profile: Profile;
  peers: Profile[];
  conversations: Conversation[];
  messages: Message[];
  activePeerId: string | null;
  status: ConnectionStatus;
  /** User intent, separate from the actual signaling connection state. */
  availability: Availability;
  /** Advisory presence; three silent probe cycles or connection failures mark a peer offline. */
  peerPresence: Record<string, "online" | "offline">;
  peerStates: Record<string, "connecting" | "connected" | "failed">;
  transfers: Record<string, number>;
  error: string | null;
  compatibilityReasons?: CompatibilityReason[];
};

/** Presence is advisory and must never be used as a prerequisite for sending. */
export function isPeerOnline(snapshot: ChatSnapshot, peerId: string): boolean {
  return snapshot.peers.some((peer) => peer.id === peerId) && snapshot.peerPresence[peerId] !== "offline";
}
