package team.kuangye.im

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.FileProvider
import androidx.core.content.pm.PackageInfoCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.net.URL
import javax.net.ssl.HttpsURLConnection
import kotlin.concurrent.thread

@TauriPlugin
class ApkUpdatePlugin(private val host: Activity) : Plugin(host) {
    private companion object { val cacheLock = Any() }
    private class InvalidUpdate : Exception()
    private val directory = File(host.cacheDir, "updates")

    private fun apk(version: String): File {
        require(version.matches(Regex("""[0-9]{1,4}\.[0-9]{1,3}\.[0-9]{1,3}""")))
        return File(directory, "ky-im-$version-android-universal.apk")
    }

    @Suppress("DEPRECATION")
    private fun isUpdate(file: File, version: String): Boolean {
        if (!file.isFile) return false
        val pm = host.packageManager
        // GET_SIGNATURES also works on API 24 and returns the original signer after key rotation.
        val candidate = pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNATURES) ?: return false
        val installed = pm.getPackageInfo(host.packageName, PackageManager.GET_SIGNATURES)
        val signers = installed.signatures?.toSet().orEmpty()
        return candidate.packageName == installed.packageName && candidate.versionName == version &&
            PackageInfoCompat.getLongVersionCode(candidate) > PackageInfoCompat.getLongVersionCode(installed) &&
            signers.isNotEmpty() && signers == candidate.signatures?.toSet()
    }

    private fun fetch(address: String, file: File) {
        var url = URL(address)
        repeat(6) {
            require(url.protocol == "https" && url.userInfo == null)
            val connection = url.openConnection() as HttpsURLConnection
            try {
                connection.connectTimeout = 15_000
                connection.readTimeout = 30_000
                connection.instanceFollowRedirects = false
                when (connection.responseCode) {
                    301, 302, 303, 307, 308 -> {
                        url = URL(url, requireNotNull(connection.getHeaderField("Location")))
                    }
                    200 -> {
                        val bytes = connection.inputStream.use { input ->
                            file.outputStream().use { output -> input.copyTo(output) }
                        }
                        val length = connection.contentLengthLong
                        require(bytes > 0 && (length < 0 || bytes == length))
                        return
                    }
                    else -> error("APK download failed")
                }
            } finally {
                connection.disconnect()
            }
        }
        error("Too many redirects")
    }

    private fun download(version: String, url: String): Unit = synchronized(cacheLock) {
        val target = apk(version)
        if (isUpdate(target, version)) return@synchronized
        directory.mkdirs()
        val partial = File(directory, "download.part.apk")
        try {
            fetch(url, partial)
            if (!isUpdate(partial, version)) throw InvalidUpdate()
            check(partial.renameTo(target))
            directory.listFiles()?.filter { it != target && it.extension == "apk" }?.forEach { it.delete() }
        } finally {
            partial.delete()
        }
    }

    @Command
    fun download(invoke: Invoke) {
        thread(name = "apk-download") {
            try {
                val args = invoke.getArgs()
                download(args.getString("version"), args.getString("url"))
                invoke.resolve()
            } catch (_: InvalidUpdate) {
                invoke.reject("APK does not match the requested update", "INVALID_APK")
            } catch (e: Exception) {
                invoke.reject("APK download failed", e)
            }
        }
    }

    @Command
    fun chooseInstaller(invoke: Invoke) {
        try {
            val file = apk(invoke.getArgs().getString("version"))
            if (!file.isFile) {
                invoke.reject("APK no longer cached", "CACHE_MISS")
                return
            }
            val uri = FileProvider.getUriForFile(host, "${host.packageName}.fileprovider", file)
            val viewApk = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                clipData = ClipData.newRawUri("APK", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            host.startActivity(Intent.createChooser(viewApk, host.getString(R.string.choose_installer)))
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("Could not open installer chooser", e)
        }
    }
}
