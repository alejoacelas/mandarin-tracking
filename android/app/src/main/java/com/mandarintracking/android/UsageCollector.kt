package com.mandarintracking.android

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import com.mandarintracking.android.core.EventKind
import com.mandarintracking.android.core.Labeler
import com.mandarintracking.android.core.SessionBuilder
import com.mandarintracking.android.core.TrackedApps
import com.mandarintracking.android.core.UsageEvent
import com.mandarintracking.android.core.UsageIntervals

/**
 * Reads the OS usage history from the stored cursor, rebuilds sessions of tracked apps and
 * writes their intervals to the outbox. Safe to run any number of times: ids are deterministic.
 */
class UsageCollector(private val context: Context) {
    private val store = Store.get(context)
    private val prefs = Prefs(context)

    data class Result(val events: Int, val intervals: Int, val readFrom: Long, val readTo: Long)

    fun run(now: Long = System.currentTimeMillis()): Result {
        var cursor = prefs.usageCursor ?: (now - FIRST_READ_MS)
        if (cursor > now) {
            // The clock moved back past the cursor. Re-read the recent past rather than waiting for the clock.
            Problems.report(context, Problems.CLOCK, "The phone clock went back in time; usage was re-read from ${Problems.fmt(now - SessionBuilder.MARGIN_MS)}.")
            cursor = now - SessionBuilder.MARGIN_MS
        }
        if (now - cursor > MAX_LOOKBACK_MS) {
            Problems.report(
                context, Problems.USAGE_GAP,
                "App usage from ${Problems.fmt(cursor)} to ${Problems.fmt(now - MAX_LOOKBACK_MS)} could not be read: " +
                    "the app did not run for over ${MAX_LOOKBACK_MS / 86_400_000} days and Android keeps only a few days of history.",
            )
            cursor = now - MAX_LOOKBACK_MS
        }

        val usm = context.getSystemService(UsageStatsManager::class.java)
        val events = ArrayList<UsageEvent>()
        val iter = usm.queryEvents(cursor, now)
        val e = UsageEvents.Event()
        var lastAny: Long? = null
        while (iter.hasNextEvent()) {
            iter.getNextEvent(e)
            lastAny = e.timeStamp
            val kind = kindOf(e.eventType)
            if (kind == EventKind.OTHER && TrackedApps.get(e.packageName) == null) {
                // Other events of untracked apps only matter as signs of life before a reboot.
                events += UsageEvent(e.timeStamp, e.packageName, null, EventKind.OTHER)
                continue
            }
            events += UsageEvent(e.timeStamp, e.packageName, e.className, kind)
        }
        lastAny?.let { prefs.lastAnyUsageEvent = it }

        val sessions = SessionBuilder({ TrackedApps.get(it) != null }).build(events, now)
        // Samples newer than this are ignored this time, so a sample still being written can't
        // later move a language boundary that was already sent.
        val sampleCutoff = now - SAMPLE_SETTLE_MS
        val samples = store.samples(cursor, sampleCutoff + Labeler.END_SLACK_MS).filter { it.timeMs <= sampleCutoff }
        val intervals = UsageIntervals.build(sessions, samples, Meta.common(context))

        val before = store.idsSince(UsageIntervals.ID_PREFIX, cursor)
        for (iv in intervals) store.upsert(iv, open = iv.meta["end"] == "running", now = now)
        val orphans = before - intervals.map { it.id }.toSet()
        if (orphans.isNotEmpty()) {
            // An interval sent earlier no longer exists after re-reading. The hub keeps the old copy,
            // so the time may be counted twice. This should not happen; make it visible if it does.
            Problems.report(context, Problems.INTERVALS, "${orphans.size} app intervals changed after they were sent (e.g. ${orphans.first()}); some phone time may be counted twice.")
        }

        prefs.usageCursor = SessionBuilder.nextCursor(sessions, cursor, now)
        prefs.lastUsageRead = now
        return Result(events.size, intervals.size, cursor, now)
    }

    companion object {
        /** On first run, read the last day so a fresh install shows something. */
        const val FIRST_READ_MS = 24 * 3600_000L
        /** Android keeps detailed events for about a week; don't ask for more. */
        const val MAX_LOOKBACK_MS = 6 * 86_400_000L
        const val SAMPLE_SETTLE_MS = 30_000L

        fun kindOf(type: Int): EventKind = when (type) {
            UsageEvents.Event.ACTIVITY_RESUMED -> EventKind.RESUMED // same value as MOVE_TO_FOREGROUND (API 26-28)
            UsageEvents.Event.ACTIVITY_PAUSED -> EventKind.PAUSED // same value as MOVE_TO_BACKGROUND
            23 /* ACTIVITY_STOPPED, API 29 */ -> EventKind.STOPPED
            16 /* SCREEN_NON_INTERACTIVE, API 28 */ -> EventKind.SCREEN_OFF
            17 /* KEYGUARD_SHOWN, API 28 */ -> EventKind.KEYGUARD_SHOWN
            26 /* DEVICE_SHUTDOWN, API 29 */ -> EventKind.SHUTDOWN
            27 /* DEVICE_STARTUP, API 29 */ -> EventKind.STARTUP
            else -> EventKind.OTHER
        }

        val hasScreenEvents: Boolean get() = Build.VERSION.SDK_INT >= 28
    }
}
