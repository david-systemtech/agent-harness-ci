import type { RequestFrame } from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { KEY, renderApp, type RenderedApp, type RenderOptions, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The new-session card and its workspace step (workspace-picker spec, "The
 * picker in the client runtime" and "Renderers"; docs/specs/tui.md,
 * "Starting a session"; #334), through the #143 harness against the
 * scripted environments: the chips `projections.newSession` presets, the
 * environment chip changed, the known directories with their identity and
 * missing mark and a key that hides one, a typed path, browsing, a worktree
 * on a new or an existing branch, scratch, a refusal in one line on the
 * step, the header's badge and workspace, and `-c` by path.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const DESK_ID = "0199aa00-0000-7000-8000-00000000de5c";
const LAPTOP_ID = "0199aa00-0000-7000-8000-0000000014a7";
const FIX = "0199aa00-0000-4000-8000-0000000000f1";
const NOTES = "0199aa00-0000-4000-8000-0000000000f2";
const OLD = "0199aa00-0000-4000-8000-0000000000f3";
const TRAIN = "0199aa00-0000-4000-8000-0000000000a1";
const HARNESS = "https://git.systemtech.dev/david/agent-harness";
const at = (hours: number) => new Date(Date.parse("2026-09-24T00:00:00.000Z") + hours * 3_600_000).toISOString();

const WORK = { id: "account-1", label: "Work", identity: { provider: "claude", email: "milo@work.test", organisation: null } } as const;
const OPUS = { accountId: "account-1", live: true, models: [{ id: "claude-opus-5", family: "opus", tier: 3, efforts: [], label: "Opus 5" }] };

const desk = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "desk",
  reach: "local",
  environmentId: DESK_ID,
  accounts: [WORK],
  models: [OPUS],
  sessions: [
    { id: FIX, title: "Fix the rail", workspace: { kind: "directory", path: "/work/harness" }, repositoryIdentity: HARNESS, lastActivityAt: at(0) },
    { id: NOTES, title: "Notes", workspace: { kind: "directory", path: "/home/milo/notes" }, lastActivityAt: at(-5) },
    { id: OLD, title: "Old one", workspace: { kind: "directory", path: "/srv/old" }, lastActivityAt: at(-10), workspaceMissingSince: at(-2) },
  ],
  ...extra,
});
const laptop = (extra: Partial<ScriptedEnvironment> = {}): ScriptedEnvironment => ({
  name: "laptop",
  reach: "paired",
  environmentId: LAPTOP_ID,
  accounts: [WORK],
  models: [OPUS],
  sessions: [{ id: TRAIN, title: "Train tidy", workspace: { kind: "directory", path: "/home/milo/train" }, repositoryIdentity: HARNESS, lastActivityAt: at(-1) }],
  ...extra,
});

const launch = async (options: { desk?: Partial<ScriptedEnvironment>; laptop?: Partial<ScriptedEnvironment> | null } & Partial<RenderOptions> = {}) => {
  const environments = options.laptop === null ? [desk(options.desk)] : [desk(options.desk), laptop(options.laptop)];
  // Under 100 columns, so a card has the frame's width and its chips' line reads whole; the rail, with the keys, is drawn in its place.
  const app = await renderApp({ size: { columns: 99, rows: 30 }, ...options, script: { environments } });
  apps.push(app);
  await app.waitFor(/ready ·/);
  // Both lists are live: what the card presets reads them.
  await app.waitUntil(() => app.runtime().projections.sessionList.read().environments.every((e) => e.freshness === "live"), "the lists live");
  return app;
};

const flat = (frame: string) => frame.replace(/\s+/g, " ");
/** The frame's lines. */
const linesOf = (app: RenderedApp) => app.frame().split("\n");
/** Whether a row of the card starts with `text`, under the cursor or not. */
const listed = (app: RenderedApp, text: string) => linesOf(app).some((line) => line.replace(/^\s*›?\s*/, "").startsWith(text));
/** The first line under the header holding `text`. */
const rowWith = (app: RenderedApp, text: string) => linesOf(app).slice(1).find((line) => line.includes(text)) ?? "";
const sent = (app: RenderedApp, name: string, method: string): readonly RequestFrame[] => app.environment(name).requests(method);
const params = (frame: RequestFrame | undefined) => (frame?.params ?? {}) as Record<string, unknown>;

/** Gives the rail the keys, unless it has them, then moves its cursor onto the heading `text`. */
const headingTo = async (app: RenderedApp, text: string) => {
  if (!app.frame().includes("The rail has the keys")) await app.press(KEY.tab);
  await app.waitFor("The rail has the keys");
  const on = () => new RegExp(`starts a session on ${text}\\b`).test(flat(app.frame()));
  for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 60 && !on(); i++) await app.press(key);
  expect(on(), `the cursor on the heading ${text}:\n${app.frame()}`).toBe(true);
};

/** Moves the card's cursor onto the row holding `text` (the query's line, which starts `›` too, is never a row). */
const rowTo = async (app: RenderedApp, text: string) => {
  const on = () => linesOf(app).some((line, i) => i > 2 && line.startsWith(" › ") && line.includes(text));
  for (const key of [KEY.down, KEY.up]) for (let i = 0; i < 40 && !on(); i++) await app.press(key);
  expect(on(), `the card's cursor on ${text}:\n${app.frame()}`).toBe(true);
};

/** Types a slash command into the composer and sends it. */
const run = async (app: RenderedApp, typed: string) => {
  await app.type(typed);
  await app.press(KEY.enter);
};

describe("the new-session card", () => {
  it("opens from an environment's heading on that environment, its chips projections.newSession's presets in order: environment, account, model, workspace", async () => {
    const app = await launch();
    await headingTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("New session on laptop: where it works");
    await app.waitFor("environment LA laptop · account Work · model Opus 5 · workspace directory train");
  });

  it("names its model as the provider does, on the chip by its name and in the model step with its id", async () => {
    const app = await launch({ desk: { models: [{ accountId: "account-1", live: true, models: [{ id: "fable", family: "fable", tier: 3, efforts: ["high"], label: "Fable" }] }] } });
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("account Work · model Fable 5.1 · workspace");
    await rowTo(app, "Another model");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: its model");
    await app.waitFor("Fable 5.1 (fable)");
  });

  it("redraws its environment chip when another client renames the environment while it is open (#327)", async () => {
    const app = await launch();
    await headingTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("environment LA laptop · account Work");
    app.environment("laptop").setLook({ name: "train box" });
    await app.waitFor("environment TB train box · account Work");
  });

  it("changes the environment chip, an unusable environment greyed with its reason, and the chips after it follow the new environment's presets", async () => {
    const nas: ScriptedEnvironment = {
      name: "nas",
      reach: "paired",
      accounts: [{ id: "account-1", label: "Home", identity: { provider: "claude", email: "milo@home.test", organisation: null } }],
      models: [{ accountId: "account-1", live: true, models: [{ id: "claude-sonnet-5", family: "sonnet", tier: 2, efforts: [], label: "Sonnet 5" }] }],
      sessions: [{ title: "Photos", workspace: { kind: "directory", path: "/tank/photos" }, lastActivityAt: at(-3) }],
    };
    const app = await renderApp({ size: { columns: 99, rows: 30 }, script: { environments: [desk(), laptop(), nas] } });
    apps.push(app);
    await app.waitUntil(() => app.runtime().projections.sessionList.read().environments.filter((e) => e.freshness === "live").length === 3, "the lists live");
    app.environment("laptop").discovery("nothing");
    app.environment("laptop").server.drop();
    await app.waitUntil(() => app.runtime().projections.environments.read()[1]?.phase !== "ready", "laptop down");
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("environment DE desk · account Work · model Opus 5 · workspace directory harness");

    await rowTo(app, "Another environment");
    await app.press(KEY.enter);
    await app.waitFor("New session: where it runs");
    expect(rowWith(app, "DE desk")).toContain("the card's now");
    await app.waitFor("LA laptop (laptop cannot be reached.)");
    await rowTo(app, "laptop");
    await app.press(KEY.enter);
    await app.waitFor("laptop cannot be reached.");
    expect(app.frame()).toContain("New session: where it runs");

    await rowTo(app, "nas");
    await app.press(KEY.enter);
    await app.waitFor("New session on nas: where it works");
    await app.waitFor("environment NA nas · account Home · model Sonnet 5 · workspace directory photos");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "nas", "sessions.create").length === 1, "the create sent to nas");
    expect(params(sent(app, "nas", "sessions.create")[0])).toMatchObject({ workspace: { kind: "directory", path: "/tank/photos" }, account: "account-1", model: "claude-sonnet-5" });
    expect(sent(app, "desk", "sessions.create")).toEqual([]);
  });
});

describe("the workspace step", () => {
  it("lists the known directories with their identity and missing mark, then Browse, a worktree and scratch, offering a gone one not at all", async () => {
    const app = await launch();
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: where it works");
    const rows = linesOf(app).slice(4, 11).map((line) => line.trim());
    expect(rows).toEqual([
      "› /work/harness git.systemtech.dev/david/agent-harness",
      "/home/milo/notes",
      expect.stringMatching(/^\/srv\/old \(gone since \w{3} \d+ \w{3} \d\d:\d\d\)$/),
      "Browse desk's directories",
      "A worktree of a repository, on a new branch or one it has",
      "Scratch a directory of the session's own",
      "Another environment on desk now",
    ]);
    await rowTo(app, "/srv/old");
    await app.press(KEY.enter);
    await app.waitFor(/\/srv\/old: gone since \w{3} \d+ \w{3} \d\d:\d\d\./);
    expect(sent(app, "desk", "sessions.create")).toEqual([]);
  });

  it("hides the known directory under the cursor on Ctrl+D, on this terminal only, until a session works there again", async () => {
    const app = await launch();
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("/home/milo/notes");
    await rowTo(app, "/home/milo/notes");
    await app.press(KEY.ctrlD);
    await app.waitFor("Hid /home/milo/notes from desk's list on this terminal; it comes back when a session works there again.");
    await app.waitUntil(() => !listed(app, "/home/milo/notes"), "the directory hidden");
    expect(app.runtime().preferences.read().hiddenDirectories[DESK_ID]).toHaveProperty("/home/milo/notes");
    await rowTo(app, "Scratch");
    await app.press(KEY.ctrlD);
    await app.waitFor("Only a directory the environment's sessions use can be hidden from this list.");

    // Another client works there: the directory is back.
    app.environment("desk").list.change(NOTES, { lastActivityAt: at(1) });
    await app.waitUntil(() => listed(app, "/home/milo/notes"), "the directory back");
  });

  it("sends scratch as one row's scratch request, and a typed path as typed, each under the id minted as the card opened, the new row taking the rail's cursor", async () => {
    const app = await launch();
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: where it works");
    await rowTo(app, "Scratch");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toEqual({
      commandId: expect.any(String),
      id: "0199ab00-0000-4000-8000-000000000001",
      workspace: { kind: "scratch" },
      account: "account-1",
      model: "claude-opus-5",
    });
    await app.waitFor("› DE · New session");
    expect(app.frame()).toContain("The rail has the keys");

    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("New session on desk: where it works");
    await app.type("~/code/new");
    await app.waitFor("~/code/new typed");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 2, "the second create sent");
    expect(params(sent(app, "desk", "sessions.create")[1])).toMatchObject({ id: "0199ab00-0000-4000-8000-000000000002", workspace: { kind: "directory", path: "~/code/new" } });
    await app.waitUntil(() => app.environment("desk").list.summaries().some((summary) => summary.workspace.path === "/home/milo/code/new"), "the session made");
  });
});

describe("browsing", () => {
  const folders = {
    "/home/milo/code": { truncated: true },
    "/home/milo/code/harness": { repository: { identity: HARNESS } },
    "/home/milo/code/tools": {},
    "/home/milo/.config": {},
  };

  it("lists workspaces.browse on the card's environment from its home: repository roots marked, dot-directories on a toggle, truncated said, a way up; choosing one sends a directory request", async () => {
    const app = await launch({ desk: { folders } });
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await rowTo(app, "Browse desk's directories");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk: /home/milo");
    await app.waitFor("Show the dot-directories");
    expect(linesOf(app).slice(4, 8).map((line) => line.trim())).toEqual(["› Work in /home/milo", ".. up to /home", "code/", "Show the dot-directories"]);
    expect(sent(app, "desk", "workspaces.browse").map(params)).toEqual([{}]);

    await rowTo(app, "Show the dot-directories");
    await app.press(KEY.enter);
    await app.waitFor(".config/");
    expect(params(sent(app, "desk", "workspaces.browse")[1])).toEqual({ path: "/home/milo", hidden: true });
    await rowTo(app, "code/");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk: /home/milo/code");
    await app.waitFor("harness/ repository");
    expect(listed(app, "tools/")).toBe(true);
    await app.waitFor("Only the first 1,000 directories are listed");
    await rowTo(app, "harness/");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk: /home/milo/code/harness");
    await rowTo(app, "Work in /home/milo/code/harness");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "directory", path: "/home/milo/code/harness" } });
    await app.waitUntil(() => !app.frame().includes("Browse desk"), "the browse step closed");
  });

  it("browses from a path typed on the step, and says so when the environment has no such directory", async () => {
    const app = await launch({ desk: { folders } });
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.type("~/code");
    await rowTo(app, "Browse from ~/code");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk: /home/milo/code");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("New session on desk: where it works");
    await app.type("/nowhere");
    await rowTo(app, "Browse from /nowhere");
    await app.press(KEY.enter);
    await app.waitFor("/nowhere is not a directory on desk.");
  });
});

describe("a worktree", () => {
  const REVIEW = "0199aa00-0000-4000-8000-0000000000f4";
  const REVIEW_TREE = "/data/worktrees/harness-0a1b2c3d/review";
  const repository = {
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
  };
  const withReview = (extra: Partial<ScriptedEnvironment> = {}): Partial<ScriptedEnvironment> => ({
    folders: repository,
    sessions: [
      ...(desk().sessions ?? []),
      { id: REVIEW, title: "Review it", workspace: { kind: "worktree" as const, path: REVIEW_TREE, repository: "/work/harness", branch: "review" }, repositoryIdentity: HARNESS, lastActivityAt: at(-2) },
    ],
    ...extra,
  });

  /** The branch step for /work/harness, from the card on desk. */
  const branches = async (app: RenderedApp) => {
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await rowTo(app, "A worktree");
    await app.press(KEY.enter);
    await app.waitFor("A worktree on desk: its repository");
    await rowTo(app, "/work/harness");
    await app.press(KEY.enter);
    await app.waitFor("A worktree of harness on desk: its branch");
  };

  it("asks for a repository, then offers a new branch with its presets, name and base, and the branches workspaces.inspect lists, one another worktree holds shown with it and its session", async () => {
    const app = await launch({ desk: withReview() });
    await branches(app);
    await app.waitFor("fix/rail");
    expect(params(sent(app, "desk", "workspaces.inspect")[0])).toEqual({ path: "/work/harness" });
    expect(linesOf(app).slice(4, 8).map((line) => line.trim())).toEqual([
      "› New branch agent-harness/0199ab00 from main",
      "main (checked out in /work/harness)",
      expect.stringMatching(/^fix\/rail committed \w{3} \d+ \w{3} \d\d:\d\d$/),
      `review (checked out in ${REVIEW_TREE} by “Review it”)`,
    ]);
    expect(app.frame()).toContain("workspace worktree harness");

    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ id: "0199ab00-0000-4000-8000-000000000001", workspace: { kind: "worktree", repository: "/work/harness", newBranch: {} } });
    await app.waitUntil(
      () => app.environment("desk").list.summaries().some((summary) => summary.workspace.kind === "worktree" && summary.workspace.branch === "agent-harness/0199ab00"),
      "the worktree made on the preset branch",
    );
  });

  it("takes a repository browsed to", async () => {
    const app = await launch({ desk: withReview({ folders: { ...repository, "/home/milo/code/tools": { repository: { identity: null, branch: "trunk" } } } }) });
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await rowTo(app, "A worktree");
    await app.press(KEY.enter);
    await rowTo(app, "Browse desk's directories");
    await app.press(KEY.enter);
    await app.waitFor("Make the worktree from /home/milo");
    await rowTo(app, "code/");
    await app.press(KEY.enter);
    await rowTo(app, "tools/");
    await app.press(KEY.enter);
    await rowTo(app, "Make the worktree from /home/milo/code/tools");
    await app.press(KEY.enter);
    await app.waitFor("A worktree of tools on desk: its branch");
    await app.waitFor("New branch agent-harness/0199ab00 from trunk");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "worktree", repository: "/home/milo/code/tools", newBranch: {} } });
  });

  it("makes a worktree on an existing branch, or on a new branch named as typed", async () => {
    const app = await launch({ desk: withReview() });
    await branches(app);
    await rowTo(app, "fix/rail");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "worktree", repository: "/work/harness", branch: "fix/rail" } });

    await branches(app);
    await app.type("try/it");
    await app.waitFor("New branch try/it from main");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 2, "the second create sent");
    expect(params(sent(app, "desk", "sessions.create")[1])).toMatchObject({ workspace: { kind: "worktree", repository: "/work/harness", newBranch: { name: "try/it" } } });
  });

  it("names a branch reason in one line on the step, which stays open for another branch", async () => {
    const app = await launch({ desk: withReview() });
    await branches(app);
    await app.waitFor("fix/rail committed");
    // Another session takes fix/rail after the branches were read.
    const taken = await app.runtime().commands.startSession(DESK_ID, { workspace: { kind: "worktree", repository: "/work/harness", branch: "fix/rail" } });
    expect(taken.answer.ok).toBe(true);
    await rowTo(app, "fix/rail");
    await app.press(KEY.enter);
    const line = "fix/rail is checked out in /data/worktrees/harness-0a1b2c3d/fix-rail by “New session”.";
    await app.waitFor(line);
    expect(linesOf(app).filter((row) => row.includes(line))).toHaveLength(1);
    expect(app.frame()).toContain("A worktree of harness on desk: its branch");
  });

  it("says why without terminal on the connection: Browse and the branch list give the capability's line, and a typed path and a typed branch still work", async () => {
    const scopes = ["read", "sessions:write", "runs:drive", "admin"] as const;
    const app = await launch({ desk: withReview({ scopes }) });
    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk's directories (This client was paired with desk without the terminal scope.)");
    await rowTo(app, "A worktree");
    await app.press(KEY.enter);
    await app.waitFor("Browse desk's directories (This client was paired with desk without the terminal scope.)");
    await app.type("/work/harness");
    await app.press(KEY.enter);
    await app.waitFor("A worktree of harness on desk: its branch");
    await app.waitFor("This client was paired with desk without the terminal scope.");
    expect(sent(app, "desk", "workspaces.inspect")).toEqual([]);
    await app.type("fix/rail");
    await rowTo(app, "Branch fix/rail");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "worktree", repository: "/work/harness", branch: "fix/rail" } });

    await headingTo(app, "desk");
    await app.press(KEY.enter);
    await app.type("/srv/typed");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 2, "the typed path sent");
    expect(params(sent(app, "desk", "sessions.create")[1])).toMatchObject({ workspace: { kind: "directory", path: "/srv/typed" } });
  });
});

describe("from the composer", () => {
  it("opens the card on /new with no session open, the terminal's own directory preset on the local environment, and opens the session once the environment has it", async () => {
    const app = await launch({ flags: { workspace: "/home/milo/code/harness" } });
    await run(app, "/new");
    await app.waitFor("New session on desk: where it works");
    await app.waitFor("workspace directory harness");
    expect(rowWith(app, "/home/milo/code/harness")).toMatch(/^ › \/home\/milo\/code\/harness this directory/);
    await app.press(KEY.enter);
    await app.waitFor("Nothing said yet.");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "directory", path: "/home/milo/code/harness" }, account: "account-1", model: "claude-opus-5" });
    await app.waitFor("agent-harness · DE desk ready · New session · directory harness");
  });

  it("keeps the cursor on the preset's row when a directory another client starts a session in arrives while the card is up", async () => {
    const app = await launch({ flags: { workspace: "/home/milo/code/harness" } });
    await run(app, "/new");
    await app.waitFor("/home/milo/code/harness this directory");
    // Another client works in a new directory: it is the most recently used, listed ahead of the rest.
    const other = await app.runtime().commands.startSession(DESK_ID, { workspace: { kind: "directory", path: "/srv/elsewhere" } });
    expect(other.answer.ok).toBe(true);
    await app.waitFor("/srv/elsewhere");
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 2, "the card's create sent");
    expect(params(sent(app, "desk", "sessions.create")[1])).toMatchObject({ workspace: { kind: "directory", path: "/home/milo/code/harness" } });
  });

  it("opens the card on /cwd on the environment --environment names, its presets there", async () => {
    const app = await launch({ flags: { workspace: "/home/milo/code/harness", environment: "laptop" } });
    await run(app, "/cwd");
    await app.waitFor("New session on laptop: where it works");
    await app.waitFor("environment LA laptop · account Work · model Opus 5 · workspace directory train");
  });

  it("opens the card on /cwd with a session open on its environment, the open session's workspace preset as a row of its own", async () => {
    const app = await launch({ flags: { session: FIX, workspace: "/home/milo/code/harness" } });
    await app.waitFor("Nothing said yet.");
    await run(app, "/cwd");
    await app.waitFor("New session on desk: where it works");
    expect(rowWith(app, "Where “Fix the rail” works")).toMatch(/^ › Where “Fix the rail” works \/work\/harness/);
    await app.press(KEY.enter);
    await app.waitUntil(() => sent(app, "desk", "sessions.create").length === 1, "the create sent");
    expect(params(sent(app, "desk", "sessions.create")[0])).toMatchObject({ workspace: { kind: "session", sessionId: FIX } });
  });
});

describe("the header", () => {
  it("shows the open session's environment badge and its workspace, kind, directory name and a worktree's branch, read-only", async () => {
    const tree = { kind: "worktree", path: "/data/worktrees/harness-0a1b2c3d/review", repository: "/work/harness", branch: "review" } as const;
    const app = await launch({ desk: { sessions: [...(desk().sessions ?? []), { id: "0199aa00-0000-4000-8000-0000000000f4", title: "Review it", workspace: tree }] }, flags: { session: "0199aa00-0000-4000-8000-0000000000f4" } });
    await app.waitFor("agent-harness · DE desk ready · Review it · worktree harness on review");
  });
});

describe("-c", () => {
  it("opens the newest session on the local environment whose workspace path is the current directory, whatever its kind", async () => {
    const tree = "/data/worktrees/harness-0a1b2c3d/review";
    const sessions = [
      { title: "Older tree", workspace: { kind: "worktree", path: tree, repository: "/work/harness", branch: "review" }, lastActivityAt: at(-3) },
      { title: "Newer tree", workspace: { kind: "worktree", path: tree, repository: "/work/harness", branch: "review" }, lastActivityAt: at(-1) },
      { title: "Scratch one", workspace: { kind: "scratch", path: "/data/scratch/0199aa00-0000-4000-8000-000000000003" }, lastActivityAt: at(0) },
    ] as const;
    const worktree = await launch({ desk: { sessions }, laptop: null, flags: { continueLatest: true }, cwd: tree });
    await worktree.waitFor("Newer tree · worktree harness on review");
    const scratch = await launch({ desk: { sessions }, laptop: null, flags: { continueLatest: true }, cwd: "/data/scratch/0199aa00-0000-4000-8000-000000000003" });
    await scratch.waitFor("Scratch one · scratch");
  });
});
