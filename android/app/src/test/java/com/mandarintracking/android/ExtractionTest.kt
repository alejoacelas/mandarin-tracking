package com.mandarintracking.android

import com.mandarintracking.android.core.TrackedApps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ExtractionTest {
    @Test fun shortLabelsAreIgnored() {
        // A Chinese-language phone: the app's buttons and tabs are Chinese, the chat is English.
        val chrome = listOf("发送", "新聊天", "首页", "设置", "复制", "重新生成")
        val content = listOf("Sure! Here is a short explanation of how tones work in Mandarin and why they matter for beginners.")
        val s = Extraction.measure(chrome + content)
        assertEquals(0, s.han)
        assertFalse(s.isMandarin)
    }

    @Test fun englishChromeAroundChineseContent() {
        val chrome = listOf("New chat", "Share", "Copy", "Message ChatGPT")
        val content = listOf("我们今天学习了很多新的汉字，比如学习、工作和朋友。你想继续练习吗？")
        val s = Extraction.measure(chrome + content)
        assertTrue(s.isMandarin)
        assertEquals(1.0, s.share, 0.0)
    }

    @Test fun repeatsCountOnce() {
        val s = Extraction.measure(listOf("我们今天学习汉字", "我们今天学习汉字"))
        assertEquals(8, s.units)
    }

    @Test fun buttonLikeNodes() {
        assertTrue(Extraction.isButtonLike("android.widget.Button", false, "Regenerate the answer please now"))
        assertTrue(Extraction.isButtonLike("android.view.View", true, "重新生成"))
        // A long clickable message bubble is content.
        assertFalse(Extraction.isButtonLike("android.view.View", true, "这是一个很长的回答，里面有很多中文字，用来学习。"))
        assertFalse(Extraction.isButtonLike("android.widget.TextView", false, "短"))
    }

    @Test fun chromeContainers() {
        assertTrue(Extraction.isChromeClass("androidx.appcompat.widget.Toolbar", null))
        assertTrue(Extraction.isChromeClass("com.google.android.material.bottomnavigation.BottomNavigationView", null))
        assertTrue(Extraction.isChromeClass("android.view.View", "com.openai.chatgpt:id/drawer_layout"))
        assertFalse(Extraction.isChromeClass("android.widget.TextView", "com.readermobile:id/article_body"))
        assertFalse(Extraction.isChromeClass(null, null))
    }

    @Test fun accessibilityXmlListsExactlyTheSampledApps() {
        val xml = File("src/main/res/xml/accessibility.xml").readText()
        val listed = Regex("""android:packageNames="([^"]+)"""").find(xml)!!.groupValues[1].split(",").toSet()
        assertEquals(TrackedApps.sampledPackages.toSet(), listed)
    }

    @Test fun trackedListHasNoDuplicatesAndPlecoIsAlwaysZh() {
        val pkgs = TrackedApps.foreground.map { it.pkg }
        assertEquals(pkgs.size, pkgs.toSet().size)
        assertFalse("com.pleco.chinesesystem" in TrackedApps.sampledPackages)
        assertTrue("com.readermobile" in TrackedApps.sampledPackages)
    }

    @Test fun youtubeInBrowser() {
        assertTrue(AdRules.mentionsYoutube("https://www.youtube.com/watch?v=abc"))
        assertTrue(AdRules.mentionsYoutube("m.youtube.com"))
        assertFalse(AdRules.mentionsYoutube("Bilibili 视频"))
    }
}
