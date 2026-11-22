# Android client

English | [简体中文](android.zh.md) · [Project overview](../README.md)

Hummingbird ships one APK for 32-bit and 64-bit ARM phones. Android uses the same messaging and file-transfer protocols as the desktop and web apps. Installation requires Android 7.0 (API 24) or later and a system WebView that supports modern JavaScript. Local launch checks cover Android 7.0 on ARMv7 (WebView 116), Android 15 on ARM64 (WebView 124, 16 KB pages), and Android 17 on ARM64 (WebView 145).

| On the phone | What happens |
| --- | --- |
| Start a chat or invite a friend | Messages shows each contact’s online status. Tap a contact to chat, or tap **+** in Messages or Devices to invite a friend. Use the copy button beside your number in the invitation. Devices also lets you look someone up by number. |
| Update the app | In Me → About Hummingbird, check for updates. Download in app saves the APK in the app cache and verifies its version, package name and signer. Tap Choose an installer, then confirm or cancel installation. You can also download in your browser. |
| Send a folder | The system picker grants access. The app reads entries in batches and preserves relative paths and empty folders. Native transfers read seekable files directly and can cache files supplied through pipes so they can resume reading. |
| Choose where to save attachments | Select a folder in Me → Storage space. The app retains the permission and uses the folder for new incoming transfers. Existing attachments still point to their original documents. By default, attachments go into private app storage. |
| Reset app data | Tap Me → Reset data and confirm. Hummingbird clears local chat history and settings and generates a new number. Attachments saved to a folder you chose are kept. |
| Save or clean up files | The phone stages incoming data locally, checks its length and writes it to the destination before acknowledging completion. The document provider may add a suffix to a top-level file or folder when names collide. Chat history, identity and indexes live in private SQLite storage. Files in a folder you chose remain yours after you clear history or uninstall the app. |
| Find nearby devices | Nearby discovery is on by default. On Android 17 and later, opening Devices for the first time (Online devices on wide screens) requests local network access. Discovery starts once permission is granted. If you decline, online discovery still works. You can grant permission later in Me → Connection settings. The app remembers if you switch nearby discovery off. |
| Chat in the background | In Me → Connection settings → Background chat, enable the option to stay connected and allow notifications. An active peer connection starts a foreground service. Rust sends heartbeats on registered, idle signaling connections. The service stops when the last peer disconnects, or you can stop it from the notification. Communication requires a working network and a running process. |
| Adjust connections | Me → Connection settings shows connection servers, direct connection helpers, relay servers and the activity log button as soon as you open it. |

## Build

Install Node.js 24, JDK 21, Rust and the Android SDK. Export `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` in the build shell. The repository includes the Android Studio project and Gradle Wrapper. The project uses Jackson 2.13.5 for API 24 compatibility. [Jackson Android compatibility](https://github.com/FasterXML/jackson-databind#android)

```sh
npm ci --ignore-scripts
npm --prefix ssg ci
rustup target add aarch64-linux-android armv7-linux-androideabi
sdkmanager 'platforms;android-36' 'platforms;android-37.0' 'build-tools;36.0.0' 'ndk;30.0.16248370'
export NDK_HOME="$ANDROID_HOME/ndk/30.0.16248370"
npm run android:build -- --debug
```

The debug APK is written to `app/android-dist/ky-im-<version>-android-universal-debug.apk`. Use `npm run android:dev` to connect to the development server. For USB debugging, use `adb reverse tcp:1420 tcp:1420` for the frontend and `adb reverse tcp:8080 tcp:8080` for local signaling. Set `VITE_SIGNAL_URL` to `ws://127.0.0.1:8080/api/ws`.

## Signing and release

For a local release, fill in the Base64 keystore, alias and password under `android.app` in the root `.env.json`, then run `npm run android:build`. The build reads the file directly, so you can skip `npm run init`. Nonempty environment variables override the corresponding fields.

| Setting | Purpose |
| --- | --- |
| `VITE_SIGNAL_URL` | Release builds use WSS. The build reads the environment variable first, then falls back to `production.ssg` in the local `.env.json`. |
| `RELEASE_VERSION` | Set the version under `android.app`, for example `v1.2.3`. An empty value uses the root `package.json` version. The version code is `major × 1000000 + minor × 1000 + patch`. Minor and patch each allow up to three digits. Increase the code for upgrades. |
| `ANDROID_KEY_BASE64` | Base64 encoding of the entire signing keystore. Use the private `.env.json` locally and a Secret of the same name in GitHub Actions. The build restores the keystore temporarily and deletes it afterward. |
| `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Alias and password of the existing signing key.  |
| `ANDROID_KEY_SHA256` | GitHub Actions Variable containing the certificate fingerprint recorded when the keystore was created. A mismatch blocks the release. |

Reuse the original signing key if you have already released an APK. For a first release, create a key with the JDK’s `keytool`. The example uses the alias `ky-im` and prompts for the password. Keep an encrypted backup of the keystore and passwords, and verify the certificate fingerprint after restoring it.

```sh
mkdir -p "$HOME/.android"
keytool -genkeypair -keystore "$HOME/.android/ky-im-release.p12" -storetype PKCS12 \
  -alias ky-im -keyalg RSA -keysize 3072 -validity 10000
```

On macOS, copy the Base64-encoded keystore to the clipboard with this command, then paste it into `ANDROID_KEY_BASE64`.

```sh
openssl base64 -A -in "$HOME/.android/ky-im-release.p12" | pbcopy
```

The signed APK is written to `app/android-dist/ky-im-<version>-android-universal.apk`. The release workflow checks the package name, SDK, version, signature, both native library sets and 16 KB alignment. It attaches the APK and its `.sha256` file to the matching GitHub Release. [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/)

## Device verification

| Check | Procedure |
| --- | --- |
| Install and upgrade | Install the same APK on a 32-bit API 24 device and a modern ARM64 phone. Record the Android and WebView versions, actual ABI and page size. Install a build with a higher version code over it and verify the number, history and folder permission. |
| Text, images, attachments and folders | Send and receive between the phone and each of the desktop and web apps. Include nested and empty folders, duplicate names and large files. Restart, open an old attachment and resume receiving. Revoke folder access, remove the storage card or exhaust storage and verify that the sender receives no completion receipt. |
| Background and screen off | On the same Wi-Fi network, establish WSS and a peer session. Press Home and send uniquely marked messages after 5 and 30 minutes. Record the peer’s underlying connection ID, the sender’s receipts and the receiver’s SQLite writes. With the screen off, check byte progress, hashes and final receipts for native and WebRTC transfers that were already running. Record network switches, Doze and process exit separately. |
| APK | Verify the final APK and generate a SHA-256 file alongside it with the script below. Launch the app and exchange messages on a device with 16 KB pages. |

```sh
python3 scripts/verify-android.py "$APK" "$RELEASE_VERSION" --certificate "$ANDROID_KEY_SHA256"
adb shell getprop ro.product.cpu.abilist
adb shell dumpsys package team.kuangye.im | rg primaryCpuAbi
adb shell dumpsys webviewupdate
adb shell getconf PAGE_SIZE
```

Android documents how folder access, local network access and foreground services work. [System document picker](https://developer.android.com/training/data-storage/shared/documents-files) · [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission) · [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
