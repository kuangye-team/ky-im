import { registerSW } from "virtual:pwa-register";

type UpdateState = {
  available: boolean;
  dismissed: boolean;
  updating: boolean;
  error: string;
};
let state: UpdateState = {
  available: false,
  dismissed: false,
  updating: false,
  error: "",
};
const listeners = new Set<() => void>();
export const getAppUpdate = () => state;
export function subscribeAppUpdate(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function patch(values: Partial<UpdateState>) {
  state = { ...state, ...values };
  listeners.forEach((listener) => listener());
}

let started = false;
let registration: ServiceWorkerRegistration | undefined;
let announcedWorker: ServiceWorker | null = null;
let activatedUpdate = false;
let activate: (() => Promise<void>) | undefined;
let prepareReload: (() => string | null) | undefined;
let reloadTimeout: ReturnType<typeof setTimeout> | undefined;
const updateError = "更新暂时未完成，请重试。";

function announceWaiting() {
  const worker = registration?.waiting;
  // A first installation is not an update. Only announce fully cached releases.
  if (
    !worker ||
    !navigator.serviceWorker.controller ||
    worker === announcedWorker
  )
    return;
  announcedWorker = worker;
  activatedUpdate = false;
  patch({ available: true, dismissed: false, error: "" });
}

function fail(message: string) {
  clearTimeout(reloadTimeout);
  prepareReload = undefined;
  patch({ updating: false, error: message });
}

function reloadIfAllowed() {
  if (!state.updating || !prepareReload) return;
  const error = prepareReload();
  if (error) {
    fail(error);
    return;
  }
  clearTimeout(reloadTimeout);
  prepareReload = undefined;
  window.location.reload();
}

export function startAppUpdates() {
  if (import.meta.env.VITE_DESKTOP || started || !("serviceWorker" in navigator)) return;
  started = true;
  const onActivated = () => {
    activatedUpdate = true;
    // Another tab may activate the shared worker. Consent belongs to this tab.
    if (!state.available) patch({ available: true, dismissed: false });
    reloadIfAllowed();
  };
  let controller = navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const next = navigator.serviceWorker.controller;
    const isUpdate = controller !== null;
    if (!next || next === controller) return;
    controller = next;
    // Workbox's short-interval/external-update heuristic can omit onNeedReload.
    if (isUpdate) onActivated();
  });
  activate = registerSW({
    immediate: true,
    onNeedRefresh: announceWaiting,
    onNeedReload: onActivated,
    onRegisteredSW(_url, current) {
      if (!current) return;
      registration = current;
      const watchInstalling = () => {
        const worker = current.installing;
        worker?.addEventListener("statechange", announceWaiting);
      };
      current.addEventListener("updatefound", watchInstalling);
      watchInstalling();
      announceWaiting();
      let checking = false;
      let lastCheck = 0;
      const check = async () => {
        if (
          document.visibilityState !== "visible" ||
          !navigator.onLine ||
          checking ||
          current.installing ||
          Date.now() - lastCheck < 30_000
        )
          return;
        checking = true;
        lastCheck = Date.now();
        try {
          await current.update();
          announceWaiting();
        } catch {
          // Offline or temporarily unreachable: keep the working app and retry later.
        } finally {
          checking = false;
        }
      };
      document.addEventListener("visibilitychange", check);
      window.addEventListener("focus", check);
      window.addEventListener("online", check);
      window.setInterval(check, 5 * 60_000);
      void check();
    },
  });
}

export function dismissAppUpdate() {
  if (!state.updating) patch({ dismissed: true, error: "" });
}

/** Recheck at activation too: a transfer can start while the worker is switching. */
export async function applyAppUpdate(beforeReload: () => string | null) {
  if (!state.available || state.updating || !activate) return;
  const error = beforeReload();
  if (error) {
    patch({ error });
    return;
  }
  prepareReload = beforeReload;
  patch({ updating: true, error: "" });
  if (activatedUpdate && !registration?.waiting) {
    reloadIfAllowed();
    return;
  }
  if (!registration?.waiting) {
    fail(updateError);
    return;
  }
  reloadTimeout = setTimeout(() => fail(updateError), 15_000);
  try {
    await activate();
  } catch {
    fail(updateError);
  }
}
