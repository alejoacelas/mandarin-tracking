package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeAnthropic struct {
	mu      sync.Mutex
	replies []func(w http.ResponseWriter, body map[string]any)
	calls   int
	bodies  []map[string]any
}

func (f *fakeAnthropic) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := io.ReadAll(r.Body)
	var body map[string]any
	json.Unmarshal(b, &body)
	f.bodies = append(f.bodies, body)
	i := min(f.calls, len(f.replies)-1)
	f.calls++
	if r.Header.Get("x-api-key") != "sk-ant-test" {
		w.WriteHeader(401)
		w.Write([]byte(`{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`))
		return
	}
	f.replies[i](w, body)
}

func answer(label string) func(http.ResponseWriter, map[string]any) {
	return func(w http.ResponseWriter, _ map[string]any) {
		txt, _ := json.Marshal(map[string]string{"label": label, "confidence": "high", "mandarin_share": "90%", "reason": "Videos are narrated in Mandarin."})
		json.NewEncoder(w).Encode(map[string]any{"stop_reason": "end_turn", "content": []any{
			map[string]any{"type": "server_tool_use", "id": "x", "name": "web_search", "input": map[string]any{}},
			map[string]any{"type": "text", "text": string(txt)},
		}})
	}
}

func status(code int) func(http.ResponseWriter, map[string]any) {
	return func(w http.ResponseWriter, _ map[string]any) {
		w.WriteHeader(code)
		w.Write([]byte(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`))
	}
}

func newClassifier(t *testing.T, f *fakeAnthropic) *Classifier {
	s := httptest.NewServer(f)
	t.Cleanup(s.Close)
	return &Classifier{Base: s.URL, Client: s.Client()}
}

func storeWithChannel(t *testing.T, name, title string) *Store {
	th := newHub(t)
	tok := th.pairPhone()
	now := th.now.UnixMilli()
	b, _ := json.Marshal(map[string]any{"intervals": []any{map[string]any{"id": "1", "source": "youtube", "start_ms": now - 60000, "end_ms": now, "language": "unknown", "app": "x", "title": title, "channel_name": name}}})
	th.do(req{path: "/api/v1/intervals", token: tok, body: string(b)})
	return th.srv.St
}

func label(t *testing.T, st *Store) Channel {
	cs, _ := st.Channels("")
	if len(cs) != 1 {
		t.Fatalf("%d channels", len(cs))
	}
	return cs[0]
}

func TestClassifyWithClaude(t *testing.T) {
	st := storeWithChannel(t, "老高與小茉 Mr & Mrs Gao", "宇宙的盡頭是什麼")
	f := &fakeAnthropic{replies: []func(http.ResponseWriter, map[string]any){answer("mandarin")}}
	if err := ClassifyPending(context.Background(), st, newClassifier(t, f), "sk-ant-test", time.Now); err != nil {
		t.Fatal(err)
	}
	c := label(t, st)
	if c.Label != "mandarin" || c.DecidedBy != "claude" || !strings.Contains(c.Reason, "90%") {
		t.Errorf("%+v", c)
	}
	prompt := f.bodies[0]["messages"].([]any)[0].(map[string]any)["content"].(string)
	if !strings.Contains(prompt, "老高與小茉") || !strings.Contains(prompt, "宇宙的盡頭是什麼") {
		t.Errorf("prompt lacks the channel or title: %s", prompt)
	}
	// Labelled channels aren't asked about again.
	ClassifyPending(context.Background(), st, newClassifier(t, f), "sk-ant-test", time.Now)
	if f.calls != 1 {
		t.Errorf("asked %d times", f.calls)
	}
}

func TestClassifyPauseTurnResumes(t *testing.T) {
	st := storeWithChannel(t, "Some Channel", "A video")
	pause := func(w http.ResponseWriter, _ map[string]any) {
		json.NewEncoder(w).Encode(map[string]any{"stop_reason": "pause_turn", "content": []any{map[string]any{"type": "text", "text": "searching"}}})
	}
	f := &fakeAnthropic{replies: []func(http.ResponseWriter, map[string]any){pause, answer("other")}}
	if err := ClassifyPending(context.Background(), st, newClassifier(t, f), "sk-ant-test", time.Now); err != nil {
		t.Fatal(err)
	}
	if label(t, st).Label != "other" || f.calls != 2 {
		t.Errorf("label %s after %d calls", label(t, st).Label, f.calls)
	}
	msgs := f.bodies[1]["messages"].([]any)
	if len(msgs) != 2 || msgs[1].(map[string]any)["role"] != "assistant" {
		t.Errorf("resume didn't resend the paused turn: %v", msgs)
	}
}

func TestClassifyFailuresFallBackToTitlesVisibly(t *testing.T) {
	st := storeWithChannel(t, "老高與小茉", "宇宙的盡頭是什麼")
	f := &fakeAnthropic{replies: []func(http.ResponseWriter, map[string]any){status(529)}}
	c := newClassifier(t, f)
	for i := 1; i <= maxClassifyAttempts; i++ {
		err := ClassifyPending(context.Background(), st, c, "sk-ant-test", time.Now)
		if err == nil || !strings.Contains(err.Error(), "529") {
			t.Fatalf("attempt %d: %v", i, err)
		}
		ch := label(t, st)
		if i < maxClassifyAttempts && ch.Label != "pending" {
			t.Fatalf("labelled after %d failures: %+v", i, ch)
		}
	}
	ch := label(t, st)
	if ch.Label != "mandarin" || ch.DecidedBy != "titles" || !strings.Contains(ch.Reason, "529") {
		t.Errorf("after 3 failures: %+v", ch)
	}
	calls := f.calls
	ClassifyPending(context.Background(), st, c, "sk-ant-test", time.Now)
	if f.calls != calls {
		t.Error("kept calling after giving up")
	}
}

func TestClassifyRefusalBadJSONAndBadLabel(t *testing.T) {
	for name, reply := range map[string]func(http.ResponseWriter, map[string]any){
		"refusal": func(w http.ResponseWriter, _ map[string]any) {
			json.NewEncoder(w).Encode(map[string]any{"stop_reason": "refusal", "content": []any{}})
		},
		"badjson": func(w http.ResponseWriter, _ map[string]any) {
			json.NewEncoder(w).Encode(map[string]any{"stop_reason": "end_turn", "content": []any{map[string]any{"type": "text", "text": "I think Mandarin"}}})
		},
		"badlabel": answer("cantonese"),
		"html":     func(w http.ResponseWriter, _ map[string]any) { w.WriteHeader(502); w.Write([]byte("<html>bad gateway</html>")) },
		"authfail": nil,
	} {
		t.Run(name, func(t *testing.T) {
			st := storeWithChannel(t, "X", "y")
			f := &fakeAnthropic{replies: []func(http.ResponseWriter, map[string]any){reply}}
			key := "sk-ant-test"
			if reply == nil {
				key = "sk-ant-wrong"
			}
			if err := ClassifyPending(context.Background(), st, newClassifier(t, f), key, time.Now); err == nil {
				t.Error("no error")
			}
			if label(t, st).Label != "pending" {
				t.Error("labelled despite the failure")
			}
		})
	}
}

func TestClassifyWithoutKeyUsesTitles(t *testing.T) {
	st := storeWithChannel(t, "Learn English with Bob", "Ten phrasal verbs for work")
	if err := ClassifyPending(context.Background(), st, nil, "", time.Now); err != nil {
		t.Fatal(err)
	}
	if c := label(t, st); c.Label != "other" || c.DecidedBy != "titles" {
		t.Errorf("%+v", c)
	}
	// Adding a key later asks Claude about title-labelled channels.
	f := &fakeAnthropic{replies: []func(http.ResponseWriter, map[string]any){answer("mixed")}}
	ClassifyPending(context.Background(), st, newClassifier(t, f), "sk-ant-test", time.Now)
	if c := label(t, st); c.Label != "mixed" || c.DecidedBy != "claude" {
		t.Errorf("after adding a key: %+v", c)
	}
	// A user's choice is never overwritten.
	st.SetChannelLabel(label(t, st).Key, "mandarin", "you", "", 0)
	ClassifyPending(context.Background(), st, newClassifier(t, f), "sk-ant-test", time.Now)
	if c := label(t, st); c.Label != "mandarin" {
		t.Errorf("user label overwritten: %+v", c)
	}
}

func TestHeuristicLabel(t *testing.T) {
	if l, _ := HeuristicLabel("x", nil); l != "" {
		t.Error("labelled with no titles")
	}
	if l, _ := HeuristicLabel("每日新闻", []string{"今天的天气很好"}); l != "mandarin" {
		t.Error(l)
	}
	if l, _ := HeuristicLabel("NHK", []string{"東京のニュースをお伝えします"}); l != "other" {
		t.Error("Japanese titles counted as Mandarin")
	}
}
