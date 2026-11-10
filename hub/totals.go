package main

import (
	"sort"
	"strings"
	"time"
)

// Class is what an interval counts as once its language is resolved.
type Class string

const (
	ClassZh      Class = "zh"      // Mandarin
	ClassPartly  Class = "partly"  // a YouTube channel labelled "mixed"
	ClassOther   Class = "other"   // not Mandarin
	ClassUnknown Class = "unknown" // couldn't tell
)

// Sources shown on the dashboard, in order.
var Sources = []string{"youtube", "reader", "pleco", "llm"}

const (
	ReaderAPIDevice = "hub-reader"
	MacAppsDevice   = "hub-mac"
	// Chat messages this close to an app session count as part of it.
	chatSlackMs = 2 * 60 * 1000
)

// ChatService maps an app to the chat service whose history can label it.
func ChatService(app string) string {
	a := strings.ToLower(app)
	switch {
	case strings.Contains(a, "openai"), strings.Contains(a, "chatgpt"):
		return "chatgpt"
	case strings.Contains(a, "anthropic"), strings.Contains(a, "claude"):
		return "claude"
	}
	return ""
}

type span struct{ s, e int64 }

func unionLen(sp []span) int64 {
	if len(sp) == 0 {
		return 0
	}
	sort.Slice(sp, func(i, j int) bool { return sp[i].s < sp[j].s })
	var total int64
	cs, ce := sp[0].s, sp[0].e
	for _, x := range sp[1:] {
		if x.s > ce {
			total += ce - cs
			cs, ce = x.s, x.e
		} else if x.e > ce {
			ce = x.e
		}
	}
	return total + ce - cs
}

func merge(sp []span) []span {
	if len(sp) == 0 {
		return nil
	}
	sp = append([]span(nil), sp...)
	sort.Slice(sp, func(i, j int) bool { return sp[i].s < sp[j].s })
	out := []span{sp[0]}
	for _, x := range sp[1:] {
		last := &out[len(out)-1]
		if x.s > last.e {
			out = append(out, x)
		} else if x.e > last.e {
			last.e = x.e
		}
	}
	return out
}

// minus returns the length of a minus b (both merged).
func minusLen(a, b []span) int64 {
	var total int64
	for _, x := range a {
		total += x.e - x.s
		for _, y := range b {
			s, e := max(x.s, y.s), min(x.e, y.e)
			if e > s {
				total -= e - s
			}
		}
	}
	return total
}

// Resolver decides the class of each interval.
type Resolver struct {
	Channels  map[string]string // channel key → label
	Chats     map[string][]ChatMessage
	ReaderAPI []Interval // intervals from the Reader API poller
}

func (r *Resolver) Resolve(iv Interval) Class {
	switch iv.Language {
	case "zh":
		return ClassZh
	case "other":
		return ClassOther
	}
	switch iv.Source {
	case "pleco":
		return ClassZh
	case "youtube":
		switch r.Channels[ChannelKey(str(iv.ChannelName))] {
		case "mandarin":
			return ClassZh
		case "mixed":
			return ClassPartly
		case "other":
			return ClassOther
		}
	case "reader":
		if iv.DeviceID == ReaderAPIDevice {
			return ClassUnknown
		}
		zh, other := false, false
		for _, a := range r.ReaderAPI {
			if a.StartMs < iv.EndMs && a.EndMs > iv.StartMs {
				zh = zh || a.Language == "zh"
				other = other || a.Language == "other"
			}
		}
		if zh {
			return ClassZh
		}
		if other {
			return ClassOther
		}
	case "llm", "app":
		if svc := ChatService(iv.App); svc != "" {
			var han, units float64
			for _, m := range r.Chats[svc] {
				if m.AtMs >= iv.StartMs-chatSlackMs && m.AtMs <= iv.EndMs+chatSlackMs {
					han += m.ZhShare * float64(m.Units)
					units += float64(m.Units)
				}
			}
			if units > 0 {
				if IsMandarinText(han/units, int(units)) {
					return ClassZh
				}
				return ClassOther
			}
		}
	}
	return ClassUnknown
}

// DaySummary is one day of the dashboard.
type DaySummary struct {
	Date         string             `json:"date"`
	TotalMin     float64            `json:"total_min"`
	BySource     map[string]float64 `json:"by_source"`
	PartlyMin    float64            `json:"partly_min"`
	Unclassified float64            `json:"unclassified_min"`
	Items        []Item             `json:"items"`
}

// Item is one video channel, document, chat or app within a day.
type Item struct {
	Source string  `json:"source"`
	Name   string  `json:"name"`
	Detail string  `json:"detail"`
	Class  Class   `json:"class"`
	Device string  `json:"device"`
	Min    float64 `json:"min"`
}

func dayBounds(date time.Time, loc *time.Location) (int64, int64) {
	y, m, d := date.In(loc).Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, loc)
	end := time.Date(y, m, d+1, 0, 0, 0, 0, loc) // handles DST: days can be 23 or 25 h
	return start.UnixMilli(), end.UnixMilli()
}

// appNames are display names for apps (Android packages and Mac bundle IDs).
var appNames = map[string]string{
	"com.openai.chatgpt": "ChatGPT", "com.openai.chat": "ChatGPT", "com.openai.codex": "ChatGPT",
	"com.anthropic.claude": "Claude", "com.anthropic.claudefordesktop": "Claude",
	"io.readwise.read": "Reader", "com.readermobile": "Reader", "readwise-api": "Reader",
	"com.google.android.apps.bard": "Gemini", "com.deepseek.chat": "DeepSeek",
	"com.larus.nova": "Doubao", "com.larus.wolf": "Dola", "com.moonshot.kimichat": "Kimi",
	"com.aliyun.tongyi": "Tongyi", "ai.qwenlm.chat.android": "Qwen", "ai.perplexity.app.android": "Perplexity",
	"ai.x.grok": "Grok", "com.tencent.hunyuan.app.chat": "Yuanbao", "com.microsoft.copilot": "Copilot",
	"com.pleco.chinesesystem":    "Pleco",
	"com.google.android.youtube": "YouTube",
}

func appName(app string) string {
	if n := appNames[app]; n != "" {
		return n
	}
	return app
}

func itemName(iv Interval) (name, detail string) {
	switch iv.Source {
	case "youtube":
		if n := str(iv.ChannelName); n != "" {
			return n, str(iv.Title)
		}
		return "Unknown channel", str(iv.Title)
	case "pleco":
		return "Pleco", ""
	}
	if t := str(iv.Title); t != "" {
		return t, appName(iv.App)
	}
	return appName(iv.App), ""
}

// Summarize computes one DaySummary per day, oldest first, ending with the day containing now.
func Summarize(ivs []Interval, r *Resolver, now time.Time, days int, loc *time.Location, deviceNames map[string]string) []DaySummary {
	out := make([]DaySummary, 0, days)
	for i := days - 1; i >= 0; i-- {
		y, m, d := now.In(loc).Date()
		day := time.Date(y, m, d-i, 12, 0, 0, 0, loc)
		from, to := dayBounds(day, loc)
		ds := DaySummary{Date: day.Format("2006-01-02"), BySource: map[string]float64{}}
		bySource := map[string][]span{}
		var zh, partly, unknown []span
		type itemKey struct {
			source, name string
			class        Class
		}
		items := map[itemKey][]span{}
		itemInfo := map[itemKey]Item{}
		for _, iv := range ivs {
			s, e := max(iv.StartMs, from), min(iv.EndMs, to, now.UnixMilli())
			if e <= s {
				continue
			}
			c := r.Resolve(iv)
			sp := span{s, e}
			switch c {
			case ClassZh:
				zh = append(zh, sp)
				src := iv.Source
				if src == "app" {
					src = "llm"
				}
				bySource[src] = append(bySource[src], sp)
			case ClassPartly:
				partly = append(partly, sp)
			case ClassUnknown:
				unknown = append(unknown, sp)
			}
			name, detail := itemName(iv)
			k := itemKey{iv.Source, name, c}
			items[k] = append(items[k], sp)
			if _, ok := itemInfo[k]; !ok {
				dev := deviceNames[iv.DeviceID]
				if dev == "" {
					dev = iv.DeviceID
				}
				itemInfo[k] = Item{Source: iv.Source, Name: name, Detail: detail, Class: c, Device: dev}
			}
		}
		zhM, partlyM := merge(zh), merge(partly)
		ds.TotalMin = minutes(unionLen(zhM))
		for src, sp := range bySource {
			ds.BySource[src] = minutes(unionLen(sp))
		}
		ds.PartlyMin = minutes(minusLen(partlyM, zhM))
		ds.Unclassified = minutes(minusLen(merge(unknown), merge(append(append([]span{}, zhM...), partlyM...))))
		for k, sp := range items {
			it := itemInfo[k]
			it.Min = minutes(unionLen(sp))
			if it.Min >= 0.1 {
				ds.Items = append(ds.Items, it)
			}
		}
		sort.Slice(ds.Items, func(i, j int) bool { return ds.Items[i].Min > ds.Items[j].Min })
		out = append(out, ds)
	}
	return out
}

func minutes(ms int64) float64 {
	return float64(ms/600) / 100 // two decimals, truncated
}
