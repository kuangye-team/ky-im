import React, { useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import "./i18n";
import { createChatEngine, type ChatEngine } from "./core";
import { App } from "./App";
import "./styles.css";
import "./themes.css";
import { startAppUpdates } from "./pwa";

startAppUpdates();

function Bootstrap() {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<ChatEngine>();
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let current: ChatEngine | undefined;
    createChatEngine()
      .then((instance) => {
        if (!alive) return;
        current = instance;
        setEngine(instance);
        instance.start();
      })
      .catch(() => {
        if (alive) setError("浏览器暂时无法保存或读取聊天记录。");
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
  if (error)
    return (
      <div className="boot-state" role="alert">
        <h1>{t("暂时无法打开蜂鸟")}</h1>
        <p>{t(error)}</p>
        <p>{t("请检查浏览器是否允许此网站保存数据，或换一个浏览器重试。")}</p>
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
    <BrowserRouter>
      <Bootstrap />
    </BrowserRouter>
  </React.StrictMode>,
);
