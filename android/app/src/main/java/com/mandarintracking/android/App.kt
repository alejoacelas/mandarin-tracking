package com.mandarintracking.android

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.SystemClock

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        startElapsed = SystemClock.elapsedRealtime()
        Notifier.createChannel(this)
        Work.schedule(this)
    }

    companion object {
        @Volatile var startElapsed = 0L
    }
}

/** The single notification the app ever shows: something needs the user's attention. */
object Notifier {
    private const val CHANNEL = "attention"
    private const val ID = 1

    fun createChannel(c: Context) {
        val ch = NotificationChannel(CHANNEL, "Needs attention", NotificationManager.IMPORTANCE_DEFAULT)
        ch.description = "Shown when tracking stopped working and needs a tap to fix."
        c.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    /** What the user must fix, in plain words. Empty when all is well. */
    fun attentionItems(c: Context): List<String> {
        val prefs = Prefs(c)
        val items = ArrayList<String>()
        if (prefs.pairingLost) items += "Connect to the Mac again: enter the new code from the dashboard."
        if (prefs.setupDone) {
            if (!Permissions.usageAccess(c)) items += "Usage access was turned off."
            if (!Permissions.notificationAccess(c)) items += "Notification access was turned off (YouTube isn't counted)."
            if (!Permissions.accessibility(c)) items += "The accessibility service was turned off (chat and reading languages aren't measured)."
            if (Permissions.backgroundRestricted(c)) items += "Battery use is set to Restricted, so the app can't run in the background."
        }
        return items
    }

    fun updateAttention(c: Context) {
        val prefs = Prefs(c)
        val items = attentionItems(c)
        val nm = c.getSystemService(NotificationManager::class.java)
        if (items.isEmpty()) {
            nm.cancel(ID)
            prefs.notifiedAttention = null
            return
        }
        val text = items.joinToString("\n")
        if (text == prefs.notifiedAttention) return
        val open = PendingIntent.getActivity(
            c, 0, Intent(c, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Mandarin tracker needs attention")
            .setContentText(items.first())
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        try {
            nm.notify(ID, n)
            prefs.notifiedAttention = text
        } catch (e: SecurityException) {
            // Notifications not allowed (Android 13+ permission). The setup screen shows this.
        }
    }
}
