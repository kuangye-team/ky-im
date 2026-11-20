/** Lightweight OPFS double for unit tests. Browser tests exercise real disk streams. */
const missing = () => new DOMException("Not found", "NotFoundError");
class TestFile {
  readonly kind = "file";
  private data = new Blob();
  constructor(readonly name: string) {}
  async getFile() { return new File([this.data], this.name); }
  async createWritable(options?: { keepExistingData?: boolean }) {
    let chunks: BlobPart[] = options?.keepExistingData ? [this.data] : [];
    let closed = false;
    return {
      seek: async (position: number) => {
        if (position !== new Blob(chunks).size) throw new Error("Expected append position");
      },
      write: async (value: BlobPart) => {
        if (closed) throw new DOMException("Closed", "InvalidStateError");
        chunks.push(value);
      },
      close: async () => { closed = true; this.data = new Blob(chunks); chunks = []; },
      abort: async () => { closed = true; chunks = []; },
    } as unknown as FileSystemWritableFileStream;
  }
}
class TestDirectory {
  readonly kind = "directory";
  private children = new Map<string, TestFile | TestDirectory>();
  constructor(readonly name: string) {}
  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<TestDirectory> {
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "directory") throw new DOMException("Wrong kind", "TypeMismatchError");
      return found;
    }
    if (!options?.create) throw missing();
    const directory = new TestDirectory(name);
    this.children.set(name, directory);
    return directory;
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const found = this.children.get(name);
    if (found) {
      if (found.kind !== "file") throw new DOMException("Wrong kind", "TypeMismatchError");
      return found;
    }
    if (!options?.create) throw missing();
    const file = new TestFile(name);
    this.children.set(name, file);
    return file;
  }
  async removeEntry(name: string) { if (!this.children.delete(name)) throw missing(); }
  async *values() { yield* this.children.values(); }
}
const root = new TestDirectory("");
export const testStorage = {
  getDirectory: async () => root as unknown as FileSystemDirectoryHandle,
  estimate: async () => ({ quota: 1024 ** 4, usage: 0 }),
};
Object.defineProperty(navigator, "storage", { value: testStorage, configurable: true });
