package main

import (
	"testing"
	"time"
)

type macStep struct {
	sec    int
	bundle string
	idle   int
	locked bool
}

// runMac feeds samples and returns the final state of every interval, by id.
func runMac(steps []macStep) map[string]Interval {
	base := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	var t MacTracker
	out := map[string]Interval{}
	for _, s := range steps {
		if iv := t.Add(MacSample{At: base.Add(time.Duration(s.sec) * time.Second), Bundle: s.bundle, Idle: time.Duration(s.idle) * time.Second, Locked: s.locked}); iv != nil {
			out[iv.ID] = *iv
		}
	}
	return out
}

func lens(m map[string]Interval) (n int, total int64) {
	for _, iv := range m {
		n++
		total += iv.EndMs - iv.StartMs
	}
	return
}

const gpt, claudeApp, finder = "com.openai.chat", "com.anthropic.claudefordesktop", "com.apple.finder"

func every5(from, to int, bundle string, idle func(int) int) []macStep {
	var s []macStep
	for t := from; t <= to; t += 5 {
		i := 0
		if idle != nil {
			i = idle(t)
		}
		s = append(s, macStep{t, bundle, i, false})
	}
	return s
}

func TestMacSwitchApps(t *testing.T) {
	steps := append(every5(0, 60, gpt, nil), every5(65, 120, claudeApp, nil)...)
	steps = append(steps, every5(125, 150, finder, nil)...)
	m := runMac(steps)
	n, total := lens(m)
	if n != 2 || total != 125_000 {
		t.Fatalf("got %d intervals, %d ms; want 2 and 125000: %+v", n, total, m)
	}
	for _, iv := range m {
		if iv.Language != "unknown" || iv.Source != "llm" || iv.DeviceID != MacAppsDevice {
			t.Errorf("%+v", iv)
		}
	}
}

func TestMacIdleLockAndSleep(t *testing.T) {
	// Idle grows after 30 s of use; at 150 s it passes the 2-minute cutoff.
	idle := func(s int) int {
		if s <= 30 {
			return 0
		}
		return s - 30
	}
	m := runMac(every5(0, 200, gpt, idle))
	if _, total := lens(m); total != 145_000 {
		t.Errorf("idle: %d ms, want 145000 (counts up to the cutoff)", total)
	}
	// Locked screen stops counting.
	steps := every5(0, 30, gpt, nil)
	steps = append(steps, macStep{35, gpt, 0, true}, macStep{40, gpt, 0, true})
	if _, total := lens(runMac(steps)); total != 30_000 {
		t.Errorf("lock: %d ms", total)
	}
	// Sleep: no samples for an hour, then the app is still in front.
	steps = append(every5(0, 30, gpt, nil), every5(3630, 3660, gpt, nil)...)
	m = runMac(steps)
	n, total := lens(m)
	if n != 2 || total != 60_000 {
		t.Errorf("sleep: %d intervals, %d ms; want 2 and 60000", n, total)
	}
}

func TestMacSplitsLongSessionsAndIgnoresOtherApps(t *testing.T) {
	m := runMac(every5(0, 3600, claudeApp, nil))
	n, total := lens(m)
	if n != 2 || total != 3600_000 {
		t.Errorf("hour in one app: %d intervals, %d ms", n, total)
	}
	for _, iv := range m {
		if iv.EndMs-iv.StartMs > maxInterval.Milliseconds() {
			t.Errorf("interval longer than 30 min: %d", iv.EndMs-iv.StartMs)
		}
	}
	if n, _ := lens(runMac(every5(0, 600, finder, nil))); n != 0 {
		t.Error("untracked app counted")
	}
	if n, _ := lens(runMac(every5(0, 600, "", nil))); n != 0 {
		t.Error("no front app counted")
	}
	m = runMac(every5(0, 60, "io.readwise.read", nil))
	for _, iv := range m {
		if iv.Source != "reader" {
			t.Errorf("Reader app source %s", iv.Source)
		}
	}
}

func TestSampleMacRuns(t *testing.T) {
	s := SampleMac()
	if s.At.IsZero() || s.Idle < 0 {
		t.Errorf("%+v", s)
	}
	t.Logf("front app %q, idle %s, locked %v", s.Bundle, s.Idle, s.Locked)
}
