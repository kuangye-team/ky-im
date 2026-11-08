import { FOLDER_CONFIG } from "../config";
import type { FolderDestination } from "./types";
import type { ControlPacket } from "./protocol";

/** In-memory metadata only. All payload writes belong to the user's directory. */
export class FolderReceiver {
  destination?: FolderDestination;
  current?: {
    index: number;
    size: number;
    received: number;
    kind: "file" | "directory";
  };
  completed = 0;
  private files = 0;
  private directories = 0;
  private bytes = 0;
  private metadataBytes = 0;
  private paths = new Set<string>();
  private parents = new Set<string>([""]);
  constructor(
    readonly expected: {
      size: number;
      fileCount: number;
      directoryCount: number;
    },
  ) {}

  async begin(packet: Extract<ControlPacket, { type: "folder-entry" }>) {
    if (
      !this.destination ||
      this.current ||
      packet.index !== this.completed ||
      this.paths.has(packet.path) ||
      !this.parents.has(packet.path.split("/").slice(0, -1).join("/"))
    )
      throw new Error("文件夹目录不完整，请重新发送");
    this.metadataBytes += new TextEncoder().encode(packet.path).byteLength;
    if (this.metadataBytes > FOLDER_CONFIG.maxMetadataBytes)
      throw new Error("文件夹内容过多，请分成几次发送");
    if (packet.kind === "file") this.files++;
    else this.directories++;
    this.bytes += packet.size;
    if (
      this.files > this.expected.fileCount ||
      this.directories > this.expected.directoryCount ||
      this.bytes > this.expected.size
    )
      throw new Error("文件夹内容与发送清单不一致，请重新发送");
    this.paths.add(packet.path);
    this.current = {
      index: packet.index,
      kind: packet.kind,
      size: packet.size,
      received: 0,
    };
    if (packet.kind === "directory") {
      await this.destination.createDirectory(packet.path);
      this.parents.add(packet.path);
      return undefined;
    }
    return this.destination.createFile(packet.path);
  }
  receive(bytes: number) {
    if (
      !this.current ||
      this.current.kind !== "file" ||
      this.current.received + bytes > this.current.size
    )
      throw new Error("文件夹内容与发送清单不一致，请重新发送");
    this.current.received += bytes;
  }
  checkEnd(index: number) {
    if (
      !this.current ||
      this.current.index !== index ||
      this.current.received !== this.current.size
    )
      throw new Error("文件没有接收完整，请让对方重新发送");
  }
  finishEntry() {
    this.current = undefined;
    this.completed++;
  }
  complete() {
    return (
      !this.current &&
      this.completed ===
        this.expected.fileCount + this.expected.directoryCount &&
      this.files === this.expected.fileCount &&
      this.directories === this.expected.directoryCount &&
      this.bytes === this.expected.size
    );
  }
}
