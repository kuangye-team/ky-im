import {
  PROFILE_AVATARS as EMOJI,
  PROFILE_COLORS as COLORS,
  PROFILE_NAME_MAX_LENGTH,
  PROFILE_BIO_MAX_LENGTH,
} from "../config";
import { useTranslation } from "react-i18next";
import { i18n, resolveLanguage } from "../i18n";
import { generateProfileName, generateProfileBio } from "../core/profile";
import { useEffect, useState, type FormEvent } from "react";
import { Check, Shuffle, X } from "lucide-react";
import type { ChatEngine } from "../core";
import type { Profile, ChatSnapshot } from "../core/types";
import { Modal } from "./Modal";
import { OwnNumber } from "./OwnNumber";
import { MyStatus } from "./MyStatus";
import { Avatar } from "./Avatar";

export function ProfileModal({
  open,
  onClose,
  profile,
  snap,
  engine,
  onNotice,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  snap: ChatSnapshot;
  engine: ChatEngine;
  onNotice: (s: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(profile.name);
  const [bio, setBio] = useState(profile.bio);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [color, setColor] = useState(profile.color);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName(profile.name);
      setBio(profile.bio);
      setAvatar(profile.avatar);
      setColor(profile.color);
    }
  }, [open, profile.name, profile.bio, profile.avatar, profile.color]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await engine.updateProfile({
        name: name.trim(),
        bio: bio.trim(),
        avatar,
        color,
      });
      onClose();
      onNotice("个人资料已更新");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("让朋友认识你")}
      description={t("设置一个喜欢的头像和名字，在线设备都能看到。")}
      className="profile-modal"
    >
      <form onSubmit={(e) => void submit(e)}>
        <div className="profile-editor">
          <div className="profile-appearance">
            <div className="profile-identity">
              <Avatar
                peer={{ ...profile, name, avatar, color }}
                size="avatar-xl"
                online={snap.status === "connected"}
              />
              <div className="profile-identity-copy">
                <strong>{name.trim() || t("你的名字")}</strong>
                <MyStatus snap={snap} engine={engine} compact />
              </div>
            </div>
            <OwnNumber
              numericId={profile.numericId}
              compact
              onNotice={onNotice}
              onRefresh={() => engine.refreshNumericId()}
            />
            <p className="profile-status-hint">
              {snap.availability === "offline"
                ? t("主动离线后停止发现和连接，本地聊天记录仍保留。")
                : snap.status === "connected"
                  ? t("你已在线，朋友可以发现并连接这台设备。")
                  : t("当前离线，网络可用后可重新连接。")}
            </p>
            <label className="form-label">{t("选择头像")}</label>
            <div className="avatar-options">
              {EMOJI.map((value) => (
                <button
                  type="button"
                  aria-label={t("头像 {{value}}", { value: value })}
                  aria-pressed={avatar === value}
                  className={avatar === value ? "selected" : ""}
                  key={value}
                  onClick={() => setAvatar(value)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="color-options">
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  style={{ background: value }}
                  className={color === value ? "selected" : ""}
                  aria-label={t("头像颜色 {{value}}", { value: value })}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                >
                  {color === value && <Check size={14} />}
                </button>
              ))}
            </div>
          </div>
          <div className="profile-details">
            <div className="profile-field-heading">
              <label className="form-label" htmlFor="profile-name">
                {t("显示名称")}
                <span>
                  {name.length}/{PROFILE_NAME_MAX_LENGTH}
                </span>
              </label>
              <button
                type="button"
                className="profile-generate"
                aria-label={t("随机生成昵称")}
                disabled={busy}
                onClick={() =>
                  setName(
                    generateProfileName(
                      resolveLanguage("system", i18n.language),
                      name,
                    ),
                  )
                }
              >
                <Shuffle size={13} aria-hidden="true" />
                {t("随机生成")}
              </button>
            </div>
            <input
              id="profile-name"
              className="form-input"
              value={name}
              maxLength={PROFILE_NAME_MAX_LENGTH}
              required
              onChange={(e) => setName(e.target.value)}
              placeholder={t("怎么称呼你？")}
            />
            <div className="profile-field-heading">
              <label className="form-label" htmlFor="profile-bio">
                {t("个性签名")}
                <span>{t("选填")}</span>
              </label>
              <button
                type="button"
                className="profile-generate"
                aria-label={t("随机生成介绍")}
                disabled={busy}
                onClick={() =>
                  setBio(
                    generateProfileBio(
                      resolveLanguage("system", i18n.language),
                      bio,
                    ),
                  )
                }
              >
                <Shuffle size={13} aria-hidden="true" />
                {t("随机生成")}
              </button>
            </div>
            <textarea
              id="profile-bio"
              className="form-input"
              value={bio}
              maxLength={PROFILE_BIO_MAX_LENGTH}
              onChange={(e) => setBio(e.target.value)}
              placeholder={t("分享一点此刻的心情")}
            />
          </div>
        </div>
        <div className="modal-actions">
          <p className="profile-privacy-hint">
            {t("请勿填写不想分享的信息。")}
          </p>
          <button className="secondary-button" type="button" onClick={onClose}>
            <X size={15} aria-hidden="true" />
            {t("取消")}
          </button>
          <button
            className="primary-button"
            disabled={busy || !name.trim()}
            type="submit"
          >
            {busy ? t("保存中…") : t("保存资料")}
            <Check size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
