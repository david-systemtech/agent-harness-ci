import { describe, expect, it } from "vitest";
import { awayRecap, type RecapSubject, type RunEnded } from "./policy.js";

/**
 * The away summary: every one of its decisions is about a person who was
 * not looking at the screen, which is why they are worth pinning. What the
 * title and a notification say are the client runtime's
 * (`src/attention/policy.test.ts` there).
 */

describe("awayRecap", () => {
  const away = 1_000;
  const back = 2_000;
  const finished = (title: string, run: Partial<RunEnded> = {}): RecapSubject => ({ title, status: "ended", pendingPrompts: 0, lastRun: { at: back, ...run } });
  const waiting = (title: string, askedAt = back): RecapSubject => ({ title, status: "parked", pendingPrompts: 1, askedAt });

  it("names what finished and what it cost, and what waits", () => {
    expect(awayRecap([finished("refactor", { durationMs: 130_000, costUsd: 0.08 }), waiting("release notes")], away)).toBe(
      "while you were away: refactor finished (2m 10s, $0.080) · release notes is waiting on you",
    );
  });

  it("drops the parenthesis rather than apologising inside it", () => {
    expect(awayRecap([finished("refactor")], away)).toBe("while you were away: refactor finished");
    expect(awayRecap([finished("refactor", { durationMs: 4_000 })], away)).toBe("while you were away: refactor finished (4.0s)");
  });

  it("names two and counts the rest, in the order given", () => {
    expect(awayRecap([finished("one"), finished("two"), finished("three"), finished("four")], away)).toBe("while you were away: one finished · two finished · +2 more");
    expect(awayRecap([waiting("b"), finished("a")], away)).toBe("while you were away: b is waiting on you · a finished");
  });

  it("says nothing at all when nothing changed while the person was away", () => {
    expect(awayRecap([], away)).toBeUndefined();
    expect(awayRecap([finished("refactor", { at: 500 })], away)).toBeUndefined();
    expect(awayRecap([waiting("release notes", 500)], away)).toBeUndefined();
    expect(awayRecap([{ status: "idle", pendingPrompts: 0 }], away)).toBeUndefined();
  });

  it("keeps quiet about a session whose next run is going, and does not call a crash an answer", () => {
    expect(awayRecap([{ ...finished("refactor"), status: "running" }], away)).toBeUndefined();
    expect(awayRecap([finished("refactor", { failed: true, durationMs: 130_000 })], away)).toBe("while you were away: refactor stopped with an error");
    expect(awayRecap([{ ...finished("x"), title: "  " }], away)).toBe("while you were away: a session finished");
  });
});
