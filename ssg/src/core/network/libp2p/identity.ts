import {
  generateKeyPair,
  privateKeyFromProtobuf,
  privateKeyToProtobuf,
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { StorageAdapter } from "../../types";

export async function identityFor(storage: StorageAdapter) {
  const load = async () => {
    let bytes = await storage.getIdentity?.();
    if (!bytes) {
      const key = await generateKeyPair("Ed25519");
      bytes = privateKeyToProtobuf(key);
      await storage.saveIdentity?.(bytes);
      bytes = (await storage.getIdentity?.()) ?? bytes;
    }
    const key = privateKeyFromProtobuf(bytes);
    return { key, id: peerIdFromPrivateKey(key).toString() };
  };
  return globalThis.navigator?.locks
    ? navigator.locks.request("hummingbird.identity", load)
    : load();
}
export type DeviceIdentity = Awaited<ReturnType<typeof identityFor>>;
