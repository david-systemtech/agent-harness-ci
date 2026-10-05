/** Runs in the built capture page: scroll to every action, including disabled explanations. */
export function verifyPhoneMenuReachability(): string[] {
  const menu = document.querySelector<HTMLElement>(".phone-frame-menu");
  if (!menu) return ["More menu is missing"];
  const failures: string[] = [];
  const top = menu.scrollTop;
  const style = getComputedStyle(menu);
  if (style.overflowY !== "auto" && style.overflowY !== "scroll") failures.push("More menu has no vertical scrollport");
  for (const row of menu.querySelectorAll<HTMLElement>('[role="menuitem"], button')) {
    row.scrollIntoView({ block: "nearest", behavior: "instant" });
    const rect = row.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    if (rect.height < 43.5 || rect.width < 43.5) failures.push(`${row.ariaLabel}: touch target is smaller than 44px`);
    if (rect.top < Math.max(0, bounds.top) - 0.5 || rect.bottom > Math.min(innerHeight, bounds.bottom) + 0.5
      || rect.left < Math.max(0, bounds.left) - 0.5 || rect.right > Math.min(innerWidth, bounds.right) + 0.5) {
      failures.push(`${row.ariaLabel}: action is clipped after scrolling into view`);
    }
  }
  menu.scrollTop = top;
  return failures;
}
