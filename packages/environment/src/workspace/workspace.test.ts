import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { deleteSession } from "../../test/sessions.js";
import { refusedWith, sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * Files and diffs through the primary seam (tui spec, "Terminal vocabulary
 * tests"; #124): `files.list` capped and never escaping the workspace,
 * `files.read` capped and flagging binary, `diffs.workingTree` from git, and
 * `diffs.session` folded from the runs' tool events, which the scripted fake
 * adapter plays as the Claude adapter will.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** Writes `files` (path to content) under `root`, making directories as needed. */
const write = (root: string, files: Record<string, string | Buffer>): void => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** Runs git in `cwd` as a test user, with no global or system configuration. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });

/** A workspace of the test's own, and a session in it. */
const setUp = async (options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const client = await t.client();
  const root = tempDir("agent-harness-workspace-");
  const sessionId = await sessionIn(client, root);
  return { t, client, root, sessionId };
};

describe("files.list", () => {
  it("lists a repository's tracked and untracked files that are not ignored, in code-unit order, from git", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "README.md": "# hi\n", "src/b.ts": "", "src/a.ts": "", ".gitignore": "*.log\nbuild/\n", "debug.log": "x", "build/out.js": "" });
    git(root, "add", "README.md", "src/a.ts", ".gitignore");
    git(root, "commit", "-qm", "first");

    expect(await client.request("files.list", { sessionId })).toEqual({
      files: [".gitignore", "README.md", "src/a.ts", "src/b.ts"],
      truncated: false,
      source: "git",
    });
  });

  it("walks a directory that is no repository, skipping .git, node_modules, dist, out, .tsbuild and every dot-directory, and never a symlink", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, {
      "a.txt": "",
      "src/index.ts": "",
      ".env": "",
      "node_modules/x/index.js": "",
      "dist/a.js": "",
      "out/b.js": "",
      ".tsbuild/c": "",
      ".venv/lib.py": "",
      "packages/p/dist/d.js": "",
      "packages/p/src/e.ts": "",
    });
    symlinkSync(join(root, "a.txt"), join(root, "link.txt"));
    symlinkSync(join(root, "src"), join(root, "linked-dir"));

    expect(await client.request("files.list", { sessionId })).toEqual({
      files: [".env", "a.txt", "packages/p/src/e.ts", "src/index.ts"],
      truncated: false,
      source: "walk",
    });
  });

  it("answers at most 20,000 files, with truncated when there are more", async () => {
    const { client, root, sessionId } = await setUp();
    for (let d = 0; d < 21; d += 1) {
      mkdirSync(join(root, `d${String(d).padStart(2, "0")}`));
      for (let f = 0; f < 1000; f += 1) writeFileSync(join(root, `d${String(d).padStart(2, "0")}`, `f${String(f).padStart(4, "0")}`), "");
    }
    const answer = await client.request("files.list", { sessionId });
    expect(answer.truncated).toBe(true);
    expect(answer.files).toHaveLength(20_000);
    expect(answer.files[0]).toBe("d00/f0000");
  });

  it("refuses a session that is not on this environment, or deleted, not_found, kind session", async () => {
    const { client, sessionId } = await setUp();
    const unknown = randomUUID();
    const error = await refusedWith(client.request("files.list", { sessionId: unknown }));
    expect([error.code, error.data]).toEqual(["not_found", { kind: "session", sessionId: unknown }]);
    await deleteSession(client, sessionId);
    const deleted = await refusedWith(client.request("files.read", { sessionId, path: "a.txt" }));
    expect([deleted.code, deleted.data]).toEqual(["not_found", { kind: "session", sessionId }]);
  });
});

describe("files.read", () => {
  it("reads a text file as UTF-8 with its size", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, { "src/a.ts": "export const é = 1;\n" });
    expect(await client.request("files.read", { sessionId, path: "src/a.ts" })).toEqual({
      path: "src/a.ts",
      size: Buffer.byteLength("export const é = 1;\n"),
      binary: false,
      truncated: false,
      text: "export const é = 1;\n",
    });
  });

  it("flags a file with a NUL byte in its first 8 KiB binary, with no text", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, { "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]), "late.bin": Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]) });
    expect(await client.request("files.read", { sessionId, path: "logo.png" })).toEqual({ path: "logo.png", size: 6, binary: true, truncated: false, text: null });
    // A NUL past the first 8 KiB is not looked for.
    expect((await client.request("files.read", { sessionId, path: "late.bin" })).binary).toBe(false);
  });

  it("reads at most 2 MiB, with truncated and the size on disk", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, { "big.log": "y".repeat(3 * 1024 * 1024) });
    const answer = await client.request("files.read", { sessionId, path: "big.log" });
    expect([answer.size, answer.truncated, answer.binary, answer.text?.length]).toEqual([3 * 1024 * 1024, true, false, 2 * 1024 * 1024]);
  });

  it.each([
    ["a .. segment", "../outside.txt"],
    ["an absolute path", "/etc/passwd"],
    ["a symlink out of the workspace", "escape/secret.txt"],
  ])("refuses %s invalid_params, reason escapes_workspace", async (_what, path) => {
    const { client, root, sessionId } = await setUp();
    const outside = tempDir("agent-harness-outside-");
    write(outside, { "secret.txt": "secret" });
    symlinkSync(outside, join(root, "escape"));
    const error = await refusedWith(client.request("files.read", { sessionId, path }));
    expect(error.code).toBe("invalid_params");
    expect(error.data).toMatchObject({ reason: "escapes_workspace" });
  });

  it("answers a path with nothing there not_found, kind file, and a directory invalid_params, reason not_a_file", async () => {
    const { client, root, sessionId } = await setUp();
    mkdirSync(join(root, "src"));
    const missing = await refusedWith(client.request("files.read", { sessionId, path: "nope.txt" }));
    expect([missing.code, missing.data]).toEqual(["not_found", { kind: "file", path: "nope.txt" }]);
    const directory = await refusedWith(client.request("files.read", { sessionId, path: "src" }));
    expect([directory.code, directory.data["reason"]]).toEqual(["invalid_params", "not_a_file"]);
  });
});

describe("diffs.workingTree", () => {
  it("is the unified diff against HEAD: changes staged and not, and untracked files as new, never ignored ones, leaving the index as it was", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "a.txt": "one\ntwo\n", ".gitignore": "*.log\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    write(root, { "a.txt": "one\n2\n", "staged.txt": "staged\n", "new.txt": "brand new\n", "noise.log": "ignored\n" });
    git(root, "add", "staged.txt");
    const indexBefore = git(root, "diff", "--cached", "--name-only");

    const answer = await client.request("diffs.workingTree", { sessionId });

    expect(answer.repository).toBe(true);
    expect(answer.truncated).toBe(false);
    expect(answer.diff).toContain("diff --git a/a.txt b/a.txt");
    expect(answer.diff).toContain("-two\n+2\n");
    expect(answer.diff).toContain("diff --git a/staged.txt b/staged.txt");
    expect(answer.diff).toContain("diff --git a/new.txt b/new.txt\nnew file mode");
    expect(answer.diff).toContain("+brand new\n");
    expect(answer.diff).not.toContain("noise.log");
    expect(git(root, "diff", "--cached", "--name-only")).toBe(indexBefore);
    expect(git(root, "status", "--porcelain")).toContain("?? new.txt");
  });

  it("diffs a repository with no commit against the empty tree, and a workspace below the repository's root with paths relative to it", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "top.txt": "top\n", "pkg/inner.txt": "inner\n" });
    const inner = await sessionIn(client, join(root, "pkg"));

    const whole = await client.request("diffs.workingTree", { sessionId });
    expect(whole.diff).toContain("diff --git a/top.txt b/top.txt");
    expect(whole.diff).toContain("diff --git a/pkg/inner.txt b/pkg/inner.txt");
    const below = await client.request("diffs.workingTree", { sessionId: inner });
    expect(below.diff).toContain("diff --git a/inner.txt b/inner.txt");
    expect(below.diff).not.toContain("top.txt");
  });

  it("says a workspace in no repository has nothing to diff", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, { "a.txt": "a\n" });
    expect(await client.request("diffs.workingTree", { sessionId })).toEqual({ diff: "", truncated: false, repository: false });
  });

  it("answers at most 8 MiB, cut at a line, with truncated", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "big.txt": `${"z".repeat(99)}\n`.repeat(90_000) });
    const answer = await client.request("diffs.workingTree", { sessionId });
    expect(answer.truncated).toBe(true);
    expect(Buffer.byteLength(answer.diff)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Buffer.byteLength(answer.diff)).toBeGreaterThan(8 * 1024 * 1024 - 200);
    expect(answer.diff.endsWith("\n")).toBe(true);
  });
});

/** A run whose script plays `events` as the Claude adapter reports file edits, then ends. */
const editingScript =
  (events: readonly { name: string; input: Record<string, unknown>; status?: "ok" | "error"; output?: unknown }[]): Script =>
  () => [
    ...events.flatMap((event, i) => [
      { type: "tool.started" as const, payload: { toolCallId: `toolu_${i}`, name: event.name, input: event.input, title: null, agentId: null, parentToolCallId: null } },
      { type: "tool.ended" as const, payload: { toolCallId: `toolu_${i}`, status: event.status ?? "ok", output: (event.output ?? "ok") as never, durationMs: 1 } },
    ]),
    say("Edited"),
    end(),
  ];

/**
 * Starts a run on the session and waits for its `run.ended` in the log: read
 * there rather than through a subscription, since a run writing megabytes of
 * edits would pass a subscriber's bound.
 */
const runToEnd = async (t: TestEnvironment, client: WireClient, sessionId: string): Promise<string> => {
  const runId = (await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "Edit the files" })).runId;
  const deadline = Date.now() + 20_000;
  while (!t.env.log.readStream({ kind: "session", id: sessionId }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)) {
    if (Date.now() > deadline) throw new Error(`Run ${runId} did not end.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return runId;
};

describe("diffs.session", () => {
  it("folds the session's file-editing tool calls that ended ok into a diff per file, in the order first changed, with the calls behind each", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter });
    const client = await t.client();
    const root = tempDir("agent-harness-workspace-");
    const sessionId = await sessionIn(client, root);
    adapter.nextScripts.push(
      editingScript([
        { name: "Write", input: { file_path: join(root, "src/new.ts"), content: "export const a = 1;\nexport const b = 2;\n" } },
        { name: "Edit", input: { file_path: join(root, "README.md"), old_string: "# Old\nkept\n", new_string: "# New\nkept\n" } },
        { name: "Edit", input: { file_path: join(root, "README.md"), old_string: "never", new_string: "applied" }, status: "error" },
        { name: "Bash", input: { command: "rm -rf build" } },
        {
          name: "MultiEdit",
          input: { file_path: join(root, "src/new.ts"), edits: [{ old_string: "export const b = 2;", new_string: "export const b = 3;" }] },
        },
        { name: "Write", input: { file_path: "/elsewhere/notes.txt", content: "outside\n" } },
      ]),
    );
    const runId = await runToEnd(t, client, sessionId);

    const answer = await client.request("diffs.session", { sessionId });

    expect(answer.truncated).toBe(false);
    expect(answer.files.map((file) => file.path)).toEqual(["src/new.ts", "README.md", "/elsewhere/notes.txt"]);
    const [created, readme, outside] = answer.files;
    expect(created?.changes).toEqual([
      { runId, toolCallId: "toolu_0", tool: "Write", status: "ok" },
      { runId, toolCallId: "toolu_4", tool: "MultiEdit", status: "ok" },
    ]);
    expect(created?.diff).toBe(
      [
        "--- a/src/new.ts",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,2 @@",
        "+export const a = 1;",
        "+export const b = 2;",
        "@@ -1,1 +1,1 @@",
        "-export const b = 2;",
        "+export const b = 3;",
        "",
      ].join("\n"),
    );
    expect(readme?.changes).toEqual([{ runId, toolCallId: "toolu_1", tool: "Edit", status: "ok" }]);
    expect(readme?.diff).toBe(["--- a/README.md", "+++ b/README.md", "@@ -1,2 +1,2 @@", "-# Old", "+# New", " kept", ""].join("\n"));
    expect(outside?.diff).toBe(["--- /elsewhere/notes.txt", "+++ /elsewhere/notes.txt", "@@ -0,0 +1,1 @@", "+outside", ""].join("\n"));
  });

  it("takes a tool's own patch, with the file's line numbers, when its output carries one", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter });
    const client = await t.client();
    const root = tempDir("agent-harness-workspace-");
    const sessionId = await sessionIn(client, root);
    const structuredPatch = [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [" a", "-b", "+B", " c"] }];
    adapter.nextScripts.push(
      editingScript([{ name: "Edit", input: { file_path: join(root, "x.ts"), old_string: "b", new_string: "B" }, output: { filePath: join(root, "x.ts"), structuredPatch } }]),
    );
    await runToEnd(t, client, sessionId);

    const answer = await client.request("diffs.session", { sessionId });

    expect(answer.files).toMatchObject([{ path: "x.ts", diff: ["--- a/x.ts", "+++ b/x.ts", "@@ -10,3 +10,3 @@", " a", "-b", "+B", " c", ""].join("\n") }]);
  });

  it("is empty for a session whose runs changed no file, and not_found for a deleted one", async () => {
    const { client, sessionId } = await setUp();
    expect(await client.request("diffs.session", { sessionId })).toEqual({ files: [], truncated: false });
    await deleteSession(client, sessionId);
    const error = await refusedWith(client.request("diffs.session", { sessionId }));
    expect([error.code, error.data]).toEqual(["not_found", { kind: "session", sessionId }]);
  });

  it("answers at most 8 MiB of diff, with truncated", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter });
    const client = await t.client();
    const root = tempDir("agent-harness-workspace-");
    const sessionId = await sessionIn(client, root);
    const content = `${"w".repeat(1023)}\n`.repeat(3 * 1024);
    adapter.nextScripts.push(editingScript([1, 2, 3].map((n) => ({ name: "Write", input: { file_path: join(root, `f${n}.txt`), content } }))));
    await runToEnd(t, client, sessionId);

    const answer = await client.request("diffs.session", { sessionId });

    expect(answer.truncated).toBe(true);
    const bytes = answer.files.reduce((total, file) => total + Buffer.byteLength(file.diff), 0);
    expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(answer.files.map((file) => file.path)).toEqual(["f1.txt", "f2.txt", "f3.txt"]);
    expect(answer.files[2]?.diff.endsWith("\n")).toBe(true);
  });
});
