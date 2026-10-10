/** Executed in the hosted capture page after photographing the expanded minted code. */
export async function verifyPhonePairingReachability(): Promise<string[]> {
  const code = document.querySelector<HTMLElement>('[role="group"][aria-label="Pairing code"]');
  const details = code?.querySelector<HTMLElement>(".pairing-code-details");
  const scroll = code?.closest<HTMLElement>("[data-settings-scroll]");
  if (!code || !details || !scroll) return ["Expanded pairing code or its scrollport is missing"];
  const failures: string[] = [];
  if (details.getBoundingClientRect().width < code.getBoundingClientRect().width - 1) failures.push("Pairing details do not use the full phone column");
  if (!["auto", "scroll"].includes(getComputedStyle(scroll).overflowY)) failures.push("Pairing code has no vertical scrollport");
  const top = scroll.scrollTop;
  for (const row of code.querySelectorAll<HTMLElement>("pre, button, p")) {
    row.scrollIntoView({ block: "nearest", behavior: "instant" });
    const rect = row.getBoundingClientRect(), bounds = scroll.getBoundingClientRect();
    if (rect.top < Math.max(0, bounds.top) - 0.5 || rect.bottom > Math.min(innerHeight, bounds.bottom) + 0.5
      || rect.left < Math.max(0, bounds.left) - 0.5 || rect.right > Math.min(innerWidth, bounds.right) + 0.5) {
      failures.push(`${row.ariaLabel ?? row.tagName}: pairing content is clipped after scrolling into view`);
    }
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (hit === null || !row.contains(hit)) failures.push(`${row.ariaLabel ?? row.tagName}: pairing content cannot receive a pointer`);
  }
  scroll.scrollTop = top;
  const close = document.querySelector<HTMLButtonElement>('[aria-label="Close Settings"]');
  if (!close) failures.push("Close Settings is missing");
  else {
    close.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (document.querySelector("[data-settings-dialog]")) failures.push("Settings did not dismiss with the expanded pairing code");
  }
  return failures;
}
