import { act, screen, waitFor, within } from "@testing-library/react";
import { StateImportFinishedPayload, StateImportReport, type CarryOverInventory, type StateImportDetection } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

const detection = (): StateImportDetection => ({
  dataFolder: { path: "/data/source", holds: { profiles: 2, banks: 3, routines: 4, instructions: 5, skillSources: 6, connections: 7 } },
  terminalFolder: { path: "/data/terminal" },
});
const opened = async (environment: Partial<ScriptedEnvironment> = {}, found = detection(), prepare?: (app: Awaited<ReturnType<typeof renderApp>>) => void) => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", capabilities: ["stateImport"], ...environment }] }, { firstLaunch: true });
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  app.environment("desk").wire.answer("stateImport.detect", () => ({ result: found }));
  prepare?.(app);
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
  return app;
};
const report = (dryRun = false): StateImportReport => StateImportReport.parse({
  dryRun,
  sharedProjects: [{ sourceId: "secondary", ownerSourceId: "primary" }],
  carried: { accounts: 2, archived: 3, pins: 4, groups: 5, forgeAccounts: 1, keyManagerConnections: 1, banks: 3, routines: 4, instructions: 5, skillSources: 6, alwaysOnSkills: 2, drafts: 1, devSites: 2 },
  reEnter: [{ label: "Forge token", step: "forges" }, { label: "Vault sign-in", step: "key-manager" }],
  later: [{ label: "Local model", provider: "local" }],
  notCarried: [{ label: "Saved connections", count: 2, step: "your-machines" }, { label: "Model choices", count: 3, step: null }],
  failed: [{ label: "Nightly digest", message: "Its workspace is missing." }],
  clientLocal: { mode: "dark", fontSize: 18, conversationWidth: "wide", showThinking: false, settingsRow: "knowledge.banks" },
});
const answerRun = (app: Awaited<ReturnType<typeof opened>>) => app.environment("desk").wire.answer("stateImport.run", (params) => ({
  result: { receipt: { status: "accepted", sequence: 1, changed: params["dryRun"] !== true }, result: report(params["dryRun"] === true) },
}));
const section = () => within(screen.getByRole("region", { name: "State import" }));

describe("State import on Carry over", () => {
  it("explains how to repair a retained state import after provider sign-in, without treating a dry run as a repair", async () => {
    const reason = "The last state import failed part way: Skill source: The repository needs a credential. Import again to retry what failed.";
    const app = await opened({ accounts: [{ label: "Work" }], setup: { "carry-over": {
      state: "needs-attention", reason, actions: ["import-again"], failing: ["carry-over.last-import"],
      targets: [{ action: "import-again", kind: "environment", id: "desk", label: "The state import" }],
    } } });
    expect(await screen.findByText(/Provider sign-in does not grant access to private skill repositories/)).toBeDefined();
    expect(section().getByText(/SSH keys and known-hosts entry/)).toBeDefined();
    expect(section().getByRole("button", { name: "Open Forges" })).toBeDefined();
    expect(section().getByRole("button", { name: "Open Skills" })).toBeDefined();
    const preview = report(true);
    preview.failed = [];
    preview.reEnter = [];
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: false }, result: preview } }));
    await app.user.click(section().getByRole("button", { name: "Dry run" }));
    expect(await section().findByText(/A dry run does not test repository access or clear a failed import/)).toBeDefined();
    expect(screen.getByText(reason)).toBeDefined();
    await app.user.click(section().getByRole("button", { name: "Open Forges" }));
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step");
  });

  it("lets a paired headless environment with signed-in owned accounts finish its empty Carry over step", async () => {
    const reason = "No adopted account's directory holds anything to carry, and no source data folder or terminal-client state folder is on this machine.";
    const app = await opened({ reach: "paired", accounts: [{ label: "Server", directory: { kind: "owned", path: "/data/owned" } }],
      setup: { "carry-over": { state: "skipped", reason, failing: [], actions: [] } },
    }, { dataFolder: null, terminalFolder: null });
    expect(screen.getByText(reason)).toBeDefined();
    expect(screen.queryByText(/Not carried from your Claude Code directory/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Server" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    await app.user.click(screen.getByRole("button", { name: "Continue" }));
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Your machines" }).getAttribute("aria-current")).toBe("step");
    expect(app.environment("desk").requests("stateImport.run")).toHaveLength(0);
  });

  it("keeps existing preferences when a real report omits them", async () => {
    const app = await opened();
    act(() => {
      app.presentation.set("textSize", 20);
      app.presentation.set("readingWidth", "full");
      app.presentation.set("reasoningShown", false);
      app.presentation.set("settingsRow", "accounts.usage");
    });
    const imported = report();
    imported.clientLocal = { mode: "light" };
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "accepted", sequence: 1, changed: true }, result: imported,
    } }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Client-local values applied" });
    expect(section().queryByText(/Font size:/)).toBeNull();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "light", textSize: 20, readingWidth: "full", reasoningShown: false, settingsRow: "accounts.usage" });
  });

  it.each([true, false])("requires both the request and reply to be a real application (requested dry run: %s)", async (dryRun) => {
    const app = await opened();
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "accepted", sequence: 1, changed: !dryRun }, result: report(!dryRun),
    } }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: dryRun ? "Dry run" : "Import" }));
    await section().findByRole("heading", { name: "Client-local values not applied" });
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("keeps a second Client's preferences after it hears another Client's completion", async () => {
    const app = await opened();
    const finished = StateImportFinishedPayload.parse(report());
    await screen.findByRole("region", { name: "State import" });
    await act(async () => app.environment("desk").notice("state-import.finished", finished));
    expect(section().queryByRole("region", { name: "State import result" })).toBeNull();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("keeps preferences across restart when the platform's local grant is stale", async () => {
    const paired = await opened({ reach: "paired" });
    paired.shell.answer("localGrant.read", () => paired.environment("desk").wire.grant.read());
    paired.shell.answer("http", async (url, request) => url.endsWith("/api/bootstrap")
      ? { status: 401, json: async () => ({ code: "unauthorized", message: "The fixture grant is stale.", data: {} }) }
      : paired.world.fetch(url, request));
    const app = await paired.remount();
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    expect(app.runtime.local.read()).toMatchObject({ state: "failed", reason: "refused" });
    answerRun(app);
    await screen.findByRole("region", { name: "Set up" });
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Client-local values not applied" });
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("lists values as unapplied when the exchanged grant names a different Environment", async () => {
    const app = await renderApp({ environments: [
      { name: "home", reach: "local" },
      { name: "desk", reach: "paired", capabilities: ["stateImport"] },
    ] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    app.environment("desk").wire.answer("stateImport.detect", () => ({ result: detection() }));
    answerRun(app);
    await screen.findByRole("region", { name: "Set up" });
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Environment" }), app.environment("desk").environmentId);
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Client-local values not applied" });
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("keeps the client's font-size limits and reports the size actually applied", async () => {
    const app = await opened();
    const imported = report();
    imported.clientLocal.fontSize = 100;
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "accepted", sequence: 1, changed: true }, result: imported,
    } }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Import report" });
    expect(section().getByText(/secondary shares a projects folder with primary/)).toBeDefined();
    expect(section().getByText("Font size: 20 (source: 100)")).toBeDefined();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read().textSize).toBe(20);
  });

  it("does not show or detect state import without the capability flag", async () => {
    const app = await opened({ capabilities: [] });
    expect(screen.queryByRole("region", { name: "State import" })).toBeNull();
    expect(app.environment("desk").requests("stateImport.detect")).toHaveLength(0);
  });

  it("is absent when neither source folder is found", async () => {
    const found = { dataFolder: null, terminalFolder: null };
    const app = await opened({}, found);
    await waitFor(() => expect(app.runtime.requests.cached(app.environment("desk").environmentId, "stateImport.detect", {}).read().result).toEqual(found));
    expect(screen.queryByRole("region", { name: "State import" })).toBeNull();
  });

  it("shows a terminal-only source", async () => {
    await opened({}, { dataFolder: null, terminalFolder: { path: "/data/terminal" } });
    await screen.findByRole("region", { name: "State import" });
    expect(section().getByText("Terminal-client state folder: /data/terminal")).toBeDefined();
    expect(section().queryByText(/Data folder:/)).toBeNull();
    expect(section().getByRole("button", { name: "Import" })).toBeDefined();
  });

  it("keeps the found folders readable without admin, disabling both commands", async () => {
    const app = await opened({ reach: "paired", scopes: ["read"] });
    await screen.findByRole("region", { name: "State import" });
    expect(section().getByRole("button", { name: "Dry run" }).hasAttribute("disabled")).toBe(true);
    expect(section().getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(true);
    expect(section().getByText(/Read-only:/)).toBeDefined();
    expect(app.environment("desk").requests("stateImport.run")).toHaveLength(0);
  });

  it.each([
    { reason: "no_source", message: "No source folder was found." },
    { reason: "import_in_progress", message: "A state import is already running." },
  ])("says $reason in one line and allows retry", async ({ reason, message }) => {
    const app = await opened();
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message, data: { reason } } },
    } }));
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    expect(await section().findByText(`Not imported: ${message}`)).toBeDefined();
    expect(section().getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(false);
    expect(section().queryByRole("region", { name: "State import result" })).toBeNull();
    await app.user.click(section().getByRole("button", { name: "Dry run" }));
    await waitFor(() => expect(app.environment("desk").requests("stateImport.run")).toHaveLength(2));
    expect(section().getAllByText(`Not imported: ${message}`)).toHaveLength(1);
    const requests = app.environment("desk").requests("stateImport.run");
    expect(requests[0]?.params["commandId"]).not.toBe(requests[1]?.params["commandId"]);
  });

  it("refreshes what was found, adopted sections and new-session counts when an import finishes", async () => {
    let imported = false;
    const app = await opened({ accounts: [{ label: "Personal" }] }, detection(), (app) => {
      const desk = app.environment("desk");
      const personal = desk.accounts()[0]!;
      desk.wire.answer("accounts.list", () => ({ result: { accounts: imported ? [personal, { ...personal, id: "imported-account", label: "Imported profile", directory: { kind: "adopted", path: "/data/profile" } }] : [personal] } }));
      desk.wire.answer("carryOver.inventory", (params) => {
        const inventory: CarryOverInventory = {
          accountId: String(params["accountId"]), sessions: { total: 5, archived: 0, missingDirectory: 0, new: imported ? 1 : 5 },
          memory: { folders: 0, repositories: 0, unmappable: [], new: 0 },
          skills: { skills: 0, commands: 0, new: 0, offered: [], invalid: 0 }, notCarried: [], doesNotCarry: { hooks: 0, mcpServers: 0, permissionRules: 0 },
        };
        return { result: inventory };
      });
      desk.wire.answer("stateImport.detect", () => ({ result: imported ? { dataFolder: { path: "/data/source", holds: { profiles: 1, banks: 0, routines: 0, instructions: 0, skillSources: 0, connections: 0 } }, terminalFolder: null } : detection() }));
      desk.wire.answer("stateImport.run", () => {
        imported = true;
        return { result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: report() } };
      });
    });
    const personal = within(await screen.findByRole("region", { name: "Personal" }));
    expect(within(await personal.findByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("5");
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Import report" });
    const finished = StateImportFinishedPayload.parse(report());
    await act(async () => app.environment("desk").notice("state-import.finished", finished));
    expect(await screen.findByRole("region", { name: "Imported profile" })).toBeDefined();
    expect(await personal.findByRole("button", { name: "Import 1 new sessions" })).toBeDefined();
    expect(within(await section().findByLabelText("Source holdings")).getByText("Profiles").nextElementSibling?.textContent).toBe("1");
    expect(section().queryByText("Terminal-client state folder: /data/terminal")).toBeNull();
    expect(app.environment("desk").requests("carryOver.run")).toHaveLength(0);
  });

  it.each(["local", "paired"] as const)("applies client-local values only through a local grant (%s), persisting that choice", async (reach) => {
    const app = await opened({ reach });
    answerRun(app);
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Import" }));
    await section().findByRole("heading", { name: "Import report" });
    expect(app.environment("desk").requests("stateImport.run")[0]?.params).toMatchObject({ dryRun: false });
    expect(section().getByRole("heading", { name: reach === "local" ? "Client-local values applied" : "Client-local values not applied" })).toBeDefined();
    for (const text of ["Theme mode: dark", "Font size: 18", "Conversation width: wide", "Show thinking: off", "Last settings row: knowledge.banks"]) expect(section().getByText(text)).toBeDefined();
    if (reach === "paired") expect(section().getByText("These values belong to the environment's machine. Connect through its local grant to apply them on this client.")).toBeDefined();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject(reach === "local"
      ? { lightOrDark: "dark", textSize: 18, readingWidth: "wide", reasoningShown: false, settingsRow: "knowledge.banks" }
      : { lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("shows a dry run's four groups and re-enter links without changing client preferences", async () => {
    const app = await opened();
    answerRun(app);
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(section().getByRole("button", { name: "Dry run" }));
    expect(await section().findByRole("heading", { name: "Dry run report" })).toBeDefined();
    for (const name of ["Carried", "Re-enter", "Arriving in milestone 2", "Not carried"]) expect(section().getByRole("heading", { name })).toBeDefined();
    for (const text of ["Accounts: 2", "Archived sessions: 3", "Pins: 4", "Groups: 5", "Forge accounts: 1", "Key-manager connections: 1", "Banks: 3", "Routines: 4", "Instructions: 5", "Skill sources: 6", "Always-on skills: 2", "Drafts: 1", "Dev sites: 2"]) expect(within(section().getByLabelText("Carried counts")).getByText(text.split(": ")[0] ?? "").nextElementSibling?.textContent).toBe(text.split(": ")[1]);
    expect(section().getByText("Local model (local)")).toBeDefined();
    expect(section().getByText("Model choices: 3")).toBeDefined();
    expect(section().getByText("Nightly digest: Its workspace is missing.")).toBeDefined();
    expect(app.environment("desk").requests("stateImport.run")[0]?.params).toMatchObject({ dryRun: true });
    expect(app.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
    await app.user.click(section().getByRole("button", { name: "Forges: Forge token" }));
    expect(screen.getByRole("navigation", { name: "Set up steps" })).toBeDefined();
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    await app.user.click(section().getByRole("button", { name: "Dry run" }));
    await section().findByRole("heading", { name: "Dry run report" });
    await app.user.click(section().getByRole("button", { name: "Key manager: Vault sign-in" }));
    expect(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
  });

  it("shows the found folders and each kind only when state import is offered", async () => {
    await opened();
    await screen.findByRole("region", { name: "State import" });
    expect(section().getByText("Data folder: /data/source")).toBeDefined();
    expect(section().getByText("Terminal-client state folder: /data/terminal")).toBeDefined();
    expect(within(section().getByLabelText("Source holdings")).getByText("Profiles").nextElementSibling?.textContent).toBe("2");
    expect(section().getByRole("button", { name: "Dry run" })).toBeDefined();
    expect(section().getByRole("button", { name: "Import" })).toBeDefined();
  });
});
