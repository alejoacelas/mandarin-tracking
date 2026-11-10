package com.mandarintracking.android.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class UsageIntervalsTest {
    private val gpt = "com.openai.chatgpt"
    private val pleco = "com.pleco.chinesesystem"
    private val min = 60_000L
    private val t0 = 1_762_000_000_000L

    @Test fun splitsAt30Minutes() {
        val iv = UsageIntervals.build(listOf(Session(pleco, t0, t0 + 75 * min, EndReason.PAUSED)), emptyList())
        assertEquals(listOf(0L, 30L, 60L), iv.map { (it.startMs - t0) / min })
        assertEquals(listOf(30L, 60L, 75L), iv.map { (it.endMs - t0) / min })
        assertEquals(listOf("split_30min", "split_30min", "paused"), iv.map { it.meta["end"] })
        assertTrue(iv.all { it.source == Source.PLECO && it.language == "zh" && it.app == pleco })
        assertEquals(3, iv.map { it.id }.toSet().size)
    }

    @Test fun idsDependOnlyOnStart() {
        val a = UsageIntervals.build(listOf(Session(gpt, t0, t0 + 5 * min, EndReason.RUNNING)), emptyList())
        val b = UsageIntervals.build(listOf(Session(gpt, t0, t0 + 40 * min, EndReason.PAUSED)), emptyList())
        assertEquals(a[0].id, b[0].id)
        assertEquals("u:com.openai.chatgpt:$t0", a[0].id)
    }

    @Test fun languageSegmentsBecomeIntervals() {
        val samples = listOf(
            TextSample(gpt, t0 + min, 0, 100), TextSample(gpt, t0 + 2 * min, 0, 100),
            TextSample(gpt, t0 + 3 * min, 90, 100), TextSample(gpt, t0 + 4 * min, 90, 100),
        )
        val iv = UsageIntervals.build(listOf(Session(gpt, t0, t0 + 5 * min, EndReason.PAUSED)), samples)
        assertEquals(listOf("other", "zh"), iv.map { it.language })
        assertEquals("language_changed", iv[0].meta["end"])
        assertEquals(0.9, iv[1].zhShare!!, 1e-9)
        assertEquals(200, iv[1].units)
        assertEquals(Source.LLM, iv[0].source)
    }

    @Test fun untrackedPackageIsSkipped() {
        assertTrue(UsageIntervals.build(listOf(Session("com.example", t0, t0 + min, EndReason.PAUSED)), emptyList()).isEmpty())
    }

    @Test fun jsonMatchesProtocol() {
        val iv = UsageIntervals.build(listOf(Session(gpt, t0, t0 + min, EndReason.PAUSED)), emptyList(), mapOf("tz" to "Asia/Shanghai")).single()
        val j = JSONObject(iv.toJson().toString())
        assertEquals("llm", j.getString("source"))
        assertEquals(t0, j.getLong("start_ms"))
        assertEquals(t0 + min, j.getLong("end_ms"))
        assertEquals("unknown", j.getString("language"))
        assertTrue(j.isNull("zh_share"))
        assertEquals(gpt, j.getString("app"))
        assertEquals("Asia/Shanghai", j.getJSONObject("meta").getString("tz"))
        assertEquals("no_samples", j.getJSONObject("meta").getString("language_reason"))
        assertTrue(j.getJSONObject("meta").toString().length < 4096)
    }

    @Test fun chunksHelper() {
        assertEquals(emptyList<Pair<Long, Long>>(), chunks(5, 5))
        assertEquals(listOf(0L to 30 * min), chunks(0, 30 * min))
        assertEquals(listOf(0L to 30 * min, 30 * min to 30 * min + 1), chunks(0, 30 * min + 1))
    }
}
