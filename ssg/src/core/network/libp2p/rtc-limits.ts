import { pEvent } from "p-event";
import { CONNECTION_CONFIG, MAX_FILE_CHUNK_BYTES, rtcMessageSizeFromEnv } from "../../../config";

export const rtcMessageLimit = rtcMessageSizeFromEnv(import.meta.env.VITE_RTC_MAX_MESSAGE_SIZE);
const low = Number(import.meta.env.VITE_RTC_BUFFERED_AMOUNT_LOW_THRESHOLD?.trim() || 256 * 1024);
export const rtcLowWater = Number.isInteger(low) && low >= 0 && low <= 0xffffffff ? low : 256 * 1024;
const chunk = Number(import.meta.env.VITE_RTC_FILE_CHUNK_SIZE);
export const rtcFileChunkBytes = Number.isInteger(chunk) && chunk > 0 && chunk <= MAX_FILE_CHUNK_BYTES ? chunk : 256 * 1024;
const configured = Number(import.meta.env.VITE_RTC_MAX_BUFFERED_AMOUNT);
export const rtcHighWater = Number.isSafeInteger(configured) && configured >= rtcMessageLimit ? configured : 1024 * 1024;
function limit(value: number | undefined, fallback: number) {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
export const rtcCanSend = (buffered: number, next: number, high = rtcHighWater) => buffered + next <= high;

export async function waitForRtcBuffer(dc: RTCDataChannel, next: number, high: number, signal: AbortSignal) {
  while (!rtcCanSend(dc.bufferedAmount, next, high)) {
    signal.throwIfAborted();
    if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
      await pEvent(dc, "bufferedamountlow", { signal });
    } else {
      // A small configured send buffer can fill below the threshold, without another low event.
      await new Promise(resolve => setTimeout(resolve, CONNECTION_CONFIG.pollIntervalMs));
    }
  }
  signal.throwIfAborted();
}

export function rtcSliceSize(local?: number, remote?: number, negotiated?: number) {
  return Math.min(limit(local, 16384), limit(remote, 16384), limit(negotiated, rtcMessageLimit), rtcMessageLimit);
}

export async function localMessageSize(desktop: boolean) {
  if (desktop) return rtcMessageLimit;
  let caller: RTCPeerConnection | undefined, callee: RTCPeerConnection | undefined;
  try {
    caller = new RTCPeerConnection();
    callee = new RTCPeerConnection();
    caller.createDataChannel("probe");
    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription(await callee.createAnswer());
    await caller.setRemoteDescription(callee.localDescription!);
    const size = caller.sctp?.maxMessageSize;
    const measured = size === Infinity ? rtcMessageLimit : limit(size, 0);
    return measured > 0 ? Math.min(measured, rtcMessageLimit) : undefined;
  } catch { return undefined; }
  finally { caller?.close(); callee?.close(); }
}
