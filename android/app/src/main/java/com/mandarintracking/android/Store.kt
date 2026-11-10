package com.mandarintracking.android

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import com.mandarintracking.android.core.Interval
import com.mandarintracking.android.core.Outbox
import com.mandarintracking.android.core.PendingInterval
import com.mandarintracking.android.core.PendingProblem
import com.mandarintracking.android.core.ProblemQueue
import com.mandarintracking.android.core.TextSample

/**
 * The durable local queue. Intervals stay here until the hub accepts their latest version,
 * however long that takes; nothing is deleted before then.
 */
class Store private constructor(context: Context) :
    SQLiteOpenHelper(context, "tracker.db", null, 1), Outbox, ProblemQueue {

    override fun onConfigure(db: SQLiteDatabase) {
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE outbox (
                id TEXT PRIMARY KEY, source TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
                body TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 0,
                rev INTEGER NOT NULL, sent_rev INTEGER NOT NULL DEFAULT 0,
                rejected_rev INTEGER NOT NULL DEFAULT 0, rejected_at INTEGER NOT NULL DEFAULT 0, rejected_reason TEXT,
                updated_at INTEGER NOT NULL)"""
        )
        db.execSQL("CREATE INDEX outbox_pending ON outbox(sent_rev, rev)")
        db.execSQL("CREATE INDEX outbox_start ON outbox(start_ms)")
        db.execSQL("CREATE TABLE samples (pkg TEXT NOT NULL, at_ms INTEGER NOT NULL, han INTEGER NOT NULL, units INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX samples_at ON samples(at_ms)")
        db.execSQL(
            """CREATE TABLE problems (component TEXT PRIMARY KEY, message TEXT, since_ms INTEGER NOT NULL,
                rev INTEGER NOT NULL, sent_rev INTEGER NOT NULL DEFAULT 0)"""
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Version 1 is the only schema so far. Future versions must migrate, never drop: the
        // outbox may hold data the hub has not seen.
    }

    // ---- intervals ----

    /** Inserts or updates an interval. Its version goes up only when its content changed. */
    @Synchronized
    fun upsert(iv: Interval, open: Boolean = false, now: Long = System.currentTimeMillis()) {
        val body = iv.toJson().toString()
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.rawQuery("SELECT body, rev, open FROM outbox WHERE id=?", arrayOf(iv.id)).use { c ->
                if (c.moveToFirst()) {
                    val same = c.getString(0) == body
                    if (same && (c.getInt(2) == 1) == open) return
                    db.update("outbox", ContentValues().apply {
                        put("body", body); put("start_ms", iv.startMs); put("end_ms", iv.endMs)
                        put("open", if (open) 1 else 0); put("updated_at", now)
                        if (!same) put("rev", c.getLong(1) + 1)
                    }, "id=?", arrayOf(iv.id))
                } else {
                    db.insertOrThrow("outbox", null, ContentValues().apply {
                        put("id", iv.id); put("source", iv.source.wire); put("start_ms", iv.startMs); put("end_ms", iv.endMs)
                        put("body", body); put("open", if (open) 1 else 0); put("rev", 1); put("updated_at", now)
                    })
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Replaces a stored interval's body (already in wire format) and marks it closed. */
    @Synchronized
    fun upsertRaw(body: org.json.JSONObject, now: Long = System.currentTimeMillis()) {
        writableDatabase.execSQL(
            "UPDATE outbox SET body=?, open=0, rev=rev+1, updated_at=? WHERE id=?",
            arrayOf<Any>(body.toString(), now, body.getString("id")),
        )
    }

    /** All intervals are sent again, e.g. after pairing with a hub that may not have them. */
    @Synchronized
    fun resendAll() {
        writableDatabase.execSQL("UPDATE outbox SET sent_rev=0, rejected_rev=0, rejected_at=0, rejected_reason=NULL")
    }

    /** Ids of intervals starting at or after [fromMs] whose id begins with [prefix]. */
    fun idsSince(prefix: String, fromMs: Long): Set<String> =
        readableDatabase.rawQuery("SELECT id FROM outbox WHERE start_ms >= ? AND id LIKE ?", arrayOf(fromMs.toString(), "$prefix%")).use { c ->
            buildSet { while (c.moveToNext()) add(c.getString(0)) }
        }

    /** Bodies of intervals that were still open when last written (the process died while they ran). */
    fun openIntervals(source: String): List<String> =
        readableDatabase.rawQuery("SELECT body FROM outbox WHERE open=1 AND source=?", arrayOf(source)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    override fun pending(limit: Int, nowMs: Long): List<PendingInterval> =
        readableDatabase.rawQuery(
            """SELECT id, rev, body FROM outbox WHERE rev > sent_rev AND (rejected_rev < rev OR rejected_at <= ?)
               ORDER BY start_ms LIMIT ?""",
            arrayOf((nowMs - RETRY_REJECTED_MS).toString(), limit.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(PendingInterval(c.getString(0), c.getLong(1), c.getString(2))) } }

    @Synchronized
    override fun markSent(id: String, rev: Long) {
        writableDatabase.execSQL(
            "UPDATE outbox SET sent_rev=?, rejected_reason=NULL WHERE id=? AND sent_rev < ?",
            arrayOf<Any>(rev, id, rev),
        )
    }

    @Synchronized
    override fun markRejected(id: String, rev: Long, reason: String, nowMs: Long) {
        writableDatabase.execSQL(
            "UPDATE outbox SET rejected_rev=?, rejected_at=?, rejected_reason=? WHERE id=?",
            arrayOf<Any>(rev, nowMs, reason.take(500), id),
        )
    }

    /** Intervals the hub has not accepted yet. */
    fun unsentCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox WHERE rev > sent_rev", null).use { c -> c.moveToFirst(); c.getInt(0) }

    fun rejectedCount(): Int = readableDatabase.rawQuery(
        "SELECT COUNT(*) FROM outbox WHERE rev > sent_rev AND rejected_rev = rev", null
    ).use { c -> c.moveToFirst(); c.getInt(0) }

    fun lastRejectReason(): String? = readableDatabase.rawQuery(
        "SELECT rejected_reason FROM outbox WHERE rev > sent_rev AND rejected_rev = rev ORDER BY rejected_at DESC LIMIT 1", null
    ).use { c -> if (c.moveToFirst()) c.getString(0) else null }

    /** Accepted intervals older than [olderThanMs] are no longer needed locally. */
    @Synchronized
    fun pruneSent(olderThanMs: Long) {
        writableDatabase.execSQL("DELETE FROM outbox WHERE rev = sent_rev AND end_ms < ?", arrayOf<Any>(olderThanMs))
        writableDatabase.execSQL("DELETE FROM samples WHERE at_ms < ?", arrayOf<Any>(olderThanMs))
    }

    // ---- text samples ----

    @Synchronized
    fun addSample(s: TextSample) {
        writableDatabase.insert("samples", null, ContentValues().apply {
            put("pkg", s.pkg); put("at_ms", s.timeMs); put("han", s.han); put("units", s.units)
        })
    }

    fun samples(fromMs: Long, toMs: Long): List<TextSample> =
        readableDatabase.rawQuery(
            "SELECT pkg, at_ms, han, units FROM samples WHERE at_ms >= ? AND at_ms <= ? ORDER BY at_ms",
            arrayOf(fromMs.toString(), toMs.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(TextSample(c.getString(0), c.getLong(1), c.getInt(2), c.getInt(3))) } }

    fun lastSampleAt(): Long? = readableDatabase.rawQuery("SELECT MAX(at_ms) FROM samples", null).use { c ->
        if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
    }

    // ---- problems ----

    /** Sets or clears ([message] null) the current problem of a component. No-op if unchanged. */
    @Synchronized
    fun setProblem(component: String, message: String?, now: Long = System.currentTimeMillis()) {
        val db = writableDatabase
        db.rawQuery("SELECT message, rev FROM problems WHERE component=?", arrayOf(component)).use { c ->
            if (c.moveToFirst()) {
                if (c.getString(0) == message) return
                db.update("problems", ContentValues().apply {
                    put("message", message); put("rev", c.getLong(1) + 1)
                    if (message != null && c.isNull(0)) put("since_ms", now)
                }, "component=?", arrayOf(component))
            } else {
                if (message == null) return
                db.insert("problems", null, ContentValues().apply {
                    put("component", component); put("message", message); put("since_ms", now); put("rev", 1)
                })
            }
        }
    }

    data class Problem(val component: String, val message: String, val sinceMs: Long)

    fun activeProblems(): List<Problem> =
        readableDatabase.rawQuery("SELECT component, message, since_ms FROM problems WHERE message IS NOT NULL ORDER BY component", null).use { c ->
            buildList { while (c.moveToNext()) add(Problem(c.getString(0), c.getString(1), c.getLong(2))) }
        }

    fun problemSince(component: String): Long? =
        readableDatabase.rawQuery("SELECT since_ms FROM problems WHERE component=? AND message IS NOT NULL", arrayOf(component)).use { c ->
            if (c.moveToFirst()) c.getLong(0) else null
        }

    override fun pendingProblems(): List<PendingProblem> =
        readableDatabase.rawQuery("SELECT component, message, rev FROM problems WHERE rev > sent_rev", null).use { c ->
            buildList { while (c.moveToNext()) add(PendingProblem(c.getString(0), c.getString(1), c.getLong(2))) }
        }

    @Synchronized
    override fun markProblemSent(component: String, rev: Long) {
        writableDatabase.execSQL("UPDATE problems SET sent_rev=? WHERE component=? AND sent_rev < ?", arrayOf<Any>(rev, component, rev))
    }

    /** After pairing with a (possibly new) hub, everything must be sent again. */
    @Synchronized
    fun resendAllProblems() {
        writableDatabase.execSQL("UPDATE problems SET sent_rev=0")
    }

    companion object {
        const val RETRY_REJECTED_MS = 6 * 3600_000L

        @Volatile private var instance: Store? = null
        fun get(context: Context): Store = instance ?: synchronized(this) {
            instance ?: Store(context.applicationContext).also { instance = it }
        }
    }
}
