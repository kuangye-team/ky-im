import { useEffect, useId, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownToLine, ArrowUpRight, Globe, Laptop, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLIENT_CONFIG } from "../config";
import { isDesktop } from "../core/network/settings";
import { detectDesktopPlatform, loadClientRelease, type ClientRelease } from "../client-downloads";
import { openExternalUrl } from "../external-links";
import "./ClientAccess.css";

export function ClientAccess({ onNotice }: { onNotice: (message: string) => void }) {
  const { t } = useTranslation();
  if (!isDesktop()) return <ClientDownload />;
  return <button className="client-access-button" onClick={() => {
    void openExternalUrl(CLIENT_CONFIG.webUrl).catch(() => onNotice("链接暂时无法打开，请稍后重试。"));
  }}>
    <Globe size={16} aria-hidden="true" /><span>{t("打开WEB端")}</span>
  </button>;
}

function ClientDownload() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState<ClientRelease>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const platform = detectDesktopPlatform(navigator);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const headingId = useId();
  const request = () => {
    setLoading(true);
    setFailed(false);
    void loadClientRelease().then(setRelease).catch(() => setFailed(true)).finally(() => setLoading(false));
  };
  useEffect(() => {
    if (open && !release && !loading && !failed) request();
  }, [open, release, loading, failed]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const keepOpen = () => {
    clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };
  const launch = () => {
    keepOpen();
    if (!platform) return;
    setAttempted(true);
    // Keep this synchronous with the user's click so browsers can ask to open the app.
    window.location.href = CLIENT_CONFIG.launchUrl;
  };
  const platforms = platform === "windows" ? ["windows", "macos"] as const : ["macos", "windows"] as const;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Anchor asChild>
      <button ref={trigger} className="client-access-button" onClick={launch}
        onPointerEnter={(event) => { if (event.pointerType === "mouse") keepOpen(); }}
        onPointerLeave={scheduleClose} onFocus={keepOpen}
        onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) scheduleClose(); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { clearTimeout(closeTimer.current); setOpen(false); }
          if (event.key === "ArrowDown") { event.preventDefault(); keepOpen(); panel.current?.querySelector<HTMLElement>("a, button")?.focus(); }
        }}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}>
        <Laptop size={16} aria-hidden="true" /><span>{t("打开客户端")}</span>
      </button>
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content ref={panel} id={panelId} className="client-download-panel" align="end" sideOffset={12}
        collisionPadding={12} aria-labelledby={headingId}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => { if (trigger.current?.contains(event.target as Node)) event.preventDefault(); }}
        onPointerEnter={() => clearTimeout(closeTimer.current)} onPointerLeave={scheduleClose}
        onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) scheduleClose(); }}>
        <div className="client-download-heading">
          <span className="client-download-mark"><Laptop size={22} aria-hidden="true" /></span>
          <div><strong id={headingId}>{t("下载蜂鸟客户端")}</strong><p>{t("让聊天与分享，随时在身边。")}</p></div>
          {release && <span className="client-download-version">v{release.version.replace(/^v/, "")}</span>}
        </div>
        {loading && <p className="client-download-message" role="status"><LoaderCircle size={16} className="client-download-spinner" />{t("正在获取下载地址…")}</p>}
        {failed && <div className="client-download-message" role="alert">
          <span>{t("下载地址暂时无法获取，请稍后重试。")}</span>
          <button className="secondary-button" onClick={request}><RefreshCw size={14} />{t("重试")}</button>
        </div>}
        {release && <div className="client-download-options">
          {platforms.map((system) => {
            const url = release.downloads[system];
            if (!url) return null;
            return <a key={system} href={url} target="_blank" rel="noopener noreferrer"
              className={`client-download-option${platform === system ? " recommended" : ""}`}>
              {system === "macos" ? <Laptop size={21} /> : <Monitor size={21} />}
              <span><strong>{system === "macos" ? "macOS" : "Windows"}</strong>
                <small>{system === "macos" ? t("Apple 芯片与 Intel") : "Windows 10 / 11"}</small></span>
              {platform === system && <em>{t("适合此设备")}</em>}
              <ArrowDownToLine size={17} aria-hidden="true" />
            </a>;
          })}
        </div>}
        <div className="client-download-footer">
          <div className="client-download-footer-row">
            <p>{t(!platform ? "客户端支持 macOS 和 Windows。" : attempted ? "若未打开，请先下载并安装客户端。" : "已安装？点击上方按钮即可打开。")}</p>
            <a href={CLIENT_CONFIG.downloadUrl} target="_blank" rel="noopener noreferrer">{t("查看所有下载")}<ArrowUpRight size={13} /></a>
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
