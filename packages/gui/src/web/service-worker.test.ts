// @vitest-environment node
import { expect, it, vi } from "vitest";
import { publicAssetRequest, installPublicWorker, type PublicWorkerScope } from "./service-worker.js";

it("admits only declared same-origin public GETs without credentials, query strings or pairing routes", () => {
  const origin = "https://client.example";
  const assets = ["/", "/assets/client.js", "/manifest.webmanifest"];
  expect(publicAssetRequest(new Request(`${origin}/assets/client.js`), origin, assets)).toBe(true);
  for (const request of [
    new Request(`${origin}/api/sessions`), new Request(`${origin}/pair`), new Request(`${origin}/pair#code-for-tests`),
    new Request(`${origin}/assets/client.js?token=token-for-tests`), new Request(`${origin}/assets/client.js`, { headers: { Authorization: "token-for-tests" } }),
    new Request(`${origin}/assets/client.js`, { method: "POST" }), new Request("https://other.example/assets/client.js"),
  ]) expect(publicAssetRequest(request, origin, assets)).toBe(false);
});


it("precaches only declared public bytes with omitted credentials and keeps an update waiting", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const saved: Request[] = [];
  const fetch = vi.fn(async () => new Response("public asset"));
  const skipWaiting = vi.fn(async () => undefined);
  const scope = {
    location: new URL("https://client.example"),
    caches: { keys: async () => [], open: async () => ({ put: async (request: Request) => { saved.push(request); }, match: async () => new Response("cached asset") }) },
    clients: { claim: async () => undefined }, fetch, skipWaiting,
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
  } as unknown as PublicWorkerScope;
  installPublicWorker(scope, "build-one", ["/", "/assets/client.js"]);
  let work: Promise<unknown> | undefined;
  listeners.get("install")!({ waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  expect(saved.map(request => [new URL(request.url).pathname, request.credentials])).toEqual([["/", "omit"], ["/assets/client.js", "omit"]]);
  expect(skipWaiting).not.toHaveBeenCalled();
  const respondWith = vi.fn();
  listeners.get("fetch")!({ request: new Request("https://client.example/api/sessions"), respondWith });
  listeners.get("fetch")!({ request: new Request("https://client.example/pair"), respondWith });
  expect(respondWith).not.toHaveBeenCalled();
  listeners.get("message")!({ data: "activate-public-update", waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work;
  expect(skipWaiting).toHaveBeenCalledOnce();
  fetch.mockRejectedValueOnce(new TypeError("Offline"));
  const navigation = new Request("https://client.example/");
  Object.defineProperty(navigation, "mode", { value: "navigate" });
  let response: Promise<Response> | undefined;
  listeners.get("fetch")!({ request: navigation, respondWith: (answer: Promise<Response>) => { response = answer; } });
  const offline = await response!;
  const text = await offline.text();
  expect(text).toContain("Offline — cached client");
  expect(text).toContain("content is stale");
  expect(text).not.toMatch(/<script|<form|<button/);

});

it("serves earlier declared assets to an existing tab from owned public caches after activation", async () => {
  let follow: ((event: { request: Request; respondWith(answer: Promise<Response>): void }) => void) | undefined;
  const fetch = vi.fn(async () => { throw new TypeError("Asset removed from the newer bundle"); });
  const scope = {
    location: new URL("https://client.example"),
    caches: { keys: async () => ["unrelated-cache", "agent-harness-public-earlier"], open: async (name: string) => ({ match: async () => name === "agent-harness-public-earlier" ? new Response("earlier font") : undefined }) },
    clients: { claim: async () => undefined }, fetch, skipWaiting: async () => undefined,
    addEventListener: (type: string, listener: typeof follow) => { if (type === "fetch") follow = listener; },
  } as unknown as PublicWorkerScope;
  installPublicWorker(scope, "newer", ["/", "/assets/newer.js"]);
  let response: Promise<Response> | undefined;
  follow!({ request: new Request("https://client.example/assets/earlier.woff2"), respondWith: answer => { response = answer; } });
  expect(await (await response!).text()).toBe("earlier font");
  expect(fetch).not.toHaveBeenCalled();
});
