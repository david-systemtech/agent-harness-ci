import { act, screen, waitFor, within } from "@testing-library/react";
import { SETTINGS, type SettingsKey, type EnvironmentBinding } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Your machines card in Set up (the Set up specification, "3. Your
 * machines"; ADR 0025; #576): a card per machine, This machine first, with
 * how it is reached and the two binding switches, the update keys under
 * Advanced, the links to the Permissions step and the access list, service
 * down and unreachable, Set up this machine and Forget. Driven through the
 * harness's full checklist over two scripted environments: `desk`, this
 * machine's, and `laptop`, paired, which a test makes unreachable.
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

/** Set up as the whole window. */
const checklist = () => screen.getByRole("region", { name: "Set up" });

/** The full checklist on its first launch, its two environments as `given` scripts them, showing the Your machines step. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: RenderOptions = {}) => {
  const app = await renderApp(
    {
      environments: [
        { name: "desk", reach: "local", icon: "desktop", colour: "teal", status: { binding: DESK_BINDING }, ...given.desk },
        { name: "laptop", reach: "paired", icon: "laptop", colour: "amber", status: { binding: LOOPBACK_ONLY }, ...given.laptop },
      ],
    },
    { firstLaunch: true, ...options },
  );
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(rail()).getByRole("button", { name: "Your machines" }));
  return app;
};

/** The full checklist's rail of steps. */
const rail = () => within(checklist()).getByRole("navigation", { name: "Set up steps" });

/** The Your machines step's card. */
const step = () => within(checklist()).getByRole("region", { name: "Your machines" });

/** One machine's card on it, by its name. */
const card = (name: string) => within(step()).getByRole("region", { name });

/** A part of a machine's card, by its heading. */
const part = (name: string, title: string) => within(card(name)).getByRole("region", { name: title });

/** The environment the full checklist checks, as its picker shows it. */
const picked = () => within(within(checklist()).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent;

describe("the Your machines card in Set up", () => {
  it("draws a card per machine, this machine's first, each saying how it is reached: its tailnet name and address, or the Tailscale warning with Check again", async () => {
    const app = await opened();
    await app.runtime.connections.setOrder([app.environment("laptop").environmentId, app.environment("desk").environmentId]);

    expect(
      within(step())
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
        .filter((name) => name !== "Add a machine"),
    ).toEqual(["desk", "laptop"]);
    expect(await within(part("desk", "Reachability")).findByText("Reachable on the tailnet at desk.tail1234.ts.net (100.101.102.103).")).toBeDefined();
    expect(within(part("desk", "Reachability")).queryByText(TAILSCALE_WARNING)).toBeNull();

    // Loopback alone is a standing notice on the card, never a failure: the step stays done.
    expect(await within(part("laptop", "Reachability")).findByText(TAILSCALE_WARNING)).toBeDefined();
    expect(within(rail()).getByRole("img", { name: "Your machines: Done" })).toBeDefined();

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
    expect(within(rail()).getByRole("img", { name: "Your machines: Done" })).toBeDefined();

    // laptop started again: Check again finds the address bound.
    statusSays({ ...LOOPBACK_ONLY, tailnet: { address: "100.64.0.9", name: null } });
    await app.user.click(within(reachability()).getByRole("button", { name: "Check again" }));
    expect(await within(reachability()).findByText("Reachable on the tailnet at 100.64.0.9.")).toBeDefined();
    expect(within(reachability()).queryByText(/^Tailscale address/)).toBeNull();
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

  it("links containment availability to the Permissions step on its machine, and Manage access opens that machine's access list", async () => {
    const app = await opened();
    await app.user.click(within(part("laptop", "Containment")).getByRole("button", { name: "Open Permissions" }));
    expect(within(rail()).getByRole("button", { name: "Permissions" }).getAttribute("aria-current")).toBe("step");
    expect(within(checklist()).getByRole("region", { name: "Permissions" })).toBeDefined();
    expect(picked()).toBe("laptop");

    await app.user.click(within(rail()).getByRole("button", { name: "Your machines" }));
    await app.user.click(within(part("laptop", "Pair another client")).getByRole("button", { name: "Manage access" }));
    expect(screen.queryByRole("region", { name: "Set up" })).toBeNull();
    const access = within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: "Access" });
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

  it("offers Set up this machine on the card Add a machine makes, which switches the checklist's picker to it and opens its first step needing attention", async () => {
    const app = await opened({
      laptop: {
        reach: "unpaired",
        setup: { forges: { state: "needs-attention", reason: "work's token has expired.", failing: ["forges.verified"], actions: [] } },
      },
    });
    expect(picked()).toBe("desk");
    const form = within(within(step()).getByRole("region", { name: "Add a machine" })).getByRole("form", { name: "Pair by link" });
    act(() => within(form).getByRole("textbox", { name: "Pairing link" }).focus());
    await app.user.paste(app.environment("laptop").wire.link);
    await app.user.click(within(form).getByRole("button", { name: "Pair" }));
    expect(await within(step()).findByText("Paired with laptop: set it up now?")).toBeDefined();

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
    expect(await within(step()).findByText("Forgot laptop and revoked this client's session there.")).toBeDefined();
    expect(within(step()).queryByRole("region", { name: "laptop" })).toBeNull();
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
    expect(await within(step()).findByText("Forgot laptop. laptop could not be reached, so this client's session there is still live: revoke it from another client.")).toBeDefined();
    expect(within(step()).queryByRole("region", { name: "laptop" })).toBeNull();
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
