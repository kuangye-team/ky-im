import { useLayoutEffect, useSyncExternalStore } from "react";

function forgetOverlayMarker() {
  const state = { ...history.state };
  delete state.phoneOverlay;
  history.replaceState(state, "");
}
// A reload restores the route but transient panels start closed.
if (history.state?.phoneOverlay) forgetOverlayMarker();

const narrow = window.matchMedia("(max-width: 680px)");
function subscribe(callback: () => void) {
  window.addEventListener("resize", callback);
  return () => window.removeEventListener("resize", callback);
}

function layout() {
  const desktop = narrow.matches ? "compact-desktop" : "desktop";
  const { userAgent, platform, maxTouchPoints } = navigator;
  if (/iPad/i.test(userAgent) || (/Mac/i.test(platform) && maxTouchPoints > 1)) return desktop;
  if (/iPhone|iPod/i.test(userAgent)) return "phone";
  // Physical screen size stays stable when the keyboard or a split window opens.
  if (/Android.+Mobile/i.test(userAgent) && screen.width > screen.height && screen.height < 500) return "phone";
  return narrow.matches ? "phone" : "desktop";
}

export function useMobileLayout() {
  const mode = useSyncExternalStore(subscribe, layout);
  const phone = mode === "phone";
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.layout = phone ? "phone" : "desktop";
    if (!phone || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const sync = () => {
      if (viewport.scale !== 1) return;
      root.style.setProperty("--phone-height", viewport.height + "px");
      root.style.setProperty("--phone-top", viewport.offsetTop + "px");
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      root.style.removeProperty("--phone-height");
      root.style.removeProperty("--phone-top");
    };
  }, [phone]);
  return mode;
}

// Radix panels live in portals. Keep a single same-page history entry while one
// is open so WebView back, Safari back, and the close button dismiss the same layer.
export function usePhoneOverlayBack(phone: boolean, routeKey: string) {
  useLayoutEffect(() => {
    if (!phone) return;
    let armedAt = "";
    let closingFromUI = false;
    let nextSync = 0;
    const surface = () => document.querySelector('[role="dialog"][data-state="open"], [role="menu"][data-state="open"]');
    const sync = () => {
      if (surface()) {
        if (!history.state?.phoneOverlay) {
          armedAt = location.href;
          history.pushState({ ...history.state, phoneOverlay: true }, "");
        }
      } else if (history.state?.phoneOverlay && !closingFromUI) {
        closingFromUI = true;
        history.back();
      }
    };
    const back = (event: PopStateEvent) => {
      if (!armedAt || armedAt !== location.href || event.state?.phoneOverlay) return;
      armedAt = "";
      event.stopImmediatePropagation();
      if (!closingFromUI && surface()) {
        const target = document.activeElement ?? document;
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      }
      closingFromUI = false;
      nextSync = requestAnimationFrame(sync);
    };
    const observer = new MutationObserver(records => {
      if (records.some(record => record.target === document.body || !document.getElementById("root")?.contains(record.target))) sync();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-state"] });
    window.addEventListener("popstate", back, true);
    if (history.state?.phoneOverlay) armedAt = location.href;
    sync();
    return () => {
      cancelAnimationFrame(nextSync);
      observer.disconnect();
      window.removeEventListener("popstate", back, true);
      if (history.state?.phoneOverlay) forgetOverlayMarker();
    };
  }, [phone, routeKey]);
}
