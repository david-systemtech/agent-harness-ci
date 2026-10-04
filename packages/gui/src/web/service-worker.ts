import { cssVariables, derive, SHIPPED_THEMES } from "@agent-harness/theme";

/** The public asset policy is shared with tests; no runtime, documents or secrets enter this worker. */
export const publicAssetRequest = (request: Request, origin: string, assets: readonly string[]): boolean => {
  const url = new URL(request.url);
  return request.method === "GET" && url.origin === origin && !url.search && (!url.hash || request.mode === "navigate")
    && !request.headers.has("authorization") && !request.headers.has("cookie") && assets.includes(url.pathname);
};

interface LifetimeEvent extends Event { waitUntil(work: Promise<unknown>): void }
interface AssetEvent extends LifetimeEvent { readonly request: Request; respondWith(response: Promise<Response>): void }
export interface PublicWorkerScope {
  readonly location: Location;
  readonly caches: CacheStorage;
  readonly clients: { claim(): Promise<void> };
  fetch(request: Request): Promise<Response>;
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (event: LifetimeEvent) => void): void;
  addEventListener(type: "fetch", listener: (event: AssetEvent) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent & LifetimeEvent) => void): void;
}
/** P15 exports a pushWorkerHook from push-worker.ts; it owns only its event listeners. */
export type PushWorkerHook = (scope: PublicWorkerScope) => void;

const offlineTokens = Object.entries(cssVariables(derive(SHIPPED_THEMES[0]!).dark)).map(([key, value]) => `${key}:${value}`).join(";");
const offlineShell = (stylesheet: string | undefined) => `<!doctype html><html lang="en" style="${offlineTokens};color-scheme:dark;--font-scale:${16 / 14}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Offline client</title>${stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : ""}</head><body><main class="min-h-dvh bg-abyss p-4 text-ink "><section class="flex min-w-0 flex-col gap-3 rounded-lg border border-hairline bg-panel p-3"><h1 class="font-semibold">Offline — cached client</h1><p>This content is stale. Connect to your environment to read current sessions or start a run.</p><p>Your saved drafts and pairing remain in this client's separate browser storage.</p><a class="inline-flex min-h-11 items-center self-start rounded-lg bg-beam px-3 text-beam-ink " href="/">Try connecting again</a></section></main></body></html>`;

export function installPublicWorker(scope: PublicWorkerScope, version: string, assets: readonly string[]): void {
  const cacheName = `agent-harness-public-${version}`;
  const origin = scope.location.origin;
  const request = (path: string) => new Request(new URL(path, origin), { credentials: "omit", cache: "reload" });
  scope.addEventListener("install", event => event.waitUntil((async () => {
    const cache = await scope.caches.open(cacheName);
    // A partial install never becomes the active version.
    await Promise.all(assets.map(async path => {
      const response = await scope.fetch(request(path));
      if (!response.ok || response.redirected || response.headers.has("set-cookie")) throw new Error("Public asset unavailable.");
      await cache.put(request(path), response);
    }));
  })()));
  scope.addEventListener("activate", event => event.waitUntil(scope.clients.claim()));
  scope.addEventListener("message", event => {
    if (event.data === "activate-public-update") event.waitUntil(scope.skipWaiting());
  });
  scope.addEventListener("fetch", event => {
    const url = new URL(event.request.url);
    const olderAsset = url.pathname.startsWith("/assets/") && publicAssetRequest(event.request, origin, [url.pathname]);
    if (!publicAssetRequest(event.request, origin, assets) && !olderAsset) return;
    event.respondWith((async () => {
      // A navigation always asks for the current client; an offline navigation has no run controls.
      if (event.request.mode === "navigate") {
        try { return await scope.fetch(request(new URL(event.request.url).pathname)); }
        catch { return new Response(offlineShell(assets.find(path => path.endsWith(".css"))), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'none'" } }); }
      }
      const cache = await scope.caches.open(cacheName);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      // Other tabs may still run the earlier bundle after an explicit upgrade in this tab.
      if (olderAsset) for (const name of await scope.caches.keys()) {
        if (!name.startsWith("agent-harness-public-")) continue;
        const previous = await (await scope.caches.open(name)).match(event.request);
        if (previous) return previous;
      }
      return scope.fetch(request(url.pathname));
    })());
  });
}

declare const __HARNESS_VERSION__: string;
// The build replaces this sentinel with the exact public bundle paths, including imported fonts.
const bundledAssets: readonly string[] = "__PUBLIC_ASSET_PATHS__" as unknown as readonly string[];
const workerGlobal = globalThis as unknown as PublicWorkerScope & { readonly document?: Document };
if (typeof workerGlobal.document === "undefined" && "clients" in workerGlobal && "caches" in workerGlobal) {
  installPublicWorker(workerGlobal, `${__HARNESS_VERSION__}-__PUBLIC_CACHE_VERSION__`, bundledAssets);
  const hooks = import.meta.glob<{ readonly pushWorkerHook: PushWorkerHook }>("./push-worker.ts", { eager: true });
  for (const hook of Object.values(hooks)) hook.pushWorkerHook(workerGlobal);
}
