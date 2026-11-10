//go:build live

// Live checks against the real Anthropic API. Run with:
//
//	set -a; . ../.env; set +a; go test -tags live -run Live -v .
package main

import (
	"context"
	"net/http"
	"os"
	"testing"
	"time"
)

func TestLiveClassifier(t *testing.T) {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		t.Skip("ANTHROPIC_API_KEY not set")
	}
	c := &Classifier{Base: "https://api.anthropic.com", Client: &http.Client{Timeout: 5 * time.Minute}}
	for _, tc := range []struct{ name, id, title, want string }{
		{"老高與小茉 Mr & Mrs Gao", "UCMUnInmOkrWN4gof9KlhNmQ", "", "mandarin"},
		{"100毛", "", "", "other"}, // Cantonese
		{"Learn English with EnglishClass101.com", "", "", "other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, err := c.Classify(context.Background(), key, Channel{Name: tc.name, ChannelID: tc.id}, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("%s: %s (%s, %s) %s", tc.name, v.Label, v.MandarinShare, v.Confidence, v.Reason)
			if v.Label != tc.want {
				t.Errorf("label %s, want %s", v.Label, tc.want)
			}
		})
	}
}
