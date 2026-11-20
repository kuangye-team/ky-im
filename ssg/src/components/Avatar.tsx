import { type CSSProperties } from "react";
import { Laptop, Smartphone } from "lucide-react";
import { isMobileDevice } from "../device-platform";
import type { Profile, ChatSnapshot } from "../core/types";

const validColor = (color: string) =>
  /^#[0-9a-f]{6}$/i.test(color) ? color : "#7266ed";
export function Avatar({
  peer,
  size = "",
  online,
}: {
  peer: Profile;
  size?: string;
  online?: boolean;
}) {
  return (
    <span
      className={`avatar ${size}`}
      style={{ "--avatar-color": validColor(peer.color) } as CSSProperties}
    >
      <span>{peer.avatar || peer.name.slice(0, 1)}</span>
      {online !== undefined && <i className={online ? "online" : ""} />}
    </span>
  );
}
export function DeviceIcon({ peer, size = 16 }: { peer: Pick<Profile, "device" | "clientType">; size?: number }) {
  return (peer.clientType === "mobile" || (peer.clientType === "web" && isMobileDevice(peer.device))) ? (
    <Smartphone size={size} />
  ) : (
    <Laptop size={size} />
  );
}
export function peerName(peer: Profile, snap: ChatSnapshot) {
  return (
    snap.conversations.find((c) => c.peer.id === peer.id)?.remark || peer.name
  );
}
