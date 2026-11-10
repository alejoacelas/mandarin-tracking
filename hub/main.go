// Command mandarin-hub stores Mandarin time sent by the Chrome extension and the Android app,
// measures Reader and Mac app time itself, and serves the dashboard.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var version = "dev"

func defaultDataDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "Application Support", "Mandarin Tracker")
}

func main() {
	dataDir := flag.String("data", defaultDataDir(), "folder for the database")
	port := flag.Int("port", 47800, "port to listen on")
	noMac := flag.Bool("no-mac-apps", false, "don't track Mac apps")
	noBonjour := flag.Bool("no-bonjour", false, "don't advertise on the local network")
	readerBase := flag.String("readwise-url", "https://readwise.io", "Readwise API base (for tests)")
	anthropicBase := flag.String("anthropic-url", "https://api.anthropic.com", "Anthropic API base (for tests)")
	showVersion := flag.Bool("version", false, "print the version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	st, err := OpenStore(filepath.Join(*dataDir, "hub.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer st.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	kick := make(chan struct{}, 1)
	client := &http.Client{Timeout: 5 * time.Minute}
	reader := &Reader{Base: *readerBase, Client: &http.Client{Timeout: 60 * time.Second}}
	srv := &Server{
		St: st, Now: time.Now, Loc: time.Local, Port: *port, Version: version,
		Kick: func() {
			select {
			case kick <- struct{}{}:
			default:
			}
		},
		CheckRead: func(t string) error {
			c, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()
			return reader.CheckToken(c, t)
		},
	}
	srv.PairCode()

	hs := &http.Server{Addr: fmt.Sprintf(":%d", *port), Handler: srv.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := hs.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("can't listen on port %d (is another copy running?): %v", *port, err)
		}
	}()
	log.Printf("mandarin-hub %s on http://127.0.0.1:%d, data in %s", version, *port, *dataDir)

	go readerLoop(ctx, st, reader, kick)
	go classifierLoop(ctx, st, &Classifier{Base: *anthropicBase, Client: client}, kick)
	if !*noMac {
		go macLoop(ctx, st)
	}
	if !*noBonjour {
		go bonjourLoop(ctx, *port)
	}
	<-ctx.Done()
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = hs.Shutdown(sctx)
}

func readerLoop(ctx context.Context, st *Store, r *Reader, kick <-chan struct{}) {
	wait := time.Duration(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		case <-kick:
		}
		wait = readerIdlePoll
		token := st.Get("readwise_token")
		if token == "" {
			continue
		}
		var state ReaderState
		if s := st.Get("reader_state"); s != "" {
			if err := json.Unmarshal([]byte(s), &state); err != nil {
				log.Printf("reader state unreadable, starting over: %v", err)
			}
		}
		pctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		next, w, err := r.Poll(pctx, token, state, time.Now())
		cancel()
		if err != nil {
			var rl RateLimitError
			if errors.As(err, &rl) {
				wait = rl.Wait
				continue // normal under load; not a problem to show
			}
			_ = st.SetProblem("hub", "reader", "Couldn't read Readwise Reader: "+err.Error(), time.Now().UnixMilli())
			log.Printf("reader: %v", err)
			continue
		}
		wait = w
		b, _ := json.Marshal(next)
		if err := st.Set("reader_state", string(b)); err != nil {
			log.Printf("reader save: %v", err)
			continue
		}
		if err := st.UpsertIntervals(ReaderIntervals(next), time.Now().UnixMilli()); err != nil {
			log.Printf("reader intervals: %v", err)
			continue
		}
		_ = st.Set("reader_last_ok", time.Now().Format(time.RFC3339))
		_ = st.SetProblem("hub", "reader", "", 0)
	}
}

func classifierLoop(ctx context.Context, st *Store, c *Classifier, kick <-chan struct{}) {
	for {
		key := st.Get("anthropic_key")
		err := ClassifyPending(ctx, st, c, key, time.Now)
		if err != nil {
			log.Printf("classify: %v", err)
			_ = st.SetProblem("hub", "youtube", "Couldn't label a YouTube channel with Claude: "+err.Error()+". Its time shows as not yet classified until it works (it uses video titles after 3 failures).", time.Now().UnixMilli())
		} else {
			_ = st.SetProblem("hub", "youtube", "", 0)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Minute):
		case <-kick:
			// Let a burst of new intervals arrive before working.
			time.Sleep(5 * time.Second)
		}
	}
}

func macLoop(ctx context.Context, st *Store) {
	var t MacTracker
	tick := time.NewTicker(macPoll)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if iv := t.Add(SampleMac()); iv != nil {
			if err := st.UpsertIntervals([]Interval{*iv}, time.Now().UnixMilli()); err != nil {
				log.Printf("mac apps: %v", err)
			}
		}
	}
}

// bonjourLoop advertises the hub with macOS's dns-sd, restarting it if it exits.
func bonjourLoop(ctx context.Context, port int) {
	host, _ := os.Hostname()
	for ctx.Err() == nil {
		cmd := exec.CommandContext(ctx, "/usr/bin/dns-sd", "-R", "Mandarin Tracker on "+host, "_mandarintrack._tcp", "local", fmt.Sprint(port), "path=/api/v1")
		if err := cmd.Run(); err != nil && ctx.Err() == nil {
			log.Printf("bonjour: %v", err)
		}
		select {
		case <-ctx.Done():
		case <-time.After(10 * time.Second):
		}
	}
}
