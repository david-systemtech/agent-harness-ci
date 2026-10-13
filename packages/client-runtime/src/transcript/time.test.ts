import { describe, expect, it } from "vitest";
import { transcriptTime } from "./time.js";

describe("local transcript time", () => {
  const now = new Date(2026, 8, 25, 12);
  it("uses compact 24-hour local words, with a date off today or across a day boundary", () => {
    const today = new Date(2026, 8, 25, 0, 5).toISOString();
    const yesterday = new Date(2026, 8, 24, 23, 58).toISOString();
    expect(transcriptTime(today, now)).toBe("00:05");
    expect(transcriptTime(yesterday, now)).toBe("2026-09-24 · 23:58");
    expect(transcriptTime(today, now, yesterday)).toBe("2026-09-25 · 00:05");
    expect(transcriptTime(undefined, now)).toBeUndefined();
    expect(transcriptTime("", now)).toBeUndefined();
  });
});
