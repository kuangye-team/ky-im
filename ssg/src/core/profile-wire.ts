import type { Profile } from "./types";
import { isRuntimeInfo } from "./capabilities";
import { isNumericId, isProfile } from "./protocol";

export function publicProfile(profile: Profile) {
  const { id, numericId, name, bio, avatar, color, revision, extend,
    device, clientType, version, capabilities, maxMessageSize } = profile;
  return { id, numericId, name, bio, avatar, color, revision, extend,
    runtime: { version, clientType, device, capabilities, maxMessageSize } };
}

export const PROFILE_FRAME_BYTES = 32 * 1024;

// Reserve enough room for the longest legal response envelope, including a future revision.
export function fitsProfileResponse(profile: Profile) {
  const revision = Number.MAX_SAFE_INTEGER;
  const packet = { type: "pong", requestId: "0".repeat(64), selfRevision: revision,
    profile: { ...publicProfile(profile), revision } };
  return new TextEncoder().encode(JSON.stringify(packet)).length <= PROFILE_FRAME_BYTES;
}

export function fullProfile(value: unknown): Profile | undefined {
  if (!value || typeof value !== "object") return;
  const { id, numericId, name, bio, avatar, color, revision, extend, runtime } = value as ReturnType<typeof publicProfile>;
  if (!runtime || !Number.isSafeInteger(revision) || !isNumericId(numericId)) return;
  const { device, clientType, version, capabilities, maxMessageSize } = runtime;
  const profile = { id, numericId, name, bio, avatar, color, revision, extend,
    device, clientType, version, capabilities, maxMessageSize };
  if (isProfile(profile)) return profile;
}

export function discoverySummary(profile: Profile, relay: boolean, extend?: Record<string, unknown>) {
  return { id: profile.id, numericId: profile.numericId, name: profile.name,
    clientType: profile.clientType,
    capabilities: profile.capabilities, relay, ...(extend && {extend}) };
}

// Discovery views have no verified revision. Only a peer exchange can supply one.
export function discoveryView(value: unknown): (Profile & {relay: boolean}) | undefined {
  if (!value || typeof value !== "object") return;
  const { id, numericId, name, capabilities, clientType, relay, extend } = value as ReturnType<typeof discoverySummary>;
  if (!isNumericId(numericId) || !isRuntimeInfo({version: "0", capabilities})) return;
  const profile = {id, numericId, name, capabilities, extend, relay: relay === true, version: "0",
    clientType,
    bio: "", avatar: "🐦", color: "#4E729A"};
  if (isProfile(profile)) return profile;
}

export function storedProfile(record: unknown) {
  return fullProfile(record) ?? (isProfile(record) ? record : undefined);
}
