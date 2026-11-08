/** 核心层继续保存稳定的原始错误；只在界面展示时翻译，历史错误也可随语言切换。 */
export const errorEnglish: Record<string, string> = {
  "当前浏览器不支持保存文件夹，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试":
    "This browser cannot save folders. Open a secure connection in Chrome or Edge on a computer and try again.",
  "文件夹名称无法使用，请重命名后重试":
    "This folder name cannot be used. Rename it and try again.",
  "文件夹目录无法读取，请检查后重试":
    "The folder structure could not be read. Check the folder and try again.",
  "文件夹内容过多，请分成几次发送":
    "This folder has too many items. Send it in smaller groups.",
  "文件无法读取，请重新选择": "The file could not be read. Select it again.",
  "文件夹过大，请分成几次发送":
    "This folder is too large. Send it in smaller groups.",
  "没有读取到文件，请尝试拖入文件夹":
    "No files were found. Try dragging the folder into the chat.",
  请一次选择一个文件夹: "Choose one folder at a time.",
  "同名文件夹过多，请选择其他保存位置":
    "Too many folders share this name. Choose another location.",
  "文件夹中存在重名内容，已停止接收以避免覆盖":
    "Some folder items have conflicting names. Receiving stopped to protect existing files.",
  "文件夹目录不完整，请重新发送":
    "The folder structure is incomplete. Send it again.",
  "文件夹内容与发送清单不一致，请重新发送":
    "The folder contents do not match the file list. Send it again.",
  "对方暂不支持接收文件夹，请更新后重试":
    "The recipient cannot receive folders yet. Update the app and try again.",
  "对方未确认接收，请重新发送": "The recipient did not accept. Send it again.",
  "文件已发生变化，请重新选择文件夹":
    "A file has changed. Select the folder again.",
  "文件夹接收不完整，请重新发送":
    "The folder was not fully received. Send it again.",
  "文件夹无法保存，请检查保存权限和磁盘空间后重试":
    "The folder could not be saved. Check permissions and free disk space, then try again.",
  "正在准备文件夹，请稍候": "A folder is being prepared. Please wait.",
  "文件夹发送失败，请重试": "The folder could not be sent. Please try again.",
  "当前选择方式不包含空文件夹；如需保留空文件夹，请拖入文件夹":
    "This picker does not include empty folders. Drag the folder into the chat to keep them.",
  "当前浏览器不支持接收超大文件，请使用电脑上的 Chrome 或 Edge 打开安全连接后重试":
    "This browser cannot receive very large files. Open a secure connection in Chrome or Edge on a computer and try again.",
  "文件无法保存，请检查磁盘空间后重试":
    "The file could not be saved. Check your free disk space and try again.",
  对方已拒绝接收此文件: "The recipient declined this file.",
  尚未同意接收此文件: "This file has not been accepted.",
  "等待接收确认已超时，请重新发送":
    "The request to receive this file expired. Please send it again.",
  "对方未确认接收，请确认双方已更新并重新发送":
    "No acceptance received. Make sure both devices are up to date and send again.",
  "文件过大，无法传输，请拆分后发送":
    "This file is too large to transfer. Split it into smaller files.",
  "此文件仅保留传输记录，请重新选择原文件发送":
    "Only the transfer record is kept. Select the original file to send it again.",
  "正在刷新蜂鸟号，请稍候": "Refreshing your Hummingbird number. Please wait.",
  "刷新蜂鸟号超时，请稍后重试":
    "Refreshing your number timed out. Please try again.",
  "刷新蜂鸟号失败，请稍后重试":
    "Could not refresh your number. Please try again.",
  "操作失败，请重试": "The operation failed. Please try again.",
  "连接已关闭，请重试": "The connection was closed. Please try again.",
  连接已关闭: "Connection closed",
  "暂时连不上蜂鸟，请检查网络后重试。":
    "Unable to reach Hummingbird. Check your connection and try again.",
  "连接已断开，请稍后重试": "Disconnected. Please try again shortly.",
  "网络已断开，请重新发送": "The network disconnected. Please send again.",
  "尚未连上蜂鸟，请稍后重试":
    "Not connected to Hummingbird yet. Please try again shortly.",
  "尚未连上蜂鸟，请检查网络后重新连接":
    "Not connected to Hummingbird. Check your network and reconnect.",
  "查找超时，请确认对方在线后重试":
    "The search timed out. Make sure the other device is online and try again.",
  "对方当前离线，消息未发送":
    "The other device is offline. Your message was not sent.",
  "请输入 6 位蜂鸟号（首位不能为 0）":
    "Enter a 6-digit Hummingbird number that does not start with 0.",
  "正在建立连接，请稍候": "Connecting. Please wait.",
  "你已离线，请先将我的状态切换为在线":
    "You are offline. Set your status to online first.",
  "设备列表无效，请重新查找蜂鸟号":
    "The device list is invalid. Search for the Hummingbird number again.",
  "暂时无法建立设备连接，请稍后重试":
    "Unable to connect to the device. Please try again shortly.",
  "返回的设备不是原联系人，请向对方确认新的蜂鸟号":
    "This is a different device. Ask your contact for their new Hummingbird number.",
  "此设备已在另一个标签页打开。请在那个标签页继续，或点击重新连接。":
    "This device is open in another tab. Continue there, or reconnect here.",
  "连接超时，请检查网络后重新连接":
    "The connection timed out. Check your network and reconnect.",
  "连接已断开，请重新连接": "Disconnected. Please reconnect.",
  "操作过于频繁，请稍后重试": "Too many requests. Please try again shortly.",
  "连接暂时繁忙，请稍后重试":
    "The connection is busy. Please try again shortly.",
  "当前在线人数较多，请稍后再来":
    "Too many devices are online. Please try again later.",
  "蜂鸟暂时繁忙，请稍后重试": "Hummingbird is busy. Please try again shortly.",
  "个人资料未能保存，请检查名称和签名后重试":
    "Your profile could not be saved. Check your name and bio and try again.",
  "暂时找不到对方，请确认对方保持页面打开":
    "Device not found. Make sure the other person keeps this page open.",
  请选择另一位联系人开始聊天: "Choose another contact to start a chat.",
  "连接遇到问题，请重新连接后重试":
    "There was a connection problem. Reconnect and try again.",
  "对方已离线，请稍后重新发送":
    "The other device went offline. Please send again later.",
  "未找到在线设备，请确认对方的蜂鸟号并保持在线":
    "No online devices found. Check the Hummingbird number and make sure the other device stays online.",
  请选择另一台设备建立连接: "Choose another device to connect.",
  "请输入有效的 6 位蜂鸟号": "Enter a valid 6-digit Hummingbird number.",
  "该分组中未找到原联系人，请向对方确认新的蜂鸟号":
    "Your original contact is not in this group. Ask them for their new Hummingbird number.",
  "无法确认联系人身份，请重新选择联系人":
    "Unable to confirm the contact's identity. Select the contact again.",
  "查找过于频繁，请稍后重试": "Too many searches. Please try again shortly.",
  "暂时找不到对方，请稍后重试": "Device not found. Please try again shortly.",
  "当前浏览器暂时无法聊天，请更新浏览器或换一个浏览器重试。":
    "This browser cannot connect. Update it or try another browser.",
  "没能连上对方，请确认双方连接同一网络，并保持页面打开":
    "Unable to connect. Make sure both devices are on the same network and keep this page open.",
  设备连接已中断: "The device connection was interrupted.",
  "接收数据过快，连接已暂停，请重新发送":
    "Data arrived too quickly. The connection was paused. Please send again.",
  "传输遇到问题，请重新发送": "The transfer failed. Please send again.",
  "连接已断开，请重新发送": "Disconnected. Please send again.",
  无法建立设备连接: "Unable to connect to the device.",
  设备连接已断开: "Device disconnected",
  "暂时连不上对方，请确认双方连接同一网络，并保持页面打开后重试。":
    "Unable to connect. Make sure both devices are on the same network, keep the page open, and try again.",
  "消息过长，请减少内容后重试":
    "The message is too long. Shorten it and try again.",
  文件传输中断: "File transfer interrupted",
  文件传输超时: "File transfer timed out",
  "上次传输已中断，请重新发送":
    "The previous transfer was interrupted. Please send again.",
  请输入有效的备注名称: "Enter a valid contact nickname.",
  "备注名称不能超过 {{limit}} 字":
    "Contact nicknames cannot exceed {{limit}} characters.",
  "未找到聊天对象，请刷新后重试": "Contact not found. Refresh and try again.",
  "昵称需为 1–40 字，简介不超过 160 字，请检查个人资料":
    "Names must be 1–40 characters and bios no more than 160. Check your profile.",
  "未收到对方的接收确认，请重新发送":
    "No delivery confirmation received. Please send again.",
  "这条消息已被删除，无法转发":
    "This message was deleted and cannot be forwarded.",
  "附件传输尚未完成，请稍后转发":
    "The attachment is still transferring. Forward it once the transfer finishes.",
  "附件尚未接收完成或已被清除，无法转发":
    "This attachment is incomplete or was removed and cannot be forwarded.",
  "请先上线，再转发消息": "Go online before forwarding messages.",
  "对方当前离线，请选择在线联系人转发":
    "This contact is offline. Choose an online contact to forward to.",
  "转发未完成，传输已中断，请重试":
    "Forwarding was interrupted. Please try again.",
  "消息太长了，请分成几条发送":
    "The message is too long. Split it into smaller messages.",
  "“{{name}}”超过 {{limit}} MB，请选择较小的文件":
    "“{{name}}” exceeds {{limit}} MB. Choose a smaller file.",
  文件传输已取消: "File transfer cancelled",
  "文件没有接收完整，请让对方重新发送":
    "The file was not fully received. Ask the sender to send it again.",
  文件数据不完整: "Incomplete file data",
  "接收文件超时，请让对方重新发送":
    "Receiving the file timed out. Ask the sender to send it again.",
  "对方暂时无法保存消息，请让对方检查浏览器空间":
    "The recipient could not save the message. Ask them to check their browser storage.",
  "接收任务过多，请稍后重试":
    "Too many incoming transfers. Please try again shortly.",
  "浏览器空间不足，请先下载重要文件，再清理不需要的记录":
    "Browser storage is full. Download important files, then clear unwanted history.",
  "对方暂时无法保存文件，请让对方检查浏览器空间":
    "The recipient could not save the file. Ask them to check their browser storage.",
  "文件接收不完整，未保存附件":
    "The file is incomplete. The attachment was not saved.",
  文件接收不完整: "Incomplete file transfer",
  "文件无法保存，请检查浏览器存储空间":
    "The file could not be saved. Check your browser storage.",
  "对方暂时无法保存附件，请让对方检查浏览器空间":
    "The recipient could not save the attachment. Ask them to check their browser storage.",
  无效的数据块: "Invalid data chunk",
  消息标识发生冲突: "Message ID conflict",
  "消息标识无效，请刷新后重试": "Invalid message ID. Refresh and try again.",
  存储适配器名称不能为空: "The storage adapter name cannot be empty.",
  "未找到存储适配器：{{type}}": "Storage adapter not found: {{type}}",
};
