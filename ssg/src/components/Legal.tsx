import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Download,
  ExternalLink,
  Heart,
  Mail,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { siteInfo } from "../site-info";
import { MAX_FILE_SIZE } from "../config";
import { ContactCopyButton } from "./ContactCopyButton";
import "./Legal.css";

type LicenseEntry = {
  id: string;
  name: string;
  version: string;
  license: string;
  projectUrl: string;
  licenseUrl: string;
};

function ExternalLinkTo({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

export function LegalLinks({
  current,
  className,
}: {
  current?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <nav className={`legal-nav ${className || ""}`} aria-label={t("网站说明")}>
      <Link
        to="/licenses"
        aria-label={t("开源许可")}
        aria-current={current === "licenses" ? "page" : undefined}
      >
        <BookOpen size={17} aria-hidden="true" />
        <span>{t("开源许可")}</span>
      </Link>
      <Link
        to="/privacy"
        aria-label={t("隐私协议")}
        aria-current={current === "privacy" ? "page" : undefined}
      >
        <ShieldCheck size={17} aria-hidden="true" />
        <span>{t("隐私协议")}</span>
      </Link>
    </nav>
  );
}

function LegalHeading({
  title,
  subtitle,
  privacy = false,
}: {
  title: string;
  subtitle: string;
  privacy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <header className="legal-heading">
      <Link className="legal-back" to="/">
        <ArrowLeft size={15} />
        {t("返回聊天")}
      </Link>
      <div className="legal-heading-content">
        <span className="legal-heading-icon">
          {privacy ? <ShieldCheck size={27} /> : <BookOpen size={27} />}
        </span>
        <div className="legal-heading-copy">
          <h1 tabIndex={-1}>{title}</h1>
          <p>{subtitle}</p>
        </div>
      </div>
    </header>
  );
}

function LegalEmail({ onNotice }: { onNotice: (message: string) => void }) {
  return (
    <div className="legal-email">
      <a href={`mailto:${siteInfo.email}`}>{siteInfo.email}</a>
      <ContactCopyButton
        value={siteInfo.email}
        kind="email"
        onNotice={onNotice}
      />
    </div>
  );
}

export function LicensesPage({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LicenseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    fetch("/licenses/index.json", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("License list unavailable");
        const data = await response.json();
        if (
          !Array.isArray(data.entries) ||
          !data.entries.length ||
          !data.entries.every(
            (entry: LicenseEntry) =>
              entry &&
              [
                entry.id,
                entry.name,
                entry.version,
                entry.license,
                entry.projectUrl,
                entry.licenseUrl,
              ].every((value) => typeof value === "string") &&
              entry.projectUrl.startsWith("https://") &&
              /^\/licenses\/[a-zA-Z0-9._-]+\.txt$/.test(entry.licenseUrl),
          )
        )
          throw new Error("Invalid license list");
        if (!controller.signal.aborted) setEntries(data.entries);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <article className="legal-page">
      <LegalHeading
        title={t("开源许可")}
        subtitle={t(
          "本项目离不开开源社区的慷慨奉献，衷心感谢本项目所依赖的所有开源项目及其背后的贡献者！",
        )}
      />
      <div className="legal-columns">
        <section className="legal-card">
          <h2>
            <Heart size={19} />
            {t("致谢与使用")}
          </h2>
          <p>
            {t(
              "蜂鸟使用了以下开源项目。各项目的版权归原作者所有，使用、修改或分享时，请遵守对应的许可。",
            )}
          </p>
          <p>
            {t(
              "这里的许可说明适用于列出的第三方项目，不代表你分享的文字、图片和文件也采用相同许可。请尊重他人的隐私与作品。",
            )}
          </p>
        </section>
        <section className="legal-card">
          <h2>
            <Mail size={19} />
            {t("联系与反馈")}
          </h2>
          <p>
            {t(
              "使用问题、隐私请求或版权反馈，欢迎联系旷野团队。请说明相关页面与问题，无需附上私人聊天记录或无关文件。",
            )}
          </p>
          <LegalEmail onNotice={onNotice} />
        </section>
      </div>
      <section className="legal-card">
        <div className="legal-section-heading">
          <div>
            <h2>{t("开源项目与许可")}</h2>
            <p>{t("查看项目来源，或保存完整的许可说明。")}</p>
          </div>
          <a
            className="legal-download"
            href="/licenses/THIRD-PARTY-NOTICES.txt"
            download
          >
            <Download size={16} />
            {t("下载全部许可说明")}
          </a>
        </div>
        {loading ? (
          <p className="legal-status" role="status">
            {t("正在打开许可列表…")}
          </p>
        ) : error ? (
          <div className="legal-status" role="alert">
            <p>{t("许可列表暂时没有加载成功，请稍后重试。")}</p>
            <button
              className="secondary-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              <RefreshCw size={15} aria-hidden="true" />
              {t("重试")}
            </button>
          </div>
        ) : (
          <div className="license-grid">
            {entries.map((entry) => (
              <section className="license-card" key={entry.id}>
                <h3>{entry.name}</h3>
                <div className="license-meta">
                  <span>{entry.version}</span>
                  <span>{entry.license}</span>
                </div>
                <div className="legal-links">
                  <ExternalLinkTo href={entry.licenseUrl}>
                    {t("许可全文")}
                  </ExternalLinkTo>
                  <ExternalLinkTo href={entry.projectUrl}>
                    {t("项目主页与源码")}
                  </ExternalLinkTo>
                </div>
              </section>
            ))}
          </div>
        )}
      </section>
      <Link className="legal-endnote" to="/privacy">
        {t("了解聊天与文件如何保存")}
        <ArrowRight size={16} />
        {t("隐私协议")}
      </Link>
    </article>
  );
}

export function PrivacyPage({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <article className="legal-page">
      <LegalHeading
        privacy
        title={t("隐私协议")}
        subtitle={t("了解你的资料、聊天和文件如何处理。更新于 {{date}}。", {
          date: siteInfo.updated,
        })}
      />
      <div className="legal-summary">
        <ShieldCheck size={22} />
        <div>
          <strong>
            {t(
              import.meta.env.VITE_DESKTOP
                ? "聊天直达对方，记录留在自己的设备。"
                : "聊天直达对方，记录留在自己的浏览器。",
            )}
          </strong>
          <p>
            {t(
              import.meta.env.VITE_DESKTOP
                ? "客户端可通过在线服务器或本地网络发现设备，优先直接传输；双方启用中转且直连失败时，由支持中转的服务器转送。快速直连目前不加密，请在可信网络中使用。"
                : "无需注册账号。文字、图片和文件优先在设备间直传。双方启用中转且直连失败时，支持中转的服务器会转送内容，但不会保存。",
            )}
          </p>
        </div>
      </div>
      <section className="legal-card">
        <h2>{t("1. 保存在你设备上的内容")}</h2>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "客户端使用 SQLite 保存资料、联系人和聊天记录，附件保存在本地数据目录。语言、网络配置与在线状态也保存在当前设备。"
              : "你的昵称、头像、个性签名、设备标识、联系人备注、聊天记录和附件保存在当前浏览器中，用来展示资料、识别联系人和查看历史消息。语言与在线状态的选择也会保存在此浏览器。",
          )}
        </p>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "这些内容不会自动同步到其他设备。可在“存储管理”中查看和迁移数据目录，请为重要文件保留备份。"
              : "这些内容不会自动同步到其他设备，会保留到你主动删除或浏览器清理网站数据时。无痕浏览、空间不足或清理浏览器数据可能导致记录丢失，请提前下载重要文件。",
          )}
        </p>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "接收文件默认需要确认。为联系人开启自动接收后，文件和文件夹会直接写入数据目录。未完成内容暂存在缓存目录，接收完整后移入正式文件目录；中断缓存会被清理。"
              : "超过 {{limit}} MB 的文件需接收方确认，并直接保存到接收方选择的位置。双方浏览器仅保留文件名、大小、时间和传输结果，不保存文件内容。删除聊天记录不会删除已保存到设备上的文件。",
            { limit: MAX_FILE_SIZE / 1024 ** 2 },
          )}
        </p>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "客户端直接传输文件夹并保留目录结构。已接收的文件、文件夹及发送时保存的文件副本由应用管理，删除对应聊天记录也会删除这些副本；另存为到其他位置的内容不受影响。"
              : "小文件夹会在发送方设备上打包为 ZIP，按普通附件保存。直接接收的文件夹保存在你选择的位置，双方浏览器只保留名称、大小、文件数量和传输结果。中断后已完成的文件会保留，删除聊天记录不会删除它们。",
          )}
        </p>
      </section>
      <section className="legal-card">
        <h2>{t("2. 发现朋友与建立连接")}</h2>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "客户端在线时会在本地网络发布设备标识、昵称、头像、个性签名、设备名称和连接地址，帮助附近设备发现彼此。可发现你的设备也能看到这些公开资料。"
              : "打开网站并保持在线时，连接服务会处理你的网络地址、设备标识、蜂鸟号、昵称、头像、个性签名、设备名称和连接状态，帮助同一网络或通过蜂鸟号查找的设备发现彼此。可发现你的设备也能看到你的公开资料，请勿填写不想分享的信息。",
          )}
        </p>
        <p>
          {t(
            "建立直连时，双方会交换必要的网络连接信息，对方可能获知你的网络地址。使用中转时，服务器会接触传输内容，请选择你信任的服务器。安全服务器地址可保护设备与服务器之间的传输，但不向服务器隐藏内容。",
          )}
        </p>
        <p>
          {t(
            "连接期间，服务会保留必要的在线资料和设备之间的连接关系；服务确认设备离线后，会移除相应的在线状态。云端部署可能暂存这些连接信息，以便服务恢复时继续工作。",
          )}
        </p>
        <p>
          {t(
            "你可以在“我的状态”中切换为离线，停止发现和连接。已发送的内容可能已被对方保存，删除自己的记录不会删除对方的副本。",
          )}
        </p>
      </section>
      <section className="legal-card">
        <h2>{t("3. 网站访问与其他服务")}</h2>
        <p>
          {t(
            "打开网站时，托管与网络服务可能处理网络地址、访问时间、页面地址、浏览器和设备信息，用于提供页面、维持连接和保障服务安全。这些访问记录不包含聊天正文或附件。",
          )}
        </p>
        <p>
          {t(
            "使用 Cloudflare 托管时，相关访问和连接信息可能由其全球服务处理。部分安全功能可能使用 Cookie；你可以通过浏览器设置管理。具体处理方式请参阅其隐私政策。",
          )}
        </p>
        <div className="legal-links">
          <ExternalLinkTo href="https://www.cloudflare.com/privacypolicy/">
            {t("Cloudflare 隐私政策")}
          </ExternalLinkTo>
          <ExternalLinkTo href="https://developers.cloudflare.com/fundamentals/reference/policies-compliances/cloudflare-cookies/">
            {t("Cloudflare Cookie 说明")}
          </ExternalLinkTo>
        </div>
        <p>
          {t(
            "当前应用不设置广告或访问统计工具。项目主页和其他外部链接仅在你点击后打开，访问时适用对方的隐私说明。",
          )}
        </p>
      </section>
      <section className="legal-card">
        <h2>{t("4. 查看、导出和删除")}</h2>
        <p>
          {t(
            "你可以在“个人资料”中修改公开资料，在聊天中删除消息或整段记录，在“聊天记录”中导出文字记录或清空本地聊天记录，在“存储管理”中下载附件、清理文件。导出的聊天记录不包含附件本身，附件请单独下载保存。",
          )}
        </p>
        <p>
          {t(
            import.meta.env.VITE_DESKTOP
              ? "清空聊天记录会删除本机存储中的消息、附件和联系人备注，保留个人资料。另存为的文件及对方的副本需分别管理。"
              : "清空聊天记录会移除当前浏览器中的消息、附件和联系人备注，但保留你的个人资料。若要移除全部本地资料与设置，可在浏览器设置中清除本站的网站数据。下载到设备上的文件需自行管理，对方保存的内容不受影响。",
          )}
        </p>
        <Link className="legal-action" to="/history">
          {t("前往聊天记录")}
          <ArrowRight size={15} />
        </Link>
      </section>
      <section className="legal-card">
        <h2>{t("5. 联系我们与隐私请求")}</h2>
        <p>
          {t(
            "运营者：{{operator}}。如需了解信息处理方式，或提出查阅、更正、删除等请求，请通过以下邮箱联系我们。仅保存在你浏览器中的聊天与文件，我们无法查看或代为导出、删除。",
            { operator: t(siteInfo.operator) },
          )}
        </p>
        <LegalEmail onNotice={onNotice} />
        <p>
          {t(
            "发送邮件时，我们会收到你的邮箱、邮件内容及主动提供的附件，用于处理和回复相关事项。请只提供必要信息，不要发送无关的私人聊天、身份证件或文件。",
          )}
        </p>
      </section>
      <section className="legal-card">
        <h2>{t("6. 未成年人和协议更新")}</h2>
        <p>
          {t(
            "未成年人请在监护人的指导下使用蜂鸟，谨慎分享个人信息。未满十四周岁用户如需发送涉及个人信息的反馈，请由监护人联系。",
          )}
        </p>
        <p>
          {t(
            "如果以后增加账号、云端保存或其他信息处理方式，我们会先更新本协议，并在需要时另行说明和征得同意。阅读本协议本身不代表同意任何新增的信息处理。",
          )}
        </p>
      </section>
      <Link className="legal-endnote" to="/licenses">
        {t("了解支持蜂鸟的开源项目")}
        <ArrowRight size={16} />
        {t("开源许可")}
      </Link>
    </article>
  );
}
