package com.mandarintracking.android.core

/** The protocol's `source` values. */
enum class Source(val wire: String) { YOUTUBE("youtube"), READER("reader"), PLECO("pleco"), LLM("llm"), APP("app") }

/** How the language of a foreground session is decided. */
enum class LanguageRule {
    /** Always Mandarin (Pleco is a Chinese dictionary). */
    ALWAYS_ZH,
    /** Measured from on-screen text by the accessibility service. */
    SAMPLED,
}

data class TrackedApp(val pkg: String, val name: String, val source: Source, val rule: LanguageRule)

/**
 * Every app the tracker measures, in one place. Package names were checked on Google Play
 * (Microsoft Copilot on APKMirror) in November 2026.
 */
object TrackedApps {
    val foreground: List<TrackedApp> = listOf(
        TrackedApp("com.pleco.chinesesystem", "Pleco", Source.PLECO, LanguageRule.ALWAYS_ZH),
        TrackedApp("com.readermobile", "Readwise Reader", Source.READER, LanguageRule.SAMPLED),
        TrackedApp("com.openai.chatgpt", "ChatGPT", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.anthropic.claude", "Claude", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.google.android.apps.bard", "Gemini", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.deepseek.chat", "DeepSeek", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.larus.nova", "Doubao", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.larus.wolf", "Dola (Cici)", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.moonshot.kimichat", "Kimi", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.aliyun.tongyi", "Qianwen (Tongyi)", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("ai.qwenlm.chat.android", "Qwen", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("ai.perplexity.app.android", "Perplexity", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("ai.x.grok", "Grok", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.microsoft.copilot", "Copilot", Source.LLM, LanguageRule.SAMPLED),
        TrackedApp("com.tencent.hunyuan.app.chat", "Yuanbao", Source.LLM, LanguageRule.SAMPLED),
    )

    private val byPkg = foreground.associateBy { it.pkg }

    fun get(pkg: String?): TrackedApp? = pkg?.let { byPkg[it] }

    /** Packages whose screen text the accessibility service samples. */
    val sampledPackages: Array<String> =
        foreground.filter { it.rule == LanguageRule.SAMPLED }.map { it.pkg }.toTypedArray()

    const val YOUTUBE = "com.google.android.youtube"

    /** Browsers whose media sessions are counted only when they show a YouTube video. */
    val browsers: Set<String> = setOf(
        "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
        "org.mozilla.firefox", "org.mozilla.firefox_beta", "com.brave.browser",
        "com.microsoft.emmx", "com.sec.android.app.sbrowser", "com.opera.browser",
        "com.vivaldi.browser", "com.kiwibrowser.browser", "com.duckduckgo.mobile.android",
        "com.mi.globalbrowser", "com.android.browser", "com.huawei.browser",
    )
}
