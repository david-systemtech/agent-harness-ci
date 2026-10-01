import { z } from "zod";
import { setOf } from "./primitives.js";

/**
 * A routine's schedule (routines spec, "Schedules"): its shapes, and the
 * maths over them that the environment's scheduler, every client and a
 * client in another language agree on to the minute: validate, describe,
 * the next due time after an instant and the due times between two
 * instants, with published cases (`schedule-cases.ts`). Pure: the zone
 * rules come from the runtime's IANA data through `Intl`.
 */

/**
 * Why a schedule is refused, by what it gets wrong: `kind`, not one of the
 * eight; `minute`, hourly's minute not a whole number from 0 to 59; `time`,
 * an `at` not `HH:MM`; `day`, a day not named; `days_empty` and
 * `days_repeated`, some days with none or one named twice; `day_of_month`,
 * monthly's day not a whole number from 1 to 31; a cron expression that is
 * an `@` form (`cron_at_form`), has a seconds field (`cron_seconds`) or not
 * five fields (`cron_fields`), holds what cron cannot read (`cron_syntax`), a
 * value outside its field (`cron_range`) or a range that runs backwards
 * (`cron_backwards`), or is never due (`cron_never`); `floor`, due times that
 * can fall under five minutes apart; `zone`, a zone the runtime does not know.
 */
export const SCHEDULE_ISSUE_REASONS = [
  "kind",
  "minute",
  "time",
  "day",
  "days_empty",
  "days_repeated",
  "day_of_month",
  "cron_at_form",
  "cron_seconds",
  "cron_fields",
  "cron_syntax",
  "cron_range",
  "cron_backwards",
  "cron_never",
  "floor",
  "zone",
] as const;
export type ScheduleIssueReason = (typeof SCHEDULE_ISSUE_REASONS)[number];

/** The days a schedule names, Monday first. */
export const ROUTINE_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const RoutineDay = z.enum(ROUTINE_DAYS).meta({ description: "A day of the week, named in English and lower case: monday to sunday." });
export type RoutineDay = z.infer<typeof RoutineDay>;

/** `HH:MM` on the 24-hour clock, 00:00 to 23:59. */
const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** A time of day in the routine's zone, `HH:MM` on the 24-hour clock. */
export const RoutineTime = z
  .string()
  .regex(HH_MM)
  .meta({ description: "A time of day in the routine's zone: HH:MM on the 24-hour clock, 00:00 to 23:59." });
export type RoutineTime = z.infer<typeof RoutineTime>;

const at = RoutineTime.meta({ description: "When in the day it is due, HH:MM in the routine's zone." });

/** The longest cron expression a schedule takes. */
export const MAX_CRON_EXPRESSION = 200;

/**
 * When a routine is due (routines spec, "Schedules"): run now only, or a
 * kind with named days and `HH:MM` times, or a five-field cron expression,
 * each in the routine's zone at minute resolution. Once its fields parse,
 * the schedule maths judges the whole (`validateSchedule`: cron's grammar,
 * a day it falls on, the five-minute floor), a refusal an issue at its path
 * whose params name the rule `schedule` and its reason.
 */
export const RoutineSchedule = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("manual") }).meta({ description: "Never due: the routine runs when run now." }),
    z
      .object({ kind: z.literal("hourly"), minute: z.int().min(0).max(59).meta({ description: "The minute past each hour it is due, 0 to 59." }) })
      .meta({ description: "Due every hour at a minute past it." }),
    z.object({ kind: z.literal("daily"), at }).meta({ description: "Due every day at a time." }),
    z.object({ kind: z.literal("weekdays"), at }).meta({ description: "Due Monday to Friday at a time." }),
    z.object({ kind: z.literal("weekly"), day: RoutineDay, at }).meta({ description: "Due one day a week at a time." }),
    z
      .object({ kind: z.literal("days"), days: setOf(RoutineDay).min(1).meta({ description: "The days it is due, each once." }), at })
      .meta({ description: "Due on some days of the week at a time." }),
    z
      .object({ kind: z.literal("monthly"), day: z.int().min(1).max(31).meta({ description: "The day of the month, 1 to 31; a month without it is skipped." }), at })
      .meta({ description: "Due one day a month at a time; a month without the day is skipped, as cron does." }),
    z
      .object({
        kind: z.literal("cron"),
        expression: z.string().min(1).max(MAX_CRON_EXPRESSION).meta({
          description:
            "Five fields (minute, hour, day of month, month, day of week) with *, lists, ranges, steps and month and day names; no seconds field and no @ form (cases/schedule-validation.json).",
        }),
      })
      .meta({ description: "Due when a five-field cron expression matches; both day fields restricted, neither beginning with *, combine with OR, as Vixie cron's do." }),
  ])
  .superRefine(
    (schedule, ctx) => {
      for (const { path, reason, message } of scheduleIssues(schedule)) ctx.addIssue({ code: "custom", path: [...path], message, params: { rule: "schedule", reason } });
    },
    // A field its own check refused is reported once, by that check.
    { when: (payload) => payload.issues.length === 0 },
  )
  .meta({
    description:
      "When a routine is due, in its zone at minute resolution: manual (run now only), hourly at a minute, daily, weekdays, weekly on a day, on some days, monthly on a day, or a cron expression. Refused as invalid_params, the issue's params naming the rule schedule and its reason, when the schedule maths refuses it (cases/schedule-validation.json): a cron expression it cannot read or that is never due, or due times that can fall under five minutes apart.",
  });
export type RoutineSchedule = z.infer<typeof RoutineSchedule>;

/** An IANA time zone's name, by its form; `WrittenTimeZone` also asks the runtime's zone data whether it knows the zone. */
export const RoutineTimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/)
  .meta({ description: "An IANA time zone's name, such as Europe/London or UTC; one a client writes must be a zone the environment's zone data knows (WrittenTimeZone)." });
export type RoutineTimeZone = z.infer<typeof RoutineTimeZone>;

/**
 * A zone as a client writes one (`routines.create`, `routines.update`): a
 * name the runtime's IANA data knows, else an issue whose params name the
 * rule `schedule` and the reason `zone`. A definition as saved and read
 * back checks only the name's form, so a client whose zone data is older
 * than the environment's still reads it.
 */
export const WrittenTimeZone = RoutineTimeZone.superRefine(
  (zone, ctx) => {
    if (!knownZone(zone)) ctx.addIssue({ code: "custom", message: zoneMessage(zone), params: { rule: "schedule", reason: "zone" } });
  },
  { when: (payload) => payload.issues.length === 0 },
).meta({
  description:
    "An IANA time zone's name as a client writes one, such as Europe/London or UTC, which the environment's zone data must know: refused otherwise as invalid_params, the issue's params naming the rule schedule and the reason zone.",
});

/** The params of an `invalid_params` issue the schedule maths raised: the rule `schedule` and its reason. */
export const ScheduleIssueParams = z
  .object({
    rule: z.literal("schedule"),
    reason: z.enum(SCHEDULE_ISSUE_REASONS).meta({ description: "Why the schedule maths refused the schedule or its zone." }),
  })
  .meta({
    description:
      "The params of an invalid_params issue the schedule maths raised: the rule schedule and its reason. The issue's path names the field; its message says why. The published cases (cases/schedule-validation.json) give each reason's inputs.",
  });
export type ScheduleIssueParams = z.infer<typeof ScheduleIssueParams>;

/** A schedule and the zone its times are in, as a definition holds them. */
export interface ZonedSchedule {
  readonly schedule: RoutineSchedule;
  readonly timezone: string;
}

/** A problem `validateSchedule` finds: its path in the definition (`schedule` and its field, or `timezone`), its reason, and a sentence for people. */
export interface ScheduleIssue {
  readonly path: readonly (string | number)[];
  readonly reason: ScheduleIssueReason;
  readonly message: string;
}

/** The fewest minutes apart two due times may fall, since each leaves a record (routines spec, "The five-minute floor"). */
export const SCHEDULE_FLOOR_MINUTES = 5;

// Instants and wall clocks ------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A formatter that reads an instant's wall clock in `zone`, to the second. */
const wallClockIn = (zone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    const numeric = "numeric" as const;
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: numeric, month: numeric, day: numeric, hour: numeric, minute: numeric, second: numeric });
    formatters.set(zone, formatter);
  }
  return formatter;
};

/** How far `zone`'s wall clock is ahead of UTC at `instant`, in milliseconds: the wall clock read as UTC, less the instant. */
const offsetAt = (zone: string, instant: number): number => {
  const parts = wallClockIn(zone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  const wall = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"));
  return wall - Math.floor(instant / 1000) * 1000;
};

/**
 * The instant a wall-clock minute in `zone` is due at, the wall clock given
 * as if it were UTC: its one occurrence; the first of the two a clock change
 * repeats; or, for a minute a clock change skips, the first minute after the
 * gap, which is the change's own instant. Assumes a zone changes its clock
 * at most once within a day either side of the minute.
 */
const instantOf = (zone: string, wall: number): number => {
  const earlier = offsetAt(zone, wall - DAY);
  const later = offsetAt(zone, wall + DAY);
  const occurrences = [wall - earlier, wall - later].filter((instant) => offsetAt(zone, instant) === wall - instant);
  if (occurrences.length > 0) return Math.min(...occurrences);
  // Skipped: the change lies between the two readings; find its first minute.
  let before = wall - Math.max(earlier, later);
  let after = wall - Math.min(earlier, later);
  const offsetBefore = offsetAt(zone, before);
  while (after - before > MINUTE) {
    const middle = before + Math.floor((after - before) / 2 / MINUTE) * MINUTE;
    if (offsetAt(zone, middle) === offsetBefore) before = middle;
    else after = middle;
  }
  return after;
};

// Calendar days --------------------------------------------------------------------------

/** A day on the calendar, with its weekday: 0 for Sunday to 6 for Saturday, as cron counts them. */
interface CalendarDay {
  readonly year: number;
  /** 1 to 12. */
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
}

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year: number, month: number): number => (month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);

/** The day after `day`. */
const dayAfter = ({ year, month, day, weekday }: CalendarDay): CalendarDay => {
  const next = (weekday + 1) % 7;
  if (day < daysInMonth(year, month)) return { year, month, day: day + 1, weekday: next };
  return month === 12 ? { year: year + 1, month: 1, day: 1, weekday: next } : { year, month: month + 1, day: 1, weekday: next };
};

/** The calendar days `first` to `last`, each with its count of days from 1970-01-01. */
function* calendarDays(first: number, last: number): Generator<readonly [number, CalendarDay]> {
  const start = new Date(first * DAY);
  let day: CalendarDay = { year: start.getUTCFullYear(), month: start.getUTCMonth() + 1, day: start.getUTCDate(), weekday: start.getUTCDay() };
  for (let days = first; days <= last; days += 1) {
    yield [days, day];
    day = dayAfter(day);
  }
}

/**
 * Every two days running the calendar has: each day of the fourteen kinds
 * of year (a common or a leap year, its 1st of January on each weekday),
 * which between them hold every day of the Gregorian cycle, with the day
 * after it. The years are stand-ins of the kind; the weekday is the kind's.
 */
function* twoDaysRunning(): Generator<readonly [CalendarDay, CalendarDay]> {
  for (const year of [2001, 2004]) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      let day: CalendarDay = { year, month: 1, day: 1, weekday };
      while (day.year === year) {
        const next = dayAfter(day);
        yield [day, next];
        day = next;
      }
    }
  }
}

/** The day, counted from 1970-01-01, whose wall clock in `zone` `instant` falls on. */
const dayOf = (zone: string, instant: number): number => Math.floor((instant + offsetAt(zone, instant)) / DAY);

// Cron ------------------------------------------------------------------------------------

/** One of cron's five fields: its name, its range and the names it takes, the first name standing for `first`. */
interface CronFieldRule {
  readonly name: string;
  readonly low: number;
  readonly high: number;
  readonly names: readonly string[];
  readonly first: number;
}

const CRON_FIELD_RULES: readonly CronFieldRule[] = [
  { name: "minute", low: 0, high: 59, names: [], first: 0 },
  { name: "hour", low: 0, high: 23, names: [], first: 0 },
  { name: "day of month", low: 1, high: 31, names: [], first: 1 },
  { name: "month", low: 1, high: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], first: 1 },
  { name: "day of week", low: 0, high: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], first: 0 },
];

/** One element of a field's list: `*`, a value or a range, with its step (1 when none is written). */
interface CronElement {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  /** Written as `*`. */
  readonly star: boolean;
  /** Written as one value. */
  readonly single: boolean;
}

/** A field as cron reads it: its elements, the values they cover, and whether it begins with `*`, which Vixie cron reads as unrestricted. */
interface CronField {
  readonly elements: readonly CronElement[];
  /** Ascending; Sunday is 0 in the day of week, however it was written. */
  readonly values: readonly number[];
  readonly star: boolean;
}

/** A five-field cron expression as read. */
interface CronExpression {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

type CronReason = "cron_at_form" | "cron_seconds" | "cron_fields" | "cron_syntax" | "cron_range" | "cron_backwards";

/** What reading an expression answers: the expression, or why it cannot be read. */
type CronReading = { readonly ok: true; readonly cron: CronExpression } | { readonly ok: false; readonly reason: CronReason; readonly message: string };

const FIVE_FIELDS = "minute, hour, day of month, month and day of week";

/** A value as `rule`'s field writes it, a number or one of its names in any case; null for text that is neither. */
const cronValue = (text: string, rule: CronFieldRule): number | null => {
  if (/^\d+$/.test(text)) return Number(text);
  const named = rule.names.indexOf(text.toLowerCase());
  return named < 0 ? null : named + rule.first;
};

/** Reads one field: a comma list of `*`, values and ranges, each with an optional step. */
const readCronField = (text: string, rule: CronFieldRule): { readonly ok: true; readonly field: CronField } | Extract<CronReading, { ok: false }> => {
  const refused = (reason: CronReason, why: string) => ({ ok: false, reason, message: `The cron expression's ${rule.name} field ${why}.` }) as const;
  const nameHint = rule.names.length > 0 ? `, or a name from ${rule.names[0]} to ${rule.names.at(-1)}` : "";
  const elements: CronElement[] = [];
  for (const element of text.split(",")) {
    const parts = /^(?:(\*)|([0-9a-z]+)(?:-([0-9a-z]+))?)(?:\/(\d+))?$/i.exec(element);
    if (parts === null) return refused("cron_syntax", `cannot read ${JSON.stringify(element)}: it takes *, a value or a range, each with an optional /step, in a comma list`);
    const [, star, start = "", end, stepText] = parts;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step === 0) return refused("cron_syntax", `has a step of 0 in ${JSON.stringify(element)}`);
    if (star !== undefined) {
      elements.push({ from: rule.low, to: rule.high, step, star: true, single: false });
      continue;
    }
    const values: number[] = [];
    for (const written of end === undefined ? [start] : [start, end]) {
      const value = cronValue(written, rule);
      if (value === null) return refused("cron_syntax", `cannot read ${JSON.stringify(written)}: it takes a number${nameHint}`);
      if (value < rule.low || value > rule.high) return refused("cron_range", `takes ${rule.low} to ${rule.high}, not ${written}`);
      values.push(value);
    }
    const [from = rule.low, to = from] = values;
    if (end === undefined && stepText !== undefined) return refused("cron_syntax", `cannot read ${JSON.stringify(element)}: a step follows * or a range, as in */${step} or ${from}-${rule.high}/${step}`);
    if (to < from) return refused("cron_backwards", `has the range ${JSON.stringify(element)}, which runs backwards`);
    elements.push({ from, to, step, star: false, single: end === undefined });
  }
  const covered = new Set<number>();
  for (const { from, to, step } of elements) for (let value = from; value <= to; value += step) covered.add(rule.name === "day of week" ? value % 7 : value);
  return { ok: true, field: { elements, values: [...covered].sort((a, b) => a - b), star: text.startsWith("*") } };
};

/**
 * Reads a five-field cron expression: minute, hour, day of month, month and
 * day of week, separated by white space; each field a comma list of `*`,
 * values and ranges with optional steps; month and day names (`jan`,
 * `sun`) in any case; 0 or 7 for Sunday. No seconds field, no `@` form.
 */
const readCron = (expression: string): CronReading => {
  const text = expression.trim();
  if (text.startsWith("@")) {
    return { ok: false, reason: "cron_at_form", message: `The cron expression ${JSON.stringify(text)} is an @ form, which a schedule does not take: write five fields (${FIVE_FIELDS}), or choose the hourly, daily, weekly or monthly kind.` };
  }
  const written = text === "" ? [] : text.split(/\s+/);
  if (written.length === 6) {
    return { ok: false, reason: "cron_seconds", message: `The cron expression has six fields; a schedule's cron has no seconds field, only five: ${FIVE_FIELDS}.` };
  }
  if (written.length !== 5) {
    return { ok: false, reason: "cron_fields", message: `The cron expression has ${written.length} ${written.length === 1 ? "field" : "fields"}; a schedule's cron has five: ${FIVE_FIELDS}.` };
  }
  const fields: CronField[] = [];
  for (const [index, rule] of CRON_FIELD_RULES.entries()) {
    const read = readCronField(written[index] ?? "", rule);
    if (!read.ok) return read;
    fields.push(read.field);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [CronField, CronField, CronField, CronField, CronField];
  return { ok: true, cron: { minute, hour, dayOfMonth, month, dayOfWeek } };
};

/**
 * Whether a cron expression is due on `day`: its month listed, and its day
 * fields by Vixie cron's rule. Both restricted (neither beginning with `*`)
 * combine with OR; otherwise with AND, so a `*` field takes every day and a
 * `*\/2` field restricts alongside the other.
 */
const cronDueOn = ({ dayOfMonth, month, dayOfWeek }: CronExpression, day: CalendarDay): boolean => {
  if (!month.values.includes(day.month)) return false;
  const onDate = dayOfMonth.values.includes(day.day);
  const onWeekday = dayOfWeek.values.includes(day.weekday);
  return dayOfMonth.star || dayOfWeek.star ? onDate && onWeekday : onDate || onWeekday;
};

// The schedule as wall-clock minutes ------------------------------------------------------

/** When a schedule is due on the wall clock: the minutes past each hour and the hours of each day it is due on, both ascending. */
interface WallPattern {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly onDay: (day: CalendarDay) => boolean;
}

const EVERY_HOUR = Array.from({ length: 24 }, (_, hour) => hour);
const everyDay = (): boolean => true;

/** `HH:MM` as its hour and minute. */
const hourAndMinute = (time: string): readonly [number, number] => [Number(time.slice(0, 2)), Number(time.slice(3, 5))];

/** A named day's weekday as cron counts them: 0 for Sunday to 6 for Saturday. */
const weekdayOf = (day: RoutineDay): number => (ROUTINE_DAYS.indexOf(day) + 1) % 7;

/** Due at `at` on the days `onDay` takes. */
const atTime = (at: string, onDay: (day: CalendarDay) => boolean): WallPattern => {
  const [hour, minute] = hourAndMinute(at);
  return { minutes: [minute], hours: [hour], onDay };
};

/** Due at `at` on the weekdays named. */
const onWeekdays = (at: string, weekdays: readonly number[]): WallPattern => atTime(at, (day) => weekdays.includes(day.weekday));

/** The schedule's wall-clock pattern; null for `manual`, which is never due, and for a cron expression that cannot be read. */
const patternOf = (schedule: RoutineSchedule): WallPattern | null => {
  switch (schedule.kind) {
    case "manual":
      return null;
    case "hourly":
      return { minutes: [schedule.minute], hours: EVERY_HOUR, onDay: everyDay };
    case "daily":
      return atTime(schedule.at, everyDay);
    case "weekdays":
      return onWeekdays(schedule.at, [1, 2, 3, 4, 5]);
    case "weekly":
      return onWeekdays(schedule.at, [weekdayOf(schedule.day)]);
    case "days":
      return onWeekdays(schedule.at, schedule.days.map(weekdayOf));
    case "monthly":
      return atTime(schedule.at, (day) => day.day === schedule.day);
    case "cron": {
      const read = readCron(schedule.expression);
      if (!read.ok) return null;
      const { cron } = read;
      return { minutes: cron.minute.values, hours: cron.hour.values, onDay: (day) => cronDueOn(cron, day) };
    }
  }
};

/**
 * The due times of `pattern` in `zone` on the days `first` to `last`, in
 * order and each once: minutes a clock change skips collapse into the first
 * minute after the gap, and a repeated minute is due at its first
 * occurrence only.
 */
function* dueInstants(pattern: WallPattern, zone: string, first: number, last: number): Generator<number> {
  let previous = Number.NEGATIVE_INFINITY;
  for (const [days, day] of calendarDays(first, last)) {
    if (!pattern.onDay(day)) continue;
    const midnight = days * DAY;
    // The same offset a day before and two days after: no clock change in the day, so one offset serves every minute of it.
    const offset = offsetAt(zone, midnight - DAY);
    const steady = offset === offsetAt(zone, midnight + 2 * DAY);
    for (const hour of pattern.hours) {
      for (const minute of pattern.minutes) {
        const wall = midnight + hour * HOUR + minute * MINUTE;
        const instant = steady ? wall - offset : instantOf(zone, wall);
        if (instant > previous) yield instant;
        previous = Math.max(previous, instant);
      }
    }
  }
}

/** How many days ahead the next due time is looked for: the Gregorian calendar's whole cycle of 400 years, in which every day it has falls. */
const HORIZON_DAYS = 146_097;

/** The wall-clock pattern of a schedule its maths can follow; null for `manual`, a cron expression that cannot be read or is never due, or a zone the runtime does not know. */
const followed = ({ schedule, timezone }: ZonedSchedule): WallPattern | null => {
  const pattern = patternOf(schedule);
  return pattern !== null && dueOnAnyDay(pattern.onDay) && knownZone(timezone) ? pattern : null;
};

/**
 * The first due time strictly after `after`, at minute resolution in the
 * routine's zone; null for `manual`, and for a schedule `validateSchedule`
 * refuses as never due, unreadable or in a zone the runtime does not know.
 */
export const nextDueAt = (zoned: ZonedSchedule, after: Date): Date | null => {
  const pattern = followed(zoned);
  if (pattern === null) return null;
  const { timezone } = zoned;
  const from = after.getTime();
  const first = dayOf(timezone, from) - 1;
  for (const instant of dueInstants(pattern, timezone, first, first + HORIZON_DAYS)) if (instant > from) return new Date(instant);
  return null;
};

/**
 * Every due time strictly after `after` and at or before `through`, in
 * order, at minute resolution in the routine's zone; none where `nextDueAt`
 * has none.
 */
export const dueTimesBetween = (zoned: ZonedSchedule, after: Date, through: Date): Date[] => {
  const pattern = followed(zoned);
  const { timezone } = zoned;
  const from = after.getTime();
  const to = through.getTime();
  if (pattern === null || to <= from) return [];
  const due: Date[] = [];
  for (const instant of dueInstants(pattern, timezone, dayOf(timezone, from) - 1, dayOf(timezone, to) + 1)) {
    if (instant > to) break;
    if (instant > from) due.push(new Date(instant));
  }
  return due;
};

// In words -----------------------------------------------------------------------------------

/** Items as a sentence lists them: `a`, `a and b`, `a, b and c`; each once. */
const listed = (items: readonly string[]): string => {
  const unique = [...new Set(items)];
  return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1) ?? ""}`;
};

/** A number as an ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st. */
const ordinal = (value: number): string => {
  const teen = value % 100 >= 11 && value % 100 <= 13;
  return `${value}${teen ? "th" : (["th", "st", "nd", "rd"][value % 10] ?? "th")}`;
};

const DAY_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_WORDS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayWord = (day: RoutineDay): string => DAY_WORDS[weekdayOf(day)] ?? day;
const twoDigits = (value: number): string => String(value).padStart(2, "0");

/** How each cron field says a value, and its unit. */
const CRON_WORDS = {
  minute: { value: String, unit: "minute" },
  hour: { value: String, unit: "hour" },
  dayOfMonth: { value: (day: number) => `the ${ordinal(day)}`, unit: "day of the month" },
  month: { value: (month: number) => MONTH_WORDS[month - 1] ?? String(month), unit: "month" },
  dayOfWeek: { value: (weekday: number) => DAY_WORDS[weekday % 7] ?? String(weekday), unit: "day of the week" },
} as const;

/** Whether a field is a bare `*`, every value. */
const everyValue = (field: CronField): boolean => field.elements.length === 1 && field.elements[0]?.star === true && field.elements[0].step === 1;

/** The one step of a field that is `*\/n` alone; null for any other field. */
const starStep = (field: CronField): number | null => (field.elements.length === 1 && field.elements[0]?.star === true ? field.elements[0].step : null);

/** A field's elements in words: `5`, `9 to 17`, `10 to 50 every 20th`, `every 2nd day of the month`. */
const elementWords = (field: CronField, words: (typeof CRON_WORDS)[keyof typeof CRON_WORDS]): string =>
  listed(
    field.elements.map(({ from, to, step, star, single }) => {
      const stepped = step > 1 ? ` every ${ordinal(step)}` : "";
      if (star) return step === 1 ? `every ${words.unit}` : `every ${ordinal(step)} ${words.unit}`;
      return single ? words.value(from) : `${words.value(from)} to ${words.value(to)}${stepped}`;
    }),
  );

/** A cron expression's minutes and hours in words: `At 09:00 and 17:00`, `Every 15 minutes in hours 9 to 17`. */
const cronTimeWords = ({ minute, hour }: CronExpression): string => {
  const singles = (field: CronField) => field.elements.every((element) => element.single);
  if (singles(minute) && singles(hour) && minute.values.length * hour.values.length <= 6) {
    return `At ${listed(hour.values.flatMap((h) => minute.values.map((m) => `${twoDigits(h)}:${twoDigits(m)}`)))}`;
  }
  const minuteStep = starStep(minute);
  const plural = (field: CronField) => (field.values.length > 1 ? "s" : "");
  const minutes =
    minuteStep === 1 ? "Every minute" : minuteStep !== null ? `Every ${minuteStep} minutes` : `At minute${plural(minute)} ${elementWords(minute, CRON_WORDS.minute)}`;
  const joint = minuteStep === null ? " of " : " in ";
  const hourStep = starStep(hour);
  if (hourStep === 1) return minuteStep === null ? `${minutes} of every hour` : minutes;
  if (hourStep !== null) return `${minutes}${joint}every ${ordinal(hourStep)} hour`;
  return `${minutes}${joint}hour${plural(hour)} ${elementWords(hour, CRON_WORDS.hour)}`;
};

/** A cron expression's days and months in words, each part led by a space; empty for every day of every month. */
const cronDayWords = (cron: CronExpression): string => {
  const { dayOfMonth, dayOfWeek, month } = cron;
  const onDates = everyValue(dayOfMonth) ? null : `on ${elementWords(dayOfMonth, CRON_WORDS.dayOfMonth)}${dayOfMonth.elements.some((element) => element.star) ? "" : " of the month"}`;
  const onWeekdays = everyValue(dayOfWeek) ? null : `on ${elementWords(dayOfWeek, CRON_WORDS.dayOfWeek)}`;
  const days =
    onDates === null ? (onWeekdays ?? "") : onWeekdays === null ? onDates : dayOfMonth.star || dayOfWeek.star ? `${onDates}, if ${onWeekdays}` : `${onDates} or ${onWeekdays}`;
  const months = everyValue(month) ? "" : `in ${elementWords(month, CRON_WORDS.month)}`;
  return [days, months].filter((part) => part !== "").map((part) => ` ${part}`).join("");
};

/** What the schedule says, without its zone. */
const whenInWords = (schedule: RoutineSchedule): string => {
  switch (schedule.kind) {
    case "manual":
      return "Only when run now";
    case "hourly":
      return schedule.minute === 0 ? "Every hour on the hour" : `Every hour at ${schedule.minute} ${schedule.minute === 1 ? "minute" : "minutes"} past`;
    case "daily":
      return `Every day at ${schedule.at}`;
    case "weekdays":
      return `Monday to Friday at ${schedule.at}`;
    case "weekly":
      return `Every ${dayWord(schedule.day)} at ${schedule.at}`;
    case "days":
      return `Every ${listed(ROUTINE_DAYS.filter((day) => schedule.days.includes(day)).map(dayWord))} at ${schedule.at}`;
    case "monthly": {
      const day = ordinal(schedule.day);
      return `On the ${day} of every month at ${schedule.at}${schedule.day > 28 ? `, skipping a month without a ${day}` : ""}`;
    }
    case "cron": {
      const read = readCron(schedule.expression);
      return read.ok ? `${cronTimeWords(read.cron)}${cronDayWords(read.cron)}` : `Cron ${schedule.expression.trim()}`;
    }
  }
};

/**
 * The schedule as one line in words, with its zone, for every renderer to
 * show: `Every day at 09:00 (Asia/Manila)`, `Monday to Friday at 08:30
 * (Europe/London)`, `Every 15 minutes in hours 9 to 17 on Monday to Friday
 * (UTC)`. `manual` has no zone: `Only when run now`.
 */
export const describeSchedule = ({ schedule, timezone }: ZonedSchedule): string => {
  const when = whenInWords(schedule);
  return schedule.kind === "manual" ? when : `${when} (${timezone})`;
};

// Validation --------------------------------------------------------------------------------

/** Whether `onDay` takes any day the calendar has. */
const dueOnAnyDay = (onDay: (day: CalendarDay) => boolean): boolean => {
  for (const [day] of twoDaysRunning()) if (onDay(day)) return true;
  return false;
};

/** Whether `onDay` takes two days running anywhere on the calendar. */
const dueTwoDaysRunning = (onDay: (day: CalendarDay) => boolean): boolean => {
  for (const [day, next] of twoDaysRunning()) if (onDay(day) && onDay(next)) return true;
  return false;
};

/**
 * The fewest minutes two due times of `pattern` can fall apart on the wall
 * clock, judged over every day of the calendar rather than a sample: two
 * minutes in one hour, or the last minute of an hour and the first of the
 * next where both hours are due, 23 and 0 counting when two days running are.
 */
const closestApart = ({ minutes, hours, onDay }: WallPattern): number => {
  let closest = Number.POSITIVE_INFINITY;
  for (const [index, minute] of minutes.entries()) closest = Math.min(closest, (minutes[index + 1] ?? Number.POSITIVE_INFINITY) - minute);
  const acrossTheHour = 60 - (minutes.at(-1) ?? 0) + (minutes[0] ?? 0);
  if (acrossTheHour >= closest) return closest;
  const hoursRunning = hours.some((hour) => hours.includes(hour + 1)) || (hours.includes(23) && hours.includes(0) && dueTwoDaysRunning(onDay));
  return hoursRunning ? acrossTheHour : closest;
};

/** Whether the runtime's IANA data knows `zone` by that name. */
const knownZone = (zone: string): boolean => {
  if (!RoutineTimeZone.safeParse(zone).success) return false;
  try {
    wallClockIn(zone);
    return true;
  } catch {
    return false;
  }
};

const zoneMessage = (zone: string): string => `${JSON.stringify(zone)} is not an IANA time zone this runtime knows, such as Europe/London or Asia/Manila.`;

/** The issues of each field of `schedule`, at paths within the schedule, before the schedule as a whole is judged. */
const fieldIssues = (schedule: RoutineSchedule): ScheduleIssue[] => {
  const issues: ScheduleIssue[] = [];
  const raise = (path: readonly (string | number)[], reason: ScheduleIssueReason, message: string) => issues.push({ path, reason, message });
  const checkAt = (at: string) => {
    if (!HH_MM.test(at)) raise(["at"], "time", `The time must be HH:MM on the 24-hour clock, 00:00 to 23:59, not ${JSON.stringify(at)}.`);
  };
  const named = (day: string): boolean => (ROUTINE_DAYS as readonly string[]).includes(day);
  const notADay = (day: string) => `${JSON.stringify(day)} is not a day: days are named in lower-case English, monday to sunday.`;
  switch (schedule.kind) {
    case "manual":
      break;
    case "hourly":
      if (!Number.isInteger(schedule.minute) || schedule.minute < 0 || schedule.minute > 59) {
        raise(["minute"], "minute", `The minute past the hour must be a whole number from 0 to 59, not ${JSON.stringify(schedule.minute)}.`);
      }
      break;
    case "daily":
    case "weekdays":
      checkAt(schedule.at);
      break;
    case "weekly":
      if (!named(schedule.day)) raise(["day"], "day", notADay(schedule.day));
      checkAt(schedule.at);
      break;
    case "days":
      if (schedule.days.length === 0) raise(["days"], "days_empty", "Some days must name at least one day.");
      for (const [index, day] of schedule.days.entries()) {
        if (!named(day)) raise(["days", index], "day", notADay(day));
        else if (schedule.days.indexOf(day) < index) raise(["days", index], "days_repeated", `${JSON.stringify(day)} is named twice; each day is named once.`);
      }
      checkAt(schedule.at);
      break;
    case "monthly":
      if (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31) {
        raise(["day"], "day_of_month", `The day of the month must be a whole number from 1 to 31, not ${JSON.stringify(schedule.day)}.`);
      }
      checkAt(schedule.at);
      break;
    case "cron": {
      const read = readCron(schedule.expression);
      if (!read.ok) raise(["expression"], read.reason, read.message);
      break;
    }
    default: {
      const { kind } = schedule as { kind: unknown };
      raise(["kind"], "kind", `${JSON.stringify(kind)} is not a schedule kind: manual, hourly, daily, weekdays, weekly, days, monthly or cron.`);
    }
  }
  return issues;
};

/** The issues of `schedule` as a whole, once its fields are sound: a cron expression never due, or due times under the floor apart. */
const wholeIssues = (schedule: RoutineSchedule): ScheduleIssue[] => {
  const pattern = patternOf(schedule);
  if (pattern === null) return [];
  const path = schedule.kind === "cron" ? ["expression"] : [];
  const written = schedule.kind === "cron" ? `The cron expression ${JSON.stringify(schedule.expression.trim())}` : "The schedule";
  if (!dueOnAnyDay(pattern.onDay)) return [{ path, reason: "cron_never", message: `${written} is never due: no month it names has a day it names.` }];
  const apart = closestApart(pattern);
  if (apart >= SCHEDULE_FLOOR_MINUTES) return [];
  const minutes = `${apart} ${apart === 1 ? "minute" : "minutes"}`;
  return [{ path, reason: "floor", message: `${written} can be due ${minutes} apart; due times must fall at least ${SCHEDULE_FLOOR_MINUTES} minutes apart, since each leaves a record.` }];
};

/** The issues of a schedule alone, at paths within it: its fields', else the whole schedule's. */
const scheduleIssues = (schedule: RoutineSchedule): ScheduleIssue[] => {
  const issues = fieldIssues(schedule);
  return issues.length > 0 ? issues : wholeIssues(schedule);
};

/**
 * Checks a schedule in its zone, answering each problem as an issue at its
 * path in the definition (none when it is sound): each kind's fields; for
 * cron, the five fields cron reads (no seconds field, no `@` form) and a
 * day it can fall on; the five-minute floor, judged over the schedule's
 * wall-clock minutes on every day of the calendar; and the zone, which the
 * runtime's IANA data must know by name.
 */
export const validateSchedule = ({ schedule, timezone }: ZonedSchedule): ScheduleIssue[] => {
  const issues = scheduleIssues(schedule).map((issue) => ({ ...issue, path: ["schedule", ...issue.path] }));
  if (!knownZone(timezone)) issues.push({ path: ["timezone"], reason: "zone", message: zoneMessage(timezone) });
  return issues;
};
