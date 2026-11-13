export type Profile = {
  /** Locally generated, persistent UUID. Used internally for identity/history; hidden in the UI. */
  id: string;
  /** Shared discovery number for this device's network group; never a device identity. */
  numericId?: string;
  name: string;
  bio: string;
  color: string;
  avatar: string;
  device: string;
  clientType: "web" | "app";
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
  /** External destinations retain metadata only; managed payloads belong to the desktop store. */
  attachmentStorage?: "external" | "managed";
  /** Present only for a folder streamed directly to the recipient's disk. */
  folder?: { fileCount: number; directoryCount: number };
  error?: string;
};
export interface FileDestination {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FolderDestination {
  createDirectory(path: string): Promise<void>;
  createFile(path: string, size?: number): Promise<FileDestination>;
  close?(): Promise<void>;
  abort?(): Promise<void>;
}
/** A file that can be read in bounded chunks, including native files accessed over IPC. */
export interface AttachmentSource {
  name: string;
  type: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}
export type StorageInfo = {
  directory: string;
  usage: number;
  cacheUsage: number;
  cleanupWarning?: boolean;
  cleanupPending?: boolean;
};
export type Conversation = {
  peer: Profile;
  /** A local display name; never included in a peer's shared profile. */
  remark?: string;
  /** Local permission for automatic receiving into this device's managed storage; off when absent. */
  autoAcceptFiles?: boolean;
  updatedAt: number;
  unread: number;
};
export interface StorageAdapter {
  readonly name: string;
  getProfile(): Promise<Profile | undefined>;
  saveProfile(profile: Profile): Promise<void>;
  getConversations(): Promise<Conversation[]>;
  saveConversation(conversation: Conversation): Promise<void>;
  getMessages(peerId: string): Promise<Message[]>;
  saveMessage(message: Message): Promise<void>;
  getAttachment(id: string): Promise<Blob | undefined>;
  saveAttachment(id: string, blob: Blob): Promise<void>;
  createFileDestination?(message: Message): Promise<FileDestination>;
  createFolderDestination?(message: Message): Promise<FolderDestination>;
  getAttachmentSource?(id: string): Promise<AttachmentSource | undefined>;
  exportAttachment?(message: Message): Promise<void>;
  getStorageInfo?(): Promise<StorageInfo>;
  moveStorage?(directory: string): Promise<StorageInfo>;
  /** Saved attachments at or above the size limit, largest first. */
  getFiles(minSize?: number): Promise<Message[]>;
  /** Deletes local messages together with their attachment payloads. */
  deleteMessages(ids: string[]): Promise<void>;
  deleteConversation(peerId: string): Promise<void>;
  clearHistory(): Promise<void>;
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
};

/** Presence is advisory and must never be used as a prerequisite for sending. */
export function isPeerOnline(snapshot: ChatSnapshot, peerId: string): boolean {
  return snapshot.peers.some((peer) => peer.id === peerId) && snapshot.peerPresence[peerId] !== "offline";
}
