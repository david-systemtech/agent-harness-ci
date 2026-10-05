import assert from "node:assert/strict";
import type { Locator, Page } from "playwright";
import { expect } from "playwright/test";

/** Hosted portal geometry: a keyboard can shrink and pan only the visual viewport. */
export async function phoneRunPickerSmoke(page: Page, engine: string): Promise<void> {
  const layout = await page.evaluate<{ width: number; height: number }>("({ width: innerWidth, height: innerHeight })");
  const settings = page.getByRole("button", { name: "Run settings", exact: true });
  if (await settings.getAttribute("aria-expanded") !== "true") await settings.click();
  const runSettings = page.getByRole("dialog", { name: "Run settings", exact: true });
  await expect(runSettings).toBeVisible();
  const model = runSettings.getByRole("button", { name: /^Model:/ });
  await model.click();
  const choices = page.getByRole("dialog", { name: "Run choices" });
  const models = choices.getByRole("group", { name: "Models", exact: true });
  const search = models.getByRole("textbox", { name: "Search models" });
  await expect(search).toBeVisible();
  await models.getByRole("menuitem", { name: "All models", exact: true }).click();
  await search.focus();
  await page.evaluate(`(() => {
    const viewport = window.visualViewport;
    if (!viewport) throw new Error("The browser exposes its visual viewport.");
    const fields = ["height", "width", "offsetTop", "offsetLeft"];
    const descriptors = fields.map(name => Object.getOwnPropertyDescriptor(viewport, name));
    window.addEventListener("smoke-run-picker-restore", () => {
      fields.forEach((name, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(viewport, name, descriptor);
        else Reflect.deleteProperty(viewport, name);
      });
      viewport.dispatchEvent(new Event("resize"));
    }, { once: true });
  })()`);
  try {
    for (const bounds of [{ height: 400, width: 390, offsetTop: 0, offsetLeft: 0 }, { height: 360, width: 360, offsetTop: 80, offsetLeft: 15 }]) {
      // Inject keyboard bounds into the real viewport event source; layout dimensions stay fixed.
      await page.evaluate(`(() => {
        const bounds = ${JSON.stringify(bounds)};
        const viewport = window.visualViewport;
        if (!viewport) throw new Error("The browser exposes its visual viewport.");
        for (const [name, value] of Object.entries(bounds)) Object.defineProperty(viewport, name, { configurable: true, value });
        viewport.dispatchEvent(new Event("resize"));
        viewport.dispatchEvent(new Event("scroll"));
      })()`);
      assert.deepEqual(await page.evaluate("({ width: innerWidth, height: innerHeight })"), layout, "The layout viewport did not resize.");
      const fits = async (control: Locator) => expect.poll(async () => {
        const box = await control.boundingBox();
        return box !== null && box.x >= bounds.offsetLeft - 1 && box.y >= bounds.offsetTop - 1
          && box.x + box.width <= bounds.offsetLeft + bounds.width + 1 && box.y + box.height <= bounds.offsetTop + bounds.height + 1;
      }, { message: `${engine}: the entire picker/control fits the visual viewport` }).toBe(true);
      await fits(choices);
      await search.scrollIntoViewIfNeeded();
      await fits(search);
      const last = models.getByRole("menuitem").last();
      await last.scrollIntoViewIfNeeded();
      await fits(last);
    }
  } finally {
    await page.evaluate("window.dispatchEvent(new Event('smoke-run-picker-restore'))");
    await page.keyboard.press("Escape");
    await expect(choices).toBeHidden();
    await expect(model).toBeFocused();
    await runSettings.getByRole("button", { name: "Close dialog", exact: true }).click();
    await expect(runSettings).toBeHidden();
    await expect(settings).toBeFocused();
  }
  console.log(`PHONE-RUN-PICKER PASS ${engine}: search and last row fit a shrinking and panning visual viewport`);
}
