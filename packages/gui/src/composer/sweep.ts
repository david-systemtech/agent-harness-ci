/**
 * The working seam's sweep (#2201): one IntersectionObserver shared by every seam, created on the first, marks a seam
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

const sharedObserver = () => {
  if (observer === undefined && typeof IntersectionObserver === "function") {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!seams.has(entry.target)) continue;
        entry.target.toggleAttribute(OFFSCREEN, !entry.isIntersecting);
        if (entry.isIntersecting) alignSweep(entry.target);
      }
    });
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
  sharedObserver()?.observe(seam);
  alignSweep(seam);
  return () => {
    seams.delete(seam);
    observer?.unobserve(seam);
    seam.removeAttribute(OFFSCREEN);
  };
};
