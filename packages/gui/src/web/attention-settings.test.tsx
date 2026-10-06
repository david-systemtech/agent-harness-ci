import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { AttentionSettingsPane } from "./attention-settings.js";

it("shows safe failure status, disables only the selected own target and leaves global controls to admin", async () => {
  const configure = vi.fn();
  render(<AttentionSettingsPane targets={[
    { id: "phone", transport: "push", enabled: true, completion: false, global: false, state: "failed", failure: "Delivery failed. Check the configured transport." },
    { id: "fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "unavailable", failure: null },
  ]} admin={false} busy={false} onConfigure={configure} onRemove={vi.fn()} onRefresh={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("Delivery failed");
  expect(screen.getByText(/Global routes require admin/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Disable Web Push registration" }));
  expect(configure).toHaveBeenCalledWith("phone", false, false, false);
  expect((screen.getByRole("button", { name: "Disable fallback" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/No prompt, transcript/)).toBeDefined();
});

it("opens the registered attention surface from inside the Settings dialog", async () => {
  const { createRuntime } = await import("@agent-harness/client-runtime");
  const { manualClock } = await import("@agent-harness/client-runtime/testing");
  const { scriptedWorld } = await import("@agent-harness/client-runtime/testing/scripted-environment");
  const { browserPlatform } = await import("../platform/browser-platform.js");
  const { openPresentation } = await import("../presentation.js");
  const { App } = await import("../app.js");
  const { IDBFactory } = await import("fake-indexeddb");
  const { onTestFinished } = await import("vitest");
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read"], sessions: [] }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false);
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: world.environment("desk").wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  const user = userEvent.setup();
  await screen.findByRole("note", { name: "Limited access" });
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const trigger = await screen.findByRole("button", { name: "Attention settings" });
  expect(trigger.closest("[data-settings-dialog]")).not.toBeNull();
  await user.click(trigger);
  expect(await screen.findByRole("heading", { name: "Attention" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Close attention settings" }));
  expect(screen.queryByRole("heading", { name: "Attention" })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("names two push registrations of the same client kind by their readable labels, never their raw ids", async () => {
  const configure = vi.fn();
  const remove = vi.fn();
  render(<AttentionSettingsPane targets={[
    { id: "push-client-session-1", label: "Chrome on Android, enabled 6 Oct, 13:04", transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null },
    { id: "push-client-session-2", label: "Chrome on Android, enabled 2 Oct, 09:15", transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null },
    { id: "push-client-session-3", transport: "push", enabled: false, completion: false, global: false, state: "disabled", failure: null },
  ]} admin={false} busy={false} onConfigure={configure} onRemove={remove} onRefresh={vi.fn()} />);
  expect(screen.getAllByRole("heading", { level: 3 }).map(heading => heading.textContent)).toEqual(["Chrome on Android, enabled 6 Oct, 13:04", "Chrome on Android, enabled 2 Oct, 09:15", "Web Push registration"]);
  expect(document.body.textContent).not.toMatch(/push-client-session/);
  expect(screen.getByRole("heading", { name: "Chrome on Android, enabled 6 Oct, 13:04" }).className).not.toMatch(/break-all/);
  await userEvent.click(screen.getByRole("button", { name: "Disable Chrome on Android, enabled 2 Oct, 09:15" }));
  expect(configure).toHaveBeenCalledWith("push-client-session-2", false, false, false);
  await userEvent.click(screen.getByRole("button", { name: "Remove Chrome on Android, enabled 6 Oct, 13:04" }));
  expect(remove).toHaveBeenCalledWith("push-client-session-1", false);
  await userEvent.click(screen.getByRole("checkbox", { name: "Routine completions for Chrome on Android, enabled 2 Oct, 09:15" }));
  expect(configure).toHaveBeenLastCalledWith("push-client-session-2", true, true, false);
  expect(screen.getByRole("button", { name: "Enable Web Push registration" })).toBeDefined();
});
