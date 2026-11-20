import { initializeRuntimeLogs, runtimeLog } from "./runtime-logs";
import React, { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import "./i18n";
import { createChatEngine, type ChatEngine } from "./core";
import { App } from "./App";
import "./styles.css";
import "./themes.css";
import { startAppUpdates } from "./app-updates";
import { preparePeerReset, RESET_COMPLETE, RESET_LOCK } from "./reset-app-data";
import { initializeAppIcons } from "./app-icons";

initializeRuntimeLogs();
initializeAppIcons();
startAppUpdates();
const Router = import.meta.env.VITE_DESKTOP ? HashRouter : BrowserRouter;

async function openChatEngine(): Promise<ChatEngine> {
  if (!import.meta.env.VITE_DESKTOP && navigator.locks)
    return navigator.locks.request(RESET_LOCK, () => createChatEngine());
  return createChatEngine();
}

function Bootstrap() {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<ChatEngine>();
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let current: ChatEngine | undefined;
    openChatEngine()
      .then((instance) => {
        if (!alive) {
          void instance.storage.close?.();
          return;
        }
        current = instance;
        if (instance.storage.close) {
          instance.storage.onDatabaseDelete = async () => {
            setError("另一页面正在重置蜂鸟数据，完成后将重新打开。");
            window.addEventListener("storage", (event) => {
              if (event.key === RESET_COMPLETE && event.newValue) window.location.reload();
            });
            await preparePeerReset(instance);
          };
        }
        setEngine(instance);
        instance.start();
      })
      .catch((error) => {
        runtimeLog("error", "app", "应用启动失败", { detail: error instanceof Error ? error.message : String(error), raw: error });
        if (alive)
          setError(
            import.meta.env.VITE_DESKTOP && error instanceof Error
              ? error.message
              : "浏览器暂时无法保存或读取聊天记录。",
          );
      });
    return () => {
      alive = false;
      current?.stop();
    };
  }, []);
  useLayoutEffect(() => {
    if (!engine && !error) return;
    // index.html coordinates the app and non-blocking production stylesheet.
    document.dispatchEvent(new Event("hummingbird:ready"));
  }, [engine, error]);
  const resettingElsewhere = error === "另一页面正在重置蜂鸟数据，完成后将重新打开。";
  if (error)
    return (
      <div className="boot-state" role="alert">
        <h1>{t(resettingElsewhere ? "正在重置…" : "暂时无法打开蜂鸟")}</h1>
        <p>{t(error)}</p>
        {resettingElsewhere ? null : <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "请检查数据存储目录的访问权限、磁盘空间和磁盘连接，然后重试。"
              : "请检查浏览器是否允许此网站保存数据，或换一个浏览器重试。",
          )}
        </p>}
        <button onClick={() => location.reload()}>
          <RefreshCw size={16} aria-hidden="true" />
          {t("重新加载")}
        </button>
      </div>
    );
  return engine ? <App engine={engine} /> : null;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Router>
      <Bootstrap />
    </Router>
  </React.StrictMode>,
);
