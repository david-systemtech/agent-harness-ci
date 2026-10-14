/**
 * The working seam's sweep (#2201): one IntersectionObserver shared by every seam, created when a seam first sweeps (remade if the global constructor
 * changes; a missing or partial one leaves every seam counted as visible), marks a seam
 * that is off screen `data-sweep-offscreen`, and one visibilitychange listener marks the document `data-sweep-hidden`
 * while the window is hidden; the stylesheet pauses the beam under either, so a wall of working panes costs nothing
 * unseen. Every running beam shares one timeline: its start time is the document timeline's origin, so every pane's
 * bar is at the same point of the cycle, and a beam that resumes is put back in step rather than where it paused.
 */
const OFFSCREEN = "data-sweep-offscreen";
const HIDDEN = "data-sweep-hidden";
/** Where every beam's cycle starts: the document timeline's origin, so `currentTime % cycle` is the same for all. */
export const SWEEP_EPOCH = 0;

const seams = new Set<Element>();
let observer: IntersectionObserver | undefined;
let listening = false;

const hidden = () => document.visibilityState === "hidden";

/** Puts a seam's running beam on the shared timeline; a paused one is left for when it resumes. */
export const alignSweep = (seam: Element): void => {
  if (hidden() || seam.hasAttribute(OFFSCREEN) || typeof seam.getAnimations !== "function") return;
  for (const animation of seam.getAnimations({ subtree: true })) {
    if ((animation as CSSAnimation).animationName === "shuttle" && animation.playState !== "paused") animation.startTime = SWEEP_EPOCH;
  }
};

const onVisibility = () => {
  document.documentElement.toggleAttribute(HIDDEN, hidden());
  if (!hidden()) for (const seam of seams) alignSweep(seam);
};

/** The constructor the shared observer was made with; a different global (a test's own) gets a fresh observer. */
let observerKind: unknown;
/** Which observer follows each seam, so a seam is let go by the observer that took it. */
const observedBy = new Map<Element, IntersectionObserver>();

/** A global IntersectionObserver that can follow and let go of a seam; anything else counts as always visible. */
const standardObserver = (): typeof IntersectionObserver | undefined => {
  const kind = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  if (typeof kind !== "function") return undefined;
  const proto = (kind as { prototype?: Partial<IntersectionObserver> }).prototype;
  return typeof proto?.observe === "function" && typeof proto.unobserve === "function" && typeof proto.disconnect === "function" ? kind as typeof IntersectionObserver : undefined;
};

/** The one observer, made when a seam first sweeps and remade if the global constructor has changed since. */
const sharedObserver = (): IntersectionObserver | undefined => {
  const kind = standardObserver();
  if (kind === undefined) return undefined;
  if (observer === undefined || observerKind !== kind) {
    observer = new kind((entries) => {
      for (const entry of entries) {
        if (!seams.has(entry.target)) continue;
        entry.target.toggleAttribute(OFFSCREEN, !entry.isIntersecting);
        if (entry.isIntersecting) alignSweep(entry.target);
      }
    });
    observerKind = kind;
  }
  return observer;
};

/** Follows a sweeping seam until the returned function lets it go. */
export const followSweep = (seam: Element): (() => void) => {
  if (!listening) {
    listening = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  document.documentElement.toggleAttribute(HIDDEN, hidden());
  seams.add(seam);
  const following = sharedObserver();
  if (following !== undefined) {
    following.observe(seam);
    observedBy.set(seam, following);
  }
  alignSweep(seam);
  return () => {
    seams.delete(seam);
    const taken = observedBy.get(seam);
    observedBy.delete(seam);
    taken?.unobserve(seam);
    seam.removeAttribute(OFFSCREEN);
  };
};
