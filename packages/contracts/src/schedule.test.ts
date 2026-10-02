import { describe, expect, it } from "vitest";
import { describeSchedule, dueTimesBetween, nextDueAt, type RoutineSchedule, validateSchedule } from "./schedule.js";
import { SCHEDULE_DUE_TIME_CASES, SCHEDULE_VALIDATION_CASES } from "./schedule-cases.js";

const instant = (iso: string): Date => new Date(iso);
const isos = (instants: readonly Date[]): string[] => instants.map((due) => due.toISOString());

describe("the next due time", () => {
  it("is the first minute after an instant at which the schedule is due, in the routine's zone", () => {
    const zoned = { schedule: { kind: "daily", at: "09:00" }, timezone: "Asia/Manila" } as const;
    expect(nextDueAt(zoned, instant("2026-10-01T00:00:00.000Z"))).toEqual(instant("2026-10-01T01:00:00.000Z"));
    expect(nextDueAt(zoned, instant("2026-10-01T01:00:00.000Z"))).toEqual(instant("2026-10-02T01:00:00.000Z"));
    expect(nextDueAt(zoned, instant("2026-10-01T00:59:59.999Z"))).toEqual(instant("2026-10-01T01:00:00.000Z"));
  });
});

describe("a schedule its maths cannot follow", () => {
  const after = instant("2026-10-01T00:00:00.000Z");
  const through = instant("2027-10-01T00:00:00.000Z");

  it("has no due time: a cron expression never due or unreadable, or a zone the runtime does not know", () => {
    for (const zoned of [
      { schedule: { kind: "cron", expression: "0 9 30 2 *" }, timezone: "UTC" },
      { schedule: { kind: "cron", expression: "0 0 9 * * *" }, timezone: "UTC" },
      { schedule: { kind: "daily", at: "09:00" }, timezone: "Mars/Olympus_Mons" },
    ] as const) {
      expect(nextDueAt(zoned, after), JSON.stringify(zoned)).toBeNull();
      expect(dueTimesBetween(zoned, after, through), JSON.stringify(zoned)).toEqual([]);
    }
  });

  it("still finds a due time eight years away: 2100 is no leap year, so the 29th of February after 2096's is 2104's", () => {
    expect(nextDueAt({ schedule: { kind: "cron", expression: "0 9 29 2 *" }, timezone: "UTC" }, instant("2096-03-01T00:00:00.000Z"))?.toISOString()).toBe("2104-02-29T09:00:00.000Z");
  });
});

describe.each(SCHEDULE_DUE_TIME_CASES.map((entry) => [entry.note, entry] as const))("the published case: %s", (_, entry) => {
  it("answers its next due time", () => {
    expect(nextDueAt(entry, instant(entry.after))?.toISOString() ?? null).toBe(entry.next);
  });

  it("answers its due times between the two instants", () => {
    expect(isos(dueTimesBetween(entry, instant(entry.after), instant(entry.through)))).toEqual(entry.dueTimes);
  });
});

describe.each(SCHEDULE_VALIDATION_CASES.map((entry) => [entry.note, entry] as const))("the published validation case: %s", (_, entry) => {
  it("finds each issue at its path, with its reason", () => {
    const issues = validateSchedule({ schedule: entry.schedule as RoutineSchedule, timezone: entry.timezone });
    expect(issues.map(({ path, reason }) => ({ path, reason }))).toEqual(entry.issues);
    for (const issue of issues) expect(issue.message, issue.reason).toMatch(/^[A-Z"].*\.$/);
  });
});

describe("a schedule in words", () => {
  const words = (schedule: RoutineSchedule, timezone = "Asia/Manila"): string => describeSchedule({ schedule, timezone });

  it("is one line for each kind, with the zone", () => {
    expect(words({ kind: "manual" })).toBe("Only when run now");
    expect(words({ kind: "hourly", minute: 0 })).toBe("Every hour on the hour (Asia/Manila)");
    expect(words({ kind: "hourly", minute: 1 })).toBe("Every hour at 1 minute past (Asia/Manila)");
    expect(words({ kind: "hourly", minute: 45 })).toBe("Every hour at 45 minutes past (Asia/Manila)");
    expect(words({ kind: "daily", at: "09:00" })).toBe("Every day at 09:00 (Asia/Manila)");
    expect(words({ kind: "weekdays", at: "08:30" })).toBe("Monday to Friday at 08:30 (Asia/Manila)");
    expect(words({ kind: "weekly", day: "sunday", at: "18:30" })).toBe("Every Sunday at 18:30 (Asia/Manila)");
    expect(words({ kind: "days", days: ["friday", "monday", "wednesday"], at: "07:00" })).toBe("Every Monday, Wednesday and Friday at 07:00 (Asia/Manila)");
    expect(words({ kind: "days", days: ["tuesday"], at: "07:00" })).toBe("Every Tuesday at 07:00 (Asia/Manila)");
    expect(words({ kind: "monthly", day: 15, at: "12:00" }, "UTC")).toBe("On the 15th of every month at 12:00 (UTC)");
    expect(words({ kind: "cron", expression: "0 9 * * 1-5" }, "Europe/London")).toBe("At 09:00 on Monday to Friday (Europe/London)");
  });

  it("says a month's days by their ordinals, and that a month without the day is skipped", () => {
    const monthly = (day: number) => words({ kind: "monthly", day, at: "03:00" }, "UTC");
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(monthly)).toEqual(
      ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "28th"].map((day) => `On the ${day} of every month at 03:00 (UTC)`),
    );
    expect(monthly(29)).toBe("On the 29th of every month at 03:00, skipping a month without a 29th (UTC)");
    expect(monthly(31)).toBe("On the 31st of every month at 03:00, skipping a month without a 31st (UTC)");
  });

  it("reads a cron expression's fields in words", () => {
    const cron = (expression: string) => words({ kind: "cron", expression }, "UTC");
    expect(cron("*/5 * * * *")).toBe("Every 5 minutes (UTC)");
    expect(cron("5 * * * *")).toBe("At minute 5 of every hour (UTC)");
    expect(cron("0 9,17 * * *")).toBe("At 09:00 and 17:00 (UTC)");
    expect(cron("0,30 9 * * *")).toBe("At 09:00 and 09:30 (UTC)");
    expect(cron("*/15 9-17 * * mon-fri")).toBe("Every 15 minutes in hours 9 to 17 on Monday to Friday (UTC)");
    expect(cron("0 */6 * * sat")).toBe("At minute 0 of every 6th hour on Saturday (UTC)");
    expect(cron("10-50/20 9-10 * * *")).toBe("At minutes 10 to 50 every 20th of hours 9 to 10 (UTC)");
    expect(cron("0 9 13 * fri")).toBe("At 09:00 on the 13th of the month or on Friday (UTC)");
    expect(cron("0 9 */2 * fri")).toBe("At 09:00 on every 2nd day of the month, if on Friday (UTC)");
    expect(cron("0 12 1,15 jan,jul *")).toBe("At 12:00 on the 1st and the 15th of the month in January and July (UTC)");
    expect(cron("0 12 1-7 */3 0,7")).toBe("At 12:00 on the 1st to the 7th of the month or on Sunday in every 3rd month (UTC)");
    expect(cron("0 12 1,*/10 * *")).toBe("At 12:00 on the 1st and every 10th day of the month (UTC)");
  });
});
