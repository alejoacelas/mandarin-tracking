package com.mandarintracking.android.core

/** One reading of on-screen text by the accessibility service. Only counts are stored, never text. */
data class TextSample(val pkg: String, val timeMs: Long, val han: Int, val units: Int) {
    val share: Share get() = Share(han, units)
}

/** Why a segment got its language. Sent in `meta.language_reason`. */
object LanguageReason {
    const val ALWAYS_ZH = "app_is_always_zh"
    const val SAMPLES = "samples"
    /** Samples exist but together hold fewer than 20 units. */
    const val TOO_LITTLE_TEXT = "too_little_text"
    /** The accessibility service took no sample during the session (off, not running, or no events). */
    const val NO_SAMPLES = "no_samples"
}

data class Segment(
    val startMs: Long,
    val endMs: Long,
    val language: String,
    val share: Share?,
    val samples: Int,
    val reason: String,
)

/**
 * Splits a session into stretches of one language using text samples.
 *
 * A sample is conclusive when it has at least 20 units; it says `zh` when its share is at least 0.3.
 * The session starts in the language of its first conclusive sample. It switches language at a
 * conclusive sample whose label differs, but only once the next conclusive sample agrees, so one
 * odd screen (a menu, the chat list) doesn't split it. Adding later samples never moves or removes
 * an earlier boundary, so ids built from segment starts stay valid as a session grows.
 * Without conclusive samples the whole session is one segment, labelled from all its text pooled,
 * or `unknown`.
 */
object Labeler {
    /** Samples up to this long after the session end still belong to it (a sample at pause time). */
    const val END_SLACK_MS = 2_000L

    fun segments(session: Session, rule: LanguageRule, samples: List<TextSample>): List<Segment> {
        if (rule == LanguageRule.ALWAYS_ZH) {
            return listOf(Segment(session.startMs, session.endMs, "zh", null, 0, LanguageReason.ALWAYS_ZH))
        }
        val mine = samples
            .filter { it.pkg == session.pkg && it.timeMs >= session.startMs && it.timeMs <= session.endMs + END_SLACK_MS }
            .sortedBy { it.timeMs }
        val conclusive = mine.filter { it.units >= Share.MIN_UNITS }
        if (conclusive.isEmpty()) {
            val pooled = mine.fold(Share.EMPTY) { acc, s -> acc + s.share }
            val (lang, reason) = when {
                mine.isEmpty() -> "unknown" to LanguageReason.NO_SAMPLES
                pooled.units >= Share.MIN_UNITS -> (if (pooled.isMandarin) "zh" else "other") to LanguageReason.SAMPLES
                else -> "unknown" to LanguageReason.TOO_LITTLE_TEXT
            }
            return listOf(Segment(session.startMs, session.endMs, lang, pooled.takeIf { it.units > 0 }, mine.size, reason))
        }

        fun label(s: TextSample) = if (s.share.isMandarin) "zh" else "other"
        val boundaries = ArrayList<Pair<Long, String>>() // (start, language)
        var current = label(conclusive[0])
        boundaries += session.startMs to current
        for (i in 1 until conclusive.size) {
            val l = label(conclusive[i])
            if (l != current && conclusive[i].timeMs < session.endMs &&
                i + 1 < conclusive.size && label(conclusive[i + 1]) == l
            ) {
                current = l
                boundaries += conclusive[i].timeMs to l
            }
        }
        return boundaries.mapIndexedNotNull { i, (start, lang) ->
            val end = if (i + 1 < boundaries.size) boundaries[i + 1].first else session.endMs
            if (end <= start) return@mapIndexedNotNull null
            val inside = mine.filter { it.timeMs >= start && (it.timeMs < end || i == boundaries.size - 1) }
            val pooled = inside.fold(Share.EMPTY) { acc, s -> acc + s.share }
            Segment(start, end, lang, pooled.takeIf { it.units > 0 }, inside.size, LanguageReason.SAMPLES)
        }
    }
}
