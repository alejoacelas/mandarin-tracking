package com.mandarintracking.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChineseShareTest {
    private fun share(t: String?) = ChineseShare.of(t).share

    // The cases from v1's test/unit/language-summary.test.js.
    @Test fun v1Cases() {
        assertEquals(1.0, share("我今天很忙"), 0.0)
        assertEquals(0.0, share("I am busy today"), 0.0)
        assertEquals(0.0, share(""), 0.0)
        assertEquals(0.5, share("我今天很忙 because of work this week"), 0.0)
        assertTrue(share("今日はとても忙しいです") < 0.4)
        assertTrue(share("오늘 정말 바빠요 我") < 0.3)
    }

    @Test fun unitsCountHanCharsAndWordRuns() {
        assertEquals(Share(5, 5), ChineseShare.of("我今天很忙"))
        assertEquals(Share(0, 4), ChineseShare.of("I am busy today"))
        // Punctuation, digits and emoji are not units.
        assertEquals(Share(2, 3), ChineseShare.of("你好, world! 123 😀。"))
    }

    @Test fun emptyAndNull() {
        assertEquals(Share.EMPTY, ChineseShare.of(null))
        assertEquals(Share.EMPTY, ChineseShare.of(""))
        assertEquals(Share.EMPTY, ChineseShare.of("123 !!! ..."))
        assertEquals(0.0, Share.EMPTY.share, 0.0)
    }

    @Test fun japaneseKanaCountsPerCharacter() {
        // 今日 忙 are Han (3); は と て も し い で す are 8 kana units.
        assertEquals(Share(3, 11), ChineseShare.of("今日はとても忙しいです"))
        assertFalse(ChineseShare.of("今日はとても忙しいです。明日もたぶん忙しいでしょう。").isMandarin)
    }

    @Test fun koreanHangulCountsPerRun() {
        assertEquals(Share(1, 4), ChineseShare.of("오늘 정말 바빠요 我"))
    }

    @Test fun latinAndCyrillicRunsMerge() {
        assertEquals(Share(0, 1), ChineseShare.of("helloпривет"))
        assertEquals(Share(0, 2), ChineseShare.of("hello привет"))
        // A Han character splits a Latin run.
        assertEquals(Share(1, 3), ChineseShare.of("ab中cd"))
    }

    @Test fun traditionalCountsAsChinese() {
        assertEquals(1.0, share("我們今天學習漢語"), 0.0)
    }

    @Test fun supplementaryPlaneHan() {
        // U+20000 (CJK Extension B) is one Han unit, not two.
        assertEquals(Share(1, 1), ChineseShare.of("𠀀"))
    }

    @Test fun mandarinThreshold() {
        val zh19 = "我".repeat(19)
        assertFalse(ChineseShare.of(zh19).isMandarin) // too few units
        assertTrue(ChineseShare.of(zh19 + "好").isMandarin)
        // 6 Han out of 20 units = 0.3 exactly counts.
        val mixed = "我们今天学习" + " word".repeat(14)
        assertEquals(Share(6, 20), ChineseShare.of(mixed))
        assertTrue(ChineseShare.of(mixed).isMandarin)
        assertFalse(ChineseShare.of("我们今天学" + " word".repeat(15)).isMandarin)
    }

    @Test fun mixedChineseEnglishLearnerText() {
        // A typical learner chat: English explanation with Chinese examples.
        val t = "The word 学习 means to study. For example: 我每天学习中文 means I study Chinese every day."
        val s = ChineseShare.of(t)
        assertEquals(9, s.han)
        assertTrue(s.share < 0.5)
    }
}
