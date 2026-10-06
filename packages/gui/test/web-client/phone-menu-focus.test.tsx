import { pairingPreset } from "@agent-harness/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { App } from "../../src/app.js";
import { startWebWorld } from "../../gallery/world.js";

it("keeps focus in each phone sheet after its More menu closes", async () => {
  vi.stubGlobal("innerWidth", 390);
  const originalMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : originalMedia(query));
  const Original = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => callback(entries.map(entry => entry.target.hasAttribute("data-dock-owner")
        ? { ...entry, borderBoxSize: [{ inlineSize: 390, blockSize: 844 }] } : entry), observer));
    }
  });
  const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired", scopes: pairingPreset("own-client").scopes, sessions: [{ title: "Phone sheet focus" }] }] }, {});
  const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
  onTestFinished(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Show sessions" }));
  await user.click(within(await screen.findByRole("dialog", { name: "Sessions" })).getByText("Phone sheet focus", { exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show sessions" })));
  for (const label of ["Files", "Diff", "Documents", "Tasks"]) {
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: label }));
    const sheet = await screen.findByRole("dialog", { name: "Side column" });
    await waitFor(() => expect(document.querySelector(".phone-frame-menu")).toBeNull());
    await user.tab();
    expect(sheet.contains(document.activeElement)).toBe(true);
    await user.click(within(sheet).getByRole("button", { name: "Close side sheet" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Side column" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show the side column" })));
    expect(screen.queryByRole("tooltip")).toBeNull();
  }
});
