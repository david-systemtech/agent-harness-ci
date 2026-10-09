import { act, screen, waitFor, within } from "@testing-library/react";
import type { CarryOverInventory, CarryOverReport, StateImportDetection } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

/** The #393 harness: the full checklist over the account inventory and import on the scripted wire; Carry over reads setup-copy.md §5.3 (#1844). */
const inventory = (accountId = "account-1"): CarryOverInventory => ({
  accountId,
  sessions: { total: 5, archived: 2, missingDirectory: 1, new: 5 },
  memory: { folders: 2, repositories: 1, unmappable: [], new: 2 },
  skills: { skills: 3, commands: 1, new: 4, offered: [], invalid: 0 },
  notCarried: [
    { kind: "subagent", name: "helper" },
    { kind: "plugin", name: "extra" },
  ],
  doesNotCarry: { hooks: 2, mcpServers: 3, permissionRules: 4 },
});
const report = (accountId = "account-1"): CarryOverReport => ({
  accountId,
  dryRun: false,
  sessions: {
    listed: 5,
    imported: 5,
    archived: 2,
    missingDirectory: 1,
    held: 0,
  },
  memory: {
    folders: [
      { folder: "project", path: "/home/milo/.claude/projects/project/memory", key: "https://git.home.test/milo/project", outcome: "copied", under: null, digest: `sha256:${"0".repeat(64)}` },
    ],
    unmappable: [],
  },
  failed: [],
});
/** What an inventory reads after an import brought everything over: the same counts, nothing new. */
const imported = (accountId = "account-1"): CarryOverInventory => {
  const after = inventory(accountId);
  return { ...after, sessions: { ...after.sessions, new: 0 }, memory: { ...after.memory, new: 0 }, skills: { ...after.skills, new: 0 } };
};
const opened = async (
  desk: Partial<ScriptedEnvironment> = {},
  listed = inventory(),
  others: readonly ScriptedEnvironment[] = [],
  ready = "Personal: 5 past chats, 2 notes folders, 4 skills.",
  prepare?: (environment: ReturnType<Awaited<ReturnType<typeof renderApp>>["environment"]>) => void,
) => {
  const app = await renderApp(
    {
      environments: [
        {
          name: "desk",
          reach: "local",
          accounts: [{ label: "Personal" }],
          ...desk,
        },
        ...others,
      ],
    },
    { firstLaunch: true },
  );
  await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
  const environment = app.environment("desk");
  environment.wire.answer("carryOver.inventory", (params) => ({
    result: { ...listed, accountId: String(params["accountId"]) },
  }));
  environment.wire.answer("carryOver.run", (params) => ({
    result: {
      receipt: { status: "accepted", sequence: 1, changed: true },
      result: report(String(params["accountId"])),
    },
  }));
  prepare?.(environment);
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
  await screen.findByText(ready);
  return app;
};
const answerInventory = (app: Awaited<ReturnType<typeof opened>>, listed: CarryOverInventory) =>
  app.environment("desk").wire.answer("carryOver.inventory", (params) => ({ result: { ...listed, accountId: String(params["accountId"]) } }));
/** The step's line after an import, as the environment words it: the card's own Everything is already here is not said twice. */
const BROUGHT_OVER: ScriptedEnvironment["setup"] = { "carry-over": { state: "done", reason: "Brought over today at 16:24.", failing: [], actions: [] } };
/** The step before any import reached Personal, as the environment words it (setup-copy.md §5.3). */
const NEVER_BROUGHT: ScriptedEnvironment["setup"] = {
  "carry-over": {
    state: "needs-attention",
    reason: "Personal has past chats to bring over. Choose Bring them over.",
    actions: ["import-again"],
    failing: ["carry-over.last-import"],
    targets: [{ action: "import-again", kind: "account", id: "account-1", label: "Personal" }],
  },
};
/** The step's last-import naming accounts with import-again: never brought over, or left items behind, as its line says. */
const needsImport = (reason: string, accounts: readonly (readonly [string, string])[]) => ({
  state: "needs-attention" as const,
  reason,
  actions: ["import-again" as const],
  failing: ["carry-over.last-import"],
  targets: accounts.map(([id, label]) => ({ action: "import-again" as const, kind: "account" as const, id, label })),
});
/** Carry over for Personal and Work, earlier work found in a data folder, each account's inventory as `listed` gives it. */
const withEarlierWork = async (setup: ScriptedEnvironment["setup"], listed: (accountId: string) => CarryOverInventory) => {
  const found: StateImportDetection = { dataFolder: { path: "/data/source", holds: { profiles: 1, banks: 0, routines: 0, instructions: 0, skillSources: 0, connections: 0 } }, terminalFolder: null };
  const app = await opened({ capabilities: ["stateImport"], accounts: [{ label: "Personal" }, { label: "Work" }], setup }, inventory(), [], undefined, (desk) => {
    desk.wire.answer("carryOver.inventory", (params) => ({ result: listed(String(params["accountId"])) }));
    desk.wire.answer("stateImport.detect", () => ({ result: found }));
    desk.wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 3, changed: true } } }));
  });
  await screen.findByRole("region", { name: "State import" });
  return app;
};
const fold = async (app: Awaited<ReturnType<typeof opened>>, name: string) => {
  await app.user.click(screen.getByRole("button", { name }));
  return within(screen.getByRole("button", { name }).parentElement as HTMLElement);
};

describe("Carry over in Set up", () => {
  it("says in one sentence per sign-in what it found, keeps the counts in What will come over and brings every adopted account over with one button", async () => {
    const app = await opened({
      accounts: [{ label: "Personal" }, { label: "Work" }, { label: "Owned", directory: { kind: "owned", path: "/home/milo/owned" } }],
    });
    expect(screen.getByText("Work: 5 past chats, 2 notes folders, 4 skills.")).toBeDefined();
    expect(screen.queryByText(/^Owned:/)).toBeNull();
    // No count before the button: they wait in the fold.
    expect(screen.queryByText("Past chats")).toBeNull();
    const coming = await fold(app, "What will come over");
    const personal = coming.getByLabelText("Personal");
    for (const [name, value] of [["Past chats", "5"], ["New chats", "5"], ["Notes folders", "2"], ["Skills", "4"]] as const) {
      expect(within(personal).getByText(name).nextElementSibling?.textContent).toBe(value);
    }
    expect(screen.getByRole("checkbox", { name: "Bring over skills too" })).toHaveProperty("checked", true);
    expect(screen.getAllByRole("button", { name: /^Bring|^Import|^Try again/ }).map((button) => button.textContent)).toEqual(["Bring them over"]);
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    expect(await screen.findByText("Brought over 10 chats and 2 notes folders.")).toBeDefined();
    expect(app.environment("desk").requests("carryOver.run").map((request) => request.params)).toEqual([
      expect.objectContaining({ accountId: "account-1", dryRun: false, skills: true }),
      expect.objectContaining({ accountId: "account-2", dryRun: false, skills: true }),
    ]);
  });

  it("lists what will not come over in its fold, and names where skills live only after skills came over", async () => {
    const app = await opened();
    expect(screen.queryByText("Prompt history")).toBeNull();
    const notComing = await fold(app, "What will not come over");
    expect(notComing.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Your Claude Code settings, hooks and plugins",
      "Personal MCP servers and permission rules",
      "Subagents",
      "Prompt history",
      "Repository trust",
    ]);
    expect(notComing.getByText("Claude Code keeps all of these. You can set them up again in agent-harness when you need them.")).toBeDefined();
    // The old paragraph is gone for good.
    expect(screen.queryByText(/Not carried from your Claude Code directory/)).toBeNull();
    expect(screen.queryByText("Your skills now live in agent-harness. Edit them there.")).toBeNull();
    const withSkills = report();
    withSkills.skills = { accountId: "account-1", dryRun: false, copied: [{ kind: "skill", name: "review", from: "/home/milo/.claude/skills/review", path: "skills/review" }], kept: [], offered: [], invalid: [], notCarried: [] };
    app.environment("desk").wire.answer("carryOver.run", () => ({ result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: withSkills } }));
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    expect(await screen.findByText("Your skills now live in agent-harness. Edit them there.")).toBeDefined();
  });

  it("says Looking for past work while the directory is read", async () => {
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }] }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    const answers: ((answer: { result: CarryOverInventory }) => void)[] = [];
    app.environment("desk").wire.answer("carryOver.inventory", () => new Promise<{ result: CarryOverInventory }>((resolve) => answers.push(resolve)));
    await screen.findByRole("region", { name: "Set up" });
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    expect(await screen.findByText("Looking for past work…")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Bring them over" })).toBeNull();
    await waitFor(() => expect(answers.length).toBeGreaterThan(0));
    await act(async () => { for (const answer of answers) answer({ result: inventory() }); });
    expect(await screen.findByRole("button", { name: "Bring them over" })).toBeDefined();
    expect(screen.queryByText("Looking for past work…")).toBeNull();
  });

  it("says a directory it could not read as an alert naming the account, with Check again and the raw words in Details", async () => {
    const app = await opened({ accounts: [{ label: "Personal" }, { label: "Work" }] });
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.inventory", (params) => params["accountId"] === "account-2"
      ? { error: { code: "internal", message: "EACCES: permission denied, scandir '/home/milo/.claude-work'", data: {} } }
      : { result: inventory() });
    await act(async () => desk.notice("carry-over.imported", report("account-2")));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/agent-harness could not look at Work's past work\./).textContent).toBe("Error: agent-harness could not look at Work's past work.");
    expect(within(alert).getByText("Choose Check again.")).toBeDefined();
    expect(within(alert).queryByText(/EACCES/)).toBeNull();
    await app.user.click(within(alert).getByRole("button", { name: "Details" }));
    expect(within(alert).getByText(/internal: EACCES: permission denied/)).toBeDefined();
    const before = desk.requests("carryOver.inventory").length;
    desk.wire.answer("carryOver.inventory", (params) => ({ result: inventory(String(params["accountId"])) }));
    await app.user.click(within(alert).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(desk.requests("carryOver.inventory").length).toBeGreaterThan(before));
    expect(await screen.findByText("Work: 5 past chats, 2 notes folders, 4 skills.")).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says Everything is already here when nothing new came over, and offers Bring over 1 new chat for one later chat", async () => {
    const app = await opened({ setup: BROUGHT_OVER });
    const desk = app.environment("desk");
    const nothing = report();
    nothing.sessions = { ...nothing.sessions, imported: 0, held: 5 };
    nothing.memory = { folders: [], unmappable: [] };
    desk.wire.answer("carryOver.run", () => ({ result: { receipt: { status: "accepted", sequence: 2, changed: false }, result: nothing } }));
    answerInventory(app, imported());
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    expect(await screen.findByText("Everything is already here.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Bring/ })).toBeNull();
    answerInventory(app, { ...imported(), sessions: { ...imported().sessions, total: 6, new: 1 } });
    await act(async () => desk.notice("carry-over.imported", report()));
    await app.user.click(await screen.findByRole("button", { name: "Bring over 1 new chat" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
  });

  it("offers Bring over 2 new chats once another client imports, and Everything is already here when all are held", async () => {
    const app = await opened({ setup: BROUGHT_OVER });
    const desk = app.environment("desk");
    answerInventory(app, { ...imported(), sessions: { total: 7, archived: 3, missingDirectory: 2, new: 2 } });
    await act(async () => desk.notice("carry-over.imported", report()));
    expect(await screen.findByRole("button", { name: "Bring over 2 new chats" })).toBeDefined();
    answerInventory(app, imported());
    await act(async () => desk.notice("carry-over.imported", report()));
    expect(await screen.findByText("Everything is already here.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Bring over/ })).toBeNull();
    expect(desk.requests("carryOver.run")).toHaveLength(0);
  });

  it("brings over without skills when the tick is off", async () => {
    const app = await opened();
    await app.user.click(screen.getByRole("checkbox", { name: "Bring over skills too" }));
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ dryRun: false, skills: false });
  });

  it("counts what did not come over from an account, lists it in Details, and turns the one button into Try again", async () => {
    const app = await opened({ accounts: [{ label: "Personal" }, { label: "Work" }] });
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.run", (params) => {
      const ran = report(String(params["accountId"]));
      if (params["accountId"] === "account-2") ran.failed = [{ providerSessionId: "failed-session", message: "The workspace could not be read." }];
      return { result: { receipt: { status: "accepted", sequence: 4, changed: true }, result: ran } };
    });
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    const notice = within(await screen.findByRole("alert"));
    expect(notice.getByText("1 item from Work did not come over.")).toBeDefined();
    expect(notice.getByText("Choose Try again.")).toBeDefined();
    expect(notice.queryByText(/failed-session/)).toBeNull();
    await app.user.click(notice.getByRole("button", { name: "Details" }));
    expect(notice.getByText(/failed-session: The workspace could not be read\./)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Bring them over" })).toBeNull();
    await app.user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(4));
  });

  it("offers Try again as its one button for an account the step names after a part-failed import, and no Import again", async () => {
    const after = { ...inventory("account-2"), sessions: { ...inventory().sessions, new: 1 } };
    const app = await opened(
      {
        accounts: [{ label: "Work" }],
        setup: {
          "carry-over": {
            state: "needs-attention",
            reason: "1 item from Work did not come over. Choose Try again.",
            actions: ["import-again"],
            failing: ["carry-over.last-import"],
            targets: [{ action: "import-again", kind: "account", id: "account-1", label: "Work" }],
          },
        },
      },
      after,
      [],
      "Work: 5 past chats, 2 notes folders, 4 skills.",
    );
    expect(screen.getAllByRole("button", { name: /^Bring|^Import|^Try again/ }).map((button) => button.textContent)).toEqual(["Try again"]);
    await app.user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ accountId: "account-1", dryRun: false });
  });

  it("offers Try again for an account the step names after an import that brought nothing over", async () => {
    await opened({
      setup: {
        "carry-over": {
          state: "needs-attention",
          reason: "5 items from Personal did not come over. Choose Try again.",
          actions: ["import-again"],
          failing: ["carry-over.last-import"],
          targets: [{ action: "import-again", kind: "account", id: "account-1", label: "Personal" }],
        },
      },
    });
    expect(screen.getAllByRole("button", { name: /^Bring|^Import|^Try again/ }).map((button) => button.textContent)).toEqual(["Try again"]);
  });

  it("says Everything is already here for a folder of skills alone once they are all brought over", async () => {
    const skillsOnly: CarryOverInventory = {
      ...inventory(),
      sessions: { total: 0, archived: 0, missingDirectory: 0, new: 0 },
      memory: { folders: 0, repositories: 0, unmappable: [], new: 0 },
      skills: { skills: 2, commands: 0, new: 0, offered: [], invalid: 0 },
    };
    await opened({ setup: BROUGHT_OVER }, skillsOnly, [], "Personal: 0 past chats, 0 notes folders, 2 skills.");
    expect(await screen.findByText("Everything is already here.")).toBeDefined();
    expect(screen.queryByRole("button", { name: /^Bring|^Try again/ })).toBeNull();
  });

  it("says a skill with a problem in a notice of its own, without Try again, since a re-run leaves it where it is", async () => {
    const app = await opened();
    app.environment("desk").wire.answer("carryOver.run", (params) => {
      const ran = report(String(params["accountId"]));
      ran.skills = {
        accountId: ran.accountId, dryRun: false, copied: [], kept: [], offered: [], notCarried: [],
        invalid: [{ kind: "skill", name: null, from: "/home/milo/.claude/skills/broken", problems: [{ kind: "description", message: "Its frontmatter has no description." }] }],
      };
      return { result: { receipt: { status: "accepted", sequence: 6, changed: true }, result: ran } };
    });
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    const notice = within(await screen.findByRole("alert"));
    expect(notice.getByText("1 skill from Personal has a problem, so it stays where it is.")).toBeDefined();
    expect(notice.queryByText("Choose Try again.")).toBeNull();
    await app.user.click(notice.getByRole("button", { name: "Details" }));
    expect(notice.getByText(/\/home\/milo\/\.claude\/skills\/broken: Its frontmatter has no description\./)).toBeDefined();
    expect(screen.queryByText(/did not come over/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("does not bring the earlier work over again when a second sign-in is brought over after the first", async () => {
    const app = await withEarlierWork(
      { "carry-over": needsImport("Work has past chats to bring over. Choose Bring them over.", [["account-2", "Work"]]) },
      (accountId) => (accountId === "account-1" ? imported() : inventory(accountId)),
    );
    const desk = app.environment("desk");
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
    await screen.findByText(/^Brought over/);
    expect(desk.requests("stateImport.run")).toHaveLength(0);
  });

  it("does not bring the earlier work over with a new sign-in while the step says an earlier import left items behind", async () => {
    const app = await withEarlierWork(
      {
        "carry-over": needsImport("1 item from Personal did not come over. Choose Try again. Work has past chats to bring over. Choose Bring them over.", [
          ["account-1", "Personal"],
          ["account-2", "Work"],
        ]),
      },
      (accountId) => inventory(accountId),
    );
    const desk = app.environment("desk");
    await app.user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
    await screen.findByText(/^Brought over/);
    expect(desk.requests("stateImport.run")).toHaveLength(0);
  });

  it("brings the earlier work over when the step's import check took too long, as the inventory says nothing came over yet", async () => {
    const app = await withEarlierWork(
      { "carry-over": { state: "needs-attention", reason: "Checking took too long. Choose Check again.", details: ["Stopped after 5 seconds."], failing: ["carry-over.last-import"], actions: ["check-again"] } },
      (accountId) => inventory(accountId),
    );
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(app.environment("desk").requests("stateImport.run")).toHaveLength(1));
  });

  it("brings the earlier work over once when every account's run is refused and Bring them over is chosen again", async () => {
    const app = await withEarlierWork(
      { "carry-over": needsImport("Personal has past chats to bring over. Choose Bring them over. Work has past chats to bring over. Choose Bring them over.", [["account-1", "Personal"], ["account-2", "Work"]]) },
      (accountId) => inventory(accountId),
    );
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.run", () => ({
      result: {
        receipt: {
          status: "rejected", sequence: 5, changed: false, reason: "conflict",
          error: { code: "conflict", message: "Bringing over past work is under way already. Wait for it to finish.", data: { reason: "import_in_progress" } },
        },
      },
    }));
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Bring them over" }).hasAttribute("disabled")).toBe(false));
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(4));
    expect(desk.requests("stateImport.run")).toHaveLength(1);
  });

  it("brings the earlier work over with the first Bring them over when a chat run here or a checkout offered as a skill already reads as not new", async () => {
    const found: StateImportDetection = { dataFolder: { path: "/data/source", holds: { profiles: 1, banks: 0, routines: 0, instructions: 0, skillSources: 0, connections: 0 } }, terminalFolder: null };
    const held: CarryOverInventory = { ...inventory(), sessions: { ...inventory().sessions, new: 4 }, skills: { ...inventory().skills, new: 0 } };
    const app = await opened({ capabilities: ["stateImport"], setup: NEVER_BROUGHT }, held, [], undefined, (desk) => {
      desk.wire.answer("stateImport.detect", () => ({ result: found }));
      desk.wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 3, changed: true } } }));
    });
    const desk = app.environment("desk");
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(desk.requests("stateImport.run")).toHaveLength(1));
    expect(desk.requests("carryOver.run")).toHaveLength(1);
  });

  it("brings the earlier work over with the first Bring them over, and not again with new chats later", async () => {
    const found: StateImportDetection = { dataFolder: { path: "/data/source", holds: { profiles: 1, banks: 0, routines: 0, instructions: 0, skillSources: 0, connections: 0 } }, terminalFolder: null };
    const app = await opened({ capabilities: ["stateImport"], setup: NEVER_BROUGHT }, inventory(), [], undefined, (desk) => {
      desk.wire.answer("stateImport.detect", () => ({ result: found }));
      desk.wire.answer("stateImport.run", () => ({ result: { receipt: { status: "accepted", sequence: 3, changed: true } } }));
    });
    const desk = app.environment("desk");
    await screen.findByRole("region", { name: "State import" });
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(desk.requests("stateImport.run")).toHaveLength(1));
    expect(desk.requests("stateImport.run")[0]?.params).toMatchObject({ dryRun: false });
    act(() => desk.setSetup({ "carry-over": { state: "done", reason: "Brought over today at 16:24.", failing: [], actions: [], targets: [] } }));
    await app.user.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("Brought over today at 16:24.");
    answerInventory(app, { ...imported(), sessions: { ...imported().sessions, total: 7, new: 2 } });
    await act(async () => desk.notice("carry-over.imported", report()));
    await app.user.click(await screen.findByRole("button", { name: "Bring over 2 new chats" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
    expect(desk.requests("stateImport.run")).toHaveLength(1);
  });

  it("says a refusal in plain words as an alert, its raw words in Details, and lets the person try again", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.run", () => ({
      result: {
        receipt: {
          status: "rejected",
          sequence: 5,
          changed: false,
          reason: "conflict",
          error: { code: "conflict", message: "Bringing over past work is under way already. Wait for it to finish.", data: { reason: "import_in_progress" } },
        },
      },
    }));
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    const alert = within(await screen.findByRole("alert"));
    expect(alert.getByText(/This cannot be done right now\. Wait a moment, then choose Bring them over\./)).toBeDefined();
    await app.user.click(alert.getByRole("button", { name: "Details" }));
    expect(alert.getByText(/conflict \(import_in_progress\): Bringing over past work is under way already/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Bring them over" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("region", { name: "What came over" })).toBeNull();
  });

  it("asks which project notes with no match belong to, and uses the choice for them", async () => {
    const listed = inventory();
    listed.memory.unmappable = [{ folder: "lost-project", path: "/home/milo/.claude/projects/lost-project/memory" }];
    const app = await opened(
      { sessions: [{ repositoryIdentity: "https://git.home.test/milo/project" }] },
      listed,
      [{ name: "remote", reach: "paired", sessions: [{ repositoryIdentity: "https://git.home.test/milo/remote" }] }],
    );
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.assignMemory", () => ({ result: { receipt: { status: "accepted", sequence: 2, changed: true } } }));
    expect(screen.getByText("Notes from lost-project do not match a project here. Choose the project they belong to:")).toBeDefined();
    expect(screen.queryByText(/\/home\/milo/)).toBeNull();
    const picker = screen.getByRole("combobox", { name: "Project for the notes from lost-project" });
    expect(within(picker).queryByRole("option", { name: "https://git.home.test/milo/remote" })).toBeNull();
    await app.user.selectOptions(picker, "https://git.home.test/milo/project");
    await app.user.click(screen.getByRole("button", { name: "Use for these notes" }));
    expect(await screen.findByText("These notes now belong to https://git.home.test/milo/project.")).toBeDefined();
    expect(desk.requests("carryOver.assignMemory")[0]?.params).toMatchObject({ accountId: "account-1", folder: "lost-project", repositoryIdentity: "https://git.home.test/milo/project" });
  });

  it("says to bring the chats over first when no project is here to choose", async () => {
    const listed = inventory();
    listed.memory.unmappable = [{ folder: "lost-project", path: "/home/milo/.claude/projects/lost-project/memory" }];
    await opened({}, listed);
    expect(screen.getByText("Bring your chats over first. Then you can choose a project for these notes.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Use for these notes" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    { kind: "branch", branch: "main" },
    { kind: "pinned", commit: "0".repeat(40) },
  ] as const)("offers to keep a skills folder from its site up to date at its $kind, its address in Details", async (follow) => {
    const listed = inventory();
    listed.skills.offered = [{ name: "review", from: "/home/milo/.agents/skills/review", url: "https://git.home.test/milo/skills.git", folder: "skills/review", follow }];
    const app = await opened({}, listed);
    app.environment("desk").wire.answer("skills.sources.add", () => ({ result: { receipt: { status: "accepted", sequence: 3, changed: true } } }));
    const offer = within(screen.getByRole("region", { name: "Skills folder: review" }));
    expect(offer.getByText("review is a skills folder from git.home.test.")).toBeDefined();
    expect(offer.queryByText(/skills\.git/)).toBeNull();
    await app.user.click(offer.getByRole("button", { name: "Details" }));
    expect(offer.getByText(/Address: https:\/\/git\.home\.test\/milo\/skills\.git/)).toBeDefined();
    await app.user.click(offer.getByRole("button", { name: "Keep it up to date" }));
    expect(await offer.findByText("agent-harness keeps review up to date now.")).toBeDefined();
    expect(app.environment("desk").requests("skills.sources.add")[0]?.params).toMatchObject({ url: "https://git.home.test/milo/skills.git", folder: "skills/review", follow });
  });

  it("names an scp-style remote's site", async () => {
    const listed = inventory();
    listed.skills.offered = [{ name: "review", from: "/home/milo/.agents/skills/review", url: "git@git.home.test:milo/skills.git", folder: "skills/review", follow: { kind: "branch", branch: "main" } }];
    await opened({}, listed);
    expect(screen.getByText("review is a skills folder from git.home.test.")).toBeDefined();
  });

  it("keeps everything read-only without admin and says the capability's line once", async () => {
    const listed = inventory();
    listed.memory.unmappable = [{ folder: "lost", path: "/home/milo/.claude/projects/lost/memory" }];
    listed.skills.offered = [{ name: "review", from: "/home/milo/.agents/skills/review", url: "https://git.home.test/milo/skills.git", folder: "skills/review", follow: { kind: "branch", branch: "main" } }];
    const app = await opened({ scopes: ["read", "sessions:write", "runs:drive", "terminal"] }, listed);
    const capability = app.runtime.capability(app.environment("desk").environmentId, "carryOver.run");
    expect(capability.status).toBe("absent");
    if (capability.status === "absent") expect(screen.getAllByText(`You can look but not change this. ${capability.message}`)).toHaveLength(1);
    for (const control of [
      screen.getByRole("checkbox", { name: "Bring over skills too" }),
      screen.getByRole("combobox", { name: "Project for the notes from lost" }),
      screen.getByRole("button", { name: "Use for these notes" }),
      screen.getByRole("button", { name: "Keep it up to date" }),
      screen.getByRole("button", { name: "Bring them over" }),
    ])
      expect(control.hasAttribute("disabled")).toBe(true);
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    expect(app.environment("desk").requests("carryOver.run")).toHaveLength(0);
  });

  it.each([
    { skills: 0, commands: 0, tick: undefined },
    { skills: 0, commands: 1, tick: true },
  ])("shows the skills tick, on, only when $skills skills and $commands commands are there to bring", async ({ skills, commands, tick }) => {
    const listed = inventory();
    listed.skills = { ...listed.skills, skills, commands };
    await opened({}, listed, [], `Personal: 5 past chats, 2 notes folders, ${skills + commands} ${skills + commands === 1 ? "skill" : "skills"}.`);
    const box = screen.queryByRole("checkbox", { name: "Bring over skills too" });
    expect(box === null ? undefined : (box as HTMLInputElement).checked).toBe(tick);
  });

  it("reads the directory again when Carry over is reopened for a re-run", async () => {
    const app = await opened({ setup: BROUGHT_OVER });
    answerInventory(app, imported());
    await act(async () => app.environment("desk").notice("carry-over.imported", report()));
    await screen.findByText("Everything is already here.");
    const rail = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(rail.getByRole("button", { name: "Appearance" }));
    answerInventory(app, { ...imported(), sessions: { ...imported().sessions, new: 2 } });
    await app.user.click(rail.getByRole("button", { name: "Carry over" }));
    expect(await screen.findByRole("button", { name: "Bring over 2 new chats" })).toBeDefined();
  });

  it("ticks skills found by the on-open refresh of a warmed inventory that had none", async () => {
    const empty = inventory();
    empty.skills = { ...empty.skills, skills: 0, commands: 0 };
    const app = await opened({}, empty, [], "Personal: 5 past chats, 2 notes folders, 0 skills.");
    const rail = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(rail.getByRole("button", { name: "Appearance" }));
    const answers: ((answer: { result: CarryOverInventory }) => void)[] = [];
    app.environment("desk").wire.answer("carryOver.inventory", () => new Promise<{ result: CarryOverInventory }>((resolve) => answers.push(resolve)));
    await app.user.click(rail.getByRole("button", { name: "Carry over" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(await screen.findByText("Personal: 5 past chats, 2 notes folders, 0 skills.")).toBeDefined();
    await act(async () => answers[0]?.({ result: inventory() }));
    expect(await screen.findByRole("checkbox", { name: "Bring over skills too" })).toHaveProperty("checked", true);
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ skills: true });
  });

  it("keeps an explicit skills choice when an inventory refresh comes in", async () => {
    const app = await opened();
    await app.user.click(screen.getByRole("checkbox", { name: "Bring over skills too" }));
    answerInventory(app, { ...inventory(), sessions: { ...inventory().sessions, total: 6, new: 6 } });
    await act(async () => app.environment("desk").notice("carry-over.imported", report()));
    expect(await screen.findByText("Personal: 6 past chats, 2 notes folders, 4 skills.")).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Bring over skills too" })).toHaveProperty("checked", false);
    await app.user.click(screen.getByRole("button", { name: "Bring them over" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ skills: false });
  });

  it("says Everything is already here once, when the step's own line already says it", async () => {
    const app = await opened();
    answerInventory(app, imported());
    await act(async () => app.environment("desk").notice("carry-over.imported", report()));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Bring them over" })).toBeNull());
    expect(screen.getAllByText("Everything is already here.")).toHaveLength(1);
  });

  it("is two lines and nothing more when there is nothing to bring over", async () => {
    const skipped: ScriptedEnvironment["setup"] = { "carry-over": { state: "skipped", reason: "Nothing to bring over from this computer.", failing: [], actions: [] } };
    const app = await renderApp({ environments: [{ name: "desk", reach: "local", accounts: [{ label: "Personal" }], setup: skipped }] }, { firstLaunch: true });
    await app.user.click(await screen.findByRole("button", { name: "Begin set up" }));
    await screen.findByRole("region", { name: "Set up" });
    await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
    expect(await screen.findByText("Nothing to bring over from this computer.")).toBeDefined();
    expect(screen.getByText("You can continue.")).toBeDefined();
    expect(screen.queryByText(/^Personal:/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Bring|What will|Check now/ })).toBeNull();
  });
});
