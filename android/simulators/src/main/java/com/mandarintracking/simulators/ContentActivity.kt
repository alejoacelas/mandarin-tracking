package com.mandarintracking.simulators

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * Stands in for Pleco, ChatGPT and Reader. Shows text in the language given by the "lang" extra
 * (zh, en, ja) and, like a chat, appends a new message every few seconds so the screen changes.
 * Start with: am start -n <pkg>/com.mandarintracking.simulators.ContentActivity --es lang zh
 */
class ContentActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var messages: LinearLayout
    private var lang = "zh"
    private var n = 0

    private val ticker = object : Runnable {
        override fun run() {
            addMessage()
            handler.postDelayed(this, 3_000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        // Interface text, as in the real apps: short labels and a hint.
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        bar.addView(Button(this).apply { text = if (uiZh()) "新聊天" else "New chat" })
        bar.addView(Button(this).apply { text = if (uiZh()) "设置" else "Settings" })
        root.addView(bar)
        root.addView(TextView(this).apply { text = title(); textSize = 20f; typeface = Typeface.DEFAULT_BOLD })
        messages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(ScrollView(this).apply { addView(messages) }, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(EditText(this).apply { hint = if (uiZh()) "给 ChatGPT 发消息" else "Message ChatGPT" })
        setContentView(root)
        applyIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        applyIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        handler.post(ticker)
    }

    override fun onPause() {
        handler.removeCallbacks(ticker)
        super.onPause()
    }

    private fun applyIntent(i: Intent?) {
        lang = i?.getStringExtra("lang") ?: "zh"
        messages.removeAllViews()
        n = 0
        repeat(3) { addMessage() }
    }

    private fun uiZh() = intent?.getStringExtra("ui") == "zh"

    private fun title() = "${getString(R.string.app_name)} · ${BuildConfig.FLAVOR}"

    private fun addMessage() {
        val pool = when (lang) {
            "en" -> EN
            "ja" -> JA
            else -> ZH
        }
        messages.addView(TextView(this).apply {
            text = pool[n % pool.size]
            textSize = 16f
            setPadding(0, 12, 0, 12)
        })
        n++
        if (messages.childCount > 12) messages.removeViewAt(0)
    }

    companion object {
        val ZH = listOf(
            "我们今天学习了很多新的汉字，比如学习、工作和朋友。你想继续练习吗？",
            "这个句子的意思是：我每天早上七点起床，然后去公园跑步。",
            "汉语的声调很重要。妈、麻、马、骂的声调都不一样，意思也完全不同。",
            "读书的时候，可以先看一遍全文，再查不认识的词。这样效率更高。",
        )
        val EN = listOf(
            "Sure! Here is a short explanation of how tones work and why they matter for beginners.",
            "The article argues that remote work changed how cities plan their public transport networks.",
            "Reading regularly is the best way to build vocabulary, especially with spaced repetition.",
            "In summary, the study found no significant difference between the two groups after six weeks.",
        )
        val JA = listOf(
            "今日はとても良い天気ですね。散歩に行きましょうか。明日も晴れるといいですね。",
            "日本語の勉強は楽しいですが、漢字を覚えるのは大変です。",
        )
    }
}

/** A second screen, to test activity switches inside one app. */
class SecondActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { text = ContentActivity.ZH[1]; textSize = 18f; setPadding(24, 24, 24, 24) })
    }
}
