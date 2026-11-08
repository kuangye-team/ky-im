const storageKey = "hummingbird.chat-drafts";
function readDrafts(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem(storageKey) || "{}",
    );
    if (saved && typeof saved === "object" && !Array.isArray(saved))
      return Object.fromEntries(
        Object.entries(saved).filter(
          ([, text]) => typeof text === "string" && text.length > 0,
        ),
      );
  } catch {
    /* The in-memory draft still works if storage is unavailable. */
  }
  return {};
}
let drafts = readDrafts();
const listeners = new Set<() => void>();
export const getChatDrafts = () => drafts;
export function subscribeChatDrafts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function saveChatDrafts() {
  try {
    if (Object.keys(drafts).length)
      sessionStorage.setItem(storageKey, JSON.stringify(drafts));
    else sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return Object.keys(drafts).length === 0;
  }
}
export function setChatDraft(peerId: string, text: string) {
  drafts = { ...drafts, [peerId]: text };
  if (!text) delete drafts[peerId];
  saveChatDrafts();
  listeners.forEach((listener) => listener());
}
