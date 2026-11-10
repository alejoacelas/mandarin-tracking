package com.mandarintracking.android.core

import org.json.JSONObject

/** One interval as defined in docs/protocol.md ("Intervals"). */
data class Interval(
    val id: String,
    val source: Source,
    val startMs: Long,
    val endMs: Long,
    /** "zh", "other" or "unknown". */
    val language: String,
    val zhShare: Double?,
    val units: Int?,
    val app: String,
    val title: String? = null,
    val channelName: String? = null,
    val meta: Map<String, Any?> = emptyMap(),
) {
    init {
        require(id.length <= 128) { "id too long: $id" }
        require(language in LANGUAGES) { "bad language $language" }
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("source", source.wire)
        put("start_ms", startMs)
        put("end_ms", endMs)
        put("language", language)
        put("zh_share", zhShare?.let { Math.round(it * 10000) / 10000.0 } ?: JSONObject.NULL)
        put("units", units ?: JSONObject.NULL)
        put("app", app)
        put("title", title ?: JSONObject.NULL)
        put("channel_name", channelName ?: JSONObject.NULL)
        put("channel_id", JSONObject.NULL)
        put("video_id", JSONObject.NULL)
        put("conversation_id", JSONObject.NULL)
        put("doc_id", JSONObject.NULL)
        put("url", JSONObject.NULL)
        put("meta", if (meta.isEmpty()) JSONObject.NULL else JSONObject().also { m ->
            meta.forEach { (k, v) -> m.put(k, v ?: JSONObject.NULL) }
        })
    }

    companion object {
        val LANGUAGES = setOf("zh", "other", "unknown")
        const val MAX_LENGTH_MS = 30 * 60_000L
    }
}

/** Splits [start, end) into pieces of at most [max] ms, aligned to [start]. */
fun chunks(start: Long, end: Long, max: Long = Interval.MAX_LENGTH_MS): List<Pair<Long, Long>> {
    if (end <= start) return emptyList()
    val out = ArrayList<Pair<Long, Long>>()
    var s = start
    while (s < end) {
        val e = minOf(end, s + max)
        out += s to e
        s = e
    }
    return out
}
