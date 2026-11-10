package main

import (
	"regexp"
	"unicode"
)

// Text counts as Mandarin when at least this share of it is Chinese, over at least MinUnits
// units (see docs/protocol.md, "Chinese share").
const (
	MandarinShare = 0.3
	MinUnits      = 20
	japaneseKana  = 0.1
)

var (
	reHangulRun = regexp.MustCompile(`\p{Hangul}+`)
	reWordRun   = regexp.MustCompile(`[\p{Latin}\p{Cyrillic}]+`)
)

// ChineseShare is the share of a text that is Chinese. Each Han character counts as one unit,
// as does each run of Latin or Cyrillic letters (a character carries about as much as a word).
// Kana characters and Hangul runs count as non-Chinese units, so Korean scores low. Japanese
// mixes kanji with kana, so text whose kana are at least japaneseKana of its kanji and kana
// counts its kanji as non-Chinese too: Chinese text has almost no kana.
func ChineseShare(text string) (share float64, units int) {
	han, kana := 0, 0
	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r):
			han++
		case unicode.Is(unicode.Hiragana, r), unicode.Is(unicode.Katakana, r):
			// The prolonged sound mark ー is Common script; ignoring it is fine.
			kana++
		}
	}
	total := han + kana + len(reHangulRun.FindAllStringIndex(text, -1)) + len(reWordRun.FindAllStringIndex(text, -1))
	if total == 0 {
		return 0, 0
	}
	if kana > 0 && float64(kana) >= japaneseKana*float64(han+kana) {
		return 0, total
	}
	return float64(han) / float64(total), total
}

// IsMandarinText applies the protocol's threshold.
func IsMandarinText(share float64, units int) bool {
	return units >= MinUnits && share >= MandarinShare
}
