import type { Clock, Timer } from "@agent-harness/client-runtime";

/**
 * The frame scheduler (docs/specs/tui.md, "Rendering"; pi's rule, a chosen
 * default): what the runtime's projections change is drawn at most once per
 * `FRAME_MS`, so a streaming run repaints at a steady 60 frames a second
 * however fast its deltas arrive. A change after a quiet spell is drawn at
 * once; the changes after it within the window are drawn together at the
 * window's end. Keyboard input bypasses the throttle: a key draws whatever
 * is waiting at once, with its own echo, so typing never waits on a stream.
 *
 * Ink's own throttle is set out of the way (`INK_MAX_FPS` in `app.tsx`) so
 * this is the one that counts.
 */

export const FRAME_MS = 16;

export interface FrameScheduler {
  /** A projection changed: draw now, or at the end of this window. */
  request(): void;
  /** A key arrived: draw what is waiting now. */
  bypass(): void;
  /** Hears each frame drawn. */
  subscribe(listener: () => void): () => void;
  /** How many frames have been drawn: what React reads to know it must render. */
  frame(): number;
  dispose(): void;
}

export const createFrameScheduler = (clock: Clock, frameMs: number = FRAME_MS): FrameScheduler => {
  const listeners = new Set<() => void>();
  let frames = 0;
  let lastDrawn = Number.NEGATIVE_INFINITY;
  let waiting: Timer | undefined;
  let disposed = false;

  const draw = () => {
    waiting?.cancel();
    waiting = undefined;
    if (disposed) return;
    frames++;
    lastDrawn = clock.now().getTime();
    for (const listener of [...listeners]) listener();
  };

  return {
    request() {
      if (disposed || waiting) return;
      const since = clock.now().getTime() - lastDrawn;
      if (since >= frameMs) return draw();
      waiting = clock.setTimeout(draw, frameMs - since);
    },
    bypass() {
      if (waiting) draw();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    frame: () => frames,
    dispose() {
      disposed = true;
      waiting?.cancel();
      waiting = undefined;
      listeners.clear();
    },
  };
};
