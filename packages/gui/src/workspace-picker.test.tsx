import { act, screen, waitFor, within } from "@testing-library/react";
import { fakeShell } from "@agent-harness/client-runtime/testing";
import { describe, expect, it } from "vitest";
import type { RenderedApp, ScriptedEnvironment } from "../test/harness.js";
import { renderApp } from "../test/harness.js";
import { inUtc, region, row, sidebar } from "../test/sidebar-fixtures.js";

/**
 * Workspaces in the window (workspace-picker spec, "Browsing an
 * environment's directories", "Missing workspaces" and "Renderers";
 * docs/specs/gui.md, "A session pane"; ADR 0021; #421), through the harness
 * over two scripted environments that browse and inspect the directories
 * their script names: the workspace chip's picker browsing an environment
 * (repository roots marked, dot-directories on a toggle, truncation said, a
 * way up), the local environment's directory dialog, a worktree on a new
 * branch and on a branch another worktree holds, the capability's line
 * without `terminal`, and the resolver's refusals on the picker, which stays
 * open; a session whose workspace is missing, its composer replaced by the
 * gone path and Choose a workspace; and the caption's workspace chip.
 */

inUtc();

const DESK_ID = "0199aa00-0000-7000-8000-00000000de5c";
const LAPTOP_ID = "0199aa00-0000-7000-8000-0000000014a7";
const REVIEW = "0199aa00-0000-4000-8000-0000000000f4";
const REVIEW_TREE = "/data/worktrees/harness-0a1b2c3d/review";
const HARNESS = "https://git.systemtech.dev/david/agent-harness";
const at = (hours: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + hours * 3_600_000).toISOString();

const WORK = { id: "account-1", label: "Work", identity: { provider: "claude", email: "seth@work.test", organisation: null } } as const;
const OPUS = { accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] };

/** What desk's directories hold: its sessions' directories, a repository with a branch another worktree holds, and more to browse. */
const FOLDERS: ScriptedEnvironment["folders"] = {
  "/work/harness": {
    repository: {
      identity: HARNESS,
      branch: "main",
      branches: [
        { name: "fix/rail", committedAt: at(-1) },
        { name: "review", committedAt: at(-2), worktree: REVIEW_TREE, sessionId: REVIEW },
      ],
    },
  },
  "/home/seth/notes": {},
  "/home/seth/code": { truncated: true },
  "/home/seth/code/tools": { repository: { identity: null, branch: "trunk" } },
  "/home/seth/code/site": {},
  "/home/seth/.config": {},
  "/home/seth/locked": { unreadable: true },
};

const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  accounts: [WORK],
  models: [OPUS],
  folders: FOLDERS,
  sessions: [
    { title: "Fix the rail", workspace: { kind: "directory", path: "/work/harness" }, repositoryIdentity: HARNESS, lastActivityAt: at(0) },
    { title: "Notes", workspace: { kind: "directory", path: "/home/seth/notes" }, lastActivityAt: at(-5) },
    {
      id: REVIEW,
      title: "Review it",
      workspace: { kind: "worktree", path: REVIEW_TREE, repository: "/work/harness", branch: "review" },
      repositoryIdentity: HARNESS,
      lastActivityAt: at(-2),
    },
    { title: "Old one", workspace: { kind: "directory", path: "/srv/old" }, lastActivityAt: at(-10), workspaceMissingSince: at(-3) },
    { title: "Sketch", workspace: { kind: "scratch", path: "/data/scratch/0199aa00-0000-4000-8000-0000000000f9" }, lastActivityAt: at(-12) },
  ],
  ...extra,
});

const laptop = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  accounts: [WORK],
  models: [OPUS],
  sessions: [{ title: "Train tidy", workspace: { kind: "directory", path: "/home/seth/train" }, lastActivityAt: at(-1) }],
  ...extra,
});

/** Both environments, every list drawn. */
const launch = async (options: { readonly desk?: Partial<ScriptedEnvironment>; readonly laptop?: Partial<ScriptedEnvironment>; readonly shell?: ReturnType<typeof fakeShell> } = {}) => {
  const app = await renderApp({ environments: [desk(options.desk), laptop(options.laptop)] }, options.shell === undefined ? {} : { shell: options.shell });
  await within(sidebar()).findByRole("button", { name: /Train tidy/ });
  await within(sidebar()).findByRole("button", { name: /Fix the rail/ });
  return app;
};

const panes = () => within(screen.getByRole("main")).getAllByRole("region", { name: "Session pane" });
const pane = () => panes()[0] as HTMLElement;
const surface = () => within(pane()).getByRole("region", { name: "New session" });

/** Every request an environment was sent of `method`, its params in order. */
const params = (app: RenderedApp, name: string, method: string) => app.environment(name).requests(method).map((request) => request.params);

/** The workspace chip's value, as its name reads. */
const workspaceChip = () => within(within(surface()).getByRole("group", { name: "Where it starts" })).getByRole("button", { name: /^Workspace: / });

/** Opens a new-session surface on `environment` from its heading, and its workspace chip's picker, once its preset has settled. */
const openPicker = async (app: RenderedApp, environment = "desk") => {
  await app.user.click(within(region(environment)).getByRole("button", { name: `New session on ${environment}` }));
  await waitFor(() => expect(workspaceChip().getAttribute("aria-label")).not.toBe("Workspace: none"));
  act(() => workspaceChip().focus());
  await app.user.keyboard("{Enter}");
  return picker();
};

/** The open picker. */
const picker = () => screen.getByRole("dialog", { name: /^Where it works on / });
/** The picker's one line. */
const pickerLine = () => within(picker()).queryByRole("status")?.textContent;

describe("the caption's workspace chip", () => {
  it("shows the kind, the directory's name and a worktree's branch, with the path on hover", async () => {
    const app = await launch();
    const chip = () => within(pane()).getByRole("note", { name: /^Workspace/ });

    await app.user.click(row("Fix the rail"));
    await waitFor(() => expect(chip().textContent).toBe("directory harness"));
    expect(chip().getAttribute("title")).toBe("/work/harness");

    await app.user.click(row("Review it"));
    await waitFor(() => expect(chip().textContent).toBe("worktree harness on review"));
    expect(chip().getAttribute("title")).toBe(REVIEW_TREE);

    await app.user.click(row("Sketch"));
    await waitFor(() => expect(chip().textContent).toBe("scratch"));
    expect(chip().getAttribute("title")).toBe("/data/scratch/0199aa00-0000-4000-8000-0000000000f9");
  });
});

describe("browsing", () => {
  /** The directories the browse view lists, each as it reads. */
  const listed = () =>
    within(within(picker()).getByRole("list", { name: /^Directories in / }))
      .getAllByRole("button")
      .map((entry) => entry.textContent);
  const heading = () => within(picker()).getByRole("heading").textContent;

  it("lists workspaces.browse on the chosen environment: repository roots marked, dot-directories on a toggle, truncation said, a way up; choosing one sends a directory request", async () => {
    const app = await launch();
    await openPicker(app);
    await app.user.click(within(picker()).getByRole("button", { name: "Browse desk…" }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth"));
    expect(listed()).toEqual([".. up to /home", "code/", "locked/", "notes/"]);
    expect(params(app, "desk", "workspaces.browse")).toEqual([{}]);

    await app.user.click(within(picker()).getByRole("switch", { name: "Dot-directories" }));
    await waitFor(() => expect(listed()).toEqual([".. up to /home", ".config/", "code/", "locked/", "notes/"]));
    expect(params(app, "desk", "workspaces.browse")[1]).toEqual({ path: "/home/seth", hidden: true });

    await app.user.click(within(picker()).getByRole("button", { name: "locked/" }));
    await waitFor(() => expect(pickerLine()).toBe("desk cannot list /home/seth/locked."));
    await app.user.click(within(picker()).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth"));

    await app.user.click(within(picker()).getByRole("button", { name: "code/" }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth/code"));
    await waitFor(() => expect(listed()).toEqual([".. up to /home/seth", "site/", "tools/ repository"]));
    expect(pickerLine()).toBe("Only the first 1,000 directories are listed: type a path to reach the rest.");
    await app.user.click(within(picker()).getByRole("button", { name: /^\.\./ }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth"));
    await app.user.click(within(picker()).getByRole("button", { name: "code/" }));
    await app.user.click(await within(picker()).findByRole("button", { name: /^tools\// }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth/code/tools"));

    await app.user.click(within(picker()).getByRole("button", { name: "Work in /home/seth/code/tools" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Where it works on / })).toBeNull());
    expect(workspaceChip().getAttribute("aria-label")).toBe("Workspace: directory tools");
    expect(params(app, "desk", "workspaces.inspect")).toEqual([{ path: "/home/seth/code/tools" }]);

    act(() => within(surface()).getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("Look around{Enter}");
    await waitFor(() => expect(params(app, "desk", "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "directory", path: "/home/seth/code/tools" } })]));
  });

  it("starts from a path typed on the picker", async () => {
    const app = await launch();
    await openPicker(app);
    act(() => within(picker()).getByRole("textbox", { name: "A directory on desk" }).focus());
    await app.user.keyboard("~/code");
    await app.user.click(within(picker()).getByRole("button", { name: "Browse from ~/code…" }));
    await waitFor(() => expect(heading()).toBe("Browse desk: /home/seth/code"));
    expect(params(app, "desk", "workspaces.browse")).toEqual([{ path: "~/code" }]);
  });
});

describe("the local directory dialog", () => {
  it("is offered beside Browse on the local environment, and its path is checked by the environment like any other: a refusal is one line on the picker, which stays open", async () => {
    const shell = fakeShell();
    const picked = ["/home/seth/gone", "/home/seth/code"];
    shell.answer("dialogs.openDirectory", async () => picked.shift());
    const app = await launch({ shell });
    await openPicker(app);
    await app.user.click(within(picker()).getByRole("button", { name: "Pick on this computer…" }));
    await waitFor(() => expect(pickerLine()).toBe("/home/seth/gone does not exist on desk."));
    expect(shell.calls.filter(([member]) => member === "dialogs.openDirectory")).toEqual([["dialogs.openDirectory", { title: "Where the session works on desk" }]]);
    expect(params(app, "desk", "workspaces.inspect")).toEqual([{ path: "/home/seth/gone" }]);
    expect(workspaceChip().getAttribute("aria-label")).toBe("Workspace: directory harness");

    await app.user.click(within(picker()).getByRole("button", { name: "Pick on this computer…" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Where it works on / })).toBeNull());
    expect(workspaceChip().getAttribute("aria-label")).toBe("Workspace: directory code");
    expect(workspaceChip().getAttribute("title")).toBe("/home/seth/code");

    // Another machine's directories are not this computer's: laptop's picker has no dialog.
    await openPicker(app, "laptop");
    expect(within(picker()).getByRole("button", { name: "Browse laptop…" })).toBeDefined();
    expect(within(picker()).queryByRole("button", { name: "Pick on this computer…" })).toBeNull();
  });
});

describe("a worktree", () => {
  /** The branch view's entries, each as it reads, and whether it can be chosen. */
  const branches = () =>
    within(within(picker()).getByRole("list", { name: /^Branches of / }))
      .getAllByRole("button")
      .map((entry) => `${entry.textContent}${entry.hasAttribute("disabled") ? " (not offered)" : ""}`);
  const heading = () => within(picker()).getByRole("heading").textContent;

  /** The branch view for /work/harness, from the picker on desk. */
  const harnessBranches = async (app: RenderedApp) => {
    await openPicker(app);
    await app.user.click(within(picker()).getByRole("button", { name: "A worktree…" }));
    expect(heading()).toBe("A worktree on desk: its repository");
    await app.user.click(within(picker()).getByRole("button", { name: /^\/work\/harness/ }));
    await waitFor(() => expect(heading()).toBe("A worktree of harness on desk: its branch"));
    await waitFor(() => expect(branches().length).toBeGreaterThan(1));
  };

  it("asks for a repository, then offers a new branch with its presets, name and base, and the branches workspaces.inspect lists, one another worktree holds shown with that worktree and its session", async () => {
    const app = await launch();
    await harnessBranches(app);
    expect(params(app, "desk", "workspaces.inspect")).toEqual([{ path: "/work/harness" }]);
    const preset = (branches()[0] ?? "").replace(/ from main$/, "").replace(/^New branch /, "");
    expect(preset).toMatch(/^agent-harness\/[0-9a-f]{8}$/);
    expect(branches()).toEqual([
      `New branch ${preset} from main`,
      "mainchecked out in /work/harness (not offered)",
      "fix/rail committed Wed 23 Sep 23:00",
      `reviewchecked out in ${REVIEW_TREE} by “Review it” (not offered)`,
    ]);

    await app.user.click(within(picker()).getByRole("button", { name: /^New branch agent-harness\// }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Where it works on / })).toBeNull());
    expect(workspaceChip().getAttribute("aria-label")).toBe(`Workspace: worktree harness on ${preset}`);
    expect(workspaceChip().getAttribute("title")).toBe("/work/harness");

    act(() => within(surface()).getByRole("textbox", { name: "Message" }).focus());
    await app.user.keyboard("Tidy the rail{Enter}");
    await waitFor(() => expect(params(app, "desk", "sessions.create")).toEqual([expect.objectContaining({ workspace: { kind: "worktree", repository: "/work/harness", newBranch: {} } })]));
    // The session opens in the pane, its caption naming the worktree made on the preset branch.
    await waitFor(() => expect(within(pane()).getByRole("note", { name: /^Workspace/ }).textContent).toBe(`worktree harness on ${preset}`));
  });

  it("names a branch taken since the branches were read in one line on the picker, which stays open for another branch, and makes a new branch named as typed", async () => {
    const app = await launch();
    await harnessBranches(app);
    // Another session takes fix/rail after the branches were read.
    const taken = await app.runtime.commands.startSession(DESK_ID, { workspace: { kind: "worktree", repository: "/work/harness", branch: "fix/rail" } });
    expect(taken.answer.ok).toBe(true);
    await app.user.click(within(picker()).getByRole("button", { name: /^fix\/rail/ }));
    await waitFor(() => expect(pickerLine()).toBe("fix/rail is checked out in /data/worktrees/harness-0a1b2c3d/fix-rail by “New session”."));
    expect(heading()).toBe("A worktree of harness on desk: its branch");

    act(() => within(picker()).getByRole("textbox", { name: "A new branch's name" }).focus());
    await app.user.keyboard("fix/rail");
    // A name a branch has is that branch, not a new one.
    expect(branches().some((entry) => entry.startsWith("New branch fix/rail"))).toBe(false);
    await app.user.clear(within(picker()).getByRole("textbox", { name: "A new branch's name" }));
    await app.user.keyboard("try/it");
    await app.user.click(within(picker()).getByRole("button", { name: /^New branch try\/it/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Where it works on / })).toBeNull());
    expect(workspaceChip().getAttribute("aria-label")).toBe("Workspace: worktree harness on try/it");
  });

  it("takes a repository browsed to", async () => {
    const app = await launch();
    await openPicker(app);
    await app.user.click(within(picker()).getByRole("button", { name: "A worktree…" }));
    await app.user.click(within(picker()).getByRole("button", { name: "Browse desk…" }));
    await app.user.click(await within(picker()).findByRole("button", { name: "code/" }));
    await app.user.click(await within(picker()).findByRole("button", { name: /^tools\// }));
    await app.user.click(await within(picker()).findByRole("button", { name: "Make the worktree from /home/seth/code/tools" }));
    await waitFor(() => expect(heading()).toBe("A worktree of tools on desk: its branch"));
    await waitFor(() => expect(branches()[0]).toMatch(/^New branch agent-harness\/[0-9a-f]{8} from trunk$/));
    await app.user.click(within(picker()).getByRole("button", { name: /^New branch agent-harness\// }));
    await waitFor(() => expect(workspaceChip().getAttribute("aria-label")).toMatch(/^Workspace: worktree tools on agent-harness\//));
  });
});
