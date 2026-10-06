import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { capturePlan, captureShard, sceneFiles } from "./capture-plan.js";
import { verifyPhoneMenuReachability } from "./phone-menu-reachability.js";
import { measureSceneGeometry } from "./geometry.js";
import { waitForFloatingLayout } from "./floating-layout.js";
import { compareCapture, geometryFailures, galleryFailed } from "./compare.js";
import type { Measurement } from "./compare.js";
import { observePreviewRequests, verifyPhonePreviewIsolation } from "./phone-preview-isolation.js";

// This executable starts a server and Chromium. Its only execution site is a hosted CI runner.
if (process.env["GITHUB_ACTIONS"] !== "true" || process.env["RUNNER_ENVIRONMENT"] !== "github-hosted") {
  throw new Error("Gallery capture runs only on GitHub-hosted runners.");
}
const directory = resolve(import.meta.dirname, "../gallery-dist");
const output = resolve(import.meta.dirname, "../gallery-images");
const types: Readonly<Record<string, string>> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = createServer((request, response) => {
  const path = resolve(directory, `.${new URL(request.url ?? "/", "http://localhost").pathname}`);
  if (!path.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
  response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
  const file = createReadStream(path);
  file.on("error", () => response.writeHead(404).end());
  file.pipe(response);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Gallery server has no address.");
let browser;
try {
  await mkdir(output, { recursive: true });
  browser = await chromium.launch();
  const report: { name: string; status: string; differentPixels: number; pixelFailed: boolean; geometryFailures: string[] }[] = [];
  const geometry: Record<string, readonly Measurement[]> = {};
  const names = await sceneFiles(resolve(import.meta.dirname, "scenes"));
  if (names.length === 0) throw new Error("The gallery has no scenes.");
  const plan = capturePlan(names);
  console.log(`Capture budget: ${plan.budget.desktop} desktop + ${plan.budget.phone} phone = ${plan.budget.total}/${plan.budget.limit}; ${plan.budget.remaining} reserved.`);
  const selected = captureShard(plan, process.env["GALLERY_SHARD"]);
  const { shard } = selected;
  for (const { scene, ladder, viewport, name, platform, textSize, probes } of selected.captures) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: ladder, ...(platform === "web" && { isMobile: true, hasTouch: true }), reducedMotion: "reduce" });
    const previewRequests = scene === "phone-pane-preview" ? await observePreviewRequests(context) : undefined;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const sceneUrl = `http://127.0.0.1:${address.port}/gallery.html?scene=${encodeURIComponent(scene)}&ladder=${ladder}&platform=${platform}${platform === "web" ? `&textSize=${textSize}` : ""}`;
    await page.goto(sceneUrl);
    await page.locator(`#root[data-gallery-ready="${scene}"]`).waitFor();
    await page.evaluate(waitForFloatingLayout);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    const capturePath = resolve(output, `${name}.png`);
    await page.screenshot({ path: capturePath, animations: "disabled", caret: "hide", scale: "css" });
    const measured = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-measure]"));
      return [
        { measure: "$window", width: innerWidth, height: innerHeight, overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth) },
        ...elements.map((element) => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return {
            measure: element.dataset["measure"] ?? "", x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight), fontFamily: style.fontFamily,
            maxChildHeight: Math.max(0, ...Array.from(element.children, (child) => child.getBoundingClientRect().height)),
          };
        }),
      ];
    });
    geometry[name] = measured;
    const failures = [
      ...await page.evaluate(measureSceneGeometry),
      ...(scene.startsWith("phone-more-") ? await page.evaluate(verifyPhoneMenuReachability) : []),
      ...geometryFailures(measured, [{ measure: "$window", property: "overflow", maximum: 0 }]),
      ...(platform === "web" ? await page.evaluate((size) => {
        const actual = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        return Math.abs(actual - 16 * size / 14) <= 0.5 ? [] : [`html.fontSize: got ${actual}, expected ${16 * size / 14}`];
      }, textSize) : []),
    ];
    // The same scene in each shorter window, measured without a screenshot; a failure names the window.
    for (const probe of probes ?? []) {
      const probeContext = await browser.newContext({ viewport: probe, deviceScaleFactor: 1, colorScheme: ladder, reducedMotion: "reduce" });
      const probePage = await probeContext.newPage();
      const probeErrors: string[] = [];
      probePage.on("pageerror", (error) => probeErrors.push(error.message));
      await probePage.goto(sceneUrl);
      await probePage.locator(`#root[data-gallery-ready="${scene}"]`).waitFor();
      await probePage.evaluate(waitForFloatingLayout);
      const overflow = await probePage.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth, document.body.scrollWidth - innerWidth));
      failures.push(...[...probeErrors, ...await probePage.evaluate(measureSceneGeometry), ...(overflow > 0 ? [`$window.overflow: got ${overflow}, expected 0`] : [])]
        .map((failure) => `${probe.width}×${probe.height}: ${failure}`));
      await probeContext.close();
    }
    if (previewRequests !== undefined) {
      try { await verifyPhonePreviewIsolation(page, previewRequests); }
      catch (error) { failures.push(`Preview isolation: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const baselinePath = resolve(import.meta.dirname, "baselines", `${name}.png`);
    let baseline: Buffer | undefined;
    try { baseline = await readFile(baselinePath); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const compared = compareCapture(baseline, await readFile(capturePath));
    if (baseline !== undefined && compared.status === "changed") await copyFile(baselinePath, resolve(output, `${name}.baseline.png`));
    if (compared.difference !== undefined) await writeFile(resolve(output, `${name}.difference.png`), compared.difference);
    report.push({ name, status: compared.status, differentPixels: compared.differentPixels, pixelFailed: compared.pixelFailed, geometryFailures: failures });
    await context.close();
  }
  await writeFile(resolve(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  const pixelBlocking = true;
  await writeFile(resolve(output, "report.json"), JSON.stringify({ pixelBlocking, captureBudget: selected.budget, shard, scenes: report }, null, 2));
  for (const scene of report) {
    for (const failure of scene.geometryFailures) console.error(`${scene.name}: ${failure}`);
    if (scene.pixelFailed) console.log(`${scene.name}: ${scene.status}, ${scene.differentPixels} pixels (${pixelBlocking ? "blocking" : "advisory"})`);
  }
  if (galleryFailed(report)) process.exitCode = 1;

} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
