package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"
)

//go:embed dashboard.html
var dashboardHTML []byte

const silentAfter = 24 * time.Hour

var permissionNames = map[string]string{
	"usage_access":          "Usage access",
	"notification_access":   "Notification access (for YouTube)",
	"accessibility":         "Accessibility (for the language of chats and reading)",
	"battery_unrestricted":  "Unrestricted battery use",
	"history_chatgpt":       "signed in to chatgpt.com",
	"history_claude":        "signed in to claude.ai",
}

func (s *Server) dashboardPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(dashboardHTML)
}

func ago(now time.Time, ms int64) string {
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < 2*time.Minute:
		return "just now"
	case d < 2*time.Hour:
		return fmt.Sprintf("%d minutes ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours ago", int(d.Hours()))
	}
	return fmt.Sprintf("%d days ago", int(d.Hours()/24))
}

// Warnings lists what needs attention, most important first.
func (s *Server) Warnings() []string {
	now := s.Now()
	var w []string
	devs, _ := s.St.Devices()
	names := map[string]string{"hub": "Hub"}
	has := map[string]bool{}
	for _, d := range devs {
		names[d.ID] = d.Name
		has[d.Kind] = true
		if now.Sub(time.UnixMilli(d.LastSeenMs)) > silentAfter {
			hint := ""
			if d.Kind == "android" {
				hint = " Time on the phone is kept there and arrives once the phone and this Mac are on the same Wi-Fi. If that's already the case, open the app on the phone to see what's wrong."
			} else if d.Kind == "chrome" {
				hint = " Chrome may not have been opened, or the extension may be turned off in chrome://extensions."
			}
			w = append(w, fmt.Sprintf("%s was last in touch %s.%s", d.Name, ago(now, d.LastSeenMs), hint))
		}
		var perms map[string]bool
		_ = json.Unmarshal([]byte(d.Permissions), &perms)
		var missing []string
		for k, v := range perms {
			if !v {
				n := permissionNames[k]
				if n == "" {
					n = k
				}
				missing = append(missing, n)
			}
		}
		sort.Strings(missing)
		if len(missing) > 0 {
			w = append(w, fmt.Sprintf("%s is missing: %s.", d.Name, strings.Join(missing, ", ")))
		}
	}
	if !has["android"] {
		w = append(w, fmt.Sprintf("No phone is connected yet. Install the Android app and enter the code %s.", s.PairCode()))
	}
	if !has["chrome"] {
		w = append(w, "The Chrome extension isn't connected yet. Load it in chrome://extensions (see the setup steps).")
	}
	probs, _ := s.St.Problems()
	for _, p := range probs {
		n := names[p.DeviceID]
		if n == "" {
			n = p.DeviceID
		}
		w = append(w, fmt.Sprintf("%s: %s (%s)", n, p.Message, ago(now, p.AtMs)))
	}
	if s.St.Get("readwise_token") == "" {
		w = append(w, "Readwise Reader isn't connected. Paste the access token from readwise.io/access_token in Settings below.")
	}
	return w
}

func lanAddresses() []string {
	var out []string
	ifs, _ := net.Interfaces()
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := i.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() {
				out = append(out, n.IP.String())
			}
		}
	}
	return out
}

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	sum, err := s.Summary(30)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	now := s.Now()
	type dev struct {
		ID, Name, Kind, Version, LastSeen string
	}
	var devs []dev
	ds, _ := s.St.Devices()
	for _, d := range ds {
		devs = append(devs, dev{d.ID, d.Name, d.Kind, d.Version, ago(now, d.LastSeenMs)})
	}
	type ch struct {
		Key, Name, Label, DecidedBy, Reason, Error string
	}
	var chs []ch
	cs, _ := s.St.Channels("")
	for i, c := range cs {
		if i == 200 {
			break
		}
		chs = append(chs, ch{c.Key, c.Name, c.Label, c.DecidedBy, c.Reason, c.LastError})
	}
	var addrs []string
	for _, a := range lanAddresses() {
		addrs = append(addrs, fmt.Sprintf("%s:%d", a, s.Port))
	}
	writeJSON(w, 200, map[string]any{
		"days": sum.Days, "warnings": sum.Warnings, "devices": devs, "channels": chs,
		"pair_code": s.PairCode(), "addresses": addrs, "version": s.Version,
		"reader_connected":  s.St.Get("readwise_token") != "",
		"anthropic_set":     s.St.Get("anthropic_key") != "",
		"reader_last_poll":  s.St.Get("reader_last_ok"),
	})
}

func (s *Server) settings(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ReadwiseToken *string `json:"readwise_token"`
		AnthropicKey  *string `json:"anthropic_key"`
	}
	if !readBody(w, r, &req) {
		return
	}
	if req.ReadwiseToken != nil {
		t := strings.TrimSpace(*req.ReadwiseToken)
		if t != "" && s.CheckRead != nil {
			if err := s.CheckRead(t); err != nil {
				fail(w, 400, err.Error())
				return
			}
		}
		if err := s.St.Set("readwise_token", t); err != nil {
			fail(w, 500, err.Error())
			return
		}
		_ = s.St.Set("reader_state", "") // start fresh with the new account
		_ = s.St.SetProblem("hub", "reader", "", 0)
	}
	if req.AnthropicKey != nil {
		k := strings.TrimSpace(*req.AnthropicKey)
		if k != "" && !strings.HasPrefix(k, "sk-ant-") {
			fail(w, 400, "That doesn't look like an Anthropic API key (they start with sk-ant-).")
			return
		}
		if err := s.St.Set("anthropic_key", k); err != nil {
			fail(w, 500, err.Error())
			return
		}
	}
	if s.Kick != nil {
		s.Kick()
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) channelLabel(w http.ResponseWriter, r *http.Request) {
	var req struct{ Key, Label string }
	if !readBody(w, r, &req) {
		return
	}
	ok := false
	for _, l := range ChannelLabels {
		ok = ok || l == req.Label
	}
	if !ok {
		fail(w, 400, "unknown label")
		return
	}
	if err := s.St.SetChannelLabel(req.Key, req.Label, "you", "Set on the dashboard.", s.Now().UnixMilli()); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) forgetDevice(w http.ResponseWriter, r *http.Request) {
	var req struct{ ID string }
	if !readBody(w, r, &req) {
		return
	}
	if err := s.St.ForgetDevice(req.ID); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
