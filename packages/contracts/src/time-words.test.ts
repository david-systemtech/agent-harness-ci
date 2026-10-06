import { describe, expect, it } from "vitest";
import { agoWords, pastTimeWords } from "./index.js";

/**
 * A past time as every client says it (#1742): its age in the units a Set
 * up line counts in, then its time on this machine's clock, with no
 * milliseconds and no break inside the day and time.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("a time's age", () => {
  it("counts whole minutes under an hour, whole hours under two days, else whole days", () => {
    expect([0, MINUTE - 1, MINUTE, 59 * MINUTE, HOUR, 47 * HOUR + 59 * MINUTE, 48 * HOUR, 30 * 24 * HOUR].map(agoWords)).toEqual([
      "just now",
      "just now",
      "1 min ago",
      "59 min ago",
      "1 h ago",
      "47 h ago",
      "2 d ago",
      "30 d ago",
    ]);
  });
});

describe("a past time", () => {
  // Built from this machine's own clock, so the words read the same in any time zone.
  const now = new Date(2026, 9, 6, 18, 30);

  it("says its age, then its clock time on the day it is now, with no seconds or milliseconds", () => {
    expect(pastTimeWords(new Date(2026, 9, 6, 16, 24, 10, 496).toISOString(), now)).toBe("2 h ago, at 16:24");
    expect(pastTimeWords(new Date(2026, 9, 6, 18, 29, 30).toISOString(), now)).toBe("just now, at 18:29");
  });

  it("names the day on another day, and the year in another year, with no space a line could break at inside them", () => {
    expect(pastTimeWords(new Date(2026, 9, 5, 16, 24).toISOString(), now)).toBe("26 h ago, at 5 Oct 16:24");
    expect(pastTimeWords(new Date(2025, 11, 31, 9, 5).toISOString(), now)).toBe("279 d ago, at 31 Dec 2025 09:05");
  });

  it("reads a time ahead of now, as a skewed clock gives it, as just now", () => {
    expect(pastTimeWords(new Date(2026, 9, 6, 18, 31).toISOString(), now)).toBe("just now, at 18:31");
  });
});
