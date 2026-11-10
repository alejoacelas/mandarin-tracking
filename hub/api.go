package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	maxBatch       = 500
	maxIntervalLen = 12 * time.Hour
	maxFuture      = 5 * time.Minute
	maxMeta        = 4096
	earliestMs     = 1577836800000 // 2020-01-01
	wrongCodeLimit = 10            // wrong pairing codes before the code changes
)

var validSources = map[string]bool{"youtube": true, "reader": true, "pleco": true, "llm": true, "app": true}
var validLanguages = map[string]bool{"zh": true, "other": true, "unknown": true}

type Server struct {
	St             *Store
	Now            func() time.Time
	Loc            *time.Location
	Port           int
	Version        string
	KickClassifier func()                   // wakes the YouTube channel labeller
	KickReader     func()                   // wakes the Reader poller
	CheckRead      func(token string) error // validates a Readwise token
	mu             sync.Mutex
	wrongCode      int
}

func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /api/v1/pair", s.pair)
	m.HandleFunc("POST /api/v1/pair-extension", s.pairExtension)
	m.HandleFunc("POST /api/v1/intervals", s.auth(s.intervals))
	m.HandleFunc("POST /api/v1/chat-messages", s.auth(s.chatMessages))
	m.HandleFunc("POST /api/v1/problems", s.auth(s.problems))
	m.HandleFunc("POST /api/v1/heartbeat", s.auth(s.heartbeat))
	m.HandleFunc("GET /api/v1/summary", s.summaryHandler)
	m.HandleFunc("GET /api/v1/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": s.Version})
	})
	// The dashboard and its controls answer only the Mac itself.
	m.HandleFunc("GET /{$}", s.local(s.dashboardPage))
	m.HandleFunc("GET /api/v1/dashboard", s.local(s.dashboard))
	m.HandleFunc("GET /app-qr.png", s.local(s.appQR))
	m.HandleFunc("POST /api/v1/settings", s.local(s.settings))
	m.HandleFunc("POST /api/v1/channel-label", s.local(s.channelLabel))
	m.HandleFunc("POST /api/v1/forget-device", s.local(s.forgetDevice))
	return m
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		fail(w, 400, "couldn't read the request")
		return false
	}
	if err := json.Unmarshal(body, v); err != nil {
		fail(w, 400, "invalid JSON: "+err.Error())
		return false
	}
	return true
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// local allows only requests from this Mac, addressed to the hub by its loopback name (which
// stops DNS-rebinding pages), and for writes only from the dashboard itself.
func (s *Server) local(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hostOK := r.Host == fmt.Sprintf("127.0.0.1:%d", s.Port) || r.Host == fmt.Sprintf("localhost:%d", s.Port)
		if !isLoopback(r) || !hostOK {
			fail(w, 403, "the dashboard is only available on the Mac, at http://127.0.0.1:"+fmt.Sprint(s.Port))
			return
		}
		if r.Method != "GET" {
			o := r.Header.Get("Origin")
			if o != "http://"+r.Host {
				fail(w, 403, "bad origin")
				return
			}
		}
		h(w, r)
	}
}

type ctxKey struct{}

func (s *Server) auth(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		dev := s.St.DeviceForToken(tok)
		if dev == "" {
			fail(w, 401, "unknown token; pair again")
			return
		}
		if err := s.St.Touch(dev, s.Now().UnixMilli(), "", ""); err != nil {
			log.Printf("touch %s: %v", dev, err)
		}
		h(w, r, dev)
	}
}

// PairCode returns the current pairing code, creating one if needed.
func (s *Server) PairCode() string {
	c := s.St.Get("pair_code")
	if c == "" {
		c = newCode()
		_ = s.St.Set("pair_code", c)
	}
	return c
}

func newCode() string {
	b := randomHex(4)
	var n uint32
	fmt.Sscanf(b, "%x", &n)
	return fmt.Sprintf("%06d", n%1000000)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var req struct{ Code, DeviceName, Kind string }
	var raw struct {
		Code       string `json:"code"`
		DeviceName string `json:"device_name"`
		Kind       string `json:"kind"`
	}
	if !readBody(w, r, &raw) {
		return
	}
	req.Code, req.DeviceName, req.Kind = strings.TrimSpace(raw.Code), raw.DeviceName, raw.Kind
	s.mu.Lock()
	defer s.mu.Unlock()
	if req.Code == "" || req.Code != s.PairCode() {
		s.wrongCode++
		if s.wrongCode >= wrongCodeLimit {
			_ = s.St.Set("pair_code", newCode())
			s.wrongCode = 0
		}
		fail(w, 403, "wrong pairing code")
		return
	}
	s.wrongCode = 0
	s.addDevice(w, req.DeviceName, req.Kind)
	_ = s.St.Set("pair_code", newCode())
}

func (s *Server) pairExtension(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r) || !strings.HasPrefix(r.Header.Get("Origin"), "chrome-extension://") {
		fail(w, 403, "only the Chrome extension on this Mac can pair this way")
		return
	}
	var raw struct {
		DeviceName string `json:"device_name"`
	}
	if !readBody(w, r, &raw) {
		return
	}
	s.addDevice(w, raw.DeviceName, "chrome")
}

func (s *Server) addDevice(w http.ResponseWriter, name, kind string) {
	if kind == "" {
		kind = "device"
	}
	kind = strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, strings.ToLower(kind))
	if name == "" {
		name = kind
	}
	if len(name) > 80 {
		name = name[:80]
	}
	id, tok, err := s.St.AddDevice(name, kind, s.Now().UnixMilli())
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"token": tok, "device_id": id})
}

// validate checks one interval against the protocol.
func (s *Server) validate(iv *Interval, raw json.RawMessage) string {
	now := s.Now().UnixMilli()
	switch {
	case iv.ID == "" || len(iv.ID) > 128:
		return "id must be 1-128 characters"
	case !validSources[iv.Source]:
		return "unknown source " + iv.Source
	case !validLanguages[iv.Language]:
		return "unknown language " + iv.Language
	case iv.App == "":
		return "app is required"
	case iv.EndMs <= iv.StartMs:
		return "end_ms must be after start_ms"
	case iv.StartMs < earliestMs:
		return "start_ms is before 2020"
	case iv.EndMs-iv.StartMs > maxIntervalLen.Milliseconds():
		return "interval longer than 12 hours"
	case iv.EndMs > now+maxFuture.Milliseconds():
		return "interval ends in the future (check the device clock)"
	case iv.ZhShare != nil && (*iv.ZhShare < 0 || *iv.ZhShare > 1):
		return "zh_share must be between 0 and 1"
	}
	var m struct {
		Meta json.RawMessage `json:"meta"`
	}
	_ = json.Unmarshal(raw, &m)
	if len(m.Meta) > 0 && string(m.Meta) != "null" {
		if len(m.Meta) > maxMeta {
			return "meta larger than 4 KB"
		}
		ms := string(m.Meta)
		iv.Meta = &ms
	}
	return ""
}

func (s *Server) intervals(w http.ResponseWriter, r *http.Request, dev string) {
	var req struct {
		Intervals []json.RawMessage `json:"intervals"`
	}
	if !readBody(w, r, &req) {
		return
	}
	if len(req.Intervals) > maxBatch {
		fail(w, 413, fmt.Sprintf("at most %d intervals per call", maxBatch))
		return
	}
	type rej struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	}
	rejected := []rej{}
	var ok []Interval
	for _, raw := range req.Intervals {
		var iv Interval
		if err := json.Unmarshal(raw, &iv); err != nil {
			rejected = append(rejected, rej{"", "malformed interval: " + err.Error()})
			continue
		}
		if why := s.validate(&iv, raw); why != "" {
			rejected = append(rejected, rej{iv.ID, why})
			continue
		}
		iv.DeviceID = dev
		ok = append(ok, iv)
	}
	now := s.Now().UnixMilli()
	if err := s.St.UpsertIntervals(ok, now); err != nil {
		fail(w, 500, "couldn't save: "+err.Error())
		return
	}
	newChannel := false
	for _, iv := range ok {
		if iv.Source == "youtube" && str(iv.ChannelName) != "" {
			if err := s.St.NoteChannel(str(iv.ChannelName), str(iv.ChannelID), now); err != nil {
				log.Printf("note channel: %v", err)
			}
			newChannel = true
		}
	}
	if newChannel && s.KickClassifier != nil {
		s.KickClassifier()
	}
	if len(rejected) > 0 {
		log.Printf("%s: rejected %d intervals, first: %s", dev, len(rejected), rejected[0].Reason)
	}
	writeJSON(w, 200, map[string]any{"accepted": len(ok), "rejected": rejected})
}

func (s *Server) chatMessages(w http.ResponseWriter, r *http.Request, dev string) {
	var req struct {
		Messages []ChatMessage `json:"messages"`
	}
	if !readBody(w, r, &req) {
		return
	}
	var ok []ChatMessage
	for _, m := range req.Messages {
		if (m.Service != "chatgpt" && m.Service != "claude") || m.MessageID == "" || m.AtMs < earliestMs ||
			m.ZhShare < 0 || m.ZhShare > 1 || m.Units < 0 {
			continue
		}
		ok = append(ok, m)
	}
	if err := s.St.UpsertChatMessages(ok); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]int{"accepted": len(ok)})
}

func (s *Server) problems(w http.ResponseWriter, r *http.Request, dev string) {
	var req struct {
		Component string `json:"component"`
		Message   string `json:"message"`
		Resolved  bool   `json:"resolved"`
	}
	if !readBody(w, r, &req) {
		return
	}
	if req.Component == "" {
		fail(w, 400, "component is required")
		return
	}
	msg := req.Message
	if req.Resolved {
		msg = ""
	} else if msg == "" {
		msg = "Something went wrong (no details given)."
	}
	if len(msg) > 1000 {
		msg = msg[:1000]
	}
	if err := s.St.SetProblem(dev, req.Component, msg, s.Now().UnixMilli()); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) heartbeat(w http.ResponseWriter, r *http.Request, dev string) {
	var req struct {
		Version     string          `json:"version"`
		Permissions json.RawMessage `json:"permissions"`
	}
	if !readBody(w, r, &req) {
		return
	}
	perms := "{}"
	if len(req.Permissions) > 0 && len(req.Permissions) < 4096 {
		perms = string(req.Permissions)
	}
	v := req.Version
	if v == "" {
		v = "?"
	}
	if err := s.St.Touch(dev, s.Now().UnixMilli(), v, perms); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// summaryHandler answers paired clients, and the dashboard on this Mac.
func (s *Server) summaryHandler(w http.ResponseWriter, r *http.Request) {
	tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if s.St.DeviceForToken(tok) == "" && !isLoopback(r) {
		fail(w, 401, "unknown token; pair again")
		return
	}
	days := 7
	fmt.Sscanf(r.URL.Query().Get("days"), "%d", &days)
	days = min(max(days, 1), 366)
	sum, err := s.Summary(days)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, sum)
}

type SummaryResp struct {
	Days     []DaySummary `json:"days"`
	Warnings []string     `json:"warnings"`
}

func (s *Server) Summary(days int) (*SummaryResp, error) {
	now := s.Now()
	y, m, d := now.In(s.Loc).Date()
	from := time.Date(y, m, d-days+1, 0, 0, 0, 0, s.Loc).UnixMilli()
	ivs, err := s.St.IntervalsBetween(from, now.UnixMilli()+1)
	if err != nil {
		return nil, err
	}
	res, err := s.resolver(from, now.UnixMilli())
	if err != nil {
		return nil, err
	}
	names := map[string]string{ReaderAPIDevice: "Reader (any device)", MacAppsDevice: "Mac apps"}
	devs, _ := s.St.Devices()
	for _, d := range devs {
		names[d.ID] = d.Name
	}
	for _, iv := range ivs {
		if _, ok := names[iv.DeviceID]; !ok {
			names[iv.DeviceID] = "Removed device"
		}
	}
	return &SummaryResp{Days: Summarize(ivs, res, now, days, s.Loc, names), Warnings: s.Warnings()}, nil
}

func (s *Server) resolver(from, to int64) (*Resolver, error) {
	labels, err := s.St.ChannelLabels()
	if err != nil {
		return nil, err
	}
	msgs, err := s.St.ChatMessagesBetween(from-chatSlackMs, to+chatSlackMs)
	if err != nil {
		return nil, err
	}
	chats := map[string][]ChatMessage{}
	for _, m := range msgs {
		chats[m.Service] = append(chats[m.Service], m)
	}
	all, err := s.St.IntervalsBetween(from, to+1)
	if err != nil {
		return nil, err
	}
	var rapi []Interval
	for _, iv := range all {
		if iv.DeviceID == ReaderAPIDevice {
			rapi = append(rapi, iv)
		}
	}
	return &Resolver{Channels: labels, Chats: chats, ReaderAPI: rapi}, nil
}
