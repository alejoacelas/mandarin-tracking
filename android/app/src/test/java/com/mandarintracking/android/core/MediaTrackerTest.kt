package com.mandarintracking.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MediaTrackerTest {
    private val yt = TrackedApps.YOUTUBE
    private val t0 = 1_762_000_000_000L
    private val sec = 1000L
    private val min = 60_000L

    private var wall = t0
    private var elapsed = 5_000_000L
    private val clock = object : Clock {
        override fun wallMs() = wall
        override fun elapsedMs() = elapsed
    }
    /** Latest version of each interval by id, plus whether it is still open. */
    private val out = LinkedHashMap<String, Pair<Interval, Boolean>>()
    private val tracker = MediaTracker(clock, { iv, open -> out[iv.id] = iv to open })

    private fun advance(ms: Long) { wall += ms; elapsed += ms }
    private val video = MediaInfo("【中文】老高與小茉 第一集", "老高與小茉 Mr & Mrs Gao", durationMs = 600_000)
    private val video2 = MediaInfo("How to learn Chinese fast", "Some Channel")
    private fun intervals() = out.values.map { it.first }

    private fun play(key: String = "s1", info: MediaInfo = video) {
        tracker.onMetadata(key, yt, "app", info)
        tracker.onPlaybackState(key, yt, "app", PlayState.PLAYING)
    }

    @Test fun playThenPause() {
        play()
        advance(3 * min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val iv = intervals().single()
        assertEquals(t0, iv.startMs)
        assertEquals(t0 + 3 * min, iv.endMs)
        assertEquals(Source.YOUTUBE, iv.source)
        assertEquals("unknown", iv.language)
        assertEquals(video.title, iv.title)
        assertEquals("老高與小茉 Mr & Mrs Gao", iv.channelName)
        assertEquals("paused", iv.meta["end"])
        assertTrue(iv.zhShare!! > 0.5)
        assertFalse(out.values.single().second)
    }

    @Test fun metadataBeforeOrAfterStateBothWork() {
        tracker.onPlaybackState("s1", yt, "app", PlayState.PLAYING)
        assertTrue(out.isEmpty()) // nothing known yet
        tracker.onMetadata("s1", yt, "app", video)
        advance(min)
        tracker.tick()
        assertEquals(t0 + min, intervals().single().endMs)
    }

    @Test fun pausedNeverRecords() {
        tracker.onMetadata("s1", yt, "app", video)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        advance(10 * min)
        tracker.tick()
        assertTrue(out.isEmpty())
    }

    @Test fun tickWritesOpenInterval() {
        play()
        advance(2 * min)
        tracker.tick()
        val (iv, open) = out.values.single()
        assertTrue(open)
        assertEquals(t0 + 2 * min, iv.endMs)
        assertEquals("playing", iv.meta["end"])
    }

    @Test fun newVideoStartsNewInterval() {
        play()
        advance(min)
        tracker.onMetadata("s1", yt, "app", video2)
        advance(2 * min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val ivs = intervals()
        assertEquals(listOf(video.title, video2.title), ivs.map { it.title })
        assertEquals(t0 + min, ivs[0].endMs)
        assertEquals("item_changed", ivs[0].meta["end"])
        assertEquals(t0 + min, ivs[1].startMs)
        assertEquals(t0 + 3 * min, ivs[1].endMs)
    }

    @Test fun repeatedSameMetadataKeepsInterval() {
        play()
        advance(min)
        tracker.onMetadata("s1", yt, "app", video.copy(durationMs = 610_000)) // e.g. artwork/duration update
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        assertEquals(1, out.size)
    }

    @Test fun shortBufferingIsBridged() {
        play()
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.BUFFERING)
        advance(3 * sec)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PLAYING)
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val iv = intervals().single()
        assertEquals(t0 + 2 * min + 3 * sec, iv.endMs)
    }

    @Test fun pauseLongerThanBridgeStartsNewInterval() {
        play()
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        advance(5 * min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PLAYING)
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        assertEquals(2, out.size)
        assertEquals(listOf(t0, t0 + 6 * min), intervals().map { it.startMs })
    }

    @Test fun adsAreNotCounted() {
        tracker.onMetadata("s1", yt, "app", MediaInfo("Ad", null, isAd = true))
        tracker.onPlaybackState("s1", yt, "app", PlayState.PLAYING)
        advance(15 * sec)
        tracker.onMetadata("s1", yt, "app", video) // ad over, video begins
        advance(min)
        tracker.onMetadata("s1", yt, "app", MediaInfo("Ad", null, isAd = true)) // mid-roll
        advance(30 * sec)
        tracker.onMetadata("s1", yt, "app", video)
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val ivs = intervals()
        assertEquals(2, ivs.size)
        assertEquals(listOf(min, min), ivs.map { it.endMs - it.startMs })
        assertTrue(ivs.all { it.title == video.title })
    }

    @Test fun blankTitleIsNotCounted() {
        play(info = MediaInfo("", null))
        advance(min)
        tracker.tick()
        assertTrue(out.isEmpty())
    }

    @Test fun sessionDestroyedWhilePlaying() {
        play()
        advance(min)
        tracker.onSessionGone("s1")
        assertEquals("session_destroyed", intervals().single().meta["end"])
        assertEquals(t0 + min, intervals().single().endMs)
        assertEquals(0, tracker.openCount)
    }

    @Test fun sessionMissingFromActiveListIsGone() {
        play("a")
        play("b", video2)
        advance(min)
        tracker.retainOnly(setOf("b"))
        assertEquals(1, tracker.openCount)
        assertFalse(out.values.first { it.first.title == video.title }.second)
    }

    @Test fun listenerDisconnectClosesAll() {
        play("a")
        play("b", video2)
        advance(min)
        tracker.onDisconnected()
        assertEquals(0, tracker.openCount)
        assertTrue(out.values.all { !it.second && it.first.meta["end"] == "listener_disconnected" })
    }

    @Test fun appKilledWhilePlayingKeepsLastTick() {
        // The process dies between ticks: the last write is what survives.
        play()
        advance(min)
        tracker.tick()
        advance(40 * sec) // killed here, no callback
        val iv = intervals().single()
        assertEquals(t0 + min, iv.endMs)
        assertTrue(out.values.single().second) // still marked open; the service closes it on restart
    }

    @Test fun splitsAt30Minutes() {
        play()
        repeat(80) { advance(min); tracker.tick() }
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val ivs = intervals()
        assertEquals(listOf(30 * min, 30 * min, 20 * min), ivs.map { it.endMs - it.startMs })
        assertEquals(listOf("split_30min", "split_30min", "paused"), ivs.map { it.meta["end"] })
        assertEquals(listOf(t0, t0 + 30 * min, t0 + 60 * min), ivs.map { it.startMs })
    }

    @Test fun longGapBetweenTicksStillSplits() {
        // Doze delays ticks; the next callback splits correctly.
        play()
        advance(65 * min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        assertEquals(listOf(30 * min, 30 * min, 5 * min), intervals().map { it.endMs - it.startMs })
    }

    @Test fun wallClockChangeDuringPlaybackDoesNotStretch() {
        play()
        elapsed += 2 * min
        wall -= 3600_000L // user sets the clock back an hour
        tracker.onPlaybackState("s1", yt, "app", PlayState.PAUSED)
        val iv = intervals().single()
        assertEquals(2 * min, iv.endMs - iv.startMs)
    }

    @Test fun idsAreUniquePerStart() {
        play()
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.STOPPED)
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.PLAYING)
        advance(min)
        tracker.onPlaybackState("s1", yt, "app", PlayState.ERROR)
        assertEquals(2, out.keys.size)
        assertTrue(out.keys.all { it.startsWith("m:$yt:") })
        assertEquals(listOf("stopped", "error"), intervals().map { it.meta["end"] })
    }
}
