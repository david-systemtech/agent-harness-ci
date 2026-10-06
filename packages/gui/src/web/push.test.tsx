import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PushController, PushControls, pushTargetLabel, type PushBrowser } from "./push.js";

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { auth: "auth-for-tests", p256dh: "key-for-tests" } };
const setup = (permission: NotificationPermission = "default") => {
  const actions: string[] = [];
  const browser: PushBrowser = { permission: () => permission, requestPermission: async () => { actions.push("permission"); return permission === "denied" ? "denied" : "granted"; }, subscription: async () => null, subscribe: async () => { actions.push("subscribe"); return subscription; }, unsubscribe: async () => { actions.push("unsubscribe"); } };
  const controller = new PushController({ secure: true, supported: true, ios: false, standalone: false }, browser, {
    key: async () => "public-key-for-tests", registered: async () => false, set: async () => { actions.push("register"); }, remove: async () => { actions.push("remove"); }, test: async () => { actions.push("test"); return "sent"; },
  });
  return { controller, actions };
};
it("permission is requested only on Enable, then Test and Disable explicitly manage the registration", async () => {
  const { controller, actions } = setup();
  render(<PushControls controller={controller} fallback={[]} />);
  expect(actions).toEqual([]);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Enable push" }));
  expect(actions).toEqual(["permission", "subscribe", "register"]);
  await user.click(screen.getByRole("button", { name: "Test push" }));
  expect(await screen.findByText("Test notification sent. Check your notifications." )).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Disable push" }));
  expect(actions).toEqual(["permission", "subscribe", "register", "test", "remove", "unsubscribe"]);
});
it.each([false, true])("replaces a retired browser subscription before enabling push again (cleanup initially fails: %s)", async cleanupFails => {
  let current: typeof subscription | null = subscription;
  const replacement = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/replacement" };
  const registered: string[] = [];
  let attempts = 0;
  let registration = true;
  const browser: PushBrowser = { permission: () => "granted", requestPermission: async () => "granted", subscription: async () => current, subscribe: async () => { current = replacement; return current; }, unsubscribe: async () => { if (++attempts === 1 && cleanupFails) throw new Error("Browser temporarily unavailable"); current = null; } };
  const controller = new PushController({ secure: true, supported: true, ios: false, standalone: false }, browser, { key: async () => "key", registered: async () => registration, set: async value => { registered.push(value.endpoint); registration = true; }, remove: async () => undefined, test: async () => { registration = false; return "retire"; } });
  await controller.enable();
  await controller.test();
  expect(controller.read().status).toBe("disabled");
  await controller.enable();
  expect(registered).toEqual([subscription.endpoint, replacement.endpoint]);
});
it("recovers a retired subscription after failed cleanup and controller recreation", async () => {
  let current: typeof subscription | null = subscription;
  let registered = true;
  let attempts = 0;
  const replacement = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/replacement" };
  const endpoints: string[] = [];
  const browser: PushBrowser = { permission: () => "granted", requestPermission: async () => "granted", subscription: async () => current, subscribe: async () => { current = replacement; return current; }, unsubscribe: async () => { if (++attempts === 1) throw new Error("Browser temporarily unavailable"); current = null; } };
  const actions = { key: async () => "key", registered: async () => registered, set: async (value: typeof subscription) => { endpoints.push(value.endpoint); registered = true; }, remove: async () => undefined, test: async () => { registered = false; return "retire" as const; } };
  const features = { secure: true, supported: true, ios: false, standalone: false };
  const original = new PushController(features, browser, actions);
  await original.enable();
  await original.test();
  const reopened = new PushController(features, browser, actions);
  await reopened.enable();
  expect(endpoints).toEqual([subscription.endpoint, replacement.endpoint]);
  expect(reopened.read().status).toBe("ready");
});
it("preserves a browser subscription replaced while Test is pending", async () => {
  let current: typeof subscription | null = subscription;
  const replacement = { ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/replacement" };
  let finish!: (status: "retire") => void;
  let start!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const pending = new Promise<"retire">(resolve => { finish = resolve; });
  const registered: string[] = [];
  const subscribe = vi.fn(async () => subscription);
  const browser: PushBrowser = { permission: () => "granted", requestPermission: async () => "granted", subscription: async () => current, subscribe, unsubscribe: async (expected?: typeof subscription) => { if (!expected || current?.endpoint === expected.endpoint) current = null; } };
  const controller = new PushController({ secure: true, supported: true, ios: false, standalone: false }, browser, { key: async () => "key", registered: async () => true, set: async value => { registered.push(value.endpoint); }, remove: async () => undefined, test: () => { start(); return pending; } });
  await controller.enable();
  const testing = controller.test();
  await started;
  current = replacement;
  finish("retire");
  await testing;
  await controller.enable();
  expect(registered).toEqual([subscription.endpoint, replacement.endpoint]);
  expect(subscribe).not.toHaveBeenCalled();
});
it("denial explains browser settings, Home Screen installation and configured fallback status", async () => {
  const { controller, actions } = setup("denied");
  render(<PushControls controller={controller} fallback={[{ id: "fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "ready", failure: null }]} />);
  expect(screen.getByText(/Permission was refused/)).toBeDefined();
  expect(screen.getByText(/fallback · ready/)).toBeDefined();
  expect(screen.getByText(/iOS.*16.4.*Home Screen/)).toBeDefined();
  expect(actions).toEqual([]);
});
it("installed iOS and HTTPS requirements are explained without a permission request", async () => {
  const permission = vi.fn(async () => "granted" as const);
  const controller = new PushController({ secure: true, supported: true, ios: true, standalone: false }, { permission: () => "default", requestPermission: permission, subscription: async () => null, subscribe: async () => subscription, unsubscribe: async () => undefined }, { key: async () => "key", registered: async () => true, set: async () => undefined, remove: async () => undefined, test: async () => "sent" });
  render(<PushControls controller={controller} fallback={[]} />);
  expect(screen.getByText(/Add this client to your Home Screen/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Enable push" })).toBeNull();
  expect(permission).not.toHaveBeenCalled();
});

it("chooses an enabled global fallback even when push APIs are unavailable", async () => {
  const deniedBrowser = { permission: () => "default" as const, requestPermission: async () => "denied" as const, subscription: async () => null, subscribe: async () => { throw new Error("Unavailable"); }, unsubscribe: async () => { throw new Error("Unavailable"); } };
  const controller = new PushController({ secure: false, supported: false, ios: false, standalone: false }, deniedBrowser, { key: async () => "key", registered: async () => true, set: async () => undefined, remove: async () => undefined, test: async () => "retry" });
  render(<PushControls controller={controller} fallback={[{ id: "fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "ready", failure: null }]} onFallback={() => { void controller.useFallback(); }} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Use fallback" }));
  expect(await screen.findByText(/Using the configured webhook fallback/)).toBeDefined();
});

it.each([
  ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
  ["Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36", "Samsung Internet on Android"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.0.0 Mobile/15E148 Safari/604.1", "Chrome on iPhone"],
  ["Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1", "Safari on iPad"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0", "Edge on Windows"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 15.6; rv:150.0) Gecko/20100101 Firefox/150.0", "Firefox on Mac"],
  ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36", "Chrome on Linux"],
  ["", "A browser"],
])("labels a push registration by its browser and when it was enabled, never by its id (%#)", (userAgent, browser) => {
  expect(pushTargetLabel(userAgent, new Date(2026, 9, 6, 13, 4))).toBe(`${browser}, enabled 6 Oct, 13:04`);
});
