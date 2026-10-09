import { act, screen, waitFor, within } from "@testing-library/react";
import { settingsDeepLink } from "@agent-harness/client-runtime";
import { PROTOCOL_VERSION, type BrowserStatus, type PairedChrome } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

const chrome: PairedChrome = {
  id: "0199aa00-0000-4000-8000-000000000041", name: "Work Chrome", pairedAt: "2026-09-24T00:00:00.000Z",
  lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.1.0", connected: true, outdated: false,
};
const statusOf = (): BrowserStatus => ({
  listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
  headless: { allowRuns: false, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
});
const opened = async () => {
  let chromes = [chrome];
  const status = statusOf();
  const app = await renderApp(
    { environments: [{ name: "desk", reach: "local", accounts: [{ id: "work", label: "Work" }] }] },
    {},
    (world) => {
      const desk = world.environment("desk");
      desk.wire.answer("browser.chromes.list", () => ({ result: { chromes } }));
      desk.wire.answer("browser.status", () => ({ result: status }));
    },
  );
  const desk = app.environment("desk");
  await screen.findByText("No session is open. Choose one from the sidebar.");
  act(() => app.shell.openDeepLink(settingsDeepLink("access.browser")));
  const pane = await screen.findByRole("region", { name: "Browser" });
  return {
    app,
    desk,
    pane,
    list: (next: PairedChrome[]) => { chromes = next; desk.notice("chrome.updated", { chromeId: chrome.id, name: chrome.name, change: "renamed" }); },
    /** The new Chrome loaded the extension, which opened its socket unpaired: steps 1 to 4 tick and step 5 asks for a code. */
    seen: () => {
      status.unpairedConnected = true;
      act(() => desk.notice("extension.seen", { protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0" }));
    },
  };
};

describe("the Browser settings pane", () => {
  it("numbers the steps, copies the live code, and renews it by itself with no Stop box (setup-copy.md §5.11)", async () => {
    const { app, desk, pane, seen } = await opened();
    desk.wire.answer("browser.pairing.code", () => ({ result: { code: "ABCD2345", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
    await app.user.click(within(pane).getByRole("button", { name: "Pair another Chrome" }));
    const steps = await within(pane).findByRole("list", { name: "Connect Chrome" });
    // The Chrome already paired is not the one being added: nothing ticks and no code is asked for until the new one is found.
    expect(within(steps).queryByText("Chrome found the extension.")).toBeNull();
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    seen();
    expect(within(steps).getByRole("heading", { name: "Copy this folder location." })).toBeDefined();
    expect(within(steps).queryByRole("checkbox")).toBeNull();
    expect(within(pane).getAllByRole("textbox", { name: "Sites you are developing" })).toHaveLength(1);
    const code = await within(pane).findByRole("textbox", { name: "Pairing code" });
    expect((code as HTMLInputElement).value).toBe("ABCD2345");
    await app.user.click(within(pane).getByRole("button", { name: "Copy pairing code" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "ABCD2345"]);
    expect(within(pane).queryByRole("button", { name: /^(Stop|Show code)/ })).toBeNull();
    desk.wire.answer("browser.pairing.code", () => ({ result: { code: "EFGH6789", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
    act(() => app.clock.advance(300_000));
    expect(await within(pane).findByDisplayValue("EFGH6789")).toBeDefined();
    expect(desk.requests("browser.pairing.code")).toHaveLength(2);
  });

  it("keeps the plain My Chrome default when only one Chrome is paired", async () => {
    const { desk, pane } = await opened();
    act(() => desk.setSettings({ "browser.reach": { work: { chrome: { environmentId: desk.environmentId, chromeId: null } } } }));
    const option = await within(pane).findByRole("option", { name: /My Chrome \(agent-harness extension\)/ });
    await waitFor(() => expect((option as HTMLOptionElement).selected).toBe(true));
    expect((option as HTMLOptionElement).disabled).toBe(false);
    expect(within(pane).queryByRole("option", { name: /another machine/ })).toBeNull();
  });

  it("keeps an unpaired local default selected and says to pair it again", async () => {
    const { app, desk, pane, list } = await opened();
    const defaults = await within(pane).findByRole("combobox", { name: "Default browser for Work" });
    await app.user.selectOptions(defaults, JSON.stringify({ chrome: { environmentId: desk.environmentId, chromeId: chrome.id } }));
    await within(pane).findByText("Default browser saved for Work.");
    desk.wire.answer("browser.chromes.unpair", () => {
      list([]);
      return { result: { receipt: { status: "accepted", sequence: 2, changed: true } } };
    });
    await app.user.click(within(pane).getByRole("button", { name: "Unpair Work Chrome" }));
    await within(pane).findByText("Unpaired Work Chrome.");
    const option = await within(pane).findByRole("option", { name: "My Chrome — no longer paired. Pair it again or choose another browser." });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect((option as HTMLOptionElement).selected).toBe(true);
    expect(within(pane).queryByRole("option", { name: /another machine/ })).toBeNull();
  });

  it("keeps a remote Chrome default visible and dim with the reason it cannot be driven here", async () => {
    const { desk, pane } = await opened();
    act(() => desk.setSettings({ "browser.reach": { work: { chrome: { environmentId: "0199aa00-0000-4000-8000-000000000999", chromeId: chrome.id } } } }));
    const option = await within(pane).findByRole("option", { name: /My Chrome on another machine.*no local client can drive/ });
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect((option as HTMLOptionElement).selected).toBe(true);
  });

  it("reports a pairing refusal in one plain line, its raw words under Details (setup-copy.md §3)", async () => {
    const { app, desk, pane, seen } = await opened();
    desk.wire.answer("browser.pairing.code", () => ({ error: { code: "forbidden", message: "Pairing is locked.\nThe environment refused the code request.", data: {} } }));
    await app.user.click(within(pane).getByRole("button", { name: "Pair another Chrome" }));
    seen();
    const alert = await within(pane).findByRole("alert");
    expect(alert.textContent).toMatch(/^Error: /);
    expect(within(pane).queryByText(/Pairing is locked/)).toBeNull();
    await app.user.click(within(pane).getByRole("button", { name: "Details" }));
    expect(within(pane).getByText(/forbidden: Pairing is locked/)).toBeDefined();
  });

  it("shows headless state and changes allowRuns and one account's default without replacing the others", async () => {
    const { app, desk, pane } = await opened();
    desk.setSettings({ "browser.reach": { other: "per-session" }, "browser.headless.allowRuns": false });
    expect(await within(pane).findByText("Available: /test/chromium. 0 live contexts.")).toBeDefined();
    const allow = await within(pane).findByRole("switch", { name: "Allow runs to use the headless browser" });
    await waitFor(() => expect(allow.getAttribute("aria-checked")).toBe("false"));
    await app.user.click(allow);
    expect(await within(pane).findByText("Headless browser allowed for runs.")).toBeDefined();
    const defaults = await within(pane).findByRole("combobox", { name: "Default browser for Work" });
    await app.user.selectOptions(defaults, JSON.stringify({ chrome: { environmentId: desk.environmentId, chromeId: chrome.id } }));
    expect(await within(pane).findByText("Default browser saved for Work.")).toBeDefined();
    await waitFor(() => expect(desk.settings()["browser.reach"]).toEqual({ other: "per-session", work: { chrome: { environmentId: desk.environmentId, chromeId: chrome.id } } }));
    await app.user.keyboard("{Control>},{/Control}");
    await app.user.keyboard("{Control>}n{/Control}");
    expect(await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" })).toBeDefined();
  });

  it("names the button it has, Pair another Chrome, when a code cannot be made", async () => {
    const { app, desk, pane, seen } = await opened();
    desk.wire.answer("browser.pairing.code", () => ({ error: { code: "internal", message: "The code store failed.", data: {} } }));
    await app.user.click(within(pane).getByRole("button", { name: "Pair another Chrome" }));
    seen();
    expect(await within(pane).findByText("agent-harness ran into a problem. Choose Pair another Chrome to try again.")).toBeDefined();
  });

  it("starts pairing here and completes when the new Chrome is listed, then unpairs it", async () => {
    const { app, desk, pane, list, seen } = await opened();
    desk.wire.answer("browser.pairing.code", () => ({ result: { code: "ABCD2345", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
    const pair = await within(pane).findByRole("button", { name: "Pair another Chrome" });
    act(() => pair.focus());
    await app.user.keyboard("{Enter}");
    seen();
    expect(await within(pane).findByDisplayValue("ABCD2345")).toBeDefined();
    const added = { ...chrome, id: "0199aa00-0000-4000-8000-000000000042", name: "Personal Chrome" };
    act(() => list([chrome, added]));
    expect(await within(pane).findByText("Personal Chrome")).toBeDefined();
    await waitFor(() => expect(within(pane).queryByDisplayValue("ABCD2345")).toBeNull());
    desk.wire.answer("browser.chromes.unpair", () => {
      list([chrome]);
      return { result: { receipt: { status: "accepted", sequence: 2, changed: true } } };
    });
    await app.user.click(within(pane).getByRole("button", { name: "Unpair Personal Chrome" }));
    expect(await within(pane).findByText("Unpaired Personal Chrome.")).toBeDefined();
    await waitFor(() => expect(within(pane).queryByText("Personal Chrome")).toBeNull());
  });

  it("lists paired Chromes with last-seen times, follows notices, and marks the retained list stale when offline", async () => {
    const { app, desk, pane, list } = await opened();
    expect(await within(pane).findByText("Work Chrome")).toBeDefined();
    expect(within(pane).getByText(/Last seen/).textContent).toContain("2026-09-24T00:00:00.000Z");
    act(() => list([{ ...chrome, name: "Renamed Chrome" }]));
    expect(await within(pane).findByText("Renamed Chrome")).toBeDefined();
    act(() => { desk.wire.discovery("unreachable"); desk.wire.server.drop(); });
    expect(await within(pane).findByText(/Cached paired Chromes.*stale/)).toBeDefined();
    expect(within(pane).getByText("Renamed Chrome")).toBeDefined();
    expect((within(pane).getByRole("option", { name: /^My Chrome: Renamed Chrome/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(within(pane).getByRole("option", { name: /^My Chrome: Renamed Chrome/ }).textContent).toContain("cannot be reached");
    await waitFor(() => expect((within(pane).getByRole("button", { name: "Unpair Renamed Chrome" }) as HTMLButtonElement).disabled).toBe(true));
    expect(app.platform.reported).toEqual([]);
  });
});
