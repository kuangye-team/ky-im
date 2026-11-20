import { isNumericId } from "./protocol";
import type { Conversation } from "./types";

/** Keep this bound aligned with the discovery protocol's recentNumericIds limit. */
export const MAX_RECENT_NUMERIC_IDS = 10;

export function recentNumericIds(
  conversations: Conversation[],
  ownNumericId?: string,
): string[] {
  const numbers = new Set<string>();
  for (const { peer } of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (isNumericId(peer.numericId) && peer.numericId !== ownNumericId) {
      numbers.add(peer.numericId);
      if (numbers.size === MAX_RECENT_NUMERIC_IDS) break;
    }
  }
  return [...numbers];
}

export function generateNumericId(previous?: string): string {
  const start = crypto.getRandomValues(new Uint32Array(1))[0]! % 900_000;
  const number = String(100_000 + start);
  return number === previous ? String(100_000 + ((start + 1) % 900_000)) : number;
}
