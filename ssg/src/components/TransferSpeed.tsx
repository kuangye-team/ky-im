import { useEffect, useState } from "react";
import type { ChatEngine } from "../core";
import { readableSize } from "./fileDownloads";

export function TransferSpeed({ engine, messageId }: {
  engine: ChatEngine;
  messageId: string;
}) {
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    let bytes = engine.transfers.getTransferredBytes(messageId);
    let time = performance.now();
    setSpeed(0);
    const timer = window.setInterval(() => {
      const nextBytes = engine.transfers.getTransferredBytes(messageId);
      const now = performance.now();
      const elapsed = now - time;
      // Sample actual bytes, since large files may advance less than 1% per second.
      setSpeed(elapsed > 0 ? Math.max(0, nextBytes - bytes) * 1000 / elapsed : 0);
      bytes = nextBytes;
      time = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [engine, messageId]);

  return <> · {readableSize(Math.round(speed))}/s</>;
}
