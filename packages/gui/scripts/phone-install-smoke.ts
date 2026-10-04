import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type { Page, BrowserContext } from "playwright";
import { expect } from "playwright/test";

/** Hosted real-client seam: no test server or browser is started by this leaf. */
export async function phoneInstallSmoke(page: Page, context: BrowserContext, bundle: string, engine: string): Promise<void> {
  console.log(`PHONE-INSTALL ${engine}: waiting for the public worker`);
  // Playwright's waitForFunction evaluates its predicate inside the page; WebKit enforces the served CSP there.
  await page.evaluate(`(() => {
    const workers = navigator.serviceWorker;
    document.documentElement.setAttribute("data-smoke-worker-registration", "pending");
    void workers.getRegistration().then(registration => {
      document.documentElement.setAttribute("data-smoke-worker-registration", JSON.stringify({
        active: registration?.active?.state,
        installing: registration?.installing?.state,
        waiting: registration?.waiting?.state,
      }));
    }, error => document.documentElement.setAttribute("data-smoke-worker-registration", String(error)));
    const controlled = () => {
      if (!workers.controller) return;
      document.documentElement.setAttribute("data-smoke-worker-controlled", "");
      workers.removeEventListener("controllerchange", controlled);
    };
    workers.addEventListener("controllerchange", controlled);
    controlled();
  })()`);
  try {
    await page.locator("html[data-smoke-worker-controlled]").waitFor({ state: "attached" });
  } catch (error) {
    const reason = await page.evaluate("({ registration: document.documentElement.getAttribute('data-smoke-worker-registration'), controlled: Boolean(navigator.serviceWorker.controller) })");
    console.error(`PHONE-INSTALL ${engine}: public worker readiness failed: ${JSON.stringify(reason)}`);
    throw new Error(`${engine} public worker did not activate: ${JSON.stringify(reason)}`, { cause: error });
  }
  await page.evaluate("document.documentElement.removeAttribute('data-smoke-worker-controlled')");
  await page.evaluate("document.documentElement.removeAttribute('data-smoke-worker-registration')");
  console.log(`PHONE-INSTALL ${engine}: public worker controls the client`);
  const textbox = page.getByRole("textbox", { name: "Message", exact: true });
  await textbox.fill("Draft retained across a client update.");
  await textbox.dispatchEvent("compositionstart");
  // The actual serving directory changes underneath the current, still-usable client.
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", bundle], { env: { ...process.env, HARNESS_VERSION: `0.0.0-phone-update-${engine}` }, stdio: "pipe" });
  await page.evaluate("navigator.serviceWorker.getRegistration().then(registration => { if (!registration) throw new Error('No public worker registration.'); void registration.update(); })");
  console.log(`PHONE-INSTALL ${engine}: waiting for the updated bundle`);
  const reload = page.getByRole("button", { name: "Reload client", exact: true });
  await reload.waitFor();
  assert(await reload.isDisabled(), "An update cannot reload during IME composition.");
  assert.equal(await textbox.inputValue(), "Draft retained across a client update.", "An update never forces navigation while composing.");
  await textbox.dispatchEvent("compositionend");
  await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }), reload.click()]);
  await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await textbox.waitFor();
  await expect(textbox, "The runtime persists the draft before activating the waiting bundle.").toHaveValue("Draft retained across a client update.", { timeout: 60_000 });
  console.log(`PHONE-INSTALL ${engine}: draft survived the explicit update`);
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
  console.log(`PHONE-INSTALL ${engine}: reloading offline`);
  await context.setOffline(true);
  await page.reload();
  await page.getByRole("heading", { name: "Offline — cached client" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /^Send/ }).count(), 0, "The offline shell cannot start a run.");
  console.log(`PHONE-INSTALL ${engine}: stale shell reached; reconnecting`);
  await context.setOffline(false);
  await page.reload();
  await page.locator("[data-web-grant]").filter({ hasText: "ready" }).waitFor();
  await textbox.waitFor();
  await expect(textbox).toHaveValue("Draft retained across a client update.", { timeout: 60_000 });
  console.log(`PHONE-INSTALL PASS ${engine}: public-only cache, waiting update, IME guard, durable draft, stale offline shell`);
}
