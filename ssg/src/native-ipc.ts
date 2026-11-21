import { base64pad } from "multiformats/bases/base64";

// Android WebView sends commands through postMessage. A numeric JSON array would
// allocate one JSON value per byte when a large file block crosses the bridge.
export function binaryPayload(data: ArrayBuffer) {
  if (!import.meta.env.VITE_ANDROID) return data;
  return { base64: base64pad.baseEncode(new Uint8Array(data)) };
}
