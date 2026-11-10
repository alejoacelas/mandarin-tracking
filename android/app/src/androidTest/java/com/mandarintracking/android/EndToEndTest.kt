package com.mandarintracking.android

import android.app.NotificationManager
import android.app.UiAutomation
import android.content.Context
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import com.mandarintracking.android.core.SyncOutcome
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Full path on an emulator: simulator apps (installed under the real package ids) → usage events,
 * accessibility samples and media sessions → outbox → a fake hub on the host (e2e/fake_hub.py).
 * Run through e2e/run.sh, which installs the simulators and starts the fake hub.
 */
@RunWith(AndroidJUnit4::class)
class EndToEndTest {
    private val ctx: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val pkg = ctx.packageName
    private lateinit var ua: UiAutomation

    companion object {
        const val HUB = "10.0.2.2:47811"
        const val TAG = "E2E"
        const val PLECO = "com.pleco.chinesesystem"
        const val GPT = "com.openai.chatgpt"
        const val READER = "com.readermobile"
        const val YT = "com.google.android.youtube"
        const val SIM = "com.mandarintracking.simulators"
    }

    @Before
    fun setUp() {
        // Keep our own accessibility service running while the test drives the device.
        Configurator.getInstance().uiAutomationFlags = UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES
        ua = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        grantAll()
        hubConfig(JSONObject().put("reset", true))
        val prefs = Prefs(ctx)
        prefs.token = null
        prefs.pairingLost = false
        prefs.manualHub = HUB
        prefs.lastHub = null
        prefs.setupDone = false
        prefs.notifiedAttention = null
        prefs.usageCursor = System.currentTimeMillis()
        val db = Store.get(ctx).writableDatabase
        db.execSQL("DELETE FROM outbox"); db.execSQL("DELETE FROM samples"); db.execSQL("DELETE FROM problems")
        ctx.getSystemService(NotificationManager::class.java).cancelAll()
        try {
            waitFor("services bound", 15_000) { MediaListenerService.connected && TextSamplerService.running }
        } catch (e: AssertionError) {
            // Older Android rebinds the services to the restarted test process slowly; switch them off and on.
            Log.i(TAG, "rebinding: listener=${MediaListenerService.connected} a11y=${TextSamplerService.running}")
            val l = shell("settings get secure enabled_notification_listeners").trim()
            val a = shell("settings get secure enabled_accessibility_services").trim()
            shell("settings put secure enabled_notification_listeners ${l.split(':').filter { !it.startsWith(pkg) }.joinToString(":").ifEmpty { "\"\"" }}")
            shell("settings put secure enabled_accessibility_services \"\"")
            Thread.sleep(1_000)
            shell("settings put secure enabled_notification_listeners $l")
            shell("settings put secure enabled_accessibility_services $a")
            // Android 8 doesn't bind the notification listener into an instrumented process at all
            // (outside tests it rebinds within ~20 s of the process dying), so only YouTube tests need it there.
            val needListener = android.os.Build.VERSION.SDK_INT >= 28
            waitFor("services bound", 30_000) { (MediaListenerService.connected || !needListener) && TextSamplerService.running }
        }
        shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard"); home()
    }

    // ---- tests ----

    @Test
    fun appSessionsGetLanguageAndReachHub() {
        pair()
        open(PLECO, "zh"); Thread.sleep(12_000); home()
        open(GPT, "zh"); Thread.sleep(25_000); home()
        open(READER, "en"); Thread.sleep(25_000); home()
        open(GPT, "ja"); Thread.sleep(25_000); home()
        Thread.sleep(UsageCollector.SAMPLE_SETTLE_MS + 3_000)
        assertEquals(SyncOutcome.OK, Collector.runAll(ctx)?.outcome)

        val ivs = hubIntervals()
        Log.i(TAG, "intervals: $ivs")
        val pleco = ivs.single { it.getString("app") == PLECO }
        assertEquals("pleco", pleco.getString("source"))
        assertEquals("zh", pleco.getString("language"))
        assertDuration(pleco, 12_000)

        val gpt = ivs.filter { it.getString("app") == GPT }.sortedBy { it.getLong("start_ms") }
        assertEquals(2, gpt.size)
        assertEquals("llm", gpt[0].getString("source"))
        assertEquals("zh", gpt[0].getString("language"))
        assertTrue(gpt[0].getDouble("zh_share") > 0.9)
        assertTrue(gpt[0].getInt("units") >= 20)
        assertDuration(gpt[0], 25_000)
        assertEquals("other", gpt[1].getString("language")) // Japanese
        assertEquals(0.0, gpt[1].getDouble("zh_share"), 0.0)

        val reader = ivs.single { it.getString("app") == READER }
        assertEquals("reader", reader.getString("source"))
        assertEquals("other", reader.getString("language"))
        assertDuration(reader, 25_000)
        assertTrue(reader.getJSONObject("meta").getInt("samples") >= 2)

        // Reading again gives the same intervals: nothing new to send.
        Collector.runAll(ctx)
        assertEquals(ivs.map { it.toString() }.toSet(), hubIntervals().map { it.toString() }.toSet())
        assertEquals(0, Store.get(ctx).unsentCount())
    }

    @Test
    fun activitySwitchInsideAppIsOneSession() {
        pair()
        open(PLECO, "zh"); Thread.sleep(5_000)
        shell("am start -n $PLECO/$SIM.SecondActivity"); Thread.sleep(5_000)
        shell("input keyevent KEYCODE_BACK"); Thread.sleep(3_000); home()
        Collector.runAll(ctx)
        val pleco = hubIntervals().filter { it.getString("app") == PLECO }
        assertEquals(pleco.toString(), 1, pleco.size)
        assertDuration(pleco[0], 13_000)
    }

    @Test
    fun screenOffEndsSession() {
        pair()
        open(PLECO, "zh"); Thread.sleep(6_000)
        // Off for longer than the 10 s join window: Android 8 records no screen-off event, only a pause.
        shell("input keyevent KEYCODE_SLEEP"); Thread.sleep(15_000)
        shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard"); Thread.sleep(2_000); home()
        Collector.runAll(ctx)
        val pleco = hubIntervals().filter { it.getString("app") == PLECO }.sortedBy { it.getLong("start_ms") }
        Log.i(TAG, "screen off: $pleco")
        assertTrue(pleco.isNotEmpty())
        assertDuration(pleco[0], 6_000)
        assertTrue(pleco[0].getJSONObject("meta").getString("end") in setOf("screen_off", "keyguard", "paused"))
    }

    @Test
    fun youtubePlaybackBecomesIntervals() {
        pair()
        yt("play", "【中文】老高與小茉 第一集：为什么要学中文", "老高與小茉 Mr & Mrs Gao"); Thread.sleep(15_000)
        yt("pause"); Thread.sleep(3_000)
        yt("play", "How to learn tones", "English Channel"); Thread.sleep(10_000)
        yt("release"); Thread.sleep(2_000)
        assertEquals(SyncOutcome.OK, Collector.runAll(ctx)?.outcome)
        val ivs = hubIntervals().filter { it.getString("source") == "youtube" }.sortedBy { it.getLong("start_ms") }
        Log.i(TAG, "youtube: $ivs")
        assertEquals(2, ivs.size)
        assertEquals("老高與小茉 Mr & Mrs Gao", ivs[0].getString("channel_name"))
        assertEquals("unknown", ivs[0].getString("language"))
        assertTrue(ivs[0].getDouble("zh_share") > 0.5)
        assertEquals(YT, ivs[0].getString("app"))
        assertDuration(ivs[0], 15_000)
        assertEquals("paused", ivs[0].getJSONObject("meta").getString("end"))
        assertEquals("How to learn tones", ivs[1].getString("title"))
        assertDuration(ivs[1], 10_000)
        assertEquals("session_destroyed", ivs[1].getJSONObject("meta").getString("end"))
    }

    @Test
    fun youtubeAppKilledWhilePlaying() {
        pair()
        yt("play", "被杀掉的视频", "某频道"); Thread.sleep(8_000)
        yt("kill"); Thread.sleep(3_000)
        Collector.runAll(ctx)
        val iv = hubIntervals().single { it.getString("source") == "youtube" }
        assertDuration(iv, 8_000)
        assertEquals("session_destroyed", iv.getJSONObject("meta").getString("end"))
    }

    @Test
    fun youtubeBackgroundPlayWithScreenOff() {
        pair()
        yt("play", "后台播放", "某频道"); Thread.sleep(3_000)
        shell("input keyevent KEYCODE_SLEEP"); Thread.sleep(15_000)
        shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard")
        yt("pause"); Thread.sleep(2_000); yt("release")
        Collector.runAll(ctx)
        val iv = hubIntervals().single { it.getString("source") == "youtube" }
        assertTrue("background play counted: $iv", iv.getLong("end_ms") - iv.getLong("start_ms") >= 17_000)
    }

    @Test
    fun hubDownThenBack() {
        pair()
        hubConfig(JSONObject().put("mode", "down"))
        open(PLECO, "zh"); Thread.sleep(5_000); home()
        assertEquals(SyncOutcome.UNREACHABLE, Collector.runAll(ctx)?.outcome)
        assertTrue(Store.get(ctx).unsentCount() > 0)
        hubConfig(JSONObject().put("mode", "ok"))
        assertEquals(SyncOutcome.OK, Collector.runAll(ctx)?.outcome)
        assertEquals(1, hubIntervals().count { it.getString("app") == PLECO })
        assertEquals(0, Store.get(ctx).unsentCount())
    }

    @Test
    fun unauthorizedMarksUnpairedAndNotifies() {
        pair()
        hubConfig(JSONObject().put("mode", "401"))
        assertEquals(SyncOutcome.UNAUTHORIZED, Collector.runAll(ctx)?.outcome)
        val prefs = Prefs(ctx)
        assertTrue(prefs.pairingLost)
        assertFalse(prefs.paired)
        val n = ctx.getSystemService(NotificationManager::class.java).activeNotifications
        assertTrue("attention notification shown", n.any { it.id == 1 })
        // Pairing again clears it.
        hubConfig(JSONObject().put("mode", "ok"))
        pair()
        assertFalse(Prefs(ctx).pairingLost)
    }

    @Test
    fun rejectedIntervalsBecomeProblem() {
        pair()
        hubConfig(JSONObject().put("reject_prefix", "u:"))
        open(PLECO, "zh"); Thread.sleep(4_000); home()
        Collector.runAll(ctx)
        val problems = hubState().getJSONObject("problems")
        assertTrue(problems.toString(), problems.has(Problems.SYNC))
        assertTrue(problems.getJSONObject(Problems.SYNC).getString("message").contains("rejected by test"))
        assertEquals(1, Store.get(ctx).rejectedCount())
    }

    @Test
    fun heartbeatReportsPermissionsAndRevocation() {
        pair()
        Collector.runAll(ctx)
        var hb = hubState().getJSONArray("heartbeats").let { it.getJSONObject(it.length() - 1) }
        val perms = hb.getJSONObject("permissions")
        for (k in listOf("usage_access", "notification_access", "accessibility")) assertTrue(k, perms.getBoolean(k))
        assertEquals("1.0.0", hb.getString("version"))
        assertTrue(hb.getJSONObject("meta").getBoolean("media_listener_connected"))

        Prefs(ctx).setupDone = true
        shell("cmd notification disallow_listener $pkg/$pkg.MediaListenerService")
        Thread.sleep(2_000)
        Collector.runAll(ctx)
        hb = hubState().getJSONArray("heartbeats").let { it.getJSONObject(it.length() - 1) }
        assertFalse(hb.getJSONObject("permissions").getBoolean("notification_access"))
        val n = ctx.getSystemService(NotificationManager::class.java).activeNotifications
        assertTrue("attention notification after revocation", n.any { it.id == 1 })
    }

    @Test
    fun discoversHubThroughNsd() {
        val prefs = Prefs(ctx)
        prefs.manualHub = null
        prefs.lastHub = null
        shell("am start -n com.mandarintracking.hubbeacon/$SIM.BeaconActivity --ei target 47811")
        // The beacon stays in the foreground: Android freezes cached background apps.
        Thread.sleep(3_000)
        val found = HubLocator.discover(ctx)
        Log.i(TAG, "discovered: $found")
        assertTrue("found: $found", found.isNotEmpty())
        val out = Pairing.pair(ctx, hubState().getString("code"))
        assertTrue("$out", out is Pairing.Outcome.Paired)
        assertEquals(SyncOutcome.OK, Collector.runAll(ctx)?.outcome)
        assertTrue(hubState().getJSONArray("heartbeats").length() > 0)
    }

    @Test
    fun workManagerSendsWithoutTheApp() {
        pair()
        open(PLECO, "zh"); Thread.sleep(4_000); home()
        Work.syncSoon(ctx, name = "e2e-${System.currentTimeMillis()}")
        waitFor("hub got the interval", 60_000) { hubIntervals().any { it.getString("app") == PLECO } }
    }

    @Test
    fun pairingThroughTheSetupScreen() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        device.wait(Until.hasObject(By.text("Connect")), 10_000)
        val field = device.findObject(By.desc("Pairing code"))
        field.text = "000000".takeIf { it != hubState().getString("code") } ?: "111111"
        device.findObject(By.text("Connect")).click()
        assertNotNull(device.wait(Until.findObject(By.textContains("Wrong code")), 15_000))
        device.findObject(By.desc("Pairing code")).text = hubState().getString("code")
        device.findObject(By.text("Connect")).click()
        assertNotNull(device.wait(Until.findObject(By.textContains("Connected to the Mac")), 15_000))
        assertTrue(Prefs(ctx).paired)
        home()
    }

    // ---- helpers ----

    private fun grantAll() {
        shell("appops set $pkg GET_USAGE_STATS allow")
        val listener = "$pkg/$pkg.MediaListenerService"
        if (shell("cmd notification allow_listener $listener").contains("No shell command")) {
            // Android 8.0 has no "cmd notification"; edit the setting directly.
            val cur = shell("settings get secure enabled_notification_listeners").trim().takeUnless { it == "null" }.orEmpty()
            if (!cur.contains(listener)) shell("settings put secure enabled_notification_listeners ${listOf(cur, listener).filter { it.isNotEmpty() }.joinToString(":")}")
        }
        val a11y = "$pkg/$pkg.TextSamplerService"
        val current = shell("settings get secure enabled_accessibility_services").trim()
        if (!current.contains(a11y)) {
            shell("settings put secure enabled_accessibility_services $a11y")
        }
        shell("settings put secure accessibility_enabled 1")
        shell("dumpsys deviceidle whitelist +$pkg")
        shell("pm grant $pkg android.permission.POST_NOTIFICATIONS")
    }

    private fun pair() {
        val out = Pairing.pair(ctx, hubState().getString("code"))
        assertTrue("pairing: $out", out is Pairing.Outcome.Paired)
    }

    private fun open(app: String, lang: String) {
        shell("am start -W -n $app/$SIM.ContentActivity --es lang $lang")
    }

    private fun yt(cmd: String, title: String? = null, artist: String? = null) {
        val extra = buildString {
            title?.let { append(" --es title_b64 ${b64(it)}") }
            artist?.let { append(" --es artist_b64 ${b64(it)}") }
        }
        shell("am start -n $YT/$SIM.PlayerActivity --es cmd $cmd$extra")
        Thread.sleep(500)
    }

    private fun b64(s: String) = android.util.Base64.encodeToString(s.toByteArray(), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)

    private fun home() { shell("input keyevent KEYCODE_HOME"); Thread.sleep(1_500) }

    private fun assertDuration(iv: JSONObject, expectedMs: Long, tolerance: Long = 4_000) {
        val d = iv.getLong("end_ms") - iv.getLong("start_ms")
        assertTrue("duration $d ms, expected about $expectedMs: $iv", kotlin.math.abs(d - expectedMs) <= tolerance)
    }

    private fun shell(cmd: String): String {
        val pfd: ParcelFileDescriptor = ua.executeShellCommand(cmd)
        return FileInputStream(pfd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { pfd.close() }
    }

    private fun waitFor(what: String, timeoutMs: Long, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return
            Thread.sleep(500)
        }
        throw AssertionError("timed out waiting for $what")
    }

    private fun http(method: String, path: String, body: String?): String {
        val c = URL("http://$HUB$path").openConnection() as HttpURLConnection
        c.requestMethod = method
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        return c.inputStream.use { it.readBytes().toString(Charsets.UTF_8) }.also { c.disconnect() }
    }

    private fun hubState() = JSONObject(http("GET", "/_test/state", null))
    private fun hubConfig(cfg: JSONObject) = http("POST", "/_test/config", cfg.toString())
    private fun hubIntervals(): List<JSONObject> {
        val m = hubState().getJSONObject("intervals")
        return m.keys().asSequence().map { m.getJSONObject(it) }.toList()
    }
}
