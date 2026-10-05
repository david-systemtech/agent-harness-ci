import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { chooseHeaderAction, openHeaderMenu } from "../test/header-actions.js";
import { renderApp } from "../test/harness.js";
import { userEvent } from "@testing-library/user-event";
import { startWebWorld } from "../gallery/world.js";
import { App } from "./app.js";

describe.each([false, true])("desktop zoom controls (macOS=%s)", (macOS) => {
  it("lists fixed native zoom keys in Keyboard shortcuts and protects them from remapping", async () => {
    const app = await renderApp({ environments: [] }, { macOS });
    await app.user.click(screen.getByRole("button", { name: "Settings" }));
    await app.user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Keyboard shortcuts" }));
    const pane = within(screen.getByRole("region", { name: "Keyboard shortcuts" }));
    for (const label of ["Zoom in", "Zoom out", "Actual size"]) {
      const row = within(pane.getByRole("row", { name: label }));
      expect(row.queryByRole("button")).toBeNull();
      expect(row.getByText(/Desktop window/)).toBeDefined();
    }
    const row = within(pane.getByRole("row", { name: "Find in the conversation" }));
    const mod = macOS ? "Meta" : "Control";
    for (const key of ["0", "{Shift>}0{/Shift}", "{Shift>}-{/Shift}"]) {
      await app.user.click(row.getByRole("button", { name: macOS ? "⌘F" : "Ctrl+F" }));
      await app.user.keyboard(`{${mod}>}${key}{/${mod}}`);
      expect(row.getByText(/Not saved: .* controls zoom/)).toBeDefined();
      expect(app.presentation.values.read().keyRemaps).toEqual({});
    }
  });

  it("offers zoom and actual size without a session, with platform keys, through the desktop shell", async () => {
    const app = await renderApp({ environments: [] }, { macOS });
    const menu = within(await openHeaderMenu(app));
    expect(menu.getByRole("menuitem", { name: "Zoom in" }).textContent).toContain(macOS ? "⌘+" : "Ctrl++");
    expect(menu.getByRole("menuitem", { name: "Zoom out" }).textContent).toContain(macOS ? "⌘-" : "Ctrl+-");
    expect(menu.getByRole("menuitem", { name: "Actual size" }).textContent).toContain(macOS ? "⌘0" : "Ctrl+0");
    for (const [label, action] of [["Zoom in", "in"], ["Zoom out", "out"], ["Actual size", "reset"]] as const) {
      await chooseHeaderAction(app, label);
      await waitFor(() => expect(app.shell.calls).toContainEqual(["window.zoom", action]));
    }
  });
});


it("leaves web zoom keys to the browser and names browser controls in shortcut help", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", sessions: [{ title: "Receipts" }] }] }, {});
  const env = world.world.environment("desk");
  const app = render(<App runtime={world.runtime} presentation={world.presentation} clock={world.clock} version={world.version} macOS={false} web={{ platform: world.platform, route: { session: { environmentId: env.environmentId, sessionId: env.sessionId() } } }} />);
  onTestFinished(async () => { app.unmount(); await world.runtime.close(); await world.presentation.close(); vi.restoreAllMocks(); });
  const user = userEvent.setup();
  const header = await screen.findByRole("banner");
  for (const [key, code, shiftKey] of [["+", "Equal", true], ["=", "Equal", false], ["+", "NumpadAdd", false], ["-", "Minus", false], ["0", "Digit0", false]] as const) {
    const event = new KeyboardEvent("keydown", { key, code, shiftKey, ctrlKey: true, bubbles: true, cancelable: true });
    header.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  act(() => within(header).getByRole("button", { name: "More" }).focus());
  await user.keyboard("{Enter}");
  const menu = within(await screen.findByRole("menu"));
  for (const name of ["Zoom in", "Zoom out", "Actual size"]) expect(menu.queryByRole("menuitem", { name })).toBeNull();
  await user.keyboard("{Escape}");
  await user.click(within(header).getByRole("button", { name: "Settings" }));
  await user.click(within(await screen.findByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Keyboard shortcuts" }));
  const row = within(screen.getByRole("row", { name: "Actual size" }));
  expect(row.getByText("Use your browser's zoom controls.")).toBeDefined();
  expect(row.queryByRole("button")).toBeNull();
});
