import { i18n } from "./i18n";

/** 只对系统错误使用此函数；消息正文、文件名、联系人资料保持原文。 */
export function translateError(message: string): string {
  const remark = /^备注名称不能超过 (\d+) 字$/.exec(message);
  if (remark)
    return i18n.t("备注名称不能超过 {{limit}} 字", { limit: remark[1] });
  const file = /^“([\s\S]*)”超过 (\d+(?:\.\d+)?) MB，请选择较小的文件$/.exec(
    message,
  );
  if (file)
    return i18n.t("“{{name}}”超过 {{limit}} MB，请选择较小的文件", {
      name: file[1],
      limit: file[2],
    });
  const adapter = /^未找到存储适配器：([\s\S]+)$/.exec(message);
  if (adapter)
    return i18n.t("未找到存储适配器：{{type}}", { type: adapter[1] });
  return i18n.t(message);
}
