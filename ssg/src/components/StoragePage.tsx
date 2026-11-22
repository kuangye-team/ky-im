import { translateError } from "../localizeError";
import { useTranslation } from "react-i18next";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ChevronRight,
  Download,
  File,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { ChatEngine } from "../core";
import { LARGE_FILE_BYTES } from "../core/storage";
import type { ChatSnapshot, Message } from "../core/types";
import { storageUsage } from "../core/storage/usage";
import { Modal } from "./Modal";
import { FileMenuActions } from "./attachmentActions";
import { FileActionsMenu } from "./SharedFileActions";
import { ResetDataButton } from "./ResetDataButton";
import { downloadAttachment, readableSize } from "./fileDownloads";
import "./StoragePage.css";

export function StoragePage({
  engine,
  phone = false,
  snap,
  onNotice,
}: {
  engine: ChatEngine;
  phone?: boolean;
  snap: ChatSnapshot;
  onNotice: (text: string) => void;
}) {
  const { t, i18n } = useTranslation("components");
  const largeFileThreshold = readableSize(LARGE_FILE_BYTES).replace(
    /\.0 (?=\w)/,
    " ",
  );
  const android = import.meta.env.VITE_ANDROID;
  const desktop = !!engine.storage.getStorageInfo;
  const view = storageUsage(engine.storage);
  const { result, loading, error: loadError } = useSyncExternalStore(view.subscribe, view.snapshot);
  const storageInfo = result?.info;
  const files = result?.files ?? [];
  const [movedDirectory, setMovedDirectory] = useState("");
  const directory = storageInfo?.directory ?? movedDirectory;
  // Android reports permission status for every user-chosen folder, including one named “应用内”.
  const defaultFolder = android && directory === "应用内" && storageInfo?.directoryUnavailable === undefined;
  const [moving, setMoving] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [pendingDirectory, setPendingDirectory] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"all" | "large">("all");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [pendingDeletion, setPendingDeletion] = useState<Message[] | null>(
    null,
  );

  useEffect(() => {
    void view.refresh();
  }, [view]);

  const downloadFile = async (file: Message) => {
    if (downloading) return;
    setDownloading(file.id);
    try {
      await downloadAttachment(engine.storage, file);
    } catch (error) {
      onNotice(
        error instanceof Error
          ? translateError(error.message)
          : t("下载失败，请重试"),
      );
    } finally {
      setDownloading(null);
    }
  };

  const toggleFile = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const largeFiles = files.filter(
    (file) => (file.size || 0) >= LARGE_FILE_BYTES,
  );
  const visibleFiles = filter === "large" ? largeFiles : files;
  const visibleSize = visibleFiles.reduce(
    (total, file) => total + (file.size || 0),
    0,
  );
  const selectedFiles = visibleFiles.filter((file) => selected.has(file.id));
  const selectedSize = selectedFiles.reduce(
    (total, file) => total + (file.size || 0),
    0,
  );
  const showChecks = !phone || selecting;
  const usage = result?.usage === undefined ? undefined : readableSize(result.usage).split(" ");
  const allSelected =
    visibleFiles.length > 0 && selectedFiles.length === visibleFiles.length;
  const busy = loading || deleting || moving || resetting || !!downloading;
  const confirmDeletion = (targets: Message[]) => {
    setDeleteError("");
    setPendingDeletion(targets);
  };
  const deleteFiles = async () => {
    if (!pendingDeletion || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const ids = new Set(pendingDeletion.map((file) => file.id));
      await engine.deleteMessages([...ids]);
      setSelected(
        (previous) => new Set([...previous].filter((id) => !ids.has(id))),
      );
      setPendingDeletion(null);
      setSelecting(false);
      onNotice(t("已清理 {{count}} 个文件及对应消息", { count: ids.size }));
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "删除失败，请重试",
      );
    } finally {
      setDeleting(false);
    }
  };

  const chooseDirectory = async () => {
    setDirectoryError("");
    try {
      if (android) {
        const { invoke } = await import("@tauri-apps/api/core");
        const name = await invoke<string | null>("android_save_location");
        if (name) {
          await view.refresh(true);
          onNotice(t("保存位置已更改，仅影响新附件。"));
        }
        return;
      }
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({
        directory: true,
        multiple: false,
        defaultPath: directory || undefined,
      });
      if (chosen && chosen !== directory) setPendingDirectory(chosen);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : String(error));
    }
  };
  const migrate = async () => {
    if (!pendingDirectory || moving) return;
    setMoving(true);
    setDirectoryError("");
    try {
      const info = await engine.moveStorage(pendingDirectory);
      setMovedDirectory(info.directory);
      setSelected(new Set());
      setPendingDirectory(null);
      onNotice(
        t(
          info.cleanupWarning
            ? "文件已迁移，原位置仍有部分文件或缓存。"
            : "数据存储目录已迁移",
        ),
      );
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoving(false);
    }
  };

  return (
    <section className="full-page storage-page storage-manager">
      {!phone && <div className="page-heading"><h1>{t("存储管理")}</h1></div>}
      <div className="storage-summary">
        <section className="storage-usage" aria-label={t("存储统计")}>
          <div className="storage-usage-heading">
            <span>
              <HardDrive size={16} aria-hidden="true" />
              {t(desktop ? "已用空间" : "本站用量估算")}
            </span>
            <button
              type="button"
              className="storage-sync"
              aria-label={t("刷新存储用量")}
              title={t("刷新存储用量")}
              aria-busy={loading}
              disabled={loading || moving || resetting || deleting}
              onClick={() => void view.refresh(true)}
            >
              <RefreshCw size={15} className={loading ? "history-spinner" : undefined} aria-hidden="true" />
            </button>
          </div>
          <div className="storage-usage-values">
            <strong>{usage ? <>{usage[0]} <small>{usage[1]}</small></> : loading ? "…" : t("暂不可用")}</strong>
            {desktop && storageInfo && (
              <span>{t("缓存占用")} <b>{readableSize(storageInfo.cacheUsage)}</b></span>
            )}
          </div>
        </section>
        {desktop && (
          <section className="storage-directory" aria-busy={moving}>
            <div className="storage-directory-heading">
              <FolderOpen size={18} aria-hidden="true" />
              <div>
                <h2>{t(android ? "附件保存位置" : "数据存储目录")}</h2>
                {directory && !defaultFolder && <p className="storage-directory-path">{directory}</p>}
              </div>
              <button
                className="storage-text-action"
                aria-label={t(android ? "更改附件保存位置" : "修改目录")}
                disabled={busy || engine.hasPendingTransfers() || !directory}
                onClick={() => void chooseDirectory()}
              >
                {t(android ? "更改" : "修改目录")}<ChevronRight size={15} aria-hidden="true" />
              </button>
            </div>
            {storageInfo?.directoryUnavailable && <p role="alert">{t("无法使用这个文件夹，请重新选择保存位置")}</p>}
            {storageInfo?.cleanupPending && (
              <p role="status">
                {t("部分已删除文件仍被占用，关闭占用程序后刷新即可重试清理。")}
              </p>
            )}
            {engine.hasPendingTransfers() && !moving && (
              <p>{t("请等待文件传输完成后再修改存储目录")}</p>
            )}
            {directoryError && !pendingDirectory && (
              <p className="large-files-error" role="alert">
                {translateError(directoryError)}
              </p>
            )}
          </section>
        )}
      </div>

      <section
        className="large-files-section"
        aria-labelledby="large-files-heading"
        aria-busy={loading}
      >
        <div className="large-files-heading">
          <h2 id="large-files-heading">
            {t("聊天文件")}
            {result && <small>{readableSize(visibleSize)}</small>}
          </h2>
          {filter === "large" && (
            <span className="storage-filter-detail">{t("{{size}} 及以上", { size: largeFileThreshold })}</span>
          )}
          {!phone && (
            <div className="storage-manager-actions">
              <ResetDataButton engine={engine} disabled={moving || deleting || !!downloading} onBusy={setResetting} />
              <button
                className="danger-outline"
                disabled={busy || !largeFiles.length}
                onClick={() => confirmDeletion(largeFiles)}
              >
                <Trash2 size={15} aria-hidden="true" />{t("清理全部大文件")}
              </button>
            </div>
          )}
        </div>
        <div className="storage-list-controls">
          <div className="storage-file-filters" role="group" aria-label={t("文件筛选")}>
            {(["all", "large"] as const).map((value) => (
              <button
                key={value}
                aria-pressed={filter === value}
                title={value === "large" ? t("大文件为 {{size}} 及以上", { size: largeFileThreshold }) : undefined}
                disabled={deleting}
                onClick={() => {
                  if (filter === value) return;
                  setFilter(value);
                  setSelecting(false);
                  setSelected(new Set());
                }}
              >
                {t(value === "all" ? "全部文件" : "大文件")}
                {result && <span>{value === "all" ? files.length : largeFiles.length}</span>}
              </button>
            ))}
          </div>
          {phone && (selecting || visibleFiles.length > 0) && (
            <button
              className="storage-text-action"
              disabled={busy}
              onClick={() => {
                setSelecting(!selecting);
                setSelected(new Set());
              }}
            >
              {t(selecting ? "取消" : "选择文件")}
            </button>
          )}
        </div>

        {loadError && <p className="large-files-error" role="alert">{t("暂时无法读取存储用量，请重试。")}</p>}
        {!result && !loading ? null : !visibleFiles.length ? (
          <div className="large-files-empty" role="status">
            {loading && !result ? (
              <LoaderCircle size={27} className="history-spinner" />
            ) : (
              <FolderOpen size={30} />
            )}
            <strong>
              {loading && !result
                ? t("正在读取文件…")
                : t(filter === "large" ? "还没有大文件" : "还没有保存的文件")}
            </strong>
          </div>
        ) : (
          <>
            {showChecks && <div className="large-files-toolbar">
              <label className="large-files-select-all">
                <input
                  type="checkbox"
                  aria-label={t(filter === "large" ? "全选大文件" : "全选文件")}
                  checked={allSelected}
                  ref={(input) => {
                    if (input)
                      input.indeterminate =
                        selectedFiles.length > 0 && !allSelected;
                  }}
                  disabled={busy}
                  onChange={() =>
                    setSelected(
                      allSelected
                        ? new Set()
                        : new Set(visibleFiles.map((file) => file.id)),
                    )
                  }
                />
                {t("全选")}
              </label>
              <span className="large-files-selection" aria-live="polite">
                {selectedFiles.length > 0 && t("已选 {{count}} 个 · {{size}}", {
                  count: selectedFiles.length,
                  size: readableSize(selectedSize),
                })}
              </span>
              <button
                className="danger-outline"
                disabled={busy || !selectedFiles.length}
                onClick={() => confirmDeletion(selectedFiles)}
              >
                <Trash2 size={14} />
                {t("删除所选")}
              </button>
            </div>}
            <ul
              className="large-files-list"
              aria-label={t(filter === "large" ? "大文件列表" : "文件列表")}
            >
              {visibleFiles.map((file) => {
                const conversation = snap.conversations.find(
                  (item) => item.peer.id === file.peerId,
                );
                const name =
                  file.fileName ||
                  (file.kind === "image" ? t("图片") : t("未命名文件"));
                return (
                  <li
                    key={file.id}
                    className={showChecks && selected.has(file.id) ? "is-selected" : ""}
                  >
                    {showChecks && <label className="large-file-check">
                      <input
                        type="checkbox"
                        aria-label={t("选择 {{name}}", { name })}
                        checked={selected.has(file.id)}
                        disabled={busy}
                        onChange={() => toggleFile(file.id)}
                      />
                    </label>}
                    <span className="large-file-icon" aria-hidden="true">
                      {file.folder ? <FolderOpen size={21} /> : file.kind === "image" ? (
                        <ImageIcon size={21} />
                      ) : (
                        <File size={21} />
                      )}
                    </span>
                    <div className="large-file-description">
                      <strong title={name}>{name}</strong>
                      <span>
                        {conversation?.remark ||
                          conversation?.peer.name ||
                          t("聊天附件")}
                        <i>·</i>
                        {new Date(file.createdAt).toLocaleDateString(
                          i18n.language,
                        )}
                        {file.status === "sending" && <em>{t("传输中")}</em>}
                      </span>
                    </div>
                    <span className="large-file-size">
                      {readableSize(file.size)}
                    </span>
                    {(!phone || !selecting) && <FileMenuActions message={file} storage={engine.storage} onNotice={onNotice}>{actions => (
                      <div className="large-file-actions">
                        <FileActionsMenu fileName={name} actions={actions} />
                        <button
                          className="icon-button large-file-download"
                          aria-label={t("下载 {{name}}", { name })}
                          title={
                            downloading === file.id
                              ? t("正在准备下载…")
                              : t("下载文件")
                          }
                          aria-busy={downloading === file.id}
                          disabled={busy}
                          onClick={() => void downloadFile(file)}
                        >
                          {downloading === file.id ? (
                            <LoaderCircle size={17} className="history-spinner" />
                          ) : (
                            <Download size={17} />
                          )}
                        </button>
                        {!phone && <button
                          className="icon-button large-file-delete"
                          aria-label={t("删除 {{name}}", { name })}
                          title={t("删除文件及对应消息")}
                          disabled={busy}
                          onClick={() => confirmDeletion([file])}
                        >
                          <Trash2 size={17} />
                        </button>}
                      </div>
                    )}</FileMenuActions>}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <Modal
        open={!!pendingDirectory}
        onClose={() => {
          if (!moving) {
            setPendingDirectory(null);
            setDirectoryError("");
          }
        }}
        title={t("迁移数据存储目录")}
        description={t(
          "请选择空文件夹，或切回默认位置。迁移期间请保持应用打开。从自选位置迁出时会保留原文件副本。",
        )}
      >
        <p className="storage-directory-path">{pendingDirectory}</p>
        {directoryError && (
          <p className="large-files-error" role="alert">
            {translateError(directoryError)}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="secondary-button"
            disabled={moving}
            onClick={() => setPendingDirectory(null)}
          >
            {t("取消")}
          </button>
          <button
            className="primary-button"
            disabled={moving || engine.hasPendingTransfers()}
            onClick={() => void migrate()}
          >
            {moving && <LoaderCircle size={15} className="history-spinner" />}
            {t(moving ? "正在迁移…" : "开始迁移")}
          </button>
        </div>
      </Modal>
      <Modal
        open={!!pendingDeletion}
        onClose={() => {
          if (!deleting) setPendingDeletion(null);
        }}
        title={t("删除 {{count}} 个文件？", {
          count: pendingDeletion?.length || 0,
        })}
        description={t(
          android
            ? "对应的聊天消息将一并删除。存到自选文件夹的附件会保留。"
            : desktop
            ? "这会删除此设备中所选文件及对应聊天消息，无法恢复。对方的记录不受影响，联系人和备注会保留。"
            : "这会删除此浏览器中所选文件及对应聊天消息，无法恢复。对方的记录不受影响，联系人和备注会保留。",
        )}
      >
        <p className="large-files-confirm-size">
          {t(android ? "所选附件共 {{size}}。" : "将清理 {{size}} 的附件。", {
            size: readableSize(
              pendingDeletion?.reduce(
                (total, file) => total + (file.size || 0),
                0,
              ),
            ),
          })}
        </p>
        {pendingDeletion?.some((file) => file.status === "sending") && (
          <p className="large-files-confirm-size">
            {t("选中的文件仍在传输，删除后会停止本地传输。")}
          </p>
        )}
        {deleteError && (
          <p className="large-files-error" role="alert">
            {t(translateError(deleteError))}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="secondary-button"
            disabled={deleting}
            onClick={() => setPendingDeletion(null)}
          >
            <X size={15} aria-hidden="true" />
            {t("取消")}
          </button>
          <button
            className="danger-button"
            disabled={deleting}
            onClick={() => void deleteFiles()}
          >
            {deleting ? (
              <LoaderCircle
                size={15}
                className="history-spinner"
                aria-hidden="true"
              />
            ) : (
              <Trash2 size={15} aria-hidden="true" />
            )}
            {deleting ? t("正在删除…") : t("确认删除")}
          </button>
        </div>
      </Modal>
    </section>
  );
}
