import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform } from "../platform/browser-platform.js";

/** Pairs the web client with `desk` on this page's origin, so its Attention settings carry the push section. */
const pairOnThisOrigin = async (scopes: readonly ("read" | "admin")[]) => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  const permission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { permission: "default", requestPermission: permission });
  const originalWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, register: async () => { throw new Error("Unavailable in jsdom"); } } });
  onTestFinished(() => { vi.unstubAllGlobals(); if (originalWorker) Object.defineProperty(navigator, "serviceWorker", originalWorker); else delete (navigator as { serviceWorker?: unknown }).serviceWorker; });
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: [...scopes], sessions: [{ title: "Waiting session" }] }] });
  world.environment("desk").wire.answer("attention.targets.list", () => ({ result: { targets: [] } }));
  const origin = new URL(world.environment("desk").wire.link).origin;
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url: string, init?: Parameters<typeof world.fetch>[1]) => world.fetch(url.replace(location.origin, origin), init),
    webSocket: (...args: Parameters<typeof world.webSocket>) => world.webSocket(args[0].replace(location.origin.replace(/^http/, "ws"), origin.replace(/^http/, "ws")), args[1]),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false);
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { address: location.origin, code: new URL(world.environment("desk").wire.link).hash.slice(1) } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  return { permission };
};

it("offers explicit push controls inside the same-origin environment's Attention settings without adding a conversation footer", async () => {
  const { permission } = await pairOnThisOrigin(["read"]);
  await screen.findByRole("note", { name: "Limited access" });
  expect(screen.queryByText("Phone notifications")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Attention settings" }));
  expect(await screen.findByRole("button", { name: "Enable push" })).toBeDefined();
  expect(screen.getByRole("region", { name: "Web Push" }).closest("[data-attention-settings]")).not.toBeNull();
  expect(permission).not.toHaveBeenCalled();
  expect(screen.getByText(/No webhook fallback is configured/).textContent).toMatch(/Ask an environment admin/);
});

it("never tells an admin client to ask an environment admin for the webhook fallback", async () => {
  await pairOnThisOrigin(["read", "admin"]);
  await userEvent.setup().click(await screen.findByRole("button", { name: "Settings" }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Attention settings" }));
  expect(await screen.findByRole("form", { name: "Add a webhook route" })).toBeDefined();
  expect((await screen.findByText(/No webhook fallback is configured/)).textContent).toMatch(/Add a webhook route above/);
  expect(document.body.textContent).not.toMatch(/ask an environment admin/i);
});
