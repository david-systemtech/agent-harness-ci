import { act, screen, waitFor, within } from "@testing-library/react";
import { clockTime } from "@agent-harness/client-runtime";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { SETTINGS, PROTOCOL_VERSION } from "@agent-harness/contracts";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Your machines (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0025, ADR 0027; #416): a card per connection, the local
 * environment first, each with its name, its icon in its colour, its
 * containment availability, a pairing code for another client and the
 * connection registry's verbs. Driven through the harness over two scripted
 * environments: `desk`, this machine's, and `laptop`, paired, which a test
 * makes unreachable.
 */

const LOCAL_IDLE_UPDATE = {
  state: "waiting", updateId: "0199aa00-0000-4000-8000-00000000000a", toVersion: "0.6.0", source: "desktop",
  since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null,
  waitsOn: { reason: "recent-activity", until: "2026-09-24T00:10:00.000Z" },
} as const;

/** The window with its two environments ready and no session open; each as `given` scripts it. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}, options: RenderOptions = {}) => {
  const app = await renderApp(
    {
      environments: [
        { name: "desk", reach: "local", icon: "desktop", colour: "teal", ...given.desk },
        { name: "laptop", reach: "paired", icon: "laptop", colour: "amber", ...given.laptop },
      ],
    },
    options,
  );
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Opens Settings on Your machines, as a person does: Mod+, then its row on the rail. */
const openMachines = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  const settings = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Your machines" }));
  return within(settings).getByRole("region", { name: "Your machines" });
};

/** The environments' cards of the pane, each by its heading: Add a machine, the card after them, is none of them. */
const cardNames = (pane: HTMLElement) =>
  within(pane)
    .getAllByRole("heading", { level: 3 })
    .map((heading) => heading.textContent)
    .filter((name) => name !== "Add a machine");

/** One environment's card, by its name. */
const card = (pane: HTMLElement, name: string) => within(pane).getByRole("region", { name });

describe("Your machines", () => {
  it("shows a card per connection, the local environment first though another is primary, each with its name and its icon in its colour", async () => {
    const app = await opened();
    await app.runtime.connections.setOrder([app.environment("laptop").environmentId, app.environment("desk").environmentId]);
    const pane = await openMachines(app);

    expect(cardNames(pane)).toEqual(["desk", "laptop"]);
    const desk = card(pane, "desk");
    const mark = within(desk).getByRole("img", { name: "desktop, teal" });
    expect(mark.tagName).toBe("svg");
    expect(mark.style.color).toBe("var(--environment-teal)");
    // The icon is drawn, not written beside the name.
    expect(within(desk).getByRole("heading", { level: 3 }).parentElement?.textContent).not.toContain("desktop");
    expect(within(desk).getByText("This machine")).toBeDefined();
    expect(within(card(pane, "laptop")).getByRole("img", { name: "laptop, amber" }).style.color).toBe("var(--environment-amber)");
    expect(within(card(pane, "laptop")).getByText("Primary")).toBeDefined();
    expect(within(desk).queryByText("Primary")).toBeNull();
    const access = within(desk).getByRole("button", { name: "Manage access" });
    expect(access.querySelector("svg")).not.toBeNull();
    expect(access.title).toContain("Enter or Space");
  });

  it("renames an environment and sets its icon and colour at admin, and the sidebar's badge follows each", async () => {
    const app = await opened({ desk: { sessions: [{ title: "Fix the rail" }] } });
    /** The badge on the row of desk's session in the sidebar. */
    const badge = () => within(screen.getByRole("navigation", { name: "Sessions" })).getByRole("img", { name: /^(desk|studio)$/ });
    await waitFor(() => expect(badge().getAttribute("aria-label")).toBe("desk"));
    expect(badge().style.color).toBe("var(--environment-teal)");
    const pane = await openMachines(app);
    const desk = app.environment("desk");

    const name = within(card(pane, "desk")).getByRole("textbox", { name: "Name" });
    await app.user.clear(name);
    await app.user.type(name, "studio");
    await app.user.click(within(card(pane, "desk")).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(cardNames(pane)).toEqual(["studio", "laptop"]));
    await app.user.selectOptions(within(card(pane, "studio")).getByRole("combobox", { name: "Colour" }), "violet");
    await app.user.selectOptions(within(card(pane, "studio")).getByRole("combobox", { name: "Icon" }), "nas");
    const mark = await within(card(pane, "studio")).findByRole("img", { name: "nas, violet" });
    expect(mark.tagName).toBe("svg");
    const drawing = mark.innerHTML;
    expect(desk.requests("environment.rename").map((request) => request.params["name"])).toEqual(["studio"]);
    expect(desk.requests("environment.setColour").map((request) => request.params["colour"])).toEqual(["violet"]);
    expect(desk.requests("environment.setIcon").map((request) => request.params["icon"])).toEqual(["nas"]);

    await app.user.click(screen.getByRole("button", { name: "Close Settings" }));
    expect(badge().getAttribute("aria-label")).toBe("studio");
    expect(badge().style.color).toBe("var(--environment-violet)");
    // The row's badge and the card draw the one glyph for nas.
    expect(badge().innerHTML).toBe(drawing);

    // A name the environment does not take is said, and nothing is sent.
    const again = await openMachines(app);
    const renamed = within(card(again, "studio")).getByRole("textbox", { name: "Name" });
    await app.user.clear(renamed);
    await app.user.type(renamed, "x".repeat(41));
    await app.user.click(within(card(again, "studio")).getByRole("button", { name: "Rename" }));
    expect(within(card(again, "studio")).getByText("Not renamed: a name is 1 to 40 characters, none of them a control character.")).toBeDefined();
    expect(desk.requests("environment.rename")).toHaveLength(1);
  });

  it("says so on both cards when two environments share a name, however it is cased, and no longer once one is renamed", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    expect(within(pane).queryByText(/too: rename one/)).toBeNull();

    const rename = async (from: string, to: string) => {
      const name = within(card(pane, from)).getByRole("textbox", { name: "Name" });
      await app.user.clear(name);
      await app.user.type(name, to);
      await app.user.click(within(card(pane, from)).getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(cardNames(pane)).toContain(to));
    };
    await rename("laptop", "Desk");
    expect(within(card(pane, "desk")).getByText("Another of your machines is named Desk too: rename one to tell them apart.")).toBeDefined();
    expect(within(card(pane, "Desk")).getByText("Another of your machines is named desk too: rename one to tell them apart.")).toBeDefined();

    await rename("Desk", "laptop");
    expect(within(pane).queryByText(/too: rename one/)).toBeNull();
  });

  it("shows each environment's containment availability per level, with why a level cannot be enforced, and opens Permissions on it", async () => {
    const missing = { available: false, reason: "bwrap is not installed on this machine.", cause: "binary_missing" } as const;
    const app = await opened({
      laptop: {
        containment: {
          levels: [{ level: "off", available: true, reason: null, cause: null }, { level: "workspace", ...missing }, { level: "workspace-no-network", ...missing }],
          mechanism: null,
        },
      },
    });
    const pane = await openMachines(app);
    const levels = (name: string) =>
      within(within(card(pane, name)).getByRole("region", { name: "Containment" }))
        .queryAllByRole("listitem")
        .map((level) => level.textContent);
    await waitFor(() =>
      expect(levels("laptop")).toEqual([
        "Off: available",
        "Workspace: not available: bwrap is not installed on this machine.",
        "No network: not available: bwrap is not installed on this machine.",
      ]),
    );
    expect(levels("desk")).toEqual(["Off: available", "Workspace: available", "No network: available"]);

    await app.user.click(within(card(pane, "laptop")).getByRole("button", { name: "Open Permissions" }));
    const permissions = screen.getByRole("region", { name: "Permissions" });
    expect(within(within(permissions).getByRole("combobox", { name: "Environment" })).getByRole("option", { selected: true }).textContent).toBe("laptop");
  });

  it("makes a pairing code for another client, with its link, its address and code, a QR of the link and its expiry, and says when it has expired", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    const laptop = app.environment("laptop");
    const pairing = () => within(card(pane, "laptop")).getByRole("region", { name: "Pair another client" });
    const expiry = clockTime(new Date(app.clock.now().getTime() + 10 * 60_000).toISOString());

    await app.user.click(within(pairing()).getByRole("button", { name: "Make a pairing code" }));
    const link = `${laptop.wire.origin}/pair#K7Q2MXH4RV`;
    expect(await within(pairing()).findByText(link)).toBeDefined();
    expect(laptop.requests("access.pairings.create")).toHaveLength(1);
    expect(within(pairing()).getByText("Address: laptop.test:7434")).toBeDefined();
    expect(within(pairing()).getByText("K7Q2M-XH4RV")).toBeDefined();
    expect(within(pairing()).getByText(`Expires at ${expiry}, for one use.`)).toBeDefined();
    const copy = within(pairing()).getByRole("button", { name: "Copy pairing link" });
    expect(copy.querySelector("svg")).not.toBeNull();
    await app.user.click(copy);
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", link]);
    await app.user.click(within(pairing()).getByRole("button", { name: "Copy pairing code" }));
    expect(app.shell.calls).toContainEqual(["clipboard.writeText", "K7Q2M-XH4RV"]);


    // The QR's dark modules are the link's, each where the QR code of the link has it, inside a quiet zone.
    const qr = within(pairing()).getByRole("img", { name: "QR code of the pairing link" });
    const { data } = encode(link, { border: 4 });
    expect(qr.getAttribute("viewBox")).toBe(`0 0 ${data.length} ${data.length}`);
    const dark = data.flatMap((line, y) => line.flatMap((on, x) => (on ? [`${x},${y}`] : [])));
    expect([...qr.querySelectorAll("rect[data-module]")].map((module) => `${module.getAttribute("x")},${module.getAttribute("y")}`)).toEqual(dark);

    act(() => app.clock.advance(10 * 60_000));
    expect(within(pairing()).getByText(`This code expired at ${expiry}: make another.`)).toBeDefined();
    expect(within(pairing()).queryByText(link)).toBeNull();
    expect(within(pairing()).queryByRole("img", { name: "QR code of the pairing link" })).toBeNull();
    await app.user.click(within(pairing()).getByRole("button", { name: "Make a pairing code" }));
    expect(await within(pairing()).findByText("K7Q2M-XH4RW")).toBeDefined();
  });

  it("disables, enables and makes a connection primary from its card, and forgets it after asking once, revoking this client's session there", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    const phase = () => app.runtime.projections.environments.read().find((view) => view.name === "laptop")?.phase;

    await app.user.click(within(laptop()).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(phase()).toBe("disabled"));
    expect(within(laptop()).getByText("laptop is disabled on this client: the values this window last read, read-only.")).toBeDefined();
    await app.user.click(within(laptop()).getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(phase()).toBe("ready"));
    expect(within(laptop()).getByRole("button", { name: "Disable" })).toBeDefined();

    expect(within(card(pane, "desk")).getByText("Primary")).toBeDefined();
    await app.user.click(within(laptop()).getByRole("button", { name: "Make primary" }));
    expect(await within(laptop()).findByText("Primary")).toBeDefined();
    expect(within(card(pane, "desk")).queryByText("Primary")).toBeNull();
    expect(within(laptop()).queryByRole("button", { name: "Make primary" })).toBeNull();
    expect(within(card(pane, "desk")).getByRole("button", { name: "Make primary" })).toBeDefined();

    // The local environment is managed through its service, never forgotten (ADR 0025).
    expect(within(card(pane, "desk")).queryByRole("button", { name: "Forget…" })).toBeNull();
    await app.user.click(within(laptop()).getByRole("button", { name: "Forget…" }));
    const asking = screen.getByRole("dialog", { name: "Forget laptop?" });
    expect(within(asking).getByText("This client forgets laptop and revokes its client session there.")).toBeDefined();
    await app.user.click(within(asking).getByRole("button", { name: "Cancel" }));
    expect(cardNames(pane)).toEqual(["desk", "laptop"]);

    const session = app.environment("laptop").wire.credential()?.clientSessionId;
    await app.user.click(within(laptop()).getByRole("button", { name: "Forget…" }));
    await app.user.click(within(screen.getByRole("dialog", { name: "Forget laptop?" })).getByRole("button", { name: "Forget" }));
    expect(await within(pane).findByText("Forgot laptop and revoked this client's session there.")).toBeDefined();
    expect(cardNames(pane)).toEqual(["desk"]);
    expect(app.environment("laptop").requests("access.sessions.revoke").map((request) => request.params["clientSessionId"])).toEqual([session]);
  });

  it("keeps an unreachable environment's card, showing its values as this window last read them, read-only, with since when, and forgets it here alone", async () => {
    const app = await opened({ laptop: { settings: { "updates.autoUpdate": false } } });
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    const autoUpdate = () => within(laptop()).getByRole("switch", { name: "Auto-update" });
    await waitFor(() => expect(within(laptop()).getAllByRole("listitem")).toHaveLength(3));
    await waitFor(() => expect(autoUpdate().getAttribute("aria-checked")).toBe("false"));

    const scripted = app.environment("laptop");
    scripted.discovery("nothing");
    scripted.server.drop();
    expect(await within(laptop()).findByText(/^Unreachable since \d\d:\d\d: the values this window last read, read-only\.$/)).toBeDefined();
    expect(within(laptop()).getByRole("img", { name: "laptop, amber" })).toBeDefined();
    expect((within(laptop()).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("laptop");
    for (const control of [
      within(laptop()).getByRole("textbox", { name: "Name" }),
      within(laptop()).getByRole("button", { name: "Rename" }),
      within(laptop()).getByRole("combobox", { name: "Icon" }),
      within(laptop()).getByRole("combobox", { name: "Colour" }),
      within(laptop()).getByRole("button", { name: "Make a pairing code" }),
      autoUpdate(),
    ]) {
      expect(control.hasAttribute("disabled"), control.getAttribute("aria-label") ?? control.textContent ?? "").toBe(true);
    }
    expect(autoUpdate().getAttribute("aria-checked")).toBe("false");
    expect(within(laptop()).getAllByRole("listitem").map((level) => level.textContent)).toEqual(["Off: available", "Workspace: available", "No network: available"]);
    // Said once, above everything it shows.
    expect(within(laptop()).getAllByText(/^Unreachable since/)).toHaveLength(1);
    expect(within(laptop()).queryByText(/^Read-only:/)).toBeNull();

    await app.user.click(within(laptop()).getByRole("button", { name: "Forget…" }));
    const asking = screen.getByRole("dialog", { name: "Forget laptop?" });
    expect(
      within(asking).getByText("laptop cannot be reached now, so this client forgets it here, and its client session there stays until it is revoked from that machine's access list."),
    ).toBeDefined();
    await app.user.click(within(asking).getByRole("button", { name: "Forget" }));
    expect(await within(pane).findByText("Forgot laptop. laptop could not be reached, so this client's session there is still live: revoke it from another client.")).toBeDefined();
    expect(cardNames(pane)).toEqual(["desk"]);
  });

  it("dims editing without admin, with the capability's line said once, and leaves the connection's own verbs", async () => {
    const app = await opened({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] } });
    const pane = await openMachines(app);
    const laptop = card(pane, "laptop");
    expect(await within(laptop).findByText("Read-only: This client was paired with laptop without the admin scope.")).toBeDefined();
    expect(within(laptop).getAllByText(/^Read-only:/)).toHaveLength(1);
    for (const control of [
      within(laptop).getByRole("textbox", { name: "Name" }),
      within(laptop).getByRole("combobox", { name: "Icon" }),
      within(laptop).getByRole("combobox", { name: "Colour" }),
      within(laptop).getByRole("button", { name: "Make a pairing code" }),
    ]) {
      expect(control.hasAttribute("disabled")).toBe(true);
    }
    for (const verb of ["Disable", "Make primary", "Forget…"]) expect(within(laptop).getByRole("button", { name: verb }).hasAttribute("disabled"), verb).toBe(false);

    const desk = card(pane, "desk");
    expect(within(desk).queryByText(/^Read-only:/)).toBeNull();
    expect(within(desk).getByRole("textbox", { name: "Name" }).hasAttribute("disabled")).toBe(false);
  });

  it("says on a paired environment's card that tokens are stored unprotected, when the desktop's secrets have no key the OS keeps", async () => {
    const shell = fakeShell();
    shell.answer("secrets.protection", async () => "unprotected");
    const app = await opened({}, { shell });
    const pane = await openMachines(app);
    const line = "Tokens are stored unprotected on this desktop: no secret service answers, so this client's token for laptop is as safe as its file's permissions.";
    expect(await within(card(pane, "laptop")).findByText(line)).toBeDefined();
    // The local environment's token is held in memory, never in the store.
    expect(within(card(pane, "desk")).queryByText(/unprotected/)).toBeNull();
    expect(shell.calls.filter(([member]) => member === "secrets.protection").length).toBeGreaterThan(0);
  });

  it("says nothing of how tokens are stored while the OS keeps their key", async () => {
    const app = await opened();
    const pane = await openMachines(app);
    await waitFor(() => expect(app.shell.calls.some(([member]) => member === "secrets.protection")).toBe(true));
    expect(within(pane).queryByText(/unprotected/)).toBeNull();
  });
});

/** Where the server the desktop carries lies in an installed desktop. */
const BUNDLED_PATH = "/opt/agent-harness/resources/server/agent-harness-linux-x64.tar.gz";

describe("Your machines' update controls", () => {
  it("shows each card's version, channel and auto-update, sets them through updates.settings.set, and sends Update now", async () => {
    const app = await opened({ laptop: { updates: { status: { version: "0.5.0", newest: "0.6.0" } } } });
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    const scripted = app.environment("laptop");
    expect(await within(laptop()).findByText("Version 0.5.0")).toBeDefined();
    const channel = () => within(laptop()).getByRole("combobox", { name: "Channel" }) as HTMLSelectElement;
    const autoUpdate = () => within(laptop()).getByRole("switch", { name: "Auto-update" });
    await waitFor(() => expect(channel().value).toBe("stable"));
    expect(autoUpdate().getAttribute("aria-checked")).toBe("true");

    await app.user.selectOptions(channel(), "beta");
    await waitFor(() => expect(channel().value).toBe("beta"));
    await app.user.click(autoUpdate());
    await waitFor(() => expect(autoUpdate().getAttribute("aria-checked")).toBe("false"));
    expect(scripted.requests("updates.settings.set").map((request) => request.params["values"])).toEqual([{ "updates.channel": "beta" }, { "updates.autoUpdate": false }]);
    expect(scripted.settings()).toMatchObject({ "updates.channel": "beta", "updates.autoUpdate": false });
    // The pin, the idle window and the deferral cap stay the generic editor's, under Advanced (#576).
    await app.user.click(within(laptop()).getByRole("button", { name: "Advanced" }));
    for (const key of ["updates.pinnedVersion", "updates.idleWindowMinutes", "updates.deferralCapHours"] as const) expect(within(laptop()).getByRole("group", { name: SETTINGS[key].label })).toBeDefined();
    expect(within(laptop()).queryByRole("group", { name: "Update channel" })).toBeNull();

    await app.user.click(within(laptop()).getByRole("button", { name: "Update now" }));
    expect(await within(laptop()).findByText("Updating to 0.6.0 once laptop is idle.")).toBeDefined();
    expect(scripted.requests("updates.apply").map((request) => request.params["when"])).toEqual(["idle"]);
    expect(app.environment("desk").requests("updates.apply")).toEqual([]);
  });

  it("shows a pending update's state and what it waits on", async () => {
    const pending = { updateId: "0199aa00-0000-4000-8000-00000000000b", toVersion: "0.6.0", source: "channel", since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null } as const;
    const app = await opened({
      desk: { updates: { status: { pending: { state: "blocked", reason: "launcher", toVersion: "0.9.0", message: "0.9.0 needs a newer launcher: run service install from its release." } } } },
      laptop: { updates: { status: { pending: { state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: "2026-09-24T00:10:00.000Z" } } } } },
    });
    const pane = await openMachines(app);
    expect(
      await within(card(pane, "laptop")).findByText(
        /^Waiting to update to 0\.6\.0 until laptop is idle: a run is parked on a prompt, until (\d+ \w{3} )?\d\d:\d\d unless more happens\. Forced at (\d+ \w{3} )?\d\d:\d\d\.$/,
      ),
    ).toBeDefined();
    expect(within(card(pane, "desk")).getByText("The update to 0.9.0 is blocked: 0.9.0 needs a newer launcher: run service install from its release.")).toBeDefined();

    app.environment("laptop").setUpdates({ status: { pending: { state: "draining", ...pending, cause: "cap" } } });
    app.environment("laptop").notice("environment.update-started", { updateId: pending.updateId, fromVersion: "0.0.0-fake", toVersion: "0.6.0", cause: "cap" });
    expect(await within(card(pane, "laptop")).findByText("Draining for the update to 0.6.0: new runs are refused.")).toBeDefined();
  });

  it("offers Drain and update now only while busy work holds the update, says its refusal in one line, and drops its question once the update no longer waits", async () => {
    const pending = { updateId: "0199aa00-0000-4000-8000-00000000000d", toVersion: "0.6.0", source: "channel", since: "2026-09-24T00:00:00.000Z", deferUntil: "2026-09-25T00:00:00.000Z", image: null } as const;
    const busy = { state: "waiting", ...pending, waitsOn: { reason: "parked-prompt", until: null } } as const;
    const app = await opened({
      desk: { updates: { status: { newest: "0.6.0", pending: { state: "waiting", ...pending, waitsOn: null } } } },
      laptop: {
        updates: { status: { newest: "0.6.0", pending: busy } },
        receipts: { "updates.apply": { rejected: "conflict", message: "laptop's update to 0.6.0 is draining already.", data: { reason: "in_progress" } } },
      },
    });
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    const scripted = app.environment("laptop");
    const drain = () => within(laptop()).queryByRole("button", { name: "Drain and update now…" });
    const question = () => screen.queryByRole("dialog", { name: "Drain laptop and update it to 0.6.0 now?" });
    await within(laptop()).findByRole("button", { name: "Drain and update now…" });
    // Nothing holds desk's update: it goes at the next tick, so there is nothing to drain for.
    expect(within(card(pane, "desk")).getByText("Updating to 0.6.0 within a minute: nothing holds it.")).toBeDefined();
    expect(within(card(pane, "desk")).queryByRole("button", { name: "Drain and update now…" })).toBeNull();

    await app.user.click(drain()!);
    await app.user.click(within(await screen.findByRole("dialog", { name: "Drain laptop and update it to 0.6.0 now?" })).getByRole("button", { name: "Drain and update" }));
    expect(await within(laptop()).findByRole("status")).toHaveProperty("textContent", "Not updated: laptop's update to 0.6.0 is draining already.");
    expect(scripted.requests("updates.apply").map((request) => request.params["when"])).toEqual(["now"]);

    // Asked, then the update stops waiting on work before an answer: the question goes, and does not come back with the work.
    await app.user.click(drain()!);
    await screen.findByRole("dialog", { name: "Drain laptop and update it to 0.6.0 now?" });
    scripted.setUpdates({ status: { pending: { state: "waiting", ...pending, waitsOn: null } } });
    scripted.notice("environment.update-pending", pending);
    await waitFor(() => expect(question()).toBeNull());
    expect(drain()).toBeNull();
    scripted.setUpdates({ status: { pending: busy } });
    scripted.notice("environment.update-pending", pending);
    await waitFor(() => expect(drain()).not.toBeNull());
    expect(question()).toBeNull();
    expect(scripted.requests("updates.apply")).toHaveLength(1);
  });

  it("offers to update an environment older than this client to this client's version, and not one already updating that far", async () => {
    const app = await opened(
      {
        desk: { updates: { status: { version: "0.5.0", pending: { state: "staging", updateId: "0199aa00-0000-4000-8000-00000000000c", toVersion: "0.6.0", source: "channel" } } } },
        laptop: { updates: { status: { version: "0.5.0" } } },
      },
      { version: "0.6.0" },
    );
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    expect(await within(laptop()).findByText("This client runs 0.6.0, newer than laptop's 0.5.0.")).toBeDefined();
    expect(within(card(pane, "desk")).queryByText(/^This client runs/)).toBeNull();

    await app.user.click(within(laptop()).getByRole("button", { name: "Update laptop to 0.6.0" }));
    expect(await within(laptop()).findByText("Updating laptop to 0.6.0 once it is idle.")).toBeDefined();
    expect(app.environment("laptop").requests("updates.apply").map((request) => ({ version: request.params["version"], when: request.params["when"] }))).toEqual([
      { version: "0.6.0", when: "idle" },
    ]);
  });

  it("offers an environment blocked on an older protocol this client's version, asked over the update route", async () => {
    // This client speaks a protocol after this build's; laptop spoke it too when paired, then went back to this build's.
    const newer = PROTOCOL_VERSION + 1;
    const app = await opened({ laptop: { capabilities: ["self-update"], protocolVersion: newer } }, { version: "0.6.0", protocolVersion: newer });
    const scripted = app.environment("laptop");
    scripted.discovery({ protocolVersion: PROTOCOL_VERSION, capabilities: ["self-update"] });
    scripted.bye("protocol", { protocolVersion: PROTOCOL_VERSION });
    await within(screen.getByRole("navigation", { name: "Sessions" })).findByText("laptop is older than this client: update laptop to this client's version.");
    const pane = await openMachines(app);
    const laptop = card(pane, "laptop");
    expect(within(laptop).getByText("This client runs 0.6.0, newer than laptop's 0.0.0-fake.")).toBeDefined();
    await app.user.click(within(laptop).getByRole("button", { name: "Update laptop to 0.6.0" }));
    expect(await within(laptop).findByText("Updating laptop to 0.6.0 once it is idle.")).toBeDefined();
    expect(scripted.wire.updatePosts().map((post) => post.body)).toEqual([{ version: "0.6.0" }]);
  });

  it("offers this client's version to the local environment blocked on an older protocol before any grant exchange, exchanging the grant to ask", async () => {
    // desk speaks this build's protocol and the client one more, from the start on: the start's exchange refused before sending the secret.
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { protocolVersion: PROTOCOL_VERSION + 1, version: "0.6.0" });
    const scripted = app.environment("desk");
    await within(screen.getByRole("navigation", { name: "Sessions" })).findByText("desk is older than this client: update desk to this client's version.");
    expect(scripted.wire.credential()).toBeUndefined();
    const pane = await openMachines(app);
    const desk = card(pane, "desk");
    expect(within(desk).getByText("This client runs 0.6.0, newer than desk's 0.0.0-fake.")).toBeDefined();

    await app.user.click(within(desk).getByRole("button", { name: "Update desk to 0.6.0" }));

    expect(await within(desk).findByText("Updating desk to 0.6.0 once it is idle.")).toBeDefined();
    expect(scripted.wire.updatePosts()).toEqual([{ token: scripted.wire.credential()?.token, body: { version: "0.6.0" } }]);
  });

  it("shows the idle wait in the sidebar and empty workspace, then observes the restart", async () => {
    const shell = fakeShell();
    shell.answer("service.pendingUpdate", async () => LOCAL_IDLE_UPDATE);
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { shell, protocolVersion: PROTOCOL_VERSION + 1, version: "0.6.0" });
    await app.user.click(await screen.findByRole("button", { name: "Update desk" }));
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    await within(sidebar).findByText(/Waiting to update to 0.6.0.*idle.*until/);
    const workspace = screen.getByRole("region", { name: "This machine" });
    expect(within(workspace).getByText(/Waiting to update to 0.6.0.*idle.*until/)).toBeDefined();
    expect(within(workspace).getByRole("button", { name: "Update immediately" }).hasAttribute("disabled")).toBe(false);
    expect(within(sidebar).queryByText("Restarting for an update…")).toBeNull();
    shell.answer("service.pendingUpdate", async () => ({ ...LOCAL_IDLE_UPDATE, state: "draining", cause: "idle" }));
    await act(async () => { app.clock.advance(5000); });
    await within(sidebar).findByText("Restarting for an update…");
    expect(within(sidebar).queryByRole("button", { name: "Update immediately" })).toBeNull();
  });

  it("clears a refused immediate-update message when the environment proceeds with the update", async () => {
    const shell = fakeShell();
    shell.answer("service.pendingUpdate", async () => LOCAL_IDLE_UPDATE);
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { shell, protocolVersion: PROTOCOL_VERSION + 1, version: "0.6.0" });
    await app.user.click(await screen.findByRole("button", { name: "Update desk" }));
    const sidebar = screen.getByRole("navigation", { name: "Sessions" });
    await within(sidebar).findByText(/Waiting to update to 0.6.0.*idle.*until/);
    shell.answer("service.pendingUpdate", async () => ({ ...LOCAL_IDLE_UPDATE, waitsOn: { reason: "run-running", until: null } }));
    await app.user.click(within(sidebar).getByRole("button", { name: "Update immediately" }));
    const refused = "Not updated: The update is no longer waiting only on the idle window.";
    await within(sidebar).findByText(refused);
    shell.answer("service.pendingUpdate", async () => ({ ...LOCAL_IDLE_UPDATE, state: "draining", cause: "idle" }));
    await act(async () => { app.clock.advance(5000); });
    await within(sidebar).findByText("Restarting for an update…");
    await waitFor(() => expect(within(sidebar).queryByText(refused)).toBeNull());
  });

  it("shows the idle deadline and offers an immediate local update across an older protocol", async () => {
    const pending = LOCAL_IDLE_UPDATE;
    let advanced = false;
    const shell = fakeShell();
    shell.answer("service.pendingUpdate", async () => advanced ? { ...pending, state: "draining", cause: "requested" } : pending);
    shell.answer("service.applyUpdateNow", async () => { advanced = true; });
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["self-update"] }] }, { shell, protocolVersion: PROTOCOL_VERSION + 1, version: "0.6.0" });
    const pane = await openMachines(app);
    await app.user.click(within(card(pane, "desk")).getByRole("button", { name: "Update desk to 0.6.0" }));
    const desk = card(pane, "desk");
    await within(desk).findByText(/Waiting to update to 0.6.0.*idle.*until/);
    expect(within(desk).queryByText("Restarting for an update…")).toBeNull();
    await app.user.click(within(desk).getByRole("button", { name: "Update immediately" }));
    await waitFor(() => expect(shell.calls.filter(([member]) => member === "service.applyUpdateNow")).toHaveLength(1));
    await within(desk).findByText("Restarting for an update…");
  });

  it("says a refused offer of this client's version in one line, as the card's status", async () => {
    const app = await opened(
      { laptop: { updates: { status: { version: "0.5.0" } }, receipts: { "updates.apply": { rejected: "conflict", message: "laptop is pinned to 0.5.0.", data: { reason: "pinned" } } } } },
      { version: "0.6.0" },
    );
    const pane = await openMachines(app);
    const laptop = () => card(pane, "laptop");
    await app.user.click(await within(laptop()).findByRole("button", { name: "Update laptop to 0.6.0" }));
    expect(await within(laptop()).findByRole("status")).toHaveProperty("textContent", "Not updated: laptop is pinned to 0.5.0.");
  });

  it("offers on the local environment's card the newer server the desktop carries, when auto-update is not effective there, and hands it over on a click", async () => {
    const shell = fakeShell();
    shell.answer("installer.bundledServer", async () => ({ version: "0.6.0", path: BUNDLED_PATH }));
    const app = await opened({ desk: { settings: { "updates.autoUpdate": false } } }, { shell, version: "0.6.0" });
    const pane = await openMachines(app);
    const desk = () => card(pane, "desk");
    expect(await within(desk()).findByText("This desktop carries the server 0.6.0, newer than desk's 0.0.0-fake.")).toBeDefined();
    // The server it carries is this client's version: it is the offer, and nothing is downloaded.
    expect(within(desk()).queryByText(/^This client runs/)).toBeNull();
    expect(within(card(pane, "laptop")).queryByText(/^This desktop carries/)).toBeNull();

    await app.user.click(within(desk()).getByRole("button", { name: "Install the bundled 0.6.0" }));
    expect(await within(desk()).findByText("desk took the bundled 0.6.0: it updates once it is idle.")).toBeDefined();
    expect(app.environment("desk").requests("updates.apply").map((request) => request.params)).toEqual([
      { commandId: expect.any(String), version: "0.6.0", artefactPath: BUNDLED_PATH, when: "idle" },
    ]);
  });

  it("explains a bundled install's disk refusal from a released environment and keeps retry available", async () => {
    const shell = fakeShell();
    shell.answer("installer.bundledServer", async () => ({ version: "0.6.0", path: BUNDLED_PATH }));
    shell.answer("installer.reserveSpace", async () => ({ availableBytes: 199864320, requiredBytes: 268435456 }));
    const app = await opened({ desk: {
      settings: { "updates.autoUpdate": false },
      receipts: { "updates.apply": { rejected: "conflict", message: "The launcher refused to install 0.6.0: disk.", data: { reason: "install", launcherReason: "disk" } } },
    } }, { shell, version: "0.6.0" });
    const pane = await openMachines(app);
    const desk = () => card(pane, "desk");
    await app.user.click(await within(desk()).findByRole("button", { name: "Install the bundled 0.6.0" }));
    expect(await within(desk()).findByText(/Insufficient disk space/)).toHaveProperty("textContent", expect.stringContaining("190.6 MiB available; 256 MiB reserve required"));
    expect(within(desk()).getByText(/Insufficient disk space/).textContent).toContain("The existing environment remains running. Free space and retry.");
    await app.user.click(within(desk()).getByRole("button", { name: "Install the bundled 0.6.0" }));
    await waitFor(() => expect(app.environment("desk").requests("updates.apply")).toHaveLength(2));
  });

  it("says on the local environment's card that it took the newer server the desktop carries by itself, with auto-update effective", async () => {
    const shell = fakeShell();
    shell.answer("installer.bundledServer", async () => ({ version: "0.6.0", path: BUNDLED_PATH }));
    const app = await opened({}, { shell });
    const pane = await openMachines(app);
    expect(await within(card(pane, "desk")).findByText("desk took the bundled 0.6.0: it updates once it is idle.")).toBeDefined();
    expect(within(card(pane, "desk")).queryByRole("button", { name: /^Install the bundled/ })).toBeNull();
  });

  it("is read-only without admin, and says a refused Update now in one line", async () => {
    const app = await opened({
      desk: { receipts: { "updates.apply": { rejected: "conflict", message: "desk runs 0.0.0-fake already.", data: { reason: "current" } } } },
      laptop: {
        scopes: ["read", "sessions:write", "runs:drive", "terminal"],
        updates: {
          status: {
            pending: {
              state: "waiting",
              updateId: "0199aa00-0000-4000-8000-00000000000e",
              toVersion: "0.6.0",
              source: "channel",
              since: "2026-09-24T00:00:00.000Z",
              deferUntil: "2026-09-25T00:00:00.000Z",
              image: null,
              waitsOn: { reason: "run-running", until: null },
            },
          },
        },
      },
    });
    const pane = await openMachines(app);
    const laptop = card(pane, "laptop");
    await within(laptop).findByText("Read-only: This client was paired with laptop without the admin scope.");
    await waitFor(() => expect(within(laptop).getByRole("combobox", { name: "Channel" }).hasAttribute("disabled")).toBe(true));
    expect(within(laptop).getByRole("switch", { name: "Auto-update" }).hasAttribute("disabled")).toBe(true);
    expect(within(laptop).getByRole("button", { name: "Update now" }).hasAttribute("disabled")).toBe(true);
    expect(within(laptop).getByRole("button", { name: "Drain and update now…" }).hasAttribute("disabled")).toBe(true);

    await app.user.click(within(card(pane, "desk")).getByRole("button", { name: "Update now" }));
    expect(await within(card(pane, "desk")).findByRole("status")).toHaveProperty("textContent", "Not updated: desk runs 0.0.0-fake already.");
  });
});
