import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { captureCases, sceneFiles } from "./capture-plan.js";
import { measureSceneGeometry } from "./geometry.js";
import { captureName, compareCapture, geometryFailures } from "./compare.js";
import type { Measurement } from "./compare.js";

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
  for (const viewport of [{ width: 1400, height: 900 }, { width: 1024, height: 768 }] as const) {
    for (const { scene, ladder } of captureCases(names)) {
      const name = captureName(scene, viewport.width, ladder);
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: ladder, reducedMotion: "reduce" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}/gallery.html?scene=${encodeURIComponent(scene)}&ladder=${ladder}`);
      await page.locator(`#root[data-gallery-ready="${scene}"]`).waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      });
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
        ...geometryFailures(measured, [{ measure: "$window", property: "overflow", maximum: 0 }]),
      ];
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
  }
  await writeFile(resolve(output, "geometry.json"), JSON.stringify(geometry, null, 2));
  const pixelBlocking = process.env["GALLERY_PIXEL_BLOCKING"] === "true";
  await writeFile(resolve(output, "report.json"), JSON.stringify({ pixelBlocking, scenes: report }, null, 2));
  for (const scene of report) {
    for (const failure of scene.geometryFailures) console.error(`${scene.name}: ${failure}`);
    if (scene.pixelFailed) console.log(`${scene.name}: ${scene.status}, ${scene.differentPixels} pixels (${pixelBlocking ? "blocking" : "advisory"})`);
  }
  if (report.some((scene) => scene.geometryFailures.length > 0 || pixelBlocking && scene.pixelFailed)) process.exitCode = 1;

} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
