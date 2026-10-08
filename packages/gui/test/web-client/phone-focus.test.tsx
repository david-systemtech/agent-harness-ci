import { pairingPreset } from "@agent-harness/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/app.js";
import { startWebWorld } from "../../gallery/world.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["phone", "own-client"] as const)("keeps Tab inside the %s session drawer after Settings and More dismiss", async preset => {
  vi.stubGlobal("innerWidth", 390);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", scopes: pairingPreset(preset).scopes, sessions: [{ title: "Hosted focus fixture" }] }] }, {});
  const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
  close.push(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  const sessions = await screen.findByRole("button", { name: "Show sessions" });
  await user.click(sessions);
  const initialDrawer = await screen.findByRole("dialog", { name: "Sessions" });
  await user.click(within(initialDrawer).getByText("Hosted focus fixture", { exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(sessions));
  await waitFor(() => expect(view.container.querySelector("[data-header-session-title]")?.textContent).toBe("Hosted focus fixture"));
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Settings rows" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Settings rows" })).getByRole("button", { name: "Accounts" }));
  if (preset === "phone") {
    expect(screen.getByRole("button", { name: "Give this phone full access" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Add an account…" }).hasAttribute("disabled")).toBe(true);
  }
  const rowsToggle = screen.getByRole("button", { name: "Settings rows" });
  await user.click(rowsToggle);
  const settingsRows = await screen.findByRole("dialog", { name: "Settings rows" });
  expect(within(settingsRows).getByRole("button", { name: "Bots" }).getAttribute("aria-disabled")).toBe("true");
  const search = within(settingsRows).getByRole("searchbox", { name: "Search settings" });
  await user.click(search);
  expect(document.activeElement).toBe(search);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings rows" })).toBeNull());
  expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();
  await waitFor(() => expect(document.activeElement).toBe(rowsToggle));
  await user.click(screen.getByRole("button", { name: "Close Settings" }));
  if (preset === "phone") {
    const pairing = world.runtime.connections.list.read();
    for (const name of ["Files", "Diff", "Terminal", "Preview"]) {
      await user.click(screen.getByRole("button", { name: "More" }));
      const entry = await screen.findByRole("menuitem", { name });
      expect(entry.getAttribute("aria-disabled")).not.toBe("true");
      expect(entry.textContent).toContain("Give this phone full access");
      await user.click(entry);
      const upgrade = await screen.findByRole("dialog", { name: "Give this phone full access" });
      expect(upgrade.textContent).toContain("card → Me");
      await user.click(within(upgrade).getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Give this phone full access" })).toBeNull());
      expect(world.runtime.connections.list.read()).toEqual(pairing);
    }
  }
  for (let opening = 0; opening < 2; opening++) {
    const trigger = screen.getByRole("button", { name: "More" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await user.click(trigger);
    await screen.findByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  }
  for (let opening = 0; opening < 3; opening++) {
    const trigger = screen.getByRole("button", { name: "Show sessions" });
    await user.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Sessions" });
    await waitFor(() => expect(document.activeElement).toBe(drawer));
    await user.tab();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    await user.click(within(drawer).getByRole("searchbox", { name: "Filter the sessions" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  }
});
