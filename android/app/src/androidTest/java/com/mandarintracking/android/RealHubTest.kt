package com.mandarintracking.android

import android.app.UiAutomation
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.mandarintracking.android.core.SyncOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream

/**
 * Pairs with the real Go hub (hub/ on main) and sends real intervals to it. Skipped unless run
 * by e2e/real-hub.sh, which starts the hub and passes its address and pairing code.
 */
@RunWith(AndroidJUnit4::class)
class RealHubTest {
    private val args = InstrumentationRegistry.getArguments()
    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun pairsAndSendsToRealHub() {
        val hub = args.getString("realHub")
        val code = args.getString("realHubCode")
        assumeTrue("realHub not given", hub != null && code != null)
        val ua = InstrumentationRegistry.getInstrumentation().getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        fun shell(c: String) = ua.executeShellCommand(c).let { pfd: ParcelFileDescriptor -> FileInputStream(pfd.fileDescriptor).use { it.readBytes() }; pfd.close() }
        val pkg = ctx.packageName
        shell("appops set $pkg GET_USAGE_STATS allow")
        shell("cmd notification allow_listener $pkg/$pkg.MediaListenerService")
        shell("input keyevent KEYCODE_WAKEUP")
        shell("wm dismiss-keyguard")
        val deadline = System.currentTimeMillis() + 30_000
        while (!MediaListenerService.connected && System.currentTimeMillis() < deadline) Thread.sleep(500)
        assertTrue("media listener connected", MediaListenerService.connected)

        val prefs = Prefs(ctx)
        prefs.token = null
        prefs.manualHub = hub
        prefs.usageCursor = System.currentTimeMillis()
        assertTrue(Pairing.pair(ctx, code!!) is Pairing.Outcome.Paired)

        shell("am start -W -n com.pleco.chinesesystem/com.mandarintracking.simulators.ContentActivity --es lang zh")
        Thread.sleep(20_000)
        shell("input keyevent KEYCODE_HOME")
        val title = android.util.Base64.encodeToString("老高與小茉 测试视频".toByteArray(), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
        val artist = android.util.Base64.encodeToString("老高與小茉 Mr & Mrs Gao".toByteArray(), android.util.Base64.NO_WRAP or android.util.Base64.URL_SAFE)
        shell("am start -n com.google.android.youtube/com.mandarintracking.simulators.PlayerActivity --es cmd play --es title_b64 $title --es artist_b64 $artist")
        Thread.sleep(20_000)
        shell("am start -n com.google.android.youtube/com.mandarintracking.simulators.PlayerActivity --es cmd release")
        Thread.sleep(2_000)

        val report = Collector.runAll(ctx)
        assertEquals(SyncOutcome.OK, report?.outcome)
        assertTrue(report!!.rejected.isEmpty())
        assertEquals(0, Store.get(ctx).unsentCount())
        // Background work may have sent some of it already; ask the hub what it counted today.
        val summary = HttpTransport(hub!!, prefs.token).request("GET", "/api/v1/summary?days=1", null)
        android.util.Log.i("E2E", "real hub summary: ${summary.body}")
        val today = org.json.JSONObject(summary.body!!).getJSONArray("days").let { it.getJSONObject(it.length() - 1) }
        val bySource = today.getJSONObject("by_source")
        assertTrue("pleco minutes: $today", bySource.optDouble("pleco", 0.0) >= 0.25)
        // The hub hasn't classified this made-up channel, so its time is listed but not in by_source.
        val items = today.getJSONArray("items")
        val yt = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.getString("source") == "youtube" }
        assertTrue("youtube item: $today", yt != null && yt.getDouble("min") >= 0.25 && yt.getString("name").startsWith("老高與小茉"))
    }
}
