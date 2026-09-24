import { describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { EXCHANGE_RATE, createRateLimiter } from "./rate-limit.js";

describe("the exchange rate limit", () => {
  it("takes 10 exchanges a minute from one address by default", () => {
    expect(EXCHANGE_RATE).toEqual({ capacity: 10, windowMs: 60_000 });
  });

  it("takes a burst up to its capacity, then one more for each share of the window that passes", () => {
    const clock = manualClock();
    const limiter = createRateLimiter({ clock, capacity: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) expect(limiter.take("127.0.0.1"), `take ${i}`).toEqual({ ok: true });
    expect(limiter.take("127.0.0.1")).toEqual({ ok: false, retryAfterMs: 6000 });
    clock.advance(5999);
    expect(limiter.take("127.0.0.1")).toEqual({ ok: false, retryAfterMs: 1 });
    clock.advance(1);
    expect(limiter.take("127.0.0.1")).toEqual({ ok: true });
    expect(limiter.take("127.0.0.1")).toMatchObject({ ok: false });
    clock.advance(60_000);
    for (let i = 0; i < 10; i++) expect(limiter.take("127.0.0.1")).toEqual({ ok: true });
    expect(limiter.take("127.0.0.1")).toMatchObject({ ok: false });
  });

  it("keeps one bucket per key", () => {
    const limiter = createRateLimiter({ clock: manualClock(), capacity: 1, windowMs: 1000 });
    expect(limiter.take("a")).toEqual({ ok: true });
    expect(limiter.take("a")).toMatchObject({ ok: false });
    expect(limiter.take("b")).toEqual({ ok: true });
  });
});
