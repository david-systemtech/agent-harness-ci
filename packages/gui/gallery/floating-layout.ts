/** Capture after fonts and floating controls have settled, rather than after a fixed delay. */
export async function waitForFloatingLayout(): Promise<void> {
  await document.fonts.ready;
  let refreshed = false;
  let previous: string | undefined;
  let stableFrames = 0;
  while (stableFrames < 3 || !refreshed) {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    const current = JSON.stringify(Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"), (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height];
    }));
    stableFrames = current === previous ? stableFrames + 1 : 0;
    previous = current;
    if (stableFrames === 3 && !refreshed) {
      // Floating UI's optimized observer may still hold a placement from before
      // an asynchronous dialog row moved its focused control. Ask it to place
      // against the completed layout, then wait for that update to settle too.
      document.activeElement?.closest('[role="dialog"]')?.dispatchEvent(new Event("resize"));
      refreshed = true;
      stableFrames = 0;
      previous = undefined;
    }
  }
}
