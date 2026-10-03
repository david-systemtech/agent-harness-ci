import { act, screen, waitFor, within } from "@testing-library/react";
import type { CarryOverInventory, CarryOverReport } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type ScriptedEnvironment } from "../test/harness.js";

/** The #393 harness: the full checklist over the account inventory and import on the scripted wire. */
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
  memory: { folders: [], unmappable: [] },
  failed: [],
});
const opened = async (desk: Partial<ScriptedEnvironment> = {}, listed = inventory(), others: readonly ScriptedEnvironment[] = []) => {
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
  environment.wire.answer("carryOver.run", () => ({
    result: {
      receipt: { status: "accepted", sequence: 1, changed: true },
      result: report(),
    },
  }));
  await screen.findByRole("region", { name: "Set up" });
  await app.user.click(within(screen.getByRole("navigation", { name: "Set up steps" })).getByRole("button", { name: "Carry over" }));
  await screen.findByRole("region", { name: "Personal" });
  return app;
};
const account = (name = "Personal") => within(screen.getByRole("region", { name }));

describe("Carry over in Set up", () => {
  it("shows the adopted account's counts and imports with the skills tick on", async () => {
    const app = await opened();
    const personal = account();
    const counts = await personal.findByLabelText("Sessions");
    expect(within(counts).getByText("Sessions").nextElementSibling?.textContent).toBe("5");
    expect(within(counts).getByText("Archived").nextElementSibling?.textContent).toBe("2");
    expect(within(counts).getByText("Missing directory").nextElementSibling?.textContent).toBe("1");
    for (const [group, name, value] of [["Memory", "Memory folders", "2"], ["Memory", "Repositories", "1"], ["Skills and commands", "Skills", "3"], ["Skills and commands", "Commands", "1"], ["Not carried", "Agents", "1"], ["Not carried", "Plugins", "1"], ["Not carried", "Hooks", "2"], ["Not carried", "Personal MCP servers", "3"], ["Not carried", "Permission rules", "4"]] as const) {
      expect(within(personal.getByLabelText(group)).getByText(name).nextElementSibling?.textContent).toBe(value);
    }
    expect(personal.getByRole("checkbox", { name: "Copy skills and commands" })).toHaveProperty("checked", true);
    await app.user.click(personal.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({
      accountId: "account-1",
      dryRun: false,
      skills: true,
    });
    expect(within(await personal.findByLabelText("Imported sessions")).getByText("Imported").nextElementSibling?.textContent).toBe("5");
  });
  it("imports without skills when the tick is off, then offers two new sessions on a re-run", async () => {
    const app = await opened();
    const personal = account();
    await personal.findByRole("checkbox", { name: "Copy skills and commands" });
    await app.user.click(personal.getByRole("checkbox", { name: "Copy skills and commands" }));
    const next = inventory();
    next.sessions.new = 2;
    app.environment("desk").wire.answer("carryOver.inventory", () => ({ result: next }));
    await app.user.click(personal.getByRole("button", { name: "Import" }));
    expect(await personal.findByRole("button", { name: "Import 2 new sessions" })).toBeDefined();
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ dryRun: false, skills: false });
    await app.user.click(personal.getByRole("button", { name: "Import 2 new sessions" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(2));
    expect(app.environment("desk").requests("carryOver.run")[1]?.params).toMatchObject({ skills: false });
  });

  it("assigns an unmappable memory folder to a repository on this environment", async () => {
    const listed = inventory();
    listed.memory.unmappable = [
      {
        folder: "lost-project",
        path: "/home/milo/.claude/projects/lost-project/memory",
      },
    ];
    const app = await opened(
      {
        sessions: [{ repositoryIdentity: "https://git.home.test/milo/project" }],
      },
      listed,
      [
        {
          name: "remote",
          reach: "paired",
          sessions: [{ repositoryIdentity: "https://git.home.test/milo/remote" }],
        },
      ],
    );
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.assignMemory", () => ({
      result: { receipt: { status: "accepted", sequence: 2, changed: true } },
    }));
    const picker = await account().findByRole("combobox", {
      name: "Repository for lost-project",
    });
    expect(
      within(picker).queryByRole("option", {
        name: "https://git.home.test/milo/remote",
      }),
    ).toBeNull();
    await app.user.selectOptions(picker, "https://git.home.test/milo/project");
    await app.user.click(account().getByRole("button", { name: "Assign memory: lost-project" }));
    expect(await account().findByText("Assigned lost-project to https://git.home.test/milo/project.")).toBeDefined();
    expect(desk.requests("carryOver.assignMemory")[0]?.params).toMatchObject({
      accountId: "account-1",
      folder: "lost-project",
      repositoryIdentity: "https://git.home.test/milo/project",
    });
  });

  it.each([
    { kind: "branch", branch: "main" },
    { kind: "pinned", commit: "0".repeat(40) },
  ] as const)("tracks a checkout as a source using its offered URL, folder and $kind", async (follow) => {
    const listed = inventory();
    listed.skills.offered = [
      {
        name: "review",
        from: "/home/milo/.agents/skills/review",
        url: "https://git.home.test/milo/skills.git",
        folder: "skills/review",
        follow,
      },
    ];
    const app = await opened({}, listed);
    app.environment("desk").wire.answer("skills.sources.add", () => ({
      result: {
        receipt: { status: "accepted", sequence: 3, changed: true },
      },
    }));
    await app.user.click(await account().findByRole("button", { name: "Track as a source" }));
    expect(await account().findByText("Tracking review as a source.")).toBeDefined();
    expect(app.environment("desk").requests("skills.sources.add")[0]?.params).toMatchObject({
      url: "https://git.home.test/milo/skills.git",
      folder: "skills/review",
      follow,
    });
  });

  it("shows a partial failure and import-again retries only the target account", async () => {
    const app = await opened({
      accounts: [
        { label: "Personal" },
        { label: "Work" },
        {
          label: "Owned",
          directory: { kind: "owned", path: "/home/milo/owned" },
        },
      ],
      setup: {
        "carry-over": {
          state: "needs-attention",
          reason: "Work failed to import",
          actions: ["import-again"],
          targets: [
            {
              action: "import-again",
              kind: "account",
              id: "account-2",
              label: "Work",
            },
          ],
        },
      },
    });
    const desk = app.environment("desk");
    const failed = report("account-2");
    failed.sessions.imported = 4;
    failed.failed = [
      {
        providerSessionId: "failed-session",
        message: "The workspace could not be read.",
      },
    ];
    desk.wire.answer("carryOver.run", () => ({
      result: {
        receipt: { status: "accepted", sequence: 4, changed: true },
        result: failed,
      },
    }));
    expect(screen.queryByRole("region", { name: "Owned" })).toBeNull();
    await app.user.click(await account("Work").findByRole("button", { name: "Import" }));
    expect(await account("Work").findByText("failed-session: The workspace could not be read.")).toBeDefined();
    await app.user.click(screen.getByRole("button", { name: "Import again: Work" }));
    await waitFor(() => expect(desk.requests("carryOver.run")).toHaveLength(2));
    expect(desk.requests("carryOver.run").map((request) => request.params["accountId"])).toEqual(["account-2", "account-2"]);
    expect(screen.getByRole("region", { name: "Set up" })).toBeDefined();
  });

  it("keeps the inventory read-only without admin and says the capability's line once", async () => {
    const listed = inventory();
    listed.memory.unmappable = [{ folder: "lost", path: "/home/milo/.claude/projects/lost/memory" }];
    listed.skills.offered = [
      {
        name: "review",
        from: "/home/milo/.agents/skills/review",
        url: "https://git.home.test/milo/skills.git",
        folder: "skills/review",
        follow: { kind: "branch", branch: "main" },
      },
    ];
    const app = await opened(
      {
        scopes: ["read", "sessions:write", "runs:drive", "terminal"],
        setup: {
          "carry-over": {
            actions: ["import-again"],
            targets: [
              {
                action: "import-again",
                kind: "account",
                id: "account-1",
                label: "Personal",
              },
            ],
          },
        },
      },
      listed,
    );
    await waitFor(() => expect(within(account().getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("5"));
    const capability = app.runtime.capability(app.environment("desk").environmentId, "carryOver.run");
    expect(capability.status).toBe("absent");
    if (capability.status === "absent") expect(screen.getAllByText(`Read-only: ${capability.message}`)).toHaveLength(1);
    for (const control of [
      account().getByRole("checkbox"),
      account().getByRole("combobox", { name: "Repository for lost" }),
      account().getByRole("button", { name: "Assign memory: lost" }),
      account().getByRole("button", { name: "Track as a source" }),
      account().getByRole("button", { name: "Import" }),
      account().getByRole("button", { name: "Import again: Personal" }),
    ])
      expect(control.hasAttribute("disabled")).toBe(true);
    await app.user.click(account().getByRole("button", { name: "Import" }));
    expect(app.environment("desk").requests("carryOver.run")).toHaveLength(0);
  });

  it("ends with ADR 0021's does-not-carry text and names the harness copy as the one to edit", async () => {
    await opened();
    expect(
      screen.getByText(
        "Not carried from your Claude Code directory: hooks, personal MCP servers, permission rules and the approvals you gave the CLI, your settings (model, theme, status line, key bindings), plugins and marketplaces, subagents, prompt history and trust decisions. Your terminal claude keeps using all of them. Repository instructions and hooks load in the harness once you trust the repository; MCP servers and permissions are set per environment in Set up.",
      ),
    ).toBeDefined();
    expect(screen.getByText("The harness copy of the skills is now the one to edit.")).toBeDefined();
  });

  it("refreshes counts when another client imports and says nothing is new when all sessions are held", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    await waitFor(() => expect(within(account().getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("5"));
    const next = inventory();
    next.sessions = { total: 7, archived: 3, missingDirectory: 2, new: 2 };
    desk.wire.answer("carryOver.inventory", () => ({ result: next }));
    await act(async () => desk.notice("carry-over.imported", report()));
    await waitFor(() => expect(within(account().getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("7"));
    expect(within(account().getByLabelText("Sessions")).getByText("Archived").nextElementSibling?.textContent).toBe("3");
    expect(within(account().getByLabelText("Sessions")).getByText("Missing directory").nextElementSibling?.textContent).toBe("2");
    expect(account().getByRole("button", { name: "Import 2 new sessions" })).toBeDefined();
    next.sessions = { ...next.sessions, new: 0 };
    await act(async () => desk.notice("carry-over.imported", report()));
    expect(await account().findByText("No new sessions.")).toBeDefined();
    expect(account().queryByRole("button", { name: /Import \d+ new sessions/ })).toBeNull();
    expect(desk.requests("carryOver.run")).toHaveLength(0);
  });

  it("says a command refusal in one line and lets the account try again", async () => {
    const app = await opened();
    const desk = app.environment("desk");
    desk.wire.answer("carryOver.run", () => ({
      result: {
        receipt: {
          status: "rejected",
          sequence: 5,
          changed: false,
          reason: "conflict",
          error: {
            code: "conflict",
            message: "An import is already running for this account.",
            data: { reason: "import_in_progress" },
          },
        },
      },
    }));
    await app.user.click(await account().findByRole("button", { name: "Import" }));
    expect(await account().findByText("Not imported: An import is already running for this account.")).toBeDefined();
    expect(account().getByRole("button", { name: "Import" }).hasAttribute("disabled")).toBe(false);
    expect(account().queryByRole("region", { name: "Import result" })).toBeNull();
  });

  it("shows the memory and skills result counts and names invalid originals", async () => {
    const app = await opened();
    const imported = report();
    imported.skills = {
      accountId: "account-1",
      dryRun: false,
      copied: [
        {
          kind: "skill",
          name: "review",
          from: "/home/milo/.claude/skills/review",
          path: "skills/review",
        },
      ],
      kept: [],
      offered: [],
      invalid: [
        {
          kind: "skill",
          name: "broken",
          from: "/home/milo/.claude/skills/broken",
          problems: [{ kind: "description", message: "A description is required." }],
        },
      ],
      notCarried: [],
    };
    imported.memory = {
      folders: [
        {
          folder: "project",
          path: "/home/milo/.claude/projects/project/memory",
          key: "https://git.home.test/milo/project",
          outcome: "copied",
          under: null,
          digest: `sha256:${"0".repeat(64)}`,
        },
      ],
      unmappable: [{ folder: "lost", path: "/home/milo/.claude/projects/lost/memory" }],
    };
    app.environment("desk").wire.answer("carryOver.run", () => ({
      result: {
        receipt: { status: "accepted", sequence: 6, changed: true },
        result: imported,
      },
    }));
    await app.user.click(await account().findByRole("button", { name: "Import" }));
    expect(within(await account().findByLabelText("Imported memory")).getByText("Copied").nextElementSibling?.textContent).toBe("1");
    expect(within(account().getByLabelText("Imported memory")).getByText("Unmappable").nextElementSibling?.textContent).toBe("1");
    expect(within(account().getByLabelText("Imported skills and commands")).getByText("Copied").nextElementSibling?.textContent).toBe("1");
    expect(within(account().getByLabelText("Imported skills and commands")).getByText("Invalid").nextElementSibling?.textContent).toBe("1");
    expect(account().getByText("/home/milo/.claude/skills/broken: A description is required.")).toBeDefined();
  });

  it.each([
    { skills: 0, commands: 0, tick: false },
    { skills: 0, commands: 1, tick: true },
  ])("defaults the tick to $tick with $skills skills and $commands commands", async ({ skills, commands, tick }) => {
    const listed = inventory();
    listed.skills = { ...listed.skills, skills, commands };
    await opened({}, listed);
    expect(
      await account().findByRole("checkbox", {
        name: "Copy skills and commands",
      }),
    ).toHaveProperty("checked", tick);
  });
  it("reads the directory again when Carry over is reopened for a re-run", async () => {
    const app = await opened();
    await waitFor(() => expect(within(account().getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("5"));
    const rail = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(rail.getByRole("button", { name: "Appearance" }));
    const next = inventory();
    next.sessions.new = 2;
    app.environment("desk").wire.answer("carryOver.inventory", () => ({ result: next }));
    await app.user.click(rail.getByRole("button", { name: "Carry over" }));
    expect(await account().findByRole("button", { name: "Import 2 new sessions" })).toBeDefined();
  });

  it("defaults to copying skills found by the on-open refresh of a warmed empty inventory", async () => {
    const empty = inventory();
    empty.skills = { ...empty.skills, skills: 0, commands: 0 };
    const app = await opened({}, empty);
    await waitFor(() => expect(within(account().getByLabelText("Skills and commands")).getByText("Skills").nextElementSibling?.textContent).toBe("0"));
    const rail = within(screen.getByRole("navigation", { name: "Set up steps" }));
    await app.user.click(rail.getByRole("button", { name: "Appearance" }));
    const answers: ((answer: { result: CarryOverInventory }) => void)[] = [];
    app.environment("desk").wire.answer("carryOver.inventory", () => new Promise<{ result: CarryOverInventory }>((resolve) => answers.push(resolve)));
    await app.user.click(rail.getByRole("button", { name: "Carry over" }));
    await waitFor(() => expect(answers).toHaveLength(1));
    expect(await account().findByRole("checkbox", { name: "Copy skills and commands" })).toHaveProperty("checked", false);
    await act(async () => answers[0]?.({ result: inventory() }));
    await waitFor(() => expect(within(account().getByLabelText("Skills and commands")).getByText("Skills").nextElementSibling?.textContent).toBe("3"));
    expect(account().getByRole("checkbox", { name: "Copy skills and commands" })).toHaveProperty("checked", true);
    await app.user.click(account().getByRole("button", { name: "Import" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ skills: true });
  });

  it("keeps an explicit skills choice when an inventory refresh still finds no skills", async () => {
    const empty = inventory();
    empty.skills = { ...empty.skills, skills: 0, commands: 0 };
    const app = await opened({}, empty);
    await app.user.click(await account().findByRole("checkbox", { name: "Copy skills and commands" }));
    const next = { ...empty, sessions: { ...empty.sessions, total: 6 } };
    app.environment("desk").wire.answer("carryOver.inventory", () => ({ result: next }));
    await act(async () => app.environment("desk").notice("carry-over.imported", report()));
    await waitFor(() => expect(within(account().getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("6"));
    expect(account().getByRole("checkbox", { name: "Copy skills and commands" })).toHaveProperty("checked", true);
    await app.user.click(account().getByRole("button", { name: "Import 5 new sessions" }));
    await waitFor(() => expect(app.environment("desk").requests("carryOver.run")).toHaveLength(1));
    expect(app.environment("desk").requests("carryOver.run")[0]?.params).toMatchObject({ skills: true });
  });
});
