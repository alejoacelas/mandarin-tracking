package com.mandarintracking.android

import android.Manifest
import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.os.Process
import android.provider.Settings

/** Live state of everything the app needs. Each check reads the system directly. */
object Permissions {
    fun listenerComponent(c: Context) = ComponentName(c, MediaListenerService::class.java)
    fun accessibilityComponent(c: Context) = ComponentName(c, TextSamplerService::class.java)

    fun usageAccess(c: Context): Boolean {
        val ops = c.getSystemService(AppOpsManager::class.java)
        val mode = if (Build.VERSION.SDK_INT >= 29) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName)
        } else {
            @Suppress("DEPRECATION")
            ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), c.packageName)
        }
        return if (mode == AppOpsManager.MODE_DEFAULT) {
            c.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED
        } else {
            mode == AppOpsManager.MODE_ALLOWED
        }
    }

    fun notificationAccess(c: Context): Boolean {
        if (Build.VERSION.SDK_INT >= 27) {
            return c.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(listenerComponent(c))
        }
        val flat = Settings.Secure.getString(c.contentResolver, "enabled_notification_listeners") ?: return false
        return flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.contains(listenerComponent(c))
    }

    fun accessibility(c: Context): Boolean {
        val on = Settings.Secure.getInt(c.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
        val flat = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return on && flat.split(':').mapNotNull { ComponentName.unflattenFromString(it) }.contains(accessibilityComponent(c))
    }

    fun batteryUnrestricted(c: Context): Boolean =
        c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)

    /** The "Restricted" battery setting (Android 9+) stops background work entirely. */
    fun backgroundRestricted(c: Context): Boolean =
        Build.VERSION.SDK_INT >= 28 && c.getSystemService(ActivityManager::class.java).isBackgroundRestricted

    fun notificationsAllowed(c: Context): Boolean =
        c.getSystemService(NotificationManager::class.java).areNotificationsEnabled()

    /**
     * Android 13+ blocks accessibility and notification access for apps installed from a file
     * until "Allow restricted settings" is tapped in App info. Returns null when the phone doesn't
     * say (older Android, or the check isn't available).
     */
    fun restrictedSettingsAllowed(c: Context): Boolean? {
        if (Build.VERSION.SDK_INT < 33) return null
        return try {
            val mode = c.getSystemService(AppOpsManager::class.java)
                .unsafeCheckOpNoThrow("android:access_restricted_settings", Process.myUid(), c.packageName)
            mode == AppOpsManager.MODE_ALLOWED || mode == AppOpsManager.MODE_DEFAULT
        } catch (e: Exception) {
            null
        }
    }

    /** The map sent in heartbeats. Keys match the hub's dashboard names; values must be booleans. */
    fun heartbeatMap(c: Context): Map<String, Boolean> = linkedMapOf(
        "usage_access" to usageAccess(c),
        "notification_access" to notificationAccess(c),
        "accessibility" to accessibility(c),
        "battery_unrestricted" to (batteryUnrestricted(c) && !backgroundRestricted(c)),
    )
}
