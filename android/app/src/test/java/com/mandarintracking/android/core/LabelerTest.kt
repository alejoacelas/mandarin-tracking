package com.mandarintracking.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelerTest {
    private val gpt = "com.openai.chatgpt"
    private val pleco = "com.pleco.chinesesystem"
    private val min = 60_000L
    private val t0 = 1_762_000_000_000L
    private fun session(pkg: String = gpt, mins: Long = 10) = Session(pkg, t0, t0 + mins * min, EndReason.PAUSED)
    private fun zh(t: Long, units: Int = 100) = TextSample(gpt, t0 + t, (units * 0.9).toInt(), units)
    private fun en(t: Long, units: Int = 100) = TextSample(gpt, t0 + t, 0, units)

    @Test fun plecoIsAlwaysZh() {
        val segs = Labeler.segments(session(pleco), LanguageRule.ALWAYS_ZH, emptyList())
        assertEquals("zh", segs.single().language)
        assertEquals(LanguageReason.ALWAYS_ZH, segs.single().reason)
        assertNull(segs.single().share)
    }

    @Test fun noSamplesIsUnknown() {
        val s = Labeler.segments(session(), LanguageRule.SAMPLED, emptyList()).single()
        assertEquals("unknown", s.language)
        assertEquals(LanguageReason.NO_SAMPLES, s.reason)
    }

    @Test fun samplesOfOtherAppsOrTimesDontCount() {
        val samples = listOf(TextSample("com.anthropic.claude", t0 + min, 90, 100), zh(-min), zh(11 * min))
        assertEquals("unknown", Labeler.segments(session(), LanguageRule.SAMPLED, samples).single().language)
    }

    @Test fun tooLittleTextIsUnknownButPooledTextCanDecide() {
        val few = listOf(TextSample(gpt, t0 + min, 5, 5))
        val s = Labeler.segments(session(), LanguageRule.SAMPLED, few).single()
        assertEquals("unknown", s.language)
        assertEquals(LanguageReason.TOO_LITTLE_TEXT, s.reason)
        assertEquals(1.0, s.share!!.share, 0.0)

        val pooled = (1..5).map { TextSample(gpt, t0 + it * min, 5, 5) } // 25 units together
        assertEquals("zh", Labeler.segments(session(), LanguageRule.SAMPLED, pooled).single().language)
    }

    @Test fun allChineseSession() {
        val s = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(zh(10_000), zh(min), zh(2 * min))).single()
        assertEquals("zh", s.language)
        assertEquals(t0, s.startMs) // extends back to the session start
        assertEquals(300, s.share!!.units)
        assertEquals(3, s.samples)
    }

    @Test fun englishSession() {
        assertEquals("other", Labeler.segments(session(), LanguageRule.SAMPLED, listOf(en(min), en(2 * min))).single().language)
    }

    @Test fun languageChangeSplitsAtFirstSampleOfNewLanguage() {
        val segs = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(en(min), en(2 * min), zh(4 * min), zh(5 * min), zh(6 * min)))
        assertEquals(listOf("other", "zh"), segs.map { it.language })
        assertEquals(t0 + 4 * min, segs[0].endMs)
        assertEquals(t0 + 4 * min, segs[1].startMs)
        assertEquals(t0 + 10 * min, segs[1].endMs)
    }

    @Test fun singleOddSampleDoesNotSplit() {
        val segs = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(zh(min), en(2 * min), zh(3 * min), zh(4 * min)))
        assertEquals(listOf("zh"), segs.map { it.language })
    }

    @Test fun trailingUnconfirmedSampleDoesNotSplit() {
        val segs = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(zh(min), zh(2 * min), en(9 * min)))
        assertEquals(1, segs.size)
    }

    @Test fun sampleAfterSessionEndCannotStartSegment() {
        val segs = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(zh(min), en(10 * min + 500), en(10 * min + 1500)))
        assertEquals(1, segs.size)
        assertEquals(t0 + 10 * min, segs[0].endMs)
    }

    @Test fun addingLaterSamplesKeepsEarlierBoundaries() {
        val all = listOf(en(min), zh(2 * min), zh(3 * min), en(5 * min), zh(6 * min), en(7 * min), en(8 * min))
        var previous: List<Long> = emptyList()
        for (n in 1..all.size) {
            val starts = Labeler.segments(session(), LanguageRule.SAMPLED, all.take(n)).map { it.startMs }
            assertTrue("prefix $n: $previous -> $starts", starts.containsAll(previous))
            previous = starts
        }
        assertEquals(listOf(t0, t0 + 2 * min, t0 + 7 * min), previous)
    }

    @Test fun inconclusiveSamplesAddToShareButNotToBoundaries() {
        val segs = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(zh(min), TextSample(gpt, t0 + 2 * min, 0, 10), TextSample(gpt, t0 + 3 * min, 0, 10)))
        assertEquals("zh", segs.single().language)
        assertEquals(120, segs.single().share!!.units)
    }

    @Test fun zeroUnitSamplesCountAsSeenButNotAsText() {
        val s = Labeler.segments(session(), LanguageRule.SAMPLED, listOf(TextSample(gpt, t0 + min, 0, 0))).single()
        assertEquals("unknown", s.language)
        assertEquals(LanguageReason.TOO_LITTLE_TEXT, s.reason)
        assertNull(s.share)
        assertEquals(1, s.samples)
    }
}
