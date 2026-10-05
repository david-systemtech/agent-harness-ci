/** Hosted proof: the drawer follows the existing owner, and only its results scroll. */
export function verifySessionSearch(height: number, offset: number): void {
  const drawer = document.querySelector<HTMLElement>('.phone-frame-drawer')!;
  const results = drawer.querySelector<HTMLElement>('[data-sidebar-scroll]')!;
  const bounds = drawer.getBoundingClientRect();
  if (Math.abs(bounds.top - offset) > 1 || Math.abs(bounds.height - height) > 1) throw new Error("Session drawer ignores visible viewport bounds");
  const controls = [
    drawer.querySelector('[aria-label="Close sessions"]')!,
    drawer.querySelector('[aria-label="New session"]')!,
    drawer.querySelector('[aria-label="Filter the sessions"]')!,
    ...Array.from(results.querySelectorAll('[data-sidebar-row], [aria-label^="Actions for"]')).slice(0, 4),
    ...Array.from(drawer.querySelectorAll('nav > div:last-of-type button')),
  ];
  for (const element of controls) {
    const rect = element.getBoundingClientRect();
    if (rect.top < offset || rect.bottom > offset + height || rect.width < 44 || rect.height < 44) throw new Error("Session drawer clips a search, result or action target");
  }
  if (results.clientHeight <= 0 || results.scrollHeight <= results.clientHeight) throw new Error("Session search lacks bounded scrolling results");
  if (getComputedStyle(results).overflowY !== "auto" || getComputedStyle(results).overscrollBehavior !== "contain") throw new Error("Session search must contain result scrolling");
  results.scrollTop = results.scrollHeight;
  if (results.scrollTop <= 0) throw new Error("Session results do not scroll");
  results.scrollTop = 0;
  if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0 || document.body.scrollTop !== 0) throw new Error("Session search moved the document");
  if (document.documentElement.scrollWidth > innerWidth) throw new Error("Session search overflows the page");
}
