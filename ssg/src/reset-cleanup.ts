export const CLOSE_OTHER_PAGES = "请关闭其他蜂鸟页面后重试";

export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    let timer: ReturnType<typeof setTimeout>;
    request.onblocked = () => {
      // Give another updated page time to stop its writers and release the connection.
      timer = setTimeout(() => reject(new Error(CLOSE_OTHER_PAGES)), 1000);
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
  });
}
