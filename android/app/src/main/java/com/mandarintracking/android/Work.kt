package com.mandarintracking.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.NotificationListenerService
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.mandarintracking.android.core.SyncEngine
import com.mandarintracking.android.core.SyncOutcome
import com.mandarintracking.android.core.SyncReport
import com.mandarintracking.android.core.HttpResult
import org.json.JSONObject
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.math.abs

object Work {
    private const val PERIODIC = "collect-and-sync"
    private const val RETRY = "sync-retry"
    private const val SOON = "sync-soon"

    /** Idempotent: keeps the existing schedule if there is one. */
    fun schedule(c: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setInputData(workDataOf("mode" to "periodic"))
            .build()
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** Runs collection and sync as soon as the network allows, retrying with exponential backoff. */
    fun syncSoon(c: Context, delaySec: Long = 0, name: String = SOON) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>()
            .setInputData(workDataOf("mode" to "retry"))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .setInitialDelay(delaySec, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(c).enqueueUniqueWork(name, ExistingWorkPolicy.KEEP, req)
    }

    fun scheduleRetry(c: Context) = syncSoon(c, delaySec = 60, name = RETRY)
}

class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val retryMode = inputData.getString("mode") == "retry"
        val report = Collector.runAll(applicationContext)
        val failed = report != null && report.outcome in setOf(SyncOutcome.UNREACHABLE, SyncOutcome.HUB_ERROR)
        if (!failed) return Result.success()
        if (retryMode) return if (runAttemptCount < 30) Result.retry() else Result.success()
        Work.scheduleRetry(applicationContext)
        return Result.success()
    }
}

/** One pass of everything: health checks, usage history, problems, sync, attention notification. */
object Collector {
    private val lock = Any()

    fun runAll(c: Context): SyncReport? = synchronized(lock) {
        val now = System.currentTimeMillis()
        Health.checkClock(c, now)
        val usageMsg = if (!Permissions.usageAccess(c)) null else try {
            UsageCollector(c).run(now)
            Health.usageSilence(c, now)
        } catch (e: Exception) {
            "Reading app usage failed: $e"
        }
        Problems.set(c, Problems.USAGE, usageMsg)
        Health.checkServices(c, now)
        Problems.expireEvents(c, now)
        Store.get(c).pruneSent(now - KEEP_SENT_MS)
        val report = Sync.run(c)
        Notifier.updateAttention(c)
        report
    }

    const val KEEP_SENT_MS = 14 * 86_400_000L
}

object Sync {
    /** Returns null when not paired. */
    fun run(c: Context): SyncReport? {
        val prefs = Prefs(c)
        val token = prefs.token ?: return null
        val store = Store.get(c)
        val found = HubLocator.withHub(c) { addr ->
            val rep = SyncEngine(store, store, HttpTransport(addr, token)) { System.currentTimeMillis() }.run(heartbeat(c))
            HttpResult(if (rep.outcome == SyncOutcome.UNREACHABLE) -1 else 200, null, error = rep.detail) to rep
        }
        val report = found?.second ?: SyncReport(SyncOutcome.UNREACHABLE, detail = prefs.lastSyncError)
        val now = System.currentTimeMillis()
        when (report.outcome) {
            SyncOutcome.OK -> {
                prefs.lastSyncOk = now
                prefs.lastSyncError = null
                report.serverDateMs?.let { prefs.hubSkewMs = it - now }
            }
            SyncOutcome.UNAUTHORIZED -> {
                prefs.token = null
                prefs.pairingLost = true
                prefs.lastSyncError = "The hub no longer knows this phone. Enter a new code."
            }
            else -> prefs.lastSyncError = report.detail
        }
        val rejected = store.rejectedCount()
        Problems.set(
            c, Problems.SYNC,
            if (rejected > 0) "The hub refused $rejected intervals (last reason: ${store.lastRejectReason()}). They are kept and retried every 6 hours." else null,
        )
        val skew = prefs.hubSkewMs
        Problems.set(
            c, Health.CLOCK_SKEW,
            if (skew != null && abs(skew) > 2 * 60_000) "The phone clock differs from the Mac's by ${skew / 60_000} minutes; times from the phone may be off." else null,
        )
        return report
    }

    fun heartbeat(c: Context): JSONObject {
        val store = Store.get(c)
        val prefs = Prefs(c)
        return JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("permissions", JSONObject(Permissions.heartbeatMap(c) as Map<*, *>))
            .put("meta", JSONObject()
                .put("android_sdk", Build.VERSION.SDK_INT)
                .put("device", Pairing.deviceName())
                .put("tz", TimeZone.getDefault().id)
                .put("unsent", store.unsentCount())
                .put("media_listener_connected", MediaListenerService.connected)
                .put("accessibility_running", TextSamplerService.running)
                .put("restricted_settings_allowed", Permissions.restrictedSettingsAllowed(c) ?: JSONObject.NULL)
                .put("background_restricted", Permissions.backgroundRestricted(c))
                .put("last_usage_read_ms", prefs.lastUsageRead ?: JSONObject.NULL)
                .put("last_text_sample_ms", store.lastSampleAt() ?: JSONObject.NULL))
    }
}

object Health {
    const val CLOCK_SKEW = "android.clock_skew"
    private const val SERVICE_GRACE_MS = 2 * 60_000L
    private const val WORKER_GAP_MS = 24 * 3600_000L
    private const val NO_EVENTS_MS = 36 * 3600_000L

    fun checkClock(c: Context, now: Long) {
        val prefs = Prefs(c)
        val elapsed = SystemClock.elapsedRealtime()
        val boot = Settings.Global.getLong(c.contentResolver, Settings.Global.BOOT_COUNT, -1)
        val lastWall = prefs.lastRunWall
        val lastElapsed = prefs.lastRunElapsed
        if (lastWall != null && lastElapsed != null && prefs.lastRunBoot == boot && elapsed >= lastElapsed) {
            val jump = (now - lastWall) - (elapsed - lastElapsed)
            if (abs(jump) > 2 * 60_000) {
                Problems.report(c, Problems.CLOCK, "The phone clock was changed by ${jump / 60_000} minutes between ${Problems.fmt(lastWall)} and ${Problems.fmt(now)}.")
            }
            if (elapsed - lastElapsed > WORKER_GAP_MS) {
                Problems.report(c, Problems.WORKER_GAP, "Background work did not run from ${Problems.fmt(lastWall)} to ${Problems.fmt(now)}. The phone may be stopping the app; see the setup screen.")
            }
        }
        prefs.lastRunWall = now
        prefs.lastRunElapsed = elapsed
        prefs.lastRunBoot = boot
    }

    fun checkServices(c: Context, now: Long) {
        val up = SystemClock.elapsedRealtime() - App.startElapsed > SERVICE_GRACE_MS

        val mediaMsg = when {
            !Permissions.notificationAccess(c) -> null // reported as a missing permission in the heartbeat
            MediaListenerService.lastError != null -> "YouTube tracking error: ${MediaListenerService.lastError}"
            !MediaListenerService.connected && up -> {
                try { NotificationListenerService.requestRebind(Permissions.listenerComponent(c)) } catch (e: Exception) {}
                "Notification access is on, but the YouTube tracker isn't running. Turning notification access off and on again usually fixes it."
            }
            else -> null
        }
        Problems.set(c, Problems.MEDIA, mediaMsg)

        val a11yMsg = when {
            !Permissions.accessibility(c) -> null
            !TextSamplerService.running && up -> "Accessibility is on, but the language checker isn't running. Turn it off and on again in Accessibility settings."
            TextSamplerService.lastError != null -> "Language checker error: ${TextSamplerService.lastError}"
            else -> null
        }
        Problems.set(c, Problems.ACCESSIBILITY, a11yMsg)
    }

    /** A message when Android has stopped recording usage events, else null. */
    fun usageSilence(c: Context, now: Long): String? {
        val lastEvent = Prefs(c).lastAnyUsageEvent ?: return null
        return if (now - lastEvent > NO_EVENTS_MS) {
            "Android has recorded no app usage since ${Problems.fmt(lastEvent)}. Usage history may be turned off on this phone."
        } else null
    }
}

/** Re-arms the schedule after reboot and app updates (WorkManager also does this itself). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Work.schedule(context)
        Work.syncSoon(context, delaySec = 30)
    }
}

/** A clock or time-zone change: collect soon so the check runs while it's fresh. */
class TimeChangeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Work.syncSoon(context, delaySec = 5)
    }
}
