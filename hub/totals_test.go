package main

import (
	"math"
	"testing"
	"time"
)

func sp(s string) *string { return &s }

func iv(dev, id, source, lang string, start time.Time, mins float64) Interval {
	return Interval{DeviceID: dev, ID: id, Source: source, Language: lang, App: "app." + source,
		StartMs: start.UnixMilli(), EndMs: start.Add(time.Duration(mins * float64(time.Minute))).UnixMilli()}
}

func near(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.02 {
		t.Errorf("%s = %.2f, want %.2f", what, got, want)
	}
}

func TestChineseShare(t *testing.T) {
	cases := []struct {
		text      string
		zh        bool
		wantUnits int
	}{
		{"我最近在学习中文，每天都会和老师练习口语。你觉得我应该先学汉字还是先练习听力？", true, 36},
		{"I have been thinking about how to plan the project timeline and which tasks come first today.", false, 17},
		{"今日はとても良い天気ですね。散歩に行きましょうか。明日も晴れるといいですね。", false, 0},
		{"오늘은 날씨가 정말 좋네요. 같이 산책하러 갈까요? 내일도 맑았으면 좋겠어요.", false, 0},
		{"", false, 0},
		{"12345 !!! 😀", false, 0},
	}
	for _, c := range cases {
		share, units := ChineseShare(c.text)
		if got := IsMandarinText(share, units); got != c.zh {
			t.Errorf("%q: share %.2f units %d, Mandarin=%v want %v", c.text, share, units, got, c.zh)
		}
		if c.wantUnits > 0 && units != c.wantUnits {
			t.Errorf("%q: units %d want %d", c.text, units, c.wantUnits)
		}
	}
	// A Mandarin lesson explained in English with some Chinese: share between.
	s, _ := ChineseShare("Today we learn 你好 and 谢谢, which mean hello and thank you in Mandarin Chinese.")
	if s <= 0 || s >= MandarinShare {
		t.Errorf("mixed text share %.2f, expected low but non-zero", s)
	}
	// Japanese with many kanji should still score below the threshold.
	s, u := ChineseShare("東京都庁で会議がありました。政府の担当者が説明しました。")
	if IsMandarinText(s, u) {
		t.Errorf("Japanese with kanji counted as Mandarin (share %.2f)", s)
	}
}

func TestUnionAndOverlaps(t *testing.T) {
	loc := time.UTC
	day := time.Date(2026, 11, 10, 10, 0, 0, 0, loc)
	now := day.Add(10 * time.Hour)
	ivs := []Interval{
		iv("a", "1", "youtube", "zh", day, 30),
		iv("b", "2", "youtube", "zh", day.Add(10*time.Minute), 30), // overlaps 20 min, e.g. phone and Mac
		iv("a", "3", "llm", "zh", day.Add(30*time.Minute), 20),     // overlaps youtube 10 min
		iv("a", "4", "pleco", "unknown", day.Add(2*time.Hour), 5),  // Pleco is always Mandarin
		iv("a", "5", "llm", "other", day.Add(3*time.Hour), 60),
	}
	sum := Summarize(ivs, &Resolver{}, now, 1, loc, nil)[0]
	near(t, "youtube", sum.BySource["youtube"], 40)
	near(t, "llm", sum.BySource["llm"], 20)
	near(t, "pleco", sum.BySource["pleco"], 5)
	near(t, "total", sum.TotalMin, 50+5) // 10:00-10:50 plus Pleco
}

func TestDaySplitMidnightAndDST(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no tz data")
	}
	// 23:30 to 00:45 crosses midnight.
	start := time.Date(2026, 11, 9, 23, 30, 0, 0, ny)
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, ny)
	days := Summarize([]Interval{iv("a", "1", "pleco", "zh", start, 75)}, &Resolver{}, now, 2, ny, nil)
	near(t, "Nov 9", days[0].TotalMin, 30)
	near(t, "Nov 10", days[1].TotalMin, 45)
	if days[0].Date != "2026-11-09" || days[1].Date != "2026-11-10" {
		t.Errorf("dates %s %s", days[0].Date, days[1].Date)
	}
	// 1 Nov 2026 is the fall-back day in New York: 25 hours. An interval covering the whole day
	// counts 25 h, and the next day starts at local midnight.
	dstStart := time.Date(2026, 11, 1, 0, 0, 0, 0, ny)
	long := []Interval{
		iv("a", "x", "pleco", "zh", dstStart, 12*60),
		iv("a", "y", "pleco", "zh", dstStart.Add(12*time.Hour), 12*60),
		iv("a", "z", "pleco", "zh", dstStart.Add(24*time.Hour), 120),
	}
	d := Summarize(long, &Resolver{}, time.Date(2026, 11, 2, 12, 0, 0, 0, ny), 2, ny, nil)
	near(t, "fall-back day", d[0].TotalMin, 25*60)
	near(t, "day after", d[1].TotalMin, 60)
}

func TestFutureTimeIsNotCountedYet(t *testing.T) {
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	d := Summarize([]Interval{iv("a", "1", "pleco", "zh", now.Add(-10*time.Minute), 14)}, &Resolver{}, now, 1, time.UTC, nil)
	near(t, "total", d[0].TotalMin, 10)
}

func TestResolveYouTube(t *testing.T) {
	r := &Resolver{Channels: map[string]string{"laogao": "mandarin", "chinese with mike": "mixed", "tvb": "other", "new one": "pending"}}
	cases := map[string]Class{"LaoGao": ClassZh, "Chinese  with Mike": ClassPartly, "TVB": ClassOther, "New One": ClassUnknown, "never seen": ClassUnknown}
	for name, want := range cases {
		x := iv("a", "1", "youtube", "unknown", time.Now(), 1)
		x.ChannelName = sp(name)
		if got := r.Resolve(x); got != want {
			t.Errorf("%s: %s want %s", name, got, want)
		}
	}
	now := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	a := iv("a", "1", "youtube", "unknown", now.Add(-time.Hour), 20)
	a.ChannelName = sp("Chinese with Mike")
	b := iv("a", "2", "youtube", "unknown", now.Add(-50*time.Minute), 20) // overlaps a by 10
	b.ChannelName = sp("laogao")
	c := iv("a", "3", "youtube", "unknown", now.Add(-20*time.Minute), 5)
	c.ChannelName = sp("new one")
	d := Summarize([]Interval{a, b, c}, r, now, 1, time.UTC, nil)[0]
	near(t, "total", d.TotalMin, 20)
	near(t, "partly (minus the Mandarin overlap)", d.PartlyMin, 10)
	near(t, "unclassified", d.Unclassified, 5)
}

func TestResolveLLMFromChatHistory(t *testing.T) {
	at := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	msgs := func(share float64, units int64, offsets ...time.Duration) []ChatMessage {
		var out []ChatMessage
		for i, o := range offsets {
			out = append(out, ChatMessage{Service: "chatgpt", MessageID: string(rune('a' + i)), AtMs: at.Add(o).UnixMilli(), ZhShare: share, Units: units})
		}
		return out
	}
	app := iv(MacAppsDevice, "m", "llm", "unknown", at, 10)
	app.App = "com.openai.chat"
	phone := app
	phone.App = "com.openai.chatgpt"
	claude := app
	claude.App = "com.anthropic.claude"

	r := &Resolver{Chats: map[string][]ChatMessage{"chatgpt": msgs(0.9, 50, time.Minute, 5*time.Minute)}}
	if r.Resolve(app) != ClassZh || r.Resolve(phone) != ClassZh {
		t.Error("ChatGPT app with Chinese messages wasn't Mandarin")
	}
	if r.Resolve(claude) != ClassUnknown {
		t.Error("Claude app was labelled from ChatGPT's history")
	}
	r = &Resolver{Chats: map[string][]ChatMessage{"chatgpt": msgs(0.0, 50, time.Minute)}}
	if r.Resolve(app) != ClassOther {
		t.Error("English history should make it other")
	}
	// Messages just outside the slack don't count; just inside do.
	r = &Resolver{Chats: map[string][]ChatMessage{"chatgpt": msgs(1, 50, -3*time.Minute, 13*time.Minute)}}
	if r.Resolve(app) != ClassUnknown {
		t.Error("messages outside the slack were used")
	}
	r = &Resolver{Chats: map[string][]ChatMessage{"chatgpt": msgs(1, 50, -90*time.Second)}}
	if r.Resolve(app) != ClassZh {
		t.Error("message 90 s before the session wasn't used")
	}
	// The client's own measurement wins.
	measured := app
	measured.Language = "other"
	r = &Resolver{Chats: map[string][]ChatMessage{"chatgpt": msgs(1, 50, time.Minute)}}
	if r.Resolve(measured) != ClassOther {
		t.Error("client-measured language was overridden")
	}
}

func TestResolveReaderAppFromAPI(t *testing.T) {
	at := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	api := iv(ReaderAPIDevice, "rw", "reader", "zh", at.Add(2*time.Minute), 3)
	apiOther := iv(ReaderAPIDevice, "rw2", "reader", "other", at.Add(60*time.Minute), 3)
	r := &Resolver{ReaderAPI: []Interval{api, apiOther}}
	phone := iv("android-1", "p", "reader", "unknown", at, 10)
	if r.Resolve(phone) != ClassZh {
		t.Error("phone Reader session overlapping a Mandarin API session should be Mandarin")
	}
	if r.Resolve(iv("android-1", "q", "reader", "unknown", at.Add(59*time.Minute), 10)) != ClassOther {
		t.Error("overlap with an English doc should be other")
	}
	if r.Resolve(iv("android-1", "s", "reader", "unknown", at.Add(5*time.Hour), 10)) != ClassUnknown {
		t.Error("no overlap should stay unknown")
	}
	// Phone and API both count the same reading once.
	now := at.Add(6 * time.Hour)
	d := Summarize([]Interval{api, phone}, r, now, 1, time.UTC, nil)[0]
	near(t, "reader", d.BySource["reader"], 10)
}
