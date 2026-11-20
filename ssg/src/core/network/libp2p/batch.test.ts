import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteBatchWriter, CumulativeAcks, PIPE_BATCH_BYTES, PIPE_QUEUE_BYTES } from "./batch";

afterEach(() => vi.useRealTimers());

describe("bounded ordered pipe batching", () => {
  it("coalesces small messages, preserves offsets and flushes a partial final batch", async () => {
    vi.useFakeTimers();
    const sent: Uint8Array<ArrayBuffer>[] = [];
    const writer = new ByteBatchWriter(async bytes => { sent.push(new Uint8Array(bytes)); });
    const bytes = Uint8Array.from({ length: PIPE_BATCH_BYTES + 37 }, (_, i) => i % 251);
    for (let at = 0; at < bytes.length; at += 16384) writer.push(bytes.subarray(at, at + 16384));
    writer.end();
    await writer.done;
    expect(sent.length).toBeLessThan(Math.ceil(bytes.length / 16384));
    expect(sent.every(b => b.length <= PIPE_BATCH_BYTES)).toBe(true);
    expect(new Uint8Array(await new Blob(sent).arrayBuffer())).toEqual(bytes);
    expect(writer.bufferedBytes).toBe(0);
  });
  it("bounds queued plus in-flight bytes and never overlaps IPC writes", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const writer = new ByteBatchWriter(write);
    writer.push(new Uint8Array(PIPE_BATCH_BYTES));
    await vi.advanceTimersByTimeAsync(1);
    writer.push(new Uint8Array(PIPE_QUEUE_BYTES - PIPE_BATCH_BYTES));
    expect(writer.bufferedBytes).toBe(PIPE_QUEUE_BYTES);
    expect(write).toHaveBeenCalledTimes(1);
    const failure = expect(writer.done).rejects.toThrow("queue exceeded");
    writer.push(new Uint8Array(1));
    await failure;
    release();
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
    expect(writer.bufferedBytes).toBe(0);
  });
  it("flushes sparse handshake bytes without waiting to fill a batch", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {});
    const writer = new ByteBatchWriter(write);
    writer.push(new Uint8Array([7]));
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(1);
    writer.end();
    await writer.done;
  });
  it("rejects on IPC failure and discards later queued bytes", async () => {
    const write = vi.fn(async () => { throw new Error("IPC closed"); });
    const writer = new ByteBatchWriter(write);
    writer.push(new Uint8Array(2 * PIPE_BATCH_BYTES));
    writer.end();
    await expect(writer.done).rejects.toThrow("IPC closed");
    expect(write).toHaveBeenCalledTimes(1);
    expect(writer.bufferedBytes).toBe(0);
  });
});

describe("cumulative admission credits", () => {
  it("does not acknowledge across a slow consumer or inflate credit through duplicates", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const acks = new CumulativeAcks(send);
    acks.consume("file", 2);
    acks.consume("file", 3);
    await vi.runAllTimersAsync();
    expect(send).not.toHaveBeenCalled();
    acks.consume("file", 1);
    expect(send.mock.calls).toEqual([["file", 3]]);
    acks.consume("file", 2);
    acks.consume("file", 4);
    await vi.runAllTimersAsync();
    expect(send.mock.calls).toEqual([["file", 3], ["file", 4]]);
    expect(() => acks.consume("file", 9)).toThrow();
    acks.close();
  });
  it("keeps control credits independent and drops scheduled credits on close", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const acks = new CumulativeAcks(send);
    acks.consume("file", 2);
    acks.consume("control", 1);
    await vi.runAllTimersAsync();
    expect(send.mock.calls).toEqual([["control", 1]]);
    acks.consume("control", 2);
    acks.close();
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
