package com.mandarintracking.android

import android.app.Notification
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.service.notification.StatusBarNotification
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.util.Log
import com.mandarintracking.android.core.Clock
import com.mandarintracking.android.core.Interval
import com.mandarintracking.android.core.MediaInfo
import com.mandarintracking.android.core.MediaTracker
import com.mandarintracking.android.core.TrackedApps
import org.json.JSONObject

/**
 * Notification access lets the app see media sessions. This service follows the sessions of the
 * YouTube app (and of browsers playing youtube.com) and records playing time. It ignores the
 * notifications themselves.
 */
class MediaListenerService : NotificationListenerService() {
    private val handler = Handler(Looper.getMainLooper())
    private var manager: MediaSessionManager? = null
    private var tracker: MediaTracker? = null
    private val callbacks = HashMap<String, Pair<MediaController, MediaController.Callback>>()

    private val clock = object : Clock {
        override fun wallMs() = System.currentTimeMillis()
        override fun elapsedMs() = SystemClock.elapsedRealtime()
    }

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list -> refresh(list) }

    private val ticker = object : Runnable {
        override fun run() {
            tracker?.tick()
            if ((tracker?.openCount ?: 0) > 0) handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        connected = true
        connectedAt = System.currentTimeMillis()
        val store = Store.get(this)
        closeLeftovers(store)
        tracker = MediaTracker(clock, { iv, open -> onInterval(store, iv, open) }, { Meta.common(this) })
        try {
            val m = getSystemService(MediaSessionManager::class.java)
            manager = m
            val comp = Permissions.listenerComponent(this)
            m.addOnActiveSessionsChangedListener(sessionsListener, comp, handler)
            refresh(m.getActiveSessions(comp))
            lastError = null
        } catch (e: SecurityException) {
            lastError = "Media sessions not readable: ${e.message}"
        }
    }

    override fun onListenerDisconnected() {
        connected = false
        tracker?.onDisconnected()
        teardown()
        // Ask the system to bind us again (e.g. after the process was killed and restarted).
        try { requestRebind(Permissions.listenerComponent(this)) } catch (e: Exception) { lastError = e.toString() }
        super.onListenerDisconnected()
    }

    override fun onDestroy() {
        connected = false
        tracker?.onDisconnected()
        teardown()
        super.onDestroy()
    }

    private fun teardown() {
        try { manager?.removeOnActiveSessionsChangedListener(sessionsListener) } catch (e: Exception) {}
        callbacks.values.forEach { (c, cb) -> c.unregisterCallback(cb) }
        callbacks.clear()
        handler.removeCallbacks(ticker)
        tracker = null
    }

    /** Intervals still marked open were cut short when the process died; close them at their last write. */
    private fun closeLeftovers(store: Store) {
        for (body in store.openIntervals("youtube")) {
            val j = JSONObject(body)
            j.optJSONObject("meta")?.put("end", "process_died")
            store.upsertRaw(j)
        }
    }

    private fun onInterval(store: Store, iv: Interval, open: Boolean) {
        store.upsert(iv, open)
        lastIntervalAt = System.currentTimeMillis()
        if (open) {
            handler.removeCallbacks(ticker)
            handler.postDelayed(ticker, TICK_MS)
        } else {
            Work.syncSoon(this)
        }
    }

    private fun refresh(list: List<MediaController>?) {
        val t = tracker ?: return
        val keep = HashSet<String>()
        for (c in list.orEmpty()) {
            val kind = kindOf(c) ?: continue
            val key = keyOf(c)
            keep += key
            if (key in callbacks) continue
            val cb = object : MediaController.Callback() {
                override fun onMetadataChanged(metadata: MediaMetadata?) = onMeta(c, key, metadata)
                override fun onPlaybackStateChanged(state: PlaybackState?) {
                    tracker?.onPlaybackState(key, c.packageName, currentKind(c, key), state?.state ?: PlaybackState.STATE_NONE)
                }
                override fun onSessionDestroyed() {
                    tracker?.onSessionGone(key)
                    callbacks.remove(key)?.let { (ctl, me) -> ctl.unregisterCallback(me) }
                }
            }
            c.registerCallback(cb, handler)
            callbacks[key] = c to cb
            onMeta(c, key, c.metadata)
            t.onPlaybackState(key, c.packageName, currentKind(c, key), c.playbackState?.state ?: PlaybackState.STATE_NONE)
        }
        for (gone in callbacks.keys - keep) {
            callbacks.remove(gone)?.let { (ctl, cb) -> ctl.unregisterCallback(cb) }
        }
        t.retainOnly(keep)
    }

    private val browserIsYoutube = HashMap<String, Boolean>()

    private fun onMeta(c: MediaController, key: String, md: MediaMetadata?) {
        if (BuildConfig.DEBUG) Log.d(TAG, "metadata ${c.packageName}: ${MediaAdapter.dump(md)}")
        lastMetadataDump = "${c.packageName}: ${MediaAdapter.dump(md)}"
        if (c.packageName in TrackedApps.browsers) browserIsYoutube[key] = AdRules.mentionsYoutube(browserSite(c) ?: "")
        tracker?.onMetadata(key, c.packageName, currentKind(c, key), MediaAdapter.info(c.packageName, md, browserIsYoutube[key] == true))
    }

    /**
     * The site a browser is playing. Browsers' media sessions don't say it, but their media
     * notification does: Chrome puts the host ("m.youtube.com") in the sub-text, and the
     * notification carries the session token, which ties it to this controller.
     */
    private fun browserSite(c: MediaController): String? = try {
        activeNotifications.orEmpty().firstOrNull { sbn ->
            sbn.packageName == c.packageName &&
                sbn.notification.extras.getParcelable<MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION) == c.sessionToken
        }?.notification?.extras?.let { e ->
            listOfNotNull(e.getCharSequence(Notification.EXTRA_SUB_TEXT), e.getCharSequence(Notification.EXTRA_INFO_TEXT)).joinToString(" ")
        }
    } catch (e: Exception) {
        null
    }

    /** A browser's media notification can appear after its metadata; check its session again. */
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null || sbn.packageName !in TrackedApps.browsers) return
        callbacks.values.filter { it.first.packageName == sbn.packageName }.forEach { (c, _) ->
            val key = keyOf(c)
            if (browserIsYoutube[key] != AdRules.mentionsYoutube(browserSite(c) ?: "")) onMeta(c, key, c.metadata)
        }
    }

    private fun currentKind(c: MediaController, key: String) = if (c.packageName == TrackedApps.YOUTUBE) "app" else "browser"

    private fun kindOf(c: MediaController): String? = when (c.packageName) {
        TrackedApps.YOUTUBE -> "app"
        in TrackedApps.browsers -> "browser"
        else -> null
    }

    private fun keyOf(c: MediaController) = "${c.packageName}#${c.sessionToken.hashCode()}"

    companion object {
        const val TAG = "MandarinMedia"
        const val TICK_MS = 60_000L

        @Volatile var connected = false
        @Volatile var connectedAt = 0L
        @Volatile var lastIntervalAt = 0L
        @Volatile var lastError: String? = null
        @Volatile var lastMetadataDump: String? = null
    }
}

/** Maps MediaMetadata to what the tracker needs. */
object MediaAdapter {
    fun info(pkg: String, md: MediaMetadata?, browserIsYoutube: Boolean): MediaInfo? {
        md ?: return null
        val title = md.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
        val info = MediaInfo(
            title = title,
            artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST),
            albumArtist = md.getString(MediaMetadata.METADATA_KEY_ALBUM_ARTIST),
            album = md.getString(MediaMetadata.METADATA_KEY_ALBUM),
            durationMs = md.getLong(MediaMetadata.METADATA_KEY_DURATION).takeIf { it > 0 },
        )
        // A browser session that isn't YouTube is treated like an ad: present but never counted.
        if (pkg in TrackedApps.browsers && !browserIsYoutube) return info.copy(isAd = true)
        return info.copy(isAd = looksLikeAd(info))
    }

    fun looksLikeAd(info: MediaInfo): Boolean = AdRules.isAd(info.title, info.artist, info.durationMs)

    fun dump(md: MediaMetadata?): String {
        md ?: return "null"
        return md.keySet().sorted().joinToString(", ") { k ->
            val v: Any? = try { md.getString(k) ?: md.getLong(k).takeIf { it != 0L } } catch (e: Exception) { "?" }
            "${k.removePrefix("android.media.metadata.")}=$v"
        }
    }
}

/** Ad and site rules, kept pure for unit tests. */
object AdRules {
    fun isAd(title: String?, artist: String?, durationMs: Long?): Boolean = false

    fun mentionsYoutube(s: String): Boolean {
        val l = s.lowercase()
        if ("music.youtube.com" in l) return false // YouTube Music is not counted
        return "youtube.com" in l || "youtu.be" in l
    }
}
