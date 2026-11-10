package com.mandarintracking.android

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Problem components sent to the hub's problems endpoint. */
object Problems {
    // Conditions: set while true, resolved as soon as they are false.
    const val MEDIA = "android.mediasession"
    const val ACCESSIBILITY = "android.accessibility"
    const val USAGE = "android.usage"
    const val SYNC = "android.sync"
    const val BACKGROUND = "android.background"

    // Events: something happened once. Shown for a day, then resolved.
    const val CLOCK = "android.clock"
    const val USAGE_GAP = "android.usage_gap"
    const val INTERVALS = "android.intervals"
    const val WORKER_GAP = "android.worker_gap"

    val EVENTS = listOf(CLOCK, USAGE_GAP, INTERVALS, WORKER_GAP)
    const val EVENT_SHOWN_MS = 24 * 3600_000L

    fun report(c: Context, component: String, message: String) = Store.get(c).setProblem(component, message)
    fun clear(c: Context, component: String) = Store.get(c).setProblem(component, null)
    fun set(c: Context, component: String, message: String?) = Store.get(c).setProblem(component, message)

    fun expireEvents(c: Context, now: Long) {
        val store = Store.get(c)
        for (comp in EVENTS) {
            val since = store.problemSince(comp) ?: continue
            if (now - since > EVENT_SHOWN_MS) store.setProblem(comp, null)
        }
    }

    fun fmt(ms: Long): String = SimpleDateFormat("d MMM HH:mm", Locale.US).apply { timeZone = TimeZone.getDefault() }.format(Date(ms))
}

object Meta {
    /** Added to every interval's `meta`. */
    fun common(c: Context): Map<String, Any?> = mapOf(
        "tz" to TimeZone.getDefault().id,
        "v" to BuildConfig.VERSION_NAME,
    )
}
