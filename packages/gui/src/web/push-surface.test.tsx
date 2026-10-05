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

it("offers explicit push controls inside the same-origin environment's Attention settings without adding a conversation footer", async () => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  const permission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { permission: "default", requestPermission: permission });
  const originalWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, register: async () => { throw new Error("Unavailable in jsdom"); } } });
  onTestFinished(() => { vi.unstubAllGlobals(); if (originalWorker) Object.defineProperty(navigator, "serviceWorker", originalWorker); else delete (navigator as { serviceWorker?: unknown }).serviceWorker; });
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read"], sessions: [{ title: "Waiting session" }] }] });
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
  await screen.findByRole("note", { name: "Limited access" });
  expect(screen.queryByText("Phone notifications")).toBeNull();
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.setup().click(await screen.findByRole("button", { name: "Attention settings" }));
  expect(await screen.findByRole("button", { name: "Enable push" })).toBeDefined();
  expect(screen.getByRole("region", { name: "Web Push" }).closest("[data-attention-settings]")).not.toBeNull();
  expect(permission).not.toHaveBeenCalled();
});
