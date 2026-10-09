import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { PROTOCOL_VERSION, type BrowserStatus, type PairedChrome } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { startWebWorld } from "../gallery/world.js";
import { App } from "./app.js";
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
const tick = (n: number) => within(card()).getByRole("img", { name: new RegExp(`^Step ${n}: `) }).getAttribute("aria-label");
const STEPS = [
  "Copy this folder location.",
  "In Chrome, open chrome://extensions.",
  "Turn on Developer mode, at the top of that page.",
  "Choose Load unpacked, paste the folder location and confirm.",
  "Choose the agent-harness extension's icon, then Options, and type this code:",
  "Sites you are building",
] as const;
/** More options stays open for the window's life once chosen (more-options.tsx), so it is opened only when shut. */
const moreOptions = async (user: { click(element: Element): Promise<void> }) => {
  const fold = within(card()).getByRole("button", { name: "More options" });
  if (fold.getAttribute("aria-expanded") !== "true") await user.click(fold);
};
const CLOSED = "Chrome is closed, so agents cannot use it. Open Chrome. This updates by itself.";
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
    seen: () => {
      status.unpairedConnected = true;
      act(() => desk.notice("extension.seen", { protocolVersion: PROTOCOL_VERSION, extensionVersion: "0.1.0" }));
    },
    pair: (chrome = chromeOf(app.clock.now().toISOString())) => {
      chromes = [...chromes.filter((paired) => paired.id !== chrome.id), chrome];
      desk.notice("chrome.updated", { chromeId: chrome.id, name: chrome.name, change: "paired" });
    },
  };
};

describe("the Browser card in Set up (setup-copy.md §5.11)", () => {
  it("numbers steps 1 to 4, copies the folder location and chrome://extensions, and mints no code before Chrome finds the extension", async () => {
    const { app, desk, status } = await opened();
    expect(await within(card()).findByText(status.folder.path)).toBeDefined();
    expect(within(card()).queryAllByRole("checkbox")).toHaveLength(0);
    for (const step of STEPS.slice(0, 4)) expect(within(card()).getByRole("heading", { name: step })).toBeDefined();
    expect(within(card()).queryByRole("heading", { name: STEPS[4] })).toBeNull();
    expect(within(card()).getByText("Paste it in the address bar and press Enter.")).toBeDefined();
    expect([1, 2, 3, 4].map(tick)).toEqual(["Step 1: not done yet", "Step 2: not done yet", "Step 3: not done yet", "Step 4: not done yet"]);
    await app.user.click(within(card()).getByRole("button", { name: "Copy folder location" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", status.folder.path]);
    await waitFor(() => expect(tick(1)).toBe("Step 1: done"));
    await app.user.click(within(card()).getAllByRole("button", { name: "Copy chrome://extensions" })[0]!);
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "chrome://extensions"]);
    await waitFor(() => expect(tick(2)).toBe("Step 2: done"));
    expect(tick(3)).toBe("Step 3: not done yet");
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    expect(within(card()).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
  });

  it("ticks steps 1 to 4 on extension.seen, says Chrome found the extension, and only then shows step 5's code", async () => {
    const { desk, seen } = await opened();
    await within(card()).findByRole("heading", { name: STEPS[0] });
    seen();
    expect(await within(card()).findByText("Chrome found the extension.")).toBeDefined();
    expect([1, 2, 3, 4].map(tick)).toEqual(["Step 1: done", "Step 2: done", "Step 3: done", "Step 4: done"]);
    expect(within(card()).getByRole("heading", { name: STEPS[4] })).toBeDefined();
    expect(await within(card()).findByDisplayValue("ABCD2345")).toBeDefined();
    expect(tick(5)).toBe("Step 5: not done yet");
    expect(desk.requests("browser.pairing.code")).toHaveLength(1);
  });

  it("counts down the code in minutes on the environment clock and renews it by itself, with no Stop box", async () => {
    const { app, desk, seen } = await opened();
    await within(card()).findByRole("heading", { name: STEPS[0] });
    seen();
    expect(await within(card()).findByDisplayValue("ABCD2345")).toBeDefined();
    expect(within(card()).getByRole("timer").textContent).toBe("5 min left");
    expect(within(card()).queryByRole("button", { name: /^(Stop|Show code)/ })).toBeNull();
    await app.user.click(within(card()).getByRole("button", { name: "Copy pairing code" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "ABCD2345"]);
    act(() => app.clock.advance(61_000));
    await waitFor(() => expect(within(card()).getByRole("timer").textContent).toBe("4 min left"));
    desk.wire.answer("browser.pairing.code", () => ({ result: { code: "EFGH6789", expiresAt: new Date(app.clock.now().getTime() + 300_000).toISOString() } }));
    act(() => app.clock.advance(239_000));
    expect(await within(card()).findByDisplayValue("EFGH6789")).toBeDefined();
    expect(within(card()).queryByDisplayValue("ABCD2345")).toBeNull();
    expect(within(card()).getByRole("timer").textContent).toBe("5 min left");
    expect(desk.requests("browser.pairing.code")).toHaveLength(2);
  });

  it("ticks step 5 on chrome.updated and keeps steps 1 to 4 ticked after pairing closes the unpaired socket", async () => {
    const { status, seen, pair } = await opened();
    await within(card()).findByRole("heading", { name: STEPS[0] });
    seen();
    await within(card()).findByDisplayValue("ABCD2345");
    status.unpairedConnected = false;
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    expect([1, 2, 3, 4].map(tick)).toEqual(["Step 1: done", "Step 2: done", "Step 3: done", "Step 4: done"]);
    expect(within(card()).queryByRole("timer")).toBeNull();
    expect(within(card()).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
  });

  it("keeps the listening address and ports in the step's one Details only", async () => {
    const { app } = await opened();
    await within(card()).findByRole("heading", { name: STEPS[0] });
    expect(within(card()).queryByText(/127\.0\.0\.1/)).toBeNull();
    await waitFor(() => expect(within(card()).getAllByRole("button", { name: "Details" })).toHaveLength(1));
    await app.user.click(within(card()).getByRole("button", { name: "Details" }));
    expect(await within(card()).findByText(/Listening on 127\.0\.0\.1:47615/)).toBeDefined();
    expect(within(card()).getByText(/Extension folder: \/home\/test\/\.agent-harness\/extension\/current/)).toBeDefined();
  });

  it("saves optional sites you are building one per line to the page policy, including an empty list", async () => {
    const { app, desk } = await opened();
    const sites = await within(card()).findByRole("textbox", { name: "Sites you are building" });
    expect(within(card()).getByText("One site per line, like localhost:3000. Agents may run scripts on these sites.")).toBeDefined();
    expect(within(card()).getByText("Optional")).toBeDefined();
    await app.user.type(sites, "app.example.test{Enter}*.example.test");
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(desk.settings()["browser.devSites"]).toEqual(["app.example.test", "*.example.test"]));
    await app.user.clear(sites);
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(desk.settings()["browser.devSites"]).toEqual([]));
  });

  it("keeps persisted sites on revisit and ticks step 6 on this visit's save", async () => {
    const { app } = await opened({ settings: { "browser.devSites": ["app.example.test"] } });
    const sites = await within(card()).findByRole("textbox", { name: "Sites you are building" });
    expect((sites as HTMLTextAreaElement).value).toBe("app.example.test");
    expect(tick(6)).toBe("Step 6: not done yet");
    await app.user.click(within(card()).getByRole("button", { name: "Save sites" }));
    await waitFor(() => expect(tick(6)).toBe("Step 6: done"));
    const steps = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(steps.getByRole("button", { name: "Appearance" }));
    await app.user.click(steps.getByRole("button", { name: "Browser" }));
    const revisited = await within(card()).findByRole("textbox", { name: "Sites you are building" });
    expect((revisited as HTMLTextAreaElement).value).toBe("app.example.test");
    expect(tick(6)).toBe("Step 6: not done yet");
  });

  it("holds Use my Chrome for agents with its reason in view until Chrome is paired", async () => {
    const { pair } = await opened({ accounts: [{ label: "work" }] });
    const use = await within(card()).findByRole("button", { name: "Use my Chrome for agents" });
    expect(use.hasAttribute("disabled")).toBe(true);
    const reason = within(card()).getByText("Pair Chrome first (step 5).");
    expect(use.getAttribute("aria-describedby")).toBe(reason.id);
    act(pair);
    await waitFor(() => expect(within(card()).getByRole("button", { name: "Use my Chrome for agents" }).hasAttribute("disabled")).toBe(false));
    expect(within(card()).queryByText("Pair Chrome first (step 5).")).toBeNull();
  });

  it("Use my Chrome for agents reads the current reach, presets My Chrome only for accounts still at per-session, then says agents use it", async () => {
    const chosen = { chrome: { environmentId: "0199aa00-0000-4000-8000-000000000099", chromeId: null } };
    const { app, desk, pair } = await opened({
      accounts: [{ label: "work" }, { label: "personal" }, { label: "already chosen" }, { label: "changed meanwhile" }],
      settings: { "browser.reach": { "account-2": "per-session", "account-3": chosen } },
    });
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    desk.setSettings({ "browser.reach": { "account-2": "per-session", "account-3": chosen, "account-4": chosen } });
    await app.user.click(within(card()).getByRole("button", { name: "Use my Chrome for agents" }));
    expect(await within(card()).findByText("Agents now use your Chrome.")).toBeDefined();
    expect(desk.settings()["browser.reach"]).toEqual({
      "account-1": { chrome: { environmentId: desk.environmentId, chromeId: null } },
      "account-2": { chrome: { environmentId: desk.environmentId, chromeId: null } },
      "account-3": chosen,
      "account-4": chosen,
    });
  });

  it("Use my Chrome for agents says nothing changed, and writes nothing, when every account already has a browser chosen", async () => {
    const chosen = { chrome: { environmentId: "0199aa00-0000-4000-8000-000000000099", chromeId: null } };
    const { app, desk, pair } = await opened({ accounts: [{ label: "work" }], settings: { "browser.reach": { "account-1": chosen } } });
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    await app.user.click(within(card()).getByRole("button", { name: "Use my Chrome for agents" }));
    expect(await within(card()).findByText("Every account already has a browser chosen, so nothing changed.")).toBeDefined();
    expect(within(card()).queryByText("Agents now use your Chrome.")).toBeNull();
    expect(desk.requests("settings.update")).toHaveLength(0);
  });

  it("keeps the browser glossary in the fold How agents use Chrome, naming the paired Chrome, never a placeholder", async () => {
    const { app, pair } = await opened();
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    expect(within(card()).queryByText("Always this browser, whatever else is open.")).toBeNull();
    await app.user.click(within(card()).getByRole("button", { name: "How agents use Chrome" }));
    expect(within(card()).getByText("Whichever of them is open.")).toBeDefined();
    expect(within(card()).getByText("My Chrome: Work Chrome")).toBeDefined();
    expect(within(card()).getByText("Always this browser, whatever else is open.")).toBeDefined();
    expect(within(card()).queryByText(/<name>/)).toBeNull();
  });

  it("says Chrome is closed without offering Unpair as the fix; Unpair and Pair another sit in More options", async () => {
    const id = chromeOf("2026-09-24T00:00:00.000Z").id;
    const { app, desk, pair, seen } = await opened({
      setup: {
        browser: {
          state: "needs-attention",
          reason: CLOSED,
          failing: ["browser.chrome-connected"],
          // An older computer still offers Unpair and Pair another here: the card draws neither beside the line.
          actions: ["check-again", "unpair", "pair-another"],
          targets: [{ action: "unpair", kind: "chrome", id, label: "Work Chrome" }],
        },
      },
    });
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    expect(within(card()).getByText(CLOSED)).toBeDefined();
    expect(within(card()).queryByRole("button", { name: /Unpair/ })).toBeNull();
    expect(within(card()).queryByRole("button", { name: /Pair another/ })).toBeNull();
    await moreOptions(app.user);
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    seen();
    expect(await within(card()).findByDisplayValue("ABCD2345")).toBeDefined();
    expect(tick(5)).toBe("Step 5: not done yet");
    desk.wire.answer("browser.chromes.unpair", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: { chrome: chromeOf(app.clock.now().toISOString()) } } }));
    await app.user.click(within(card()).getByRole("button", { name: "Unpair Work Chrome" }));
    expect(await within(card()).findByText("Unpaired Work Chrome.")).toBeDefined();
    expect(desk.requests("browser.chromes.unpair").map((r) => r.params["chromeId"])).toEqual([id]);
    const checked = desk.requests("setup.check").length;
    await app.user.click(within(card()).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(desk.requests("setup.check").length).toBeGreaterThan(checked));
  });

  it("offers Copy chrome://extensions beside the out-of-date line in place of Reload", async () => {
    const id = chromeOf("2026-09-24T00:00:00.000Z").id;
    const outdated = "The Chrome extension is out of date. In chrome://extensions, choose reload on agent-harness.";
    const { app, pair } = await opened({
      setup: { browser: { state: "needs-attention", reason: outdated, failing: ["browser.extension-current"], actions: ["reload", "check-again"], targets: [{ action: "reload", kind: "chrome", id, label: "Work Chrome" }] } },
    });
    act(pair);
    expect(await within(card()).findByText(outdated)).toBeDefined();
    expect(within(card()).queryByRole("button", { name: /^Reload/ })).toBeNull();
    const fix = within(card()).getAllByRole("button", { name: "Copy chrome://extensions" });
    expect(fix).toHaveLength(2);
    await app.user.click(fix[0]!);
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "chrome://extensions"]);
  });

  it("says plainly when the ports are busy and when the extension's files are missing, each an alert with its raw words in Details", async () => {
    const { app, desk, status, seen } = await opened();
    await within(card()).findByRole("heading", { name: STEPS[0] });
    status.listener = { state: "not-listening", reason: "port-in-use", message: "Ports 47615-47619 on loopback are all in use or reserved, so no Chrome can reach this environment." };
    status.folder.problem = "This environment carries no built extension: /opt/extension holds no manifest with a version name.";
    seen();
    const busy = await within(card()).findByText("Chrome cannot reach agent-harness because the ports it needs are busy. Close other apps, then restart agent-harness.");
    const missing = within(card()).getByText("The extension's files are missing from this install. Reinstall agent-harness.");
    for (const line of [busy, missing]) {
      const alert = line.closest('[role="alert"]') as HTMLElement;
      expect(alert.textContent).toMatch(/^Error: /);
      expect(within(alert).getByText("Error:").className).toContain("sr-only");
    }
    expect(within(card()).queryByText(/47615-47619/)).toBeNull();
    for (const details of within(card()).getAllByRole("button", { name: "Details" })) await app.user.click(details);
    expect(within(card()).getAllByText(/Ports 47615-47619 on loopback/).length).toBeGreaterThan(0);
    expect(within(card()).getAllByText(/carries no built extension/).length).toBeGreaterThan(0);
    void desk;
  });

  it("says agent-harness is not running here without a local environment, and never mints a code on the remote computer", async () => {
    const { desk } = await opened({}, false);
    expect(within(card()).getByText("agent-harness is not running on this computer, so Chrome cannot connect to it.")).toBeDefined();
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
  });

  it("keeps the step's own details, which Chrome and which versions, in Details without a local environment", async () => {
    const outdated = "The Chrome extension is out of date. In chrome://extensions, choose reload on agent-harness.";
    const { app } = await opened({
      setup: { browser: { state: "needs-attention", reason: outdated, failing: ["browser.extension-current"], actions: ["check-again"], details: ["Work Chrome: extension 0.0.9, this computer ships 0.1.0"] } },
    }, false);
    expect(await within(card()).findByText(outdated)).toBeDefined();
    for (const details of within(card()).getAllByRole("button", { name: "Details" })) await app.user.click(details);
    expect(within(card()).getAllByText(/Work Chrome: extension 0\.0\.9, this computer ships 0\.1\.0/).length).toBeGreaterThan(0);
  });

  it("says connecting Chrome works only in the desktop app in a browser tab, and mints no code there", async () => {
    const world = await startWebWorld({ environments: [{ name: "desk", reach: "paired" }] }, { settingsRow: "setup.checklist" });
    const view = render(<App {...world} web={{ platform: world.platform, route: {} }} />);
    onTestFinished(async () => { view.unmount(); await world.runtime.close(); await world.presentation.close(); });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    await user.click(await screen.findByRole("button", { name: "Open Set up" }));
    await user.click(within(await screen.findByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Browser" }));
    expect(await screen.findByText("Connecting Chrome works only in the desktop app.")).toBeDefined();
    expect(world.world.environment("desk").requests("browser.pairing.code")).toHaveLength(0);
  });

  it("read-only clients see why pairing and writes are unavailable and send no admin calls", async () => {
    const { desk, seen } = await opened({ scopes: ["read", "sessions:write", "runs:drive", "terminal"] });
    await within(card()).findByRole("heading", { name: STEPS[0] });
    seen();
    await within(card()).findByRole("heading", { name: STEPS[4] });
    // Said once for every held control, never once each (setup-copy.md §1 rules 14 and 16).
    expect(within(card()).getAllByText(/^This app has limited access to desk, so it cannot change settings/)).toHaveLength(1);
    expect(within(card()).getByRole("button", { name: "Save sites" }).hasAttribute("disabled")).toBe(true);
    expect(within(card()).getByRole("button", { name: "Use my Chrome for agents" }).hasAttribute("disabled")).toBe(true);
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    expect(desk.requests("settings.update")).toHaveLength(0);
  });

  it("does not say agents use Chrome when the reach write is refused, and Use my Chrome for agents stays available", async () => {
    const { app, pair } = await opened({ accounts: [{ label: "work" }], receipts: { "settings.update": { rejected: "forbidden", message: "Settings are locked." } } });
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    await app.user.click(within(card()).getByRole("button", { name: "Use my Chrome for agents" }));
    expect(await within(card()).findByRole("alert")).toBeDefined();
    expect(within(card()).queryByText("Agents now use your Chrome.")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Use my Chrome for agents" }).hasAttribute("disabled")).toBe(false);
  });

  it.each(["accounts.list", "settings.get"])("does not save reach when %s cannot be read, and leaves Use my Chrome for agents available", async (method) => {
    const { app, desk, pair } = await opened({ accounts: [{ label: "work" }] });
    act(pair);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    desk.wire.answer(method, () => ({ error: { code: "forbidden", message: "This read is unavailable.", data: {} } }));
    await app.user.click(within(card()).getByRole("button", { name: "Use my Chrome for agents" }));
    expect(await within(card()).findByRole("alert")).toBeDefined();
    expect(desk.requests("settings.update")).toHaveLength(0);
    expect(within(card()).queryByText("Agents now use your Chrome.")).toBeNull();
    expect(within(card()).getByRole("button", { name: "Use my Chrome for agents" }).hasAttribute("disabled")).toBe(false);
  });

  it("opens an already paired Chrome with every step ticked and no code, and Pair another preserves unsaved sites", async () => {
    const { app, desk, seen } = await opened({}, true, true);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    const sites = within(card()).getByRole("textbox", { name: "Sites you are building" });
    await app.user.type(sites, "app.example.test");
    await moreOptions(app.user);
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    seen();
    expect(await within(card()).findByDisplayValue("ABCD2345")).toBeDefined();
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    await waitFor(() => expect(desk.requests("browser.pairing.code")).toHaveLength(2));
    expect((within(card()).getByRole("textbox", { name: "Sites you are building" }) as HTMLTextAreaElement).value).toBe("app.example.test");
  });

  it("starts Pair another with steps 1 to 4 unticked and no code until Chrome finds the new extension, and keeps them ticked once it pairs", async () => {
    const { app, desk, status, seen, pair } = await opened({}, true, true);
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    await moreOptions(app.user);
    await app.user.click(within(card()).getByRole("button", { name: "Pair another" }));
    await waitFor(() => expect(tick(4)).toBe("Step 4: not done yet"));
    expect([1, 2, 3].map(tick)).toEqual(["Step 1: not done yet", "Step 2: not done yet", "Step 3: not done yet"]);
    expect(within(card()).queryByText("Chrome found the extension.")).toBeNull();
    expect(within(card()).queryByRole("heading", { name: STEPS[4] })).toBeNull();
    expect(desk.requests("browser.pairing.code")).toHaveLength(0);
    seen();
    expect(await within(card()).findByDisplayValue("ABCD2345")).toBeDefined();
    expect([1, 2, 3, 4].map(tick)).toEqual(["Step 1: done", "Step 2: done", "Step 3: done", "Step 4: done"]);
    status.unpairedConnected = false;
    act(() => pair({ ...chromeOf(app.clock.now().toISOString()), id: "0199aa00-0000-4000-8000-000000000042", name: "Personal Chrome" }));
    await waitFor(() => expect(tick(5)).toBe("Step 5: done"));
    expect([1, 2, 3, 4].map(tick)).toEqual(["Step 1: done", "Step 2: done", "Step 3: done", "Step 4: done"]);
    expect(within(card()).queryByRole("textbox", { name: "Pairing code" })).toBeNull();
  });
});
