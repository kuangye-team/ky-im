import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEngine } from "./engine";
import { IndexedDBStorageAdapter } from "./storage";
import { MAX_FILE_SIZE, decodeChunk, encodeChunk, newId } from "./protocol";
import type { Profile } from "./types";
import { CHUNK_SIZE, FOLDER_CONFIG, TRANSFER_CONFIG } from "../config";

// Exercise the complete streaming lifecycle without allocating hundreds of megabytes.
// protocol.test.ts separately fixes the production boundary at exactly 256 MiB.
vi.mock("../config", async (original) => ({
  ...(await original<typeof import("../config")>()),
  MAX_FILE_SIZE: 64 * 1024,
  TRANSFER_CONFIG: {
    ...(await original<typeof import("../config")>()).TRANSFER_CONFIG,
    streamWindowBytes: 32 * 1024,
  },
}));

class Channel extends EventTarget {
  readyState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  sent: unknown[] = [];
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}
class PeerConnection {
  static instances: PeerConnection[] = [];
  connectionState = "new";
  signalingState = "stable";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  channel = new Channel();
  onconnectionstatechange?: () => void;
  onicecandidate?: unknown;
  ondatachannel?: unknown;
  constructor() {
    PeerConnection.instances.push(this);
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "test-offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "test-answer" };
  }
  async setLocalDescription(value: { type: string }) {
    this.localDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-local-offer" : "stable";
  }
  async setRemoteDescription(value: { type: string }) {
    this.remoteDescription = value;
    this.signalingState =
      value.type === "offer" ? "have-remote-offer" : "stable";
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
  fail() {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  sent: string[] = [];
  constructor() {
    Socket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  receive(packet: unknown) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
}
const me: Profile = {
  id: "10000000-0000-4000-8000-000000000000",
  name: "本机",
  avatar: "🌿",
  color: "#597461",
  bio: "",
  device: "Mac",
};
const peer: Profile = {
  ...me,
  id: "20000000-0000-4000-8000-000000000000",
  name: "对方",
};
const engines: ChatEngine[] = [];
const adapters: IndexedDBStorageAdapter[] = [];
async function setup(open = true) {
  const storage = new IndexedDBStorageAdapter(`send-transport-${newId()}`);
  adapters.push(storage);
  const engine = new ChatEngine(storage, me, []);
  engines.push(engine);
  await engine.selectPeer(peer);
  engine.start();
  const socket = Socket.instances.at(-1)!;
  socket.onopen?.();
  socket.receive({ type: "welcome", id: me.id, peers: [peer] });
  const pc = PeerConnection.instances.at(-1)!;
  await Promise.resolve();
  if (open) pc.channel.open();
  return { engine, storage, socket, pc, channel: pc.channel };
}
const controls = (channel: Channel) =>
  channel.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
beforeEach(() => {
  PeerConnection.instances = [];
  Socket.instances = [];
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("location", { protocol: "http:", host: "192.168.1.2:5173" });
  vi.stubGlobal("RTCPeerConnection", PeerConnection);
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.stop();
  vi.useRealTimers();
  // Finish queued IDB failure updates before closing the databases.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.all(adapters.splice(0).map((storage) => storage.close()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function offer(channel: Channel, size = MAX_FILE_SIZE + 17) {
  const id = newId();
  channel.receive(
    JSON.stringify({
      type: "file-start",
      id,
      kind: "file",
      fileName: "archive.bin",
      mimeType: "",
      size,
      createdAt: Date.now(),
    }),
  );
  return id;
}
function destination() {
  return {
    write: vi.fn(async (_data: Blob) => {}),
    close: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  };
}
function offerFolder(
  channel: Channel,
  size = 4,
  fileCount = 2,
  directoryCount = 1,
) {
  const id = newId();
  channel.receive(
    JSON.stringify({
      type: "folder-start",
      id,
      fileName: "资料夹",
      size,
      fileCount,
      directoryCount,
      createdAt: Date.now(),
    }),
  );
  return id;
}
async function pending(engine: ChatEngine, id: string) {
  await vi.waitFor(() =>
    expect(engine.getSnapshot().messages.find((m) => m.id === id)?.status).toBe(
      "awaiting-acceptance",
    ),
  );
}

describe("contact file receiving permission", () => {
  it.each([0, 3, MAX_FILE_SIZE])(
    "requires consent by default for %i bytes and stores only after acceptance",
    async (size) => {
      const { engine, channel, socket } = await setup();
      const id = offer(channel, size);
      await pending(engine, id);
      const signaling = [...socket.sent];
      expect(controls(channel).some((p) => p.type === "file-accept")).toBe(
        false,
      );
      expect(await engine.getAttachment(id)).toBeUndefined();
      await engine.acceptFile(id);
      expect(controls(channel)).toContainEqual({ type: "file-accept", id });
      for (let offset = 0; offset < size; offset += CHUNK_SIZE)
        channel.receive(
          encodeChunk(
            id,
            offset / CHUNK_SIZE,
            new Uint8Array(Math.min(CHUNK_SIZE, size - offset)).fill(7).buffer,
          ),
        );
      channel.receive(JSON.stringify({ type: "file-end", id }));
      await vi.waitFor(() =>
        expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
      );
      expect((await engine.getAttachment(id))?.size).toBe(size);
      expect(socket.sent).toEqual(signaling);
    },
  );

  it("does not send small file bytes or honor premature acknowledgments before acceptance", async () => {
    const { engine, channel } = await setup();
    const file = new File(["small file"], "small.txt");
    const slice = vi.spyOn(file, "slice");
    const sending = engine.sendFiles([file]).catch(() => false);
    await vi.waitFor(() =>
      expect(controls(channel).some((p) => p.type === "file-start")).toBe(true),
    );
    const id = engine.getSnapshot().messages[0].id;
    channel.receive(JSON.stringify({ type: "ack", id }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.getSnapshot().messages[0].status).toBe("awaiting-acceptance");
    expect(slice).not.toHaveBeenCalled();
    expect(channel.sent.some((data) => data instanceof ArrayBuffer)).toBe(
      false,
    );
    channel.receive(
      JSON.stringify({
        type: "transfer-error",
        id,
        message: "对方已拒绝接收此文件",
      }),
    );
    expect(await sending).toBe(false);
    expect(slice).not.toHaveBeenCalled();
  });

  it("rejects small file bytes before consent and supports cancellation of pending requests", async () => {
    const { engine, channel } = await setup();
    const early = offer(channel, 3);
    await pending(engine, early);
    channel.receive(encodeChunk(early, 0, new Uint8Array(3).buffer));
    await vi.waitFor(() =>
      expect(
        engine.getSnapshot().messages.find((m) => m.id === early)?.status,
      ).toBe("failed"),
    );
    expect(await engine.getAttachment(early)).toBeUndefined();
    const declined = offer(channel, 0);
    await pending(engine, declined);
    engine.rejectFile(declined);
    await vi.waitFor(() => expect(engine.hasPendingTransfers()).toBe(false));
    expect(controls(channel)).toContainEqual(
      expect.objectContaining({ type: "transfer-error", id: declined }),
    );
  });

  it("only permits the chosen contact and requires consent again after switching off", async () => {
    const { engine, channel, socket } = await setup();
    const other = { ...peer, id: "30000000-0000-4000-8000-000000000000" };
    socket.receive({ type: "peer_joined", peer: other });
    await engine.selectPeer(other);
    await engine.updatePeerAutoAcceptFiles(other.id, true);
    await engine.selectPeer(peer);
    const id = offer(channel, 3);
    await pending(engine, id);
    engine.rejectFile(id);
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    const automatic = offer(channel, 3);
    await vi.waitFor(() =>
      expect(controls(channel)).toContainEqual({
        type: "file-accept",
        id: automatic,
      }),
    );
    await engine.cancelTransfer(automatic);
    await engine.updatePeerAutoAcceptFiles(peer.id, false);
    const manual = offer(channel, 3);
    await pending(engine, manual);
    expect(
      controls(channel).some(
        (p) => p.type === "file-accept" && p.id === manual,
      ),
    ).toBe(false);
  });
});

describe("large file consent and direct-to-disk transfers", () => {
  it("finishes local cancellation even when the channel cannot send the notice", async () => {
    const { engine, channel } = await setup();
    const id = offer(channel);
    await pending(engine, id);
    const sink = destination();
    await engine.acceptFile(id, sink);
    vi.spyOn(channel, "send").mockImplementation(() => {
      throw new Error("Send buffer full");
    });
    await expect(engine.deleteMessage(id)).resolves.toBeUndefined();
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(engine.hasPendingTransfers()).toBe(false);
    expect(engine.getSnapshot().messages).toEqual([]);
  });
  it("automatically receives the exact boundary only when enabled, but still requires consent above it", async () => {
    const { engine, channel } = await setup();
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    const automatic = offer(channel, MAX_FILE_SIZE);
    await vi.waitFor(() =>
      expect(
        engine.getSnapshot().messages.find((m) => m.id === automatic)?.status,
      ).toBe("sending"),
    );
    const manual = offer(channel, MAX_FILE_SIZE + 1);
    await pending(engine, manual);
    expect(controls(channel).filter((p) => p.type === "file-accept")).toEqual([
      { type: "file-accept", id: automatic },
    ]);
    expect(await engine.getAttachment(manual)).toBeUndefined();
  });
  it("rejects bytes received before consent and records refusal without an attachment", async () => {
    const { engine, channel } = await setup();
    const id = offer(channel);
    await pending(engine, id);
    channel.receive(encodeChunk(id, 0, new Uint8Array([1]).buffer));
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("failed"),
    );
    expect(
      controls(channel).some((p) => p.type === "transfer-error" && p.id === id),
    ).toBe(true);
    expect(await engine.getAttachment(id)).toBeUndefined();
  });
  it("streams complete bytes in bounded batches and acknowledges only after closing the destination", async () => {
    const { engine, storage, channel, socket } = await setup();
    const save = vi.spyOn(storage, "saveAttachment");
    const bytes = new Uint8Array(MAX_FILE_SIZE + 17).map((_, i) => i % 251);
    const id = offer(channel, bytes.length);
    await pending(engine, id);
    const sink = destination();
    let close!: () => void;
    sink.close.mockImplementation(
      () =>
        new Promise((resolve) => {
          close = resolve;
        }),
    );
    const signaling = [...socket.sent];
    await engine.acceptFile(id, sink);
    expect(
      controls(channel).some((p) => p.type === "file-accept" && p.id === id),
    ).toBe(true);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE)
      channel.receive(
        encodeChunk(
          id,
          offset / CHUNK_SIZE,
          bytes.slice(offset, offset + CHUNK_SIZE).buffer,
        ),
      );
    channel.receive(JSON.stringify({ type: "file-end", id }));
    await vi.waitFor(() => expect(sink.close).toHaveBeenCalledOnce());
    expect(controls(channel).some((p) => p.type === "ack")).toBe(false);
    expect(
      sink.write.mock.calls.every(
        ([blob]) => blob.size <= TRANSFER_CONFIG.streamWindowBytes,
      ),
    ).toBe(true);
    expect(
      new Uint8Array(
        await new Blob(
          sink.write.mock.calls.map(([blob]) => blob),
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
    close();
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect(controls(channel).some((p) => p.type === "ack")).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(await engine.getAttachment(id)).toBeUndefined();
    expect((await storage.getMessages(peer.id))[0]?.attachmentStorage).toBe(
      "external",
    );
    expect(socket.sent).toEqual(signaling);
  });
  it("does not read or store outgoing bytes before consent and honors refusal", async () => {
    const { engine, storage, channel } = await setup();
    const file = new File([new Uint8Array(MAX_FILE_SIZE + 1)], "large.bin");
    const slice = vi.spyOn(file, "slice");
    const save = vi.spyOn(storage, "saveAttachment");
    const sending = engine.sendFiles([file]).catch(() => false);
    await vi.waitFor(() =>
      expect(controls(channel).some((p) => p.type === "file-start")).toBe(true),
    );
    const id = engine.getSnapshot().messages[0]!.id;
    expect(slice).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    channel.receive(JSON.stringify({ type: "ack", id }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.getSnapshot().messages[0]?.status).toBe(
      "awaiting-acceptance",
    );
    channel.receive(
      JSON.stringify({
        type: "transfer-error",
        id,
        message: "对方已拒绝接收此文件",
      }),
    );
    expect(await sending).toBe(false);
    expect(engine.getSnapshot().messages[0]?.error).toBe(
      "对方已拒绝接收此文件",
    );
    expect(slice).not.toHaveBeenCalled();
  });
  it("waits for disk progress before sending another window, then finishes without persisting bytes", async () => {
    const { engine, storage, channel } = await setup();
    const save = vi.spyOn(storage, "saveAttachment");
    const bytes = new Uint8Array(MAX_FILE_SIZE + 17).fill(91);
    const sending = engine.sendFiles([new File([bytes], "large.bin")]);
    await vi.waitFor(() =>
      expect(controls(channel).some((p) => p.type === "file-start")).toBe(true),
    );
    const id = engine.getSnapshot().messages[0]!.id;
    channel.receive(JSON.stringify({ type: "file-accept", id }));
    const chunks = () =>
      channel.sent.filter(
        (data): data is ArrayBuffer => data instanceof ArrayBuffer,
      );
    await vi.waitFor(() => expect(chunks()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks()).toHaveLength(2);
    channel.receive(
      JSON.stringify({ type: "file-progress", id, received: bytes.length + 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunks()).toHaveLength(2);
    channel.receive(
      JSON.stringify({
        type: "file-progress",
        id,
        received: TRANSFER_CONFIG.streamWindowBytes,
      }),
    );
    await vi.waitFor(() => expect(chunks()).toHaveLength(4));
    channel.receive(
      JSON.stringify({
        type: "file-progress",
        id,
        received: 2 * TRANSFER_CONFIG.streamWindowBytes,
      }),
    );
    expect(await sending).toBe(true);
    expect(
      new Uint8Array(
        await new Blob(
          chunks().map((chunk) => decodeChunk(chunk)!.data),
        ).arrayBuffer(),
      ),
    ).toEqual(bytes);
    channel.receive(JSON.stringify({ type: "ack", id }));
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect(save).not.toHaveBeenCalled();
  });
  it.each(["disconnect", "delete", "disk-error", "sender-cancel"])(
    "aborts partial output on %s",
    async (mode) => {
      const { engine, channel } = await setup();
      const id = offer(channel);
      await pending(engine, id);
      const sink = destination();
      await engine.acceptFile(id, sink);
      if (mode === "disconnect") channel.close();
      if (mode === "delete") await engine.deleteMessage(id);
      if (mode === "sender-cancel")
        channel.receive(
          JSON.stringify({
            type: "transfer-error",
            id,
            message: "文件传输已取消",
          }),
        );
      if (mode === "disk-error") {
        sink.write.mockRejectedValueOnce(new Error("Disk full"));
        for (let sequence = 0; sequence < 2; sequence++)
          channel.receive(
            encodeChunk(id, sequence, new Uint8Array(CHUNK_SIZE).buffer),
          );
      }
      await vi.waitFor(() => expect(sink.abort).toHaveBeenCalledOnce());
      expect(sink.close).not.toHaveBeenCalled();
      expect(await engine.getAttachment(id)).toBeUndefined();
      expect(controls(channel).some((p) => p.type === "ack")).toBe(false);
    },
  );
  it("aborts a destination chosen after the request was declined", async () => {
    const { engine, channel } = await setup();
    const id = offer(channel);
    await pending(engine, id);
    engine.rejectFile(id);
    const sink = destination();
    await expect(engine.acceptFile(id, sink)).rejects.toThrow("文件传输已取消");
    expect(sink.abort).toHaveBeenCalledOnce();
    expect(controls(channel).some((p) => p.type === "file-accept")).toBe(false);
  });
  it("expires unanswered requests and informs the sender", async () => {
    const { engine, channel } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const id = offer(channel);
    await pending(engine, id);
    await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.consentTimeoutMs + 1);
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("failed"),
    );
    expect(
      controls(channel).some((p) => p.type === "transfer-error" && p.id === id),
    ).toBe(true);
    expect(engine.hasPendingTransfers()).toBe(false);
  });
  it("aborts a stalled disk write and never acknowledges it", async () => {
    const { engine, channel } = await setup();
    const id = offer(channel);
    await pending(engine, id);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sink = destination();
    let release!: () => void;
    sink.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await engine.acceptFile(id, sink);
    for (let sequence = 0; sequence < 2; sequence++)
      channel.receive(
        encodeChunk(id, sequence, new Uint8Array(CHUNK_SIZE).buffer),
      );
    await vi.waitFor(() => expect(sink.write).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(TRANSFER_CONFIG.timeoutMs + 1);
    expect(sink.abort).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("failed"),
    );
    expect(
      controls(channel).some(
        (p) => p.type === "file-progress" || p.type === "ack",
      ),
    ).toBe(false);
  });
});

describe("direct folder transfers", () => {
  it("requires consent even for tiny files, then saves structure and payload without browser attachments or signaling content", async () => {
    const { engine, channel, storage, socket } = await setup();
    const save = vi.spyOn(storage, "saveAttachment");
    await engine.updatePeerAutoAcceptFiles(peer.id, true);
    const id = offerFolder(channel);
    await pending(engine, id);
    expect(engine.getSnapshot().messages[0]?.attachmentStorage).toBe(
      "external",
    );
    expect(controls(channel)).toContainEqual({ type: "folder-supported", id });
    const signaling = [...socket.sent];
    const sinks = [destination(), destination()];
    const target = {
      createDirectory: vi.fn(async (_path: string) => {}),
      createFile: vi.fn(async (_path: string) => sinks.shift()!),
    };
    const first = sinks[0];
    const second = sinks[1];
    await engine.acceptFolder(id, target);
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 0,
        path: "空目录",
        kind: "directory",
        size: 0,
      }),
    );
    channel.receive(JSON.stringify({ type: "folder-entry-end", id, index: 0 }));
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 1,
        path: "data.txt",
        kind: "file",
        size: 4,
      }),
    );
    channel.receive(
      encodeChunk(id, 0, new TextEncoder().encode("data").buffer),
    );
    channel.receive(JSON.stringify({ type: "folder-entry-end", id, index: 1 }));
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 2,
        path: "zero.txt",
        kind: "file",
        size: 0,
      }),
    );
    channel.receive(JSON.stringify({ type: "folder-entry-end", id, index: 2 }));
    channel.receive(JSON.stringify({ type: "folder-end", id }));
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("delivered"),
    );
    expect(target.createDirectory).toHaveBeenCalledWith("空目录");
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
    expect(await first.write.mock.calls[0][0].text()).toBe("data");
    expect(save).not.toHaveBeenCalled();
    expect(await storage.getAttachment(id)).toBeUndefined();
    expect(socket.sent).toEqual(signaling);
    expect(controls(channel)).toContainEqual({ type: "ack", id });
  });
  it("does not create or read anything before consent and propagates cancellation", async () => {
    const { engine, channel, storage } = await setup();
    const file = new File([new Uint8Array(MAX_FILE_SIZE + 1)], "test.bin");
    const slice = vi.spyOn(file, "slice");
    const save = vi.spyOn(storage, "saveAttachment");
    const sending = engine
      .sendFolder(
        async () => ({
          name: "资料",
          entries: [{ kind: "file", path: file.name, file }],
        }),
        () => {},
        new AbortController().signal,
      )
      .catch(() => false);
    await vi.waitFor(() =>
      expect(controls(channel).some((p) => p.type === "folder-start")).toBe(
        true,
      ),
    );
    const id = engine.getSnapshot().messages[0].id;
    expect(slice).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    await engine.cancelTransfer(id);
    expect(await sending).toBe(false);
    expect(engine.getSnapshot().messages[0]?.status).toBe("failed");
    expect(
      controls(channel).some((p) => p.type === "transfer-error" && p.id === id),
    ).toBe(true);
  });
  it("rejects entry creation before acceptance", async () => {
    const { engine, channel } = await setup();
    const id = offerFolder(channel);
    await pending(engine, id);
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 0,
        kind: "directory",
        path: "too-early",
        size: 0,
      }),
    );
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("failed"),
    );
    expect(await engine.getAttachment(id)).toBeUndefined();
  });
  it.each([
    "wrong-size",
    "early-end",
    "duplicate-path",
    "disk-error",
    "cancel",
    "disconnect",
  ])("handles %s without acknowledging incomplete folders", async (mode) => {
    const { engine, channel } = await setup();
    const id = offerFolder(channel, 4, 2, 0);
    await pending(engine, id);
    const sink = destination();
    await engine.acceptFolder(id, {
      createDirectory: async () => {},
      createFile: async () => sink,
    });
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 0,
        kind: "file",
        path: "a.txt",
        size: 4,
      }),
    );
    await vi.waitFor(() =>
      expect(
        controls(channel).some((p) => p.type === "folder-entry-ready"),
      ).toBe(true),
    );
    if (mode === "cancel") await engine.cancelTransfer(id);
    else if (mode === "disconnect") channel.close();
    else if (mode === "early-end")
      channel.receive(JSON.stringify({ type: "folder-end", id }));
    else if (mode === "wrong-size")
      channel.receive(encodeChunk(id, 0, new Uint8Array(5).buffer));
    else {
      if (mode === "disk-error")
        sink.write.mockRejectedValueOnce(new Error("Disk full"));
      channel.receive(encodeChunk(id, 0, new Uint8Array(4).buffer));
      channel.receive(
        JSON.stringify({ type: "folder-entry-end", id, index: 0 }),
      );
      if (mode === "duplicate-path")
        channel.receive(
          JSON.stringify({
            type: "folder-entry",
            id,
            index: 1,
            path: "a.txt",
            kind: "file",
            size: 0,
          }),
        );
    }
    await vi.waitFor(() =>
      expect(engine.getSnapshot().messages[0]?.status).toBe("failed"),
    );
    expect(controls(channel).some((p) => p.type === "ack")).toBe(false);
    expect(await engine.getAttachment(id)).toBeUndefined();
    if (mode !== "duplicate-path") expect(sink.abort).toHaveBeenCalledOnce();
  });
  it("aborts a file handle that finishes opening after cancellation", async () => {
    const { engine, channel } = await setup();
    const id = offerFolder(channel);
    await pending(engine, id);
    const sink = destination();
    let release!: (value: typeof sink) => void;
    const createFile = vi.fn(
      () =>
        new Promise<typeof sink>((resolve) => {
          release = resolve;
        }),
    );
    await engine.acceptFolder(id, {
      createDirectory: async () => {},
      createFile,
    });
    channel.receive(
      JSON.stringify({
        type: "folder-entry",
        id,
        index: 0,
        kind: "file",
        path: "a.txt",
        size: 4,
      }),
    );
    await vi.waitFor(() => expect(createFile).toHaveBeenCalledOnce());
    await engine.cancelTransfer(id);
    release(sink);
    await vi.waitFor(() => expect(sink.abort).toHaveBeenCalledOnce());
    expect(sink.write).not.toHaveBeenCalled();
  });
  it("detects older receivers without sending folder contents", async () => {
    const { engine, channel } = await setup();
    const file = new File([new Uint8Array(MAX_FILE_SIZE + 1)], "test.bin");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sending = engine
      .sendFolder(
        async () => ({
          name: "资料",
          entries: [{ kind: "file", path: file.name, file }],
        }),
        () => {},
        new AbortController().signal,
      )
      .catch(() => false);
    await vi.waitFor(() =>
      expect(controls(channel).some((p) => p.type === "folder-start")).toBe(
        true,
      ),
    );
    await vi.advanceTimersByTimeAsync(FOLDER_CONFIG.supportTimeoutMs + 1);
    expect(await sending).toBe(false);
    expect(engine.getSnapshot().messages[0]?.error).toBe(
      "对方暂不支持接收文件夹，请更新后重试",
    );
    expect(channel.sent.some((p) => p instanceof ArrayBuffer)).toBe(false);
  });
});
