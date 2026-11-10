package com.mandarintracking.android

import android.content.Context
import android.content.SharedPreferences

/** Small settings and bookkeeping values, kept in the app's private storage. */
class Prefs(context: Context) {
    private val p: SharedPreferences = context.applicationContext.getSharedPreferences("tracker", Context.MODE_PRIVATE)

    private fun str(k: String) = p.getString(k, null)
    private fun long(k: String) = if (p.contains(k)) p.getLong(k, 0) else null
    private fun put(k: String, v: String?) = p.edit().apply { if (v == null) remove(k) else putString(k, v) }.commit()
    private fun put(k: String, v: Long?) = p.edit().apply { if (v == null) remove(k) else putLong(k, v) }.commit()

    var token: String? get() = str("token"); set(v) { put("token", v) }
    var deviceId: String? get() = str("device_id"); set(v) { put("device_id", v) }

    /** True after the hub answered 401: the user must enter a new code. */
    var pairingLost: Boolean get() = p.getBoolean("pairing_lost", false); set(v) { p.edit().putBoolean("pairing_lost", v).commit() }

    /** "host:port" of the last hub that answered. Tried first. */
    var lastHub: String? get() = str("last_hub"); set(v) { put("last_hub", v) }

    /** "host:port" typed in settings. When set, discovery is skipped. */
    var manualHub: String? get() = str("manual_hub"); set(v) { put("manual_hub", v?.trim()?.ifEmpty { null }) }

    /** Where the next usage-event read starts (see SessionBuilder.nextCursor). */
    var usageCursor: Long? get() = long("usage_cursor"); set(v) { put("usage_cursor", v) }

    /** When usage events were last read successfully (wall clock). */
    var lastUsageRead: Long? get() = long("last_usage_read"); set(v) { put("last_usage_read", v) }

    /** Wall time of the last usage event seen at all, to spot phones that stop recording them. */
    var lastAnyUsageEvent: Long? get() = long("last_any_usage_event"); set(v) { put("last_any_usage_event", v) }

    // Clock bookkeeping from the previous worker run, to spot clock jumps and reboots.
    var lastRunWall: Long? get() = long("last_run_wall"); set(v) { put("last_run_wall", v) }
    var lastRunElapsed: Long? get() = long("last_run_elapsed"); set(v) { put("last_run_elapsed", v) }
    var lastRunBoot: Long? get() = long("last_run_boot"); set(v) { put("last_run_boot", v) }

    var lastSyncOk: Long? get() = long("last_sync_ok"); set(v) { put("last_sync_ok", v) }
    var lastSyncError: String? get() = str("last_sync_error"); set(v) { put("last_sync_error", v) }

    /** Hub clock minus phone clock, from the HTTP Date header of the last reply. */
    var hubSkewMs: Long? get() = long("hub_skew"); set(v) { put("hub_skew", v) }

    /** Set once every checklist item was green, so later regressions can raise a notification. */
    var setupDone: Boolean get() = p.getBoolean("setup_done", false); set(v) { p.edit().putBoolean("setup_done", v).commit() }

    /** The last attention message shown as a notification, to avoid repeating it. */
    var notifiedAttention: String? get() = str("notified_attention"); set(v) { put("notified_attention", v) }

    val paired: Boolean get() = token != null
}
