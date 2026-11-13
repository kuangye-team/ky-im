import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ScrollText,
  Check,
  Copy,
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
  Zap,
} from "lucide-react";
import type { ChatEngine } from "../core";
import { SIGNALING_CONFIG } from "../config";
import { newId } from "../core/protocol";
import { testServer } from "../core/network/serverTest";
import {
  DEFAULT_SERVER_ID,
  isDesktop,
  type NetworkSettings,
  type SignalServer,
} from "../core/network/settings";
import { translateError } from "../localizeError";
import { RuntimeLogs } from "./RuntimeLogs";
import { Modal } from "./Modal";
import { copyText } from "./copyText";
import "./SystemSettings.css";

export function SystemSettings({
  engine,
  onNotice,
}: {
  engine: ChatEngine;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [showLogs, setShowLogs] = useState(false);
  const serverHeadingId = useId();
  const serverKeyId = useId();
  const [settings, setSettings] = useState<NetworkSettings>(
    () => engine.networkSettings,
  );
  const [applying, setApplying] = useState(false);
  const applyingRef = useRef(false);
  const [error, setError] = useState("");
  const [errorSection, setErrorSection] =
    useState<keyof NetworkSettings>("servers");
  const [applied, setApplied] = useState(false);
  const [editor, setEditor] = useState<SignalServer | null>(null);
  const [editorError, setEditorError] = useState("");
  const [showServerKey, setShowServerKey] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const desktop = isDesktop();
  const pending = engine.hasPendingTransfers();
  const busy = applying || pending || testing !== null;
  const defaultAddress =
    SIGNALING_CONFIG.url ||
    `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/ws`;
  const adding =
    editor && !settings.servers.some((server) => server.id === editor.id);
  const apply = async (
    next: NetworkSettings,
    section: keyof NetworkSettings | "editor" = "servers",
  ) => {
    if (applyingRef.current) return false;
    applyingRef.current = true;
    setApplying(true);
    setError("");
    setEditorError("");
    setApplied(false);
    try {
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
    setTesting(server.id);
    setTestErrors((errors) => ({ ...errors, [server.id]: "" }));
    let relay: boolean | undefined;
    try {
      relay = (await testServer(server.url, 5000, server.authorization)).relay;
    } catch (error) {
      if (mounted.current)
        setTestErrors((errors) => ({
          ...errors,
          [server.id]:
            error instanceof Error
              ? error.message
              : "连接失败，请检查服务器地址或稍后重试",
        }));
    }
    if (!mounted.current) return;
    await apply({
      ...settings,
      servers: settings.servers.map((s) =>
        s.id === server.id
          ? {
              ...s,
              relaySupported: relay,
              relay: relay === true && s.relay === true,
            }
          : s,
      ),
    });
    setTesting(null);
  };
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
      <div className="settings-page-header">
        <div className="page-heading">
          <div>
            <Settings size={24} aria-hidden="true" />
            <h1>{t("系统配置")}</h1>
          </div>
          <p>
            {t(
              "选择怎么找到其他设备，以及怎么传送消息和文件。设置只保存在这台设备上。",
            )}
          </p>
        </div>
        <button
          className="secondary-button settings-log-button"
          onClick={() => setShowLogs(true)}
        >
          <ScrollText size={18} aria-hidden="true" />
          {t("运行日志")}
        </button>
      </div>
      {showLogs && <RuntimeLogs onClose={() => setShowLogs(false)} />}
      <div className="settings-feedback">
        <p>{t("修改后自动生效并重新连接。正在传输内容时，请完成后再修改。")}</p>
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
        <fieldset className="settings-card" disabled={busy}>
          <legend>
            <Radio size={19} aria-hidden="true" />
            {t("怎么找到其他设备")}
          </legend>
          <p>{t("可以同时选择，每组至少保留一种。同一台设备只会显示一次。")}</p>
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
              <strong>{t("在线查找（中心信令）")}</strong>
              <small>
                {t("通过连接服务器找到设备，也可以用蜂鸟号联系朋友。")}
              </small>
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
              <strong>{t("附近查找（mDNS）")}</strong>
              <small>
                {t(
                  "自动寻找同一 Wi-Fi 或有线网络里的客户端，没有互联网也能用。",
                )}
              </small>
            </span>
          </label>
          {errorSection === "discovery" && errorNotice}
        </fieldset>
        <fieldset className="settings-card" disabled={busy}>
          <legend>
            <Zap size={19} aria-hidden="true" />
            {t("怎么传送消息和文件")}
          </legend>
          <p>{t("同时开启时，先尝试快速直连；连接不成功，再尝试兼容传输。")}</p>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={settings.transport.tcp}
              disabled={!desktop}
              onChange={(e) =>
                void apply(
                  {
                    ...settings,
                    transport: { ...settings.transport, tcp: e.target.checked },
                  },
                  "transport",
                )
              }
            />
            <span>
              <strong>{t("快速直连（TCP）")}</strong>
              <small>
                {t("适合客户端之间直接传输，需要双方都能使用这种方式。")}
              </small>
            </span>
          </label>
          <label className="settings-choice">
            <input
              type="checkbox"
              checked={settings.transport.webrtc}
              disabled={!desktop}
              onChange={(e) =>
                void apply(
                  {
                    ...settings,
                    transport: {
                      ...settings.transport,
                      webrtc: e.target.checked,
                    },
                  },
                  "transport",
                )
              }
            />
            <span>
              <strong>{t("兼容传输（WebRTC）")}</strong>
              <small>
                {t("支持网页与客户端互传，能否连通取决于双方网络。")}
              </small>
            </span>
          </label>
          {errorSection === "transport" && errorNotice}
          {!desktop && (
            <p className="settings-hint">
              {t(
                "网页版使用在线查找和兼容传输；附近查找和快速直连需要安装客户端。",
              )}
            </p>
          )}
        </fieldset>
        <section
          className="settings-card settings-server-card"
          aria-labelledby={serverHeadingId}
        >
          <div className="settings-server-heading">
            <h2 id={serverHeadingId}>
              <Globe size={19} aria-hidden="true" />
              {t("服务器列表")}
            </h2>
            <button
              className="secondary-button"
              type="button"
              disabled={busy || settings.servers.length >= 16}
              onClick={(event) =>
                openEditor(
                  { id: newId(), name: "", url: "", enabled: true },
                  event.currentTarget,
                )
              }
            >
              <Plus size={16} aria-hidden="true" />
              {t("添加服务器")}
            </button>
          </div>
          <p>
            {t(
              "连接服务器帮助设备找到彼此。双方都开启同一服务器的中转后，直连失败时可由该服务器转送消息和文件。",
            )}
          </p>
          <div className="settings-server-columns" aria-hidden="true">
            <span>{t("服务器名称")}</span>
            <span>{t("服务器地址")}</span>
            <span>{t("操作")}</span>
          </div>
          <ul className="settings-server-list" aria-label={t("服务器列表")}>
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
                            : t("测试后可查看中转支持情况")}
                  </small>
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
                    className="icon-button"
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
                </div>
              </li>
            ))}
          </ul>
          {errorSection === "servers" && errorNotice}
          <p className="settings-hint">
            {t("默认服务器由应用提供，可设置访问密钥、启用或停用。")}
          </p>
        </section>
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
              <p className="settings-hint">
                {t("填写服务器管理员提供的完整密钥，仅保存在这台设备上。")}
              </p>
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

function ServerAddress({
  address,
  onNotice,
}: {
  address: string;
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [address]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="settings-server-address">
      <span title={address}>{address}</span>
      <button
        type="button"
        className={`icon-button${copied ? " copied" : ""}`}
        aria-label={t("复制服务器地址")}
        title={t(copied ? "已复制" : "复制服务器地址")}
        onClick={() => {
          void copyText(address).then(
            () => {
              setCopied(true);
              onNotice(t("服务器地址已复制"));
            },
            () => {
              setCopied(false);
              onNotice(t("请选中地址后手动复制"));
            },
          );
        }}
      >
        {copied ? (
          <Check size={15} aria-hidden="true" />
        ) : (
          <Copy size={15} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
