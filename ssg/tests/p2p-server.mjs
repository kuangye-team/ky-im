import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
const server = createServer((_, res) => res.end("ok"));
const ws = new WebSocketServer({ server, maxPayload: 3 * 1024 * 1024 });
const binary = fileURLToPath(
  new URL("../../temp/cache/cargo/debug/examples/p2p-harness", import.meta.url),
);
ws.on("connection", (socket) => {
  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (data) => process.stderr.write(data));
  let buffered = Buffer.alloc(0);
  child.stdout.on("data", (data) => {
    buffered = Buffer.concat([buffered, data]);
    while (buffered.length >= 4) {
      const size = buffered.readUInt32BE(0);
      if (buffered.length < 4 + size) break;
      const kind = buffered[4], payload = buffered.subarray(5, 4 + size);
      if (socket.readyState === 1)
        socket.send(kind === 1 ? payload.toString() : payload);
      buffered = buffered.subarray(4 + size);
    }
  });
  socket.on("message", (message, binary) => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(message.length + 1);
    header[4] = binary ? 2 : 1;
    child.stdin.write(Buffer.concat([header, message]));
  });
  socket.on("close", () => child.kill());
  child.on("exit", () => socket.close());
});
server.listen(4320, "127.0.0.1");
