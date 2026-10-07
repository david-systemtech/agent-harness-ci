import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AttentionTargetStatus } from "@agent-harness/contracts";
import { AttentionSettingsPane } from "./attention-settings.js";

it("shows safe failure status, disables only the selected own target and leaves global controls to admin", async () => {
  const configure = vi.fn();
  render(<AttentionSettingsPane targets={[
    { id: "phone", transport: "push", enabled: true, completion: false, global: false, state: "failed", failure: "Delivery failed. Check the configured transport." },
    { id: "fallback", transport: "webhook", enabled: true, completion: false, global: true, state: "unavailable", failure: null },
  ]} admin={false} busy={false} onConfigure={configure} onRemove={vi.fn()} onRefresh={vi.fn()} onAddRoute={vi.fn()} onTest={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("Delivery failed");
  expect(screen.getByText(/Global routes require admin/)).toBeDefined();
  await userEvent.click(screen.getByRole("button", { name: "Disable Web Push registration" }));
  expect(configure).toHaveBeenCalledWith("phone", false, false, false);
  expect((screen.getByRole("button", { name: "Disable fallback" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/No prompt, transcript/)).toBeDefined();
  expect(screen.queryByRole("form", { name: "Add a webhook route" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Test / })).toBeNull();
});

it("lets an admin add a named signed-webhook route and test a global webhook route by its endpoint", async () => {
  const add = vi.fn(async () => true);
  const test = vi.fn();
  const user = userEvent.setup();
  const view = render(<AttentionSettingsPane targets={[]} admin busy={false} onConfigure={vi.fn()} onRemove={vi.fn()} onRefresh={vi.fn()} onAddRoute={add} onTest={test} />);
  expect(screen.queryByText(/Global routes require admin/)).toBeNull();
  expect(document.body.textContent).not.toMatch(/ask an environment admin/i);
  const form = screen.getByRole("form", { name: "Add a webhook route" });
  await user.type(screen.getByLabelText("Name"), "Phone attention");
  await user.type(screen.getByLabelText("Receiver URL"), "https://receiver.example/attention");
  await user.type(screen.getByLabelText("Signing secret"), "token-for-tests");
  await user.click(screen.getByRole("button", { name: "Add route" }));
  expect(add).not.toHaveBeenCalled();
  expect(form.querySelector("[role=alert]")?.textContent).toMatch(/lower-case letters, digits and hyphens/);
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "phone-attention");
  await user.click(screen.getByRole("button", { name: "Add route" }));
  expect(add).toHaveBeenCalledWith({ name: "phone-attention", url: "https://receiver.example/attention", secret: "token-for-tests" });
  expect((screen.getByLabelText("Signing secret") as HTMLInputElement).value).toBe("");
  expect((screen.getByLabelText("Signing secret") as HTMLInputElement).type).toBe("password");
  view.rerender(<AttentionSettingsPane targets={[
    { id: "phone-attention", transport: "webhook", webhookEndpoint: "phone-attention", enabled: true, completion: false, global: true, state: "ready", failure: null },
    { id: "push-client-session-1", label: "Chrome on Android, enabled 6 Oct, 13:04", transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null },
  ]} admin busy={false} onConfigure={vi.fn()} onRemove={vi.fn()} onRefresh={vi.fn()} onAddRoute={add} onTest={test} />);
  expect(screen.getByText(/Signed webhook · Global route/)).toBeDefined();
  expect(screen.getAllByRole("button", { name: /^Test / }).map(button => button.getAttribute("aria-label"))).toEqual(["Test phone-attention"]);
  await user.click(screen.getByRole("button", { name: "Test phone-attention" }));
  expect(test).toHaveBeenCalledWith("phone-attention");
});

it("keeps the typed route when the environment refuses it", async () => {
  const user = userEvent.setup();
  render(<AttentionSettingsPane targets={[]} admin busy={false} onConfigure={vi.fn()} onRemove={vi.fn()} onRefresh={vi.fn()} onAddRoute={async () => false} onTest={vi.fn()} />);
  await user.type(screen.getByLabelText("Name"), "phone-attention");
  await user.type(screen.getByLabelText("Receiver URL"), "https://receiver.example/attention");
  await user.type(screen.getByLabelText("Signing secret"), "token-for-tests");
  await user.click(screen.getByRole("button", { name: "Add route" }));
  expect((screen.getByLabelText("Receiver URL") as HTMLInputElement).value).toBe("https://receiver.example/attention");
  expect((screen.getByLabelText("Signing secret") as HTMLInputElement).value).toBe("token-for-tests");
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
  ]} admin={false} busy={false} onConfigure={configure} onRemove={remove} onRefresh={vi.fn()} onAddRoute={vi.fn()} onTest={vi.fn()} />);
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

it("an admin client makes the named endpoint and its global route from Attention settings, then tests it, without replacing another endpoint", async () => {
  const { createRuntime } = await import("@agent-harness/client-runtime");
  const { manualClock } = await import("@agent-harness/client-runtime/testing");
  const { scriptedWorld } = await import("@agent-harness/client-runtime/testing/scripted-environment");
  const { browserPlatform } = await import("../platform/browser-platform.js");
  const { openPresentation } = await import("../presentation.js");
  const { App } = await import("../app.js");
  const { IDBFactory } = await import("fake-indexeddb");
  const { onTestFinished } = await import("vitest");
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "admin"], sessions: [] }] });
  const desk = world.environment("desk");
  const routes: AttentionTargetStatus[] = [];
  const accepted = (result: Record<string, unknown>) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result } });
  desk.wire.answer("attention.targets.list", () => ({ result: { targets: [...routes] } }));
  desk.wire.answer("routines.endpoints.list", () => ({ result: { endpoints: [{ name: "routine-hook", url: "https://receiver.example/routines", secretKind: "pasted", lastResult: null }] } }));
  desk.wire.answer("routines.endpoints.set", params => accepted({ endpoint: { name: params["name"], url: params["url"], secretKind: "pasted", lastResult: null } }));
  desk.wire.answer("attention.routes.set", params => {
    const target = params["target"] as { id: string; enabled: boolean; completion: boolean; configuration: { endpoint: string } };
    routes.push({ id: target.id, transport: "webhook", webhookEndpoint: target.configuration.endpoint, enabled: target.enabled, completion: target.completion, global: true, state: "ready", failure: null });
    return accepted({ id: target.id });
  });
  desk.wire.answer("routines.endpoints.test", () => ({ result: { status: 204, durationMs: 120, error: null } }));
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false);
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: desk.wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await user.click(await screen.findByRole("button", { name: "Attention settings" }));
  await screen.findByRole("form", { name: "Add a webhook route" });
  expect(document.body.textContent).not.toMatch(/ask an environment admin/i);
  const fill = async (name: string) => {
    await user.clear(screen.getByLabelText("Name")); await user.type(screen.getByLabelText("Name"), name);
    await user.clear(screen.getByLabelText("Receiver URL")); await user.type(screen.getByLabelText("Receiver URL"), "https://receiver.example/attention");
    await user.clear(screen.getByLabelText("Signing secret")); await user.type(screen.getByLabelText("Signing secret"), "token-for-tests");
    await user.click(screen.getByRole("button", { name: "Add route" }));
  };
  await fill("routine-hook");
  expect(await screen.findByText(/An endpoint named routine-hook already exists/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set")).toEqual([]);
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route phone-attention saved/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set").map(request => request.params)).toEqual([expect.objectContaining({ name: "phone-attention", url: "https://receiver.example/attention", secret: { kind: "pasted", secret: "token-for-tests" } })]);
  expect(desk.requests("attention.routes.set").map(request => request.params)).toEqual([expect.objectContaining({ target: { id: "phone-attention", transport: "webhook", enabled: true, completion: false, configuration: { endpoint: "phone-attention" } } })]);
  expect(await screen.findByText(/Signed webhook · Global route/)).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Test phone-attention" }));
  expect(await screen.findByText("phone-attention answered 204 in 120 ms.")).toBeDefined();
  expect(desk.requests("routines.endpoints.test").map(request => request.params)).toEqual([{ name: "phone-attention" }]);
});
