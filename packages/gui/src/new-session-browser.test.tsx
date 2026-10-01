import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BrowserStatus, PairedChrome } from "@agent-harness/contracts";
import { renderApp } from "../test/harness.js";

const chrome: PairedChrome = {
  id: "0199aa00-0000-4000-8000-000000000041", name: "Work Chrome", pairedAt: "2026-09-24T00:00:00.000Z",
  lastConnectedAt: "2026-09-24T00:00:00.000Z", lastReportedVersion: "0.1.0", connected: true, outdated: false,
};
const status: BrowserStatus = {
  listener: { state: "listening", port: 47615 }, folder: { path: "/test/extension", problem: null }, shippedVersion: "0.1.0", unpairedConnected: false,
  headless: { allowRuns: false, availability: { available: true, source: { kind: "launched", executable: "/test/chromium" } }, liveContexts: 0 },
};
const open = async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ id: "work", label: "Work" }, { id: "home", label: "Home" }] }] });
  const desk = app.environment("desk");
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes: [chrome] } }));
  desk.wire.answer("browser.status", () => ({ result: status }));
  desk.setSettings({ "browser.reach": { work: { chrome: { environmentId: desk.environmentId, chromeId: chrome.id } } } });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  await app.user.keyboard("{Control>}n{/Control}");
  return { app, desk };
};

describe("the new-session browser chip", () => {
  it("sends the browser preset with the first message and shows it on the created session", async () => {
    const { app, desk } = await open();
    await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" });
    const message = screen.getByRole("textbox", { name: "Message" });
    act(() => message.focus());
    await app.user.keyboard("Read the page");
    await app.user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("region", { name: "Transcript" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" })).toBeDefined();
    expect(desk.requests("sessions.create")[0]?.params["browser"]).toEqual({ value: { kind: "chrome", environmentId: desk.environmentId, chromeId: chrome.id }, chosenBy: "reach" });
  });

  it("reruns the browser preset when the account changes after a person chose a browser", async () => {
    const { app } = await open();
    const browser = await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" });
    act(() => browser.focus());
    await app.user.keyboard("{Enter}");
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^None/ }));
    await screen.findByRole("button", { name: "Browser: None" });
    const account = screen.getByRole("button", { name: /^Account: Work/ });
    act(() => account.focus());
    await app.user.keyboard("{Enter}");
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^Home/ }));
    expect(await screen.findByRole("button", { name: "Browser: Default" })).toBeDefined();
  });

  it("offers an explicit None choice separately from Default and restores it after reopening", async () => {
    const { app } = await open();
    const chip = await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" });
    act(() => chip.focus());
    await app.user.keyboard("{Enter}");
    await app.user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /^None/ }));
    expect(await screen.findByRole("button", { name: "Browser: None" })).toBeDefined();
    await app.remount();
    expect(await screen.findByRole("button", { name: "Browser: None" })).toBeDefined();
  });

  it("shows the account reach preset, lets the keyboard choose the dock, and keeps that choice on reopening", async () => {
    const { app } = await open();
    const button = await screen.findByRole("button", { name: "Browser: My Chrome: Work Chrome" });
    act(() => button.focus());
    await app.user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /^Headless browser/ }).getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByRole("menuitem", { name: /^Headless browser/ }).textContent).toContain("lets no run use its headless browser");
    const dock = within(menu).getByRole("menuitem", { name: /^agent-harness's built-in browser/ });
    act(() => dock.focus());
    await app.user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Browser: agent-harness's built-in browser" });
    await app.remount();
    expect(await screen.findByRole("button", { name: "Browser: agent-harness's built-in browser" })).toBeDefined();
  });
});
