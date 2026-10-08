import { render, screen, waitFor } from "@testing-library/react";
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
    { id: "phone-route", transport: "webhook", webhookEndpoint: "phone-attention", enabled: true, completion: false, global: true, state: "ready", failure: null },
    { id: "push-client-session-1", label: "Chrome on Android, enabled 6 Oct, 13:04", transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null },
  ]} admin busy={false} onConfigure={vi.fn()} onRemove={vi.fn()} onRefresh={vi.fn()} onAddRoute={add} onTest={test} />);
  expect(screen.getByText(/Signed webhook · Global route/)).toBeDefined();
  expect(screen.getAllByRole("button", { name: /^Test / }).map(button => button.getAttribute("aria-label"))).toEqual(["Test phone-route"]);
  await user.click(screen.getByRole("button", { name: "Test phone-route" }));
  expect(test).toHaveBeenCalledWith("phone-route", "phone-attention");
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

/** The web client paired with `desk` under an admin grant, its Attention sheet open; the environment holds a routine's endpoint, `routine-hook`. */
const openAdminSheet = async () => {
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
  const endpoints = new Set(["routine-hook"]);
  desk.wire.answer("attention.targets.list", () => ({ result: { targets: [...routes] } }));
  desk.wire.answer("routines.endpoints.list", () => ({ result: { endpoints: [...endpoints].map(name => ({ name, url: "https://receiver.example/routines", secretKind: "pasted", lastResult: null })) } }));
  desk.wire.answer("routines.endpoints.set", params => { endpoints.add(String(params["name"])); return accepted({ endpoint: { name: params["name"], url: params["url"], secretKind: "pasted", lastResult: null } }); });
  desk.wire.answer("routines.endpoints.remove", params => { endpoints.delete(String(params["name"])); return accepted({ name: params["name"] }); });
  desk.wire.answer("attention.routes.set", params => {
    const target = params["target"] as { id: string; enabled: boolean; completion: boolean; configuration: { endpoint: string } };
    routes.push({ id: target.id, transport: "webhook", webhookEndpoint: target.configuration.endpoint, enabled: target.enabled, completion: target.completion, global: true, state: target.enabled ? "ready" : "disabled", failure: null });
    return accepted({ id: target.id });
  });
  desk.wire.answer("attention.routes.configure", params => {
    const index = routes.findIndex(route => route.id === params["id"]);
    routes[index] = { ...routes[index]!, enabled: params["enabled"] === true, completion: params["completion"] === true, state: params["enabled"] === true ? "ready" : "disabled" };
    return accepted({ id: params["id"] });
  });
  desk.wire.answer("attention.routes.remove", params => { routes.splice(routes.findIndex(route => route.id === params["id"]), 1); return accepted({ id: params["id"] }); });
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
  const fill = async (name: string) => {
    await user.clear(screen.getByLabelText("Name")); await user.type(screen.getByLabelText("Name"), name);
    await user.clear(screen.getByLabelText("Receiver URL")); await user.type(screen.getByLabelText("Receiver URL"), "https://receiver.example/attention");
    await user.clear(screen.getByLabelText("Signing secret")); await user.type(screen.getByLabelText("Signing secret"), "token-for-tests");
    await user.click(screen.getByRole("button", { name: "Add route" }));
  };
  const routeSet = (params: Record<string, unknown>) => {
    const target = params["target"] as { id: string; enabled: boolean; completion: boolean; configuration: { endpoint: string } };
    routes.push({ id: target.id, transport: "webhook", webhookEndpoint: target.configuration.endpoint, enabled: target.enabled, completion: target.completion, global: true, state: target.enabled ? "ready" : "disabled", failure: null });
  };
  return { desk, endpoints, routes, routeSet, user, fill };
};
/** A delivery target's card text, found by its heading. */
const card = (name: string) => screen.getByRole("heading", { name }).closest("article")?.textContent;
/** The status line written beside the button just tapped: its next sibling, or the next sibling of the row of buttons it sits in. */
const besideButton = (button: HTMLElement) => {
  const after = button.nextElementSibling ?? button.parentElement?.nextElementSibling;
  return after?.getAttribute("role") === "status" ? after.textContent : null;
};
const accepted = (result: Record<string, unknown>) => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result } });

it("an admin client makes the named endpoint and its global route from Attention settings, then tests it, without replacing another endpoint", async () => {
  const { desk, user, fill } = await openAdminSheet();
  expect(document.body.textContent).not.toMatch(/ask an environment admin/i);
  await fill("routine-hook");
  expect(await screen.findByText(/An endpoint named routine-hook already exists/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set")).toEqual([]);
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route phone-attention saved/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set").map(request => request.params)).toEqual([expect.objectContaining({ name: "phone-attention", url: "https://receiver.example/attention", secret: { kind: "pasted", secret: "token-for-tests" } })]);
  // Saved disabled, so nothing is delivered to it before its endpoint exists, then enabled once the endpoint is saved.
  expect(desk.requests("attention.routes.set").map(request => request.params)).toEqual([expect.objectContaining({ target: { id: "phone-attention", transport: "webhook", enabled: false, completion: false, configuration: { endpoint: "phone-attention" } } })]);
  expect(desk.requests("attention.routes.configure").map(request => request.params)).toEqual([expect.objectContaining({ id: "phone-attention", enabled: true, completion: false })]);
  await waitFor(() => expect(card("phone-attention")).toMatch(/Signed webhook · Global route · ready/));
  await user.click(screen.getByRole("button", { name: "Test phone-attention" }));
  expect(await screen.findByText("phone-attention answered 204 in 120 ms.")).toBeDefined();
  expect(desk.requests("routines.endpoints.test").map(request => request.params)).toEqual([{ name: "phone-attention" }]);
});

it("writes a route's outcome beside the Add route button and a test's on its route row, where the admin tapped, and scrolls each into view", async () => {
  const { desk, routes, user, fill } = await openAdminSheet();
  /** A row another client adds after the outcome was written, read by a refresh this sheet's action did not start: it leaves the scroll alone. */
  const elsewhere = async (id: string) => {
    const before = scrolled.length;
    routes.push({ id, label: id, transport: "push", enabled: true, completion: false, global: false, state: "ready", failure: null });
    await user.click(screen.getByRole("button", { name: "Refresh status" }));
    await screen.findByRole("heading", { name: id });
    expect(scrolled.length).toBe(before);
  };
  // Each scroll is recorded with the rows on screen when it ran: a row rendered above the line after it scrolled pushes it out of view.
  const scrolled: { readonly textContent: string | null; readonly rows: readonly (string | null)[] }[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push({ textContent: this.textContent, rows: [...document.querySelectorAll("[data-attention-settings] article h3")].map(heading => heading.textContent) });
  });
  const addRoute = screen.getByRole("button", { name: "Add route" });
  await fill("routine-hook");
  await waitFor(() => expect(besideButton(addRoute)).toBe("An endpoint named routine-hook already exists on this environment. Choose another name."));
  await fill("phone-attention");
  await waitFor(() => expect(besideButton(addRoute)).toBe("Webhook route phone-attention saved. Test it to check that its receiver takes the signed post."));
  await waitFor(() => expect(scrolled.at(-1)).toEqual({ textContent: expect.stringMatching(/^Webhook route phone-attention saved/), rows: expect.arrayContaining(["phone-attention"]) }));
  await elsewhere("other-client-1");
  // Nothing the admin did is written above the panes, out of view of the button tapped.
  expect(screen.getAllByRole("status").filter(line => !line.closest("form, article"))).toEqual([]);
  const test = await screen.findByRole("button", { name: "Test phone-attention" });
  await user.click(test);
  await waitFor(() => expect(besideButton(screen.getByRole("button", { name: "Test phone-attention" }))).toBe("phone-attention answered 204 in 120 ms."));
  expect(scrolled.at(-1)?.textContent).toBe("phone-attention answered 204 in 120 ms.");
  await elsewhere("other-client-2");
  expect(besideButton(addRoute)).toBeNull();
  desk.wire.answer("routines.endpoints.test", () => ({ result: { status: null, durationMs: 3000, error: "The receiver did not answer in time." } }));
  await user.click(screen.getByRole("button", { name: "Test phone-attention" }));
  await waitFor(() => expect(besideButton(screen.getByRole("button", { name: "Test phone-attention" }))).toBe("phone-attention did not take the test: The receiver did not answer in time."));
  expect(screen.getAllByRole("status").filter(line => !line.closest("form, article"))).toEqual([]);
});

it("writes a refused route's reason, and a route saved but not enabled, beside the Add route button", async () => {
  const { desk, fill } = await openAdminSheet();
  const addRoute = screen.getByRole("button", { name: "Add route" });
  desk.wire.answer("routines.endpoints.set", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "invalid_params", error: { code: "invalid_params", message: "Use https, or http only to a private address.", data: {} } } } }));
  await fill("phone-attention");
  await waitFor(() => expect(besideButton(addRoute)).toBe("Webhook route not saved: Use https, or http only to a private address."));
  desk.wire.answer("routines.endpoints.set", params => accepted({ endpoint: { name: params["name"], url: params["url"], secretKind: "pasted", lastResult: null } }));
  desk.wire.answer("attention.routes.configure", () => ({ error: { code: "unavailable", message: "The environment is busy.", data: {} } }));
  await fill("phone-attention");
  await waitFor(() => expect(besideButton(addRoute)).toBe("Webhook route phone-attention saved but not enabled: The environment is busy. Enable it on its row above."));
  expect(screen.getAllByRole("status").filter(line => !line.closest("form, article"))).toEqual([]);
});

it("saves the route before its endpoint, so a refused route leaves no endpoint or secret behind", async () => {
  const { desk, endpoints, fill } = await openAdminSheet();
  desk.wire.answer("attention.routes.set", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "forbidden", error: { code: "forbidden", message: "This target belongs to another registration.", data: {} } } } }));
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route not saved: This target belongs/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set")).toEqual([]);
  expect(endpoints.has("phone-attention")).toBe(false);
});

it("never replaces an endpoint no listed route names, even one only another client's own target uses", async () => {
  // Another client's own target delivers to `client-hook`; this client's target list cannot show it.
  const { desk, endpoints, fill } = await openAdminSheet();
  endpoints.add("client-hook");
  await fill("client-hook");
  expect(await screen.findByText(/An endpoint named client-hook already exists/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set")).toEqual([]);
  expect(desk.requests("attention.routes.set")).toEqual([]);
});

it("removes the route it just saved when the environment refuses the endpoint, so no enabled route names a missing endpoint", async () => {
  const { desk, routes, fill } = await openAdminSheet();
  desk.wire.answer("routines.endpoints.set", () => ({ result: { receipt: { status: "rejected", sequence: 2, changed: false, reason: "invalid_params", error: { code: "invalid_params", message: "Use https, or http only to a private address.", data: {} } } } }));
  await fill("phone-attention");
  expect(await screen.findByText("Webhook route not saved: Use https, or http only to a private address.")).toBeDefined();
  expect(desk.requests("attention.routes.remove").map(request => request.params)).toEqual([expect.objectContaining({ id: "phone-attention" })]);
  expect(desk.requests("attention.routes.configure")).toEqual([]);
  expect(routes).toEqual([]);
});

it("leaves a route it could not remove disabled, and adding it again under the same name finishes it after the sheet was closed", async () => {
  const { desk, routes, fill } = await openAdminSheet();
  desk.wire.answer("routines.endpoints.set", () => ({ error: { code: "unavailable", message: "The environment is busy.", data: {} } }));
  desk.wire.answer("attention.routes.remove", () => ({ error: { code: "unavailable", message: "The environment is busy.", data: {} } }));
  await fill("phone-attention");
  expect(await screen.findByText("Webhook route not saved: The environment is busy.")).toBeDefined();
  expect(routes.map(route => [route.id, route.enabled])).toEqual([["phone-attention", false]]);
  await waitFor(() => expect(card("phone-attention")).toMatch(/Signed webhook · Global route · disabled/));
  await userEvent.click(screen.getByRole("button", { name: "Close attention settings" }));
  await userEvent.click(await screen.findByRole("button", { name: "Attention settings" }));
  await screen.findByRole("form", { name: "Add a webhook route" });
  desk.wire.answer("routines.endpoints.set", params => accepted({ endpoint: { name: params["name"], url: params["url"], secretKind: "pasted", lastResult: null } }));
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route phone-attention saved/)).toBeDefined();
  expect(desk.requests("attention.routes.set")).toHaveLength(1);
  expect(routes.map(route => [route.id, route.enabled])).toEqual([["phone-attention", true]]);
});

it("goes on to the endpoint when the route's answer is lost but the route was applied", async () => {
  const { desk, routeSet, fill } = await openAdminSheet();
  desk.wire.answer("attention.routes.set", params => { routeSet(params); return { error: { code: "unavailable", message: "The answer was lost.", data: {} } }; });
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route phone-attention saved/)).toBeDefined();
  expect(desk.requests("routines.endpoints.set").map(request => request.params)).toEqual([expect.objectContaining({ name: "phone-attention" })]);
  expect(desk.requests("routines.endpoints.remove")).toEqual([]);
});

it("enables the route when the endpoint's answer is lost but the endpoint was saved", async () => {
  const { desk, endpoints, routes, fill } = await openAdminSheet();
  desk.wire.answer("routines.endpoints.set", params => { endpoints.add(String(params["name"])); return { error: { code: "unavailable", message: "The answer was lost.", data: {} } }; });
  await fill("phone-attention");
  expect(await screen.findByText(/Webhook route phone-attention saved/)).toBeDefined();
  expect(desk.requests("attention.routes.remove")).toEqual([]);
  expect(routes.map(route => [route.id, route.enabled])).toEqual([["phone-attention", true]]);
});
