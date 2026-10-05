import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";

import { fileTool, type ScriptControls } from "../../../environment/test/fake-adapter.js";
import { untilEvent } from "../../../environment/test/routines.js";
import type { TestEnvironment } from "../../../environment/test/helper.js";
import { SETTINGS_ROWS, STEP_ORDER, STEP_LABELS } from "@agent-harness/contracts";

const expect = browserExpect.configure({ timeout: 60_000 });

/** Scripted provider writes through the normal file observer, so Documents uses real events. */
export async function* phoneDocument(controls: ScriptControls) {
  const path = join(controls.input.workspace.path, "phone-preview.html");
  const content = `<!doctype html><h1>Hosted static preview</h1>
<script>parent.document.documentElement.dataset.previewCompromised = 'yes'; fetch('/preview-probe-script')</script>
<img src="/preview-probe-image" onerror="parent.document.documentElement.dataset.previewCompromised = 'yes'">
<style>body { background-image: url('/preview-probe-style') }</style>
<form action="/preview-probe-form"><input><button>Submit untrusted form</button></form>
<a href="/preview-probe-navigation">Untrusted link</a><iframe src="/preview-probe-frame"></iframe>`;
  yield* fileTool(controls, { tool: "Write", input: { file_path: path, content }, paths: [path], write: () => writeFileSync(path, content) });
}

const noOverflow = async (page: Page): Promise<void> => {
  await expect.poll(async () => page.evaluate<boolean>("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), { message: "The page must fit without horizontal scrolling." }).toBe(true);
};

export const reachable = async (page: Page, control: Locator): Promise<void> => {
  await expect(control).toBeVisible();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const box = await control.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) return { missing: true };
    if (box.width < 43.5 || box.height < 43.5) return { tooSmall: box };
    if (box.x < -0.5 || box.y < -0.5 || box.x + box.width > viewport.width + 0.5 || box.y + box.height > viewport.height + 0.5) return { outside: box, viewport };
    return true;
  }, { message: "Touch control is at least 44px and entirely inside the settled viewport." }).toBe(true);
};

const chooseRow = async (page: Page, label: string): Promise<void> => {
  await page.getByRole("button", { name: "Settings rows", exact: true }).click();
  const rows = page.getByRole("dialog", { name: "Settings rows", exact: true });
  await rows.getByRole("button", { name: label, exact: true }).click();
  await expect(rows).toBeHidden();
  await expect(page.getByRole("button", { name: "Settings rows", exact: true })).toBeFocused();
};

// Center each row with room at both scrollport edges before checking full intersection.
const revealMenuRow = async (row: Locator): Promise<void> => {
  await row.evaluate(element => {
    if (!("scrollIntoView" in element) || typeof element.scrollIntoView !== "function") throw new Error("A menu action must be scrollable.");
    element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  });
};

/** Inspect the real menu after scrolling each action, including disabled grant explanations. */
const phoneMoreSmoke = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "More", exact: true }).click();
  const menu = page.getByRole("menu");
  for (const name of ["Terminal", "Browser", "Split right", "Split down"]) {
    const row = menu.getByRole("menuitem", { name, exact: true });
    await revealMenuRow(row);
    await reachable(page, row);
    // Phone rows omit desktop shortcuts; a collapsed one-character column must fail.
    await expect(row.locator("kbd")).toBeHidden();
    if (await row.locator(":scope > span > span").count()) {
      const label = await row.locator(":scope > span").boundingBox();
      assert(label && label.width >= 200, "Menu explanations retain a word-sized column.");
    }
  }
  await expect(menu.getByRole("menuitem", { name: "Browser", exact: true })).not.toContainText("shell.webView");
  for (const row of await menu.getByRole("menuitem").all()) {
    await revealMenuRow(row);
    try { await reachable(page, row); }
    catch (error) {
      console.error("PHONE-MENU clipping", await row.getAttribute("aria-label"), await row.boundingBox(), await menu.boundingBox(), page.viewportSize());
      throw error;
    }
  }
  await page.keyboard.press("Escape");
};

/** Uses the production page from P01's HTTPS runner, never a gallery or fake shell. */
export async function phoneFrameSmoke(page: Page, engine: string): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseRow(page, "Accounts");
  await expect(page.getByText(/pair again.*admin/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add an account…", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await page.getByRole("button", { name: "More", exact: true }).click();
  for (const name of ["Files", "Diff", "Terminal", "Browser", "Split right", "Split down"]) {
    await expect(page.getByRole("menuitem", { name, exact: true })).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("Escape");
  for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }, { width: 390, height: 460 }]) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await noOverflow(page);
      await phoneMoreSmoke(page);
      for (const name of ["Show sessions", "Settings", "More"]) await reachable(page, page.getByRole("button", { name, exact: true }));
      await reachable(page, page.getByRole("button", { name: /^Send/ }));
      const trigger = page.getByRole("button", { name: "Show sessions", exact: true });
      await trigger.click();
      const drawer = page.getByRole("dialog", { name: "Sessions", exact: true });
      await expect(drawer).toBeFocused();
      await page.keyboard.press("Tab");
      await expect.poll(() => page.evaluate<boolean>("document.querySelector('.phone-frame-drawer')?.contains(document.activeElement) === true"), { timeout: 60_000, message: "Drawer traps focus after Tab." }).toBe(true);
      // A focused icon may open a tooltip whose first Escape dismisses only that tooltip.
      await drawer.getByRole("searchbox", { name: "Filter the sessions", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden(); await expect(trigger).toBeFocused();
    }
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseRow(page, "Theme");
  const textSize = page.getByRole("spinbutton", { name: "Text size", exact: true });
  const originalSize = await textSize.inputValue();
  await textSize.fill("20"); await textSize.press("Enter");
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 460 });
    await phoneMoreSmoke(page);
    await noOverflow(page);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseRow(page, "Theme");
  await textSize.fill(originalSize); await textSize.press("Enter");
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  console.log(`PHONE-FRAME PASS ${engine}: 390/360px, keyboard height, both color schemes, touch targets, drawer focus, grant restrictions`);
}

export async function phoneReconnectSmoke(page: Page, environment: TestEnvironment, sessionId: string, release: () => void, setOriginAvailable: (available: boolean) => void): Promise<void> {
  await page.context().setOffline(true);
  setOriginAvailable(false);
  try {
    await expect(page.locator("[data-web-grant]")).not.toContainText("ready");
    const after = environment.env.log.head();
    const prompt = untilEvent(environment, { kind: "session", id: sessionId }, event => event.sequence > after && event.type === "prompt.opened");
    release();
    await prompt;
  } finally {
    setOriginAvailable(true);
    await page.context().setOffline(false);
  }
  await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await expect(page.getByRole("button", { name: /^Allow once/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Allow once/ })).toBeVisible();
}

export async function phonePaneSmoke(page: Page, engine: string, environment: TestEnvironment, sessionId: string, previewRequests: () => readonly string[]): Promise<void> {
  const observer = await environment.client();
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await phoneMoreSmoke(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Full grant is minted separately by the runner; this never expands the Phone grant.
  for (const label of ["Files", "Diff", "Documents", "Tasks", "Terminal"]) {
    await page.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Side column", exact: true });
    await expect(sheet).toBeVisible();
    if (label !== "Terminal") await expect(sheet.getByRole("button", { name: "Close side sheet", exact: true })).toBeFocused();
    await noOverflow(page);
    if (label === "Files") await expect(sheet.getByRole("heading", { name: "The workspace", exact: true })).toBeVisible();
    if (label === "Documents") {
      const before = [...previewRequests()];
      const document = sheet.getByRole("article", { name: "phone-preview.html", exact: true });
      await document.getByRole("button", { name: "Preview", exact: true }).click();
      const frame = page.frameLocator('iframe[title="Preview of phone-preview.html"]');
      await expect(frame.getByRole("heading", { name: "Hosted static preview" })).toBeVisible();
      await expect.poll(() => frame.locator("html").evaluate<string>("document.readyState")).toBe("complete");
      await expect(page.locator('iframe[title="Preview of phone-preview.html"]')).toHaveAttribute("sandbox", "");
      await frame.getByText("Untrusted link", { exact: true }).click();
      await expect(frame.getByRole("heading", { name: "Hosted static preview" })).toBeVisible();
      assert.equal(await frame.locator("script, form, iframe, [onclick], [onerror], [href]").count(), 0);
      assert.equal(await page.locator("html").getAttribute("data-preview-compromised"), null, "Preview cannot modify its parent.");
      // Browsers report request events for CSP-blocked loads; prove contact at the real receiver.
      assert.deepEqual(previewRequests(), before, "Untrusted preview cannot contact the HTTPS receiver or navigate.");
    }
    let terminalId: string | undefined;
    if (label === "Terminal") {
      const ctrl = sheet.getByRole("button", { name: "Ctrl", exact: true });
      await expect(ctrl).toBeEnabled();
      for (const name of ["Ctrl", "Esc", "Tab", "Select", "Close terminal"]) await reachable(page, sheet.getByRole("button", { name, exact: true }));
      await expect.poll(async () => (await observer.request("terminals.list", { sessionId })).terminals.length, { timeout: 60_000 }).toBe(1);
      const terminals = await observer.request("terminals.list", { sessionId });
      assert.equal(terminals.terminals.length, 1); terminalId = terminals.terminals[0]!.id;
      // Close the sheet explicitly: Esc is also a terminal input control.
      await sheet.getByRole("button", { name: "Close side sheet", exact: true }).click();
    } else if (label === "Documents") {
      // The opaque preview owns keyboard focus; the parent has an explicit touch close control.
      await sheet.getByRole("button", { name: "Close side sheet", exact: true }).click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(sheet).toBeHidden();
    if (terminalId) {
      assert.equal((await observer.request("terminals.list", { sessionId })).terminals[0]?.id, terminalId, "Hiding the sheet keeps the environment PTY.");
    }
    await expect(page.getByRole("button", { name: "Show the side column", exact: true })).toBeFocused();
  }
  // The web replacement lives in Status; the native Browser dock remains unavailable.
  const browserTrigger = page.getByRole("button", { name: "Environment browser", exact: true });
  await browserTrigger.click();
  const browserDialog = page.getByRole("dialog", { name: "Environment browser", exact: true });
  await expect(browserDialog.getByRole("textbox", { name: "Page address", exact: true })).toBeVisible();
  await expect(browserDialog.getByRole("combobox", { name: "Browser for the next run", exact: true })).toBeVisible();
  assert.equal(await browserDialog.locator("iframe").count(), 0, "The browser replacement never embeds a third-party page.");
  await reachable(page, browserDialog.getByRole("button", { name: "Close browser", exact: true }));
  await browserDialog.getByRole("button", { name: "Close browser", exact: true }).click();
  await expect(browserDialog).toBeHidden(); await expect(browserTrigger).toBeFocused();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const row of SETTINGS_ROWS) {
    if ("dim" in row) {
      await page.getByRole("button", { name: "Settings rows", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Settings rows", exact: true });
      await expect(drawer.getByRole("button", { name: row.label, exact: true })).toHaveAttribute("aria-disabled", "true");
      await expect(drawer.getByText(row.dim, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      continue;
    }
    await chooseRow(page, row.label);
    await expect(page.getByRole("heading", { name: row.label, level: 2, exact: true })).toBeVisible();
    await noOverflow(page);
  }
  await chooseRow(page, "Theme");
  const textSize = page.getByRole("spinbutton", { name: "Text size", exact: true });
  await textSize.fill("20"); await textSize.press("Enter");
  await expect(page.getByRole("spinbutton", { name: "Text size", exact: true })).toHaveValue("20");
  await page.getByRole("button", { name: "Close Settings", exact: true }).click();
  await page.setViewportSize({ width: 360, height: 460 });
  await noOverflow(page); await reachable(page, page.getByRole("button", { name: /^Send/ }));
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 460 });
    await phoneMoreSmoke(page);
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await chooseRow(page, "Accounts");
  await expect(page.getByRole("button", { name: "Add an account…", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Open the Carry over step in Set up", exact: true }).click();
  const setup = page.getByRole("region", { name: "Set up", exact: true });
  for (const step of STEP_ORDER) {
    await setup.getByRole("button", { name: "Set up steps", exact: true }).click();
    await page.getByRole("dialog", { name: "Set up steps", exact: true }).getByRole("button", { name: STEP_LABELS[step], exact: true }).click();
    await expect(setup.getByRole("heading", { name: STEP_LABELS[step], level: 2, exact: true })).toBeVisible();
    await reachable(page, setup.getByRole("button", { name: step === "appearance" ? "Finish" : "Continue", exact: true }));
    await noOverflow(page);
  }
  await observer.close();
  console.log(`PHONE-PANES PASS ${engine}: all seven panes, retained PTY, isolated preview, every Settings row and all eleven steps, text at 20`);
}
