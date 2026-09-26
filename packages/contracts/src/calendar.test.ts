import { describe, expect, it } from "vitest";
import { addCalendarMonths, snoozeLimit } from "./calendar.js";

describe("calendar arithmetic", () => {
  it("adds calendar months keeping the time of day, clamping a month-end to the shorter month's last day", () => {
    const plus = (from: string, months: number) => addCalendarMonths(new Date(from), months).toISOString();
    expect(plus("2026-01-15T10:00:00.000Z", 1)).toBe("2026-02-15T10:00:00.000Z");
    expect(plus("2026-01-31T10:00:00.000Z", 1)).toBe("2026-02-28T10:00:00.000Z");
    expect(plus("2028-01-31T10:00:00.000Z", 1)).toBe("2028-02-29T10:00:00.000Z");
    expect(plus("2026-03-31T23:59:59.999Z", 1)).toBe("2026-04-30T23:59:59.999Z");
    expect(plus("2026-08-31T00:00:00.000Z", 6)).toBe("2027-02-28T00:00:00.000Z");
    expect(plus("2026-12-31T00:00:00.000Z", 2)).toBe("2027-02-28T00:00:00.000Z");
    expect(plus("2026-10-31T00:00:00.000Z", 12)).toBe("2027-10-31T00:00:00.000Z");
  });

  it("ends a snooze's window a calendar year on: a leap day's is the next February's last day", () => {
    expect(snoozeLimit(new Date("2028-02-29T12:00:00.000Z")).toISOString()).toBe("2029-02-28T12:00:00.000Z");
    expect(snoozeLimit(new Date("2026-09-26T08:30:00.000Z")).toISOString()).toBe("2027-09-26T08:30:00.000Z");
  });
});
