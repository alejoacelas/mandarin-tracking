package com.mandarintracking.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.mandarintracking.android.core.ChineseShare
import com.mandarintracking.android.core.Share
import com.mandarintracking.android.core.TextSample
import com.mandarintracking.android.core.TrackedApps

/**
 * Measures how Chinese the on-screen text of Reader and LLM apps is. It listens only to those
 * packages, reads the visible text at most every [INTERVAL_MS] while it changes, and stores only
 * the Han and unit counts, never the text.
 */
class TextSamplerService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var pendingPkg: String? = null
    private val lastSampleAt = HashMap<String, Long>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        serviceInfo = serviceInfo.apply {
            packageNames = TrackedApps.sampledPackages
            eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or
                AccessibilityEvent.TYPE_VIEW_SCROLLED or AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED
            feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            notificationTimeout = 500
            flags = flags or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        }
        connectedAt = System.currentTimeMillis()
        running = true
    }

    override fun onDestroy() {
        running = false
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onInterrupt() {}

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val pkg = event?.packageName?.toString() ?: return
        if (pkg !in TrackedApps.sampledPackages) return
        lastEventAt = System.currentTimeMillis()
        if (pendingPkg != null) return
        val now = SystemClock.elapsedRealtime()
        val last = lastSampleAt[pkg] ?: Long.MIN_VALUE / 2
        // Let the screen settle briefly, and keep at least INTERVAL_MS between samples.
        val delay = maxOf(SETTLE_MS, last + INTERVAL_MS - now)
        pendingPkg = pkg
        handler.postDelayed({ sample(pkg) }, delay)
    }

    private fun sample(pkg: String) {
        pendingPkg = null
        val root = try { rootInActiveWindow } catch (e: Exception) { null } ?: return
        try {
            if (root.packageName?.toString() != pkg) return
            val texts = LinkedHashSet<String>()
            collect(root, texts, inChrome = false, depth = 0, budget = intArrayOf(MAX_NODES))
            val share = Extraction.measure(texts)
            lastSampleAt[pkg] = SystemClock.elapsedRealtime()
            Store.get(this).addSample(TextSample(pkg, System.currentTimeMillis(), share.han, share.units))
            lastStoredAt = System.currentTimeMillis()
        } catch (e: Exception) {
            lastError = e.toString()
        } finally {
            @Suppress("DEPRECATION")
            if (Build.VERSION.SDK_INT < 33) root.recycle()
        }
    }

    private fun collect(node: AccessibilityNodeInfo, out: MutableSet<String>, inChrome: Boolean, depth: Int, budget: IntArray) {
        if (depth > MAX_DEPTH || budget[0]-- <= 0) return
        if (!node.isVisibleToUser) return
        val chrome = inChrome || Extraction.isChromeClass(node.className?.toString(), node.viewIdResourceName)
        if (!chrome) {
            val showingHint = Build.VERSION.SDK_INT >= 26 && node.isShowingHintText
            if (!showingHint && !node.isPassword && !Extraction.isButtonLike(node.className?.toString(), node.isClickable, node.text)) {
                node.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out += it }
            }
        }
        for (i in 0 until node.childCount) {
            val child = try { node.getChild(i) } catch (e: Exception) { null } ?: continue
            try {
                collect(child, out, chrome, depth + 1, budget)
            } finally {
                @Suppress("DEPRECATION")
                if (Build.VERSION.SDK_INT < 33) child.recycle()
            }
        }
    }

    companion object {
        const val INTERVAL_MS = 10_000L
        const val SETTLE_MS = 1_500L
        const val MAX_NODES = 3000
        const val MAX_DEPTH = 80

        // Read by the health check in the same process.
        @Volatile var running = false
        @Volatile var connectedAt = 0L
        @Volatile var lastEventAt = 0L
        @Volatile var lastStoredAt = 0L
        @Volatile var lastError: String? = null
    }
}

/** Rules for telling content text apart from interface text. Pure, so it is unit-tested. */
object Extraction {
    /** Strings with fewer units are labels, buttons or tabs ("发送", "New chat", "首页"). */
    const val MIN_UNITS_PER_STRING = 5

    private val chromeClassHints = listOf("Toolbar", "ActionBar", "TabLayout", "TabWidget", "BottomNavigation", "NavigationBar", "NavigationRail", "NavigationView", "Menu")
    private val chromeIdHints = listOf("toolbar", "tab_bar", "bottom_nav", "navigation", "drawer", "menu", "sidebar", "app_bar", "appbar")

    fun isChromeClass(cls: String?, viewId: String?): Boolean {
        if (cls != null && chromeClassHints.any { cls.contains(it) }) return true
        val id = viewId?.substringAfter(":id/")?.lowercase() ?: return false
        return chromeIdHints.any { id.contains(it) }
    }

    fun isButtonLike(cls: String?, clickable: Boolean, text: CharSequence?): Boolean {
        if (cls != null && (cls.endsWith("Button") || cls.endsWith("Chip") || cls.endsWith("Tab") || cls.endsWith("CheckBox") || cls.endsWith("Switch"))) return true
        // A short clickable text is a control; long clickable text (a whole message bubble) is content.
        return clickable && ChineseShare.of(text?.toString()).units < 2 * MIN_UNITS_PER_STRING
    }

    /** Units of the given strings, skipping short ones and repeats. */
    fun measure(texts: Collection<String>): Share =
        texts.distinct().map { ChineseShare.of(it) }.filter { it.units >= MIN_UNITS_PER_STRING }.fold(Share.EMPTY) { a, b -> a + b }
}
