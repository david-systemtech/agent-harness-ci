/** Capture after fonts and floating controls have settled, rather than after a fixed delay. */
export async function waitForFloatingLayout(): Promise<void> {
  await document.fonts.ready;
  let previous: string | undefined;
  let stableFrames = 0;
  while (stableFrames < 3) {
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    const current = JSON.stringify(Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"), (element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height];
    }));
    stableFrames = current === previous ? stableFrames + 1 : 0;
    previous = current;
  }
}
