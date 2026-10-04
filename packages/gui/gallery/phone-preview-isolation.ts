import type { BrowserContext, Page } from "playwright";

/** A hosted browser reading, checked separately from pixel comparisons. */
export interface PreviewIsolationReading {
  readonly scriptRan: boolean;
  readonly parentReadable: boolean;
  readonly parentMutated: boolean;
  readonly requests: readonly string[];
}
export function assertPreviewIsolation(path: string, reading: PreviewIsolationReading): void {
  const failures = [
    ...(reading.scriptRan ? ["document script executed"] : []),
    ...(reading.parentReadable ? ["parent document was readable"] : []),
    ...(reading.parentMutated ? ["parent document was changed"] : []),
    ...reading.requests.map(url => `network request: ${url}`),
  ];
  if (failures.length > 0) throw new Error(`${path}: ${failures.join("; ")}`);
}

/** Installed before navigation so early iframe resource loads cannot escape observation. */
export async function observePreviewRequests(context: BrowserContext): Promise<string[]> {
  const requests: string[] = [];
  context.on("request", request => {
    if (/^https?:/.test(request.url()) && request.frame().parentFrame() !== null) requests.push(request.url());
  });
  // Record attempted probes while keeping a regression from contacting the fixture host.
  await context.route("https://example.test/**", route => route.abort());
  return requests;
}

/** Chromium, rather than jsdom, executes these assertions against each actual srcdoc. */
export async function verifyPhonePreviewIsolation(page: Page, requests: readonly string[]): Promise<void> {
  for (const path of ["site/index.html", "chart.svg"]) {
    if (path === "chart.svg") {
      await page.getByRole("tab", { name: "Documents", exact: true }).click();
      await page.getByRole("article", { name: path, exact: true }).getByRole("button", { name: "Preview", exact: true }).click();
    }
    const handle = await page.getByTitle(`Preview of ${path}`, { exact: true }).elementHandle();
    const frame = await handle?.contentFrame();
    if (!frame) throw new Error(`${path}: no rendered preview frame`);
    await frame.waitForLoadState("load");
    await frame.locator(path.endsWith(".svg") ? "svg circle" : "h1").waitFor();
    const reading = await frame.evaluate(() => {
      let parentReadable = false;
      try { void parent.document.body; parentReadable = true; }
      catch (error) { if (!(error instanceof DOMException) || error.name !== "SecurityError") throw error; }
      return { scriptRan: document.documentElement.dataset["previewScriptRan"] === "yes", parentReadable };
    });
    const parentMutated = await page.evaluate(() => document.documentElement.dataset["previewParentAccess"] === "yes");
    assertPreviewIsolation(path, { ...reading, parentMutated, requests });
    console.log(`${path}: hosted preview scripts, parent access and network isolation passed`);
  }
}
