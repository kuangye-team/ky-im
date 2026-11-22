import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDownToLine, ArrowUpRight, Globe, Laptop, LoaderCircle, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CLIENT_CONFIG } from "../config";
import { isNative } from "../platform";
import { detectDesktopPlatform, loadClientRelease, type ClientRelease, type ClientPlatform } from "../client-downloads";
import { openExternalUrl } from "../external-links";
import { detectDevice } from "../device-platform";
import "./ClientAccess.css";

export function ClientAccess({ onNotice, iconOnly = false }: { onNotice: (message: string) => void; iconOnly?: boolean }) {
  const { t } = useTranslation();
  if (!isNative()) return <ClientDownload iconOnly={iconOnly} />;
  const label = t("打开网页版");
  return <button className={iconOnly ? "phone-client-access" : "client-access-button"} aria-label={label} title={label} onClick={() => {
    void openExternalUrl(CLIENT_CONFIG.webUrl).catch(() => onNotice("链接暂时无法打开，请稍后重试。"));
  }}>
    <Globe size={iconOnly ? 22 : 16} aria-hidden="true" />{!iconOnly && <span>{label}</span>}
  </button>;
}

function ClientDownload({ iconOnly }: { iconOnly: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [release, setRelease] = useState<ClientRelease>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const platform = detectDevice(navigator) === "Android" ? "android" : detectDesktopPlatform(navigator);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const trigger = useRef<HTMLAnchorElement>(null);
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
    if (iconOnly) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) setOpen(false);
    }, 180);
  };
  const launch = (event: MouseEvent<HTMLAnchorElement>) => {
    keepOpen();
    if (!iconOnly && !platform && !window.matchMedia("(max-width: 680px)").matches) {
      event.preventDefault();
      return;
    }
    setAttempted(true);
  };
  const platforms: ClientPlatform[] = iconOnly ? ["android", "macos", "windows"] : ["macos", "windows", "android"];
  if (platform) platforms.sort((left, right) => Number(right === platform) - Number(left === platform));
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Anchor asChild>
      <a ref={trigger} role="button" href={CLIENT_CONFIG.launchUrl} className={iconOnly ? "phone-client-access" : "client-access-button"} onClick={launch}
        aria-label={iconOnly ? t("打开客户端") : undefined} title={iconOnly ? t("打开客户端") : undefined}
        onPointerEnter={(event) => { if (!iconOnly && event.pointerType === "mouse") keepOpen(); }}
        onPointerLeave={scheduleClose} onFocus={iconOnly ? undefined : keepOpen}
        onBlur={(event) => { if (!panel.current?.contains(event.relatedTarget)) scheduleClose(); }}
        onKeyDown={(event) => {
          if (event.key === " ") { event.preventDefault(); event.currentTarget.click(); }
          if (event.key === "Escape") { clearTimeout(closeTimer.current); setOpen(false); }
          if (event.key === "ArrowDown") { event.preventDefault(); keepOpen(); panel.current?.querySelector<HTMLElement>("a, button")?.focus(); }
        }}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}>
        {iconOnly ? <Globe size={22} aria-hidden="true" /> : <><Laptop size={16} aria-hidden="true" /><span>{t("打开客户端")}</span></>}
      </a>
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
        <div className="client-download-options">
          {platforms.map((system) => {
            const url = release?.downloads[system];
            if (!url) return null;
            return <a key={system} href={url} target="_blank" rel="noopener noreferrer"
              className={`client-download-option${platform === system ? " recommended" : ""}`}>
              {system === "android" ? <Smartphone size={21} /> : system === "macos" ? <Laptop size={21} /> : <Monitor size={21} />}
              <span><strong>{{ macos: "macOS", windows: "Windows", android: "Android" }[system]}</strong>
                <small>{system === "android" ? "APK" : system === "macos" ? t("Apple 芯片与 Intel") : "Windows 10 / 11"}</small></span>
              {platform === system && <em>{t("适合此设备")}</em>}
              <ArrowDownToLine size={17} aria-hidden="true" />
            </a>;
          })}
        </div>
        <div className="client-download-footer">
          <div className="client-download-footer-row">
            <p>{t(attempted ? "若未打开，请先下载并安装客户端。" : !platform ? "客户端支持 Android、macOS 和 Windows。" : "已安装？点击上方按钮即可打开。")}</p>
            <a href={CLIENT_CONFIG.downloadUrl} target="_blank" rel="noopener noreferrer">{t("查看所有下载")}<ArrowUpRight size={13} /></a>
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
