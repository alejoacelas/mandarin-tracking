package com.mandarintracking.android.core

import java.lang.Character.UnicodeScript

/**
 * Share of a text that is Chinese, as defined in docs/protocol.md ("Chinese share").
 * Each Han character is one unit, each run of Latin/Cyrillic letters is one unit,
 * each kana character is one unit and each run of Hangul is one unit.
 * Ported from v1's src/language.js.
 */
data class Share(val han: Int, val units: Int) {
    val share: Double get() = if (units == 0) 0.0 else han.toDouble() / units

    /** Text counts as Mandarin when the share is at least 0.3 and there are at least 20 units. */
    val isMandarin: Boolean get() = units >= MIN_UNITS && share >= MIN_SHARE

    operator fun plus(o: Share) = Share(han + o.han, units + o.units)

    companion object {
        const val MIN_UNITS = 20
        const val MIN_SHARE = 0.3
        val EMPTY = Share(0, 0)
    }
}

object ChineseShare {
    private enum class Run { NONE, LETTERS, HANGUL }

    fun of(text: String?): Share {
        if (text.isNullOrEmpty()) return Share.EMPTY
        var han = 0
        var other = 0
        var run = Run.NONE
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            val script = try { UnicodeScript.of(cp) } catch (e: IllegalArgumentException) { UnicodeScript.UNKNOWN }
            run = when (script) {
                UnicodeScript.HAN -> { han++; Run.NONE }
                UnicodeScript.HIRAGANA, UnicodeScript.KATAKANA -> { other++; Run.NONE }
                UnicodeScript.HANGUL -> { if (run != Run.HANGUL) other++; Run.HANGUL }
                UnicodeScript.LATIN, UnicodeScript.CYRILLIC -> { if (run != Run.LETTERS) other++; Run.LETTERS }
                else -> Run.NONE
            }
        }
        return Share(han, han + other)
    }
}
