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
  const fits = async (control: Locator, name: string) => {
    const diagnostics = await page.evaluate(`(() => {
      const element = document.querySelector('[data-composer-column]');
      const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const parents = [];
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (node === element || style.overflowY !== "visible") parents.push({ tag: node.tagName, box: rect(node), overflowY: style.overflowY, scrollTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight });
      }
      const active = document.activeElement;
      const viewport = window.visualViewport;
      return { parents, controls: [...element.querySelectorAll('p[role="status"], button')].map(node => ({ label: node.getAttribute("aria-label") || node.textContent, box: rect(node) })), active: active ? { tag: active.tagName, label: active.getAttribute("aria-label"), box: rect(active) } : null, viewport: viewport ? { height: viewport.height, width: viewport.width, offsetTop: viewport.offsetTop, scale: viewport.scale } : null };
    })()`);
    console.log(`PHONE-REFUSAL ${engine}: ${name} geometry ${JSON.stringify(diagnostics)}`);
    const box = await control.boundingBox();
    const region = await column.boundingBox();
    const viewport = page.viewportSize();
    assert(box && region && viewport, "The refusal and controls have rendered boxes.");
    assert(box.y >= region.y - 1 && box.y + box.height <= region.y + region.height + 1, `The whole ${name} fits the user-scrollable composer: ${JSON.stringify({ box, region, viewport, diagnostics })}`);
    assert(box.y >= 0 && box.y + box.height <= viewport.height + 1, `The ${name} is reachable inside the keyboard-height viewport: ${JSON.stringify({ box, region, viewport, diagnostics })}`);
  };
  await signIn(false);
  try {
    for (const viewport of [{ width: 390, height: 480 }, { width: 360, height: 400 }]) {
      console.log(`PHONE-REFUSAL ${engine}: viewport ${viewport.width}x${viewport.height}`);
      await page.setViewportSize(viewport);
      await field.fill(message);
      await page.getByRole("button", { name: /^Send/ }).click();
      await expect(refusal).toContainText("not signed in");
      await expect(refusal).toContainText("no run can start");
      await expect(field).toHaveValue(message);
      assert.equal(await page.evaluate("getComputedStyle(document.querySelector('[data-composer-column]')).overflowY"), "auto", "A touch user can scroll the full composer, including its refusal and Run settings.");
      await refusal.scrollIntoViewIfNeeded();
      await fits(refusal, "refusal");
      await page.screenshot({ path: join(output, `phone-refusal-${engine}-${viewport.width}.png`) });
      await settings.scrollIntoViewIfNeeded();
      await fits(settings, "Run settings");
      await settings.click();
      const account = page.getByRole("button", { name: /^Account:/ });
      await account.click();
      const choices = page.getByRole("dialog", { name: "Run choices" });
      await expect(choices).toContainText(/signed out/i);
      await choices.getByRole("menuitem").filter({ hasText: "claude-max" }).click();
      await page.keyboard.press("Escape");
      // The closing popup restores focus after its exit animation. The phone viewport
      // then scrolls that trigger into view; settle that event before scrolling elsewhere.
      await expect(choices).toBeHidden();
      await expect(account).toBeFocused();
      console.log(`PHONE-REFUSAL ${engine}: Run choices closed and Account focus restored`);
      const remedy = column.locator('p[role="status"]').filter({ hasText: "Cannot sign" });
      await expect(remedy).toContainText("admin");
      await remedy.scrollIntoViewIfNeeded();
      await fits(remedy, "remedy");
      await page.getByRole("button", { name: /^Send/ }).scrollIntoViewIfNeeded();
      await fits(page.getByRole("button", { name: /^Send/ }), "Send");
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
