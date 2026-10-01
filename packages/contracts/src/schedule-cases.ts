import type { RoutineSchedule, ScheduleIssueReason } from "./schedule.js";

/**
 * The published cases of the schedule maths (routines spec, "Schedules"):
 * each rule's inputs and the answers the contracts give, written to the JSON
 * Schema export under `cases/` for a client in another language to run its
 * own implementation against. Instants are UTC; zones are IANA names.
 */

/** One published case of the due times: a schedule in its zone, two instants, and what the maths answers between them. */
export interface ScheduleDueTimesCase {
  /** What the case shows. */
  readonly note: string;
  readonly schedule: RoutineSchedule;
  readonly timezone: string;
  readonly after: string;
  readonly through: string;
  /** The first due time strictly after `after`, or null for none. */
  readonly next: string | null;
  /** Every due time strictly after `after` and at or before `through`, in order. */
  readonly dueTimes: readonly string[];
}

/** 2026-10-01 is a Thursday; Asia/Manila is UTC+8 all year. */
const manila = { timezone: "Asia/Manila", after: "2026-10-01T00:00:00.000Z" } as const;

/**
 * The due times' cases, published in the JSON Schema export as
 * `cases/schedule-due-times.json`.
 */
export const SCHEDULE_DUE_TIME_CASES: readonly ScheduleDueTimesCase[] = [
  // Each kind on time.
  { note: "manual is never due", schedule: { kind: "manual" }, ...manila, through: "2026-11-01T00:00:00.000Z", next: null, dueTimes: [] },
  {
    note: "hourly at five past",
    schedule: { kind: "hourly", minute: 5 },
    ...manila,
    through: "2026-10-01T03:00:00.000Z",
    next: "2026-10-01T00:05:00.000Z",
    dueTimes: ["2026-10-01T00:05:00.000Z", "2026-10-01T01:05:00.000Z", "2026-10-01T02:05:00.000Z"],
  },
  {
    note: "daily at 09:00",
    schedule: { kind: "daily", at: "09:00" },
    ...manila,
    through: "2026-10-03T00:00:00.000Z",
    next: "2026-10-01T01:00:00.000Z",
    dueTimes: ["2026-10-01T01:00:00.000Z", "2026-10-02T01:00:00.000Z"],
  },
  {
    note: "weekdays at 09:00, Thursday to the next Tuesday",
    schedule: { kind: "weekdays", at: "09:00" },
    ...manila,
    through: "2026-10-06T00:00:00.000Z",
    next: "2026-10-01T01:00:00.000Z",
    dueTimes: ["2026-10-01T01:00:00.000Z", "2026-10-02T01:00:00.000Z", "2026-10-05T01:00:00.000Z"],
  },
  {
    note: "weekly on Sunday at 18:30",
    schedule: { kind: "weekly", day: "sunday", at: "18:30" },
    ...manila,
    through: "2026-10-12T00:00:00.000Z",
    next: "2026-10-04T10:30:00.000Z",
    dueTimes: ["2026-10-04T10:30:00.000Z", "2026-10-11T10:30:00.000Z"],
  },
  {
    note: "some days, Friday and Monday at 07:00, which is the day before in UTC",
    schedule: { kind: "days", days: ["friday", "monday"], at: "07:00" },
    ...manila,
    through: "2026-10-06T00:00:00.000Z",
    next: "2026-10-01T23:00:00.000Z",
    dueTimes: ["2026-10-01T23:00:00.000Z", "2026-10-04T23:00:00.000Z"],
  },
  {
    note: "monthly on the 15th at 12:00",
    schedule: { kind: "monthly", day: 15, at: "12:00" },
    ...manila,
    through: "2026-12-01T00:00:00.000Z",
    next: "2026-10-15T04:00:00.000Z",
    dueTimes: ["2026-10-15T04:00:00.000Z", "2026-11-15T04:00:00.000Z"],
  },
  {
    note: "cron at 14:15 on the 1st",
    schedule: { kind: "cron", expression: "15 14 1 * *" },
    ...manila,
    through: "2026-11-02T00:00:00.000Z",
    next: "2026-10-01T06:15:00.000Z",
    dueTimes: ["2026-10-01T06:15:00.000Z", "2026-11-01T06:15:00.000Z"],
  },
  // Cron's day fields: both restricted combine with OR; one restricted restricts. October 2026's Fridays are the 2nd, 9th,
  // 16th, 23rd and 30th, and its 13th is a Tuesday.
  {
    note: "cron with both day fields restricted is due on either: the 13th or a Friday",
    schedule: { kind: "cron", expression: "0 9 13 * fri" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-17T00:00:00.000Z",
    next: "2026-10-02T09:00:00.000Z",
    dueTimes: ["2026-10-02T09:00:00.000Z", "2026-10-09T09:00:00.000Z", "2026-10-13T09:00:00.000Z", "2026-10-16T09:00:00.000Z"],
  },
  {
    note: "cron with only the day of month restricted is due on that day",
    schedule: { kind: "cron", expression: "0 9 13 * *" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-17T00:00:00.000Z",
    next: "2026-10-13T09:00:00.000Z",
    dueTimes: ["2026-10-13T09:00:00.000Z"],
  },
  {
    note: "cron with only the day of week restricted is due on those days",
    schedule: { kind: "cron", expression: "0 9 * * 5" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-17T00:00:00.000Z",
    next: "2026-10-02T09:00:00.000Z",
    dueTimes: ["2026-10-02T09:00:00.000Z", "2026-10-09T09:00:00.000Z", "2026-10-16T09:00:00.000Z"],
  },
  {
    note: "a day field beginning with * is not restricted, as Vixie cron reads it, so */2 and Friday combine with AND: odd days that are Fridays",
    schedule: { kind: "cron", expression: "0 9 */2 * fri" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-11-01T00:00:00.000Z",
    next: "2026-10-09T09:00:00.000Z",
    dueTimes: ["2026-10-09T09:00:00.000Z", "2026-10-23T09:00:00.000Z"],
  },
  // Cron's names and steps.
  {
    note: "month names, in any case, in a list",
    schedule: { kind: "cron", expression: "0 12 1 JAN,jul *" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2027-08-01T00:00:00.000Z",
    next: "2027-01-01T12:00:00.000Z",
    dueTimes: ["2027-01-01T12:00:00.000Z", "2027-07-01T12:00:00.000Z"],
  },
  {
    note: "day names in a range, and 7 for Sunday",
    schedule: { kind: "cron", expression: "30 8 * * Sat-sat,7" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-12T00:00:00.000Z",
    next: "2026-10-03T08:30:00.000Z",
    dueTimes: ["2026-10-03T08:30:00.000Z", "2026-10-04T08:30:00.000Z", "2026-10-10T08:30:00.000Z", "2026-10-11T08:30:00.000Z"],
  },
  {
    note: "a step over * counts from the field's first value",
    schedule: { kind: "cron", expression: "0 */6 * * sat" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-04T00:00:00.000Z",
    next: "2026-10-03T00:00:00.000Z",
    dueTimes: ["2026-10-03T00:00:00.000Z", "2026-10-03T06:00:00.000Z", "2026-10-03T12:00:00.000Z", "2026-10-03T18:00:00.000Z"],
  },
  {
    note: "a step over a range counts from the range's start, and a leading zero is read as a number",
    schedule: { kind: "cron", expression: "10-50/20 09 * * *" },
    timezone: "UTC",
    after: "2026-10-01T00:00:00.000Z",
    through: "2026-10-01T12:00:00.000Z",
    next: "2026-10-01T09:10:00.000Z",
    dueTimes: ["2026-10-01T09:10:00.000Z", "2026-10-01T09:30:00.000Z", "2026-10-01T09:50:00.000Z"],
  },
  // A clock change that skips an hour: Europe/London goes from 01:00 GMT to 02:00 BST on 2026-03-29 (01:00 UTC),
  // America/New_York from 02:00 EST to 03:00 EDT on 2026-03-08 (07:00 UTC).
  {
    note: "a daily time the clock skips fires at the first minute after the gap, 02:00 BST",
    schedule: { kind: "daily", at: "01:30" },
    timezone: "Europe/London",
    after: "2026-03-28T12:00:00.000Z",
    through: "2026-03-30T12:00:00.000Z",
    next: "2026-03-29T01:00:00.000Z",
    dueTimes: ["2026-03-29T01:00:00.000Z", "2026-03-30T00:30:00.000Z"],
  },
  {
    note: "hourly through the skipped hour: 01:30 falls in the gap and fires at 02:00 BST, half an hour before 02:30",
    schedule: { kind: "hourly", minute: 30 },
    timezone: "Europe/London",
    after: "2026-03-29T00:00:00.000Z",
    through: "2026-03-29T03:00:00.000Z",
    next: "2026-03-29T00:30:00.000Z",
    dueTimes: ["2026-03-29T00:30:00.000Z", "2026-03-29T01:00:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-29T02:30:00.000Z"],
  },
  {
    note: "a daily time the clock skips fires at the first minute after the gap, 03:00 EDT",
    schedule: { kind: "daily", at: "02:30" },
    timezone: "America/New_York",
    after: "2026-03-07T12:00:00.000Z",
    through: "2026-03-09T12:00:00.000Z",
    next: "2026-03-08T07:00:00.000Z",
    dueTimes: ["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"],
  },
  {
    note: "two times inside one gap fire once, at the first minute after it",
    schedule: { kind: "cron", expression: "0,30 2 * * *" },
    timezone: "America/New_York",
    after: "2026-03-08T00:00:00.000Z",
    through: "2026-03-08T12:00:00.000Z",
    next: "2026-03-08T07:00:00.000Z",
    dueTimes: ["2026-03-08T07:00:00.000Z"],
  },
  // A clock change that repeats an hour: Europe/London goes from 02:00 BST back to 01:00 GMT on 2026-10-25 (01:00 UTC),
  // America/New_York from 02:00 EDT back to 01:00 EST on 2026-11-01 (06:00 UTC).
  {
    note: "a daily time the clock repeats fires once, at its first occurrence, 01:30 BST",
    schedule: { kind: "daily", at: "01:30" },
    timezone: "Europe/London",
    after: "2026-10-24T12:00:00.000Z",
    through: "2026-10-26T12:00:00.000Z",
    next: "2026-10-25T00:30:00.000Z",
    dueTimes: ["2026-10-25T00:30:00.000Z", "2026-10-26T01:30:00.000Z"],
  },
  {
    note: "hourly through the repeated hour: 01:15 fires at 01:15 EDT and not again at 01:15 EST",
    schedule: { kind: "hourly", minute: 15 },
    timezone: "America/New_York",
    after: "2026-11-01T04:00:00.000Z",
    through: "2026-11-01T08:00:00.000Z",
    next: "2026-11-01T04:15:00.000Z",
    dueTimes: ["2026-11-01T04:15:00.000Z", "2026-11-01T05:15:00.000Z", "2026-11-01T07:15:00.000Z"],
  },
  {
    note: "from inside the repeated hour, its minutes have had their occurrence: next is 02:15 EST",
    schedule: { kind: "hourly", minute: 15 },
    timezone: "America/New_York",
    after: "2026-11-01T06:00:00.000Z",
    through: "2026-11-01T07:15:00.000Z",
    next: "2026-11-01T07:15:00.000Z",
    dueTimes: ["2026-11-01T07:15:00.000Z"],
  },
  // A month without the day.
  {
    note: "monthly on the 31st skips the months without one",
    schedule: { kind: "monthly", day: 31, at: "09:00" },
    timezone: "UTC",
    after: "2026-01-01T00:00:00.000Z",
    through: "2026-08-01T00:00:00.000Z",
    next: "2026-01-31T09:00:00.000Z",
    dueTimes: ["2026-01-31T09:00:00.000Z", "2026-03-31T09:00:00.000Z", "2026-05-31T09:00:00.000Z", "2026-07-31T09:00:00.000Z"],
  },
  {
    note: "monthly on the 29th skips February in a common year and keeps it in a leap year",
    schedule: { kind: "monthly", day: 29, at: "09:00" },
    timezone: "UTC",
    after: "2027-02-01T00:00:00.000Z",
    through: "2028-03-01T00:00:00.000Z",
    next: "2027-03-29T09:00:00.000Z",
    dueTimes: [
      "2027-03-29T09:00:00.000Z",
      "2027-04-29T09:00:00.000Z",
      "2027-05-29T09:00:00.000Z",
      "2027-06-29T09:00:00.000Z",
      "2027-07-29T09:00:00.000Z",
      "2027-08-29T09:00:00.000Z",
      "2027-09-29T09:00:00.000Z",
      "2027-10-29T09:00:00.000Z",
      "2027-11-29T09:00:00.000Z",
      "2027-12-29T09:00:00.000Z",
      "2028-01-29T09:00:00.000Z",
      "2028-02-29T09:00:00.000Z",
    ],
  },
];

/** A schedule as a client may write it, kind and fields, before anything has checked them. */
export interface ScheduleAsWritten {
  readonly kind: string;
  readonly [field: string]: unknown;
}

/** One published case of validation: a schedule and zone in, and each issue the check finds, by its path and reason. */
export interface ScheduleValidationCase {
  /** What the case shows. */
  readonly note: string;
  readonly schedule: ScheduleAsWritten;
  readonly timezone: string;
  readonly issues: readonly { readonly path: readonly (string | number)[]; readonly reason: ScheduleIssueReason }[];
}

const expression = ["schedule", "expression"] as const;
const cron = (written: string) => ({ kind: "cron", expression: written });
/** A cron expression's case in UTC: refused for `reason`, or taken when it is null. */
const cronCase = (note: string, written: string, reason: ScheduleIssueReason | null): ScheduleValidationCase => ({
  note,
  schedule: cron(written),
  timezone: "UTC",
  issues: reason === null ? [] : [{ path: expression, reason }],
});

/**
 * The validation cases, published in the JSON Schema export as
 * `cases/schedule-validation.json`.
 */
export const SCHEDULE_VALIDATION_CASES: readonly ScheduleValidationCase[] = [
  // Each kind's fields.
  { note: "manual", schedule: { kind: "manual" }, timezone: "UTC", issues: [] },
  { note: "hourly at 0", schedule: { kind: "hourly", minute: 0 }, timezone: "UTC", issues: [] },
  { note: "hourly at 59", schedule: { kind: "hourly", minute: 59 }, timezone: "UTC", issues: [] },
  { note: "hourly at 60", schedule: { kind: "hourly", minute: 60 }, timezone: "UTC", issues: [{ path: ["schedule", "minute"], reason: "minute" }] },
  { note: "hourly at -1", schedule: { kind: "hourly", minute: -1 }, timezone: "UTC", issues: [{ path: ["schedule", "minute"], reason: "minute" }] },
  { note: "hourly at a fraction", schedule: { kind: "hourly", minute: 1.5 }, timezone: "UTC", issues: [{ path: ["schedule", "minute"], reason: "minute" }] },
  { note: "daily at 00:00", schedule: { kind: "daily", at: "00:00" }, timezone: "UTC", issues: [] },
  { note: "daily at 23:59", schedule: { kind: "daily", at: "23:59" }, timezone: "UTC", issues: [] },
  { note: "daily at 24:00", schedule: { kind: "daily", at: "24:00" }, timezone: "UTC", issues: [{ path: ["schedule", "at"], reason: "time" }] },
  { note: "daily at 9:00, one digit for the hour", schedule: { kind: "daily", at: "9:00" }, timezone: "UTC", issues: [{ path: ["schedule", "at"], reason: "time" }] },
  { note: "weekdays at 12:60", schedule: { kind: "weekdays", at: "12:60" }, timezone: "UTC", issues: [{ path: ["schedule", "at"], reason: "time" }] },
  { note: "weekly on a named day", schedule: { kind: "weekly", day: "sunday", at: "09:30" }, timezone: "UTC", issues: [] },
  { note: "weekly on a capitalised day", schedule: { kind: "weekly", day: "Sunday", at: "09:30" }, timezone: "UTC", issues: [{ path: ["schedule", "day"], reason: "day" }] },
  { note: "weekly on cron's short name", schedule: { kind: "weekly", day: "sun", at: "09:30" }, timezone: "UTC", issues: [{ path: ["schedule", "day"], reason: "day" }] },
  { note: "some days, each named once", schedule: { kind: "days", days: ["monday", "thursday"], at: "18:05" }, timezone: "UTC", issues: [] },
  { note: "some days, none", schedule: { kind: "days", days: [], at: "18:05" }, timezone: "UTC", issues: [{ path: ["schedule", "days"], reason: "days_empty" }] },
  {
    note: "some days, one named twice, at the repeat",
    schedule: { kind: "days", days: ["monday", "friday", "monday"], at: "18:05" },
    timezone: "UTC",
    issues: [{ path: ["schedule", "days", 2], reason: "days_repeated" }],
  },
  { note: "some days, one not a day", schedule: { kind: "days", days: ["monday", "someday"], at: "18:05" }, timezone: "UTC", issues: [{ path: ["schedule", "days", 1], reason: "day" }] },
  { note: "monthly on the 1st", schedule: { kind: "monthly", day: 1, at: "03:00" }, timezone: "UTC", issues: [] },
  { note: "monthly on the 31st", schedule: { kind: "monthly", day: 31, at: "03:00" }, timezone: "UTC", issues: [] },
  { note: "monthly on the 0th", schedule: { kind: "monthly", day: 0, at: "03:00" }, timezone: "UTC", issues: [{ path: ["schedule", "day"], reason: "day_of_month" }] },
  { note: "monthly on the 32nd", schedule: { kind: "monthly", day: 32, at: "03:00" }, timezone: "UTC", issues: [{ path: ["schedule", "day"], reason: "day_of_month" }] },
  { note: "a kind there is not", schedule: { kind: "yearly", at: "03:00" }, timezone: "UTC", issues: [{ path: ["schedule", "kind"], reason: "kind" }] },
  {
    note: "each field's issue at its own path",
    schedule: { kind: "days", days: ["monday", "monday"], at: "7:00" },
    timezone: "UTC",
    issues: [
      { path: ["schedule", "days", 1], reason: "days_repeated" },
      { path: ["schedule", "at"], reason: "time" },
    ],
  },
  // The zone.
  { note: "a zone the runtime knows", schedule: { kind: "daily", at: "09:00" }, timezone: "America/Argentina/Buenos_Aires", issues: [] },
  { note: "UTC", schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", issues: [] },
  { note: "an Etc zone", schedule: { kind: "daily", at: "09:00" }, timezone: "Etc/GMT+5", issues: [] },
  { note: "a zone no runtime knows", schedule: { kind: "daily", at: "09:00" }, timezone: "Mars/Olympus_Mons", issues: [{ path: ["timezone"], reason: "zone" }] },
  { note: "an offset is not a zone", schedule: { kind: "daily", at: "09:00" }, timezone: "+08:00", issues: [{ path: ["timezone"], reason: "zone" }] },
  { note: "an empty zone", schedule: { kind: "daily", at: "09:00" }, timezone: "", issues: [{ path: ["timezone"], reason: "zone" }] },
  {
    note: "a schedule's issue and the zone's together",
    schedule: { kind: "hourly", minute: 75 },
    timezone: "Nowhere/Atlantis",
    issues: [
      { path: ["schedule", "minute"], reason: "minute" },
      { path: ["timezone"], reason: "zone" },
    ],
  },
  // Cron's grammar.
  cronCase("five fields with *, a list, a range, a step and names", "0,30 9-17/2 */10 jan-mar mon-fri", null),
  cronCase("names in any case, and 7 for Sunday", "15 6 * JAN,Jul Sun,7", null),
  cronCase("white space around and between the fields", "  0   9\t* * *  ", null),
  cronCase("an @ form", "@daily", "cron_at_form"),
  cronCase("@reboot", "@reboot", "cron_at_form"),
  cronCase("a seconds field", "0 0 9 * * *", "cron_seconds"),
  cronCase("four fields", "0 9 * *", "cron_fields"),
  cronCase("seven fields", "0 0 9 * * * 2026", "cron_fields"),
  cronCase("only white space", "   ", "cron_fields"),
  cronCase("minute 60", "60 9 * * *", "cron_range"),
  cronCase("hour 24", "0 24 * * *", "cron_range"),
  cronCase("day of month 0", "0 9 0 * *", "cron_range"),
  cronCase("month 13", "0 9 * 13 *", "cron_range"),
  cronCase("day of week 8", "0 9 * * 8", "cron_range"),
  cronCase("a range past the field's end", "0-60 9 * * *", "cron_range"),
  cronCase("a range that runs backwards", "0 17-9 * * *", "cron_backwards"),
  cronCase("day names that run backwards, Sunday being 0", "0 9 * * fri-sun", "cron_backwards"),
  cronCase("a step of 0", "*/0 9 * * *", "cron_syntax"),
  cronCase("a step after one value", "5/15 9 * * *", "cron_syntax"),
  cronCase("an empty element in a list", "0,,30 9 * * *", "cron_syntax"),
  cronCase("a whole day name", "0 9 * * monday", "cron_syntax"),
  cronCase("a day name in the month field", "0 9 * mon *", "cron_syntax"),
  cronCase("a month name in the minute field", "jan 9 * * *", "cron_syntax"),
  cronCase("a question mark", "0 9 ? * mon", "cron_syntax"),
  cronCase("L for the last day", "0 9 L * *", "cron_syntax"),
  cronCase("# for the nth weekday", "0 9 * * mon#1", "cron_syntax"),
  cronCase("a negative value", "0 9 -1 * *", "cron_syntax"),
  // Never due.
  cronCase("the 30th of February is never due", "0 9 30 2 *", "cron_never"),
  cronCase("the 31st of the 30-day months is never due", "0 9 31 apr,jun,sep,nov *", "cron_never"),
  cronCase("the 29th of February is due in leap years", "0 9 29 2 *", null),
  cronCase("the 30th of February or a Monday is due on the Mondays", "0 9 30 2 mon", null),
  // The five-minute floor, judged over the schedule.
  cronCase("every minute is refused", "* * * * *", "floor"),
  cronCase("every second minute is refused", "*/2 * * * *", "floor"),
  cronCase("minutes 0 and 58 are refused: 09:58 and 10:00 are two minutes apart", "0,58 * * * *", "floor"),
  cronCase("a run of minutes is refused", "0-4 9 * * *", "floor"),
  cronCase("minutes 0 and 58 in hours 9 and 10 are refused", "0,58 9,10 * * *", "floor"),
  cronCase("minutes 0 and 58 in hours 9 and 11 are taken: 09:58 and 11:00 are an hour apart", "0,58 9,11 * * *", null),
  cronCase("minutes 0 and 58 at 23 and 0 are refused when two days run: 23:58 and 00:00", "0,58 0,23 * * *", "floor"),
  cronCase("minutes 0 and 58 at 23 and 0 on the 1st only are taken: no two such days run", "0,58 0,23 1 * *", null),
  cronCase("minutes 0 and 58 at 23 and 0 on the 31st or the 1st are refused: the 31st runs into the 1st", "0,58 0,23 1,31 * *", "floor"),
  cronCase("minutes 0 and 58 at 23 and 0 on Saturday and Sunday are refused", "0,58 0,23 * * sat,sun", "floor"),
  cronCase("every fifth minute is taken", "*/5 * * * *", null),
  cronCase("minutes 0 and 5 are taken: five minutes apart", "0,5 * * * *", null),
  { note: "hourly is taken", schedule: { kind: "hourly", minute: 59 }, timezone: "UTC", issues: [] },
  { note: "some days on each day of the week is taken", schedule: { kind: "days", days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"], at: "23:59" }, timezone: "UTC", issues: [] },
];
