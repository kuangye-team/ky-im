/** Local, bounded diagnostics shared by the browser and desktop WebView. No payload logging. */
export const LOG_LIMIT = 2000;
export const LOG_MAX_BYTES = 3 * 1024 * 1024;
export const LOG_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = "hummingbird.runtime-logs";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCategory =
  | "app"
  | "discovery"
  | "connection"
  | "heartbeat"
  | "message";
export type RuntimeLog = {
  id: string;
  time: number;
  session: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  peerId?: string;
  detail?: string;
  source?: string;
  /** Sanitized source event, including stack/diagnostic metadata; never content payloads. */
  raw?: string;
};
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let sequence = 0;
const listeners = new Set<() => void>();
let pending: ReturnType<typeof setTimeout> | undefined;
let initialized = false;

// Error messages may contain URLs or credentials supplied by a service.
export function sanitizeLog(value: string, limit = 1200): string {
  return value
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return "[address]";
      }
    })
    .replace(/Bearer\s+[\w.+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /((?:authorization|token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, limit);
}
/** Bound diagnostic objects and remove credentials/content even when nested. */
export function serializeSourceLog(value: unknown): string {
  const seen = new WeakSet<object>();
  function clean(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return sanitizeLog(value, 3000);
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value !== "object") return String(value);
    if (seen.has(value)) return "[circular]";
    if (depth >= 5) return "[depth limit]";
    seen.add(value);
    if (value instanceof Error)
      return {
        name: value.name,
        message: sanitizeLog(value.message),
        stack: sanitizeLog(value.stack || "", 3000),
        ...(value.cause ? { cause: clean(value.cause, depth + 1) } : {}),
      };
    if (Array.isArray(value))
      return value.slice(0, 24).map((item) => clean(item, depth + 1));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      result[key] = /authorization|password|token|secret|api.?key/i.test(key)
        ? "[redacted]"
        : /^(text|payload|body|content|fileName)$/i.test(key)
          ? "[omitted]"
          : clean(item, depth + 1);
    }
    return result;
  }
  try {
    return JSON.stringify(clean(value), null, 2).slice(0, 6000);
  } catch {
    return "[unavailable]";
  }
}
function sourceLocation() {
  const frames = (new Error().stack?.split("\n") || []).filter((line) =>
    /(?:at |@)/.test(line),
  );
  // Skip this helper and runtimeLog, including minified production function names.
  return sanitizeLog(frames[2]?.trim() || "app", 400);
}
function readLogs(): RuntimeLog[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is RuntimeLog =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.session === "string" &&
          typeof entry.time === "number" &&
          entry.time > Date.now() - LOG_MAX_AGE &&
          ["debug", "info", "warn", "error"].includes(entry.level) &&
          ["app", "discovery", "connection", "heartbeat", "message"].includes(
            entry.category,
          ) &&
          typeof entry.message === "string" &&
          (entry.peerId === undefined || typeof entry.peerId === "string") &&
          (entry.detail === undefined || typeof entry.detail === "string"),
      )
      .slice(-LOG_LIMIT)
      .map((entry) => ({
        ...entry,
        message: sanitizeLog(entry.message),
        detail: entry.detail && sanitizeLog(entry.detail),
        source:
          typeof entry.source === "string"
            ? sanitizeLog(entry.source, 400)
            : undefined,
        raw:
          typeof entry.raw === "string"
            ? sanitizeLog(entry.raw, 6000)
            : undefined,
      }));
  } catch {
    return [];
  }
}
let entries = readLogs();
let byteSizes = entries.map((entry) => JSON.stringify(entry).length * 2);
let retainedBytes = byteSizes.reduce((sum, size) => sum + size, 0);
function trimLogs() {
  let removed = 0;
  while (
    removed < entries.length &&
    (entries.length - removed > LOG_LIMIT ||
      retainedBytes > LOG_MAX_BYTES ||
      entries[removed].time <= Date.now() - LOG_MAX_AGE)
  ) {
    retainedBytes -= byteSizes[removed++];
  }
  if (removed) {
    entries = entries.slice(removed);
    byteSizes = byteSizes.slice(removed);
  }
}
trimLogs();
export const getRuntimeLogs = () => entries;
export function subscribeRuntimeLogs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function flushRuntimeLogs() {
  clearTimeout(pending);
  pending = undefined;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* Diagnostics must never interrupt chat when storage is unavailable. */
  }
}
export function runtimeLog(
  level: LogLevel,
  category: LogCategory,
  message: string,
  context: {
    peerId?: string;
    detail?: string;
    source?: string;
    raw?: unknown;
  } = {},
) {
  const time = Date.now();
  const source = context.source || sourceLocation();
  const entry: RuntimeLog = {
    id: `${session}-${++sequence}`,
    time,
    session,
    level,
    category,
    message: sanitizeLog(message),
    ...(context.peerId ? { peerId: context.peerId.slice(0, 80) } : {}),
    ...(context.detail ? { detail: sanitizeLog(context.detail) } : {}),
    source: sanitizeLog(source, 400),
    raw: serializeSourceLog({
      source,
      time: new Date(time).toISOString(),
      level,
      category,
      event: message,
      ...(context.peerId ? { peerId: context.peerId } : {}),
      ...(context.detail ? { detail: context.detail } : {}),
      ...(context.raw !== undefined ? { diagnostic: context.raw } : {}),
    }),
  };
  const bytes = JSON.stringify(entry).length * 2;
  entries = [...entries, entry];
  byteSizes.push(bytes);
  retainedBytes += bytes;
  trimLogs();
  for (const listener of listeners) listener();
  if (level === "error" || level === "warn") flushRuntimeLogs();
  else if (!pending) pending = setTimeout(flushRuntimeLogs, 500);
}
export function clearRuntimeLogs() {
  entries = [];
  byteSizes = [];
  retainedBytes = 0;
  flushRuntimeLogs();
  for (const listener of listeners) listener();
}
export function initializeRuntimeLogs() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  runtimeLog("info", "app", "应用已启动", { detail: navigator.userAgent });
  window.addEventListener("error", (event) =>
    runtimeLog("error", "app", "运行时发生错误", {
      detail: event.message,
      raw: event.error || {
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      },
    }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    runtimeLog("error", "app", "操作意外中断", {
      raw: event.reason,
      detail:
        event.reason instanceof Error
          ? event.reason.message
          : typeof event.reason === "string"
            ? event.reason
            : "Unknown rejection",
    }),
  );
  window.addEventListener("pagehide", flushRuntimeLogs);
  document.addEventListener("visibilitychange", () => {
    runtimeLog(
      "info",
      "app",
      document.visibilityState === "visible" ? "应用回到前台" : "应用进入后台",
    );
    flushRuntimeLogs();
  });
}
