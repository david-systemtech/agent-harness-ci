import assert from "node:assert/strict";
import type { Page } from "playwright";
import { expect } from "playwright/test";

/** Check the production browser client after pairing, with a simulated notch. */
export async function phoneFrameSmoke(page: Page, engine: string): Promise<void> {
  const original = page.viewportSize();
  await page.evaluate(`(() => {
    for (const [edge, value] of [["top", 20], ["right", 8], ["bottom", 16], ["left", 8]]) {
      document.documentElement.style.setProperty("--phone-frame-safe-" + edge, value + "px");
    }
  })()`);
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 390, height: 480 }]) {
      await page.setViewportSize(viewport);
      await expect(page.locator("[data-web-grant]")).toContainText("Scopes:");
      await expect.poll(() => page.evaluate<boolean>(`(() => {
        const frame = document.querySelector("[data-web-client]");
        const header = frame.querySelector("header").getBoundingClientRect();
        const grant = frame.querySelector("[data-web-grant]");
        const disclosure = grant.getBoundingClientRect();
        const main = frame.querySelector("main").getBoundingClientRect();
        const visibleHeight = window.visualViewport?.height ?? innerHeight;
        return header.top >= 20 && header.bottom <= disclosure.top + 0.5
          && disclosure.bottom <= main.top + 0.5 && main.bottom <= visibleHeight + 0.5
          && disclosure.left >= 8 && disclosure.right <= innerWidth - 8 + 0.5
          && grant.scrollWidth <= grant.clientWidth && grant.scrollHeight <= grant.clientHeight;
      })()`)).toBe(true);
    }
    await page.getByRole("button", { name: "Show sessions", exact: true }).tap();
    const drawer = page.getByRole("dialog", { name: "Sessions", exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Close sessions", exact: true }).tap();
    await expect(drawer).toBeHidden();
    await expect(page.locator("[data-ui-tooltip]")).toHaveCount(0);
    assert(await page.locator('meta[name="viewport"]').getAttribute("content").then(value => value?.includes("viewport-fit=cover")), "The production page admits device safe-area insets.");
  } finally {
    await page.evaluate(`(() => { for (const edge of ["top", "right", "bottom", "left"]) document.documentElement.style.removeProperty("--phone-frame-safe-" + edge); })()`);
    if (original) await page.setViewportSize(original);
  }
  console.log(`PHONE-FRAME PASS ${engine}: safe area, grant wrapping, no overlap, touch focus`);
}
