import { expect, test } from "@playwright/test";

test("跨标签页清理跳过活动写入，删除后禁止提交，刷新清理中断文件", async ({ page, context }) => {
  await page.goto("/");
  const other = await context.newPage(); await other.goto("/");
  const name = `opfs-test-${crypto.randomUUID()}`;
  const id = crypto.randomUUID();
  await page.evaluate(async ({ name, id }) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter(name);
    const writer = await store.createFileDestination({ id, size: 3 });
    await writer.write(new Blob(["abc"]));
    Object.assign(window, { opfsTest: { store, writer } });
  }, { name, id });
  // This instance has a separate JS realm; actual Web Locks protect the first writer.
  expect(await other.evaluate(async ({ name, id }) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const store = new IndexedDBStorageAdapter(name);
    await store.saveAttachment("other", new Blob(["keep"]));
    await store.deleteMessages([id]);
    const missing = (await store.getAttachment(id)) === undefined;
    await store.close(); return missing;
  }, { name, id })).toBe(true);
  expect(await page.evaluate(async () => {
    const { writer } = (window as any).opfsTest;
    try { await writer.close(); return "incorrectly committed"; }
    catch (error) { await writer.abort(); return (error as Error).message; }
  })).toContain("已取消");
  const path = await page.evaluate(async ({ name, id }) => {
    const state = (window as any).opfsTest;
    const writer = await state.store.createFileDestination({ id, size: 3 });
    await writer.write(new Blob(["abc"]));
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result);
    });
    const pending = await new Promise<any[]>((resolve) => {
      const request = db.transaction("pendingAttachments").objectStore("pendingAttachments").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    db.close(); return pending.find(p => p.id === id).record.path;
  }, { name, id });
  await page.reload();
  expect(await page.evaluate(async ({ name, path }) => {
    const { IndexedDBStorageAdapter } = await import("/src/core/storage.ts");
    const { attachmentDirectory } = await import("/src/core/storage/opfs.ts");
    const store = new IndexedDBStorageAdapter(name);
    // Wait for startup recovery and verify unrelated completed content remains.
    const kept = await (await store.getAttachment("other"))!.text();
    const directory = await attachmentDirectory(name);
    let removed = false;
    try { await directory.getDirectoryHandle(path); }
    catch (error) { removed = (error as DOMException).name === "NotFoundError"; }
    await store.resetData(); await store.close(); return { kept, removed };
  }, { name, path })).toEqual({ kept: "keep", removed: true });
  await other.close();
});
