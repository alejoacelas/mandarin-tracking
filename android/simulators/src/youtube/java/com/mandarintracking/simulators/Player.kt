package com.mandarintracking.simulators

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import android.widget.TextView

/**
 * Forwards commands to [PlayerService] and closes.
 * am start -n com.google.android.youtube/com.mandarintracking.simulators.PlayerActivity \
 *   --es cmd play --es title "..." --es artist "..."
 * Commands: play, pause, buffer, stop, error, release (session destroyed), kill (process dies).
 */
class PlayerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = "YouTube (sim)" })
        val i = Intent(this, PlayerService::class.java).putExtras(intent.extras ?: Bundle())
        startForegroundService(i)
        finish()
    }
}

/** Publishes a media session the way the YouTube app does, with a media notification. */
class PlayerService : Service() {
    private var session: MediaSession? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foreground()
        val cmd = intent?.getStringExtra("cmd") ?: "play"
        if (cmd == "kill") {
            android.os.Process.killProcess(android.os.Process.myPid())
            return START_NOT_STICKY
        }
        if (cmd == "release") {
            session?.release()
            session = null
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        val s = session ?: MediaSession(this, "youtube-sim").also { session = it; it.isActive = true }
        // Tests pass text as URL-safe base64 because shell commands split on spaces.
        fun extra(k: String) = intent?.getStringExtra(k)
            ?: intent?.getStringExtra("${k}_b64")?.let { String(android.util.Base64.decode(it, android.util.Base64.URL_SAFE)) }
        intent?.putExtra("title", extra("title"))?.putExtra("artist", extra("artist"))?.putExtra("album_artist", extra("album_artist"))
        intent?.getStringExtra("title")?.let { title ->
            val md = MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
            intent.getStringExtra("artist")?.let {
                md.putString(MediaMetadata.METADATA_KEY_ARTIST, it)
                md.putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, it)
            }
            intent.getStringExtra("album_artist")?.let { md.putString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST, it) }
            md.putLong(MediaMetadata.METADATA_KEY_DURATION, intent.getLongExtra("duration", 600_000))
            s.setMetadata(md.build())
        }
        val state = when (cmd) {
            "play" -> PlaybackState.STATE_PLAYING
            "pause" -> PlaybackState.STATE_PAUSED
            "buffer" -> PlaybackState.STATE_BUFFERING
            "stop" -> PlaybackState.STATE_STOPPED
            "error" -> PlaybackState.STATE_ERROR
            else -> PlaybackState.STATE_NONE
        }
        s.setPlaybackState(
            PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO)
                .setState(state, 0, if (state == PlaybackState.STATE_PLAYING) 1f else 0f, SystemClock.elapsedRealtime())
                .build()
        )
        return START_NOT_STICKY
    }

    private fun foreground() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("player", "Player", NotificationManager.IMPORTANCE_LOW))
        val n = Notification.Builder(this, "player")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("YouTube (sim)")
            .setStyle(Notification.MediaStyle().also { st -> session?.let { st.setMediaSession(it.sessionToken) } })
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(1, n)
    }

    override fun onDestroy() {
        session?.release()
        super.onDestroy()
    }
}
