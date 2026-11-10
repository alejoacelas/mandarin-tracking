package com.mandarintracking.android.core

/** Turns foreground sessions into protocol intervals: language segments, then 30-minute pieces. */
object UsageIntervals {
    const val ID_PREFIX = "u:"

    fun id(pkg: String, startMs: Long) = "$ID_PREFIX$pkg:$startMs"

    fun build(sessions: List<Session>, samples: List<TextSample>, extraMeta: Map<String, Any?> = emptyMap()): List<Interval> {
        val out = ArrayList<Interval>()
        for (session in sessions) {
            val app = TrackedApps.get(session.pkg) ?: continue
            val segments = Labeler.segments(session, app.rule, samples)
            for ((si, seg) in segments.withIndex()) {
                val last = si == segments.size - 1
                for ((start, end) in chunks(seg.startMs, seg.endMs)) {
                    val endReason = when {
                        end < seg.endMs -> "split_30min"
                        !last -> "language_changed"
                        else -> session.endReason
                    }
                    out += Interval(
                        id = id(session.pkg, start),
                        source = app.source,
                        startMs = start,
                        endMs = end,
                        language = seg.language,
                        zhShare = seg.share?.share,
                        units = seg.share?.units,
                        app = session.pkg,
                        meta = extraMeta + mapOf(
                            "end" to endReason,
                            "language_reason" to seg.reason,
                            "samples" to seg.samples,
                        ),
                    )
                }
            }
        }
        return out
    }
}
