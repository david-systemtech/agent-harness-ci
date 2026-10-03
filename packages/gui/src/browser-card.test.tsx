import { act, screen, waitFor, within } from "@testing-library/react";
import { PROTOCOL_VERSION, type BrowserStatus, type PairedChrome } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

const statusOf = (): BrowserStatus => ({
  listener: { state: "listening", port: 47615 },
  folder: { path: "/home/test/.agent-harness/extension/current", problem: null },
  shippedVersion: "0.1.0",
  unpairedConnected: false,
  headless: { allowRuns: true, availability: { available: false, reason: "No browser installed." }, liveContexts: 0 },
});
const chromeOf = (now: string): PairedChrome => ({
  id: "0199aa00-0000-4000-8000-000000000041",
  name: "Work Chrome",
  pairedAt: now,
  lastConnectedAt: now,
  lastReportedVersion: "0.1.0",
  connected: true,
  outdated: false,
});
const card = () => screen.getByRole("region", { name: "Browser" });
const opened = async (given: Partial<ScriptedEnvironment> = {}, local = true, initiallyPaired = false) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: local ? "local" : "paired", ...given }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const desk = app.environment("desk");
  const status = statusOf();
  let chromes: PairedChrome[] = initiallyPaired ? [chromeOf(app.clock.now().toISOString())] : [];
  desk.wire.answer("browser.status", () => ({ result: status }));
  desk.wire.answer("browser.chromes.list", () => ({ result: { chromes } }));
  desk.wire.answer("browser.pairing.code", () => ({ result: { code: "ABCD2345", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
  await screen.findByRole("navigation", { name: "Set up steps" });
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Browser" }));
  return {
    app,
    desk,
    status,
    pair: () => {
      chromes = [chromeOf(app.clock.now().toISOString())];
      desk.notice("chrome.updated", { chromeId: chromes[0]?.id, name: "Work Chrome", change: "paired" });
    },
  };
};

describe("the Browser card in Set up", () => {
  it("shows the unpacked folder and exact walkthrough, copies it, and ticks Load on extension.seen", async () => {
    const { app, desk, status } = await opened();
    expect(await within(card()).findByText(status.folder.path)).toBeDefined();
    expect(within(card()).getByText("Open chrome://extensions. Turn on Developer mode. Click Load unpacked and choose this folder.")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Copy" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", status.folder.path]);
    expect(within(card()).getByRole("img", { name: "1. Load the extension: pending" })).toBeDefined();
    status.unpairedConnected = true;
    act(() => desk.notice("extension.seen", { protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0" }));
    await waitFor(() => expect(within(card()).getByRole("img", { name: "1. Load the extension: complete" })).toBeDefined());
  });
  it("mints a code on opening, counts down on the environment clock, and renews it on expiry", async () => {
    const { app, desk } = await opened();
    expect(await within(card()).findByText("ABCD2345")).toBeDefined();
    expect(within(card()).getByText("Type this code on the extension's options page.")).toBeDefined();
    expect(within(card()).getByText("Listening on 127.0.0.1:47615.")).toBeDefined();
    expect(within(card()).getByRole("timer").textContent).toBe("5m 0s left to pair.");
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect(within(card()).getByRole("timer").textContent).toBe("3m 59s left to pair."));
    desk.wire.answer("browser.pairing.code", () => ({ result: { code: "EFGH6789", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
    act(() => app.clock.advance(239_000));
    expect(await within(card()).findByText("EFGH6789")).toBeDefined();
    expect(within(card()).queryByText("ABCD2345")).toBeNull();
    expect(within(card()).getByRole("timer").textContent).toBe("5m 0s left to pair.");
    expect(desk.requests("browser.pairing.code")).toHaveLength(2);
  });

  it("ticks Pair with the Chrome's name on chrome.updated and keeps Load ticked after pairing closes the unpaired socket", async () => {
    const { desk, status, pair } = await opened();
    await within(card()).findByText("ABCD2345");
    status.unpairedConnected = true;
    act(() => desk.notice("extension.seen", { protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0" }));
    await waitFor(() => expect(within(card()).getByRole("img", { name: "1. Load the extension: complete" })).toBeDefined());
    status.unpairedConnected = false;
    act(pair);
    expect(await within(card()).findByText("Paired: Work Chrome.")).toBeDefined();
    expect(within(card()).getByRole("img", { name: "2. Pair: complete" })).toBeDefined();
    expect(within(card()).getByRole("img", { name: "1. Load the extension: complete" })).toBeDefined();
    expect(within(card()).queryByRole("timer")).toBeNull();
    expect(within(card()).queryByText("Type this code on the extension's options page.")).toBeNull();
  });

  it("saves optional development hosts one per line to the page policy, including an empty list", async () => {
    const { app, desk } = await opened();
    const sites = await within(card()).findByRole("textbox", { name: "Sites you are developing" });
    expect(within(card()).getByText("Loopback and private addresses count without being listed.")).toBeDefined();
    await app.user.type(sites, "app.example.test{Enter}*.example.test");
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(desk.settings()["browser.devSites"]).toEqual(["app.example.test", "*.example.test"]));
    await app.user.clear(sites);
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(desk.settings()["browser.devSites"]).toEqual([]));
  });

  it("keeps persisted hosts on revisit and labels the tick as this visit's save acknowledgement", async () => {
    const { app } = await opened({ settings: { "browser.devSites": ["app.example.test"] } });
    const savedThisVisit = () => within(card()).getByRole("checkbox", { name: "Sites saved this visit" }) as HTMLInputElement;
    const sites = await within(card()).findByRole("textbox", { name: "Sites you are developing" });
    expect((sites as HTMLTextAreaElement).value).toBe("app.example.test");
    expect(savedThisVisit().checked).toBe(false);
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(savedThisVisit().checked).toBe(true));
    const steps = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(steps.getByRole("button", { name: "Appearance" }));
    await app.user.click(steps.getByRole("button", { name: "Browser" }));
    const revisited = await within(card()).findByRole("textbox", { name: "Sites you are developing" });
    expect((revisited as HTMLTextAreaElement).value).toBe("app.example.test");
    expect(savedThisVisit().checked).toBe(false);
  });

  it("Done reads the current reach and presets My Chrome only for accounts still at per-session, names them, then shows usage", async () => {
    const chosen = { chrome: { environmentId: "0199aa00-0000-4000-8000-000000000099", chromeId: null } };
    const { app, desk, pair } = await opened({
      accounts: [{ label: "work" }, { label: "personal" }, { label: "already chosen" }, { label: "changed meanwhile" }],
      settings: { "browser.reach": { "account-2": "per-session", "account-3": chosen } },
    });
    act(pair);
    await within(card()).findByText("Paired: Work Chrome.");
    desk.setSettings({ "browser.reach": { "account-2": "per-session", "account-3": chosen, "account-4": chosen } });
    await app.user.click(within(card()).getByRole("button", { name: "Done" }));
    expect(await within(card()).findByText("My Chrome set as the reach for work, personal. Accounts already set keep their reach.")).toBeDefined();
    expect(desk.settings()["browser.reach"]).toEqual({
      "account-1": { chrome: { environmentId: desk.environmentId, chromeId: null } },
      "account-2": { chrome: { environmentId: desk.environmentId, chromeId: null } },
      "account-3": chosen,
      "account-4": chosen,
    });
    expect(within(card()).getByRole("region", { name: "Using your browser" })).toBeDefined();
    expect(within(card()).getByText("Whichever of them is open.")).toBeDefined();
    expect(within(card()).getByText("Always this browser, whatever else is open.")).toBeDefined();
  });

  it("keeps the health line and maps Reload, Pair another, Unpair and Check again on the card", async () => {
    const id = chromeOf("2026-09-24T00:00:00.000Z").id;
    const health = "The extension only runs while Chrome is open. Open Chrome and, if it asks, dismiss the developer-mode notice; this turns green by itself.";
    const { app, desk, pair } = await opened({
      setup: {
        browser: {
          state: "needs-attention",
          reason: health,
          failing: ["browser.chrome-connected"],
          actions: ["check-again", "unpair", "pair-another", "reload"],
          targets: [
            { action: "unpair", kind: "chrome", id, label: "Work Chrome" },
            { action: "reload", kind: "chrome", id, label: "Work Chrome" },
          ],
        },
      },
    });
    act(pair);
    await within(card()).findByText("Paired: Work Chrome.");
    expect(within(card()).getByText(health)).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Reload: Work Chrome" }));
    expect(await within(card()).findByText("Work Chrome: Open chrome://extensions and click Reload.")).toBeDefined();
    expect(screen.getByRole("region", { name: "Set up" })).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    expect(await within(card()).findByText("ABCD2345")).toBeDefined();
    desk.wire.answer("browser.chromes.unpair", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { chrome: chromeOf(app.clock.now().toISOString()) } } }));
    await app.user.click(within(card()).getByRole("button", { name: "Unpair: Work Chrome" }));
    expect(await within(card()).findByText("Unpaired Work Chrome.")).toBeDefined();
    expect(desk.requests("browser.chromes.unpair").map((r) => r.params["chromeId"])).toEqual([id]);
    const checked = desk.requests("setup.check").length;
    await app.user.click(within(card()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(desk.requests("setup.check").length).toBeGreaterThan(checked));
  });

  it("shows the local listener's port-in-use sentence and a folder problem", async () => {
    const { desk, status } = await opened();
    await within(card()).findByText("ABCD2345");
    status.listener = { state: "not-listening", reason: "port-in-use", message: "The extension listener could not bind: every port is in use." };
    status.folder.problem = "The shipped extension could not be copied.";
    act(() => desk.notice("extension.seen", { protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0" }));
    expect(await within(card()).findByText(status.listener.message)).toBeDefined();
    expect(await within(card()).findByText(status.folder.problem)).toBeDefined();
  });

  it("shows the install line without a local environment and never mints a code on the remote machine", async () => {
    const { desk } = await opened({}, false);
    expect(within(card()).getByText("Install agent-harness on this machine to pair your Chrome.")).toBeDefined();
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
  });

  it("read-only clients see why pairing and writes are unavailable and send no admin calls", async () => {
    const { desk } = await opened({ scopes: ["read", "sessions:write", "runs:drive", "terminal"] });
    expect(await within(card()).findByText(/^No pairing code: /)).toBeDefined();
    expect(within(card()).getByRole("button", { name: "Save sites" }).hasAttribute("disabled")).toBe(true);
    expect(within(card()).getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(true);
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    expect(desk.requests("settings.update")).toHaveLength(0);
  });

  it("does not show usage when the reach write is rejected, and can retry Done", async () => {
    const { app, pair } = await opened({ accounts: [{ label: "work" }], receipts: { "settings.update": { rejected: "forbidden", message: "Settings are locked." } } });
    act(pair);
    await within(card()).findByText("Paired: Work Chrome.");
    await app.user.click(within(card()).getByRole("button", { name: "Done" }));
    expect(await within(card()).findByText("Reach not saved: Settings are locked.")).toBeDefined();
    expect(within(card()).queryByRole("region", { name: "Using your browser" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(false);
  });

  it.each(["accounts.list", "settings.get"])("does not save reach when %s cannot be read, and leaves Done available", async (method) => {
    const { app, desk, pair } = await opened({ accounts: [{ label: "work" }] });
    act(pair);
    await within(card()).findByText("Paired: Work Chrome.");
    desk.wire.answer(method, () => ({ error: { code: "forbidden", message: "This read is unavailable.", data: {} } }));
    await app.user.click(within(card()).getByRole("button", { name: "Done" }));
    expect(await within(card()).findByText("Reach not saved: This read is unavailable.")).toBeDefined();
    expect(desk.requests("settings.update")).toHaveLength(0);
    expect(within(card()).queryByRole("region", { name: "Using your browser" })).toBeNull();
    expect(within(card()).getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(false);
  });

  it("opens an already paired Chrome with a live code, and Pair another preserves unsaved development hosts", async () => {
    const { app, desk } = await opened({ setup: { browser: { actions: ["pair-another"] } } }, true, true);
    expect(await within(card()).findByText("ABCD2345")).toBeDefined();
    expect(within(card()).getByText("Type this code on the extension's options page.")).toBeDefined();
    const sites = within(card()).getByRole("textbox", { name: "Sites you are developing" });
    await app.user.type(sites, "app.example.test");
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    await waitFor(() => expect(desk.requests("browser.pairing.code")).toHaveLength(2));
    expect(within(card()).getByText("Type this code on the extension's options page.")).toBeDefined();
    expect((within(card()).getByRole("textbox", { name: "Sites you are developing" }) as HTMLTextAreaElement).value).toBe("app.example.test");
  });
});
