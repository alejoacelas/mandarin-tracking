// Toolbar badge: today's Mandarin minutes from the hub's summary ("42m", "1h05") on red. When
// something needs attention it turns amber and ends in "!" ("42!", or just "!" without minutes).
export const RED = "#c0392b";
export const AMBER = "#d68a00";

export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Today's total minutes, or 0 when the summary has no entry for today yet.
export function todayFrom(summary, date) {
  const day = summary?.days?.find((d) => d?.date === date);
  return day && Number.isFinite(day.total_min) ? day.total_min : 0;
}

export function formatMinutes(m) {
  const r = Math.round(m);
  return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h${String(r % 60).padStart(2, "0")}`;
}

export function badgeFor({ minutes, problem }) {
  const known = minutes != null;
  if (problem) {
    const r = known ? Math.round(minutes) : null;
    const text = r == null ? "!" : r < 100 ? `${r}!` : `${Math.round(r / 60)}h!`;
    return { text, color: AMBER, title: `Mandarin time${known ? `: ${formatMinutes(minutes)} today` : ""}. Something needs attention; click for details.` };
  }
  if (!known) return { text: "", color: RED, title: "Mandarin time" };
  return { text: Math.round(minutes) ? formatMinutes(minutes) : "", color: RED, title: `Mandarin time: ${formatMinutes(minutes)} today` };
}
