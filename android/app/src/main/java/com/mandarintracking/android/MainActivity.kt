package com.mandarintracking.android

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import kotlin.concurrent.thread

/** The setup checklist. Every item shows its live state and opens the exact settings page. */
class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var list: LinearLayout
    private var pairMessage: String? = null
    private var pairing = false
    private var foundHub: String? = null
    private var searching = false

    private val refresher = object : Runnable {
        override fun run() { render(); handler.postDelayed(this, 2_000) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(32)) }
        setContentView(ScrollView(this).apply { addView(list) })
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresher)
        if (!Prefs(this).paired) searchHub()
        Work.syncSoon(this)
    }

    override fun onPause() {
        handler.removeCallbacks(refresher)
        super.onPause()
    }

    private fun searchHub() {
        if (searching || Prefs(this).manualHub != null) return
        searching = true
        thread {
            val found = HubLocator.discover(this).firstOrNull()
            handler.post { foundHub = found; searching = false; render() }
        }
    }

    // ---- rendering ----

    private var codeField: EditText? = null
    private var addressField: EditText? = null

    private fun render() {
        val prefs = Prefs(this)
        // Keep what the user is typing across refreshes.
        val code = codeField?.text?.toString()
        val addr = addressField?.text?.toString()
        val focused = currentFocus
        if (focused is EditText) return // don't rebuild under the user's fingers
        list.removeAllViews()

        list.addView(text("Mandarin tracker", 22f, bold = true))
        list.addView(text("Counts time in YouTube, Pleco, Readwise Reader and AI chat apps, and sends it to the Mac. " +
            "Do each step once. After that, nothing needs to be opened.", 15f).also { it.setPadding(0, dp(4), 0, dp(12)) })

        val usage = Permissions.usageAccess(this)
        val notif = Permissions.notificationAccess(this)
        val a11y = Permissions.accessibility(this)
        val battery = Permissions.batteryUnrestricted(this)
        val restricted = Permissions.backgroundRestricted(this)

        // 1. Pairing
        val pairStatus = when {
            prefs.paired -> "Connected to the Mac (${prefs.lastHub ?: prefs.manualHub ?: "address unknown"})."
            prefs.pairingLost -> "The Mac no longer knows this phone. Enter the new code from its dashboard."
            prefs.manualHub != null -> "Will use the address ${prefs.manualHub}."
            foundHub != null -> "Found the Mac at $foundHub."
            searching -> "Looking for the Mac on this Wi-Fi…"
            else -> "No Mac found on this Wi-Fi yet. Make sure the phone is on the same Wi-Fi as the Mac."
        }
        val pairBox = item("Connect to the Mac", prefs.paired, pairStatus,
            if (prefs.paired) null else "Enter the 6-digit code shown on the Mac dashboard.")
        if (!prefs.paired) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
            codeField = EditText(this).apply {
                hint = "123456"; inputType = InputType.TYPE_CLASS_NUMBER; setText(code ?: ""); minEms = 5
                contentDescription = "Pairing code"
            }
            row.addView(codeField)
            row.addView(button(if (pairing) "Connecting…" else "Connect") { doPair() }.also { it.isEnabled = !pairing })
            pairBox.addView(row)
            pairMessage?.let { pairBox.addView(text(it, 14f, color = ERROR)) }
        }
        list.addView(pairBox)

        // 2. Restricted settings (Android 13+, app installed from a file)
        val restrictedAllowed = Permissions.restrictedSettingsAllowed(this)
        if (Build.VERSION.SDK_INT >= 33 && (!a11y || !notif) && restrictedAllowed != true) {
            list.addView(item("Allow restricted settings", false,
                if (restrictedAllowed == false) "Android blocks the accessibility and notification switches for apps installed from a file."
                else "If the accessibility or notification switch below is greyed out or shows \"Restricted setting\", do this first.",
                "Tap Open. On the App info page, tap ⋮ (top right), then Allow restricted settings, and confirm with your PIN. " +
                    "If ⋮ has no such item, first try the Accessibility step below once (Android shows a \"Restricted setting\" message), then come back here.",
                "Open App info") { openAppDetails() })
        }

        // 3. Usage access
        list.addView(item("Usage access", usage,
            if (usage) "On. App time is read from Android's usage history." else "Off. Needed to count time in Pleco, Reader and AI chat apps.",
            if (usage) null else "Tap Open, choose Mandarin tracker, and turn on \"Permit usage access\".",
            "Open") { openUsageAccess() })

        // 4. Notification access
        list.addView(item("Notification access", notif,
            if (notif) (if (MediaListenerService.connected) "On. YouTube playback is counted." else "On, but the YouTube tracker hasn't started yet.")
            else "Off. Needed to count YouTube, including background play.",
            if (notif) null else "Tap Open and turn on Mandarin tracker. The app reads only what is playing, not your notifications.",
            "Open") { openNotificationAccess() })

        // 5. Accessibility
        list.addView(item("Accessibility service", a11y,
            if (a11y) (if (TextSamplerService.running) "On. The language of Reader and AI chats is measured." else "On, but the service hasn't started yet. If this stays, turn it off and on again.")
            else "Off. Needed to tell Chinese from other languages in Reader and AI chat apps.",
            if (a11y) null else "Tap Open, then Installed apps (or Downloaded apps) → Mandarin tracker → turn it on. " +
                "Android warns that the app can see the screen. It only looks at Reader and AI chat apps, counts Chinese characters, and never stores or sends the text.",
            "Open") { openAccessibility() })

        // 6. Battery
        list.addView(item("Run in the background", battery && !restricted,
            when {
                restricted -> "Battery use is set to Restricted, so Android stops the app."
                battery -> "On. Android won't put the app to sleep."
                else -> "Android may delay or stop the app to save battery."
            },
            when {
                restricted -> "Tap Open, then Battery (or App battery usage) → Unrestricted."
                battery -> null
                else -> "Tap Open and choose Allow."
            },
            "Open") { if (restricted) openAppDetails() else openBattery() })

        // 7. Notifications (Android 13+): needed to tell the user when something breaks.
        if (Build.VERSION.SDK_INT >= 33) {
            val allowed = Permissions.notificationsAllowed(this)
            list.addView(item("Notifications", allowed,
                if (allowed) "On. The app tells you if tracking stops working." else "Off. The app can't tell you if tracking stops working.",
                if (allowed) null else "Tap Allow.", "Allow") {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            })
        }

        // 8. Phone makers that stop background apps
        oemAdvice()?.let { (title, how, intents) ->
            list.addView(item(title, null, "Some phones stop background apps unless told not to.", how, "Open") { startFirst(intents + appDetailsIntent()) })
        }

        val allGood = prefs.paired && usage && notif && a11y && battery && !restricted
        if (allGood && !prefs.setupDone) prefs.setupDone = true

        // Status
        list.addView(text("Status", 18f, bold = true).also { it.setPadding(0, dp(20), 0, dp(4)) })
        val store = Store.get(this)
        val lastOk = prefs.lastSyncOk
        list.addView(text(buildString {
            append(if (lastOk != null) "Last sent to the Mac: ${ago(lastOk)}." else "Nothing sent to the Mac yet.")
            append(" Waiting to send: ${store.unsentCount()}.")
            prefs.lastSyncError?.takeIf { prefs.paired }?.let { append("\nLast attempt: $it") }
        }, 14f))
        for (p in store.activeProblems()) list.addView(text("• ${p.message}", 14f, color = ERROR))
        list.addView(button("Send now") { Work.syncSoon(this, name = "manual-${System.currentTimeMillis()}") })

        // Advanced
        list.addView(text("Advanced", 18f, bold = true).also { it.setPadding(0, dp(20), 0, dp(4)) })
        list.addView(text("Mac address, only if the Mac isn't found automatically (for example 192.168.1.20:47800). Leave empty to search.", 14f))
        val advRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        addressField = EditText(this).apply {
            hint = "192.168.1.20:47800"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(addr ?: prefs.manualHub ?: ""); minEms = 9; contentDescription = "Mac address"
        }
        advRow.addView(addressField)
        advRow.addView(button("Save") {
            prefs.manualHub = addressField?.text?.toString()?.removePrefix("http://")?.trimEnd('/')
            addressField?.clearFocus()
            foundHub = null
            searchHub()
            render()
        })
        list.addView(advRow)
        list.addView(text("Version ${BuildConfig.VERSION_NAME} · Android ${Build.VERSION.RELEASE} · ${Pairing.deviceName()}", 12f, color = MUTED).also { it.setPadding(0, dp(16), 0, 0) })
    }

    private fun doPair() {
        val code = codeField?.text?.toString()?.trim().orEmpty()
        if (!code.matches(Regex("\\d{6}"))) { pairMessage = "The code has 6 digits."; codeField?.clearFocus(); render(); return }
        pairing = true
        pairMessage = null
        codeField?.clearFocus()
        render()
        thread {
            val out = Pairing.pair(this, code)
            handler.post {
                pairing = false
                pairMessage = when (out) {
                    is Pairing.Outcome.Paired -> null
                    Pairing.Outcome.WrongCode -> "Wrong code. Check the code on the Mac dashboard; it changes after each phone connects."
                    is Pairing.Outcome.Failed -> out.message
                }
                if (out is Pairing.Outcome.Paired) { codeField?.setText(""); Work.syncSoon(this) }
                Notifier.updateAttention(this)
                render()
            }
        }
    }

    // ---- intents ----

    private fun pkgUri() = Uri.parse("package:$packageName")
    private fun appDetailsIntent() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri())
    private fun openAppDetails() = startFirst(listOf(appDetailsIntent()))

    private fun openUsageAccess() = startFirst(listOf(
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS, pkgUri()),
        Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS),
    ))

    private fun openNotificationAccess() {
        val list = ArrayList<Intent>()
        if (Build.VERSION.SDK_INT >= 30) {
            list += Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, Permissions.listenerComponent(this).flattenToString())
        }
        list += Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        startFirst(list)
    }

    private fun openAccessibility() {
        val comp = Permissions.accessibilityComponent(this).flattenToString()
        startFirst(listOf(
            // Opens the app's own switch on Android 11+; not in the public SDK, so the list page is next.
            Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").putExtra(Intent.EXTRA_COMPONENT_NAME, comp),
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
        ))
    }

    @Suppress("BatteryLife")
    private fun openBattery() = startFirst(listOf(
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri()),
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
    ))

    /** Opens the first intent the phone can handle. Phones differ in which settings pages exist. */
    private fun startFirst(intents: List<Intent>) {
        for (i in intents) {
            try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return } catch (e: Exception) { }
        }
    }

    private fun oemAdvice(): Triple<String, String, List<Intent>>? {
        val m = Build.MANUFACTURER.lowercase()
        fun comp(p: String, c: String) = Intent().setComponent(ComponentName(p, c))
        return when {
            m in setOf("xiaomi", "redmi", "poco") -> Triple("Xiaomi: allow autostart",
                "Tap Open and turn on Autostart for Mandarin tracker. Then in App info → Battery saver choose No restrictions.",
                listOf(comp("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity")))
            m in setOf("huawei", "honor") -> Triple("Huawei/Honor: manage app launch",
                "Tap Open, find Mandarin tracker, turn off \"Manage automatically\" and turn on all three switches (auto-launch, secondary launch, run in background).",
                listOf(comp("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                    comp("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity")))
            m == "samsung" -> Triple("Samsung: never sleep",
                "Tap Open, then Battery → Unrestricted. Also check Settings → Battery → Background usage limits: Mandarin tracker must not be under Sleeping or Deep sleeping apps.",
                emptyList())
            m in setOf("oppo", "realme", "oneplus") -> Triple("Oppo/Realme/OnePlus: allow background activity",
                "Tap Open, then Battery → Allow background activity (and Allow auto launch if shown).",
                listOf(comp("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity")))
            m in setOf("vivo", "iqoo") -> Triple("Vivo: allow background running",
                "Tap Open and allow Mandarin tracker to run in the background and to auto-start.",
                listOf(comp("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity")))
            else -> null
        }
    }

    // ---- small view helpers ----

    private fun item(title: String, ok: Boolean?, status: String, how: String?, action: String? = null, onClick: (() -> Unit)? = null): LinearLayout {
        val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(10), 0, dp(10)) }
        val mark = when (ok) { true -> "✓ "; false -> "○ "; null -> "• " }
        box.addView(text(mark + title, 17f, bold = true, color = if (ok == true) OK else null))
        box.addView(text(status, 14f))
        if (how != null) {
            box.addView(text(how, 14f, color = MUTED))
            if (action != null && onClick != null) box.addView(button(action, onClick))
        }
        return box
    }

    private fun text(s: String, size: Float, bold: Boolean = false, color: Int? = null) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        if (bold) typeface = Typeface.DEFAULT_BOLD
        color?.let { setTextColor(it) }
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun ago(ms: Long): String {
        val m = (System.currentTimeMillis() - ms) / 60_000
        return when {
            m < 1 -> "just now"
            m < 120 -> "$m min ago"
            m < 48 * 60 -> "${m / 60} h ago"
            else -> "${m / 1440} days ago"
        }
    }

    companion object {
        private const val OK = 0xFF1B7F3B.toInt()
        private const val ERROR = 0xFFB3261E.toInt()
        private const val MUTED = 0xFF6B6B6B.toInt()
    }
}
