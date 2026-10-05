import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/app.js";
import { startWebWorld } from "../../gallery/world.js";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps Tab inside the browser session drawer after Settings and More dismiss", async () => {
  vi.stubGlobal("innerWidth", 390);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Hosted focus fixture" }] }] }, {});
  const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
  close.push(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: "Settings rows" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Settings rows" })).getByRole("button", { name: "Accounts" }));
  await user.click(screen.getByRole("button", { name: "Close Settings" }));
  for (let opening = 0; opening < 2; opening++) {
    const trigger = screen.getByRole("button", { name: "More" });
    await user.click(trigger);
    await screen.findByRole("menu");
    await user.click(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
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
