import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, BrowserContext } from "playwright";
import { expect } from "playwright/test";

export function addCacheAudit(bundle: string): void {
  appendFileSync(join(bundle, "service-worker.js"), `
;const cacheWrites = [];
const putPublicBytes = Cache.prototype.put;
Cache.prototype.put = async function(request, response) {
  await putPublicBytes.call(this, request, response);
  const path = new URL(typeof request === "string" ? request : request.url).pathname;
  if (path === "/" || path === "/phone-icons/icon-192.png") {
    cacheWrites.push({ path, matched: Boolean(await this.match(request)), keys: (await this.keys()).length });
  }
};
globalThis.addEventListener("message", event => {
    if (event.data !== "__smoke-cache-audit") return;
    event.waitUntil((async () => {
      const capabilityName = "__smoke-cache-capability";
      const capability = await globalThis.caches.open(capabilityName);
      let capabilityResult;
      try {
        const root = new Request(new URL("/", globalThis.location.origin), { credentials: "omit", cache: "no-store" });
        await putPublicBytes.call(capability, root, new Response("fixture cache capability"));
        const synthetic = Boolean(await capability.match(root));
        const manifest = new Request(new URL("/manifest.webmanifest", globalThis.location.origin), { credentials: "omit", cache: "no-store" });
        const fetchedResponse = await fetch(manifest);
        const buffered = new Response(await fetchedResponse.clone().arrayBuffer(), { headers: fetchedResponse.headers, status: fetchedResponse.status });
        await putPublicBytes.call(capability, manifest, fetchedResponse);
        const fetched = Boolean(await capability.match(manifest));
        await putPublicBytes.call(capability, manifest, buffered);
        const bufferedMatch = Boolean(await capability.match(manifest));
        const icon = new URL("/phone-icons/icon-192.png", globalThis.location.origin).href;
        await putPublicBytes.call(capability, icon, new Response("fixture string-key capability"));
        capabilityResult = { synthetic, fetched, buffered: bufferedMatch, stringKey: Boolean(await capability.match(icon)), keys: (await capability.keys()).length };
      } finally {
        await globalThis.caches.delete(capabilityName);
      }
      const names = await globalThis.caches.keys();
      const urls = [];
      const matches = [];
      for (const name of names) {
        const cache = await globalThis.caches.open(name);
        for (const request of await cache.keys()) urls.push(request.url);
        matches.push({ name, root: Boolean(await cache.match("/")), icon: Boolean(await cache.match("/phone-icons/icon-192.png")), rootKeys: (await cache.keys("/")).length });
      }
      event.ports[0].postMessage({ names, urls, matches, writes: cacheWrites, capability: capabilityResult });
    })().catch(error => event.ports[0].postMessage({ error: String(error) })));
  });`);
}

export async function auditPublicCache(page: Page, engine: string, phase: string): Promise<string[]> {
  const windowCapability = await page.evaluate<{ matched: boolean; keys: number }>(`(async () => {
    const name = "__smoke-window-cache-capability";
    const cache = await caches.open(name);
    try {
      await cache.put("/", new Response("fixture window cache capability"));
      return { matched: Boolean(await cache.match("/")), keys: (await cache.keys()).length };
    } finally { await caches.delete(name); }
  })()`);
  console.log(`PHONE-INSTALL ${engine}: ${phase} window capability ${JSON.stringify(windowCapability)}`);
  // Audit from the worker's storage realm without changing the production cache.
  await page.evaluate(`void (async () => {
    const worker = navigator.serviceWorker.controller;
    if (!worker) throw new Error("No public worker for the audit.");
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      document.documentElement.setAttribute("data-smoke-cache-audit", JSON.stringify(event.data));
      channel.port1.close();
    };
    worker.postMessage("__smoke-cache-audit", [channel.port2]);
  })().catch(error => document.documentElement.setAttribute("data-smoke-cache-audit", JSON.stringify({ error: String(error) })))`);
  await page.locator("html[data-smoke-cache-audit]").waitFor({ state: "attached" });
  const audit = await page.evaluate<{ urls?: string[]; names?: string[]; matches?: unknown[]; writes?: unknown[]; capability?: unknown; error?: string }>("JSON.parse(document.documentElement.getAttribute('data-smoke-cache-audit'))");
  await page.evaluate("document.documentElement.removeAttribute('data-smoke-cache-audit')");
  assert(audit.urls, audit.error ?? "The worker cache audit answered.");
  console.log(`PHONE-INSTALL ${engine}: ${phase} cache ${JSON.stringify({ names: audit.names, entries: audit.urls.length, matches: audit.matches, writes: audit.writes, capability: audit.capability })}`);
  return audit.urls;

}

export async function waitForPublicWorker(page: Page, engine: string): Promise<void> {
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
}

/** Hosted real-client seam: no test server or browser is started by this leaf. */
export async function phoneInstallSmoke(page: Page, context: BrowserContext, bundle: string, engine: string): Promise<void> {
  await waitForPublicWorker(page, engine);
  await auditPublicCache(page, engine, "before update");
  const textbox = page.getByRole("textbox", { name: "Message", exact: true });
  await textbox.fill("Draft retained across a client update.");
  await textbox.dispatchEvent("compositionstart");
  // The actual serving directory changes underneath the current, still-usable client.
  execFileSync("pnpm", ["exec", "vite", "build", "--outDir", bundle], { env: { ...process.env, HARNESS_VERSION: `0.0.0-phone-update-${engine}` }, stdio: "pipe" });
  addCacheAudit(bundle);
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
  await auditPublicCache(page, engine, "after update");
  // Authenticated requests and pairing paths must bypass the public worker entirely.
  await page.evaluate(`(async () => {
    await fetch("/api/not-a-route", { headers: { Authorization: "token-for-tests" } });
    await fetch("/pair?code=code-for-tests");
  })()`);
  const cacheUrls = await auditPublicCache(page, engine, "after credential bypass");
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
