import type { StorageAdapter, StorageUsage } from "../types";

type State = { result?: StorageUsage; loading: boolean; error: boolean };
const instances = new WeakMap<StorageAdapter, UsageView>();

/** A single user-initiated refresh survives navigation and React remounts. */
export function storageUsage(storage: StorageAdapter) {
  let view = instances.get(storage);
  if (!view) {
    view = new UsageView(storage);
    instances.set(storage, view);
  }
  return view;
}

function withoutDeleted(result: StorageUsage, ids: Set<string>) {
  return ids.size ? { ...result, files: result.files.filter((file) => !ids.has(file.id)) } : result;
}

class UsageView {
  private state: State = { loading: false, error: false };
  private listeners = new Set<() => void>();
  private pending?: Promise<void>;
  private forceRefresh = false;
  private deletedDuringRefresh?: Set<string>;
  private generation = 0;
  constructor(private storage: StorageAdapter) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: State) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  refresh(force = false) {
    if (this.pending) {
      this.forceRefresh ||= force;
      return this.pending;
    }
    this.forceRefresh = force;
    const generation = this.generation;
    const deleted = this.deletedDuringRefresh = new Set<string>();
    this.pending = Promise.resolve().then(async () => {
      const cached = this.storage.getCachedUsage ? await this.storage.getCachedUsage() : this.state.result;
      if (generation !== this.generation) return;
      const age = cached ? Date.now() - cached.completedAt : Infinity;
      if (!this.forceRefresh && cached && age >= 0 && age < 60_000) {
        this.publish({ result: withoutDeleted(cached, deleted), loading: false, error: false });
        return;
      }
      this.publish({ result: cached ? withoutDeleted(cached, deleted) : undefined, loading: true, error: false });
      let result: StorageUsage;
      if (this.storage.scanUsage) {
        result = await this.storage.scanUsage(cached?.completedAt);
      } else {
        const files = await this.storage.getFiles();
        const info = await this.storage.getStorageInfo?.();
        const usage = info?.usage ?? (await navigator.storage?.estimate?.())?.usage;
        result = { files, info, usage, completedAt: Date.now() };
      }
      if (generation === this.generation) this.publish({ result: withoutDeleted(result, deleted), loading: false, error: false });
    }).catch(() => {
      if (generation === this.generation) this.publish({ ...this.state, loading: false, error: true });
    }).finally(() => {
      if (generation === this.generation) {
        this.pending = undefined;
        this.deletedDuringRefresh = undefined;
      }
    });
    return this.pending;
  }
  remove(ids: Set<string>) {
    for (const id of ids) this.deletedDuringRefresh?.add(id);
    const result = this.state.result;
    if (result) this.publish({ ...this.state, result: withoutDeleted(result, ids) });
  }
  invalidate() {
    this.generation++;
    this.deletedDuringRefresh = undefined;
    this.pending = undefined;
    this.publish({ loading: false, error: false });
  }
}
