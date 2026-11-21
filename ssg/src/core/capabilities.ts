import { isNative } from "../platform";
import catalog from "../../../shared/capabilities.json";
export const CAP = Object.freeze(catalog);
export const RELEASE_VERSION = import.meta.env.RELEASE_VERSION || "0.1.0";
export interface RuntimeInfo { version: string; capabilities: string[] }
export const canDialWebTransport = () => globalThis.isSecureContext === true && typeof globalThis.WebTransport === "function";
export function localRuntime(desktop = isNative()): RuntimeInfo {
  return { version: RELEASE_VERSION, capabilities: [desktop ? CAP.app : CAP.web,
    CAP.discovery, CAP.signaling, CAP.reverseDial, CAP.query, CAP.chat, CAP.file, CAP.resume, CAP.folder, CAP.folderResume,
    CAP.receipts, CAP.webrtc, CAP.relay, ...(desktop || canDialWebTransport() ? [CAP.webtransport] : []), ...(desktop ? [CAP.tcp] : [])] };
}
export function configuredRuntime(desktop: boolean, settings: { servers: { enabled: boolean; relay?: boolean; relaySupported?: boolean }[] }): RuntimeInfo {
  const info = localRuntime(desktop);
  if (!settings.servers.some(s => s.enabled && s.relay && s.relaySupported))
    info.capabilities = info.capabilities.filter(c => c !== CAP.relay);
  return info;
}
export function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  if (!value || typeof value !== "object") return false;
  const info = value as RuntimeInfo;
  return typeof info.version === "string" && /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/.test(info.version) &&
    Array.isArray(info.capabilities) && info.capabilities.length <= 64 &&
    new Set(info.capabilities).size === info.capabilities.length &&
    info.capabilities.every(c => typeof c === "string" && c.length <= 96 && /^[a-z][a-z0-9.-]{0,79}\.v[1-9][0-9]*$/.test(c));
}
export const supports = (info: RuntimeInfo, capability: string) => info.capabilities.includes(capability);
export const commonCapabilities = (local: RuntimeInfo, remote: RuntimeInfo) =>
  local.capabilities.filter(c => remote.capabilities.includes(c));
/** Advertise the common transport set; libp2p owns selection and dialing. */
export const availableTransports = (local: RuntimeInfo, remote: RuntimeInfo) =>
  commonCapabilities(local, remote).filter(c => c === CAP.webtransport
    ? (local.capabilities.includes(CAP.web) && remote.capabilities.includes(CAP.app)) ||
      (local.capabilities.includes(CAP.app) && remote.capabilities.includes(CAP.web))
    : [CAP.tcp, CAP.webrtc, CAP.relay].includes(c));
export type CompatibilityReason = "local-update" | "peer-update" | "server-update" | "peer-unsupported" | "server-unsupported" | "no-transport";
export class CompatibilityError extends Error {
  constructor(readonly reasons: CompatibilityReason[], readonly missing: string[] = []) {
    super("暂时无法连接");
    this.name = "CompatibilityError";
  }
}
export function requireCapabilities(local: RuntimeInfo, remote: RuntimeInfo, required: readonly string[], target: "peer" | "server" = "peer") {
  const localMissing = required.filter(c => !supports(local, c));
  const remoteMissing = required.filter(c => !supports(remote, c));
  if (localMissing.length || remoteMissing.length) throw new CompatibilityError([
    ...(localMissing.length ? ["local-update" as const] : []),
    ...(remoteMissing.length ? [target === "server" ? "server-update" as const : "peer-update" as const,
      target === "server" ? "server-unsupported" as const : "peer-unsupported" as const] : []),
  ], [...new Set([...localMissing, ...remoteMissing])]);
}
export function requirePeer(local: RuntimeInfo, remote: RuntimeInfo) {
  requireCapabilities(local, remote, [CAP.query, CAP.chat]);
  const transports = availableTransports(local, remote);
  if (!transports.length) throw new CompatibilityError(["no-transport"]);
  return transports;
}
export function requireServer(value: unknown): RuntimeInfo {
  if (!isRuntimeInfo(value)) throw new CompatibilityError(["server-unsupported"]);
  requireCapabilities(localRuntime(), value, [CAP.discovery, CAP.signaling, CAP.query], "server");
  return value;
}
