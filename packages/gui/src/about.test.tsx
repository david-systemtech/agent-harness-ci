import { screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import type { PendingUpdate } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type RenderOptions, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * About (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; launcher-update spec, "Settings, methods, notices and flags"
 * and "The desktop moves with its local environment"; ADR 0026, ADR 0027;
 * #424): this client's version pinned above the picker with the desktop's
 * own update, then the picked environment's version, channel, auto-update,
 * pending update, Update now and Drain and update now (#825) from
 * `updates.status`, and the Claude Code it bundles; and "Restart to update"
 * across the window's header once the runtime reports a staged desktop
 * build. Driven through the harness over the scripted environment `desk`,
 * this machine's, and the fake shell's `update`.
 */

const UPDATE_ID = "0199aa00-0000-4000-8000-00000000000a";

/** An update to 0.6.0 installed and waiting while a run runs, forced a day after the harness's clock starts. */
const WAITING: PendingUpdate = {
  state: "waiting",
  updateId: UPDATE_ID,
  toVersion: "0.6.0",
  source: "channel",
  since: "2026-09-24T00:00:00.000Z",
  deferUntil: "2026-09-25T00:00:00.000Z",
  image: null,
  waitsOn: { reason: "run-running", until: null },
};

/** A desktop build of 0.6.0 as the local environment stages it. */
const STAGED = { path: "/home/milo/.local/state/agent-harness/desktop/0.6.0/agent-harness-0.6.0.pacman", version: "0.6.0", sha256: "a".repeat(64) };

/** The window over `desk` alone, ready, with no session open. */
const opened = async (desk: Partial<ScriptedEnvironment> = {}, options: RenderOptions = {}) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", ...desk }] }, options);
  await screen.findByText("No session is open. Choose one from the sidebar.");
  return app;
};

/** Opens Settings on About, as a person does: Mod+, then its row on the rail. */
const openAbout = async (app: RenderedApp) => {
  await app.user.keyboard("{Control>},{/Control}");
  const settings = await screen.findByRole("region", { name: "Settings" });
  await app.user.click(within(within(settings).getByRole("navigation", { name: "Settings rows" })).getByRole("button", { name: "About" }));
  return within(settings).getByRole("region", { name: "About" });
};

/** The window's header. */
const header = () => screen.getByRole("banner");

describe("About", () => {
  it("shows the picked environment's version, channel, auto-update, pending update with what it waits on, and its bundled Claude Code, read again on the update notices", async () => {
    const app = await opened({
      settings: { "updates.channel": "beta" },
      updates: { status: { version: "0.5.0", bundledClaudeCodeVersion: "2.1.283", pending: WAITING } },
    });
    const about = await openAbout(app);
    const updates = within(about).getByRole("region", { name: "Updates" });

    const platform = await within(about).findByText("linux · x64");
    expect(platform.tagName).toBe("DD");
    expect(platform.classList.contains("font-mono")).toBe(true);
    expect(within(updates).getByRole("button", { name: "Update now" }).querySelector("svg")).not.toBeNull();
    expect(await within(updates).findByText("Version 0.5.0")).toBeDefined();
    await waitFor(() => expect((within(updates).getByRole("combobox", { name: "Channel" }) as HTMLSelectElement).value).toBe("beta"));
    expect(within(updates).getByRole("switch", { name: "Auto-update" }).getAttribute("aria-checked")).toBe("true");
    expect(within(updates).getByText(/^Waiting to update to 0\.6\.0 until desk is idle: a run is running\. Forced at (\d+ \w{3} )?\d\d:\d\d\.$/)).toBeDefined();
    expect(within(about).getByText("Claude Code (bundled) 2.1.283, updates with this environment.")).toBeDefined();

    const desk = app.environment("desk");
    desk.setUpdates({ status: { pending: { state: "current" } } });
    desk.notice("environment.update-cancelled", { updateId: UPDATE_ID, toVersion: "0.6.0", cause: "requested" });
    await waitFor(() => expect(within(updates).queryByText(/^Waiting to update/)).toBeNull());

    desk.setUpdates({ status: { pending: { state: "staging", updateId: UPDATE_ID, toVersion: "0.6.1", source: "request" } } });
    desk.notice("environment.update-pending", { ...WAITING, toVersion: "0.6.1" });
    expect(await within(updates).findByText("Staging 0.6.1: downloading and installing it.")).toBeDefined();
  });

  it("says an unreadable bundled Claude Code, and a pin that holds the version with auto-update off", async () => {
    const app = await opened({ settings: { "updates.pinnedVersion": "0.5.0" }, updates: { status: { version: "0.5.0", bundledClaudeCodeVersion: null } } });
    const about = await openAbout(app);
    expect(await within(about).findByText("Pinned to 0.5.0: auto-update is off until it is unpinned.")).toBeDefined();
    expect(within(about).getByText("Claude Code (bundled), its version not read, updates with this environment.")).toBeDefined();
  });

  it("sends Update now as updates.apply when idle, saying where it goes", async () => {
    const app = await opened({ updates: { status: { version: "0.5.0", newest: "0.6.0" } } });
    const about = await openAbout(app);
    await app.user.click(await within(about).findByRole("button", { name: "Update now" }));
    expect(await within(about).findByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();
    expect(app.environment("desk").requests("updates.apply").map((request) => request.params)).toEqual([{ commandId: expect.any(String), when: "idle" }]);
  });

  it("keeps Update now's line while its update is pending, and drops it once the update fails and rolls back", async () => {
    const app = await opened({ updates: { updateId: UPDATE_ID, status: { version: "0.5.0", newest: "0.6.0" } } });
    const about = await openAbout(app);
    const desk = app.environment("desk");
    await app.user.click(await within(about).findByRole("button", { name: "Update now" }));
    expect(await within(about).findByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();

    desk.setUpdates({ status: { pending: WAITING } });
    desk.notice("environment.update-pending", WAITING);
    expect(await within(about).findByText(/^Waiting to update to 0\.6\.0 until desk is idle/)).toBeDefined();
    expect(within(about).getByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();

    const failed = { updateId: UPDATE_ID, fromVersion: "0.5.0", toVersion: "0.6.0", stage: "trial", reason: "credential", rolledBack: true } as const;
    desk.setUpdates({ status: { pending: { state: "current" }, lastOutcome: { outcome: "failed", ...failed, at: "2026-09-24T00:05:00.000Z" }, failedVersions: ["0.6.0"] } });
    desk.notice("environment.update-failed", failed);
    await waitFor(() => expect(within(about).queryByText("Updating to 0.6.0 once desk is idle.")).toBeNull());
    expect(within(about).queryByText(/^Waiting to update/)).toBeNull();
  });

  it("keeps Update now's line while its update is pending, and drops it once the update commits and the target runs", async () => {
    const app = await opened({ updates: { updateId: UPDATE_ID, status: { version: "0.5.0", newest: "0.6.0" } } });
    const about = await openAbout(app);
    const desk = app.environment("desk");
    await app.user.click(await within(about).findByRole("button", { name: "Update now" }));
    expect(await within(about).findByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();

    desk.setUpdates({ status: { pending: WAITING } });
    desk.notice("environment.update-pending", WAITING);
    expect(await within(about).findByText(/^Waiting to update to 0\.6\.0 until desk is idle/)).toBeDefined();
    expect(within(about).getByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();

    const updated = { updateId: UPDATE_ID, fromVersion: "0.5.0", toVersion: "0.6.0" } as const;
    desk.setUpdates({ status: { version: "0.6.0", pending: { state: "current" }, lastOutcome: { outcome: "updated", ...updated, at: "2026-09-24T00:05:00.000Z" } } });
    desk.notice("environment.updated", updated);
    expect(await within(about).findByText("Version 0.6.0")).toBeDefined();
    await waitFor(() => expect(within(about).queryByText("Updating to 0.6.0 once desk is idle.")).toBeNull());
    expect(within(about).queryByText(/^Waiting to update/)).toBeNull();
  });

  it("drops Update now's line once its update is withdrawn, even when no read showed it pending", async () => {
    const app = await opened({ updates: { updateId: UPDATE_ID, status: { version: "0.5.0", newest: "0.6.0" } } });
    const about = await openAbout(app);
    await app.user.click(await within(about).findByRole("button", { name: "Update now" }));
    expect(await within(about).findByText("Updating to 0.6.0 once desk is idle.")).toBeDefined();

    app.environment("desk").notice("environment.update-cancelled", { updateId: UPDATE_ID, toVersion: "0.6.0", cause: "requested" });
    await waitFor(() => expect(within(about).queryByText("Updating to 0.6.0 once desk is idle.")).toBeNull());
  });

  it("offers Drain and update now while the update waits on running work, asks once saying running runs are cut at the drain's cap, and sends updates.apply now", async () => {
    const app = await opened({ updates: { status: { version: "0.5.0", newest: "0.6.0", pending: WAITING } } });
    const about = await openAbout(app);
    const desk = app.environment("desk");
    const drain = await within(about).findByRole("button", { name: "Drain and update now…" });

    await app.user.click(drain);
    const asked = await screen.findByRole("dialog", { name: "Drain desk and update it to 0.6.0 now?" });
    expect(
      within(asked).getByText(
        "desk refuses new runs at once and lets the running ones finish for up to 30 minutes, then cuts any still running and restarts on 0.6.0. A run it cuts carries on after the update when its provider can resume it.",
      ),
    ).toBeDefined();
    await app.user.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(desk.requests("updates.apply")).toEqual([]);

    await app.user.click(drain);
    await app.user.click(within(await screen.findByRole("dialog", { name: "Drain desk and update it to 0.6.0 now?" })).getByRole("button", { name: "Drain and update" }));
    expect(await within(about).findByRole("status")).toHaveProperty("textContent", "Draining desk to update to 0.6.0.");
    expect(desk.requests("updates.apply").map((request) => request.params)).toEqual([{ commandId: expect.any(String), when: "now" }]);
    expect(screen.queryByRole("dialog", { name: "Drain desk and update it to 0.6.0 now?" })).toBeNull();
  });

  it("says a refused Update now in one line", async () => {
    const app = await opened({ receipts: { "updates.apply": { rejected: "conflict", message: "desk is pinned to 0.5.0.", data: { reason: "pinned" } } } });
    const about = await openAbout(app);
    await app.user.click(await within(about).findByRole("button", { name: "Update now" }));
    expect(await within(about).findByText("Not updated: desk is pinned to 0.5.0.")).toBeDefined();
  });

  it("is read-only without admin, with the capability's line said once", async () => {
    const app = await opened({ scopes: ["read", "sessions:write", "runs:drive", "terminal"], updates: { status: { version: "0.5.0" } } });
    const about = await openAbout(app);
    expect(await within(about).findByText("Read-only: This client was paired with desk without the admin scope.")).toBeDefined();
    expect(within(about).getAllByText(/^Read-only:/)).toHaveLength(1);
    for (const control of [
      within(about).getByRole("combobox", { name: "Channel" }),
      within(about).getByRole("switch", { name: "Auto-update" }),
      within(about).getByRole("button", { name: "Update now" }),
    ]) {
      expect(control.hasAttribute("disabled"), control.getAttribute("aria-label") ?? control.textContent ?? "").toBe(true);
    }
  });
});

describe("Restart to update", () => {
  it("shows in the header and on About once the runtime reports a staged desktop build, and a click applies it", async () => {
    const app = await opened({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } });
    expect(await within(header()).findByRole("button", { name: "Restart to update" })).toBeDefined();
    // Handed to the shell for the next quit as soon as it was staged.
    expect(app.shell.calls.filter(([member]) => member === "update.apply").map(([, ...args]) => args)).toEqual([[STAGED, "quit"]]);

    const about = await openAbout(app);
    expect(within(about).getByText("This client: 0.0.0-fake")).toBeDefined();
    expect(within(about).getByText("0.6.0 is ready: it installs when this client next quits, or now with Restart to update.")).toBeDefined();
    expect(within(about).getByRole("button", { name: "Restart to update" })).toBeDefined();

    await app.user.click(within(about).getByRole("button", { name: "Restart to update" }));
    await waitFor(() => expect(app.shell.calls.filter(([member]) => member === "update.apply").map(([, ...args]) => args)).toEqual([[STAGED, "quit"], [STAGED, "now"]]));
  });

  it("says where it was clicked why an install failed and the command that installs the staged build by hand, and no longer offers the same restart", async () => {
    const message = "Installing 0.6.0 needs pkexec, which polkit provides, and it is not installed, so 0.0.0-fake stays installed.";
    const byHand = `sudo pacman -U ${STAGED.path}`;
    const shell = fakeShell();
    shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "install", message, byHand } : { outcome: "applied" }));
    const app = await opened({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } }, { shell });

    await app.user.click(await within(header()).findByRole("button", { name: "Restart to update" }));

    // Shown at once, without hovering: the reason and the command, in the details the header's control opened.
    const details = within(await screen.findByRole("dialog", { name: "Update failed" }));
    expect(details.getByText(message)).toBeDefined();
    expect(details.getByText(byHand)).toBeDefined();
    expect(within(header()).queryByRole("button", { name: "Restart to update" })).toBeNull();
    expect(within(header()).getByRole("button", { name: "Update failed" })).toBeDefined();

    await app.user.click(details.getByRole("button", { name: "Open the release page" }));
    expect(shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", "https://git.example.test/david/agent-harness/releases"]]);
    await app.user.click(details.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(shell.calls.filter(([member]) => member === "update.apply").map(([, ...args]) => args)).toEqual([[STAGED, "quit"], [STAGED, "now"], [STAGED, "now"]]));
  });

  it("shows a failed install on About with the command that installs the staged build by hand, and tries again from there", async () => {
    const message = "pacman could not install 0.6.0 (error: failed to init transaction (unable to lock database)), so 0.0.0-fake stays installed.";
    const byHand = `sudo pacman -U ${STAGED.path}`;
    const shell = fakeShell();
    shell.answer("update.apply", async (_staged, when) => (when === "now" ? { outcome: "failed", failure: "install", message, byHand } : { outcome: "applied" }));
    const app = await opened({ updates: { status: { newest: "0.6.0" }, desktopBuild: STAGED } }, { shell });
    await within(header()).findByRole("button", { name: "Restart to update" });
    await app.runtime.desktopUpdate.restart();

    const about = within(await openAbout(app));
    expect(about.getByText(message)).toBeDefined();
    expect(about.getByText(byHand)).toBeDefined();
    expect(about.queryByRole("button", { name: "Restart to update" })).toBeNull();
    await app.user.click(about.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(shell.calls.filter(([member]) => member === "update.apply")).toHaveLength(3));
  });

  it("shows a failed stage on About with its reason and checks again from there at once, offering the build it then stages", async () => {
    const message = "The artefact did not download.";
    const app = await opened({ updates: { status: { newest: "0.6.0" }, desktopBuild: { refused: "conflict", message, data: { reason: "download" } } } });
    const about = within(await openAbout(app));
    expect(await about.findByText(`The local environment could not stage the desktop's 0.6.0 build: ${message}`)).toBeDefined();

    app.environment("desk").setUpdates({ desktopBuild: STAGED });
    await app.user.click(about.getByRole("button", { name: "Check again" }));
    expect(await about.findByText("0.6.0 is ready: it installs when this client next quits, or now with Restart to update.")).toBeDefined();
    expect(about.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(about.getByRole("button", { name: "Restart to update" })).toBeDefined();
  });

  it("shows nothing while no newer build is staged", async () => {
    const app = await opened({ updates: { status: { lastCheck: { at: "2026-10-03T21:21:26.000Z", result: "ok" } } } });
    const about = await openAbout(app);
    await waitFor(() => expect(within(about).getByText("This client's build is the newest.")).toBeDefined());
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });

  it("says it waits for the local environment's first read of its release channel, never that the build is the newest", async () => {
    const app = await opened();
    const about = await openAbout(app);
    expect(await within(about).findByText("Waiting for this machine's environment to read its release channel, then checking for a newer build…")).toBeDefined();
    expect(within(about).queryByText("This client's build is the newest.")).toBeNull();
  });

  it("says an install that cannot update itself, with the release page", async () => {
    const shell = fakeShell();
    shell.answer("update.current", async () => ({ version: "0.0.0-fake", platform: "linux", arch: "x64", format: null }));
    const app = await opened({ updates: { status: { newest: "0.6.0" } } }, { shell });
    const about = await openAbout(app);
    expect(await within(about).findByText("This install cannot update itself: download a newer build from the release page.")).toBeDefined();
    await app.user.click(within(about).getByRole("button", { name: "Open the release page" }));
    expect(shell.calls.filter(([member]) => member === "openExternal")).toEqual([["openExternal", "https://git.example.test/david/agent-harness/releases"]]);
    expect(screen.queryByRole("button", { name: "Restart to update" })).toBeNull();
  });
});
