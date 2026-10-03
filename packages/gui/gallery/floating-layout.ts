/** Capture after fonts and floating controls have settled, rather than after a fixed delay. */
export async function waitForFloatingLayout(): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>((done) => {
    let previous: string | undefined;
    let stableFrames = 0;
    const draw = () => {
      const current = JSON.stringify(Array.from(document.querySelectorAll("[data-radix-popper-content-wrapper]"), (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height];
      }));
      stableFrames = current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 3) done();
      else requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
}
