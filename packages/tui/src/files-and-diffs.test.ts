import { afterEach, describe, expect, it } from "vitest";
import type { SessionDiffFile } from "@agent-harness/contracts";
import { KEY, renderApp, type RenderedApp, type ScriptedEnvironment } from "../test/harness.js";

/**
 * Files and diffs in the terminal UI (docs/specs/tui.md, "The composer",
 * "The transcript"; #148): `/files [path]` opens `files.list` as a
 * browsable picker and reads a file in the pager through `files.read`, a
 * binary file and a cut listing marked; `/diff` and the row verb `d` read
 * `diffs.session` and `diffs.workingTree` through the user's diff filter,
 * a cut diff marked; the row verb `o` opens the file in the user's editor
 * on this machine's environment, else in the pager through `files.read`.
 */

let apps: RenderedApp[] = [];
afterEach(async () => {
  for (const app of apps) await app.unmount();
  apps = [];
});

const SESSION = "0199aa00-0000-4000-8000-000000000001";
const WORKSPACE = "/home/seth/receipts";
const FILES = ["README.md", "logo.png", "src/app.ts", "src/parse.ts"];

const launch = async (environment: Partial<ScriptedEnvironment> = {}, extra: Partial<Parameters<typeof renderApp>[0]> = {}) => {
  const app = await renderApp({
    script: {
      environments: [
        {
          name: "desk",
          reach: "local",
          sessions: [{ id: SESSION, title: "Receipts", workspace: { kind: "directory", path: WORKSPACE } }],
          files: FILES,
          fileContents: { "README.md": "# Receipts\n\nReads receipts.", "src/app.ts": "export const app = 1;\n", "logo.png": { binary: true, size: 2048 } },
          ...environment,
        },
      ],
    },
    flags: { session: SESSION },
    ...extra,
  });
  apps.push(app);
  await app.waitFor("Nothing said yet.");
  return { app, env: app.environment(environment.name ?? "desk") };
};

const command = async (app: RenderedApp, text: string) => {
  await app.type(text);
  await app.press(KEY.enter);
};

const paramsOf = (app: RenderedApp, name: string, method: string) => app.environment(name).requests(method).map((request) => request.params);

/** A run that edited `src/app.ts` with the call `t1` and read `README.md` with `t2`, its calls one row. */
const editRun = (app: RenderedApp, name = "desk") => {
  const env = app.environment(name);
  const { runId } = env.startRun(SESSION, "Fix the app");
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-export const app = 0;", "+export const app = 1;"] }];
  env.emit(SESSION, "tool.started", { runId, toolCallId: "t1", name: "Edit", input: { file_path: `${WORKSPACE}/src/app.ts`, old_string: "0", new_string: "1" }, title: null, agentId: null, parentToolCallId: null });
  env.emit(SESSION, "tool.ended", { runId, toolCallId: "t1", status: "ok", output: { structuredPatch: patch }, durationMs: 5 });
  env.endRun(SESSION, runId);
  return runId;
};

const APP_DIFF: SessionDiffFile = {
  path: "src/app.ts",
  diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const app = 0;\n+export const app = 1;\n",
  changes: [{ runId: "0199bb00-0000-4000-8000-000000000001", toolCallId: "t1", tool: "Edit", status: "ok" }],
};
const OTHER_DIFF: SessionDiffFile = {
  path: "src/parse.ts",
  diff: "--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -1 +1 @@\n-old parse\n+new parse\n",
  changes: [{ runId: "0199bb00-0000-4000-8000-000000000000", toolCallId: "t0", tool: "Write", status: "ok" }],
};

/** Takes the transcript's keys and puts its cursor on the run's calls, the row above its cost line. */
const onCallsRow = async (app: RenderedApp) => {
  await app.press(KEY.tab, KEY.tab);
  await app.waitFor("The transcript has the keys");
  await app.press(KEY.up, KEY.up);
};

describe("/files", () => {
  it("opens the workspace's listing as a picker, one directory at a time, and reads a file in the pager through files.read", async () => {
    const { app } = await launch();
    await command(app, "/files");
    await app.waitFor(/src\/ 2 files/);
    expect(app.frame()).toContain("Files · /home/seth/receipts");
    expect(app.frame()).toContain("README.md");
    await app.press(KEY.enter);
    await app.waitFor("Files · /home/seth/receipts/src");
    expect(app.frame()).toContain("../");
    await app.press(KEY.down);
    await app.press(KEY.enter);
    await app.waitFor("export const app = 1;");
    expect(app.frame()).toContain("src/app.ts · 22 bytes");
    expect(paramsOf(app, "desk", "files.read")).toEqual([{ sessionId: SESSION, path: "src/app.ts" }]);
    // The page goes back to the directory it was read from.
    await app.press("q");
    await app.waitFor("Files · /home/seth/receipts/src");
  });

  it("finds a typed filter anywhere under the directory, and reads a path named after /files at once", async () => {
    const { app } = await launch();
    await command(app, "/files");
    await app.waitFor("Files · /home/seth/receipts");
    await app.type("parse");
    await app.waitFor("src/parse.ts");
    expect(app.frame()).not.toContain("README.md");
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Nothing said yet.");
    await command(app, "/files README.md");
    await app.waitFor("Reads receipts.");
    expect(app.frame()).toContain("README.md · 27 bytes");
  });

  it("marks a binary file, drawing none of it, and a listing the environment cut at its cap", async () => {
    const { app } = await launch({ filesTruncated: true });
    await command(app, "/files");
    await app.waitFor("this listing is cut");
    await app.press(KEY.esc);
    await app.waitFor("Nothing said yet.");
    await command(app, "/files logo.png");
    await app.waitFor("A binary file of 2.0 KB: not shown as text.");
    expect(app.frame()).toContain("logo.png · 2.0 KB · binary");
  });

  it("reads an absolute path inside the workspace as the path under it, and refuses one outside it in one line", async () => {
    const { app } = await launch();
    await command(app, `/files ${WORKSPACE}/README.md`);
    await app.waitFor("Reads receipts.");
    expect(paramsOf(app, "desk", "files.read")).toEqual([{ sessionId: SESSION, path: "README.md" }]);
    // The page goes back to the listing it was read from, then the listing closes.
    await app.press(KEY.esc, KEY.esc);
    await app.waitFor("Nothing said yet.");
    await command(app, "/files /etc/hosts");
    await app.waitFor("/etc/hosts is outside the session's workspace, which the environment reads files from.");
    expect(paramsOf(app, "desk", "files.read")).toHaveLength(1);
  });

  it("says in one line why a path cannot be read", async () => {
    const { app } = await launch();
    await command(app, "/files nope.txt");
    await app.waitFor("Not read: No file nope.txt in the workspace.");
  });
});

describe("/diff", () => {
  it("reads what the session changed and the working tree, drawn as a diff when the user has no diff filter", async () => {
    const { app } = await launch({ sessionDiff: { files: [APP_DIFF] }, workingTree: { diff: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Old\n+# Receipts\n" } });
    await command(app, "/diff");
    await app.waitFor("What this session changed");
    expect(app.frame()).toContain("+export const app = 1;");
    expect(app.frame()).toContain("The working tree against HEAD");
    expect(app.frame()).toContain("+# Receipts");
    expect(paramsOf(app, "desk", "diffs.session")).toEqual([{ sessionId: SESSION }]);
    expect(paramsOf(app, "desk", "diffs.workingTree")).toEqual([{ sessionId: SESSION }]);
  });

  it("goes through the user's diff filter, named in the title, and marks a diff cut at its cap", async () => {
    const piped: string[] = [];
    const filter = {
      label: "delta",
      run: async (text: string) => {
        piped.push(text);
        return { ok: true as const, text: text.replaceAll("+export", "DELTA+export") };
      },
    };
    const { app } = await launch({ sessionDiff: { files: [APP_DIFF], truncated: true } }, { diffFilter: filter });
    await command(app, "/diff");
    await app.waitFor("DELTA+export const app = 1;");
    expect(app.frame()).toContain("Diff · via delta");
    expect(app.frame()).toContain("cut at 8 MiB");
    expect(piped[0]).toContain("+export const app = 1;");
  });

  it("says nothing of a diff that fails after a later page was asked for, which stays open with its own line", async () => {
    let fail: (error: Error) => void = () => undefined;
    const filter = { label: "delta", run: () => new Promise<never>((_, reject) => (fail = reject)) };
    const { app } = await launch({ sessionDiff: { files: [APP_DIFF] } }, { diffFilter: filter });
    await command(app, "/diff");
    await app.waitFor("Reading the diff, through delta…");
    await command(app, "/files README.md");
    await app.waitFor("Reads receipts.");
    fail(new Error("delta crashed."));
    await app.tick(5);
    expect(app.frame()).not.toContain("delta crashed.");
    expect(app.frame()).toContain("Reads receipts.");
  });

  it("says why the working tree has no diff: git refused the repository's filters", async () => {
    const { app } = await launch({ workingTree: { refused: "git_filters_refused", message: "The repository names a clean filter (lfs)." } });
    await command(app, "/diff");
    await app.waitFor("Not read: The repository names a clean filter (lfs).");
    expect(app.frame()).toContain("Nothing yet.");
  });
});

describe("the row verbs", () => {
  it("d shows the session's diff of the files the row's edits changed", async () => {
    const { app } = await launch({ sessionDiff: { files: [OTHER_DIFF, APP_DIFF] } });
    editRun(app);
    await app.waitFor("◆ Edited a file");
    await onCallsRow(app);
    await app.press("d");
    await app.waitFor("Diff · src/app.ts");
    expect(app.frame()).toContain("+export const app = 1;");
    expect(app.frame()).not.toContain("new parse");
  });

  it("o opens the file in the user's editor at the line the edit changed when the environment is this machine", async () => {
    const { app } = await launch();
    editRun(app);
    await app.waitFor("◆ Edited a file");
    await onCallsRow(app);
    await app.press("o");
    await app.waitUntil(() => app.opened.length === 1, "the editor to open the file");
    expect(app.opened).toEqual([{ path: `${WORKSPACE}/src/app.ts`, line: 1 }]);
    expect(paramsOf(app, "desk", "files.read")).toEqual([]);
  });

  it("o reads the file in the pager through files.read when the environment is another machine", async () => {
    const { app } = await launch({ name: "laptop", reach: "paired" });
    editRun(app, "laptop");
    await app.waitFor("◆ Edited a file");
    await onCallsRow(app);
    await app.press("o");
    await app.waitFor("export const app = 1;");
    expect(app.opened).toEqual([]);
    expect(paramsOf(app, "laptop", "files.read")).toEqual([{ sessionId: SESSION, path: "src/app.ts" }]);
  });
});
