# Android 客户端

[English](android.md) | 简体中文 · [项目概览](../README.zh.md)

蜂鸟使用同一个 APK 向 32 位和 64 位 ARM 手机交付。手机与桌面、网页共用消息及文件协议。安装起点为 Android 7.0（API 24），前端还需要可运行现代 JavaScript 的系统 WebView。本地启动验收覆盖 Android 7.0 / ARMv7（WebView 116）、Android 15 / ARM64（WebView 124、16 KB 页）和 Android 17 / ARM64（WebView 145）。

| 手机上的操作 | 数据与连接 |
| --- | --- |
| 发起聊天或邀请朋友 | 「消息」显示联系人的在线状态。点联系人即可聊天，点「消息」或「设备」右上角的「＋」即可邀请朋友。弹窗里的复制按钮在蜂鸟号旁。「设备」也可以输入蜂鸟号查找朋友。 |
| 发送文件夹 | 通过系统选择器授权，分批枚举子项，保留相对路径和空目录。支持定位的文件直接读取，管道类型的文件可暂存在应用缓存中供原生传输续读。 |
| 设置附件保存位置 | 在手机的「我的 → 存储空间」选择文件夹。应用保留系统授权。新的接收任务使用这个位置，旧附件的记录仍指向原文档。未选择时使用应用私有空间。 |
| 重置应用数据 | 点「我的 → 重置数据」并确认。蜂鸟会清除本机的聊天记录和设置，重新生成蜂鸟号。存到自选文件夹的附件会保留。 |
| 保存及清理 | 接收时在手机内暂存，校验长度并写入所选目录后才确认完成。提供方可为同名顶层文件或文件夹加后缀。聊天记录、身份和索引在应用私有 SQLite 中。清理聊天记录或卸载后，存到自选文件夹的内容仍由用户管理。 |
| 查找附近设备 | 附近查找默认开启。Android 17 起首次进入「设备」（宽屏为「在线设备」）时申请局域网权限，获准后开始查找。拒绝后仍可在线查找，也可在「我的 → 连接设置」手动授权。手动关闭会记住。 |
| 切到后台聊天 | 在「我的 → 连接设置 → 后台聊天」开启保持连接，并允许显示通知。已与好友建立连接时启动前台服务。Rust 在已注册的空闲信令连接上发送心跳。最后一个对端断开后停止服务，通知内也可关闭。通信依赖可用网络和存活的进程。 |
| 调整连接 | 打开「我的 → 连接设置」即可查看连接服务器、直连辅助、中转服务器和运行日志入口。 |

## 构建

准备 Node 24、JDK 21、Rust、Android SDK，并在构建终端中导出 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。仓库已包含 Android Studio 工程和 Gradle Wrapper。Android 工程使用 Jackson 2.13.5 以支持 API 24。[Jackson Android 兼容说明](https://github.com/FasterXML/jackson-databind#android)

```sh
npm ci --ignore-scripts
npm --prefix ssg ci
rustup target add aarch64-linux-android armv7-linux-androideabi
sdkmanager 'platforms;android-36' 'platforms;android-37.0' 'build-tools;36.0.0' 'ndk;30.0.16248370'
export NDK_HOME="$ANDROID_HOME/ndk/30.0.16248370"
npm run android:build -- --debug
```

调试包输出到 `app/android-dist/ky-im-<version>-android-arm-debug.apk`。使用 `npm run android:dev` 可连接开发服务器。USB 调试可用 `adb reverse tcp:1420 tcp:1420` 访问前端，用 `adb reverse tcp:8080 tcp:8080` 访问本地信令，并将 `VITE_SIGNAL_URL` 指向 `ws://127.0.0.1:8080/api/ws`。

## 签名与发布

本地正式打包时，在根目录 `.env.json` 的 `android.app` 填写密钥库的 Base64、别名和密码，再运行 `npm run android:build`。命令直接读取配置，无需先运行 `npm run init`。非空环境变量可覆盖对应字段。

| 配置 | 用途 |
| --- | --- |
| `VITE_SIGNAL_URL` | 正式构建使用 WSS。优先采用非空环境变量，再使用本地 `.env.json` 的 `production.ssg` 配置。 |
| `RELEASE_VERSION` | 在 `android.app` 填写发布版本，如 `v1.2.3`，留空使用根目录 `package.json` 的版本。版本码为 `major × 1000000 + minor × 1000 + patch`，次版本和补丁各最多三位。覆盖安装须递增。 |
| `ANDROID_KEY_BASE64` | 完整签名密钥库的 Base64。在本机填入私有的 `.env.json`，在 GitHub Actions 填入同名 Secret。构建命令临时还原密钥库，结束后删除。 |
| `ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` | 分别填写现有签名私钥的别名和密码。 |
| `ANDROID_KEY_SHA256` | GitHub Actions Variable，保存首次建库时记录的证书 SHA-256 指纹。验签不匹配会阻止发布。 |

已有正式发布包时，请沿用原签名密钥。首次发布且尚无密钥时，可用 JDK 的 `keytool` 创建。以下示例的别名为 `ky-im`，密码在终端提示时输入。请加密备份密钥库和密码，并核对恢复后的证书指纹。

```sh
mkdir -p "$HOME/.android"
keytool -genkeypair -keystore "$HOME/.android/ky-im-release.p12" -storetype PKCS12 \
  -alias ky-im -keyalg RSA -keysize 3072 -validity 10000
```

在 macOS 上，可运行以下命令将现有密钥库编码并复制到剪贴板，再粘贴到 `ANDROID_KEY_BASE64`。

```sh
openssl base64 -A -in "$HOME/.android/ky-im-release.p12" | pbcopy
```

正式包输出到 `app/android-dist/ky-im-<version>-android-arm.apk`。发布工作流校验包名、SDK、版本、签名、两套原生库以及 16 KB 对齐后，将 `ky-im-<version>-android-arm.apk` 和 `.sha256` 附到同版本 GitHub Release。[Tauri Android 签名](https://v2.tauri.app/distribute/sign/android/)

## 设备验收

| 项目 | 检查方式 |
| --- | --- |
| 安装与升级 | 使用同一 APK 在 API 24 的 32 位设备和现代 arm64 手机上安装，记录 Android、WebView、实际 ABI 和页大小。用递增版本覆盖安装，确认蜂鸟号、历史和目录授权。 |
| 文字、图片、附件与整夹 | 手机分别与桌面和网页双向收发。样本含嵌套、空目录、重名、大文件。重启后打开旧附件并继续接收。撤销目录授权、拔卡或空间不足时，核对发送端未收到完成回执。 |
| 后台与熄屏 | 在同一 Wi-Fi 先建立 WSS 和对端会话。按 Home 后在 5、30 分钟分别发送带唯一标记的消息，记录对端物理连接标识、发送端回执和接收端 SQLite 写入。另测已开始的原生及 WebRTC 文件传输，熄屏时核对字节推进、哈希和最终回执。切网、Doze 和进程退出单独记录。 |
| 包体 | 使用下列脚本校验最终 APK 并生成同目录的 SHA-256 文件。另在 16 KB 页设备上启动并收发消息。 |

```sh
python3 scripts/verify-android.py "$APK" "$RELEASE_VERSION" --certificate "$ANDROID_KEY_SHA256"
adb shell getprop ro.product.cpu.abilist
adb shell dumpsys package team.kuangye.im | rg primaryCpuAbi
adb shell dumpsys webviewupdate
adb shell getconf PAGE_SIZE
```

Android 的目录授权和后台运行规则见[系统文档选择器](https://developer.android.com/training/data-storage/shared/documents-files)、[局域网权限](https://developer.android.com/privacy-and-security/local-network-permission)及[前台服务类型](https://developer.android.com/develop/background-work/services/fgs/service-types)。
