import { afterEach, describe, expect, it } from "vitest";
import { parseWhen, presetTimes, wakeWords, whenWords } from "./when.js";

/**
 * The snooze picker's times (docs/specs/tui.md, "The rail"): an hour, this
 * evening, tomorrow morning, next Monday, or a typed time, each an instant
 * sent as absolute UTC. Reckoned on this terminal's calendar from the
 * environment's now, so the tests build their expectations in local time.
 */

// Thursday 24 September 2026, 10:30 on this machine's calendar.
const now = new Date(2026, 8, 24, 10, 30);
const at = (day: number, hours: number, minutes = 0, month = 8) => new Date(2026, month, day, hours, minutes);

describe("the presets", () => {
  it("are an hour on, this evening at 18:00, tomorrow at 09:00 and next Monday at 09:00", () => {
    expect(presetTimes(now).map((p) => [p.label, p.at?.getTime()])).toEqual([
      ["An hour", at(24, 11, 30).getTime()],
      ["This evening", at(24, 18).getTime()],
      ["Tomorrow morning", at(25, 9).getTime()],
      ["Next Monday", at(28, 9).getTime()],
    ]);
  });

  it("say why this evening is not offered once 18:00 has passed", () => {
    const late = presetTimes(at(24, 19));
    expect(late[1]).toMatchObject({ label: "This evening", at: null, absent: "It is past 18:00." });
  });

  it("take next Monday as a week on from a Monday", () => {
    expect(presetTimes(at(28, 8)).at(3)?.at?.getTime()).toBe(at(5, 9, 0, 9).getTime());
  });
});

describe("a typed time", () => {
  const parsed = (text: string) => {
    const answer = parseWhen(text, now);
    return answer instanceof Date ? answer.getTime() : answer.problem;
  };

  it("reads a span from now", () => {
    expect(parsed("2h")).toBe(at(24, 12, 30).getTime());
    expect(parsed("in 30 minutes")).toBe(at(24, 11).getTime());
    expect(parsed("3d")).toBe(at(27, 10, 30).getTime());
    expect(parsed("an hour")).toBe(at(24, 11, 30).getTime());
  });

  it("reads a clock time today, or tomorrow once it has passed", () => {
    expect(parsed("14:15")).toBe(at(24, 14, 15).getTime());
    expect(parsed("9:00")).toBe(at(25, 9).getTime());
    expect(parsed("9pm")).toBe(at(24, 21).getTime());
    expect(parsed("7:45am")).toBe(at(25, 7, 45).getTime());
  });

  it("reads the words of the presets, a weekday and a date, with or without a time", () => {
    expect(parsed("tomorrow")).toBe(at(25, 9).getTime());
    expect(parsed("tomorrow 14:00")).toBe(at(25, 14).getTime());
    expect(parsed("evening")).toBe(at(24, 18).getTime());
    expect(parsed("monday")).toBe(at(28, 9).getTime());
    expect(parsed("next tue 8:00")).toBe(at(29, 8).getTime());
    expect(parsed("2026-10-02")).toBe(at(2, 9, 0, 9).getTime());
    expect(parsed("2026-10-02 17:30")).toBe(at(2, 17, 30, 9).getTime());
    expect(parsed("2026-09-30T06:00:00Z")).toBe(Date.parse("2026-09-30T06:00:00Z"));
  });

  it("refuses what is not a time, a time gone, and a time more than a year ahead", () => {
    expect(parsed("soonish")).toBe("Not a time: try 2h, 18:00, tomorrow, monday 9:00 or 2026-10-02 17:30.");
    expect(parsed("2026-09-01")).toBe("That time has passed.");
    expect(parsed("2027-12-01")).toBe("That is more than a year ahead; a snooze is at most a year.");
    expect(parsed("25:00")).toBe("Not a time: try 2h, 18:00, tomorrow, monday 9:00 or 2026-10-02 17:30.");
  });

  it("takes a year as the environment does, a calendar year on in UTC: from a leap day, to the next February's last day", () => {
    const leapDay = new Date("2028-02-29T12:00:00.000Z");
    expect(parseWhen("2029-02-28T12:00:00Z", leapDay)).toEqual(new Date("2029-02-28T12:00:00.000Z"));
    expect(parseWhen("2029-02-28T12:00:01Z", leapDay)).toEqual({ problem: "That is more than a year ahead; a snooze is at most a year." });
    expect(parseWhen("2029-03-01T11:00:00Z", leapDay)).toEqual({ problem: "That is more than a year ahead; a snooze is at most a year." });
  });
});

describe("the words for a time", () => {
  it("in the rail: the clock time today, the weekday within the week, else the date", () => {
    expect(wakeWords(at(24, 18), now)).toBe("18:00");
    expect(wakeWords(at(28, 9), now)).toBe("Mon 09:00");
    expect(wakeWords(at(5, 9, 0, 9), now)).toBe("5 Oct");
  });

  describe("across a change to summer time", () => {
    const zone = process.env["TZ"];
    afterEach(() => {
      if (zone === undefined) delete process.env["TZ"];
      else process.env["TZ"] = zone;
    });

    it("counts calendar days, not 24-hour spans: a week on is the date, even over the short night", () => {
      // Berlin's clocks go forward in the night of Sunday 29 March 2026, so that week is an hour short.
      process.env["TZ"] = "Europe/Berlin";
      const saturday = new Date(2026, 2, 28, 10, 0);
      expect(wakeWords(new Date(2026, 3, 4, 9, 0), saturday)).toBe("4 Apr");
      expect(wakeWords(new Date(2026, 3, 3, 9, 0), saturday)).toBe("Fri 09:00");
    });
  });

  it("in a picker: the weekday, the date and the clock time", () => {
    expect(whenWords(at(28, 9))).toBe("Mon 28 Sep 09:00");
  });
});
