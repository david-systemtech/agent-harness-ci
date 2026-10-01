import { ContractError } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { ENDED_RUN_KEPT_MS, PRESET_IDLE_WINDOW_MS, activityOf, createRunRegistry, type RunRecord } from "./run-registry.js";

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
  /** The idle window at its preset, ten minutes, as these cases read it. */
  const WINDOW = PRESET_IDLE_WINDOW_MS;
  const at = (iso: string) => new Date(iso);
  const now = at("2026-09-24T12:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is idle with no runs at all", () => {
    expect(activityOf([], now, WINDOW)).toEqual({ state: "idle" });
  });

  it("is busy while a run is starting or running, whenever it started", () => {
    expect(activityOf([{ id: "a", state: "starting", startedAt: ago(60 * MINUTE) }], now, WINDOW)).toEqual({ state: "busy", reason: "run-starting" });
    expect(activityOf([{ id: "a", state: "running", startedAt: ago(60 * MINUTE) }], now, WINDOW)).toEqual({ state: "busy", reason: "run-running" });
  });

  it("is busy for ten minutes after a run started or ended, and says until when", () => {
    const ended = (ms: number): RunRecord => ({ id: "a", state: "ended", startedAt: ago(ms + MINUTE), endedAt: ago(ms) });
    expect(activityOf([ended(9 * MINUTE)], now, WINDOW)).toEqual({
      state: "busy",
      reason: "recent-activity",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([ended(10 * MINUTE)], now, WINDOW)).toEqual({ state: "idle" });
    expect(activityOf([ended(11 * MINUTE)], now, WINDOW)).toEqual({ state: "idle" });
  });

  it("counts a parked prompt for ten minutes after it parked, however long ago its run started", () => {
    const parked = (ms: number): RunRecord => ({ id: "p", state: "parked", startedAt: ago(3 * 60 * MINUTE), parkedSince: ago(ms) });
    expect(activityOf([parked(9 * MINUTE)], now, WINDOW)).toEqual({
      state: "busy",
      reason: "parked-prompt",
      busyUntil: at("2026-09-24T12:01:00.000Z").toISOString(),
    });
    expect(activityOf([parked(10 * MINUTE)], now, WINDOW)).toEqual({ state: "idle" });
  });

  it("reads the window it is given, for a run's start or end and for a parked prompt alike", () => {
    const ended: RunRecord = { id: "e", state: "ended", startedAt: ago(30 * MINUTE), endedAt: ago(24 * MINUTE) };
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(60 * MINUTE), parkedSince: ago(24 * MINUTE) };
    expect(activityOf([ended], now, 25 * MINUTE)).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:01:00.000Z").toISOString() });
    expect(activityOf([parked], now, 25 * MINUTE)).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at("2026-09-24T12:01:00.000Z").toISOString() });
    expect(activityOf([ended, parked], now, 24 * MINUTE)).toEqual({ state: "idle" });
  });

  it("reports the reason that holds longest, and a run starting or running over any window", () => {
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(60 * MINUTE), parkedSince: ago(8 * MINUTE) };
    const ended: RunRecord = { id: "e", state: "ended", startedAt: ago(5 * MINUTE), endedAt: ago(MINUTE) };
    expect(activityOf([parked, ended], now, WINDOW)).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:09:00.000Z").toISOString() });
    const running: RunRecord = { id: "r", state: "running", startedAt: ago(90 * MINUTE) };
    expect(activityOf([parked, ended, running], now, WINDOW)).toEqual({ state: "busy", reason: "run-running" });
  });

  it("is busy while a terminal runs a command, over any window and under a run starting or running, and idle again once it no longer does (#343)", () => {
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(60 * MINUTE), parkedSince: ago(MINUTE) };
    expect(activityOf([], now, WINDOW, { terminalRunning: true })).toEqual({ state: "busy", reason: "terminal-running" });
    expect(activityOf([parked], now, WINDOW, { terminalRunning: true })).toEqual({ state: "busy", reason: "terminal-running" });
    expect(activityOf([{ id: "s", state: "starting", startedAt: ago(MINUTE) }], now, WINDOW, { terminalRunning: true })).toEqual({ state: "busy", reason: "run-starting" });
    expect(activityOf([{ id: "r", state: "running", startedAt: ago(MINUTE) }], now, WINDOW, { terminalRunning: true })).toEqual({ state: "busy", reason: "run-running" });
    expect(activityOf([], now, WINDOW, { terminalRunning: false })).toEqual({ state: "idle" });
  });

  it("counts the environment's start as a run's start: busy for the window after it with no run known, then no longer (#445)", () => {
    expect(activityOf([], now, WINDOW, { startedAt: ago(9 * MINUTE) })).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:01:00.000Z").toISOString() });
    expect(activityOf([], now, 25 * MINUTE, { startedAt: ago(24 * MINUTE) })).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:01:00.000Z").toISOString() });
    expect(activityOf([], now, WINDOW, { startedAt: ago(10 * MINUTE) })).toEqual({ state: "idle" });
    // A later run, or a prompt parked since, holds longer; a run under way and a terminal's command outrank it.
    const ended: RunRecord = { id: "e", state: "ended", startedAt: ago(8 * MINUTE), endedAt: ago(2 * MINUTE) };
    expect(activityOf([ended], now, WINDOW, { startedAt: ago(9 * MINUTE) })).toEqual({ state: "busy", reason: "recent-activity", busyUntil: at("2026-09-24T12:08:00.000Z").toISOString() });
    const parked: RunRecord = { id: "p", state: "parked", startedAt: ago(9 * MINUTE), parkedSince: ago(9 * MINUTE) };
    expect(activityOf([parked], now, WINDOW, { startedAt: ago(9 * MINUTE) })).toEqual({ state: "busy", reason: "parked-prompt", busyUntil: at("2026-09-24T12:01:00.000Z").toISOString() });
    expect(activityOf([{ id: "r", state: "running", startedAt: ago(MINUTE) }], now, WINDOW, { startedAt: ago(2 * MINUTE) })).toEqual({ state: "busy", reason: "run-running" });
    expect(activityOf([], now, WINDOW, { startedAt: ago(MINUTE), terminalRunning: true })).toEqual({ state: "busy", reason: "terminal-running" });
  });
});

describe("the in-memory run registry", () => {
  it("tells its listeners of every change, forgets ended runs once no idle window the setting can name counts them, and refuses unknown runs", () => {
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
    const endedAt = now;
    now = new Date(endedAt.getTime() + 120 * MINUTE - 1);
    expect([...registry.runs()].map((run) => run.id)).toEqual(["a"]);
    expect(ENDED_RUN_KEPT_MS).toBe(120 * MINUTE);
    now = new Date(endedAt.getTime() + 120 * MINUTE);
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
