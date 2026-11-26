/** Session picker row formatting, locale-free on purpose: `toLocaleString` varies by ICU build
 * and machine locale, which makes row text untestable. */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Jul 24, 16:02"; the year only when it is not the current one ("Jul 24 2025, 16:02"). */
export function formatSessionDate(mtimeMs: number, now: Date = new Date()): string {
  const d = new Date(mtimeMs);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}, ${hh}:${mm}`;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Binary units: one decimal below 10 ("1.5 KB"), whole above ("532 KB"); negative clamps to 0. */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown =
    unit === 0 || value >= 10
      ? String(Math.round(value))
      : String(Math.round(value * 10) / 10);
  return `${shown} ${UNITS[unit]}`;
}
