package com.mandarintracking.android.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** In-memory outbox with the same rules as the SQLite one (rev / sent_rev / rejection pause). */
class FakeOutbox(private val retryRejectedAfterMs: Long = 6 * 3600_000L) : Outbox {
    data class Row(var json: String, var rev: Long, var sentRev: Long = 0, var rejectedRev: Long = 0, var rejectedAt: Long = 0, var reason: String? = null)
    val rows = LinkedHashMap<String, Row>()

    fun upsert(iv: Interval) {
        val json = iv.toJson().toString()
        val r = rows[iv.id]
        if (r == null) rows[iv.id] = Row(json, 1) else if (r.json != json) { r.json = json; r.rev++ }
    }

    override fun pending(limit: Int, nowMs: Long) = rows.filter { (_, r) ->
        r.rev > r.sentRev && (r.rejectedRev < r.rev || nowMs - r.rejectedAt >= retryRejectedAfterMs)
    }.entries.take(limit).map { PendingInterval(it.key, it.value.rev, it.value.json) }

    override fun markSent(id: String, rev: Long) { rows[id]?.let { if (rev > it.sentRev) it.sentRev = rev; it.reason = null } }
    override fun markRejected(id: String, rev: Long, reason: String, nowMs: Long) {
        rows[id]?.let { it.rejectedRev = rev; it.rejectedAt = nowMs; it.reason = reason }
    }
}

class FakeProblems : ProblemQueue {
    val rows = LinkedHashMap<String, Pair<String?, Long>>() // component -> (message, rev)
    val sent = HashMap<String, Long>()
    fun set(c: String, m: String?) { val r = rows[c]; if (r?.first != m || r == null) rows[c] = m to ((r?.second ?: 0) + 1) }
    override fun pendingProblems() = rows.filter { (c, v) -> v.second > (sent[c] ?: 0) }.map { (c, v) -> PendingProblem(c, v.first, v.second) }
    override fun markProblemSent(component: String, rev: Long) { sent[component] = rev }
}

/** A hub that stores intervals by id like the real one and can be told to fail. */
class FakeHub : HubTransport {
    val stored = HashMap<String, JSONObject>()
    val calls = ArrayList<Pair<String, JSONObject>>()
    var mode = "ok" // ok | down | 401 | 500
    var reject: (JSONObject) -> String? = { null }
    var dateMs: Long? = null

    override fun post(path: String, body: String): HttpResult {
        val j = JSONObject(body)
        calls += path to j
        when (mode) {
            "down" -> return HttpResult(-1, null, error = "connect timed out")
            "401" -> return HttpResult(401, """{"error":"unknown token; pair again"}""")
            "500" -> return HttpResult(500, "boom")
        }
        if (path != "intervals") return HttpResult(200, """{"ok":true}""", dateMs)
        val arr = j.getJSONArray("intervals")
        assertTrue("batch too big", arr.length() <= 500)
        val rejected = JSONArray()
        var accepted = 0
        for (i in 0 until arr.length()) {
            val iv = arr.getJSONObject(i)
            val why = reject(iv)
            if (why != null) rejected.put(JSONObject().put("id", iv.getString("id")).put("reason", why))
            else { stored[iv.getString("id")] = iv; accepted++ }
        }
        return HttpResult(200, JSONObject().put("accepted", accepted).put("rejected", rejected).toString(), dateMs)
    }
}

class SyncEngineTest {
    private val t0 = 1_762_000_000_000L
    private var now = t0
    private val outbox = FakeOutbox()
    private val problems = FakeProblems()
    private val hub = FakeHub()
    private val engine = SyncEngine(outbox, problems, hub) { now }
    private val hb = JSONObject().put("version", "1.0.0")

    private fun iv(n: Int, end: Long = 60_000) = Interval("u:com.pleco.chinesesystem:${t0 + n * 100_000L}", Source.PLECO,
        t0 + n * 100_000L, t0 + n * 100_000L + end, "zh", null, null, "com.pleco.chinesesystem")

    @Test fun sendsEverythingThenProblemsThenHeartbeat() {
        repeat(3) { outbox.upsert(iv(it)) }
        problems.set("android.usage", "Usage access was turned off.")
        val r = engine.run(hb)
        assertEquals(SyncOutcome.OK, r.outcome)
        assertEquals(3, r.sent)
        assertEquals(listOf("intervals", "problems", "heartbeat"), hub.calls.map { it.first })
        assertEquals(3, hub.stored.size)
        assertTrue(outbox.pending(500, now).isEmpty())
        assertTrue(problems.pendingProblems().isEmpty())
    }

    @Test fun batchesOf500() {
        repeat(1234) { outbox.upsert(iv(it)) }
        val r = engine.run(hb)
        assertEquals(1234, r.sent)
        assertEquals(listOf(500, 500, 234), hub.calls.filter { it.first == "intervals" }.map { it.second.getJSONArray("intervals").length() })
    }

    @Test fun unreachableKeepsEverythingQueued() {
        repeat(3) { outbox.upsert(iv(it)) }
        hub.mode = "down"
        val r = engine.run(hb)
        assertEquals(SyncOutcome.UNREACHABLE, r.outcome)
        assertEquals(3, outbox.pending(500, now).size)
        hub.mode = "ok"
        assertEquals(3, engine.run(hb).sent)
    }

    @Test fun unauthorizedStopsAndKeepsQueue() {
        outbox.upsert(iv(0))
        hub.mode = "401"
        assertEquals(SyncOutcome.UNAUTHORIZED, engine.run(hb).outcome)
        assertEquals(1, outbox.pending(500, now).size)
    }

    @Test fun serverErrorKeepsQueue() {
        outbox.upsert(iv(0))
        hub.mode = "500"
        assertEquals(SyncOutcome.HUB_ERROR, engine.run(hb).outcome)
        assertEquals(1, outbox.pending(500, now).size)
    }

    @Test fun partialRejectionMarksOnlyRejected() {
        repeat(4) { outbox.upsert(iv(it)) }
        hub.reject = { if (it.getLong("start_ms") == t0 + 200_000L) "end_ms is more than 5 minutes in the future" else null }
        val r = engine.run(hb)
        assertEquals(3, r.sent)
        assertEquals(1, r.rejected.size)
        assertEquals("end_ms is more than 5 minutes in the future", r.rejected[0].second)
        // Not retried right away...
        assertTrue(outbox.pending(500, now).isEmpty())
        // ...but retried after the pause, and accepted once the hub agrees.
        now += 6 * 3600_000L
        hub.reject = { null }
        assertEquals(1, engine.run(hb).sent)
        assertEquals(4, hub.stored.size)
    }

    @Test fun rejectedIntervalIsRetriedAtOnceWhenItChanges() {
        outbox.upsert(iv(0))
        hub.reject = { "bad" }
        engine.run(hb)
        hub.reject = { null }
        outbox.upsert(iv(0, end = 90_000)) // the session grew
        assertEquals(1, engine.run(hb).sent)
    }

    @Test fun growingIntervalIsResentAndReplacedOnHub() {
        outbox.upsert(iv(0, end = 10_000))
        engine.run(hb)
        outbox.upsert(iv(0, end = 50_000))
        engine.run(hb)
        assertEquals(1, hub.stored.size)
        assertEquals(t0 + 50_000, hub.stored.values.single().getLong("end_ms"))
    }

    @Test fun unchangedIntervalIsNotResent() {
        outbox.upsert(iv(0))
        engine.run(hb)
        outbox.upsert(iv(0))
        engine.run(hb)
        assertEquals(1, hub.calls.count { it.first == "intervals" })
    }

    @Test fun duplicateDeliveryIsHarmless() {
        repeat(3) { outbox.upsert(iv(it)) }
        val body = JSONObject().put("intervals", JSONArray().also { a -> outbox.pending(500, now).forEach { a.put(JSONObject(it.json)) } })
        hub.post("intervals", body.toString())
        hub.post("intervals", body.toString())
        assertEquals(3, hub.stored.size)
    }

    @Test fun unreadableReplyIsHubError() {
        outbox.upsert(iv(0))
        val bad = SyncEngine(outbox, problems, { _, _ -> HttpResult(200, "<html>captive portal</html>") }) { now }
        assertEquals(SyncOutcome.HUB_ERROR, bad.run(hb).outcome)
        assertEquals(1, outbox.pending(500, now).size)
    }

    @Test fun resolvedProblemIsSentAsResolved() {
        problems.set("android.usage", "off")
        engine.run(hb)
        problems.set("android.usage", null)
        engine.run(hb)
        val last = hub.calls.last { it.first == "problems" }.second
        assertEquals(true, last.getBoolean("resolved"))
        assertTrue(!last.has("message"))
    }

    @Test fun reportsServerDate() {
        hub.dateMs = t0 + 123
        assertEquals(t0 + 123, engine.run(hb).serverDateMs)
    }
}
