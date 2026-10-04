import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Page, BrowserContext } from "playwright";

/** Hosted real-client seam: no test server or browser is started by this leaf. */
export async function phoneInstallSmoke(page: Page, context: BrowserContext, bundle: string, engine: string): Promise<void> {
  await page.evaluate("navigator.serviceWorker.ready.then(() => undefined)");
  await page.waitForFunction("navigator.serviceWorker.controller !== null");
  const textbox = page.getByRole("textbox", { name: "Message", exact: true });
  await textbox.fill("Draft retained across a client update.");
  await textbox.dispatchEvent("compositionstart");
  // The actual serving directory changes underneath the current, still-usable client.
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", bundle], { env: { ...process.env, HARNESS_VERSION: `0.0.0-phone-update-${engine}` }, stdio: "pipe" });
  await page.evaluate("navigator.serviceWorker.ready.then(registration => registration.update())");
  const reload = page.getByRole("button", { name: "Reload client", exact: true });
  await reload.waitFor();
  assert(await reload.isDisabled(), "An update cannot reload during IME composition.");
  assert.equal(await textbox.inputValue(), "Draft retained across a client update.", "An update never forces navigation while composing.");
  await textbox.dispatchEvent("compositionend");
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), reload.click()]);
  await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await textbox.waitFor();
  assert.equal(await textbox.inputValue(), "Draft retained across a client update.", "The runtime persists the draft before activating the waiting bundle.");
  // Authenticated requests and pairing paths must bypass the public worker entirely.
  await page.evaluate(`(async () => {
    await fetch("/api/not-a-route", { headers: { Authorization: "token-for-tests" } });
    await fetch("/pair?code=code-for-tests");
  })()`);
  const cacheUrls = await page.evaluate<string[]>(`(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  })()`);
  assert(cacheUrls.length > 0, "The production worker cached public assets.");
  assert(cacheUrls.every(value => {
    const url = new URL(value);
    return url.origin === new URL(page.url()).origin && !url.search && !url.hash && (url.pathname === "/" || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/assets/") || url.pathname.startsWith("/phone-icons/"));
  }), "Only same-origin public assets reach CacheStorage; no API, pairing URL or credential is cached.");
  const manifest = await page.evaluate<{ id: string; start_url: string; scope: string; display: string }>("fetch('/manifest.webmanifest').then(response => response.json())");
  assert.deepEqual([manifest.id, manifest.start_url, manifest.scope, manifest.display], ["/", "/", "/", "standalone"]);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("heading", { name: "Offline — cached client" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Send/ }).count(), 0, "The offline shell cannot start a run.");
  await context.setOffline(false);
  await page.reload();
  await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await textbox.waitFor();
  assert.equal(await textbox.inputValue(), "Draft retained across a client update.");
  console.log(`PHONE-INSTALL PASS ${engine}: public-only cache, waiting update, IME guard, durable draft, stale offline shell`);
}
