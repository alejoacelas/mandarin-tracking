// Chinese share, as defined in docs/protocol.md: each Han character is one unit, each run of
// Latin or Cyrillic letters is one unit, each kana character and each run of Hangul is one
// (non-Chinese) unit. Share = Han units / all units, or 0 when the text is Japanese.
export const ZH_SHARE_MIN = 0.3;
export const ZH_UNITS_MIN = 20;

export function chineseShare(text) {
  const s = String(text ?? "");
  const han = (s.match(/\p{Script=Han}/gu) ?? []).length;
  const kana = (s.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const hangul = (s.match(/\p{Script=Hangul}+/gu) ?? []).length;
  const words = (s.match(/[\p{Script=Latin}\p{Script=Cyrillic}]+/gu) ?? []).length;
  const units = han + kana + hangul + words;
  if (!units) return { share: null, units };
  // Japanese: kana are at least 10% of the Han and kana characters. Kanji-heavy Japanese would
  // otherwise pass the Mandarin threshold.
  if (kana > 0 && kana >= 0.1 * (han + kana)) return { share: 0, units };
  return { share: han / units, units };
}

// `zh` or `other` once there are enough units to tell; `unknown` below that.
export function languageOf({ share, units }) {
  if (!(units >= ZH_UNITS_MIN) || share == null) return "unknown";
  return share >= ZH_SHARE_MIN ? "zh" : "other";
}
