import { manualClock } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import { FRAME_MS, createFrameScheduler } from "./frames.js";

/**
 * The frame scheduler (docs/specs/tui.md, "Rendering"): what the runtime
 * changes is drawn at most once per 16 milliseconds, the first change at
 * once and the rest of a window's changes together at its end; keyboard
 * input bypasses the throttle and draws what is waiting at once.
 */

const setup = () => {
  const clock = manualClock();
  const scheduler = createFrameScheduler(clock);
  const drawn: number[] = [];
  scheduler.subscribe(() => drawn.push(clock.now().getTime() - new Date("2026-09-24T00:00:00.000Z").getTime()));
  return { clock, scheduler, drawn };
};

describe("the frame scheduler", () => {
  it("is one frame per 16 milliseconds", () => {
    expect(FRAME_MS).toBe(16);
  });

  it("draws the first change at once", () => {
    const { scheduler, drawn } = setup();
    scheduler.request();
    expect(drawn).toEqual([0]);
  });

  it("draws the changes that follow within the window once, at its end", () => {
    const { clock, scheduler, drawn } = setup();
    scheduler.request();
    clock.advance(3);
    scheduler.request();
    scheduler.request();
    clock.advance(5);
    scheduler.request();
    expect(drawn).toEqual([0]);
    clock.advance(7);
    expect(drawn).toEqual([0]);
    clock.advance(1);
    expect(drawn).toEqual([0, 16]);
    clock.advance(100);
    expect(drawn).toEqual([0, 16]);
  });

  it("streams at one frame per window, however many changes arrive", () => {
    const { clock, scheduler, drawn } = setup();
    for (let ms = 0; ms < 64; ms++) {
      scheduler.request();
      scheduler.request();
      clock.advance(1);
    }
    expect(drawn).toEqual([0, 16, 32, 48, 64]);
    clock.advance(16);
    expect(drawn).toEqual([0, 16, 32, 48, 64]);
  });

  it("lets keyboard input bypass the throttle: what is waiting is drawn at once", () => {
    const { clock, scheduler, drawn } = setup();
    scheduler.request();
    clock.advance(2);
    scheduler.request();
    expect(drawn).toEqual([0]);
    scheduler.bypass();
    expect(drawn).toEqual([0, 2]);
    clock.advance(20);
    expect(drawn).toEqual([0, 2]);
  });

  it("draws nothing on a key when nothing is waiting: the key's own frame is the draw", () => {
    const { scheduler, drawn } = setup();
    scheduler.bypass();
    expect(drawn).toEqual([]);
  });

  it("counts frames, and stops drawing once disposed", () => {
    const { clock, scheduler, drawn } = setup();
    scheduler.request();
    expect(scheduler.frame()).toBe(1);
    clock.advance(1);
    scheduler.request();
    scheduler.dispose();
    clock.advance(50);
    scheduler.request();
    expect(drawn).toEqual([0]);
  });
});
