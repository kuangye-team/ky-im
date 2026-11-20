import { useTranslation } from "react-i18next";
import { ArrowRight, CheckCheck, FileText, HardDrive, Plus, Radio, ShieldCheck } from "lucide-react";

export function Welcome({
  count,
  connected,
  onInvite,
  onNearby,
  compact = false,
}: {
  count: number;
  connected: boolean;
  onInvite: () => void;
  onNearby: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className={`welcome ${compact ? "welcome-compact" : ""}`}>
      <div className="welcome-top">
        <span>
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          {connected ? t("发现身边的美好") : t("等待网络连接")}
        </span>
      </div>
      <div className="welcome-main">
        <div className="connection-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <span className="art-dot dot-one" />
          <span className="art-dot dot-two" />
          <div className="art-peer art-peer-left">
            <span>🌿</span>
            <i />
          </div>
          <div className="art-peer art-peer-right">
            <span>🪐</span>
            <i />
          </div>
          <div className="art-bubble art-bubble-top">
            <span />
            {t("嗨，朋友！")}
          </div>
          <div className="art-bubble art-bubble-bottom">
            <FileText size={16} />
            <span>{t("分享一点好东西")}</span>
            <CheckCheck size={13} />
          </div>
          <div className="art-center">
            <span className="hummingbird-logo" />
            <span className="art-spark">✦</span>
          </div>
        </div>
        <h1>
          『<span>{t("让分享，轻快抵达")}</span>』
        </h1>
        <p>
          {t("连接同一个 Wi-Fi，打开蜂鸟。")}
          <br />
          {t("聊聊天，传照片，把好东西分享给身边的人。")}
        </p>
        <div className="welcome-buttons">
          <button className="primary-button" onClick={onInvite}>
            <Plus size={17} />
            {t("邀请朋友加入")}
          </button>
          <button className="text-button" onClick={onNearby}>
            {compact ? t("使用帮助") : t("查看在线设备")}
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="online-caption">
          <span className={`status-dot ${connected ? "" : "offline"}`} />
          {count
            ? t("{{count}} 位朋友在线，挑一位打个招呼吧", { count: count })
            : t("等朋友上线，让分享即刻发生")}
        </div>
      </div>
      <div className="welcome-features">
        <span>
          <Radio size={17} />
          {t("无需登录注册")}
        </span>
        <span>
          <ShieldCheck size={17} />
          {t("私密高速传输")}
        </span>
        <span>
          <HardDrive size={17} />
          {t("数据保存在本地")}
        </span>
      </div>
    </section>
  );
}
