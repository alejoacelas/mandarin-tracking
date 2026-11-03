// Share of a text that is Chinese, counting each Han character and each word in another
// script as one unit (a Chinese character carries roughly as much as a word).
// Kana and Hangul count as non-Chinese, so Japanese and Korean score low.
export function chineseShare(text) {
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const kana = (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []).length;
  const hangul = (text.match(/\p{Script=Hangul}+/gu) ?? []).length;
  const words = (text.match(/[\p{Script=Latin}\p{Script=Cyrillic}]+/gu) ?? []).length;
  const total = han + kana + hangul + words;
  if (total === 0) return { share: 0, units: 0 };
  return { share: han / total, units: total };
}
