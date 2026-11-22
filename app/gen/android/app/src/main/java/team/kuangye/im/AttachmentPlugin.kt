package team.kuangye.im

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@TauriPlugin
class AttachmentPlugin(private val host: Activity) : Plugin(host) {
    @Command
    fun open(invoke: Invoke) {
        val args = invoke.getArgs()
        try {
            val source = Uri.parse(args.getString("uri"))
            val uri = when (source.scheme) {
                "content" -> source
                "file" -> FileProvider.getUriForFile(host, host.packageName + ".fileprovider", File(requireNotNull(source.path)))
                else -> throw IllegalArgumentException()
            }
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, args.getString("mime"))
                clipData = ClipData.newRawUri(null, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            host.startActivity(if (args.getBoolean("choose")) Intent.createChooser(view, null) else view)
            invoke.resolve()
        } catch (error: Exception) {
            invoke.reject("无法打开文件，请检查是否已安装合适的应用")
        }
    }
}
