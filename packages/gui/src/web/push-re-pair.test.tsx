import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { SCOPES, type AttentionTargetInput } from "@agent-harness/contracts";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform } from "../platform/browser-platform.js";

const KEYS = { auth: "auth-for-tests", p256dh: "key-for-tests" };

/**
 * A phone web client paired with `desk`'s Phone grant on this page's origin, whose browser can push: its subscription is
 * the browser's, and the environment keeps each push registration for the client session that made it, as the
 * environment does, a re-pair's revoked client session losing its own (#1959).
 */
const phoneOnThisOrigin = async ({ subscribeWithoutTap = true } = {}) => {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PushManager", class {});
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("Notification", { permission: "granted", requestPermission });
  let current: { readonly endpoint: string } | null = null;
  let tapped = false;
  let made = 0;
  const subscription = (endpoint: string) => ({ toJSON: () => ({ endpoint, keys: KEYS }), unsubscribe: async () => { current = null; return true; } });
  const pushManager = {
    getSubscription: async () => current && subscription(current.endpoint),
    subscribe: async () => {
      // WebKit subscribes only in a tap; Chrome does with the permission granted.
      if (!subscribeWithoutTap && !tapped) throw new DOMException("A user gesture is required.", "NotAllowedError");
      current = { endpoint: `https://push.example.test/send/${++made}` };
      return subscription(current.endpoint);
    },
  };
  requestPermission.mockImplementation(async () => { tapped = true; return "granted"; });
  const originalWorker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { addEventListener: () => undefined, removeEventListener: () => undefined, register: async () => { throw new Error("Unavailable in jsdom"); }, getRegistration: async () => ({ active: {}, pushManager }) } });
  onTestFinished(() => { vi.unstubAllGlobals(); if (originalWorker) Object.defineProperty(navigator, "serviceWorker", originalWorker); else delete (navigator as { serviceWorker?: unknown }).serviceWorker; });

  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Waiting session" }] }] });
  const environment = world.environment("desk");
  const origin = new URL(environment.wire.link).origin;
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url: string, init?: Parameters<typeof world.fetch>[1]) => world.fetch(url.replace(location.origin, origin), init),
    webSocket: (...args: Parameters<typeof world.webSocket>) => world.webSocket(args[0].replace(location.origin.replace(/^http/, "ws"), origin.replace(/^http/, "ws")), args[1]),
  };
  const runtime = createRuntime(platform);
  const own = () => runtime.connections.list.read().find(record => record.environmentId === environment.environmentId)?.clientSessionId ?? null;

  // The environment's registrations: each owned by the client session that set it; a revoked client session's go with it.
  const targets = new Map<string, { readonly target: AttentionTargetInput; readonly owner: string | null }>();
  let sequence = 0;
  const accepted = (id: string) => ({ result: { receipt: { status: "accepted" as const, sequence: ++sequence, changed: true }, result: { id } } });
  environment.wire.answer("attention.push.key", () => ({ result: { publicKey: "public-key-for-tests" } }));
  environment.wire.answer("attention.targets.set", params => { const target = params["target"] as AttentionTargetInput; targets.set(target.id, { target, owner: own() }); return accepted(target.id); });
  environment.wire.answer("attention.targets.remove", params => { targets.delete(String(params["id"])); return accepted(String(params["id"])); });
  environment.wire.answer("attention.targets.list", () => ({ result: { targets: [...targets.values()].filter(({ owner }) => owner === own()).map(({ target: { configuration, ...status } }) => { void configuration; return { ...status, global: false, state: "ready" as const, failure: null }; }) } }));
  const revokeOld = (previous: string) => { for (const [id, { owner }] of targets) if (owner === previous) targets.delete(id); };

  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false);
  const code = new URL(environment.wire.link).hash.slice(1);
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { address: location.origin, code } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  await screen.findByRole("note", { name: "Limited access" });
  const user = userEvent.setup();

  return {
    user, targets, own, requestPermission,
    /** Settings → Attention → Enable push, as the docs tell the owner after pairing the phone. */
    enablePush: async () => {
      await user.click(screen.getByRole("button", { name: "Settings" }));
      await user.click(await screen.findByRole("button", { name: "Attention settings" }));
      await user.click(await screen.findByRole("button", { name: "Enable push" }));
      await screen.findByText("Push enabled for this client.");
    },
    disablePush: async () => {
      await user.click(screen.getByRole("button", { name: "Disable push" }));
      await screen.findByText("Push disabled for this client.");
    },
    closeSettings: async () => {
      await user.click(screen.getByRole("button", { name: "Close attention settings" }));
      await user.click(await screen.findByRole("button", { name: "Close Settings" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
    },
    /** Give this phone full access: the same in-place re-pair the form asks of the runtime, with a full-access code. */
    giveFullAccess: async () => {
      const previous = own();
      environment.autoAccept(false);
      const before = environment.wire.opened();
      const pairing = runtime.connections.add({ address: location.origin, code }, { rePair: environment.environmentId, fullAccess: true });
      await waitFor(() => expect(environment.wire.opened()).toBeGreaterThan(before));
      await act(async () => { await environment.accept({ scopes: [...SCOPES], ceiling: "bypassPermissions" }); });
      await act(async () => { expect((await pairing).status).toBe("paired"); });
      if (previous !== null) revokeOld(previous);
      expect(own()).not.toBe(previous);
    },
    /** The browser lost its subscription, and the tap that enabled push is long past. */
    dropSubscription: () => { current = null; tapped = false; },
  };
};

const pushOf = (targets: Map<string, { readonly target: AttentionTargetInput; readonly owner: string | null }>, owner: string | null) =>
  [...targets.values()].filter(row => row.owner === owner && row.target.transport === "push").map(row => row.target);

it("carries the phone's push registration over to its new client session when it is given full access", async () => {
  const phone = await phoneOnThisOrigin();
  await phone.enablePush();
  const [enabled] = pushOf(phone.targets, phone.own());
  expect(enabled).toBeDefined();
  await phone.closeSettings();

  await phone.giveFullAccess();

  await waitFor(() => expect(pushOf(phone.targets, phone.own())).toHaveLength(1));
  const [carried] = pushOf(phone.targets, phone.own());
  expect(carried).toMatchObject({ id: `push-${phone.own()}`, label: enabled?.label, enabled: true, configuration: enabled?.configuration });
  expect(screen.queryByRole("status", { name: "Push is off" })).toBeNull();
});

it("says push is off with Enable push right there when the browser cannot subscribe again without a tap", async () => {
  const phone = await phoneOnThisOrigin({ subscribeWithoutTap: false });
  await phone.enablePush();
  await phone.closeSettings();
  phone.dropSubscription();

  await phone.giveFullAccess();

  const notice = await screen.findByRole("status", { name: "Push is off" });
  expect(notice.textContent).toContain("Pairing this client again turned off its push notifications.");
  expect(pushOf(phone.targets, phone.own())).toEqual([]);
  await phone.user.click(within(notice).getByRole("button", { name: "Enable push" }));
  await waitFor(() => expect(pushOf(phone.targets, phone.own())).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("status", { name: "Push is off" })).toBeNull());
});

it("leaves push off after a re-pair when the owner had disabled it", async () => {
  const phone = await phoneOnThisOrigin();
  await phone.enablePush();
  await phone.disablePush();
  await phone.closeSettings();

  await phone.giveFullAccess();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  expect(pushOf(phone.targets, phone.own())).toEqual([]);
  expect(screen.queryByRole("status", { name: "Push is off" })).toBeNull();
});
