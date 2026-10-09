import { act, screen, waitFor, within } from "@testing-library/react";
import { SETTINGS, type SettingsKey, type EnvironmentBinding } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Your machines (ADR 0025; #576, #1846): in Set up, the Your machines step
 * asks whether the computer it sets up is used from other devices
 * (setup-copy.md §5.4), and with "Also" says plainly whether they can reach
 * it; in Settings, a card per machine, This machine first, with how it is
 * reached and the two binding switches, the update keys under Advanced, the
 * links to Permissions and the access list, service down and unreachable,
 * Set up this machine and Forget. Driven through the harness over two
 * scripted environments: `desk`, this machine's, and `laptop`, paired,
 * which a test makes unreachable.
 */

/** desk's tailnet name and address, and the LAN addresses its machine holds. */
const DESK_BINDING: EnvironmentBinding = {
  tailnet: { address: "100.101.102.103", name: "desk.tail1234.ts.net" },
  lan: null,
  lanAddresses: ["192.168.1.20", "10.0.0.5"],
};

/** Loopback alone: no tailnet address was found, and no LAN address is bound. */
const LOOPBACK_ONLY: EnvironmentBinding = { tailnet: null, lan: null, lanAddresses: [] };

const TAILSCALE_WARNING = "No Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.";

const NO_SESSION = "No session is open. Choose one from the sidebar.";

/** The two environments as `given` scripts them over the preset. */
const environments = (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> }): ScriptedEnvironment[] => [
  { name: "desk", reach: "local", icon: "desktop", colour: "teal", status: { binding: DESK_BINDING }, ...given.desk },
  { name: "laptop", reach: "paired", icon: "laptop", colour: "amber", status: { binding: LOOPBACK_ONLY }, ...given.laptop },
];

/** What `environment.status` answers once `binding` is how the environment is reached. */
const statusWith = (binding: EnvironmentBinding) => () => ({ result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding } });

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The full checklist's rail of steps. */
const rail = () => within(checklist()).getByRole("navigation", { name: "Set up steps" });

/** The Your machines step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Your machines" });

/** The environment the full checklist checks, as its picker shows it. */
const picked = () => within(within(checklist()).getByRole("combobox", { name: "Setting up" })).getByRole("option", { selected: true }).textContent;

/** The full checklist on its first launch, its two environments as `given` scripts them, showing the Your machines step. */
const inSetUp = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: RenderOptions = {}) => {
  const app = await renderApp({ environments: environments(given) }, { firstLaunch: true, ...options });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(rail()).getByRole("button", { name: "Your machines" }));
  return app;
};

/** The step's question, by its choice's name. */
const choice = (name: string) => within(within(step()).getByRole("radiogroup", { name: "Use agent-harness from other devices?" })).getByRole("radio", { name });

/** Answers the step's question "Also from my other devices". */
const alsoFromOtherDevices = async (app: RenderedApp) => {
  await app.user.click(choice("Also from my other devices"));
  return within(step()).findByRole("region", { name: "How your devices reach this computer" });
};

/** The step's card with its More options open: the fold stays open for the window's life once opened, so it is opened only when shut. */
const moreOptions = async (app: RenderedApp) => {
  const fold = within(step()).getByRole("button", { name: "More options" });
  if (fold.getAttribute("aria-expanded") !== "true") await app.user.click(fold);
  return step();
};

const REACHABLE = "Your devices can reach this computer through Tailscale.";
const NOT_INSTALLED = "Your other devices cannot reach this computer yet. Install Tailscale here and on your other devices.";
const NOT_CONNECTED = "Tailscale is installed but not connected. Open Tailscale and sign in, then choose Check again.";
const NEEDS_RESTART = "Tailscale is ready. Restart agent-harness to use it.";
const ON_WIFI = "Devices on this Wi-Fi network can reach this computer. To reach it from anywhere else, use Tailscale.";

describe("the Your machines step in Set up", () => {
  it("asks whether agent-harness is used from other devices, Only on this computer chosen while nothing else is paired, with no machine cards, browser origins, sandbox list or grant note", async () => {
    await inSetUp();
    expect(within(step()).getByRole("heading", { name: "Use agent-harness from other devices?", level: 2 })).toBeDefined();
    await waitFor(() => expect(choice("Only on this computer").getAttribute("aria-checked")).toBe("true"));
    expect(choice("Also from my other devices").getAttribute("aria-checked")).toBe("false");
    expect(within(step()).queryByRole("region", { name: "How your devices reach this computer" })).toBeNull();
    expect(within(step()).queryByText(REACHABLE)).toBeNull();
    // Settings' parts are not on the Set up card: no card per machine, no origins, no sandbox list, no grant note.
    for (const part of ["desk", "laptop", "Reachability", "Browser origins", "Containment", "Pair another client", "Updates", "Connection"]) {
      expect(within(step()).queryByRole("region", { name: part }), part).toBeNull();
    }
    expect(within(step()).queryByRole("note", { name: "This client's grant" })).toBeNull();
    expect(within(step()).queryByText(/limited access/)).toBeNull();
    expect(within(step()).queryByRole("switch", { name: "Bind the tailnet address" })).toBeNull();
  });

  it("chooses Also from my other devices at first once another device is paired with the computer", async () => {
    await inSetUp({ desk: { clientSessions: [{ label: "phone", kind: "web" }] } });
    await waitFor(() => expect(choice("Also from my other devices").getAttribute("aria-checked")).toBe("true"));
    expect(await within(step()).findByText(REACHABLE)).toBeDefined();
  });

  it("with Also, says the computer is reachable through Tailscale, then offers Add a device", async () => {
    const app = await inSetUp();
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(REACHABLE)).toBeDefined();
    expect(within(reach).queryByRole("button", { name: "Get Tailscale" })).toBeNull();
    expect(within(step()).getByRole("region", { name: "Add a device" })).toBeDefined();
    // Only on this computer puts the reach and Add a device away again.
    await app.user.click(choice("Only on this computer"));
    expect(within(step()).queryByRole("region", { name: "How your devices reach this computer" })).toBeNull();
    expect(within(step()).queryByRole("region", { name: "Add a device" })).toBeNull();
  });

  it("says when Tailscale is not installed, Get Tailscale opens its download page, and Check again reads how the computer is reached again", async () => {
    const app = await inSetUp({ desk: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: false } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(NOT_INSTALLED)).toBeDefined();
    await app.user.click(within(reach).getByRole("button", { name: "Get Tailscale" }));
    expect(app.shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", "https://tailscale.com/download"]]);

    const desk = app.environment("desk");
    desk.wire.answer("environment.status", statusWith({ ...LOOPBACK_ONLY, tailscaleInstalled: true }));
    const reads = desk.requests("environment.status").length;
    await app.user.click(within(reach).getByRole("button", { name: "Check again" }));
    expect(await within(reach).findByText(NOT_CONNECTED)).toBeDefined();
    expect(desk.requests("environment.status")).toHaveLength(reads + 1);
    expect(within(reach).queryByText(NOT_INSTALLED)).toBeNull();
    expect(within(reach).queryByRole("button", { name: "Get Tailscale" })).toBeNull();

    desk.wire.answer("environment.status", statusWith(DESK_BINDING));
    await app.user.click(within(reach).getByRole("button", { name: "Check again" }));
    expect(await within(reach).findByText(REACHABLE)).toBeDefined();
  });

  it("says when how the computer is reached cannot be read, and Check again reads it again", async () => {
    const app = await renderApp({ environments: environments({ laptop: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: false } } } }) }, { firstLaunch: true });
    const laptop = app.environment("laptop");
    laptop.wire.answer("environment.status", () => ({ error: { code: "internal", message: "status-for-tests unavailable", data: {} } }));
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await app.user.click(within(await screen.findByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Your machines" }));
    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), "laptop");
    const reach = await within(step()).findByRole("region", { name: "How your devices reach this computer" });
    expect(await within(reach).findByRole("alert")).toBeDefined();
    expect(within(reach).getByText("agent-harness could not run the check. Choose Check again.")).toBeDefined();
    laptop.wire.answer("environment.status", statusWith({ ...LOOPBACK_ONLY, tailscaleInstalled: false }));
    await app.user.click(within(reach).getByRole("button", { name: "Check again" }));
    expect(await within(reach).findByText(NOT_INSTALLED)).toBeDefined();
  });

  it("says an environment too old to report Tailscale's installation is not reachable yet, never that Tailscale is installed", async () => {
    const app = await inSetUp({ desk: { status: { binding: LOOPBACK_ONLY } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(NOT_INSTALLED)).toBeDefined();
  });

  it("says Tailscale found since the start is used once agent-harness restarts, and Restart agent-harness on this computer drains it and starts it again", async () => {
    const app = await inSetUp({ desk: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true, tailnetFound: "100.101.102.103" } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(NEEDS_RESTART)).toBeDefined();
    expect(within(reach).queryByText("It is used from the next start.")).toBeNull();
    const desk = app.environment("desk");
    app.shell.answer("service.start", async () => {
      desk.wire.answer("environment.status", statusWith(DESK_BINDING));
      desk.discovery("ready");
    });
    await app.user.click(within(reach).getByRole("button", { name: "Restart agent-harness" }));
    await waitFor(() => expect(desk.requests("environment.drain")).toHaveLength(1));
    expect(await within(reach).findByText("desk is restarting.")).toBeDefined();
    expect(within(reach).queryByRole("button", { name: "Restart agent-harness" })).toBeNull();
    // The drain ends with the service stopping: nothing answers on this machine until the start.
    desk.discovery("nothing");
    desk.server.drop();
    const phase = () => app.runtime.projections.environments.read().find((view) => view.environmentId === desk.environmentId)?.phase;
    await waitFor(() => expect(phase()).not.toBe("ready"));
    // While the drain holds the service open, the line still says it restarts, not the Tailscale line read before.
    expect(within(step()).getByText("desk is restarting.")).toBeDefined();
    expect(within(step()).queryByText(NEEDS_RESTART)).toBeNull();
    expect(within(step()).queryByText("It is used from the next start.")).toBeNull();
    // The first try again finds nothing answering on this machine: its service is down, and the restart starts it.
    act(() => app.clock.advance(5_000));
    await waitFor(() => expect(app.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1));
    expect(await within(step()).findByText(REACHABLE, {}, { timeout: 5_000 })).toBeDefined();
    expect(within(step()).queryByText("desk is restarting.")).toBeNull();
  });

  it("says agent-harness did not restart on this computer when the start after the drain fails, with the refusal in Details", async () => {
    const app = await inSetUp({ desk: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true, tailnetFound: "100.101.102.103" } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(NEEDS_RESTART)).toBeDefined();
    const desk = app.environment("desk");
    app.shell.answer("service.start", async () => { throw new Error("the service manager refused the start"); });
    await app.user.click(within(reach).getByRole("button", { name: "Restart agent-harness" }));
    await waitFor(() => expect(desk.requests("environment.drain")).toHaveLength(1));
    desk.discovery("nothing");
    desk.server.drop();
    const phase = () => app.runtime.projections.environments.read().find((view) => view.environmentId === desk.environmentId)?.phase;
    await waitFor(() => expect(phase()).not.toBe("ready"));
    act(() => app.clock.advance(5_000));
    await waitFor(() => expect(app.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1));
    expect(await within(step()).findByText("agent-harness did not restart on desk.")).toBeDefined();
    // Restart cannot run while nothing answers: the notice points at the checklist's Start, which can.
    expect(within(step()).getByText("Choose Start to try again.")).toBeDefined();
    expect(within(step()).queryByText("Choose Restart agent-harness to try again.")).toBeNull();
    expect(within(step()).queryByText("desk is restarting.")).toBeNull();
    app.shell.answer("service.start", async () => {
      desk.wire.answer("environment.status", statusWith(DESK_BINDING));
      desk.discovery("ready");
    });
    await app.user.click(within(checklist()).getByRole("button", { name: "Start" }));
    expect(await within(step()).findByText(REACHABLE, {}, { timeout: 5_000 })).toBeDefined();
    // Running again, the computer no longer carries the failed start's notice.
    expect(within(step()).queryByText("agent-harness did not restart on desk.")).toBeNull();
  });

  it("says a paired computer uses Tailscale from its next start, with no restart from this app", async () => {
    const app = await inSetUp({ laptop: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true, tailnetFound: "100.64.0.9" } } } });
    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), "laptop");
    await waitFor(() => expect(picked()).toBe("laptop"));
    const reach = await within(step()).findByRole("region", { name: "How your devices reach this computer" });
    expect(choice("Also from my other devices").getAttribute("aria-checked")).toBe("true");
    expect(await within(reach).findByText(NEEDS_RESTART)).toBeDefined();
    expect(within(reach).getByText("It is used from the next start.")).toBeDefined();
    expect(within(reach).queryByRole("button", { name: "Restart agent-harness" })).toBeNull();
  });

  it("says Use Tailscale is off in More options when that, not Tailscale, keeps other devices away", async () => {
    const app = await inSetUp({ desk: { settings: { "network.bindTailnet": false }, status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true, tailnetFound: "100.101.102.103" } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText("Use Tailscale is off in More options, so your other devices cannot reach this computer.")).toBeDefined();
    expect(within(reach).queryByText(NEEDS_RESTART)).toBeNull();
  });

  it.each([
    ["Use Tailscale is off", { "network.bindTailnet": false, "network.bindLan": "192.168.1.20" }, {}],
    ["Tailscale is not installed", { "network.bindLan": "192.168.1.20" }, { tailscaleInstalled: false }],
  ] as const)("says devices on the Wi-Fi network reach the computer once its local network address is bound, where %s", async (_case, settings, tailscale) => {
    const app = await inSetUp({ desk: { settings, status: { binding: { ...LOOPBACK_ONLY, ...tailscale, lan: "192.168.1.20", lanAddresses: ["192.168.1.20"] } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText(ON_WIFI)).toBeDefined();
    expect(reach.getAttribute("data-reach-verdict")).toBe("wifi");
    expect(within(reach).queryByText(/cannot reach this computer/)).toBeNull();
    expect(within(reach).queryByRole("button", { name: "Get Tailscale" })).toBeNull();
    expect(within(reach).getByRole("button", { name: "Check again" })).toBeDefined();
  });

  it("says on Windows, before the first start that uses Tailscale, which button to press when Windows asks", async () => {
    const app = await inSetUp({ desk: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true, tailnetFound: "100.101.102.103", firewallAsksOnce: true } } } });
    const reach = await alsoFromOtherDevices(app);
    expect(await within(reach).findByText("Windows asks once whether Node.js may accept connections. Keep Private networks ticked and choose Allow access.")).toBeDefined();
  });

  it("keeps the name, icon and colour, Use Tailscale, the Wi-Fi network switch, the update switch and channel, and All settings for this computer in More options", async () => {
    const app = await inSetUp();
    const desk = app.environment("desk");
    const more = await moreOptions(app);
    expect(within(more).getByRole("textbox", { name: "Name" })).toBeDefined();
    expect(within(more).getByRole("combobox", { name: "Icon" })).toBeDefined();
    expect(within(more).getByRole("combobox", { name: "Colour" })).toBeDefined();

    // Use Tailscale is preset on, which says what on means, never that Tailscale works.
    const tailscale = await within(more).findByRole("switch", { name: "Use Tailscale" });
    expect(tailscale.getAttribute("aria-checked")).toBe("true");
    expect(within(more).getByText("On: agent-harness uses Tailscale whenever it is installed.")).toBeDefined();
    await app.user.click(tailscale);
    await waitFor(() => expect(desk.settings()["network.bindTailnet"]).toBe(false));

    const wifi = within(more).getByRole("switch", { name: "Also allow devices on this Wi-Fi network" });
    expect(within(more).getByText("Anyone on this network could try to connect. They still need a pairing code.")).toBeDefined();
    expect(wifi.getAttribute("aria-checked")).toBe("false");
    await app.user.click(wifi);
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBe("192.168.1.20"));
    await app.user.click(wifi);
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBeNull());

    const automatic = within(more).getByRole("switch", { name: "Update automatically" });
    await app.user.click(automatic);
    await waitFor(() => expect(desk.settings()["updates.autoUpdate"]).toBe(!(SETTINGS["updates.autoUpdate"].preset as boolean)));
    const channel = within(more).getByRole("combobox", { name: "Channel" });
    expect(within(channel).getAllByRole("option").map((option) => option.textContent)).toEqual(["Stable", "Beta"]);
    await app.user.selectOptions(channel, "beta");
    await waitFor(() => expect(desk.settings()["updates.channel"]).toBe("beta"));

    // The step's status has its own Open in Settings with the same hint: this one is beside All settings.
    const allSettings = within(more).getByRole("button", { name: "All settings for this computer" });
    expect(within(allSettings.parentElement as HTMLElement).getByText("Leaves Set up")).toBeDefined();
    await app.user.click(allSettings);
    expect(screen.queryByRole("region", { name: "Set up" })).toBeNull();
    const settings = screen.getByRole("region", { name: "Settings" });
    expect(within(settings).getByRole("region", { name: "Your machines" })).toBeDefined();
    expect(within(within(settings).getByRole("region", { name: "Your machines" })).getByRole("region", { name: "desk" })).toBeDefined();
  });

  it("disables the Wi-Fi network switch with its reason in words on a computer with no local network address", async () => {
    const app = await inSetUp({ desk: { status: { binding: { ...DESK_BINDING, lanAddresses: [] } } } });
    const more = await moreOptions(app);
    expect((await within(more).findByRole("switch", { name: "Also allow devices on this Wi-Fi network" })).hasAttribute("disabled")).toBe(true);
    expect(within(more).getByText("This computer is not on a local network.")).toBeDefined();
  });

  it("says a limited pairing in one line, whose What does this mean? opens the limited-access sheet, its switches held", async () => {
    const app = await inSetUp({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] } });
    await app.user.selectOptions(within(checklist()).getByRole("combobox", { name: "Setting up" }), "laptop");
    expect(await within(step()).findByText("This app has limited access to laptop.")).toBeDefined();
    expect(within(step()).queryByRole("note", { name: "This client's grant" })).toBeNull();
    await app.user.click(within(step()).getByRole("button", { name: "What does this mean?" }));
    expect(await screen.findByRole("dialog", { name: "This phone's access" })).toBeDefined();
    await app.user.keyboard("{Escape}");
    const more = await moreOptions(app);
    expect((await within(more).findByRole("switch", { name: "Use Tailscale" })).hasAttribute("disabled")).toBe(true);
  });

  it("offers Set up this machine for a computer Add a device pairs, which switches the checklist's picker to it and opens its first step needing attention", async () => {
    const app = await inSetUp({
      laptop: {
        reach: "unpaired",
        setup: { forges: { state: "needs-attention", reason: "work's token has expired.", failing: ["forges.verified"], actions: [] } },
      },
    });
    expect(picked()).toBe("desk");
    await alsoFromOtherDevices(app);
    const form = within(within(step()).getByRole("region", { name: "Add a machine" })).getByRole("form", { name: "Pair by link" });
    act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
    await app.user.paste(app.environment("laptop").wire.link);
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    expect(await within(step()).findByText("Paired with laptop: set it up now?")).toBeDefined();

    await app.user.click(within(step()).getByRole("button", { name: "Set up this machine" }));
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step"));
    expect(picked()).toBe("laptop");
    expect(app.environment("laptop").requests("setup.check").length).toBeGreaterThan(0);
  });
});

/** Settings, open on Your machines, as a person opens it: Mod+, then its row on the rail. */
const settings = () => screen.getByRole("region", { name: "Settings" });

/** Settings' Your machines pane. */
const pane = () => within(settings()).getByRole("region", { name: "Your machines" });

/** One machine's card on it, by its name. */
const card = (name: string) => within(pane()).getByRole("region", { name });

/** A part of a machine's card, by its heading. */
const part = (name: string, title: string) => within(card(name)).getByRole("region", { name: title });

/** The window with its two environments as `given` scripts them, Settings open on Your machines. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: RenderOptions = {}) => {
  const app = await renderApp({ environments: environments(given) }, options);
  await screen.findByText(NO_SESSION);
  await app.user.keyboard("{Control>},{/Control}");
  await app.user.click(within(within(await screen.findByRole("region", { name: "Settings" })).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Your machines" }));
  return app;
};

/** The environment Settings edits, as its picker shows it. */
const editing = () => within(within(settings()).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent;

describe("the Your machines cards in Settings", () => {
  it("draws a card per machine, this machine's first, each saying how it is reached: its tailnet name and address, or the Tailscale warning with Check again", async () => {
    const app = await opened();
    await app.runtime.connections.setOrder([app.environment("laptop").environmentId, app.environment("desk").environmentId]);

    expect(
      within(pane())
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
        .filter((name) => name !== "Add a machine"),
    ).toEqual(["desk", "laptop"]);
    expect(await within(part("desk", "Reachability")).findByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
    expect(within(part("desk", "Reachability")).queryByText(TAILSCALE_WARNING)).toBeNull();

    // Loopback alone is a standing notice on the card, never a failure.
    expect(await within(part("laptop", "Reachability")).findByText(TAILSCALE_WARNING)).toBeDefined();

    // Check again reads again how laptop is reached: Tailscale installed and laptop started again since.
    const laptop = app.environment("laptop");
    laptop.wire.answer("environment.status", () => ({
      result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding: { ...LOOPBACK_ONLY, tailnet: { address: "100.64.0.9", name: null } } },
    }));
    const reads = laptop.requests("environment.status").length;
    await app.user.click(within(part("laptop", "Reachability")).getByRole("button", { name: "Check again" }));
    expect(await within(part("laptop", "Reachability")).findByText("Reachable on the tailnet at 100.64.0.9.")).toBeDefined();
    expect(laptop.requests("environment.status")).toHaveLength(reads + 1);
    expect(within(part("laptop", "Reachability")).queryByText(TAILSCALE_WARNING)).toBeNull();
  });

  it("distinguishes an installed but unreadable Tailscale from no installation on Check again", async () => {
    const app = await opened({ laptop: { status: { binding: { ...LOOPBACK_ONLY, tailscaleInstalled: true } } } });
    const reachability = () => part("laptop", "Reachability");
    expect(await within(reachability()).findByText("Tailscale is installed, but its address could not be read. This machine is reachable only from itself. Check that Tailscale is running and signed in, then check again.")).toBeDefined();
    app.environment("laptop").wire.answer("environment.status", () => ({ result: {
      readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false,
      binding: { ...LOOPBACK_ONLY, tailscaleInstalled: false },
    } }));
    await app.user.click(within(reachability()).getByRole("button", { name: "Check again" }));
    expect(await within(reachability()).findByText("Tailscale is not installed. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.")).toBeDefined();
  });

  it("says in place of the Tailscale warning that a Tailscale address installed since is found and binds at the machine's next start, until Check again finds it bound", async () => {
    const app = await opened();
    const laptop = app.environment("laptop");
    const reachability = () => part("laptop", "Reachability");
    const statusSays = (binding: EnvironmentBinding) =>
      laptop.wire.answer("environment.status", () => ({ result: { readiness: "ready", activity: { state: "idle" }, updatesManagedOutside: false, binding } }));
    expect(await within(reachability()).findByText(TAILSCALE_WARNING)).toBeDefined();

    // Tailscale installed since laptop started: its address is found, not bound.
    statusSays({ ...LOOPBACK_ONLY, tailnetFound: "100.64.0.9" });
    await app.user.click(within(reachability()).getByRole("button", { name: "Check again" }));
    expect(await within(reachability()).findByText("Tailscale address 100.64.0.9 found: laptop binds it at its next start.")).toBeDefined();
    expect(within(reachability()).queryByText(TAILSCALE_WARNING)).toBeNull();

    // laptop started again: Check again finds the address bound.
    statusSays({ ...LOOPBACK_ONLY, tailnet: { address: "100.64.0.9", name: null } });
    await app.user.click(within(reachability()).getByRole("button", { name: "Check again" }));
    expect(await within(reachability()).findByText("Reachable on the tailnet at 100.64.0.9.")).toBeDefined();
    expect(within(reachability()).queryByText(/^Tailscale address/)).toBeNull();
  });

  it("says beforehand, on a Windows machine, that Windows asks once and which button to press, and says nothing of it elsewhere (ticket 1910)", async () => {
    await opened({ desk: { status: { binding: { ...DESK_BINDING, firewallAsksOnce: true } } } });
    const firewall =
      "Windows asks once, at the first start that binds the tailnet or a LAN address, whether Node.js may accept connections: keep Private networks ticked and choose Allow access, which may ask for an administrator's approval. Updates do not ask again.";
    expect(await within(part("desk", "Reachability")).findByText(firewall)).toBeDefined();
    expect(within(part("laptop", "Reachability")).queryByText(firewall)).toBeNull();
  });

  it("defaults to the first private IPv4 choice and warns when an IPv6 address is selected", async () => {
    const app = await opened({ desk: { status: { binding: { ...DESK_BINDING, lanAddresses: ["192.168.1.20", "fd00::20", "2001:db8::1", "2001:db8::2"] } } } });
    const reachability = () => part("desk", "Reachability");
    expect(within(reachability()).getByRole("switch", { name: "Bind 192.168.1.20 on the LAN" })).toBeDefined();
    const choice = within(reachability()).getByRole("combobox", { name: "LAN address" });
    expect(within(choice).getAllByRole("option").map((option) => option.textContent)).toEqual(["192.168.1.20", "fd00::20", "2001:db8::1", "2001:db8::2"]);
    expect(within(reachability()).queryByText("An IPv6 address may change. If it does, choose an address this machine still holds.")).toBeNull();
    await app.user.selectOptions(choice, "2001:db8::1");
    expect(within(reachability()).getByText("An IPv6 address may change. If it does, choose an address this machine still holds.")).toBeDefined();
    await app.user.click(within(reachability()).getByRole("switch", { name: "Bind 2001:db8::1 on the LAN" }));
    await waitFor(() => expect(app.environment("desk").requests("settings.update").at(-1)?.params).toMatchObject({ values: { "network.bindLan": "2001:db8::1" } }));
  });

  it("names the LAN address its switch would bind with the warning, writes network.bindLan and network.bindTailnet each through its own switch, and says both apply at the next start", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const reachability = () => part("desk", "Reachability");
    const lan = () => within(reachability()).getByRole("switch", { name: "Bind 192.168.1.20 on the LAN" });
    expect(await within(reachability()).findByText("Anyone on this network could try to reach it; it still needs a paired client.")).toBeDefined();
    expect(within(reachability()).getByText("Both switches apply at desk's next start.")).toBeDefined();
    expect(lan().getAttribute("aria-checked")).toBe("false");

    await app.user.click(lan());
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBe("192.168.1.20"));
    expect(lan().getAttribute("aria-checked")).toBe("true");
    // The machine holds two: choosing the other binds it instead.
    await app.user.selectOptions(within(reachability()).getByRole("combobox", { name: "LAN address" }), "10.0.0.5");
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBe("10.0.0.5"));
    const bound = within(reachability()).getByRole("switch", { name: "Bind 10.0.0.5 on the LAN" });
    await app.user.click(bound);
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBeNull());

    const tailnet = within(reachability()).getByRole("switch", { name: "Bind the tailnet address" });
    expect(tailnet.getAttribute("aria-checked")).toBe("true");
    await app.user.click(tailnet);
    await waitFor(() => expect(desk.settings()["network.bindTailnet"]).toBe(false));
    expect(desk.requests("settings.update").map((request) => request.params["values"])).toEqual([
      { "network.bindLan": "192.168.1.20" },
      { "network.bindLan": "10.0.0.5" },
      { "network.bindLan": null },
      { "network.bindTailnet": false },
    ]);
    // What desk binds now is its start's, until the next.
    expect(within(reachability()).getByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
  });

  it("lays out the tailnet switch's row as the LAN switch's, its label right after the switch, and a click on either label toggles its switch", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const reachability = () => part("desk", "Reachability");
    const tailnet = await within(reachability()).findByRole("switch", { name: "Bind the tailnet address" });
    const lan = within(reachability()).getByRole("switch", { name: "Bind 192.168.1.20 on the LAN" });
    // Each switch's label (icon and words) follows it in a wash box laid out alike, never pushed to the row's far end (#1728).
    for (const control of [tailnet, lan]) expect(control.nextElementSibling?.id).toBe(control.getAttribute("aria-labelledby"));
    expect(tailnet.parentElement?.className).toBe(lan.parentElement?.className);

    await app.user.click(within(reachability()).getByText("Bind the tailnet address"));
    await waitFor(() => expect(desk.settings()["network.bindTailnet"]).toBe(false));
    expect(tailnet.getAttribute("aria-checked")).toBe("false");
    await app.user.click(within(reachability()).getByText("Bind 192.168.1.20 on the LAN"));
    await waitFor(() => expect(desk.settings()["network.bindLan"]).toBe("192.168.1.20"));
  });

  it("keeps the idle window, the deferral cap and the pin under Advanced, beside the update controls, each written through updates.settings.set", async () => {
    const app = await opened();
    const laptop = app.environment("laptop");
    const updates = () => part("laptop", "Updates");
    const field = (key: SettingsKey) => within(updates()).getByRole("group", { name: SETTINGS[key].label });
    expect(await within(updates()).findByRole("combobox", { name: "Channel" })).toBeDefined();
    expect(within(updates()).getByRole("button", { name: "Update now" })).toBeDefined();
    expect(within(updates()).queryByRole("group", { name: "Quiet time before updates in minutes" })).toBeNull();

    await app.user.click(within(updates()).getByRole("button", { name: "Advanced" }));
    const advanced = ["updates.pinnedVersion", "updates.idleWindowMinutes", "updates.deferralCapHours"] as const;
    for (const key of advanced) expect(field(key)).toBeDefined();
    expect(within(updates()).getAllByRole("group")).toHaveLength(advanced.length);
    const save = async (key: SettingsKey, typed: string) => {
      const box = await within(field(key)).findByRole("textbox");
      await app.user.clear(box);
      await app.user.type(box, typed);
      await app.user.click(within(field(key)).getByRole("button", { name: "Save" }));
    };
    await save("updates.idleWindowMinutes", "15");
    await waitFor(() => expect(laptop.settings()["updates.idleWindowMinutes"]).toBe(15));
    await save("updates.deferralCapHours", "48");
    await waitFor(() => expect(laptop.settings()["updates.deferralCapHours"]).toBe(48));
    await save("updates.pinnedVersion", "0.5.0");
    await waitFor(() => expect(laptop.settings()["updates.pinnedVersion"]).toBe("0.5.0"));
    expect(laptop.requests("updates.settings.set").map((request) => request.params["values"])).toEqual([
      { "updates.idleWindowMinutes": 15 },
      { "updates.deferralCapHours": 48 },
      { "updates.pinnedVersion": "0.5.0" },
    ]);
    expect(laptop.requests("settings.update")).toEqual([]);
  });

  it("links containment availability to Permissions on its machine, and Manage access opens that machine's access list", async () => {
    const app = await opened();
    await app.user.click(within(part("laptop", "Containment")).getByRole("button", { name: "Open Permissions" }));
    expect(await within(settings()).findByRole("region", { name: "Permissions" })).toBeDefined();
    expect(editing()).toBe("laptop");

    await app.user.click(within(within(settings()).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Your machines" }));
    await app.user.click(within(part("laptop", "Pair another client")).getByRole("button", { name: "Manage access" }));
    const access = await within(settings()).findByRole("region", { name: "Access" });
    expect(within(within(access).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent).toBe("laptop");
  });

  it("shows an unreachable machine's card as last read with since when, and this machine's service down with Start", async () => {
    const app = await opened();
    expect(await within(part("laptop", "Reachability")).findByText(TAILSCALE_WARNING)).toBeDefined();
    const laptop = app.environment("laptop");
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(card("laptop")).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    // Its reachability and settings as this window last read them, read-only.
    expect(within(part("laptop", "Reachability")).getByText(TAILSCALE_WARNING)).toBeDefined();
    expect(within(part("laptop", "Reachability")).getByRole("button", { name: "Check again" }).hasAttribute("disabled")).toBe(true);
    expect(within(part("laptop", "Reachability")).getByRole("switch", { name: "Bind the tailnet address" }).hasAttribute("disabled")).toBe(true);

    const desk = app.environment("desk");
    expect(await within(part("desk", "Reachability")).findByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
    app.shell.answer("service.start", async () => desk.discovery("ready"));
    desk.discovery("nothing");
    desk.server.drop();
    // The first try again finds nothing answering on this machine: its service is down.
    expect(await within(card("desk")).findByText(/^Unreachable since/)).toBeDefined();
    act(() => app.clock.advance(5_000));
    expect(await within(card("desk")).findByText(/^Service down since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    expect(within(part("desk", "Reachability")).getByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
    await app.user.click(within(card("desk")).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(within(card("desk")).queryByText(/^Service down/)).toBeNull());
    expect(app.shell.calls.filter(([member]) => member === "service.start")).toHaveLength(1);
  });

  it("says on this machine's card that macOS asks for its stored key while an update's start waits on it", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    expect(await within(part("desk", "Reachability")).findByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
    app.shell.answer("credentialAccess.read", async () => ({ version: "0.1.3", pid: 4242, since: "2026-10-06T10:34:01.000Z", state: "waiting", live: true }));
    // The launcher switched to the new version, whose start waits on the prompt: nothing answers on this machine.
    desk.discovery("nothing");
    desk.server.drop();
    const prompt = "macOS is asking to let agent-harness use its stored key: answer “Always Allow” in its dialog to finish the update to 0.1.3.";
    expect(await within(card("desk")).findByText(prompt)).toBeDefined();
  });

  it("offers Set up this machine on the card Add a machine makes, which opens the checklist on it at its first step needing attention", async () => {
    const app = await opened({
      laptop: {
        reach: "unpaired",
        setup: { forges: { state: "needs-attention", reason: "work's token has expired.", failing: ["forges.verified"], actions: [] } },
      },
    });
    const form = within(within(pane()).getByRole("region", { name: "Add a machine" })).getByRole("form", { name: "Pair by link" });
    act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
    await app.user.paste(app.environment("laptop").wire.link);
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    expect(await within(pane()).findByText("Paired with laptop: set it up now?")).toBeDefined();

    await app.user.click(within(card("laptop")).getByRole("button", { name: "Set up this machine" }));
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step"));
    expect(picked()).toBe("laptop");
    expect(app.environment("laptop").requests("setup.check").length).toBeGreaterThan(0);
  });

  it("forgets a reachable machine from its card, revoking this client's session there and saying so; this machine's card has no Forget", async () => {
    const app = await opened();
    expect(within(card("desk")).queryByRole("button", { name: "Forget…" })).toBeNull();
    const laptop = app.environment("laptop");
    const session = laptop.wire.credential()?.clientSessionId;
    await app.user.click(within(card("laptop")).getByRole("button", { name: "Forget…" }));
    const asking = screen.getByRole("dialog", { name: "Forget laptop?" });
    expect(within(asking).getByText("This client forgets laptop and revokes its client session there.")).toBeDefined();
    await app.user.click(within(asking).getByRole("button", { name: "Forget" }));
    expect(await within(pane()).findByText("Forgot laptop and revoked this client's session there.")).toBeDefined();
    expect(within(pane()).queryByRole("region", { name: "laptop" })).toBeNull();
    expect(laptop.requests("access.sessions.revoke").map((request) => request.params["clientSessionId"])).toEqual([session]);
  });

  it("forgets an unreachable machine here alone, saying its session there stays until it is revoked from that machine's access list", async () => {
    const app = await opened();
    const laptop = app.environment("laptop");
    expect(await within(part("laptop", "Reachability")).findByText(TAILSCALE_WARNING)).toBeDefined();
    laptop.discovery("nothing");
    laptop.server.drop();
    expect(await within(card("laptop")).findByText(/^Unreachable since/)).toBeDefined();
    await app.user.click(within(card("laptop")).getByRole("button", { name: "Forget…" }));
    const asking = screen.getByRole("dialog", { name: "Forget laptop?" });
    expect(
      within(asking).getByText("laptop cannot be reached now, so this client forgets it here, and its client session there stays until it is revoked from that machine's access list."),
    ).toBeDefined();
    await app.user.click(within(asking).getByRole("button", { name: "Forget" }));
    expect(await within(pane()).findByText("Forgot laptop. laptop could not be reached, so this client's session there is still live: revoke it from another client.")).toBeDefined();
    expect(within(pane()).queryByRole("region", { name: "laptop" })).toBeNull();
    expect(laptop.requests("access.sessions.revoke")).toEqual([]);
  });

  it("is read-only without admin, the switches and the settings under Advanced among it, with the capability's line said once", async () => {
    const app = await opened({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] } });
    expect(await within(card("laptop")).findByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toBeDefined();
    expect(within(card("laptop")).getAllByText(/^Read-only:/)).toHaveLength(1);
    const reachability = part("laptop", "Reachability");
    expect(await within(reachability).findByRole("switch", { name: "Bind the tailnet address" })).toBeDefined();
    for (const control of within(reachability).getAllByRole("switch")) expect(control.hasAttribute("disabled"), control.getAttribute("aria-labelledby") ?? "").toBe(true);
    await app.user.click(within(part("laptop", "Updates")).getByRole("button", { name: "Advanced" }));
    for (const key of ["updates.pinnedVersion", "updates.idleWindowMinutes", "updates.deferralCapHours"] as const) {
      expect(within(within(part("laptop", "Updates")).getByRole("group", { name: SETTINGS[key].label })).getByRole("textbox").hasAttribute("disabled"), key).toBe(true);
    }

    expect(within(card("desk")).queryByText(/^Read-only:/)).toBeNull();
    expect(within(part("desk", "Reachability")).getByRole("switch", { name: "Bind the tailnet address" }).hasAttribute("disabled")).toBe(false);
  });
});
