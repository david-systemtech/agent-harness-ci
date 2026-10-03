import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { captureCases, sceneFiles } from "./capture-plan.js";
import { measureSceneGeometry } from "./geometry.js";

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
  const names = await sceneFiles(resolve(import.meta.dirname, "scenes"));
  if (names.length === 0) throw new Error("The gallery has no scenes.");
  const failures: string[] = [];
  for (const { scene, ladder, name } of captureCases(names)) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1, colorScheme: ladder, reducedMotion: "reduce" });
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
    await page.screenshot({ path: resolve(output, `${name}.png`), animations: "disabled", caret: "hide", scale: "css" });
    failures.push(...(await page.evaluate(measureSceneGeometry)).map((failure) => `${name}: ${failure}`));
    await context.close();
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}
