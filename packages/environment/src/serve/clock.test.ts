import { describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { systemClock } from "./clock.js";

describe("the system clock", () => {
  it("tells the real time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("runs a timeout longer than Node's timers take at its time, never at once", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const fired: number[] = [];
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      systemClock.setTimeout(() => fired.push(Date.now()), thirtyDays);
      vi.advanceTimersByTime(thirtyDays - 1);
      expect(fired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(fired).toEqual([thirtyDays]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels timeouts and intervals", () => {
    vi.useFakeTimers({ now: 0 });
    try {
      let runs = 0;
      systemClock.setTimeout(() => runs++, 10).cancel();
      const interval = systemClock.setInterval(() => runs++, 10);
      vi.advanceTimersByTime(35);
      interval.cancel();
      vi.advanceTimersByTime(100);
      expect(runs).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the manual clock", () => {
  it("stands still until advanced, then runs what falls due in order, each at its own time", () => {
    const clock = manualClock("2026-09-24T00:00:00.000Z");
    const log: string[] = [];
    const at = () => clock.now().toISOString().slice(11, 23);
    clock.setTimeout(() => log.push(`b ${at()}`), 2000);
    clock.setInterval(() => log.push(`i ${at()}`), 1500);
    clock.setTimeout(() => log.push(`a ${at()}`), 1000);
    clock.advance(999);
    expect(log).toEqual([]);
    clock.advance(2001);
    expect(log).toEqual(["a 00:00:01.000", "i 00:00:01.500", "b 00:00:02.000", "i 00:00:03.000"]);
    expect(at()).toBe("00:00:03.000");
  });

  it("runs a timer a callback sets when it falls due within the same advance, and not one that is cancelled", () => {
    const clock = manualClock();
    const log: number[] = [];
    const cancelled = clock.setTimeout(() => log.push(-1), 50);
    clock.setTimeout(() => {
      log.push(1);
      cancelled.cancel();
      clock.setTimeout(() => log.push(2), 10);
    }, 10);
    clock.advance(100);
    expect(log).toEqual([1, 2]);
    expect(clock.pending()).toBe(0);
  });
});
