/** Only independent controls can overtake queued file frames. File start/end,
 * folder boundaries and file chunks always retain their original order. */
export function priorityControl(data: string | ArrayBuffer): boolean {
  if (typeof data !== "string") return false;
  try {
    return ["ack", "file-accept", "file-hold", "file-progress", "folder-entry-ready", "folder-entry-saved", "transfer-error", "receipt-query", "receipt", "text"].includes(JSON.parse(data)?.type);
  } catch { return false; }
}
export class SendQueue<T> {
  private normal: T[] = [];
  private urgent: T[] = [];
  private burst = 0;
  get length() { return this.normal.length + this.urgent.length; }
  get priorityLength() { return this.urgent.length; }
  push(value: T, priority = false) { (priority ? this.urgent : this.normal).push(value); }
  shift(priorityOnly = false): T | undefined {
    if (priorityOnly) return this.urgent.shift();
    if (this.urgent.length && (this.burst < 4 || !this.normal.length)) { this.burst++; return this.urgent.shift(); }
    this.burst = 0;
    return this.normal.shift();
  }
  shiftNormal(): T | undefined { return this.normal.shift(); }
  clear() { this.normal = []; this.urgent = []; this.burst = 0; }
  remove(predicate: (value: T) => boolean): T[] {
    const removed: T[] = [];
    const keep = (value: T) => { if (!predicate(value)) return true; removed.push(value); return false; };
    this.normal = this.normal.filter(keep);
    this.urgent = this.urgent.filter(keep);
    return removed;
  }
}

const idDecoder = new TextDecoder();

/** Inspect routing metadata without copying a binary file block. */
export function transferId(data: string | ArrayBuffer): string | undefined {
  if (typeof data === "string") {
    try { return JSON.parse(data)?.id; } catch { return undefined; }
  }
  if (data.byteLength < 44 || new DataView(data).getUint32(0) !== 0x534e4431) return;
  return idDecoder.decode(new Uint8Array(data, 4, 36));
}
