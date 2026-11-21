import { isNative } from "../platform";
import { CompatibilityError, type CompatibilityReason } from "../core/capabilities";
import { CompatibilityHelp } from "./CompatibilityHelp";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ScrollText,
  Check,
  Eye,
  EyeOff,
  Globe,
  LoaderCircle,
  Pencil,
  Plus,
  Radio,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import type { ChatEngine } from "../core";
import { SIGNALING_CONFIG } from "../config";
import { newId } from "../core/protocol";
import { testServer } from "../core/network/serverTest";
import {
  DEFAULT_SERVER_ID,
  saveSettings,
  type NetworkSettings,
  type SignalServer,
} from "../core/network/settings";
import { translateError } from "../localizeError";
import { AndroidBackground } from "./AndroidBackground";
import { RuntimeLogs } from "./RuntimeLogs";
import { IceServerSettings } from "./IceServerSettings";
import { Modal } from "./Modal";
import { ServerAddress } from "./ServerAddress";
import { TurnServerSettings } from "./TurnServerSettings";
import "./SystemSettings.css";

type SettingsSection = keyof NetworkSettings | "turnServers";

export function SystemSettings({
  engine,
  phone = false,
  onNotice,
}: {
  engine: ChatEngine;
  phone?: boolean;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation(["translation", "components"], { nsMode: "fallback" });
  const [showLogs, setShowLogs] = useState(false);
  const serverHeadingId = useId();
  const serverHeading = t("信令服务器");
  const serverKeyId = useId();
  const [settings, setSettings] = useState<NetworkSettings>(
    () => engine.networkSettings,
  );
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [error, setError] = useState("");
  const [errorSection, setErrorSection] =
    useState<SettingsSection>("servers");
  const [applied, setApplied] = useState(false);
  const [editor, setEditor] = useState<SignalServer | null>(null);
  const [editorError, setEditorError] = useState("");
  const [showServerKey, setShowServerKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testReasons, setTestReasons] = useState<Record<string, CompatibilityReason[]>>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [networkRevision, setNetworkRevision] = useState(0);
  const testedRevision = useRef(new Map<string, number>());
  useEffect(() => engine.subscribeNetworkChange(() => setNetworkRevision(n => n + 1)), [engine]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const desktop = isNative();
  const pending = engine.hasPendingTransfers();
  const busy = applying || pending || testing !== null;
  const defaultAddress =
    SIGNALING_CONFIG.url ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
  const adding =
    editor && !settings.servers.some((server) => server.id === editor.id);
  const apply = async (
    next: NetworkSettings,
    section: SettingsSection | "editor" = "servers",
  ) => {
    if (applyingRef.current) return false;
    applyingRef.current = true;
    setApplying(true);
    setError("");
    setEditorError("");
    setApplied(false);
    try {
      if (import.meta.env.VITE_ANDROID && section === "discovery" && next.discovery.mdns && (!settings.discovery.mdns || engine.needsNearbyPermission)) {
        const { nearbyPermission } = await import("../android-nearby");
        if (!await nearbyPermission("manual")) throw new Error("请在系统权限设置中允许蜂鸟查找附近设备");
      }
      await engine.configureNetwork(next);
      setSettings(engine.networkSettings);
      setApplied(true);
      return true;
    } catch (error) {
      if (section !== "editor") setErrorSection(section);
      const showError = section === "editor" ? setEditorError : setError;
      showError(error instanceof Error ? error.message : "设置未保存，请重试");
      return false;
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };
  const openEditor = (server: SignalServer, trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger;
    setError("");
    setEditorError("");
    setShowServerKey(false);
    setEditor({ ...server });
  };
  const updateEditor = (next: SignalServer) => {
    if (
      next.url !== editor?.url ||
      next.authorization !== editor?.authorization
    ) {
      next.relay = false;
      next.relaySupported = undefined;
    }
    setEditor(next);
    setEditorError("");
  };
  const runTest = async (server: SignalServer) => {
    if (busy) return;
    testedRevision.current.set(server.id, networkRevision);
    setTesting(server.id);
    setTestReasons(reasons => ({ ...reasons, [server.id]: [] }));
    setTestErrors((errors) => ({ ...errors, [server.id]: "" }));
    try {
      const { relay } = await testServer(
        server.url, 5000, server.authorization, desktop ? settings.proxyMode : undefined,
      );
      if (!mounted.current) return;
      const latest = engine.networkSettings;
      const tested = latest.servers.find(s => s.id === server.id && s.url === server.url &&
        s.authorization === server.authorization);
      if (!tested || latest.proxyMode !== settings.proxyMode || tested.relaySupported === relay) return;
      tested.relaySupported = relay;
      if (tested.relay && !relay) {
        tested.relay = false;
        await apply(latest);
      } else {
        // Recording a capability alone does not change any active route.
        setSettings(saveSettings(latest));
      }
    } catch (error) {
      if (mounted.current && error instanceof CompatibilityError) setTestReasons(reasons => ({ ...reasons, [server.id]: error.reasons }));
      if (mounted.current)
        setTestErrors((errors) => ({
          ...errors,
          [server.id]:
            error instanceof Error
              ? error.message
              : "连接失败，请检查服务器地址或稍后重试",
        }));
    } finally {
      if (mounted.current) setTesting(null);
    }
  };
  const retryTest = useEffectEvent(runTest);
  useEffect(() => {
    if (busy || editor || !settings.discovery.signaling || engine.getSnapshot().availability === "offline") return;
    const failed = settings.servers.find(server => server.enabled && testErrors[server.id] &&
      (testedRevision.current.get(server.id) ?? networkRevision) < networkRevision);
    if (failed) void retryTest(failed);
  }, [busy, editor, settings, testErrors, networkRevision, engine]);
  const saveServer = async () => {
    if (!editor || pending) return;
    const success = await apply(
      {
        ...settings,
        servers: adding
          ? [...settings.servers, editor]
          : settings.servers.map((server) =>
              server.id === editor.id ? editor : server,
            ),
      },
      "editor",
    );
    if (success) {
      setTestErrors((errors) => ({ ...errors, [editor.id]: "" }));
      setEditor(null);
    }
  };
  const errorNotice = error && (
    <p className="settings-error" role="alert">
      {translateError(error)}
    </p>
  );
  return (
    <section className="full-page system-settings">
      {!phone && <div className="settings-page-header">
        <div className="page-heading">
          <div>
            <Settings size={24} aria-hidden="true" />
            <h1>{t("系统配置")}</h1>
          </div>
          <p>{t("设置只保存在这台设备上。")}</p>
        </div>
        <button
          className="secondary-button settings-log-button"
          onClick={() => setShowLogs(true)}
        >
          <ScrollText size={18} aria-hidden="true" />
          {t("运行日志")}
        </button>
      </div>}
      {showLogs && <RuntimeLogs onClose={() => setShowLogs(false)} />}
      <div className="settings-feedback">
        {!phone && <p>{t("设置生效时会重新连接。正在传输内容时，请完成后再修改。")}</p>}
        <p role="status">
          {pending
            ? t("还有内容正在传输，请完成后再修改设置")
            : applying
              ? t("正在应用设置…")
              : applied
                ? t("设置已生效。")
                : ""}
        </p>
      </div>
      <div className="settings-sections">
        {import.meta.env.VITE_ANDROID && <AndroidBackground phone={phone} />}
        {desktop && !import.meta.env.VITE_ANDROID && (
          <fieldset className="settings-card" disabled={busy}>
            <legend><Globe size={19} aria-hidden="true" />{t("代理设置")}</legend>
            {!phone && <p>{t("选择蜂鸟连接服务器时使用的方式。")}</p>}
            <div className="settings-proxy-options">
              {(["system", "direct"] as const).map((mode) => (
                <label key={mode} className="settings-choice">
                  <input
                    type="radio"
                    name="proxy-mode"
                    checked={settings.proxyMode === mode}
                    onChange={() => void apply({ ...settings, proxyMode: mode }, "proxyMode")}
                  />
                  <strong>{mode === "system" ? t("跟随系统") : t("不使用代理")}</strong>
                </label>
              ))}
            </div>
            {errorSection === "proxyMode" && errorNotice}
          </fieldset>
        )}
        {(!phone || desktop) && <fieldset className="settings-card" disabled={busy}>
          <legend>
            <Radio size={19} aria-hidden="true" />
            {t(phone ? "查找设备" : "怎么找到其他设备")}
          </legend>
          {!phone && <p>{t("至少选择一种查找方式。同一台设备只会显示一次。")}</p>}
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={settings.discovery.signaling}
              disabled={!desktop}
              onChange={(e) =>
                void apply(
                  {
                    ...settings,
                    discovery: {
                      ...settings.discovery,
                      signaling: e.target.checked,
                    },
                  },
                  "discovery",
                )
              }
            />
            <span>
              <strong>{t(phone ? "通过网络查找" : "在线查找（中心信令）")}</strong>
              {!phone && <small>{t("通过连接服务器找到设备，也可以用蜂鸟号联系朋友。")}</small>}
            </span>
          </label>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={settings.discovery.mdns}
              disabled={!desktop}
              onChange={(e) =>
                void apply(
                  {
                    ...settings,
                    discovery: {
                      ...settings.discovery,
                      mdns: e.target.checked,
                    },
                  },
                  "discovery",
                )
              }
            />
            <span>
              <strong>{t(phone ? "查找附近设备" : "附近查找（mDNS）")}</strong>
              {!phone && <small>{t("自动寻找同一 Wi-Fi 或有线网络里的客户端，没有互联网也能用。")}</small>}
            </span>
          </label>
          {settings.discovery.mdns && engine.needsNearbyPermission && (
            <button type="button" className="secondary-button" onClick={() => void apply(settings, "discovery")}>
              {t("允许查找附近设备")}
            </button>
          )}
          {errorSection === "discovery" && errorNotice}
        </fieldset>}
        <section
          className="settings-card settings-server-card"
          aria-labelledby={serverHeadingId}
        >
          <div className="settings-server-heading">
            <h2 id={serverHeadingId}>
              <Globe size={19} aria-hidden="true" />
              {serverHeading}
            </h2>
            <button
              className="secondary-button"
              type="button"
              aria-label={t("添加服务器")}
              disabled={busy || settings.servers.length >= 16}
              onClick={(event) =>
                openEditor(
                  { id: newId(), name: "", url: "", enabled: true },
                  event.currentTarget,
                )
              }
            >
              <Plus size={16} aria-hidden="true" />
              {t(phone ? "添加" : "添加服务器")}
            </button>
          </div>
          {!phone && <p>{t("连接服务器帮助设备找到彼此。双方都开启同一服务器的中转后，直连失败时可由该服务器转送消息和文件。")}</p>}
          <div className="settings-server-columns" aria-hidden="true">
            <span>{t("服务器名称")}</span>
            <span>{t("服务器地址")}</span>
            <span>{t("操作")}</span>
          </div>
          <ul className="settings-server-list" aria-label={serverHeading}>
            {settings.servers.map((server, index) => (
              <li className="settings-server" key={server.id}>
                <div className="settings-server-name">
                  <strong>
                    {server.id === DEFAULT_SERVER_ID
                      ? t("默认服务器")
                      : server.name || t("未命名服务器")}
                  </strong>
                  <small
                    aria-live="polite"
                    className={
                      testErrors[server.id] ? "settings-test-error" : ""
                    }
                  >
                    {testing === server.id
                      ? t("正在测试…")
                      : testErrors[server.id]
                        ? t(testErrors[server.id])
                        : server.relaySupported === true
                          ? t("连接成功 · 支持中转")
                          : server.relaySupported === false
                            ? t("连接成功 · 不支持中转")
                            : !phone && t("测试后可查看中转支持情况")}
                  </small>
                  <CompatibilityHelp reasons={testReasons[server.id]} />
                </div>
                <ServerAddress
                  address={server.url || defaultAddress}
                  onNotice={onNotice}
                />
                <div className="settings-server-actions">
                  <label>
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      disabled={busy}
                      aria-label={t("启用服务器 {{index}}", {
                        index: index + 1,
                      })}
                      onChange={(e) =>
                        void apply({
                          ...settings,
                          servers: settings.servers.map((s) =>
                            s.id === server.id
                              ? { ...s, enabled: e.target.checked }
                              : s,
                          ),
                        })
                      }
                    />
                    {t("启用")}
                  </label>
                  <label
                    title={t(
                      server.relaySupported === false
                        ? "此服务器不支持中转"
                        : server.relaySupported !== true
                          ? "请先测试服务器，确认支持中转后再开启"
                          : "双方开启且直连失败后，才会使用中转",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={server.relay === true}
                      disabled={
                        busy ||
                        !server.enabled ||
                        server.relaySupported !== true
                      }
                      aria-label={t("启用服务器 {{index}} 的中转", {
                        index: index + 1,
                      })}
                      onChange={(event) =>
                        void apply({
                          ...settings,
                          servers: settings.servers.map((s) =>
                            s.id === server.id
                              ? { ...s, relay: event.target.checked }
                              : s,
                          ),
                        })
                      }
                    />
                    {t("中转")}
                  </label>
                  <button
                    type="button"
                    className="icon-button settings-probe"
                    disabled={busy}
                    aria-label={t("测试服务器 {{index}}", { index: index + 1 })}
                    title={t("测试")}
                    onClick={() => void runTest(server)}
                  >
                    {testing === server.id ? (
                      <LoaderCircle
                        size={17}
                        className="spinning"
                        aria-hidden="true"
                      />
                    ) : (
                      <Activity size={17} aria-hidden="true" />
                    )}
                    {phone && t("测试")}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("编辑服务器 {{index}}", { index: index + 1 })}
                    title={t("编辑服务器")}
                    disabled={busy}
                    onClick={(event) => openEditor(server, event.currentTarget)}
                  >
                    <Pencil size={17} aria-hidden="true" />
                  </button>
                  {(!phone || server.id !== DEFAULT_SERVER_ID) && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("删除服务器 {{index}}", { index: index + 1 })}
                      title={t("删除服务器")}
                      disabled={busy || server.id === DEFAULT_SERVER_ID}
                      onClick={() =>
                        void apply({
                          ...settings,
                          servers: settings.servers.filter(
                            (s) => s.id !== server.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {errorSection === "servers" && errorNotice}
          {!phone && <p className="settings-hint">
            {t("默认服务器由应用提供，可设置访问密钥、启用或停用。")}
          </p>}
        </section>
        <IceServerSettings
          phone={phone}
          servers={settings.iceServers}
          busy={busy}
          error={errorSection === "iceServers" ? error : ""}
          onClearError={() => setError("")}
          onNotice={onNotice}
          onApply={(iceServers) => apply({ ...settings, iceServers }, "iceServers")}
        />
        <TurnServerSettings
          phone={phone}
          servers={settings.iceServers}
          busy={busy}
          error={errorSection === "turnServers" ? error : ""}
          onClearError={() => setError("")}
          onNotice={onNotice}
          onApply={(iceServers) => apply({ ...settings, iceServers }, "turnServers")}
        />
      </div>
      {editor && (
        <Modal
          open
          title={t(adding ? "添加服务器" : "编辑服务器")}
          onClose={() => !applyingRef.current && setEditor(null)}
          onCloseAutoFocus={() => editorTrigger.current?.focus()}
          className="settings-server-modal"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveServer();
            }}
          >
            <fieldset
              className="settings-server-fields"
              disabled={applying || pending}
            >
              <label>
                {t("服务器名称")}
                <input
                  className="form-input"
                  value={
                    editor.id === DEFAULT_SERVER_ID
                      ? t("默认服务器")
                      : editor.name
                  }
                  readOnly={editor.id === DEFAULT_SERVER_ID}
                  maxLength={80}
                  autoFocus
                  placeholder={t("未命名服务器")}
                  onChange={(event) =>
                    updateEditor({ ...editor, name: event.target.value })
                  }
                />
              </label>
              <label>
                {t("服务器地址")}
                <input
                  className="form-input"
                  value={
                    editor.id === DEFAULT_SERVER_ID
                      ? editor.url || defaultAddress
                      : editor.url
                  }
                  readOnly={editor.id === DEFAULT_SERVER_ID}
                  maxLength={2048}
                  placeholder="wss://example.com/api/ws"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    updateEditor({ ...editor, url: event.target.value })
                  }
                />
              </label>
              <div className="settings-server-key-field">
                <label htmlFor={serverKeyId}>{t("访问密钥")}</label>
                <div className="settings-server-key-input">
                  <input
                    id={serverKeyId}
                    className="form-input"
                    type={showServerKey ? "text" : "password"}
                    value={editor.authorization || ""}
                    maxLength={4096}
                    placeholder={t("无需密钥时留空")}
                    autoCapitalize="none"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      updateEditor({
                        ...editor,
                        authorization: event.target.value,
                      })
                    }
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t(showServerKey ? "隐藏密钥" : "显示密钥")}
                    title={t(showServerKey ? "隐藏密钥" : "显示密钥")}
                    onClick={() => setShowServerKey((visible) => !visible)}
                  >
                    {showServerKey ? (
                      <EyeOff size={17} aria-hidden="true" />
                    ) : (
                      <Eye size={17} aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
              {!phone && <p className="settings-hint">
                {t("填写服务器管理员提供的完整密钥，仅保存在这台设备上。")}
              </p>}
            </fieldset>
            {editorError && (
              <p className="settings-error" role="alert">
                {translateError(editorError)}
              </p>
            )}
            {pending && (
              <p className="settings-hint" role="status">
                {t("还有内容正在传输，请完成后再修改设置")}
              </p>
            )}
            <div className="modal-actions">
              <label className="settings-server-enabled">
                <input
                  type="checkbox"
                  checked={editor.enabled}
                  disabled={applying || pending}
                  onChange={(event) =>
                    updateEditor({ ...editor, enabled: event.target.checked })
                  }
                />
                {t("启用")}
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={applying}
                onClick={() => setEditor(null)}
              >
                <X size={16} aria-hidden="true" />
                {t("取消")}
              </button>
              <button
                type="submit"
                className="primary-button"
                disabled={applying || pending}
                aria-busy={applying}
              >
                {applying ? (
                  <LoaderCircle
                    size={16}
                    className="spinning"
                    aria-hidden="true"
                  />
                ) : (
                  <Check size={16} aria-hidden="true" />
                )}
                {t(adding ? "添加" : "保存")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
