/** Hosted phone proof: instructions and controls stay uncovered after scrolling, including at keyboard height. */
export async function verifyPhoneThemeReachability(): Promise<string[]> {
  const scroll = document.querySelector<HTMLElement>("[data-settings-scroll]");
  if (!scroll) return ["Theme has no Settings scrollport"];
  const failures: string[] = [];
  if (!["auto", "scroll"].includes(getComputedStyle(scroll).overflowY)) failures.push("Theme has no vertical scrollport");
  const top = scroll.scrollTop;
  for (const name of ["Light or dark", "Text size"]) {
    const row = document.querySelector(`[data-theme-preference="${name}"]`);
    if (!row) { failures.push(`${name}: preference is missing`); continue; }
    for (const target of row.querySelectorAll<HTMLElement>('.theme-preference-label > div > span, button, input[type="number"], label:has(input[type="radio"])')) {
      target.scrollIntoView({ block: "nearest", behavior: "instant" });
      const rect = target.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
      if (rect.top < Math.max(0, bounds.top) - 0.5 || rect.bottom > Math.min(innerHeight, bounds.bottom) + 0.5
        || rect.left < Math.max(0, bounds.left) - 0.5 || rect.right > Math.min(innerWidth, bounds.right) + 0.5) {
        failures.push(`${name}: ${target.ariaLabel ?? target.textContent} is clipped after scrolling`);
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!hit || !target.contains(hit)) failures.push(`${name}: ${target.ariaLabel ?? target.textContent} is covered`);
    }
  }
  scroll.scrollTop = top;
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]');
  if (!close) failures.push("Close Settings is missing");
  else {
    close.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (document.querySelector("[data-settings-dialog]")) failures.push("Theme Settings did not dismiss");
  }
  return failures;
}
