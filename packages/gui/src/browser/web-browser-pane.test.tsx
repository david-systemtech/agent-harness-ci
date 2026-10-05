import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { startWebWorld } from "../../gallery/world.js";

it("opens a browser surface without a shell, sets the next run's driver and opens a page externally", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Receipts" }] }] }, {});
  const env = world.world.environment("desk");
  env.wire.answer("browser.status", () => ({ result: { headless: { allowRuns: true, availability: { available: true, source: { kind: "endpoint", endpoint: "http://localhost:9222" } }, liveContexts: 0 }, listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false } }));
  env.wire.answer("sessions.setBrowser", params => {
    env.emit(env.sessionId(), "session.browser.set", { browser: params["browser"], chosenBy: "person" }, { fields: { browser: { kind: "headless" } } });
    return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: {} } };
  });
  const app = render(<App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={false} web={{ platform: world.platform, route: { session: { environmentId: env.environmentId, sessionId: env.sessionId() } } }} />);
  onTestFinished(async () => { app.unmount(); await world.runtime.close(); await world.presentation.close(); vi.restoreAllMocks(); });
  const user = userEvent.setup();
  const trigger = await screen.findByRole("button", { name: "Environment browser" });
  // Share the existing control row; another footer clips decisions above the keyboard.
  expect(within(screen.getByRole("region", { name: "Status line" })).getByRole("button", { name: "Environment browser" })).toBe(trigger);
  await user.click(screen.getByRole("button", { name: "More" }));
  const browser = within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Browser" });
  expect(browser.getAttribute("aria-disabled")).toBe("true");
  expect(browser.textContent).not.toContain("shell.webView");
  expect(browser.textContent).toContain("Environment browser");
  expect(browser.textContent).toContain("Open page");
  await user.keyboard("{Escape}");
  await user.click(trigger);
  const dialog = within(screen.getByRole("dialog", { name: "Environment browser" }));
  await user.selectOptions(await dialog.findByRole("combobox", { name: "Browser for the next run" }), "1");
  await waitFor(() => expect(env.requests("sessions.setBrowser").at(-1)?.params).toMatchObject({ sessionId: env.sessionId(), browser: { kind: "headless" } }));
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await user.type(dialog.getByRole("textbox", { name: "Page address" }), "example.org/receipts");
  await user.click(dialog.getByRole("button", { name: "Open page" }));
  expect(open).toHaveBeenCalledWith("https://example.org/receipts", "_blank", "noopener,noreferrer");
  expect(document.querySelector("iframe")).toBeNull();
  expect(world.platform.shell).toBeUndefined();
  await user.click(dialog.getByRole("button", { name: "Close browser" }));
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("shows unavailable driver reasons and deliberate re-pair guidance on a read-only phone", async () => {
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", scopes: ["read"], sessions: [{ title: "Receipts" }] }] }, {});
  const env = world.world.environment("desk");
  env.wire.answer("browser.status", () => ({ result: {
    listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
    headless: { allowRuns: true, availability: { available: false, reason: "No configured Chromium executable." }, liveContexts: 0 },
  } }));
  const app = render(<App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={false} web={{ platform: world.platform, route: { session: { environmentId: env.environmentId, sessionId: env.sessionId() } } }} />);
  onTestFinished(async () => { app.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Environment browser" }));
  const dialog = within(screen.getByRole("dialog", { name: "Environment browser" }));
  await dialog.findByText(/No configured Chromium executable.*Ask an environment administrator/);
  expect(dialog.getByRole("combobox", { name: "Browser for the next run" }).hasAttribute("disabled")).toBe(true);
  expect(dialog.getByRole("option", { name: "Headless browser" }).hasAttribute("disabled")).toBe(true);
  expect(dialog.getByText(/Re-pair deliberately with a sessions:write grant/)).toBeDefined();
  expect(dialog.getByText(/A phone cannot host the desktop Chrome extension or a local relay environment/)).toBeDefined();
  expect(env.requests("sessions.setBrowser")).toHaveLength(0);
});


it("preserves a saved unavailable dock selection until the person explicitly chooses Default", async () => {
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Receipts" }] }] }, {});
  const env = world.world.environment("desk");
  const app = render(<App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={false} web={{ platform: world.platform, route: { session: { environmentId: env.environmentId, sessionId: env.sessionId() } } }} />);
  onTestFinished(async () => { app.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Environment browser" }));
  env.emit(env.sessionId(), "session.browser.set", { browser: { kind: "dock" }, chosenBy: "person" }, { fields: { browser: { kind: "dock" } } });
  const dialog = within(screen.getByRole("dialog", { name: "Environment browser" }));
  const picker = dialog.getByRole("combobox", { name: "Browser for the next run" });
  await waitFor(() => expect(within(picker).getByRole("option", { name: "Browser dock (unavailable)", selected: true }).hasAttribute("disabled")).toBe(true));
  expect(dialog.getByText(/Choose Default or an available environment browser/)).toBeDefined();
  expect(env.requests("sessions.setBrowser")).toHaveLength(0);
  env.wire.answer("sessions.setBrowser", () => {
    env.emit(env.sessionId(), "session.browser.set", { browser: null, chosenBy: "person" }, { fields: { browser: null } });
    return { result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: {} } };
  });
  await user.selectOptions(picker, "0");
  await waitFor(() => expect(env.requests("sessions.setBrowser").at(-1)?.params).toMatchObject({ sessionId: env.sessionId(), browser: null }));
  await waitFor(() => expect(within(picker).getByRole("option", { name: "Default", selected: true })).toBeDefined());
});
