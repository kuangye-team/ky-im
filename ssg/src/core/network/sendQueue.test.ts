import { expect, it } from "vitest";
import { SendQueue, priorityControl } from "./sendQueue";
it("lets independent controls pass queued data without reordering file boundaries or starving data", () => {
  const queue = new SendQueue<string>();
  for (const type of ["file-start", "binary", "file-end"]) queue.push(type);
  for (let n = 0; n < 6; n++) queue.push(`ping-${n}`, true);
  const values: string[] = [];
  while (queue.length) values.push(queue.shift()!);
  expect(values).toEqual(["ping-0", "ping-1", "ping-2", "ping-3", "file-start", "ping-4", "ping-5", "binary", "file-end"]);
  expect(priorityControl('{"type":"file-end"}')).toBe(false);
  expect(priorityControl('{"type":"ack"}')).toBe(true);
  expect(priorityControl(new ArrayBuffer(8))).toBe(false);
});
