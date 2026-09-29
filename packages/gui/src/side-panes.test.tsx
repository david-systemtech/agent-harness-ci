import { act, screen, waitFor, within } from "@testing-library/react";
import type { DelegatedWorkRow, SessionDiffFile } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { renderApp, type EnvironmentHandle, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * The side column's Files, Diff and Tasks panes (docs/specs/gui.md, "The
 * seven panes and the grid"; #408), each over the methods the environment
 * serves, driven through the harness over the scripted environment's
 * answers: the workspace one directory at a time and a file in the file
 * view; what the session changed and the working tree in the diff view; the
 * session's delegated work with its stop and each agent's transcript.
 */

const FILES = ["README.md", "big.log", "logo.png", "package.json", "src/app.tsx", "src/files/browse.ts", "src/files/pages.ts", "test/harness.ts"];

const APP_TSX = "const answer = 42;\nexport default answer;\n";

/** The local environment with a session opened in the pane. */
const opened = async (more: Partial<ScriptedEnvironment> = {}) => {
  const app = await renderApp({
    environments: [
      {
        name: "desk",
        reach: "local",
        sessions: [{ title: "Receipts" }],
        files: FILES,
        fileContents: {
          "README.md": "# Receipts\n",
          "src/app.tsx": APP_TSX,
          "big.log": { text: "line one\n", truncated: true, size: 3 * 1024 * 1024 },
          "logo.png": { binary: true, size: 40_000 },
        },
        ...more,
      },
    ],
  });
  app.open("desk");
  await within(await screen.findByRole("region", { name: "Transcript" })).findByText("Nothing said yet.");
  const env = app.environment("desk");
  return { app, env, session: env.sessionId() };
};

/** Keys typed into the composer's box, focused first. */
const write = async (app: RenderedApp, keys: string) => {
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  await app.user.keyboard(keys);
};

/** The pane on screen named `name`. */
const pane = (name: string) => screen.getByRole("region", { name });

/** What the environment was sent for `method`, each request's params. */
const sent = (env: EnvironmentHandle, method: string) => env.requests(method).map((request) => request.params);

/** The rows of the Files pane's directory, each as it reads. */
const rows = () =>
  within(pane("Files"))
    .getAllByRole("button")
    .filter((button) => button.closest("ul") !== null)
    .map((button) => button.textContent);

describe("the Files pane", () => {
  it("lists one directory at a time from files.list, its directories first with how many files each holds, with a way up", async () => {
    const { app, env, session } = await opened();
    await write(app, "/files{Enter}");
    await within(pane("Files")).findByRole("heading", { name: "The workspace" });
    await waitFor(() => expect(rows()).toEqual(["src/ 3 files", "test/ 1 file", "README.md", "big.log", "logo.png", "package.json"]));

    await app.user.click(within(pane("Files")).getByRole("button", { name: "src/ 3 files" }));
    expect(within(pane("Files")).getByRole("heading", { name: "src/" })).toBeDefined();
    expect(rows()).toEqual(["../", "files/ 2 files", "app.tsx"]);

    await app.user.click(within(pane("Files")).getByRole("button", { name: "Up to The workspace" }));
    expect(within(pane("Files")).getByRole("heading", { name: "The workspace" })).toBeDefined();
    // Listed once, through the request cache, for the session.
    expect(sent(env, "files.list")).toEqual([{ sessionId: session }]);
  });

  it("opens a file in a highlighted file view through files.read, marked with its size, and goes back to its directory", async () => {
    const { app, env, session } = await opened();
    await write(app, "/files{Enter}");
    await app.user.click(await within(pane("Files")).findByRole("button", { name: "src/ 3 files" }));
    await app.user.click(within(pane("Files")).getByRole("button", { name: "app.tsx" }));

    expect(await within(pane("Files")).findByRole("heading", { name: "src/app.tsx · 42 bytes" })).toBeDefined();
    const code = within(pane("Files")).getByRole("code");
    expect(code.textContent).toBe(APP_TSX);
    // Highlighted: the language's keywords are drawn apart from the rest of the line.
    expect(within(code).getByText("const")).not.toBe(code);
    expect(sent(env, "files.read")).toEqual([{ sessionId: session, path: "src/app.tsx" }]);

    await app.user.click(within(pane("Files")).getByRole("button", { name: "Back to src/" }));
    expect(rows()).toEqual(["../", "files/ 2 files", "app.tsx"]);
  });

  it("says a file past 2 MiB is shown by its first 2 MiB, and says a binary file without drawing it", async () => {
    const { app } = await opened();
    await write(app, "/files big.log{Enter}");
    expect(await within(pane("Files")).findByRole("heading", { name: "big.log · 3.0 MB · the first 2 MiB" })).toBeDefined();
    expect(within(pane("Files")).getByRole("code").textContent).toBe("line one\n");

    await write(app, "/files logo.png{Enter}");
    expect(await within(pane("Files")).findByText("A binary file of 39 KB: not shown as text.")).toBeDefined();
    expect(within(pane("Files")).getByRole("heading", { name: "logo.png · 39 KB · binary" })).toBeDefined();
    expect(within(pane("Files")).queryByRole("code")).toBeNull();
  });

  it("goes where /files <path> names in the workspace, a file or a directory, and refuses a path outside it in the pane's line", async () => {
    const { app } = await opened();
    await write(app, "/files /home/seth/code/README.md{Enter}");
    expect(await within(pane("Files")).findByRole("heading", { name: "README.md · 11 bytes" })).toBeDefined();

    await write(app, "/files src/files{Enter}");
    expect(await within(pane("Files")).findByRole("heading", { name: "src/files/" })).toBeDefined();
    expect(rows()).toEqual(["../", "browse.ts", "pages.ts"]);

    await write(app, "/files /etc/hosts{Enter}");
    expect(await screen.findByText("/etc/hosts is outside the session's workspace, which the environment reads files from.")).toBeDefined();
    expect(within(pane("Files")).getByRole("heading", { name: "src/files/" })).toBeDefined();
  });
});

const EDIT = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const total = 1;\n+const total = 2;\n";
const TREE = "diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -3 +3 @@\n-old line\n+new line\n";

describe("the Diff pane", () => {
  it("lists what the session changed per file with the calls that made each change, then the working tree against HEAD, in the diff view", async () => {
    const changed: { files: SessionDiffFile[] } = { files: [] };
    const { app, env, session } = await opened({ sessionDiff: changed, workingTree: { diff: TREE } });
    const { runId } = env.startRun(session, "Raise the total");
    env.endRun(session, runId);
    changed.files.push({
      path: "src/a.ts",
      diff: EDIT,
      changes: [
        { runId, toolCallId: "t1", tool: "Edit", status: "ok" },
        { runId: "0199a100-0000-4000-8000-00000000abcd", toolCallId: "t2", tool: "MultiEdit", status: "ok" },
      ],
    });
    await within(screen.getByRole("region", { name: "Transcript" })).findByRole("article", { name: "Your message" });

    await write(app, "/diff{Enter}");
    const file = await within(pane("Diff")).findByRole("article", { name: "src/a.ts" });
    expect(within(within(file).getByRole("list", { name: "The calls that made it" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Edit · turn 1",
      "MultiEdit",
    ]);
    expect(within(file).getByText("+const total = 2;")).toBeDefined();
    expect(within(file).getByText("-const total = 1;")).toBeDefined();
    expect(within(pane("Diff")).getByRole("heading", { name: "The working tree against HEAD" })).toBeDefined();
    expect(within(pane("Diff")).getByText("+new line")).toBeDefined();
    expect(sent(env, "diffs.session")).toEqual([{ sessionId: session }]);
    expect(sent(env, "diffs.workingTree")).toEqual([{ sessionId: session }]);
  });

  it("says a diff the environment cut is cut, and why the working tree has none", async () => {
    const { app } = await opened({
      sessionDiff: { files: [{ path: "src/a.ts", diff: EDIT, changes: [] }], truncated: true },
      workingTree: { refused: "git_filters_refused", message: "The repository names the clean filter lfs, which would run outside containment." },
    });
    await write(app, "/diff{Enter}");
    expect(await within(pane("Diff")).findByText("… cut at 8 MiB: the rest is not shown.")).toBeDefined();
    expect(within(pane("Diff")).getByText("Not read: The repository names the clean filter lfs, which would run outside containment.")).toBeDefined();
  });

  it("says when the session changed nothing and the workspace is in no repository", async () => {
    const { app } = await opened({ workingTree: { diff: "", repository: false } });
    await write(app, "/diff{Enter}");
    expect(await within(pane("Diff")).findByText("Nothing yet.")).toBeDefined();
    expect(within(pane("Diff")).getByText("The workspace is in no git repository.")).toBeDefined();
  });

  it("reads both again each time it comes on screen, and on Read again", async () => {
    const { app, env } = await opened();
    await write(app, "/diff{Enter}");
    await within(pane("Diff")).findByText("Nothing yet.");
    await write(app, "/files{Enter}");
    await write(app, "/diff{Enter}");
    await waitFor(() => expect(sent(env, "diffs.session")).toHaveLength(2));
    await app.user.click(within(pane("Diff")).getByRole("button", { name: "Read again" }));
    await waitFor(() => expect(sent(env, "diffs.workingTree")).toHaveLength(3));
  });
});

const task = (taskId: string, status: DelegatedWorkRow["status"], minute: number, more: Partial<DelegatedWorkRow> = {}): DelegatedWorkRow => ({
  taskId,
  kind: "local_agent",
  description: `Look into ${taskId}`,
  status,
  startedAt: `2026-09-29T10:${String(minute).padStart(2, "0")}:00.000Z`,
  endedAt: status === "pending" || status === "running" || status === "paused" ? null : "2026-09-29T10:30:00.000Z",
  subagentType: "Explore",
  toolCallId: `call-${taskId}`,
  error: null,
  ...more,
});

/** A live run on the session whose ledger holds `tasks`, and the Tasks pane open. */
const withTasks = async (more: Partial<ScriptedEnvironment>, ...tasks: DelegatedWorkRow[]) => {
  const opening = await opened(more);
  const { app, env, session } = opening;
  const { runId } = env.startRun(session, "Survey the parser");
  env.emit(session, "tasks.changed", { runId, tasks });
  await write(app, "/tasks{Enter}");
  return { ...opening, runId, ledger: (...next: DelegatedWorkRow[]) => env.emit(session, "tasks.changed", { runId, tasks: next }) };
};

/** The names of the articles in the Tasks pane's list named `list`. */
const listed = (list: string) =>
  within(within(pane("Tasks")).getByRole("list", { name: list }))
    .getAllByRole("article")
    .map((article) => article.getAttribute("aria-label"));

/** The button reading `name` on the task named `task`. */
const onTask = (taskName: string, name: string) => within(within(pane("Tasks")).getByRole("article", { name: taskName })).getByRole("button", { name });

describe("the Tasks pane", () => {
  it("says when the session has delegated no work", async () => {
    const { app } = await opened();
    await write(app, "/tasks{Enter}");
    expect(within(pane("Tasks")).getByText("No delegated work in this session.")).toBeDefined();
  });

  it("lists the session's delegated work, live on top and finished folded, each newest first", async () => {
    const { app } = await withTasks({}, task("a", "completed", 1), task("b", "running", 2), task("c", "pending", 3), task("d", "failed", 4, { error: "It gave up." }));
    await waitFor(() => expect(listed("Live work")).toEqual(["Explore: Look into c", "Explore: Look into b"]));
    expect(within(pane("Tasks")).queryByRole("list", { name: "Finished work" })).toBeNull();

    await app.user.click(within(pane("Tasks")).getByRole("button", { name: "2 finished" }));
    await waitFor(() => expect(listed("Finished work")).toEqual(["Explore: Look into d", "Explore: Look into a"]));
    expect(within(within(pane("Tasks")).getByRole("article", { name: "Explore: Look into d" })).getByText("failed: It gave up.")).toBeDefined();
    expect(within(within(pane("Tasks")).getByRole("article", { name: "Explore: Look into d" })).queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("stops a live task with runs.stopTask, Stopping… until it settles, then folds it with the finished", async () => {
    const { app, env, runId, ledger } = await withTasks({}, task("b", "running", 2), task("c", "running", 3));
    await waitFor(() => expect(listed("Live work")).toHaveLength(2));

    await app.user.click(onTask("Explore: Look into b", "Stop"));
    await waitFor(() => expect(sent(env, "runs.stopTask")).toEqual([expect.objectContaining({ runId, taskId: "b" })]));
    expect(onTask("Explore: Look into b", "Stopping…").getAttribute("aria-disabled")).toBe("true");

    ledger(task("b", "stopped", 2), task("c", "running", 3));
    await waitFor(() => expect(listed("Live work")).toEqual(["Explore: Look into c"]));
    expect(within(pane("Tasks")).getByRole("button", { name: "1 finished" })).toBeDefined();
  });

  it("says a refused stop in the pane's line, and offers Stop again", async () => {
    const { app } = await withTasks({ receipts: { "runs.stopTask": { rejected: "conflict", message: "The task has settled." } } }, task("b", "running", 2));
    await app.user.click(await within(pane("Tasks")).findByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Not stopped: The task has settled.")).toBeDefined();
    expect(onTask("Explore: Look into b", "Stop").getAttribute("aria-disabled")).toBeNull();
  });

  it("opens an agent's transcript through sessions.subagentTranscript, drawn as the transcript draws a session, and goes back to the tasks", async () => {
    const messages = [
      { type: "user", uuid: "u1", message: { role: "user", content: "Find where the parser lives" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Grep", input: { pattern: "parse" } }] } },
      { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "src/parser.ts" }] } },
      { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "It lives in **src/parser.ts**." }] } },
    ];
    const { app, env, session } = await withTasks(
      { provider: { subagentTranscripts: true }, subagentTranscripts: { "call-b": messages } },
      task("b", "running", 2),
      task("shell", "running", 3, { kind: "local_bash", subagentType: null, description: "pnpm test --watch" }),
    );
    await waitFor(() => expect(listed("Live work")).toHaveLength(2));
    // Work that is no agent has no transcript to open.
    expect(within(within(pane("Tasks")).getByRole("article", { name: "local_bash: pnpm test --watch" })).queryByRole("button", { name: "Open" })).toBeNull();

    await app.user.click(onTask("Explore: Look into b", "Open"));
    const transcript = await within(pane("Tasks")).findByRole("group", { name: "The agent's transcript" });
    expect(within(transcript).getByRole("article", { name: "Your message" }).textContent).toBe("Find where the parser lives");
    expect(within(transcript).getByRole("article", { name: "Reply" }).textContent).toBe("It lives in src/parser.ts.");
    expect(within(transcript).getByRole("button", { name: /^Searched the code/i })).toBeDefined();
    expect(sent(env, "sessions.subagentTranscript")).toEqual([{ sessionId: session, agentId: "call-b" }]);

    await app.user.click(within(pane("Tasks")).getByRole("button", { name: "Back to the tasks" }));
    expect(listed("Live work")).toHaveLength(2);
  });

  it("draws Open dim with the adapter's reason where it cannot read an agent's transcript, and a press says why", async () => {
    const { app, env } = await withTasks({}, task("b", "running", 2));
    const open = await within(pane("Tasks")).findByRole("button", { name: "Open" });
    await waitFor(() => expect(open.getAttribute("aria-disabled")).toBe("true"));
    await app.user.click(open);
    expect(await screen.findByText("Not opened: Claude cannot read a subagent's transcript.")).toBeDefined();
    expect(sent(env, "sessions.subagentTranscript")).toEqual([]);
  });
});
