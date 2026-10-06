/**
 * A time as every client says it (#1742): on this machine's clock, to the
 * minute. The window, the terminal and the CLI share these, so a past time
 * an environment names reads alike in each, "2 h ago, at 16:24".
 */

/** Hours and minutes on this machine's clock. */
export const clockTime = (iso: string): string => {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A time where the client is: its clock time on the day it is `now`, else its day and clock time, the year too when it is not this one. */
export const whenWords = (iso: string, now: Date): string => {
  const at = new Date(iso);
  const time = clockTime(iso);
  if (at.toDateString() === now.toDateString()) return time;
  const day = `${String(at.getDate())} ${MONTHS[at.getMonth()] ?? ""}`;
  return at.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${day} ${String(at.getFullYear())} ${time}`;
};

/**
 * How long ago something was: `just now` under a minute, then whole minutes
 * under an hour (`5 min ago`), whole hours under two days (`30 h ago`,
 * which a day would round to half its size), else whole days (`2 d ago`).
 */
export const agoWords = (ageMs: number): string => {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};

/**
 * A past time, its age counted against `now` and then its time where the
 * client is, `2 h ago, at 16:24`, the day and time held on one line
 * (no-break spaces). A time ahead of `now`, a skewed clock's, is just now.
 */
export const pastTimeWords = (iso: string, now: Date): string =>
  `${agoWords(Math.max(0, now.getTime() - Date.parse(iso)))}, at ${whenWords(iso, now).replaceAll(" ", " ")}`;
