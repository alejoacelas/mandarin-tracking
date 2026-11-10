package main

// Time in Mac desktop apps that can't be measured from Chrome: the ChatGPT and Claude apps and
// Reader's desktop app. Every few seconds the hub checks which app is in front. Time counts
// while a tracked app is in front, the screen is unlocked and there has been input within
// macIdleCutoff. The hub can't see inside these apps, so their intervals have language
// "unknown": chat history (from the extension) and the Reader API decide later.

import (
	"fmt"
	"time"
)

var MacTrackedApps = map[string]string{ // bundle ID → source
	"com.openai.chat":                "llm",
	"com.openai.codex":               "llm", // ChatGPT.app's ID in 2026 builds
	"com.anthropic.claudefordesktop": "llm",
	"io.readwise.read":               "reader",
}

const (
	macPoll       = 5 * time.Second
	macIdleCutoff = 2 * time.Minute
	macMaxGap     = 15 * time.Second // a longer gap between samples (e.g. sleep) ends the interval
	maxInterval   = 30 * time.Minute
)

type MacSample struct {
	At     time.Time
	Bundle string
	Idle   time.Duration
	Locked bool
}

// MacTracker turns samples into intervals. It isn't safe for concurrent use.
type MacTracker struct {
	cur  *Interval
	last time.Time
}

// Add takes a sample and returns the interval to save (the current one, updated), the
// interval that just finished, or nil.
func (t *MacTracker) Add(s MacSample) *Interval {
	active := !s.Locked && s.Idle < macIdleCutoff && MacTrackedApps[s.Bundle] != ""
	gap := !t.last.IsZero() && s.At.Sub(t.last) > macMaxGap
	t.last = s.At
	if t.cur != nil {
		cur := t.cur
		sameApp := active && cur.App == s.Bundle && !gap
		tooLong := time.Duration(s.At.UnixMilli()-cur.StartMs)*time.Millisecond >= maxInterval
		if sameApp && !tooLong {
			cur.EndMs = s.At.UnixMilli()
			return cur
		}
		t.cur = nil
		// Switching apps ends the interval when the switch was seen. Going idle or locking ends
		// it at the last sample that was active; a gap (sleep) also keeps the last sample.
		if !gap && !s.Locked && s.Idle < macIdleCutoff {
			cur.EndMs = s.At.UnixMilli()
		}
		if active {
			t.start(s)
		}
		return cur
	}
	if active {
		t.start(s)
	}
	return nil
}

func (t *MacTracker) start(s MacSample) {
	ms := s.At.UnixMilli()
	t.cur = &Interval{
		DeviceID: MacAppsDevice, ID: fmt.Sprintf("mac-%s-%d", s.Bundle, ms), Source: MacTrackedApps[s.Bundle],
		StartMs: ms, EndMs: ms + 1, Language: "unknown", App: s.Bundle,
	}
}

// Current returns the running interval, if any.
func (t *MacTracker) Current() *Interval { return t.cur }
