package com.mandarintracking.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class SessionBuilderTest {
    private val pleco = "com.pleco.chinesesystem"
    private val gpt = "com.openai.chatgpt"
    private val launcher = "com.android.launcher3"
    private val builder = SessionBuilder({ TrackedApps.get(it) != null })
    private val sec = 1000L
    private val min = 60_000L
    private val t0 = 1_762_000_000_000L

    private fun ev(t: Long, pkg: String, kind: EventKind, cls: String? = "Main") = UsageEvent(t0 + t, pkg, cls, kind)
    private fun build(vararg e: UsageEvent, now: Long = 10 * 60 * min) = builder.build(e.toList(), t0 + now)

    @Test fun simpleSession() {
        val s = build(ev(0, pleco, EventKind.RESUMED), ev(5 * min, pleco, EventKind.PAUSED), ev(5 * min + 10, pleco, EventKind.STOPPED))
        assertEquals(listOf(Session(pleco, t0, t0 + 5 * min, EndReason.PAUSED)), s)
    }

    @Test fun untrackedAppsAreIgnored() {
        val s = build(ev(0, launcher, EventKind.RESUMED), ev(5 * min, launcher, EventKind.PAUSED))
        assertTrue(s.isEmpty())
    }

    @Test fun missingPausedIsClosedByNextAppResuming() {
        val s = build(ev(0, pleco, EventKind.RESUMED), ev(3 * min, launcher, EventKind.RESUMED))
        assertEquals(listOf(Session(pleco, t0, t0 + 3 * min, EndReason.OTHER_APP)), s)
    }

    @Test fun overlappingActivitiesOfSameAppAreOneSession() {
        val s = build(
            ev(0, gpt, EventKind.RESUMED, "A"),
            ev(1 * min, gpt, EventKind.RESUMED, "B"), // multi-resume / transparent activity
            ev(2 * min, gpt, EventKind.PAUSED, "A"),
            ev(4 * min, gpt, EventKind.PAUSED, "B"),
        )
        assertEquals(listOf(Session(gpt, t0, t0 + 4 * min, EndReason.PAUSED)), s)
    }

    @Test fun activitySwitchInsideAppIsBridged() {
        val s = build(
            ev(0, gpt, EventKind.RESUMED, "A"),
            ev(2 * min, gpt, EventKind.PAUSED, "A"),
            ev(2 * min + 300, gpt, EventKind.RESUMED, "B"),
            ev(6 * min, gpt, EventKind.PAUSED, "B"),
        )
        assertEquals(listOf(Session(gpt, t0, t0 + 6 * min, EndReason.PAUSED)), s)
    }

    @Test fun longerGapStartsNewSession() {
        val s = build(
            ev(0, gpt, EventKind.RESUMED), ev(2 * min, gpt, EventKind.PAUSED),
            ev(2 * min + 30 * sec, gpt, EventKind.RESUMED), ev(4 * min, gpt, EventKind.PAUSED),
        )
        assertEquals(2, s.size)
        assertEquals(t0 + 2 * min + 30 * sec, s[1].startMs)
    }

    @Test fun gapWithAnotherTrackedAppIsNotBridged() {
        val s = build(
            ev(0, gpt, EventKind.RESUMED), ev(60 * sec, gpt, EventKind.PAUSED),
            ev(61 * sec, pleco, EventKind.RESUMED), ev(65 * sec, pleco, EventKind.PAUSED),
            ev(66 * sec, gpt, EventKind.RESUMED), ev(120 * sec, gpt, EventKind.PAUSED),
        )
        assertEquals(listOf(gpt, pleco, gpt), s.map { it.pkg })
    }

    @Test fun screenOffMidSessionEndsIt() {
        val s = build(
            ev(0, pleco, EventKind.RESUMED),
            ev(4 * min, "android", EventKind.SCREEN_OFF),
            ev(4 * min + 500, pleco, EventKind.PAUSED), // arrives after screen off
            ev(20 * min, pleco, EventKind.RESUMED), // unlocked again, app still on top
            ev(25 * min, pleco, EventKind.PAUSED),
        )
        assertEquals(
            listOf(Session(pleco, t0, t0 + 4 * min, EndReason.SCREEN_OFF), Session(pleco, t0 + 20 * min, t0 + 25 * min, EndReason.PAUSED)),
            s,
        )
    }

    @Test fun keyguardAndShutdownEndSessions() {
        val a = build(ev(0, pleco, EventKind.RESUMED), ev(min, "android", EventKind.KEYGUARD_SHOWN))
        assertEquals(EndReason.KEYGUARD, a.single().endReason)
        val b = build(ev(0, pleco, EventKind.RESUMED), ev(min, "android", EventKind.SHUTDOWN))
        assertEquals(Session(pleco, t0, t0 + min, EndReason.SHUTDOWN), b.single())
    }

    @Test fun rebootWithoutShutdownEndsAtLastEventBeforeIt() {
        val s = build(
            ev(0, pleco, EventKind.RESUMED),
            ev(2 * min, launcher, EventKind.OTHER), // last sign of life
            ev(90 * min, "android", EventKind.STARTUP),
        )
        assertEquals(Session(pleco, t0, t0 + 2 * min, EndReason.REBOOT), s.single())
    }

    @Test fun runningSessionEndsAtNow() {
        val s = build(ev(0, gpt, EventKind.RESUMED), now = 7 * min)
        assertEquals(Session(gpt, t0, t0 + 7 * min, EndReason.RUNNING), s.single())
        assertTrue(s.single().running)
    }

    @Test fun pausedWithoutResumeIsIgnored() {
        // The read window starts after the session began (e.g. events older than retention).
        val s = build(ev(0, pleco, EventKind.PAUSED), ev(10, pleco, EventKind.STOPPED), ev(min, gpt, EventKind.RESUMED), ev(2 * min, gpt, EventKind.PAUSED))
        assertEquals(listOf(gpt), s.map { it.pkg })
    }

    @Test fun tinySessionsAreDropped() {
        val s = build(ev(0, pleco, EventKind.RESUMED), ev(400, pleco, EventKind.PAUSED))
        assertTrue(s.isEmpty())
    }

    @Test fun nullClassNamesOnOldAndroid() {
        val s = build(ev(0, pleco, EventKind.RESUMED, null), ev(min, pleco, EventKind.PAUSED, null))
        assertEquals(1, s.size)
    }

    @Test fun unsortedInputIsSorted() {
        val s = builder.build(listOf(ev(min, pleco, EventKind.PAUSED), ev(0, pleco, EventKind.RESUMED)), t0 + 10 * min)
        assertEquals(Session(pleco, t0, t0 + min, EndReason.PAUSED), s.single())
    }

    @Test fun duplicateReadsGiveIdenticalSessions() {
        val events = listOf(ev(0, pleco, EventKind.RESUMED), ev(3 * min, pleco, EventKind.PAUSED), ev(4 * min, gpt, EventKind.RESUMED))
        val a = builder.build(events, t0 + 5 * min)
        val b = builder.build(events + events, t0 + 5 * min) // events delivered twice
        assertEquals(a, b)
    }

    @Test fun sessionAcrossMidnightAndDstIsContinuous() {
        // 2026-03-29 in Europe/Madrid: clocks jump from 02:00 to 03:00. Session 01:30 -> 03:30 local = 1 h real time.
        val zone = ZoneId.of("Europe/Madrid")
        val start = ZonedDateTime.of(2026, 3, 29, 1, 30, 0, 0, zone).toInstant().toEpochMilli()
        val end = ZonedDateTime.of(2026, 3, 29, 3, 30, 0, 0, zone).toInstant().toEpochMilli()
        val s = builder.build(listOf(UsageEvent(start, pleco, "M", EventKind.RESUMED), UsageEvent(end, pleco, "M", EventKind.PAUSED)), end + min)
        assertEquals(60 * min, s.single().endMs - s.single().startMs)
        // Across midnight: one session, the hub splits by day.
        val m0 = ZonedDateTime.of(2026, 11, 10, 23, 50, 0, 0, zone).toInstant().toEpochMilli()
        val s2 = builder.build(listOf(UsageEvent(m0, pleco, "M", EventKind.RESUMED), UsageEvent(m0 + 20 * min, pleco, "M", EventKind.PAUSED)), m0 + 30 * min)
        assertEquals(1, s2.size)
    }

    // ---- cursor ----

    @Test fun cursorStaysAtStartOfRunningSession() {
        val s = build(ev(0, gpt, EventKind.RESUMED), now = 50 * min)
        assertEquals(t0, SessionBuilder.nextCursor(s, t0 - 5 * min, t0 + 50 * min))
    }

    @Test fun cursorKeepsMarginForLateEvents() {
        val s = build(ev(0, gpt, EventKind.RESUMED), ev(min, gpt, EventKind.PAUSED), now = 50 * min)
        assertEquals(t0 + 40 * min, SessionBuilder.nextCursor(s, t0 - 5 * min, t0 + 50 * min))
    }

    @Test fun cursorDoesNotLandInsideSessionNearMargin() {
        // Session ends just after the margin floor: the cursor must go back to its start.
        val s = build(ev(30 * min, gpt, EventKind.RESUMED), ev(41 * min, gpt, EventKind.PAUSED), now = 50 * min)
        assertEquals(t0 + 30 * min, SessionBuilder.nextCursor(s, t0, t0 + 50 * min))
    }

    @Test fun cursorDoesNotLandInBridgeableGap() {
        // Session ends 5 s before the floor; a resume 5 s after the floor would join it.
        val floor = 40 * min
        val s = build(ev(30 * min, gpt, EventKind.RESUMED), ev(floor - 5 * sec, gpt, EventKind.PAUSED), now = 50 * min)
        assertEquals(t0 + 30 * min, SessionBuilder.nextCursor(s, t0, t0 + 50 * min))
    }

    @Test fun cursorNeverMovesBack() {
        val s = build(ev(0, gpt, EventKind.RESUMED), ev(min, gpt, EventKind.PAUSED), now = 3 * min)
        assertEquals(t0 + 2 * min, SessionBuilder.nextCursor(s, t0 + 2 * min, t0 + 3 * min))
    }

    /**
     * Reading in many overlapping windows, each starting at the previous cursor, gives the same
     * intervals (by id and content) as one read of everything.
     */
    @Test fun incrementalReadsMatchOneBigRead() {
        val events = ArrayList<UsageEvent>()
        var t = 0L
        val rnd = java.util.Random(42)
        val pkgs = listOf(pleco, gpt, launcher, "com.readermobile")
        repeat(400) {
            val p = pkgs[rnd.nextInt(pkgs.size)]
            events += ev(t, p, EventKind.RESUMED, "A")
            t += (rnd.nextInt(600) * sec)
            when (rnd.nextInt(6)) {
                0 -> events += ev(t, "android", EventKind.SCREEN_OFF)
                1 -> {} // missing PAUSED
                else -> events += ev(t, p, EventKind.PAUSED, "A")
            }
            t += if (rnd.nextBoolean()) rnd.nextInt(8) * sec else rnd.nextInt(300) * sec
        }
        events += ev(t, "android", EventKind.SCREEN_OFF)
        val end = t + 5 * min
        val whole = UsageIntervals.build(builder.build(events, t0 + end), emptyList())
            .associateBy { it.id }

        val seen = HashMap<String, Interval>()
        var cursor = t0 - min
        var now = t0
        while (now < t0 + end) {
            now += (5 + rnd.nextInt(20)) * min
            val window = events.filter { it.timeMs in cursor..now }
            val sessions = builder.build(window, now)
            UsageIntervals.build(sessions, emptyList()).forEach { seen[it.id] = it }
            cursor = SessionBuilder.nextCursor(sessions, cursor, now)
        }
        val finalNow = t0 + end + 60 * min
        val tail = builder.build(events.filter { it.timeMs >= cursor }, finalNow)
        UsageIntervals.build(tail, emptyList()).forEach { seen[it.id] = it }

        assertTrue("generated ${whole.size} intervals", whole.size > 100)
        assertEquals(whole.keys, seen.keys)
        for ((id, iv) in whole) {
            assertEquals("end of $id", iv.endMs, seen.getValue(id).endMs)
        }
    }
}
