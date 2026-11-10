package com.mandarintracking.android.core

/** The usage events the session builder understands, mapped from UsageEvents.Event types. */
enum class EventKind { RESUMED, PAUSED, STOPPED, SCREEN_OFF, KEYGUARD_SHOWN, SHUTDOWN, STARTUP, OTHER }

data class UsageEvent(val timeMs: Long, val pkg: String, val cls: String?, val kind: EventKind)

/** Why a session ended. Sent in `meta.end` so odd endings are visible on the hub. */
object EndReason {
    const val PAUSED = "paused"
    const val OTHER_APP = "other_app"
    const val SCREEN_OFF = "screen_off"
    const val KEYGUARD = "keyguard"
    const val SHUTDOWN = "shutdown"
    /** The phone restarted without a shutdown event; the end is the last event seen before it. */
    const val REBOOT = "reboot_without_shutdown"
    /** Still in the foreground when the events were read; the end is the read time. */
    const val RUNNING = "running"
}

data class Session(val pkg: String, val startMs: Long, val endMs: Long, val endReason: String) {
    val running: Boolean get() = endReason == EndReason.RUNNING
}

/**
 * Rebuilds foreground sessions of tracked apps from usage events.
 *
 * Rules:
 * - A session of a package is open while at least one of its activities is resumed.
 * - A RESUMED of any other package closes it (covers a missing PAUSED, e.g. after a crash).
 *   In split screen this undercounts rather than double counts.
 * - Screen off, keyguard shown and shutdown close every session.
 * - Startup without a preceding shutdown closes open sessions at the last event before it.
 * - Sessions of the same app separated by at most [bridgeMs] with nothing in between are joined
 *   (activity switches inside an app).
 * - Sessions shorter than [minMs] are dropped.
 * - PAUSED/STOPPED without a matching RESUMED (e.g. the read window starts mid-session) is ignored.
 */
class SessionBuilder(
    private val isTracked: (String) -> Boolean,
    private val bridgeMs: Long = BRIDGE_MS,
    private val minMs: Long = MIN_MS,
) {
    private class Open(val start: Long, val activities: MutableSet<String>)

    fun build(events: List<UsageEvent>, nowMs: Long): List<Session> {
        val sorted = events.sortedBy { it.timeMs } // stable: keeps OS order for equal times
        val open = LinkedHashMap<String, Open>()
        val out = ArrayList<Session>()
        var lastTime: Long? = null

        fun close(pkg: String, at: Long, reason: String) {
            val o = open.remove(pkg) ?: return
            if (at > o.start) out += Session(pkg, o.start, at, reason)
        }
        fun closeAll(at: Long, reason: String) {
            open.keys.toList().forEach { close(it, at, reason) }
        }

        for (e in sorted) {
            when (e.kind) {
                EventKind.RESUMED -> {
                    open.keys.filter { it != e.pkg }.forEach { close(it, e.timeMs, EndReason.OTHER_APP) }
                    if (isTracked(e.pkg)) {
                        open.getOrPut(e.pkg) { Open(e.timeMs, mutableSetOf()) }.activities += e.cls.orEmpty()
                    }
                }
                EventKind.PAUSED, EventKind.STOPPED -> {
                    val o = open[e.pkg]
                    if (o != null && o.activities.remove(e.cls.orEmpty()) && o.activities.isEmpty()) {
                        close(e.pkg, e.timeMs, EndReason.PAUSED)
                    }
                }
                EventKind.SCREEN_OFF -> closeAll(e.timeMs, EndReason.SCREEN_OFF)
                EventKind.KEYGUARD_SHOWN -> closeAll(e.timeMs, EndReason.KEYGUARD)
                EventKind.SHUTDOWN -> closeAll(e.timeMs, EndReason.SHUTDOWN)
                EventKind.STARTUP -> closeAll(lastTime ?: e.timeMs, EndReason.REBOOT)
                EventKind.OTHER -> {}
            }
            lastTime = e.timeMs
        }
        open.forEach { (pkg, o) -> if (nowMs > o.start) out += Session(pkg, o.start, nowMs, EndReason.RUNNING) }
        // A session only grows as later events arrive, so dropping short ones never retracts a sent id.
        return bridge(out.sortedBy { it.startMs }).filter { it.endMs - it.startMs >= minMs }
    }

    private fun bridge(sessions: List<Session>): List<Session> {
        val out = ArrayList<Session>()
        for (s in sessions) {
            val prev = out.lastOrNull()
            // Only switches inside the app are joined; the screen going off always ends a session.
            val joinable = prev != null && prev.endReason in JOINABLE
            if (prev != null && joinable && prev.pkg == s.pkg && s.startMs - prev.endMs <= bridgeMs) {
                out[out.size - 1] = prev.copy(endMs = maxOf(prev.endMs, s.endMs), endReason = s.endReason)
            } else {
                out += s
            }
        }
        return out
    }

    companion object {
        const val BRIDGE_MS = 10_000L
        const val MIN_MS = 1_000L
        private val JOINABLE = setOf(EndReason.PAUSED, EndReason.OTHER_APP)
        /** How far back each read reaches before the cursor-defining "now", for late events. */
        const val MARGIN_MS = 10 * 60_000L

        /**
         * Where the next read must start so that it sees every session it may still change:
         * no session spans this point and no joinable gap spans it. Reading from here again is
         * idempotent because interval ids depend only on session and segment start times.
         * It never moves before [readStartMs], which already had that property.
         */
        fun nextCursor(sessions: List<Session>, readStartMs: Long, readEndMs: Long, bridgeMs: Long = BRIDGE_MS): Long {
            val floor = readEndMs - MARGIN_MS
            val pending = sessions.filter { it.running || it.endMs >= floor - bridgeMs }
            return maxOf(readStartMs, (pending.map { it.startMs } + floor).min())
        }
    }
}
