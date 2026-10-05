import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";

/** Hosted real-client regression for the keyboard-height refusal in #1325. */
export async function phoneRefusalSmoke(page: Page, engine: string, output: string, signIn: (signedIn: boolean) => Promise<void>): Promise<void> {
  const original = page.viewportSize();
  const message = "Explain the receipt totals and retain the original rounding rule.\n".repeat(6);
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  const column = page.locator("[data-composer-column]");
  const refusal = column.locator('p[role="status"]').filter({ hasText: "Not sent:" });
  const settings = page.getByRole("button", { name: "Run settings", exact: true });
  const fits = async (control: Locator) => {
    const box = await control.boundingBox();
    const region = await column.boundingBox();
    const viewport = page.viewportSize();
    assert(box && region && viewport, "The refusal and controls have rendered boxes.");
    assert(box.y >= region.y - 1 && box.y + box.height <= region.y + region.height + 1, "The whole refusal/control fits the user-scrollable composer.");
    assert(box.y >= 0 && box.y + box.height <= viewport.height + 1, "The refusal/control is reachable inside the keyboard-height viewport.");
  };
  await signIn(false);
  try {
    for (const viewport of [{ width: 390, height: 480 }, { width: 360, height: 400 }]) {
      await page.setViewportSize(viewport);
      await field.fill(message);
      await page.getByRole("button", { name: /^Send/ }).click();
      await expect(refusal).toContainText("not signed in");
      await expect(refusal).toContainText("no run can start");
      await expect(field).toHaveValue(message);
      assert.equal(await page.evaluate("getComputedStyle(document.querySelector('[data-composer-column]')).overflowY"), "auto", "A touch user can scroll the full composer, including its refusal and Run settings.");
      await refusal.scrollIntoViewIfNeeded();
      await fits(refusal);
      await page.screenshot({ path: join(output, `phone-refusal-${engine}-${viewport.width}.png`) });
      await settings.scrollIntoViewIfNeeded();
      await fits(settings);
      await settings.click();
      const account = page.getByRole("button", { name: /^Account:/ });
      await account.click();
      const choices = page.getByRole("dialog", { name: "Run choices" });
      await expect(choices).toContainText(/signed out/i);
      await choices.getByRole("menuitem").filter({ hasText: "claude-max" }).click();
      await page.keyboard.press("Escape");
      const remedy = column.locator('p[role="status"]').filter({ hasText: "Cannot sign" });
      await expect(remedy).toContainText("admin");
      await remedy.scrollIntoViewIfNeeded();
      await fits(remedy);
      await page.getByRole("button", { name: /^Send/ }).scrollIntoViewIfNeeded();
      await fits(page.getByRole("button", { name: /^Send/ }));
      await settings.click();
      await page.reload();
      await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await expect(field).toHaveValue(message);
    }
  } finally {
    await signIn(true);
    if (original) await page.setViewportSize(original);
    await field.fill("");
  }
  console.log(`PHONE-REFUSAL PASS ${engine}: keyboard-height refusal, remedy, Run settings, Send and durable draft`);
}
