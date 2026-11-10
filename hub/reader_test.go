package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeReadwise serves /api/v3/list/ from a mutable set of documents.
type fakeReadwise struct {
	mu       sync.Mutex
	docs     []apiDoc
	html     map[string]string
	status   int // if set, every call returns it
	pageSize int
	calls    int
	measured int
}

func (f *fakeReadwise) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if r.Header.Get("Authorization") != "Token good" {
		w.WriteHeader(401)
		return
	}
	if r.URL.Path == "/api/v2/auth/" {
		w.WriteHeader(204)
		return
	}
	if f.status != 0 {
		if f.status == 429 {
			w.Header().Set("Retry-After", "7")
		}
		w.WriteHeader(f.status)
		return
	}
	q := r.URL.Query()
	var res []apiDoc
	if id := q.Get("id"); id != "" {
		f.measured++
		for _, d := range f.docs {
			if d.ID == id {
				h := f.html[id]
				d.HTMLContent = &h
				res = append(res, d)
			}
		}
	} else {
		for _, d := range f.docs {
			if d.UpdatedAt > q.Get("updatedAfter") {
				res = append(res, d)
			}
		}
	}
	start := 0
	if c := q.Get("pageCursor"); c != "" {
		json.Unmarshal([]byte(c), &start)
	}
	var next *string
	if f.pageSize > 0 && len(res) > start+f.pageSize {
		n, _ := json.Marshal(start + f.pageSize)
		s := string(n)
		next = &s
		res = res[start : start+f.pageSize]
	} else {
		res = res[start:]
	}
	if len(res) == 0 && q.Get("id") == "" && len(f.docs) == 0 {
		w.WriteHeader(404)
		return
	}
	json.NewEncoder(w).Encode(apiPage{Results: res, NextPageCursor: next})
}

func (f *fakeReadwise) set(id, title, updated, opened string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t := title
	var op *string
	if opened != "" {
		op = &opened
	}
	for i := range f.docs {
		if f.docs[i].ID == id {
			f.docs[i].UpdatedAt, f.docs[i].LastOpenedAt = updated, op
			return
		}
	}
	f.docs = append(f.docs, apiDoc{ID: id, Title: &t, UpdatedAt: updated, LastOpenedAt: op})
}

func newFakeReader(t *testing.T) (*fakeReadwise, *Reader) {
	f := &fakeReadwise{html: map[string]string{}}
	s := httptest.NewServer(f)
	t.Cleanup(s.Close)
	return f, &Reader{Base: s.URL, Client: s.Client()}
}

const zhText = "<p>我最近在学习中文，每天都会和老师练习口语。你觉得我应该先学汉字还是先练习听力？其实我更喜欢看视频学习。</p>"
const enText = "<p>I have been thinking about how to plan the project timeline and which tasks come first, and then some more words here.</p>"

func ts(base time.Time, sec int) string { return base.Add(time.Duration(sec) * time.Second).UTC().Format(time.RFC3339Nano) }

func TestReaderFirstPollDoesNotCountHistory(t *testing.T) {
	f, r := newFakeReader(t)
	base := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	f.set("a", "旧文章", ts(base, 0), ts(base, 0))
	f.html["a"] = zhText
	st, _, err := r.Poll(context.Background(), "good", ReaderState{}, base.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Events) != 0 || len(ReaderIntervals(st)) != 0 {
		t.Fatalf("first poll recorded events: %+v", st.Events)
	}
	if f.measured != 0 {
		t.Fatalf("first poll fetched %d documents' text; it should fetch none, to spare a large library", f.measured)
	}
}

func TestReaderSessionAndLanguage(t *testing.T) {
	f, r := newFakeReader(t)
	base := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	f.set("zh", "中文文章", ts(base, -3600), "")
	f.set("en", "English article", ts(base, -3600), "")
	f.html["zh"], f.html["en"] = zhText, enText
	ctx := context.Background()
	st, _, _ := r.Poll(ctx, "good", ReaderState{}, base)
	// Open the Chinese doc and save progress every 30 s for 3 minutes.
	f.set("zh", "中文文章", ts(base, 1), ts(base, 0))
	st, wait, err := r.Poll(ctx, "good", st, base.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if wait != readerActivePoll {
		t.Fatalf("wait = %s while reading, want %s", wait, readerActivePoll)
	}
	for s := 30; s <= 180; s += 30 {
		f.set("zh", "中文文章", ts(base, s), ts(base, 0))
		if st, _, err = r.Poll(ctx, "good", st, base.Add(time.Duration(s+1)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	// Then an English doc, 20 minutes later.
	f.set("en", "English article", ts(base, 1500), ts(base, 1500))
	st, _, _ = r.Poll(ctx, "good", st, base.Add(1501*time.Second))
	ivs := ReaderIntervals(st)
	var zh, other int64
	for _, iv := range ivs {
		switch iv.Language {
		case "zh":
			zh += iv.EndMs - iv.StartMs
		case "other":
			other += iv.EndMs - iv.StartMs
		}
	}
	if zh != (180+45)*1000 {
		t.Errorf("Mandarin reading = %d ms, want %d", zh, (180+45)*1000)
	}
	if other != 45*1000 {
		t.Errorf("English reading = %d ms, want 45000 (open and save at the same moment, then the tail)", other)
	}
	// Recomputing gives the same ids, so saving twice replaces rather than duplicates.
	again := ReaderIntervals(st)
	if len(again) != len(ivs) || again[0].ID != ivs[0].ID {
		t.Error("interval ids aren't stable across recomputation")
	}
	_, wait, _ = r.Poll(ctx, "good", st, base.Add(3*time.Hour))
	if wait != readerIdlePoll {
		t.Errorf("wait = %s when idle, want %s", wait, readerIdlePoll)
	}
}

func TestReaderPaginationHighlightsAndEmptyLibrary(t *testing.T) {
	f, r := newFakeReader(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	st, _, err := r.Poll(ctx, "good", ReaderState{}, base) // empty library: 404
	if err != nil {
		t.Fatalf("empty library: %v", err)
	}
	f.pageSize = 2
	for i, id := range []string{"a", "b", "c", "d", "e"} {
		f.set(id, "文章", ts(base, i), "")
		f.html[id] = zhText
	}
	parent := "a"
	f.docs = append(f.docs, apiDoc{ID: "h", UpdatedAt: ts(base, 9), ParentID: &parent})
	st, _, err = r.Poll(ctx, "good", st, base.Add(10*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(st.Events) != 5 {
		t.Fatalf("got %d events across pages, want 5 (highlight skipped)", len(st.Events))
	}
	if _, ok := st.Docs["h"]; ok {
		t.Error("a highlight was recorded as a document")
	}
}

func TestReaderErrors(t *testing.T) {
	f, r := newFakeReader(t)
	ctx := context.Background()
	if _, _, err := r.Poll(ctx, "bad", ReaderState{}, time.Now()); !errors.As(err, new(AuthError)) {
		t.Errorf("bad token: got %v, want AuthError", err)
	}
	if err := r.CheckToken(ctx, "bad"); !errors.As(err, new(AuthError)) {
		t.Errorf("CheckToken bad: %v", err)
	}
	if err := r.CheckToken(ctx, "good"); err != nil {
		t.Errorf("CheckToken good: %v", err)
	}
	f.status = 429
	var rl RateLimitError
	if _, _, err := r.Poll(ctx, "good", ReaderState{}, time.Now()); !errors.As(err, &rl) || rl.Wait != 7*time.Second {
		t.Errorf("rate limit: got %v", err)
	}
	f.status = 500
	if _, _, err := r.Poll(ctx, "good", ReaderState{}, time.Now()); err == nil {
		t.Error("500 wasn't an error")
	}
	// Unreachable server.
	dead := &Reader{Base: "http://127.0.0.1:1", Client: http.DefaultClient}
	if _, _, err := dead.Poll(ctx, "good", ReaderState{}, time.Now()); err == nil || !strings.Contains(err.Error(), "couldn't reach") {
		t.Errorf("unreachable: %v", err)
	}
}

func TestReaderMeasureFailureIsRetried(t *testing.T) {
	f, r := newFakeReader(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	f.set("a", "文章", ts(base, 0), "")
	st, _, _ := r.Poll(ctx, "good", ReaderState{}, base)
	f.set("a", "文章", ts(base, 30), ts(base, 29))
	f.status = 500
	st2, _, err := r.Poll(ctx, "good", st, base.Add(31*time.Second))
	if err == nil {
		t.Fatal("expected an error")
	}
	f.status = 0
	f.html["a"] = zhText
	st3, _, err := r.Poll(ctx, "good", st2, base.Add(60*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if len(st3.Events) != 2 || !st3.Docs["a"].Known {
		t.Fatalf("document wasn't picked up after the failure: %+v", st3)
	}
}

// Replays API snapshots recorded in v1 while a script read real documents in Reader (10 s
// snapshots, with what was actually read in truth.jsonl), polling adaptively as the hub does.
func TestReaderReplayOfScriptedReading(t *testing.T) {
	type snapDoc struct {
		Title        string  `json:"title"`
		UpdatedAt    string  `json:"updated_at"`
		LastOpenedAt *string `json:"last_opened_at"`
	}
	type snap struct {
		T    float64            `json:"t"`
		Docs map[string]snapDoc `json:"docs"`
	}
	var snaps []snap
	fh, err := os.Open("testdata/readwise/runs/poll.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 1<<20), 1<<22)
	for sc.Scan() {
		var s snap
		if json.Unmarshal(sc.Bytes(), &s) == nil && s.Docs != nil {
			snaps = append(snaps, s)
		}
	}
	type truth struct {
		Scenario   string  `json:"scenario"`
		Start, End float64 `json:"start"`
	}
	var scen []struct {
		Scenario   string  `json:"scenario"`
		Start, End float64 `json:"-"`
		S          float64 `json:"start"`
		E          float64 `json:"end"`
	}
	tb, _ := os.ReadFile("testdata/readwise/runs/truth.jsonl")
	for _, l := range strings.Split(strings.TrimSpace(string(tb)), "\n") {
		var x struct {
			Scenario string  `json:"scenario"`
			S        float64 `json:"start"`
			E        float64 `json:"end"`
		}
		json.Unmarshal([]byte(l), &x)
		if x.Scenario == "probe" || x.Scenario == "js_scroll_8min" {
			continue // no input events, so Reader stopped syncing; not reading the API can see
		}
		scen = append(scen, struct {
			Scenario   string  `json:"scenario"`
			Start, End float64 `json:"-"`
			S          float64 `json:"start"`
			E          float64 `json:"end"`
		}{Scenario: x.Scenario, S: x.S, E: x.E})
	}
	html := map[string]string{}
	files, _ := filepath.Glob("testdata/readwise/fixtures/*.html")
	h1 := regexp.MustCompile(`(?s)<h1>(.*?)</h1>`)
	for _, p := range files {
		b, _ := os.ReadFile(p)
		title := []rune(h1.FindStringSubmatch(string(b))[1])
		html[string(title[:4])] = string(b)
	}

	var cur snap
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var res []apiDoc
		for id, d := range cur.Docs {
			d := d
			if q.Get("id") != "" && q.Get("id") != id {
				continue
			}
			if q.Get("id") == "" && d.UpdatedAt <= q.Get("updatedAfter") {
				continue
			}
			title := d.Title
			h := html[string([]rune(title)[:4])]
			res = append(res, apiDoc{ID: id, Title: &title, UpdatedAt: d.UpdatedAt, LastOpenedAt: d.LastOpenedAt, HTMLContent: &h})
		}
		json.NewEncoder(w).Encode(apiPage{Results: res})
	}))
	defer srv.Close()
	r := &Reader{Base: srv.URL, Client: srv.Client()}

	start := math.Inf(1)
	var actual float64
	for _, s := range scen {
		start = math.Min(start, s.S)
		actual += s.E - s.S
	}
	start -= 30
	var st ReaderState
	tnow := snaps[0].T
	for _, s := range snaps {
		if s.T >= start-120 {
			tnow = s.T
			break
		}
	}
	for {
		idx := -1
		for i, s := range snaps {
			if s.T >= tnow {
				idx = i
				break
			}
		}
		if idx < 0 {
			break
		}
		cur = snaps[idx]
		at := time.UnixMilli(int64(cur.T * 1000))
		next, wait, err := r.Poll(context.Background(), "x", st, at)
		if err != nil {
			t.Fatal(err)
		}
		st = next
		tnow = cur.T + wait.Seconds() - 2
	}
	var credited float64
	for _, iv := range ReaderIntervals(st) {
		if float64(iv.StartMs) >= start*1000 && iv.Language == "zh" {
			credited += float64(iv.EndMs-iv.StartMs) / 1000
		}
	}
	if math.Abs(credited-actual)/actual > 0.15 {
		t.Fatalf("credited %.0f s, actual %.0f s (more than 15%% off)", credited, actual)
	}
	t.Logf("credited %.0f s, actual %.0f s", credited, actual)
}
