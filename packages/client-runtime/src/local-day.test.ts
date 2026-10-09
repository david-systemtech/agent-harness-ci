import { afterEach, expect, it, vi } from "vitest";
import { onLocalDayChange } from "./index.js";
import { manualClock } from "./testing/in-memory-platform.js";

afterEach(() => vi.unstubAllEnvs());

it.each([
  ["spring", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z", 23],
  ["autumn", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z", 25],
] as const)("wakes at local midnight through the %s clock change and stops when cancelled", (_season, start, midnight, hours) => {
  vi.stubEnv("TZ", "America/New_York");
  const clock = manualClock(start);
  const days: string[] = [];
  const timer = onLocalDayChange(clock, () => days.push(clock.now().toISOString()));
  clock.advance(hours * 60 * 60_000 - 1);
  expect(days).toEqual([]);
  clock.advance(1);
  expect(days).toEqual([midnight]);
  timer.cancel();
  clock.advance(2 * 24 * 60 * 60_000);
  expect(days).toEqual([midnight]);
  expect(clock.pending()).toBe(0);
});

it("can be cancelled by the day-change callback without scheduling another wake", () => {
  const clock = manualClock("2026-09-24T23:59:59.999Z");
  const timer = onLocalDayChange(clock, () => timer.cancel());
  clock.advance(24 * 60 * 60_000);
  expect(clock.pending()).toBe(0);
});
