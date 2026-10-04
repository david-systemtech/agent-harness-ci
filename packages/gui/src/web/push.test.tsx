import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PushController, PushControls, type PushBrowser } from "./push.js";

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: { auth: "auth-for-tests", p256dh: "key-for-tests" } };
const setup = (permission: NotificationPermission = "default") => {
  const actions: string[] = [];
  const browser: PushBrowser = { permission: () => permission, requestPermission: async () => { actions.push("permission"); return permission === "denied" ? "denied" : "granted"; }, subscription: async () => null, subscribe: async () => { actions.push("subscribe"); return subscription; }, unsubscribe: async () => { actions.push("unsubscribe"); } };
  const controller = new PushController({ secure: true, supported: true, ios: false, standalone: false }, browser, {
    key: async () => "public-key-for-tests", set: async () => { actions.push("register"); }, remove: async () => { actions.push("remove"); }, test: async () => { actions.push("test"); return "sent"; },
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
  const controller = new PushController({ secure: true, supported: true, ios: true, standalone: false }, { permission: () => "default", requestPermission: permission, subscription: async () => null, subscribe: async () => subscription, unsubscribe: async () => undefined }, { key: async () => "key", set: async () => undefined, remove: async () => undefined, test: async () => "sent" });
  render(<PushControls controller={controller} fallback={[]} />);
  expect(screen.getByText(/Add this client to your Home Screen/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Enable push" })).toBeNull();
  expect(permission).not.toHaveBeenCalled();
});

it("chooses an enabled global fallback even when push APIs are unavailable", async () => {
  const deniedBrowser = { permission: () => "default" as const, requestPermission: async () => "denied" as const, subscription: async () => null, subscribe: async () => { throw new Error("Unavailable"); }, unsubscribe: async () => { throw new Error("Unavailable"); } };
  const controller = new PushController({ secure: false, supported: false, ios: false, standalone: false }, deniedBrowser, { key: async () => "key", set: async () => undefined, remove: async () => undefined, test: async () => "retry" });
  render(<PushControls controller={controller} fallback={[{ id: "fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "ready", failure: null }]} onFallback={() => { void controller.useFallback(); }} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Use fallback" }));
  expect(await screen.findByText(/Using the configured webhook fallback/)).toBeDefined();
});
