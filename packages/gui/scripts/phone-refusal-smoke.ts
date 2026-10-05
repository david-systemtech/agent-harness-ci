import assert from "node:assert/strict";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";

/** Match text-named controls and labelled icon buttons without confusing empty icons. */
export const composerControlExpression = (text: string | null, label: string | null): string => label === null
  ? `Array.from(document.querySelector('[data-composer-column]').querySelectorAll('p[role="status"], button:not([aria-label])')).find(element => element.textContent === ${JSON.stringify(text)})`
  : `document.querySelector('[data-composer-column]').querySelector(${JSON.stringify(`[aria-label=${JSON.stringify(label)}]`)})`;

/** Hosted real-client regression for the keyboard-height refusal in #1325. */
export async function phoneRefusalSmoke(page: Page, engine: string, output: string, signIn: (signedIn: boolean) => Promise<void>, readDraft: () => Promise<string | null>): Promise<void> {
  const original = page.viewportSize();
  const message = "Explain the receipt totals and retain the original rounding rule.\n".repeat(6);
  const field = page.getByRole("textbox", { name: "Message", exact: true });
  const column = page.locator("[data-composer-column]");
  const refusal = column.locator('p[role="status"]').filter({ hasText: "Not sent:" });
  const settings = page.getByRole("button", { name: "Run settings", exact: true });
  const send = page.getByRole("button", { name: /^Send/ });
  const fits = async (control: Locator) => {
    const text = await control.textContent();
    const label = await control.getAttribute("aria-label");
    const element = composerControlExpression(text, label);
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
    // The preceding permission receipt can render while its run is still finishing.
    // Enter the refusal draft after the composer has returned to starting a new run.
    console.log(`PHONE-REFUSAL ${engine}: waiting for the previous run to finish`);
    await expect(field).toHaveAttribute("placeholder", "Continue the session…", { timeout: 60_000 });
    for (const viewport of [{ width: 390, height: 480 }, { width: 360, height: 400 }]) {
      console.log(`PHONE-REFUSAL ${engine}: viewport ${viewport.width}x${viewport.height}`);
      await page.setViewportSize(viewport);
      await page.evaluate("globalThis.__phoneSmokeField = document.querySelector('[aria-label=Message]')");
      await field.fill(message);
      try {
        await expect(field).toHaveValue(message);
        await expect(send).toBeEnabled();
        console.log(`PHONE-REFUSAL ${engine}: draft observed and Send enabled`);
        await send.click();
      }
      catch (error) {
        const state = await page.evaluate(`(() => {
          const field = document.querySelector('[aria-label="Message"]');
          const column = document.querySelector('[data-composer-column]');
          return { draftLength: field?.value.length, sameField: field === globalThis.__phoneSmokeField, originalConnected: globalThis.__phoneSmokeField?.isConnected, composer: column?.innerText, grant: document.querySelector('[data-web-grant]')?.innerText };
        })()`);
        console.error(`PHONE-REFUSAL ${engine}: Send failed ${JSON.stringify(state)}`);
        throw error;
      } finally { await page.evaluate("delete globalThis.__phoneSmokeField"); }
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
      const accountSection = choices.getByRole("group", { name: "Accounts", exact: true });
      await expect(accountSection).toBeVisible();
      await expect(choices.getByRole("group", { name: "Models", exact: true })).toHaveCount(0);
      await expect(choices.getByRole("group", { name: "Effort", exact: true })).toHaveCount(0);
      const accountRow = accountSection.getByRole("menuitem").filter({ hasText: "claude-max" });
      await expect(accountRow).toBeVisible();
      await accountRow.click();
      await page.keyboard.press("Escape");
      // The closing popup restores focus after its exit animation. The phone viewport
      // then scrolls that trigger into view; settle that event before scrolling elsewhere.
      await expect(choices).toBeHidden();
      await expect(account).toBeFocused();
      console.log(`PHONE-REFUSAL ${engine}: Run choices closed and Account focus restored`);
      const remedy = column.locator('p[role="status"]').filter({ hasText: "Cannot sign" });
      await expect(remedy).toContainText("admin");
      await fits(remedy);
      await fits(page.getByRole("button", { name: /^Send/ }));
      await settings.click();
      await expect.poll(readDraft, { timeout: 60_000, message: "The refused draft reaches the environment before reload." }).toBe(message);
      await page.reload();
      await page.locator('[data-web-grant][data-phase="ready"]').waitFor();
      await expect(field).toHaveValue(message, { timeout: 60_000 });
    }
  } finally {
    await signIn(true);
    if (original) await page.setViewportSize(original);
    await field.fill("");
    // The next phase must not restore this saved draft while editing its own.
    await expect(field).toHaveValue("");
    await expect.poll(readDraft, { timeout: 60_000, message: "The cleared refusal draft reaches the environment before the next smoke phase." }).toBeNull();
  }
  console.log(`PHONE-REFUSAL PASS ${engine}: keyboard-height refusal, remedy, Run settings, Send and durable draft`);
}
