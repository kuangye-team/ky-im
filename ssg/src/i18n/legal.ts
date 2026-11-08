export const legalEnglish: Record<string, string> = {
  "小文件夹会在发送方设备上打包为 ZIP，按普通附件保存。直接接收的文件夹保存在你选择的位置，双方浏览器只保留名称、大小、文件数量和传输结果。中断后已完成的文件会保留，删除聊天记录不会删除它们。":
    "Small folders are packed into ZIP files on the sender's device and saved as regular attachments. Folders received directly are saved to your chosen location; both browsers keep only the name, size, file count and transfer result. Completed files remain after an interruption. Deleting chat history does not delete them.",
  "超过 {{limit}} MB 的文件需接收方确认，并直接保存到接收方选择的位置。双方浏览器仅保留文件名、大小、时间和传输结果，不保存文件内容。删除聊天记录不会删除已保存到设备上的文件。":
    "Files over {{limit}} MB require acceptance and are saved directly to the recipient's chosen location. Both browsers keep only the filename, size, time and transfer result, without the file contents. Deleting chat history does not delete files saved to your device.",
  网站说明: "About this website",
  开源许可: "Open-source licenses",
  隐私协议: "Privacy policy",
  返回聊天: "Back to chats",
  "本项目离不开开源社区的慷慨奉献，衷心感谢本项目所依赖的所有开源项目及其背后的贡献者！":
    "This project would not be possible without the generosity of the open-source community. Our heartfelt thanks go to all the open-source projects we rely on and the contributors behind them!",
  致谢与使用: "Thanks and usage",
  "蜂鸟使用了以下开源项目。各项目的版权归原作者所有，使用、修改或分享时，请遵守对应的许可。":
    "Hummingbird uses the projects listed below. Copyright belongs to their respective authors. Please follow each project's license when using, modifying, or sharing it.",
  "这里的许可说明适用于列出的第三方项目，不代表你分享的文字、图片和文件也采用相同许可。请尊重他人的隐私与作品。":
    "These licenses cover the listed third-party projects. They do not apply to the messages, images, or files you share. Please respect others' privacy and work.",
  联系与反馈: "Contact and feedback",
  "使用问题、隐私请求或版权反馈，欢迎联系旷野团队。请说明相关页面与问题，无需附上私人聊天记录或无关文件。":
    "Contact Kuangye Team with questions, privacy requests, or copyright concerns. Describe the relevant page and issue without including private conversations or unrelated files.",
  开源项目与许可: "Projects and licenses",
  "查看项目来源，或保存完整的许可说明。":
    "Explore the projects or save their complete license notices.",
  下载全部许可说明: "Download all license notices",
  "正在打开许可列表…": "Loading licenses…",
  "许可列表暂时没有加载成功，请稍后重试。":
    "The license list could not be loaded. Please try again.",
  重试: "Try again",
  许可全文: "Full license",
  项目主页与源码: "Project and source",
  了解聊天与文件如何保存: "How your chats and files are stored",
  "了解你的资料、聊天和文件如何处理。更新于 {{date}}。":
    "How your profile, chats, and files are handled. Updated {{date}}.",
  "聊天直达对方，记录留在自己的浏览器。":
    "Chats go directly to your friends. History stays in your browser.",
  "无需注册账号。文字、图片和文件在双方设备间加密传输，网站的连接服务不转发或保存聊天内容。":
    "No account is needed. Messages, images, and files are encrypted in transit between devices. The website's connection service does not relay or store chat content.",
  "1. 保存在你设备上的内容": "1. What stays on your device",
  "你的昵称、头像、个性签名、设备标识、联系人备注、聊天记录和附件保存在当前浏览器中，用来展示资料、识别联系人和查看历史消息。语言与在线状态的选择也会保存在此浏览器。":
    "Your name, avatar, introduction, device identifier, contact nicknames, chat history, and attachments are stored in this browser to display profiles, identify contacts, and show past messages. Your language and online status preferences are also saved here.",
  "这些内容不会自动同步到其他设备，会保留到你主动删除或浏览器清理网站数据时。无痕浏览、空间不足或清理浏览器数据可能导致记录丢失，请提前下载重要文件。":
    "This information does not automatically sync to other devices. It stays until you delete it or the browser clears the website's data. Private browsing, low storage space, or clearing browser data can remove it. Download important files to keep a copy.",
  "2. 发现朋友与建立连接": "2. Finding friends and connecting",
  "打开网站并保持在线时，连接服务会处理你的网络地址、设备标识、蜂鸟号、昵称、头像、个性签名、设备名称和连接状态，帮助同一网络或通过蜂鸟号查找的设备发现彼此。可发现你的设备也能看到你的公开资料，请勿填写不想分享的信息。":
    "While you are online, the connection service processes your network address, device identifier, Hummingbird number, name, avatar, introduction, device name, and connection status. This helps devices find each other on the same network or by Hummingbird number. Devices that can discover you can also see your public profile, so only include information you want to share.",
  "建立直连时，双方会交换必要的网络连接信息，对方可能获知你的网络地址。连接服务仅协助设备发现和连接，不承担文字、图片或文件的传输。":
    "Devices exchange the network information needed to connect directly. The other person may learn your network address. The connection service only helps devices find and connect to each other; it does not transmit messages, images, or files.",
  "连接期间，服务会保留必要的在线资料和设备之间的连接关系；服务确认设备离线后，会移除相应的在线状态。云端部署可能暂存这些连接信息，以便服务恢复时继续工作。":
    "During a connection, the service keeps the necessary online profiles and connection relationships. It removes the corresponding online state after confirming a device is offline. Cloud deployments may temporarily store this connection information so the service can resume working.",
  "你可以在“我的状态”中切换为离线，停止发现和连接。已发送的内容可能已被对方保存，删除自己的记录不会删除对方的副本。":
    "Switch to Offline in “My status” to stop discovery and connections. Recipients may already have saved what you sent. Deleting your own history does not remove their copies.",
  "3. 网站访问与其他服务": "3. Website access and other services",
  "打开网站时，托管与网络服务可能处理网络地址、访问时间、页面地址、浏览器和设备信息，用于提供页面、维持连接和保障服务安全。这些访问记录不包含聊天正文或附件。":
    "Hosting and network services may process your network address, access time, page address, browser, and device information to deliver pages, maintain connections, and protect the service. These access records do not include message contents or attachments.",
  "使用 Cloudflare 托管时，相关访问和连接信息可能由其全球服务处理。部分安全功能可能使用 Cookie；你可以通过浏览器设置管理。具体处理方式请参阅其隐私政策。":
    "When hosted on Cloudflare, access and connection information may be processed by its global services. Some security features may use cookies, which you can manage in your browser settings. See Cloudflare's privacy policy for details.",
  "Cloudflare 隐私政策": "Cloudflare privacy policy",
  "Cloudflare Cookie 说明": "Cloudflare cookie information",
  "当前应用不设置广告或访问统计工具。项目主页和其他外部链接仅在你点击后打开，访问时适用对方的隐私说明。":
    "The current app has no advertising or analytics tools. Project websites and other external links open only when you click them. Their privacy policies apply when you visit.",
  "4. 查看、导出和删除": "4. Viewing, exporting, and deleting",
  "你可以在“个人资料”中修改公开资料，在聊天中删除消息或整段记录，在“聊天记录”中导出文字记录或清空本地聊天记录，在“存储管理”中下载附件、清理文件。导出的聊天记录不包含附件本身，附件请单独下载保存。":
    "Edit your public information in “Your profile”. Delete messages or entire conversations from a chat. In “Chat history”, export text records or clear local history. In “Storage management”, download attachments or delete files. History exports do not include the attachments themselves; download those separately.",
  "清空聊天记录会移除当前浏览器中的消息、附件和联系人备注，但保留你的个人资料。若要移除全部本地资料与设置，可在浏览器设置中清除本站的网站数据。下载到设备上的文件需自行管理，对方保存的内容不受影响。":
    "Clearing chat history removes messages, attachments, and contact nicknames from this browser but keeps your profile. To remove all local information and preferences, clear this website's data in your browser settings. Manage downloaded files separately. Copies saved by other people are unaffected.",
  前往聊天记录: "Open chat history",
  "5. 联系我们与隐私请求": "5. Contact and privacy requests",
  "运营者：{{operator}}。如需了解信息处理方式，或提出查阅、更正、删除等请求，请通过以下邮箱联系我们。仅保存在你浏览器中的聊天与文件，我们无法查看或代为导出、删除。":
    "Operator: {{operator}}. Contact us at the email below with questions about information handling or requests to access, correct, or delete information. We cannot view, export, or delete chats and files stored only in your browser.",
  "发送邮件时，我们会收到你的邮箱、邮件内容及主动提供的附件，用于处理和回复相关事项。请只提供必要信息，不要发送无关的私人聊天、身份证件或文件。":
    "When you email us, we receive your email address, message, and any attachments you provide to handle and respond to your request. Include only necessary information, without unrelated private chats, identity documents, or files.",
  "6. 未成年人和协议更新": "6. Minors and policy updates",
  "未成年人请在监护人的指导下使用蜂鸟，谨慎分享个人信息。未满十四周岁用户如需发送涉及个人信息的反馈，请由监护人联系。":
    "Minors should use Hummingbird with a guardian's guidance and share personal information carefully. A guardian should contact us on behalf of anyone under fourteen when feedback involves personal information.",
  "如果以后增加账号、云端保存或其他信息处理方式，我们会先更新本协议，并在需要时另行说明和征得同意。阅读本协议本身不代表同意任何新增的信息处理。":
    "If we add accounts, cloud storage, or other ways of handling information, we will update this policy first and provide further notice and request consent where needed. Reading this policy does not itself mean you agree to any new processing.",
  了解支持蜂鸟的开源项目: "Explore the projects behind Hummingbird",
};
