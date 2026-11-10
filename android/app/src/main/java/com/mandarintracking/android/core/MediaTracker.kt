package com.mandarintracking.android.core

interface Clock {
    fun wallMs(): Long
    fun elapsedMs(): Long
}

/** What a media session says about the item it plays. Mapped from MediaMetadata by the service. */
data class MediaInfo(
    val title: String?,
    val artist: String?,
    val albumArtist: String? = null,
    val album: String? = null,
    val durationMs: Long? = null,
    /** The adapter's judgement that this item is an ad (see MediaListenerService). */
    val isAd: Boolean = false,
) {
    val channel: String? get() = artist?.takeIf { it.isNotBlank() } ?: albumArtist?.takeIf { it.isNotBlank() }
    /** Two infos describe the same video when title and channel match. */
    fun sameItem(o: MediaInfo?) = o != null && o.title == title && o.channel == channel && o.isAd == isAd
}

/** Playback states, mirroring android.media.session.PlaybackState constants. */
object PlayState {
    const val NONE = 0
    const val STOPPED = 1
    const val PAUSED = 2
    const val PLAYING = 3
    const val FAST_FORWARDING = 4
    const val REWINDING = 5
    const val BUFFERING = 6
    const val ERROR = 7
    const val CONNECTING = 8
    const val SKIPPING_TO_PREVIOUS = 9
    const val SKIPPING_TO_NEXT = 10
    const val SKIPPING_TO_QUEUE_ITEM = 11

    fun isPlaying(s: Int) = s == PLAYING || s == FAST_FORWARDING || s == REWINDING
    fun name(s: Int) = when (s) {
        NONE -> "none"; STOPPED -> "stopped"; PAUSED -> "paused"; PLAYING -> "playing"
        BUFFERING -> "buffering"; ERROR -> "error"; CONNECTING -> "connecting"
        SKIPPING_TO_NEXT, SKIPPING_TO_PREVIOUS, SKIPPING_TO_QUEUE_ITEM -> "skipping"
        else -> "state_$s"
    }
}

/** Receives YouTube intervals. [open] is true while the interval is still growing. */
fun interface MediaSink {
    fun upsert(interval: Interval, open: Boolean)
}

/**
 * Turns media session callbacks into `youtube` intervals.
 *
 * An interval runs while the session is playing one item. It closes on pause, stop, buffering,
 * error, a new item, the session going away or the listener disconnecting. Playing again within
 * [bridgeMs] of a close, on the same item, continues the same interval (buffering blips). Ads are
 * not counted. Durations come from the elapsed-time clock, so wall-clock changes during playback
 * don't stretch or shrink an interval. Open intervals are written on every [tick] so that if the
 * process dies, at most one tick of playback is lost.
 */
class MediaTracker(
    private val clock: Clock,
    private val sink: MediaSink,
    private val extraMeta: () -> Map<String, Any?> = { emptyMap() },
    private val bridgeMs: Long = 10_000L,
) {
    private class Run(val pkg: String, val kind: String, val info: MediaInfo, val startWall: Long, val startElapsed: Long) {
        val id = "m:$pkg:$startWall"
    }

    private class State(val pkg: String, val kind: String) {
        var info: MediaInfo? = null
        var playState: Int = PlayState.NONE
        var run: Run? = null
        var lastClosed: Run? = null
        var lastClosedAt: Long = 0
    }

    private val states = LinkedHashMap<String, State>()

    /** Number of intervals currently running. */
    val openCount: Int get() = states.values.count { it.run != null }

    /**
     * [kind] is "app" for the YouTube app or "browser" for a browser tab already known to be YouTube.
     * Sessions of other apps must not be passed in.
     */
    fun onMetadata(key: String, pkg: String, kind: String, info: MediaInfo?) {
        val st = states.getOrPut(key) { State(pkg, kind) }
        val old = st.info
        st.info = info
        if (info != null && info.sameItem(old)) {
            // Same item; metadata often arrives in several steps (e.g. duration later).
            return
        }
        st.run?.let { close(st, "item_changed") }
        st.lastClosed = null
        maybeStart(st)
    }

    fun onPlaybackState(key: String, pkg: String, kind: String, state: Int) {
        val st = states.getOrPut(key) { State(pkg, kind) }
        st.playState = state
        if (PlayState.isPlaying(state)) {
            maybeStart(st)
        } else if (st.run != null) {
            close(st, PlayState.name(state))
        }
    }

    fun onSessionGone(key: String) {
        val st = states.remove(key) ?: return
        if (st.run != null) close(st, "session_destroyed")
    }

    /** Called with the keys of all current sessions; ones missing are treated as gone. */
    fun retainOnly(keys: Set<String>) {
        states.keys.filter { it !in keys }.forEach { onSessionGone(it) }
    }

    fun onDisconnected() {
        states.keys.toList().forEach { k ->
            val st = states.getValue(k)
            if (st.run != null) close(st, "listener_disconnected")
        }
        states.clear()
    }

    /** Writes open intervals with their current end and splits them at 30 minutes. */
    fun tick() {
        for (st in states.values) {
            st.run ?: continue
            split(st)
            emit(st.run!!, clock.elapsedMs(), open = true, reason = "playing")
        }
    }

    private fun maybeStart(st: State) {
        val info = st.info
        if (st.run != null || !PlayState.isPlaying(st.playState) || info == null || info.isAd) return
        if (info.title.isNullOrBlank()) return
        val now = clock.elapsedMs()
        val prev = st.lastClosed
        st.run = if (prev != null && prev.info.sameItem(info) && now - st.lastClosedAt <= bridgeMs) {
            prev
        } else {
            Run(st.pkg, st.kind, info, clock.wallMs(), now)
        }
        st.lastClosed = null
        emit(st.run!!, now, open = true, reason = "playing")
    }

    private fun close(st: State, reason: String) {
        split(st)
        val run = st.run ?: return
        val now = clock.elapsedMs()
        emit(run, now, open = false, reason = reason)
        st.run = null
        st.lastClosed = run
        st.lastClosedAt = now
    }

    private fun split(st: State) {
        var run = st.run ?: return
        val now = clock.elapsedMs()
        while (now - run.startElapsed >= Interval.MAX_LENGTH_MS) {
            emit(run, run.startElapsed + Interval.MAX_LENGTH_MS, open = false, reason = "split_30min")
            run = Run(run.pkg, run.kind, run.info, run.startWall + Interval.MAX_LENGTH_MS, run.startElapsed + Interval.MAX_LENGTH_MS)
        }
        st.run = run
    }

    private fun emit(run: Run, endElapsed: Long, open: Boolean, reason: String) {
        val end = run.startWall + (endElapsed - run.startElapsed)
        if (end <= run.startWall) return
        val share = ChineseShare.of(run.info.title)
        sink.upsert(
            Interval(
                id = run.id,
                source = Source.YOUTUBE,
                startMs = run.startWall,
                endMs = end,
                language = "unknown",
                zhShare = if (share.units > 0) share.share else null,
                units = share.units,
                app = run.pkg,
                title = run.info.title,
                channelName = run.info.channel,
                meta = extraMeta() + mapOf(
                    "end" to reason,
                    "kind" to run.kind,
                    "artist" to run.info.artist,
                    "album_artist" to run.info.albumArtist,
                    "album" to run.info.album,
                    "duration_ms" to run.info.durationMs,
                ),
            ),
            open,
        )
    }
}
