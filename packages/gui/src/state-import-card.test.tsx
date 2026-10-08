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
  sharedProjects: [{ sourceId: "00000000-0000-4000-8000-000000000002", label: "Work", ownerSourceId: "00000000-0000-4000-8000-000000000001", ownerLabel: "Personal" }],
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
const section = () => within(screen.getByRole("region", { name: "Earlier work" }));
const steps = () => within(screen.getByRole("navigation", { name: "Set up steps" }));
/** Details' text once opened: the facts the plain line leaves out. */
const openDetails = async (app: Awaited<ReturnType<typeof opened>>, scope: ReturnType<typeof within>) => {
  await app.user.click(scope.getByRole("button", { name: "Details" }));
  return scope.getByText(/^agent-harness \S+ on /).textContent;
};

describe("State import on Carry over", () => {
  it("draws no blanket repair paragraph for a retained state import, and a preview leaves the step's line as it is", async () => {
    const reason = "The last state import failed part way: Skill source: The repository needs a credential. Import again to retry what failed.";
    const app = await opened({ accounts: [{ label: "Work" }], setup: { "carry-over": {
      state: "needs-attention", reason, actions: ["import-again"], failing: ["carry-over.last-import"],
      targets: [{ action: "import-again", kind: "environment", id: "desk", label: "The state import" }],
    } } });
    await screen.findByRole("region", { name: "Earlier work" });
    // Each failed item says its own fix in the report (#1845): no 50-word paragraph for every failure.
    expect(screen.queryByText(/Provider sign-in does not grant access to private skill repositories/)).toBeNull();
    expect(section().queryByText(/SSH keys and known-hosts entry/)).toBeNull();
    expect(section().queryByRole("button", { name: "Open Forges" })).toBeNull();
    expect(section().queryByRole("button", { name: "Open Skills" })).toBeNull();
    const preview = report(true);
    preview.failed = [];
    preview.reEnter = [];
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: false }, result: preview } }));
    await app.user.click(section().getByRole("button", { name: "Preview" }));
    expect(await section().findByText(/^This would bring over: .*\. Nothing has been changed yet\.$/)).toBeDefined();
    expect(screen.getByText(reason)).toBeDefined();
  });

  it("lets a paired headless environment with signed-in owned accounts finish its empty Carry over step", async () => {
    const reason = "No adopted account's directory holds anything to carry, and no source data folder or terminal-client state folder is on this machine.";
    const app = await opened({ reach: "paired", accounts: [{ label: "Server", directory: { kind: "owned", path: "/data/owned" } }],
      setup: { "carry-over": { state: "skipped", reason, failing: [], actions: [] } },
    }, { dataFolder: null, terminalFolder: null });
    expect(screen.getByText(reason)).toBeDefined();
    expect(screen.queryByText(/Not carried from your Claude Code directory/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Server" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bring it over" })).toBeNull();
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
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    await section().findByRole("heading", { name: "Window preferences" });
    expect(section().getByText("Applied to this window.")).toBeDefined();
    expect(section().queryByText(/Text size:/)).toBeNull();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "light", textSize: 20, readingWidth: "full", reasoningShown: false, settingsRow: "accounts.usage" });
  });

  it.each([true, false])("requires both the request and reply to be a real application (requested dry run: %s)", async (dryRun) => {
    const app = await opened();
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "accepted", sequence: 1, changed: !dryRun }, result: report(!dryRun),
    } }));
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: dryRun ? "Preview" : "Bring it over" }));
    await section().findByRole("heading", { name: "Window preferences" });
    expect(section().queryByText("Applied to this window.")).toBeNull();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("keeps a second Client's preferences after it hears another Client's completion", async () => {
    const app = await opened();
    const finished = StateImportFinishedPayload.parse(report());
    await screen.findByRole("region", { name: "Earlier work" });
    await act(async () => app.environment("desk").notice("state-import.finished", finished));
    expect(section().queryByRole("region", { name: "Earlier work result" })).toBeNull();
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
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    expect(await section().findByText("These apply only on desk's own computer.")).toBeDefined();
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
    await app.user.selectOptions(screen.getByRole("combobox", { name: "Setting up" }), app.environment("desk").environmentId);
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    expect(await section().findByText("These apply only on desk's own computer.")).toBeDefined();
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
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    await section().findByRole("heading", { name: "Brought over" });
    // Each profile is named by its label (#1726); its source id waits under the line's Details, which the keyboard reaches (#1800).
    const shared = section().getByText(/share one projects folder/);
    expect(shared.textContent).toBe("Work and Personal share one projects folder, so their chats and notes come over once, with Personal.");
    expect(section().queryByTitle(/Source id/)).toBeNull();
    expect(section().queryByText(/00000000-0000-4000-8000/)).toBeNull();
    const row = within(shared.parentElement!);
    const details = row.getByRole("button", { name: "Details" });
    for (let presses = 0; presses < 200 && document.activeElement !== details; presses += 1) await app.user.tab();
    expect(document.activeElement).toBe(details);
    await app.user.keyboard("{Enter}");
    expect(row.getByText(/^agent-harness \S+ on /).textContent).toContain("Work source id: 00000000-0000-4000-8000-000000000002\nPersonal source id: 00000000-0000-4000-8000-000000000001");
    expect(section().getByText("Text size: 20 (was 100)")).toBeDefined();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read().textSize).toBe(20);
  });

  it("does not show or detect state import without the capability flag", async () => {
    const app = await opened({ capabilities: [] });
    expect(screen.queryByRole("region", { name: "Earlier work" })).toBeNull();
    expect(app.environment("desk").requests("stateImport.detect")).toHaveLength(0);
  });

  it("is absent when neither source folder is found", async () => {
    const found = { dataFolder: null, terminalFolder: null };
    const app = await opened({}, found);
    await waitFor(() => expect(app.runtime.requests.cached(app.environment("desk").environmentId, "stateImport.detect", {}).read().result).toEqual(found));
    expect(screen.queryByRole("region", { name: "Earlier work" })).toBeNull();
  });

  it("shows a terminal-only source", async () => {
    await opened({}, { dataFolder: null, terminalFolder: { path: "/data/terminal" } });
    await screen.findByRole("region", { name: "Earlier work" });
    expect(section().getByText("Earlier work found in terminal: your terminal history.")).toBeDefined();
    expect(section().queryByText(/\/data\/terminal/)).toBeNull();
    expect(section().getByRole("button", { name: "Bring it over" })).toBeDefined();
  });

  it("keeps the found folders readable without admin, disabling both commands", async () => {
    const app = await opened({ reach: "paired", scopes: ["read"] });
    await screen.findByRole("region", { name: "Earlier work" });
    expect(section().getByRole("button", { name: "Preview" }).hasAttribute("disabled")).toBe(true);
    expect(section().getByRole("button", { name: "Bring it over" }).hasAttribute("disabled")).toBe(true);
    expect(section().getByText(/^You can look but not change this\./)).toBeDefined();
    expect(app.environment("desk").requests("stateImport.run")).toHaveLength(0);
  });

  it.each([
    { reason: "no_source", message: "No source folder was found.", line: "No earlier work is on this computer any more." },
    { reason: "import_in_progress", message: "A state import is already running.", line: "Bringing over is under way already. Wait for it to finish." },
  ])("says $reason in one plain line, the raw refusal under Details, and allows retry", async ({ reason, message, line }) => {
    const app = await opened();
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: {
      receipt: { status: "rejected", sequence: 1, changed: false, reason: "conflict", error: { code: "conflict", message, data: { reason } } },
    } }));
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    const alert = await section().findByRole("alert");
    expect(alert.textContent).toBe(`Error: ${line}`);
    expect(section().queryByText(message)).toBeNull();
    expect(await openDetails(app, within(alert.parentElement!))).toContain(`conflict (${reason}): ${message}`);
    expect(section().getByRole("button", { name: "Bring it over" }).hasAttribute("disabled")).toBe(false);
    expect(section().queryByRole("region", { name: "Earlier work result" })).toBeNull();
    await app.user.click(section().getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(app.environment("desk").requests("stateImport.run")).toHaveLength(2));
    expect(section().getAllByRole("alert")).toHaveLength(1);
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
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    await section().findByRole("heading", { name: "Brought over" });
    const finished = StateImportFinishedPayload.parse(report());
    await act(async () => app.environment("desk").notice("state-import.finished", finished));
    expect(await screen.findByRole("region", { name: "Imported profile" })).toBeDefined();
    expect(await personal.findByRole("button", { name: "Import 1 new sessions" })).toBeDefined();
    expect(await section().findByText("Earlier work found in source: 1 account.")).toBeDefined();
    expect(app.environment("desk").requests("carryOver.run")).toHaveLength(0);
  });

  it.each(["local", "paired"] as const)("applies client-local values only through a local grant (%s), persisting that choice", async (reach) => {
    const app = await opened({ reach });
    answerRun(app);
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    await section().findByRole("heading", { name: "Brought over" });
    expect(app.environment("desk").requests("stateImport.run")[0]?.params).toMatchObject({ dryRun: false });
    expect(section().getByRole("heading", { name: "Window preferences" })).toBeDefined();
    expect(section().getByText(reach === "local" ? "Applied to this window." : "These apply only on desk's own computer.")).toBeDefined();
    for (const text of ["Theme: dark", "Text size: 18", "Reading width: wide", "Show thinking: off", "Last open in Settings: Memory banks"]) expect(section().getByText(text)).toBeDefined();
    expect(section().queryByText(/knowledge\.banks/)).toBeNull();
    const relaunched = await app.remount();
    expect(relaunched.presentation.values.read()).toMatchObject(reach === "local"
      ? { lightOrDark: "dark", textSize: 18, readingWidth: "wide", reasoningShown: false, settingsRow: "knowledge.banks" }
      : { lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
  });

  it("shows a preview's line and its groups, each fix moving inside Set up, without changing client preferences", async () => {
    const app = await opened();
    answerRun(app);
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Preview" }));
    expect(await section().findByText("This would bring over: 2 accounts, 3 archived chats, 4 pinned chats, 5 groups, 1 forge, 1 key manager, 3 memory banks, 4 routines, 5 instructions, 6 skill collections, 2 always-on skills, 1 draft and 2 dev sites. Nothing has been changed yet.")).toBeDefined();
    expect(section().queryByRole("heading", { name: "Brought over" })).toBeNull();
    for (const name of ["Needs you", "Not supported yet", "Not brought over", "Window preferences"]) expect(section().getByRole("heading", { name })).toBeDefined();
    for (const old of ["Dry run report", "Carried", "Re-enter", "Arriving in milestone 2", "Not carried"]) expect(section().queryByRole("heading", { name: old })).toBeNull();
    expect(section().getByText("Local model")).toBeDefined();
    expect(section().getByText("Model choices: 3")).toBeDefined();
    expect(section().getByText("Nightly digest: Its workspace is missing.")).toBeDefined();
    expect(app.environment("desk").requests("stateImport.run")[0]?.params).toMatchObject({ dryRun: true });
    expect(app.presentation.values.read()).toMatchObject({ lightOrDark: "system", textSize: 14, readingWidth: "comfortable", reasoningShown: true, settingsRow: null });
    await app.user.click(section().getByRole("button", { name: "Go to Forges", description: "Forge token" }));
    expect(steps().getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(steps().getByRole("button", { name: "Carry over" }));
    await app.user.click(section().getByRole("button", { name: "Preview" }));
    await section().findByText(/^This would bring over:/);
    await app.user.click(section().getByRole("button", { name: "Go to Key manager", description: "Vault sign-in" }));
    expect(steps().getByRole("button", { name: "Key manager" }).getAttribute("aria-current")).toBe("step");
  });

  it("says what was found in one line, its folders under Details, with Preview and Bring it over", async () => {
    const app = await opened();
    await screen.findByRole("region", { name: "Earlier work" });
    expect(section().getByText("Earlier work found in source: 2 accounts, 3 memory banks, 4 routines, 5 instructions, 6 skill collections, 7 key managers and your terminal history.")).toBeDefined();
    for (const old of [/State import/, /Data folder/, /Terminal-client/, /\/data\//]) expect(section().queryByText(old)).toBeNull();
    expect(await openDetails(app, section())).toContain("Data folder: /data/source\nTerminal folder: /data/terminal");
    expect(section().getByRole("button", { name: "Preview" })).toBeDefined();
    expect(section().getByRole("button", { name: "Bring it over" })).toBeDefined();
  });

  it("names a list it could not read under Details, not in the line", async () => {
    const app = await opened({}, { dataFolder: { path: "C:\\Users\\someone\\earlier", holds: { profiles: 1, banks: null, routines: 0, instructions: 0, skillSources: 0, connections: 0 } }, terminalFolder: null });
    await screen.findByRole("region", { name: "Earlier work" });
    expect(section().getByText("Earlier work found in earlier: 1 account.")).toBeDefined();
    expect(await openDetails(app, section())).toContain("The list of memory banks could not be read.");
  });

  it("shows each failed item with its own fix: Go to Forges, Go to Skills, or its plain line with Details", async () => {
    const app = await opened();
    const partial = report();
    partial.reEnter = [];
    partial.failed = [
      { label: "Skill collection private", message: "Connect a forge for skills.test.", step: "forges", details: ["Repository: https://skills.test/team/private", "fatal: Authentication failed"] },
      { label: 'Always-on Skill "write" (Claude profile "Work")', message: "Skill write is missing.", step: "skills" },
      { label: "Instructions", message: "agent-harness could not read this part of your earlier work.", details: ["The instruction list is not JSON."] },
    ];
    app.environment("desk").wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 1, changed: true }, result: partial } }));
    await screen.findByRole("region", { name: "Earlier work" });
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    const failed = within(await section().findByRole("list", { name: "Did not come over" }));
    expect(section().getByRole("alert").textContent).toContain("Error: Skill collection private: Connect a forge for skills.test.");
    expect(failed.getAllByRole("listitem").map((item) => item.querySelector("span")?.textContent)).toEqual([
      "Error: Skill collection private: Connect a forge for skills.test.",
      'Error: Always-on Skill "write" (Claude profile "Work"): Skill write is missing.',
      "Error: Instructions: agent-harness could not read this part of your earlier work.",
    ]);
    // Repository paths and raw diagnostics are not on screen; they wait under each item's Details.
    for (const raw of [/team\/private/, /Authentication failed/, /not JSON/]) expect(section().queryByText(raw)).toBeNull();
    expect(failed.getAllByRole("button", { name: "Go to Forges" })).toHaveLength(1);
    expect(failed.getAllByRole("button", { name: "Go to Skills" })).toHaveLength(1);
    expect(failed.getAllByRole("button", { name: /^Go to/ })).toHaveLength(2);
    const unread = within(failed.getAllByRole("listitem")[2]!);
    expect(await openDetails(app, unread)).toContain("The instruction list is not JSON.");
    await app.user.click(failed.getByRole("button", { name: "Go to Skills", description: /Skill write is missing\./ }));
    expect(steps().getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("step");
    await app.user.click(steps().getByRole("button", { name: "Carry over" }));
    await app.user.click(section().getByRole("button", { name: "Bring it over" }));
    await app.user.click(await section().findByRole("button", { name: "Go to Forges", description: /Connect a forge for skills\.test\./ }));
    expect(steps().getByRole("button", { name: "Forges" }).getAttribute("aria-current")).toBe("step");
  });
});
