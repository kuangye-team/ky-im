import { translateError } from "../localizeError";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import {
  Download,
  File,
  FolderOpen,
  HardDrive,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { ChatEngine } from "../core";
import { LARGE_FILE_BYTES } from "../core/storage";
import type { ChatSnapshot, Message, StorageInfo } from "../core/types";
import { Modal } from "./Modal";
import { downloadAttachment, readableSize } from "./fileDownloads";
import "./StoragePage.css";

export function StoragePage({
  engine,
  snap,
  onNotice,
}: {
  engine: ChatEngine;
  snap: ChatSnapshot;
  onNotice: (text: string) => void;
}) {
  const { t, i18n } = useTranslation("components");
  const largeFileThreshold = readableSize(LARGE_FILE_BYTES).replace(
    /\.0 (?=\w)/,
    " ",
  );
  const desktop = !!engine.storage.getStorageInfo;
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [moving, setMoving] = useState(false);
  const [directoryError, setDirectoryError] = useState("");
  const [pendingDirectory, setPendingDirectory] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageEstimate | null>(null);
  const [files, setFiles] = useState<Message[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [filter, setFilter] = useState<"all" | "large">("all");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [pendingDeletion, setPendingDeletion] = useState<Message[] | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError("");
    void engine.storage
      .getFiles()
      .then((nextFiles) => {
        if (!current) return;
        setFiles(nextFiles);
        const ids = new Set(nextFiles.map((file) => file.id));
        setSelected(
          (previous) => new Set([...previous].filter((id) => ids.has(id))),
        );
      })
      .catch(() => {
        if (current) setLoadError("暂时无法读取文件，请重试。");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    if (engine.storage.getStorageInfo) {
      void engine.storage
        .getStorageInfo()
        .then((info) => {
          if (current) {
            setStorageInfo(info);
            setUsage({ usage: info.usage });
          }
        })
        .catch((error) => {
          if (current)
            setDirectoryError(
              error instanceof Error ? error.message : String(error),
            );
        });
    } else
      void navigator.storage
        ?.estimate?.()
        .then((estimate) => {
          if (current) setUsage(estimate);
        })
        .catch(() => {
          if (current) setUsage(null);
        });
    return () => {
      current = false;
    };
  }, [engine, snap.messages, snap.conversations, refreshVersion]);

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
  const largeFilesSize = largeFiles.reduce(
    (total, file) => total + (file.size || 0),
    0,
  );
  const selectedFiles = visibleFiles.filter((file) => selected.has(file.id));
  const selectedSize = selectedFiles.reduce(
    (total, file) => total + (file.size || 0),
    0,
  );
  const totalSize = files.reduce((total, file) => total + (file.size || 0), 0);
  const allSelected =
    visibleFiles.length > 0 && selectedFiles.length === visibleFiles.length;
  const busy = loading || deleting || moving || !!downloading || !!loadError;
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
      setFiles((previous) => previous.filter((file) => !ids.has(file.id)));
      setSelected(
        (previous) => new Set([...previous].filter((id) => !ids.has(id))),
      );
      setPendingDeletion(null);
      setRefreshVersion((value) => value + 1);
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
      const { open } = await import("@tauri-apps/plugin-dialog");
      const directory = await open({
        directory: true,
        multiple: false,
        defaultPath: storageInfo?.directory,
      });
      if (directory && directory !== storageInfo?.directory)
        setPendingDirectory(directory);
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
      setStorageInfo(info);
      setUsage({ usage: info.usage });
      setPendingDirectory(null);
      onNotice(
        t(
          info.cleanupWarning
            ? "数据已迁移，原目录未能清理，可手动删除原目录。"
            : "数据存储目录已迁移",
        ),
      );
      setRefreshVersion((value) => value + 1);
    } catch (error) {
      setDirectoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMoving(false);
    }
  };

  return (
    <section className="full-page storage-page storage-manager">
      <div className="page-heading">
        <h1>{t("存储管理")}</h1>
        <p>
          {t(
            desktop
              ? "查看存储用量，整理保存在这台设备上的图片、文件和文件夹。"
              : "查看存储用量，整理保存在这个浏览器里的图片和文件。",
          )}
        </p>
      </div>
      {desktop && (
        <section className="storage-directory" aria-busy={moving}>
          <div className="storage-directory-heading">
            <h2>
              <FolderOpen size={20} />
              {t("数据存储目录")}
            </h2>
            <button
              className="secondary-button"
              disabled={busy || engine.hasPendingTransfers() || !storageInfo}
              onClick={() => void chooseDirectory()}
            >
              {t("修改目录")}
            </button>
          </div>
          <p className="storage-directory-path">
            {storageInfo?.directory || t("正在读取文件…")}
          </p>
          <p>
            {t(
              "接收中的文件暂存在缓存目录，完成后自动移入文件目录。修改目录会迁移全部聊天记录和文件。",
            )}
          </p>
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
      <div
        className={`storage-metrics${desktop ? " storage-metrics-with-cache" : ""}`}
        aria-label={t("存储统计")}
      >
        <div>
          <span>{t("已用空间")}</span>
          <strong>
            {usage?.usage !== undefined
              ? readableSize(usage.usage)
              : t("暂不可用")}
          </strong>
          <small className="metric-detail">
            {t(desktop ? "本地数据与缓存" : "当前浏览器估算")}
          </small>
        </div>
        {desktop && (
          <div>
            <span>{t("缓存占用")}</span>
            <strong>
              {storageInfo
                ? readableSize(storageInfo.cacheUsage)
                : t("暂不可用")}
            </strong>
          </div>
        )}
        <div>
          <span>{t("文件数")}</span>
          <strong>
            {loadError ? "—" : loading ? "…" : files.length}
            <small> {t("个")}</small>
          </strong>
          <small className="metric-detail">
            {loadError ? "—" : loading ? "…" : readableSize(totalSize)}
          </small>
        </div>
        <div>
          <span>{t("大文件数")}</span>
          <strong>
            {loadError ? "—" : loading ? "…" : largeFiles.length}
            <small> {t("个")}</small>
          </strong>
          <small className="metric-detail">
            {loadError ? "—" : loading ? "…" : readableSize(largeFilesSize)}
          </small>
        </div>
      </div>

      <section
        className="large-files-section"
        aria-labelledby="large-files-heading"
        aria-busy={loading}
      >
        <div className="large-files-heading">
          <div>
            <h2 id="large-files-heading">
              <HardDrive size={21} />
              {t("文件管理")}
            </h2>
            <p>{t("已保存的图片和文件按大小排序，下载后可留存一份。")}</p>
          </div>
          <button
            className="danger-outline"
            disabled={busy || !largeFiles.length}
            onClick={() => confirmDeletion(largeFiles)}
          >
            <Trash2 size={15} aria-hidden="true" />
            {t("清理全部大文件")}
          </button>
        </div>
        <div
          className="storage-file-filters"
          role="group"
          aria-label={t("文件筛选")}
        >
          {(["all", "large"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              disabled={deleting}
              onClick={() => {
                setFilter(value);
                setSelected(new Set());
              }}
            >
              {value === "all" ? (
                <FolderOpen size={15} aria-hidden="true" />
              ) : (
                <HardDrive size={15} aria-hidden="true" />
              )}
              {t(value === "all" ? "全部文件" : "大文件")}
            </button>
          ))}
          <span>
            {t("大文件为 {{size}} 及以上", { size: largeFileThreshold })}
          </span>
        </div>

        {loadError ? (
          <div className="large-files-empty" role="alert">
            <p>{t(loadError)}</p>
            <button
              className="secondary-button"
              onClick={() => setRefreshVersion((value) => value + 1)}
            >
              <RefreshCw size={14} />
              {t("重新加载")}
            </button>
          </div>
        ) : !visibleFiles.length ? (
          <div className="large-files-empty" role="status">
            {loading ? (
              <LoaderCircle size={27} className="history-spinner" />
            ) : (
              <FolderOpen size={30} />
            )}
            <strong>
              {loading
                ? t("正在读取文件…")
                : t(filter === "large" ? "还没有大文件" : "还没有保存的文件")}
            </strong>
            {!loading && (
              <p>
                {filter === "large"
                  ? t("这里会列出 {{size}} 及以上的本地图片和文件。", {
                      size: largeFileThreshold,
                    })
                  : t("聊天中保存的图片和文件会出现在这里。")}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="large-files-toolbar">
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
                {selectedFiles.length
                  ? t("已选 {{count}} 个 · {{size}}", {
                      count: selectedFiles.length,
                      size: readableSize(selectedSize),
                    })
                  : t("{{count}} 个文件 · {{size}}", {
                      count: visibleFiles.length,
                      size: readableSize(visibleSize),
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
            </div>
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
                    className={selected.has(file.id) ? "is-selected" : ""}
                  >
                    <label className="large-file-check">
                      <input
                        type="checkbox"
                        aria-label={t("选择 {{name}}", { name })}
                        checked={selected.has(file.id)}
                        disabled={busy}
                        onChange={() => toggleFile(file.id)}
                      />
                    </label>
                    <span className="large-file-icon">
                      {file.kind === "image" ? (
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
                    <div className="large-file-actions">
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
                      <button
                        className="icon-button large-file-delete"
                        aria-label={t("删除 {{name}}", { name })}
                        title={t("删除文件及对应消息")}
                        disabled={busy}
                        onClick={() => confirmDeletion([file])}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="large-files-note">
              {t(
                "清理会删除所选文件和对应聊天消息；正在传输的文件会停止本地传输。",
              )}
            </p>
          </>
        )}
      </section>

      <p className="storage-footnote">
        <Info size={14} />
        {t(
          desktop
            ? "文件保存在数据存储目录。清理前请备份重要文件，对方保存的内容不受影响。"
            : "文件只保存在当前浏览器。清理前请下载重要文件，对方保存的内容不受影响。",
        )}
      </p>

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
          "请选择空文件夹。迁移完成后会切换到新目录并清理原目录；迁移期间请勿退出应用。",
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
          desktop
            ? "这会删除此设备中所选文件及对应聊天消息，无法恢复。对方的记录不受影响，联系人和备注会保留。"
            : "这会删除此浏览器中所选文件及对应聊天消息，无法恢复。对方的记录不受影响，联系人和备注会保留。",
        )}
      >
        <p className="large-files-confirm-size">
          {t("将清理 {{size}} 的附件。", {
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
