package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testHub struct {
	t   *testing.T
	srv *Server
	h   http.Handler
	now time.Time
}

func newHub(t *testing.T) *testHub {
	st, err := OpenStore(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	th := &testHub{t: t, now: time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)}
	th.srv = &Server{St: st, Now: func() time.Time { return th.now }, Loc: time.UTC, Port: 47800, Version: "test"}
	th.h = th.srv.Handler()
	return th
}

type req struct {
	method, path, body, token, origin, host, remote string
}

func (th *testHub) do(r req) (int, map[string]any) {
	if r.method == "" {
		r.method = "POST"
	}
	hr := httptest.NewRequest(r.method, r.path, strings.NewReader(r.body))
	hr.RemoteAddr = "192.168.1.50:5555"
	if r.remote != "" {
		hr.RemoteAddr = r.remote
	}
	hr.Host = "192.168.1.10:47800"
	if r.host != "" {
		hr.Host = r.host
	}
	if r.token != "" {
		hr.Header.Set("Authorization", "Bearer "+r.token)
	}
	if r.origin != "" {
		hr.Header.Set("Origin", r.origin)
	}
	w := httptest.NewRecorder()
	th.h.ServeHTTP(w, hr)
	var out map[string]any
	b, _ := io.ReadAll(w.Body)
	_ = json.Unmarshal(b, &out)
	return w.Code, out
}

func (th *testHub) pairPhone() string {
	code := th.srv.PairCode()
	c, out := th.do(req{path: "/api/v1/pair", body: fmt.Sprintf(`{"code":%q,"device_name":"Pixel","kind":"android"}`, code)})
	if c != 200 {
		th.t.Fatalf("pair: %d %v", c, out)
	}
	return out["token"].(string)
}

func TestPairing(t *testing.T) {
	th := newHub(t)
	code := th.srv.PairCode()
	if len(code) != 6 {
		t.Fatalf("code %q", code)
	}
	if c, _ := th.do(req{path: "/api/v1/pair", body: `{"code":"000000x"}`}); c != 403 {
		t.Errorf("wrong code: %d", c)
	}
	tok := th.pairPhone()
	if th.srv.PairCode() == code {
		t.Error("code didn't change after pairing")
	}
	if c, _ := th.do(req{path: "/api/v1/pair", body: fmt.Sprintf(`{"code":%q}`, code)}); c != 403 {
		t.Error("used code worked twice")
	}
	if c, _ := th.do(req{path: "/api/v1/heartbeat", token: tok, body: `{"version":"1"}`}); c != 200 {
		t.Errorf("token rejected: %d", c)
	}
	if c, _ := th.do(req{path: "/api/v1/heartbeat", token: "nope", body: `{}`}); c != 401 {
		t.Errorf("bad token: %d", c)
	}
	if c, _ := th.do(req{path: "/api/v1/heartbeat", body: `{}`}); c != 401 {
		t.Errorf("no token: %d", c)
	}
	// Guessing changes the code after 10 wrong tries.
	before := th.srv.PairCode()
	for i := 0; i < wrongCodeLimit; i++ {
		th.do(req{path: "/api/v1/pair", body: `{"code":"x"}`})
	}
	if th.srv.PairCode() == before {
		t.Error("code didn't change after repeated wrong guesses")
	}
	// Disconnecting a device revokes its token.
	var devID string
	ds, _ := th.srv.St.Devices()
	devID = ds[0].ID
	if err := th.srv.St.ForgetDevice(devID); err != nil {
		t.Fatal(err)
	}
	if c, _ := th.do(req{path: "/api/v1/heartbeat", token: tok, body: `{}`}); c != 401 {
		t.Error("forgotten device still accepted")
	}
}

func TestPairExtension(t *testing.T) {
	th := newHub(t)
	ext := "chrome-extension://abcdefghijklmnop"
	if c, _ := th.do(req{path: "/api/v1/pair-extension", body: `{}`, origin: ext}); c != 403 {
		t.Error("extension pairing from the network was accepted")
	}
	if c, _ := th.do(req{path: "/api/v1/pair-extension", body: `{}`, remote: "127.0.0.1:1", origin: "https://evil.example"}); c != 403 {
		t.Error("a website could pair as the extension")
	}
	if c, _ := th.do(req{path: "/api/v1/pair-extension", body: `{}`, remote: "127.0.0.1:1"}); c != 403 {
		t.Error("pairing without an origin was accepted")
	}
	c, out := th.do(req{path: "/api/v1/pair-extension", body: `{"device_name":"Chrome on Mac"}`, remote: "127.0.0.1:1", origin: ext})
	if c != 200 || out["token"] == nil {
		t.Fatalf("extension pairing failed: %d %v", c, out)
	}
	if c, _ := th.do(req{path: "/api/v1/pair-extension", body: `{}`, remote: "[::1]:1", origin: ext}); c != 200 {
		t.Error("IPv6 loopback refused")
	}
}

func ivJSON(id string, start, end int64, extra string) string {
	return fmt.Sprintf(`{"id":%q,"source":"pleco","start_ms":%d,"end_ms":%d,"language":"zh","app":"com.pleco.chinesesystem"%s}`, id, start, end, extra)
}

func TestIntervalValidationAndUpsert(t *testing.T) {
	th := newHub(t)
	tok := th.pairPhone()
	now := th.now.UnixMilli()
	min := int64(60000)
	cases := map[string]string{
		"ok":           ivJSON("ok", now-10*min, now-5*min, ""),
		"backwards":    ivJSON("backwards", now-5*min, now-10*min, ""),
		"zero":         ivJSON("zero", now-5*min, now-5*min, ""),
		"future":       ivJSON("future", now, now+10*min, ""),
		"old":          ivJSON("old", 1000, 2000, ""),
		"long":         ivJSON("long", now-13*60*min, now, ""),
		"badsource":    strings.Replace(ivJSON("badsource", now-2*min, now-min, ""), `"pleco"`, `"tiktok"`, 1),
		"badlang":      strings.Replace(ivJSON("badlang", now-2*min, now-min, ""), `"zh"`, `"cn"`, 1),
		"badshare":     ivJSON("badshare", now-2*min, now-min, `,"zh_share":1.5`),
		"bigmeta":      ivJSON("bigmeta", now-2*min, now-min, `,"meta":{"x":"`+strings.Repeat("a", 5000)+`"}`),
		"withmeta":     ivJSON("withmeta", now-2*min, now-min, `,"meta":{"pkg":"x"}`),
		"slightfuture": ivJSON("slightfuture", now-min, now+2*min, ""),
	}
	var parts []string
	for _, v := range cases {
		parts = append(parts, v)
	}
	parts = append(parts, `{"id":5}`, ivJSON("", now-2*min, now-min, ""))
	c, out := th.do(req{path: "/api/v1/intervals", token: tok, body: `{"intervals":[` + strings.Join(parts, ",") + `]}`})
	if c != 200 {
		t.Fatalf("%d %v", c, out)
	}
	if got := out["accepted"].(float64); got != 3 {
		t.Errorf("accepted %v, want 3 (ok, withmeta, slightfuture); rejected: %v", got, out["rejected"])
	}
	if got := len(out["rejected"].([]any)); got != 11 {
		t.Errorf("rejected %d, want 11", got)
	}
	// Re-sending with a later end replaces the interval rather than adding one.
	body := `{"intervals":[` + ivJSON("ok", now-10*min, now-min, "") + `]}`
	th.do(req{path: "/api/v1/intervals", token: tok, body: body})
	th.do(req{path: "/api/v1/intervals", token: tok, body: body})
	ivs, _ := th.srv.St.IntervalsBetween(0, now+min)
	if len(ivs) != 3 {
		t.Fatalf("%d intervals stored", len(ivs))
	}
	sum, _ := th.srv.Summary(1)
	near(t, "total", sum.Days[0].TotalMin, 10) // ok extended to now-1; slightfuture runs to now
	// A second device's identical id is a different interval.
	tok2 := th.pairPhone()
	th.do(req{path: "/api/v1/intervals", token: tok2, body: body})
	ivs, _ = th.srv.St.IntervalsBetween(0, now+min)
	if len(ivs) != 4 {
		t.Errorf("second device's interval: %d stored", len(ivs))
	}
	// Batch limit and malformed JSON.
	big := make([]string, maxBatch+1)
	for i := range big {
		big[i] = ivJSON(fmt.Sprint(i), now-2*min, now-min, "")
	}
	if c, _ := th.do(req{path: "/api/v1/intervals", token: tok, body: `{"intervals":[` + strings.Join(big, ",") + `]}`}); c != 413 {
		t.Errorf("oversized batch: %d", c)
	}
	if c, _ := th.do(req{path: "/api/v1/intervals", token: tok, body: `{"intervals":[`}); c != 400 {
		t.Errorf("malformed: %d", c)
	}
}

func TestYouTubeIntervalRegistersChannel(t *testing.T) {
	th := newHub(t)
	kicked := 0
	th.srv.KickClassifier = func() { kicked++ }
	tok := th.pairPhone()
	now := th.now.UnixMilli()
	body := fmt.Sprintf(`{"intervals":[{"id":"y","source":"youtube","start_ms":%d,"end_ms":%d,"language":"unknown","app":"com.google.android.youtube","title":"老高與小茉","channel_name":"老高與小茉 Mr & Mrs Gao"}]}`, now-600000, now)
	th.do(req{path: "/api/v1/intervals", token: tok, body: body})
	cs, _ := th.srv.St.Channels("")
	if len(cs) != 1 || cs[0].Label != "pending" || kicked != 1 {
		t.Fatalf("channels %+v kicked %d", cs, kicked)
	}
	sum, _ := th.srv.Summary(1)
	near(t, "unclassified before labelling", sum.Days[0].Unclassified, 10)
	th.srv.St.SetChannelLabel(cs[0].Key, "mandarin", "test", "", now)
	sum, _ = th.srv.Summary(1)
	near(t, "Mandarin after labelling", sum.Days[0].TotalMin, 10)
}

func TestChatMessagesProblemsHeartbeatWarnings(t *testing.T) {
	th := newHub(t)
	tok := th.pairPhone()
	now := th.now.UnixMilli()
	c, out := th.do(req{path: "/api/v1/chat-messages", token: tok, body: fmt.Sprintf(
		`{"messages":[{"service":"chatgpt","conversation_id":"c","message_id":"m1","at_ms":%d,"role":"user","zh_share":0.9,"units":40},
		{"service":"bard","conversation_id":"c","message_id":"m2","at_ms":%d,"role":"user","zh_share":0.9,"units":40}]}`, now, now)})
	if c != 200 || out["accepted"].(float64) != 1 {
		t.Errorf("chat messages: %d %v", c, out)
	}
	th.do(req{path: "/api/v1/problems", token: tok, body: `{"component":"android.usage","message":"Usage access was turned off."}`})
	th.do(req{path: "/api/v1/heartbeat", token: tok, body: `{"version":"1.0","permissions":{"usage_access":false,"notification_access":true}}`})
	w := strings.Join(th.srv.Warnings(), "\n")
	for _, want := range []string{"Usage access was turned off", "missing: Usage access", "Chrome extension isn't connected", "Reader isn't connected"} {
		if !strings.Contains(w, want) {
			t.Errorf("warnings lack %q:\n%s", want, w)
		}
	}
	if strings.Contains(w, "No phone is connected") {
		t.Error("warned about no phone with one paired")
	}
	th.do(req{path: "/api/v1/problems", token: tok, body: `{"component":"android.usage","resolved":true}`})
	if strings.Contains(strings.Join(th.srv.Warnings(), "\n"), "turned off") {
		t.Error("resolved problem still shown")
	}
	th.now = th.now.Add(25 * time.Hour)
	if !strings.Contains(strings.Join(th.srv.Warnings(), "\n"), "Pixel was last in touch 25 hours ago") {
		t.Errorf("no silence warning: %v", th.srv.Warnings())
	}
}

func TestDashboardIsLocalOnly(t *testing.T) {
	th := newHub(t)
	if c, _ := th.do(req{method: "GET", path: "/api/v1/dashboard"}); c != 403 {
		t.Error("dashboard open to the network")
	}
	// A DNS-rebinding page reaches loopback but with its own Host.
	if c, _ := th.do(req{method: "GET", path: "/api/v1/dashboard", remote: "127.0.0.1:9", host: "evil.example:47800"}); c != 403 {
		t.Error("dashboard answered a foreign Host")
	}
	if c, _ := th.do(req{method: "GET", path: "/api/v1/dashboard", remote: "127.0.0.1:9", host: "127.0.0.1:47800"}); c != 200 {
		t.Error("dashboard refused the Mac")
	}
	// Settings writes need the dashboard's own origin.
	if c, _ := th.do(req{path: "/api/v1/settings", remote: "127.0.0.1:9", host: "127.0.0.1:47800", origin: "https://evil.example", body: `{"anthropic_key":""}`}); c != 403 {
		t.Error("cross-site settings write accepted")
	}
	c, out := th.do(req{path: "/api/v1/settings", remote: "127.0.0.1:9", host: "127.0.0.1:47800", origin: "http://127.0.0.1:47800", body: `{"anthropic_key":"not-a-key"}`})
	if c != 400 {
		t.Errorf("bad key accepted: %d %v", c, out)
	}
	th.srv.CheckRead = func(tok string) error {
		if tok != "good" {
			return AuthError{}
		}
		return nil
	}
	if c, _ := th.do(req{path: "/api/v1/settings", remote: "127.0.0.1:9", host: "127.0.0.1:47800", origin: "http://127.0.0.1:47800", body: `{"readwise_token":"bad"}`}); c != 400 {
		t.Error("bad Readwise token saved")
	}
	if c, _ := th.do(req{path: "/api/v1/settings", remote: "127.0.0.1:9", host: "127.0.0.1:47800", origin: "http://127.0.0.1:47800", body: `{"readwise_token":" good "}`}); c != 200 || th.srv.St.Get("readwise_token") != "good" {
		t.Error("good Readwise token not saved")
	}
	// The summary needs a token from the network but not on the Mac.
	if c, _ := th.do(req{method: "GET", path: "/api/v1/summary"}); c != 401 {
		t.Error("summary open to the network")
	}
	if c, out := th.do(req{method: "GET", path: "/api/v1/summary?days=3", remote: "127.0.0.1:9"}); c != 200 || len(out["days"].([]any)) != 3 {
		t.Errorf("summary on the Mac: %d", c)
	}
}

func TestDashboardServesPage(t *testing.T) {
	th := newHub(t)
	hr := httptest.NewRequest("GET", "/", nil)
	hr.RemoteAddr, hr.Host = "127.0.0.1:9", "localhost:47800"
	w := httptest.NewRecorder()
	th.h.ServeHTTP(w, hr)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("<title>Mandarin Time</title>")) {
		t.Errorf("dashboard page: %d", w.Code)
	}
}
