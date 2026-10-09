import { snoozeLimit } from "@agent-harness/contracts";

/**
 * When a snoozed session comes back (docs/specs/tui.md, "The rail";
 * docs/specs/gui.md, "The window and the sidebar"): the snooze picker's
 * presets (an hour, this evening, tomorrow morning, next Monday) and a typed
 * time, each an instant the command carries as absolute UTC, and a snoozed
 * row's wake time, which the terminal UI's rail and the window's sidebar
 * both say. The calendar is this client's (its evening, its Monday); the
 * instant it counts from is the environment's now, from the server-time
 * skew, so "an hour" is an hour on the environment that wakes the session.
 * The environment refuses a time not after its now or more than a calendar
 * year ahead (`out_of_window`, `snoozeLimit`); these words refuse them first,
 * by the same limit.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The hour "this evening" is, and the hour a morning or a day named without a time starts. */
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** One of the picker's presets: when it is, or why it is not offered now. */
export interface WhenPreset {
  readonly label: string;
  readonly at: Date | null;
  readonly absent?: string;
}

/** The day of `from` at `hours:minutes` on this client's calendar, `days` on. */
const dayAt = (from: Date, days: number, hours: number, minutes = 0): Date =>
  new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, hours, minutes);

/** The next `weekday` (0 Sunday) strictly after the day of `from`. */
const nextWeekday = (from: Date, weekday: number, hours: number, minutes = 0): Date =>
  dayAt(from, ((weekday - from.getDay() + 6) % 7) + 1, hours, minutes);

/** The four presets, in the picker's order; this evening says why not once 18:00 has passed. */
export const presetTimes = (now: Date): readonly WhenPreset[] => {
  const evening = dayAt(now, 0, EVENING_HOUR);
  return [
    { label: "An hour", at: new Date(now.getTime() + HOUR) },
    evening.getTime() > now.getTime()
      ? { label: "This evening", at: evening }
      : { label: "This evening", at: null, absent: `It is past ${String(EVENING_HOUR)}:00.` },
    { label: "Tomorrow morning", at: dayAt(now, 1, MORNING_HOUR) },
    { label: "Next Monday", at: nextWeekday(now, 1, MORNING_HOUR) },
  ];
};

export const WHEN_EXAMPLES = "2h, 18:00, tomorrow, monday 9:00 or 2026-10-02 17:30";
const NOT_A_TIME = `Not a time: try ${WHEN_EXAMPLES}.`;

/** A clock time, `14:15`, `9pm`, `7:45am`: hours and minutes, or undefined. */
const clockOf = (text: string): { readonly hours: number; readonly minutes: number } | undefined => {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return undefined;
  const [, h = "", m, half] = match;
  let hours = Number(h);
  const minutes = m === undefined ? 0 : Number(m);
  // A bare number is a clock time only with am or pm; `14` alone is not one.
  if (m === undefined && half === undefined) return undefined;
  if (half !== undefined) {
    if (hours < 1 || hours > 12) return undefined;
    hours = (hours % 12) + (half === "pm" ? 12 : 0);
  }
  return hours < 24 && minutes < 60 ? { hours, minutes } : undefined;
};

/** A span from now, `2h`, `in 30 minutes`, `an hour`: its length, or undefined. */
const spanOf = (text: string): number | undefined => {
  if (/^(in\s+)?(an?\s+)?hour$/.test(text)) return HOUR;
  const match = /^(?:in\s+)?(\d+)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/.exec(text);
  if (!match) return undefined;
  const [, count = "0", unit = "m"] = match;
  const size = unit.startsWith("m") ? MINUTE : unit.startsWith("h") ? HOUR : unit.startsWith("d") ? DAY : 7 * DAY;
  return Number(count) * size;
};

/** A day named in words or as a date, with an optional clock time after it; undefined when `text` names none. */
const dayOf = (text: string, now: Date): Date | "bad-clock" | undefined => {
  const dated = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](.+))?$/.exec(text);
  const worded = /^(?:next\s+)?(today|tonight|this evening|evening|tomorrow(?: morning)?|[a-z]+)(?:\s+(?:at\s+)?(.+))?$/.exec(text);
  let day: Date | undefined;
  let rest: string | undefined;
  let hours = MORNING_HOUR;
  if (dated) {
    const [, y = "", mo = "", d = "", time] = dated;
    day = new Date(Number(y), Number(mo) - 1, Number(d));
    if (day.getMonth() !== Number(mo) - 1) return undefined;
    rest = time;
  } else if (worded) {
    const [, word = "", time] = worded;
    rest = time;
    if (word === "today") day = dayAt(now, 0, 0);
    else if (word === "tonight" || word === "this evening" || word === "evening") {
      day = dayAt(now, 0, 0);
      hours = EVENING_HOUR;
    } else if (word.startsWith("tomorrow")) day = dayAt(now, 1, 0);
    else {
      // A weekday by its first three letters or more: `mon`, `tues`, `wednesday`.
      const weekday = WEEKDAYS.findIndex((name) => word.length >= 3 && name.toLowerCase().startsWith(word));
      if (weekday === -1) return undefined;
      day = nextWeekday(now, weekday, 0);
    }
  } else return undefined;
  if (rest === undefined) return dayAt(day, 0, hours);
  const clock = clockOf(rest.trim());
  return clock ? dayAt(day, 0, clock.hours, clock.minutes) : "bad-clock";
};

/**
 * A typed time as an instant after `now`: a span (`2h`, `in 30 minutes`), a
 * clock time today or, once passed, tomorrow (`14:15`, `9pm`), the presets'
 * words (`evening`, `tomorrow`, `monday`, each with a time or not), a date
 * (`2026-10-02`, `2026-10-02 17:30`), or an ISO timestamp with its offset.
 * A day named without a time is at 09:00, an evening at 18:00. Otherwise the
 * problem, in one line.
 */
export const parseWhen = (typed: string, now: Date): Date | { readonly problem: string } => {
  const text = typed.trim().toLowerCase().replace(/\s+/g, " ");
  let at: Date | undefined;
  const span = spanOf(text);
  const clock = clockOf(text);
  if (span !== undefined) at = new Date(now.getTime() + span);
  else if (clock) {
    const today = dayAt(now, 0, clock.hours, clock.minutes);
    at = today.getTime() > now.getTime() ? today : dayAt(now, 1, clock.hours, clock.minutes);
  } else if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:\d{2})$/.test(text)) {
    at = new Date(Date.parse(typed.trim()));
  } else {
    const day = dayOf(text, now);
    if (day === "bad-clock" || day === undefined) return { problem: NOT_A_TIME };
    at = day;
  }
  if (Number.isNaN(at.getTime())) return { problem: NOT_A_TIME };
  if (at.getTime() <= now.getTime()) return { problem: "That time has passed." };
  if (at.getTime() > snoozeLimit(now).getTime()) return { problem: "That is more than a year ahead; a snooze is at most a year." };
  return at;
};

const two = (n: number) => String(n).padStart(2, "0");
const clockWords = (at: Date) => `${two(at.getHours())}:${two(at.getMinutes())}`;
/** A day of the week, short: `Mon`. */
export const weekdayWords = (at: Date): string => (WEEKDAYS[at.getDay()] ?? "").slice(0, 3);

/** A time in a picker: `Mon 28 Sep 09:00`, on this client's calendar. */
export const whenWords = (at: Date): string => `${weekdayWords(at)} ${at.getDate()} ${MONTHS[at.getMonth()] ?? ""} ${clockWords(at)}`;

/** Calendar days from the day of `from` to the day of `to` on this client's calendar, whatever a DST change between them does to the hours. */
export const daysBetween = (from: Date, to: Date): number =>
  Math.round((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())) / DAY);

/** A snoozed row's wake time, short: the clock time on the day of `now`, the weekday and time within six days, else the date. */
export const wakeWords = (at: Date, now: Date): string => {
  const days = daysBetween(now, at);
  if (days <= 0) return clockWords(at);
  if (days < 7) return `${weekdayWords(at)} ${clockWords(at)}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ""}`;
};
