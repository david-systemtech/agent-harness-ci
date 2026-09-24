import { ContractError } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { IDLE_WINDOW_MS, PARKED_PROMPT_WINDOW_MS, activityOf, createRunRegistry, type RunRecord } from "./run-registry.js";

const MINUTE = 60_000;

/** What `fn` threw. */
const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("It did not throw.");
};

describe("the idle rule", () => {
  const at = (iso: string) => new Date(iso);
  const now = at("2026-09-24T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is idle with no runs at all", () => {
    expect(activityOf([], now)).toEqual({ state: "idle" });
  });

  it("is busy while a run is starting or running, whenever it started", () => {
    expect(activityOf([{ id: "a", state: "starting", startedAt: ago(60 * MINUTE) }], now)).toEqual({ state: "busy", reason: "run-starting" });
    expect(activityOf([{ id: "a", state: "running", startedAt: ago(60 * MINUTE) }], now)).toEqual({ state: "busy", reason: "run-running" });
  });

  it("is busy for ten minutes after a run started or ended, and says until when", () => {
    const ended = (ms: number): RunRecord => ({ id: "a", state: "ended", startedAt: ago(ms + MINUTE), endedAt: ago(ms) });
    expect(activityOf([ended(9 * MINUTE)], now)).toEqual({
      state: "busy",
      reason: "recent-activity",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([ended(IDLE_WINDOW_MS)], now)).toEqual({ state: "idle" });
    expect(activityOf([ended(11 * MINUTE)], now)).toEqual({ state: "idle" });
  });

  it("counts a parked prompt for ten minutes after it parked, however long ago its run started", () => {
    const parked = (ms: number): RunRecord => ({ id: "p", state: "parked", startedAt: ago(3 * 60 * MINUTE), parkedSince: ago(ms) });
    expect(activityOf([parked(9 * MINUTE)], now)).toEqual({
      state: "busy",
      reason: "parked-prompt",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([parked(PARKED_PROMPT_WINDOW_MS)], now)).toEqual({ state: "idle" });
  });

  it("reports the reason that holds longest, and a run starting or running over any window", () => {
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(60 * MINUTE), parkedSince: ago(8 * MINUTE) };
    const ended: RunRecord = { id: "e", state: "ended", startedAt: ago(5 * MINUTE), endedAt: ago(MINUTE) };
    expect(activityOf([parked, ended], now)).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:09:00.000Z").toISOString() });
    const running: RunRecord = { id: "r", state: "running", startedAt: ago(90 * MINUTE) };
    expect(activityOf([parked, ended, running], now)).toEqual({ state: "busy", reason: "run-running" });
  });
});

describe("the in-memory run registry", () => {
  it("tells its listeners of every change, forgets ended runs once they no longer count, and refuses unknown runs", () => {
    let now = new Date("2026-09-24T00:00:00.000Z");
    const registry = createRunRegistry({ clock: { now: () => now } });
    const heard = vi.fn();
    const stop = registry.onChange(heard);
    registry.start("a");
    registry.running("a");
    registry.park("a");
    registry.resume("a");
    registry.end("a");
    expect(heard).toHaveBeenCalledTimes(5);
    expect([...registry.runs()]).toEqual([{ id: "a", state: "ended", startedAt: now, endedAt: now }]);
    expect(() => registry.start("a")).toThrow(/already/);
    expect(() => registry.end("missing")).toThrow(/No run/);
    now = new Date(now.getTime() + IDLE_WINDOW_MS);
    expect([...registry.runs()]).toEqual([]);
    stop();
    registry.start("b");
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it("admits runs until it refuses new ones, then refuses each with unavailable draining, at admit and at start", () => {
    const registry = createRunRegistry({ clock: { now: () => new Date() } });
    expect(() => registry.admit()).not.toThrow();
    registry.start("before");
    registry.refuseNewRuns();
    for (const refusal of [thrown(() => registry.admit()), thrown(() => registry.start("after"))]) {
      expect(refusal).toBeInstanceOf(ContractError);
      expect(refusal).toMatchObject({ code: "unavailable", data: { readiness: "draining" } });
    }
    // A run admitted before goes on: the drain waits for it.
    registry.running("before");
    expect([...registry.runs()].map((run) => run.id)).toEqual(["before"]);
  });
});
