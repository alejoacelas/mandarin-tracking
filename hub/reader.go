package main

// Reading time from the Readwise Reader API. The API has no time-spent data, but a document's
// `updated_at` moves each time an app saves reading progress (about every 30 s while scrolling),
// and `last_opened_at` marks opens. This covers every device Reader runs on, including the
// phone and desktop apps. A session runs from an open or save through every save less than
// readerGap apart, plus readerTail after the last one. Time between two events goes to the
// later event's document. These rules were tuned in v1 against recorded scripted reading
// (testdata/readwise), within about 15% overall.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"time"
)

const (
	readerGap        = 300 * time.Second
	readerTail       = 45 * time.Second
	readerIdlePoll   = 60 * time.Second // well under the API limit of 20 calls a minute
	readerActivePoll = 30 * time.Second
	readerKeepEvents = 48 * time.Hour
)

type readerDoc struct {
	UpdatedAt string  `json:"u"`
	OpenedAt  string  `json:"o"`
	Share     float64 `json:"s"`
	Units     int     `json:"n"`
	Known     bool    `json:"k"` // Share has been measured
	Title     string  `json:"t"`
}

type readerEvent struct {
	Doc string `json:"d"`
	At  int64  `json:"a"`
}

type ReaderState struct {
	Since  string               `json:"since"`
	Docs   map[string]readerDoc `json:"docs"`
	Events []readerEvent        `json:"events"`
}

type Reader struct {
	Base   string // https://readwise.io
	Client *http.Client
}

type apiDoc struct {
	ID           string  `json:"id"`
	Title        *string `json:"title"`
	UpdatedAt    string  `json:"updated_at"`
	LastOpenedAt *string `json:"last_opened_at"`
	ParentID     *string `json:"parent_id"`
	Category     string  `json:"category"`
	HTMLContent  *string `json:"html_content"`
	URL          string  `json:"url"`
}

type apiPage struct {
	Results        []apiDoc `json:"results"`
	NextPageCursor *string  `json:"nextPageCursor"`
}

// RateLimitError carries the wait the API asked for.
type RateLimitError struct{ Wait time.Duration }

func (e RateLimitError) Error() string {
	return fmt.Sprintf("Reader API rate limit, retry in %s", e.Wait)
}

// AuthError means the token was refused.
type AuthError struct{}

func (AuthError) Error() string {
	return "Readwise refused the access token. Paste a new one from readwise.io/access_token in Settings."
}

func (r *Reader) get(ctx context.Context, token string, q url.Values) (*apiPage, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", r.Base+"/api/v3/list/?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Token "+token)
	resp, err := r.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("couldn't reach Readwise: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	switch {
	case resp.StatusCode == 404: // an empty library returns 404
		return &apiPage{}, nil
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return nil, AuthError{}
	case resp.StatusCode == 429:
		wait, _ := strconv.Atoi(resp.Header.Get("Retry-After"))
		if wait <= 0 {
			wait = 60
		}
		return nil, RateLimitError{time.Duration(wait) * time.Second}
	case resp.StatusCode != 200:
		return nil, fmt.Errorf("Reader API returned %d", resp.StatusCode)
	}
	var p apiPage
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, fmt.Errorf("Reader API sent something unexpected: %w", err)
	}
	return &p, nil
}

// CheckToken reports whether Readwise accepts a token.
func (r *Reader) CheckToken(ctx context.Context, token string) error {
	req, err := http.NewRequestWithContext(ctx, "GET", r.Base+"/api/v2/auth/", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Token "+token)
	resp, err := r.Client.Do(req)
	if err != nil {
		return fmt.Errorf("couldn't reach Readwise: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode == 204 || resp.StatusCode == 200 {
		return nil
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return AuthError{}
	}
	return fmt.Errorf("Readwise returned %d", resp.StatusCode)
}

var reTags = regexp.MustCompile(`<[^>]+>`)

func (r *Reader) measure(ctx context.Context, token, id, title string) (float64, int, error) {
	p, err := r.get(ctx, token, url.Values{"id": {id}, "withHtmlContent": {"true"}})
	if err != nil {
		return 0, 0, err
	}
	text := title
	if len(p.Results) > 0 && p.Results[0].HTMLContent != nil {
		text += " " + reTags.ReplaceAllString(*p.Results[0].HTMLContent, " ")
	}
	share, units := ChineseShare(text)
	return share, units, nil
}

// Poll fetches documents updated since the last poll and records their save and open events.
// The first poll only records documents, so a library's history isn't counted as reading.
// It returns the new state and how long to wait before polling again.
func (r *Reader) Poll(ctx context.Context, token string, st ReaderState, now time.Time) (ReaderState, time.Duration, error) {
	first := st.Docs == nil
	if first {
		st.Docs = map[string]readerDoc{}
	}
	since := st.Since
	if since == "" {
		since = "1970-01-01T00:00:00Z"
	}
	cursor := ""
	var docs []apiDoc
	for {
		q := url.Values{"updatedAfter": {since}}
		if cursor != "" {
			q.Set("pageCursor", cursor)
		}
		p, err := r.get(ctx, token, q)
		if err != nil {
			return st, 0, err
		}
		docs = append(docs, p.Results...)
		if p.NextPageCursor == nil || *p.NextPageCursor == "" {
			break
		}
		cursor = *p.NextPageCursor
	}
	latest := st.Since
	for _, d := range docs {
		if d.UpdatedAt > latest {
			latest = d.UpdatedAt
		}
		if d.ParentID != nil && *d.ParentID != "" { // highlights and notes
			continue
		}
		prev, seen := st.Docs[d.ID]
		if seen && prev.UpdatedAt == d.UpdatedAt {
			continue
		}
		doc := prev
		doc.UpdatedAt, doc.Title = d.UpdatedAt, str(d.Title)
		opened := str(d.LastOpenedAt)
		if !first && !doc.Known {
			share, units, err := r.measure(ctx, token, d.ID, doc.Title)
			if err != nil {
				return st, 0, err // state unchanged, so this document is retried next poll
			}
			doc.Share, doc.Units, doc.Known = share, units, true
		}
		if !first {
			if t, err := time.Parse(time.RFC3339Nano, opened); err == nil && opened != prev.OpenedAt {
				st.Events = append(st.Events, readerEvent{d.ID, t.UnixMilli()})
			}
			if t, err := time.Parse(time.RFC3339Nano, d.UpdatedAt); err == nil {
				st.Events = append(st.Events, readerEvent{d.ID, t.UnixMilli()})
			}
		}
		doc.OpenedAt = opened
		st.Docs[d.ID] = doc
	}
	st.Since = latest
	// Keep recent events only.
	cut := now.Add(-readerKeepEvents).UnixMilli()
	kept := st.Events[:0]
	var last int64
	for _, e := range st.Events {
		if e.At >= cut {
			kept = append(kept, e)
		}
		last = max(last, e.At)
	}
	st.Events = kept
	wait := readerIdlePoll
	if now.UnixMilli()-last < readerGap.Milliseconds() {
		wait = readerActivePoll
	}
	return st, wait, nil
}

// ReaderIntervals turns events into intervals. Each event's interval runs to the next event if
// that is within readerGap, else for readerTail; it belongs to the later event's document.
// Interval ids derive from the event, so recomputing replaces earlier versions.
func ReaderIntervals(st ReaderState) []Interval {
	ev := append([]readerEvent(nil), st.Events...)
	sort.Slice(ev, func(i, j int) bool { return ev[i].At < ev[j].At })
	var out []Interval
	for i, e := range ev {
		doc, end := e.Doc, e.At+readerTail.Milliseconds()
		if i+1 < len(ev) && ev[i+1].At-e.At <= readerGap.Milliseconds() {
			if ev[i+1].At == e.At {
				continue
			}
			doc, end = ev[i+1].Doc, ev[i+1].At
		}
		d := st.Docs[doc]
		lang := "unknown"
		if d.Known {
			lang = "other"
			if IsMandarinText(d.Share, d.Units) {
				lang = "zh"
			}
		}
		share, units := d.Share, int64(d.Units)
		title, docID := d.Title, doc
		out = append(out, Interval{
			DeviceID: ReaderAPIDevice, ID: fmt.Sprintf("rw-%s-%d", e.Doc, e.At), Source: "reader",
			StartMs: e.At, EndMs: end, Language: lang, ZhShare: &share, Units: &units,
			App: "readwise-api", Title: &title, DocID: &docID,
		})
	}
	return out
}
