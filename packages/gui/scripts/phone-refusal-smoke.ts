import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";

/** Hosted real-client regression for the keyboard-height refusal in #1325. */
export async function phoneRefusalSmoke(page: Page, engine: string, output: string, signIn: (signedIn: boolean) => Promise<void>, waitForDraft: (message: string) => Promise<void>): Promise<void> {
  const original = page.viewportSize();
  const message = "Explain the receipt totals and retain the original rounding rule.\n".repeat(6);
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  const column = page.locator("[data-composer-column]");
  const refusal = column.locator('p[role="status"]').filter({ hasText: "Not sent:" });
  const settings = page.getByRole("button", { name: "Run settings", exact: true });
  const fits = async (control: Locator) => {
    const text = await control.textContent();
    const element = `Array.from(document.querySelector('[data-composer-column]').querySelectorAll('p[role="status"], button')).find(element => element.textContent === ${JSON.stringify(text)})`;
    // Scroll only the touch-scrollable composer, never an overflow-hidden ancestor
    // or the document. Centering also leaves room for fractional edge geometry.
    await page.evaluate(`(() => {
      const element = ${element};
      if (!element) throw new Error('The refusal/control must exist in the composer.');
      const column = element.closest('[data-composer-column]');
      const rect = element.getBoundingClientRect(), bounds = column.getBoundingClientRect();
      column.scrollTop += rect.top - bounds.top - column.clientTop - (column.clientHeight - rect.height) / 2;
    })()`);
    // Account/status changes can resize the column after intersection is observed.
    // Read both boxes in one frame and wait for the original bounds condition.
    await expect.poll(() => page.evaluate(`(() => {
      const element = ${element};
      if (!element) return { missing: true };
      const box = element.getBoundingClientRect();
      const region = element.closest('[data-composer-column]').getBoundingClientRect();
      const inside = box.y >= region.y - 1 && box.bottom <= region.bottom + 1
        && box.y >= 0 && box.bottom <= innerHeight + 1;
      return inside ? true : { control: { y: box.y, height: box.height },
        column: { y: region.y, height: region.height }, viewport: innerHeight };
    })()`), { timeout: 60_000, message: "The whole refusal/control fits the user-scrollable composer and keyboard-height viewport." }).toBe(true);
    // Intersection observes clipping by every overflow ancestor, not just the viewport.
    try { await expect(control).toBeInViewport({ ratio: 1, timeout: 60_000 }); }
    catch (error) {
      console.error("PHONE-REFUSAL geometry", await page.evaluate(`(() => {
        const element = ${element};
        return JSON.stringify({ viewport: [innerWidth, innerHeight],
          focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim().slice(0, 40),
          ancestors: (() => { const result = []; for (let node = element; node; node = node.parentElement) {
            const { x, y, width, height } = node.getBoundingClientRect();
            result.push({ tag: node.tagName, column: node.hasAttribute('data-composer-column'),
              above: node.hasAttribute('data-composer-above'), x, y, width, height,
              scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
              overflow: getComputedStyle(node).overflowY });
          } return result; })()
        });
      })()`));
      throw error;
    }
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
      await fits(refusal);
      await page.screenshot({ path: join(output, `phone-refusal-${engine}-${viewport.width}.png`) });
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
      await fits(remedy);
      await fits(page.getByRole("button", { name: /^Send/ }));
      await settings.click();
      // Reload after the debounced draft has reached the real environment.
      await waitForDraft(message);
      await page.reload();
      await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
      await expect(field).toHaveValue(message, { timeout: 60_000 });
    }
  } finally {
    await signIn(true);
    if (original) await page.setViewportSize(original);
    await field.fill("");
  }
  console.log(`PHONE-REFUSAL PASS ${engine}: keyboard-height refusal, remedy, Run settings, Send and durable draft`);
}
