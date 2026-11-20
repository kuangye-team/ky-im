import { IndexedDBStorageAdapter } from "../storage";

/** Exercise the engine's optional buffered/external adapter contract separately from OPFS. */
export function bufferedStorage(name: string) {
  return new Proxy(new IndexedDBStorageAdapter(name), {
    get(target, key) {
      if (!Object.hasOwn(target, key) && (key === "createFileDestination" || key === "createFolderDestination" || key === "getAttachmentSource")) return undefined;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
