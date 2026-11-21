package team.kuangye.im

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

internal const val BACKGROUND = "keepPeerSession"
internal const val PREFERENCES = "connections"

class PeerService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "stop") {
            getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit().putBoolean(BACKGROUND, false).apply()
            stopSelf()
            return START_NOT_STICKY
        }
        val channel = "active-peers"
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(channel, getString(R.string.peer_session), NotificationManager.IMPORTANCE_LOW)
            )
        }
        val immutable = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), immutable)
        val stop = PendingIntent.getService(this, 1, Intent(this, PeerService::class.java).setAction("stop"), immutable)
        val notification = NotificationCompat.Builder(this, channel)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(getString(R.string.peer_session))
            .setContentText(getString(R.string.peer_session_detail))
            .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .addAction(0, getString(R.string.peer_session_stop), stop).build()
        startForeground(1, notification)
        return START_NOT_STICKY
    }
}
