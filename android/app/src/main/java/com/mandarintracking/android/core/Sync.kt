package com.mandarintracking.android.core

import org.json.JSONArray
import org.json.JSONObject

/** An HTTP answer from the hub. [code] is -1 when the hub could not be reached. */
data class HttpResult(val code: Int, val body: String?, val serverDateMs: Long? = null, val error: String? = null)

fun interface HubTransport {
    /** POSTs [body] to `/api/v1/<path>` with the bearer token. Must not throw. */
    fun post(path: String, body: String): HttpResult
}

data class PendingInterval(val id: String, val rev: Long, val json: String)

interface Outbox {
    /** Intervals not yet accepted in their current version, oldest first. Rejected ones only after a pause. */
    fun pending(limit: Int, nowMs: Long): List<PendingInterval>
    /** The hub accepted [rev] of [id]. A newer local version stays pending. */
    fun markSent(id: String, rev: Long)
    fun markRejected(id: String, rev: Long, reason: String, nowMs: Long)
}

data class PendingProblem(val component: String, val message: String?, val rev: Long) {
    val resolved: Boolean get() = message == null
}

interface ProblemQueue {
    fun pendingProblems(): List<PendingProblem>
    fun markProblemSent(component: String, rev: Long)
}

enum class SyncOutcome { OK, UNAUTHORIZED, UNREACHABLE, HUB_ERROR }

data class SyncReport(
    val outcome: SyncOutcome,
    val sent: Int = 0,
    val rejected: List<Pair<String, String>> = emptyList(),
    val detail: String? = null,
    val serverDateMs: Long? = null,
)

/**
 * Sends everything that is waiting to the hub: intervals in batches of at most 500,
 * then problem changes, then a heartbeat. Stops at the first failure and leaves the rest queued.
 */
class SyncEngine(
    private val outbox: Outbox,
    private val problems: ProblemQueue,
    private val transport: HubTransport,
    private val now: () -> Long,
) {
    fun run(heartbeat: JSONObject): SyncReport {
        val first = pushIntervals()
        if (first.outcome != SyncOutcome.OK) return first
        val p = pushProblems()
        if (p != null) return p.copy(sent = first.sent, rejected = first.rejected)
        val hb = transport.post("heartbeat", heartbeat.toString())
        failure(hb)?.let { return it.copy(sent = first.sent, rejected = first.rejected) }
        return first.copy(serverDateMs = hb.serverDateMs ?: first.serverDateMs)
    }

    fun pushIntervals(): SyncReport {
        var sent = 0
        val rejected = ArrayList<Pair<String, String>>()
        var date: Long? = null
        // Each batch marks every row it carried, so this loop always makes progress.
        while (true) {
            val batch = outbox.pending(BATCH, now())
            if (batch.isEmpty()) break
            val body = JSONObject().put("intervals", JSONArray().also { a -> batch.forEach { a.put(JSONObject(it.json)) } })
            val res = transport.post("intervals", body.toString())
            failure(res)?.let { return it.copy(sent = sent, rejected = rejected) }
            date = res.serverDateMs ?: date
            val rej = parseRejected(res.body)
                ?: return SyncReport(SyncOutcome.HUB_ERROR, sent, rejected, "Unreadable reply to intervals: ${res.body?.take(200)}")
            for (row in batch) {
                val reason = rej[row.id]
                if (reason != null) {
                    outbox.markRejected(row.id, row.rev, reason, now())
                    rejected += row.id to reason
                } else {
                    outbox.markSent(row.id, row.rev)
                    sent++
                }
            }
            if (batch.size < BATCH) break
        }
        return SyncReport(SyncOutcome.OK, sent, rejected, serverDateMs = date)
    }

    private fun pushProblems(): SyncReport? {
        for (p in problems.pendingProblems()) {
            val body = JSONObject().put("component", p.component)
            if (p.resolved) body.put("resolved", true) else body.put("message", p.message)
            val res = transport.post("problems", body.toString())
            failure(res)?.let { return it }
            problems.markProblemSent(p.component, p.rev)
        }
        return null
    }

    private fun failure(res: HttpResult): SyncReport? = when {
        res.code == 401 -> SyncReport(SyncOutcome.UNAUTHORIZED, detail = "Hub answered 401")
        res.code < 0 -> SyncReport(SyncOutcome.UNREACHABLE, detail = res.error ?: "Hub not reachable")
        res.code !in 200..299 -> SyncReport(SyncOutcome.HUB_ERROR, detail = "Hub answered ${res.code}: ${res.body?.take(200)}")
        else -> null
    }

    private fun parseRejected(body: String?): Map<String, String>? = try {
        val o = JSONObject(body ?: "")
        val arr = o.optJSONArray("rejected") ?: JSONArray()
        (0 until arr.length()).associate { i ->
            val r = arr.getJSONObject(i)
            r.getString("id") to r.optString("reason", "no reason given")
        }
    } catch (e: Exception) {
        null
    }

    companion object {
        const val BATCH = 500
    }
}
