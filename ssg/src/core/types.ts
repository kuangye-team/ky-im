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
  /** Large transfers retain metadata only on both devices. */
  attachmentStorage?: "external";
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
  createFile(path: string): Promise<FileDestination>;
}
export type Conversation = {
  peer: Profile;
  /** A local display name; never included in a peer's shared profile. */
  remark?: string;
  /** Local permission for this contact's browser-stored attachments; off when absent. */
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
  peerStates: Record<string, "connecting" | "connected" | "failed">;
  transfers: Record<string, number>;
  error: string | null;
};
