import { SETTINGS, type SettingsKey } from "@agent-harness/contracts";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The Service row, `environments.service` (docs/specs/gui.md, "Settings";
 * the env spec's lifecycle; ADR 0007, ADR 0027; #417): the environment's
 * state from `environment.status`, Drain and Rebuild projections each asked
 * once and answered in one line, and the three session keys through
 * `settings.update`. Driven through the harness over two scripted
 * environments: `desk`, this machine's, and `laptop`, paired.
 */

/** The window with its two environments ready and no session open, each as `given` scripts it. */
const opened = async (given: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment> } = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...given.desk }, { name: "laptop", reach: "paired", ...given.laptop }] });
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** A row's pane, by its label. */
const pane = (label: string) => within(screen.getByRole("region", { name: "Settings" })).getByRole("region", { name: label });

/** Opens Settings on Service with Mod+, and the rail, as a person does, the picker on `environment` when it is given. */
const openService = async (app: RenderedApp, environment?: string) => {
  if (screen.queryByRole("region", { name: "Settings" }) === null) await app.user.keyboard("{Control>},{/Control}");
  const open = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(open).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "Service" }));
  if (environment !== undefined) await app.user.selectOptions(within(pane("Service")).getByRole("combobox", { name: "Environment" }), environment);
  return pane("Service");
};

/** The State part of the pane. */
const stateOf = (region: HTMLElement) => within(region).getByRole("region", { name: "State" });

/** A key's group, by the key. */
const field = (region: HTMLElement, key: SettingsKey) => within(region).getByRole("group", { name: SETTINGS[key].label });

describe("the state", () => {
  it("shows what environment.status says: ready and idle, busy with why, and updates managed outside", async () => {
    const app = await opened({ laptop: { status: { activity: { state: "busy", reason: "run-running" }, updatesManagedOutside: true } } });
    const service = await openService(app, "desk");
    expect(await within(stateOf(service)).findByText("Ready and idle.")).toBeDefined();
    expect(within(stateOf(service)).queryByText(/managed outside/)).toBeNull();

    await openService(app, "laptop");
    const laptop = stateOf(pane("Service"));
    expect(await within(laptop).findByText("Ready and busy: a run is running.")).toBeDefined();
    expect(within(laptop).getByText("Its updates are managed outside it: a host-side updater recreates its container.")).toBeDefined();
    expect(app.environment("laptop").requests("environment.status")).not.toEqual([]);
  });
});

describe("drain", () => {
  it("asks once, drains through environment.drain in one line, and shows the state draining; a second joins the first", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const service = await openService(app);
    await within(stateOf(service)).findByText("Ready and idle.");

    const drain = within(service).getByRole("button", { name: "Drain…" });
    expect(drain.querySelector("svg")).not.toBeNull();
    expect(drain.title).toContain("Enter or Space");
    await app.user.click(within(service).getByRole("button", { name: "Drain…" }));
    const asked = await screen.findByRole("dialog", { name: "Drain desk?" });
    expect(within(asked).getByText("desk refuses new runs, lets the running ones finish for up to 30 minutes, then stops.")).toBeDefined();
    await app.user.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("environment.drain")).toEqual([]);

    await app.user.click(within(service).getByRole("button", { name: "Drain…" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Drain desk?" })).getByRole("button", { name: "Drain" }));
    expect(await within(service).findByText(/^desk is draining since \d\d:\d\d: it refuses new runs and stops once the running ones finish\.$/)).toBeDefined();
    expect(desk.requests("environment.drain")).toHaveLength(1);
    expect(desk.drain()).toMatchObject({ trigger: "command" });
    expect(await within(stateOf(service)).findByText(/^Draining since \d\d:\d\d: new runs are refused\.$/)).toBeDefined();

    await app.user.click(within(service).getByRole("button", { name: "Drain…" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Drain desk?" })).getByRole("button", { name: "Drain" }));
    expect(await within(service).findByText(/^desk was draining already, since \d\d:\d\d, started by a client\.$/)).toBeDefined();
  });
});

describe("rebuild projections", () => {
  it("asks once and rebuilds through environment.rebuildProjections in one line", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const service = await openService(app);
    await app.user.click(within(service).getByRole("button", { name: "Rebuild projections…" }));
    const asked = await screen.findByRole("dialog", { name: "Rebuild desk's projections?" });
    expect(within(asked).getByText("desk drops its projection tables and replays its event log into them; the log itself does not change.")).toBeDefined();
    await app.user.click(within(asked).getByRole("button", { name: "Rebuild" }));
    expect(await within(service).findByText(/^Rebuilt desk's 5 projections from its log, through event \d+\.$/)).toBeDefined();
    expect(desk.requests("environment.rebuildProjections")).toHaveLength(1);
  });

  it("says why the environment refused it", async () => {
    const app = await opened({ desk: { receipts: { "environment.rebuildProjections": { rejected: "internal", message: "The event log is busy." } } } });
    const service = await openService(app);
    await app.user.click(within(service).getByRole("button", { name: "Rebuild projections…" }));
    await app.user.click(within(await screen.findByRole("dialog", { name: "Rebuild desk's projections?" })).getByRole("button", { name: "Rebuild" }));
    expect(await within(service).findByText("Not rebuilt: The event log is busy.")).toBeDefined();
  });
});

describe("the session keys", () => {
  it("writes auto-settle after idle, auto-settle on merge and the compaction window through settings.update", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    const keys = within(await openService(app)).getByRole("region", { name: "Sessions" });

    const idle = await within(field(keys, "sessions.autoSettleAfterIdle")).findByRole("textbox");
    expect((idle as HTMLInputElement).value).toBe("14 days");
    expect(within(field(keys, "sessions.autoSettleOnMerge")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect((within(field(keys, "sessions.transcriptCompactAfterDays")).getByRole("textbox") as HTMLInputElement).value).toBe("90");
    await app.user.clear(idle);
    await app.user.type(idle, "3 days");
    await app.user.click(within(field(keys, "sessions.autoSettleAfterIdle")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(desk.settings()["sessions.autoSettleAfterIdle"]).toEqual({ amount: 3, unit: "days" }));

    await app.user.click(within(field(keys, "sessions.autoSettleOnMerge")).getByRole("switch"));
    await waitFor(() => expect(desk.settings()["sessions.autoSettleOnMerge"]).toBe(true));

    const compact = within(field(keys, "sessions.transcriptCompactAfterDays")).getByRole("textbox");
    await app.user.clear(compact);
    await app.user.type(compact, "30");
    await app.user.click(within(field(keys, "sessions.transcriptCompactAfterDays")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(desk.settings()["sessions.transcriptCompactAfterDays"]).toBe(30));
    expect(desk.requests("settings.update")).toHaveLength(3);
  });
});

describe("without admin", () => {
  it("shows the state, and is read-only with the capability's line, said once", async () => {
    const app = await opened({ laptop: { scopes: ["read", "sessions:write", "runs:drive", "terminal"] } });
    const service = await openService(app, "laptop");
    expect(await within(stateOf(service)).findByText("Ready and idle.")).toBeDefined();
    expect(within(service).getAllByText("Read-only: This app has limited access to laptop, so it cannot change settings or sign in accounts. Pair again with full access to change this.")).toHaveLength(1);
    expect(within(service).getByRole("button", { name: "Drain…" }).hasAttribute("disabled")).toBe(true);
    expect(within(service).getByRole("button", { name: "Rebuild projections…" }).hasAttribute("disabled")).toBe(true);
    expect((await within(field(service, "sessions.autoSettleOnMerge")).findByRole("switch")).hasAttribute("disabled")).toBe(true);
  });
});
