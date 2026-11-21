package team.kuangye.im

import android.app.Activity
import android.content.SharedPreferences
import android.content.Intent
import android.content.Context
import androidx.core.content.ContextCompat
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val LAN = "android.permission.ACCESS_LOCAL_NETWORK"

@TauriPlugin(permissions = [Permission(strings = [LAN], alias = "lan"),
    Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications")])
class NearbyPlugin(private val host: Activity) : Plugin(host) {
    private val prefs = host.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val connections = mutableSetOf<String>()
    private var session = ""
    private var visible = true
    private var requested = false
    private val preferenceListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == BACKGROUND) synchronized(this) { updateService() }
    }
    init { prefs.registerOnSharedPreferenceChangeListener(preferenceListener) }
    private fun notificationsAllowed() = androidx.core.app.NotificationManagerCompat.from(host).areNotificationsEnabled()

    // The preference is an explicit opt-in, and an authenticated peer is required.
    private fun updateService() {
        val wanted = prefs.getBoolean(BACKGROUND, false) && notificationsAllowed() && connections.isNotEmpty()
        val intent = Intent(host, PeerService::class.java)
        if (wanted && visible && !requested) {
            try {
                ContextCompat.startForegroundService(host, intent)
                requested = true
            } catch (_: IllegalStateException) {
                // The activity can leave the foreground while the command is in flight.
            }
        } else if (!wanted && requested) {
            host.stopService(intent)
            requested = false
        }
    }

    @Command
    @Synchronized
    fun peer(invoke: Invoke) {
        val args = invoke.getArgs()
        if (args.getString("session") == session) {
            val id = args.getString("connection")
            if (args.getBoolean("connected")) connections.add(id) else connections.remove(id)
            updateService()
        }
        invoke.resolve()
    }

    @Command
    @Synchronized
    fun background(invoke: Invoke) {
        val args = invoke.getArgs()
        if (!args.isNull("enabled")) {
            if (args.getBoolean("enabled") && Build.VERSION.SDK_INT >= 33 && !notificationsAllowed()) {
                requestPermissionForAlias("notifications", invoke, "notificationResult")
                return
            }
            prefs.edit().putBoolean(BACKGROUND, args.getBoolean("enabled") && notificationsAllowed()).apply()
        }
        updateService()
        invoke.resolve(JSObject().put("enabled", prefs.getBoolean(BACKGROUND, false) && notificationsAllowed()))
    }

    @PermissionCallback
    @Synchronized
    fun notificationResult(invoke: Invoke) {
        val enabled = notificationsAllowed()
        prefs.edit().putBoolean(BACKGROUND, enabled).apply()
        updateService()
        invoke.resolve(JSObject().put("enabled", enabled))
    }

    @Synchronized
    override fun onResume(activity: AppCompatActivity) { visible = true; updateService() }
    @Synchronized
    override fun onPause(activity: AppCompatActivity) { visible = false }

    private var multicast: WifiManager.MulticastLock? = null
    private fun allowed() = Build.VERSION.SDK_INT < 37 ||
        host.checkSelfPermission(LAN) == PackageManager.PERMISSION_GRANTED

    @Command
    fun requestAccess(invoke: Invoke) {
        val mode = invoke.getArgs().getString("mode")
        if (allowed() || mode == "check" || (mode == "automatic" && prefs.getBoolean("askedForLan", false))) {
            permissionResult(invoke)
            return
        }
        prefs.edit().putBoolean("askedForLan", true).apply()
        requestPermissionForAlias("lan", invoke, "permissionResult")
    }

    @PermissionCallback
    fun permissionResult(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", allowed()))
    }

    @Command
    @Synchronized
    fun network(invoke: Invoke) {
        session = invoke.getArgs().getString("session")
        connections.clear()
        updateService()
        if (invoke.getArgs().getBoolean("enabled") && allowed()) {
            if (multicast == null) {
                val wifi = host.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                multicast = wifi?.createMulticastLock("ky-im:nearby")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            }
        } else release()
        invoke.resolve()
    }

    @Synchronized
    private fun release() {
        multicast?.let { if (it.isHeld) it.release() }
        multicast = null
    }

    @Synchronized
    override fun onDestroy(activity: AppCompatActivity) {
        prefs.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        connections.clear()
        updateService()
        release()
    }
}
