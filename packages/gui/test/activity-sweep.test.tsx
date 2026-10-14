// @vitest-environment jsdom-on-node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// What the stylesheet pauses (activity-seam-styles.test.tsx holds it to these selectors): jsdom runs no CSS animations,
// so each fake beam reads its play state from whether its seam matches them, as the browser's would.
const PAUSED = ".shuttle[data-sweep-offscreen], :root[data-sweep-hidden] .shuttle";
interface Beam { animationName: string; startTime: number | null; readonly playState: string }
const beams = new Map<Element, Beam>();
const seam = () => {
  const element = document.createElement("div");
  element.className = "shuttle";
  document.body.append(element);
  const beam: Beam = { animationName: "shuttle", startTime: 700, get playState() { return element.matches(PAUSED) ? "paused" : "running"; } };
  beams.set(element, beam);
  Object.assign(element, { getAnimations: () => [beam, { animationName: "word-in", startTime: 5, playState: "running" }] });
  return { element, beam };
};

let observers: { callback: IntersectionObserverCallback; observed: Set<Element> }[] = [];
let visibility: DocumentVisibilityState = "visible";
const intersect = (element: Element, isIntersecting: boolean) =>
  observers[0]!.callback([{ target: element, isIntersecting } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
const setVisibility = (state: DocumentVisibilityState) => {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.resetModules();
  observers = [];
  vi.stubGlobal("IntersectionObserver", class {
    readonly observed = new Set<Element>();
    constructor(readonly callback: IntersectionObserverCallback) { observers.push(this); }
    observe(element: Element) { this.observed.add(element); }
    unobserve(element: Element) { this.observed.delete(element); }
    disconnect() { this.observed.clear(); }
  });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-sweep-hidden");
  setVisibility("visible");
});

it("puts every running beam on one shared timeline, with one observer for all the seams", async () => {
  const { followSweep, SWEEP_EPOCH } = await import("../src/composer/sweep.js");
  const panes = Array.from({ length: 12 }, seam);
  for (const { element } of panes) followSweep(element);
  expect(observers).toHaveLength(1);
  expect(observers[0]!.observed.size).toBe(12);
  expect(new Set(panes.map(({ beam }) => beam.startTime))).toEqual(new Set([SWEEP_EPOCH]));
  // Only the sweep is moved; any other animation under the seam keeps its own start.
  expect((panes[0]!.element.getAnimations()[1] as unknown as Beam).startTime).toBe(5);
});

it("pauses an off-screen seam's beam and every beam while the window is hidden, and resumes them in step", async () => {
  const { followSweep, SWEEP_EPOCH } = await import("../src/composer/sweep.js");
  const [on, off] = [seam(), seam()];
  const letGo = [followSweep(on.element), followSweep(off.element)];
  intersect(on.element, true);
  intersect(off.element, false);
  expect(on.beam.playState).toBe("running");
  expect(off.beam.playState).toBe("paused");

  setVisibility("hidden");
  expect(document.documentElement.hasAttribute("data-sweep-hidden")).toBe(true);
  expect([on.beam.playState, off.beam.playState]).toEqual(["paused", "paused"]);

  // A resumed animation restarts from where it was held; the sweep puts it back on the shared timeline.
  on.beam.startTime = 4321;
  setVisibility("visible");
  expect([on.beam.playState, off.beam.playState]).toEqual(["running", "paused"]);
  expect(on.beam.startTime).toBe(SWEEP_EPOCH);

  off.beam.startTime = 99;
  intersect(off.element, true);
  expect(off.beam.playState).toBe("running");
  expect(off.beam.startTime).toBe(SWEEP_EPOCH);

  // A seam that stops sweeping is let go and loses its mark.
  intersect(off.element, false);
  letGo[1]!();
  expect(off.element.hasAttribute("data-sweep-offscreen")).toBe(false);
  expect(observers[0]!.observed.has(off.element)).toBe(false);
  letGo[0]!();
});
