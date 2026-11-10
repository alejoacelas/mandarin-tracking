package main

// Decides whether a YouTube channel's videos are spoken in Mandarin. With an Anthropic API
// key, Claude researches the channel on the web (prompt from v1, evaluated against the audio
// of 58 tricky channels). Without one, the channel is judged from the Chinese share of its
// video titles and name, which misses Mandarin channels with English titles and counts
// Cantonese ones; the dashboard shows which method decided each channel.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

var ChannelLabels = []string{"mandarin", "mixed", "other", "unknown"}

const classifyModel = "claude-opus-5-5"

const classifySystem = `You decide which language is spoken in a YouTube channel's current videos, for someone tracking how much Mandarin they listen to.

Always search before answering, even for a channel you think you know: different channels share names, and channels change language over time. Confirm that what you find is about this exact channel (its URL or handle), and describe its recent videos, not its past or its reputation.

Look for direct evidence about the spoken audio: descriptions of what the host says and in which language, video descriptions mentioning dubbing (配音) or subtitles (字幕), the languages of its recent video titles and descriptions, fan wikis, Wikipedia or Baidu entries, comments that mention the language. Titles are weak evidence on their own: Cantonese, Taiwanese Hokkien, Japanese and English channels often have Chinese-character titles, and Mandarin channels sometimes have English ones. Don't infer the language from who the creators are, where they live, or what they talk about: a Chinese-Korean couple may speak Korean, and a video about Shanghainese may be in Mandarin.

Labels:
- "mandarin": most of the speech (or sung vocals, for music) in the channel's recent videos is Mandarin Chinese, any accent (mainland, Taiwan, Singapore, Malaysia).
- "mixed": Mandarin is roughly 25-75% of the speech, e.g. a Mandarin-teaching channel that explains in another language, a bilingual vlog, or a news channel that mixes its own Mandarin reports with English reports subtitled in Chinese.
- "other": little or no spoken Mandarin. This includes Cantonese, Hokkien, Hakka, Shanghainese and other Chinese languages, English or other languages about China or teaching Chinese, and channels whose videos are mostly music without vocals, ambient sound or silence, even if the few words spoken are Mandarin.
- "unknown": you could not find enough evidence to choose. Prefer this over a guess.

Keep searching until you are confident or out of leads.`

var classifySchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"label":          map[string]any{"type": "string", "enum": ChannelLabels},
		"confidence":     map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
		"mandarin_share": map[string]any{"type": "string", "description": "Rough share of the speech that is Mandarin, e.g. '90%', '40%', '0%'."},
		"reason":         map[string]any{"type": "string", "description": "One or two sentences citing the evidence."},
	},
	"required":             []string{"label", "confidence", "mandarin_share", "reason"},
	"additionalProperties": false,
}

type Classifier struct {
	Base   string // https://api.anthropic.com
	Client *http.Client
}

type ChannelVerdict struct {
	Label, Confidence, MandarinShare, Reason string
}

type anthropicResp struct {
	StopReason string `json:"stop_reason"`
	Content    []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	RawContent json.RawMessage `json:"-"`
	Error      *struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// Classify asks Claude about one channel.
func (c *Classifier) Classify(ctx context.Context, key string, ch Channel, titles []string) (ChannelVerdict, error) {
	lines := []string{"Channel name: " + ch.Name}
	if ch.ChannelID != "" {
		lines = append(lines, "Channel URL: https://www.youtube.com/channel/"+ch.ChannelID)
	}
	for i, t := range titles {
		if i == 5 {
			break
		}
		lines = append(lines, "Title of one of its videos: "+t)
	}
	messages := []any{map[string]any{"role": "user", "content": strings.Join(lines, "\n")}}
	for turn := 0; turn < 6; turn++ {
		body, _ := json.Marshal(map[string]any{
			"model": classifyModel, "max_tokens": 16000, "system": classifySystem, "messages": messages,
			"tools": []any{
				map[string]any{"type": "web_search_20260209", "name": "web_search", "max_uses": 8},
				map[string]any{"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 5},
			},
			"output_config": map[string]any{"effort": "medium", "format": map[string]any{"type": "json_schema", "schema": classifySchema}},
		})
		req, err := http.NewRequestWithContext(ctx, "POST", c.Base+"/v1/messages", bytes.NewReader(body))
		if err != nil {
			return ChannelVerdict{}, err
		}
		req.Header.Set("x-api-key", key)
		req.Header.Set("anthropic-version", "2023-06-01")
		req.Header.Set("content-type", "application/json")
		resp, err := c.Client.Do(req)
		if err != nil {
			return ChannelVerdict{}, fmt.Errorf("couldn't reach Anthropic: %w", err)
		}
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
		resp.Body.Close()
		var r anthropicResp
		if err := json.Unmarshal(raw, &r); err != nil {
			return ChannelVerdict{}, fmt.Errorf("Anthropic returned %d with an unreadable body", resp.StatusCode)
		}
		if resp.StatusCode != 200 {
			msg := fmt.Sprintf("Anthropic returned %d", resp.StatusCode)
			if r.Error != nil {
				msg += ": " + r.Error.Message
			}
			return ChannelVerdict{}, fmt.Errorf("%s", msg)
		}
		if r.StopReason == "pause_turn" {
			var full struct {
				Content json.RawMessage `json:"content"`
			}
			_ = json.Unmarshal(raw, &full)
			messages = []any{messages[0], map[string]any{"role": "assistant", "content": full.Content}}
			continue
		}
		if r.StopReason == "refusal" {
			return ChannelVerdict{}, fmt.Errorf("the model declined to classify this channel")
		}
		if r.StopReason != "end_turn" {
			return ChannelVerdict{}, fmt.Errorf("classification stopped early: %s", r.StopReason)
		}
		text := ""
		for _, b := range r.Content {
			if b.Type == "text" {
				text = b.Text
			}
		}
		var v struct {
			Label, Confidence, Reason string
			MandarinShare             string `json:"mandarin_share"`
		}
		if err := json.Unmarshal([]byte(text), &v); err != nil {
			return ChannelVerdict{}, fmt.Errorf("the model's answer wasn't valid JSON")
		}
		for _, l := range ChannelLabels {
			if l == v.Label {
				return ChannelVerdict{v.Label, v.Confidence, v.MandarinShare, v.Reason}, nil
			}
		}
		return ChannelVerdict{}, fmt.Errorf("the model gave an unknown label %q", v.Label)
	}
	return ChannelVerdict{}, fmt.Errorf("classification didn't finish within 6 turns")
}

// HeuristicLabel judges a channel by the Chinese share of its name and video titles.
// It needs at least one title; it returns "" when there's nothing to judge.
func HeuristicLabel(name string, titles []string) (label, reason string) {
	if len(titles) == 0 {
		return "", ""
	}
	share, units := ChineseShare(name + " " + strings.Join(titles, " "))
	if units < 4 {
		return "", ""
	}
	pct := int(share * 100)
	if share >= MandarinShare {
		return "mandarin", fmt.Sprintf("%d%% of the channel name and %d video titles is Chinese text.", pct, len(titles))
	}
	return "other", fmt.Sprintf("Only %d%% of the channel name and %d video titles is Chinese text.", pct, len(titles))
}

const maxClassifyAttempts = 3

func (c Channel) LastErrorOr(err error) string {
	if err != nil {
		return err.Error()
	}
	return c.LastError
}

// ClassifyPending labels every pending channel. With a key it uses Claude; after
// maxClassifyAttempts failures (or without a key) it uses the title heuristic and says so.
func ClassifyPending(ctx context.Context, st *Store, c *Classifier, key string, now func() time.Time) error {
	pending, err := st.Channels("label IN ('pending') OR (decided_by='titles' AND ? <> '' AND attempts < ?)", key, maxClassifyAttempts)
	if err != nil {
		return err
	}
	var lastErr error
	for _, ch := range pending {
		titles, err := st.ChannelTitles(ch.Key, 10)
		if err != nil {
			return err
		}
		if key != "" && ch.Attempts < maxClassifyAttempts {
			v, err := c.Classify(ctx, key, ch, titles)
			if err == nil {
				reason := v.Reason
				if v.MandarinShare != "" {
					reason = fmt.Sprintf("%s (about %s Mandarin, %s confidence)", v.Reason, v.MandarinShare, v.Confidence)
				}
				if err := st.SetChannelLabel(ch.Key, v.Label, "claude", reason, now().UnixMilli()); err != nil {
					return err
				}
				continue
			}
			lastErr = err
			if err := st.ChannelFailed(ch.Key, err.Error(), now().UnixMilli()); err != nil {
				return err
			}
			if ch.Attempts+1 < maxClassifyAttempts {
				continue
			}
		}
		if ch.Label != "pending" {
			continue // already has a title-based label; keep it
		}
		if l, why := HeuristicLabel(ch.Name, titles); l != "" {
			if key != "" {
				why = fmt.Sprintf("Claude couldn't label it (%s), so it was judged by its titles: %s", ch.LastErrorOr(lastErr), why)
			}
			if err := st.SetChannelLabel(ch.Key, l, "titles", why, now().UnixMilli()); err != nil {
				return err
			}
		}
	}
	return lastErr
}
