import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { end, fakeAdapter, say, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { deleteSession } from "../../test/sessions.js";
import { refusedWith, sessionIn } from "../../test/terminals.js";
import { runGit } from "./git.js";
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

/**
 * Gives the environment's git a global config of the test's own, as the
 * machine's owner would write one: `HOME`, which the scrubbed environment
 * keeps, is pointed at a directory whose `.gitconfig` holds `entries`.
 */
const machineGitConfig = (entries: Record<string, string>): void => {
  const home = tempDir("agent-harness-home-");
  for (const [key, value] of Object.entries(entries)) git(home, "config", "--file", join(home, ".gitconfig"), key, value);
  const before = process.env["HOME"];
  process.env["HOME"] = home;
  onCleanup(() => void (before === undefined ? delete process.env["HOME"] : (process.env["HOME"] = before)));
};

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

describe("git on a workspace", () => {
  it("never runs the fsmonitor a repository's own config names, for files.list or diffs.workingTree", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    const marker = join(tempDir("agent-harness-marker-"), "ran");
    const monitor = join(tempDir("agent-harness-monitor-"), "monitor.sh");
    writeFileSync(monitor, `#!/bin/sh\necho ran >> ${marker}\nexit 1\n`);
    chmodSync(monitor, 0o755);
    git(root, "config", "core.fsmonitor", monitor);
    write(root, { "a.txt": "b\n" });

    await client.request("files.list", { sessionId });
    await client.request("diffs.workingTree", { sessionId });

    expect(existsSync(marker)).toBe(false);
  });

  it("refuses a diff whose repository names a clean filter, conflict, reason git_filters_refused, naming it, and never runs it (#212)", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    // The filter writes outside the workspace, as an agent's planted one would: the marker says whether it ran.
    const marker = join(tempDir("agent-harness-marker-"), "ran");
    git(root, "config", "filter.spy.clean", `sh -c 'echo ran >> ${marker}; cat'`);
    write(root, { ".gitattributes": "* filter=spy\n", "a.txt": "b\n", "new.txt": "new\n" });

    const error = await refusedWith(client.request("diffs.workingTree", { sessionId }));

    expect([error.code, error.data]).toEqual(["conflict", { reason: "git_filters_refused", filters: ["spy"] }]);
    expect(error.message).toMatch(/\bspy\b/);
    expect(existsSync(marker)).toBe(false);
    // A query: a second ask is refused the same, the filter still never run, and listing the files runs no filter.
    expect((await refusedWith(client.request("diffs.workingTree", { sessionId }))).data).toEqual({ reason: "git_filters_refused", filters: ["spy"] });
    expect((await client.request("files.list", { sessionId })).files).toEqual([".gitattributes", "a.txt", "new.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("counts a smudge or process filter, and one the repository's config includes from elsewhere, as the repository's; the machine's own config is not the repository's", async () => {
    const { client, root, sessionId } = await setUp();
    machineGitConfig({ "filter.machine.clean": "cat" });
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    const included = join(tempDir("agent-harness-include-"), "filters");
    writeFileSync(included, '[filter "lfs"]\n\tprocess = git-lfs filter-process\n');
    git(root, "config", "include.path", included);
    git(root, "config", "filter.Pretty.smudge", "cat");
    write(root, { "a.txt": "b\n" });

    const error = await refusedWith(client.request("diffs.workingTree", { sessionId }));

    expect([error.code, error.data]).toEqual(["conflict", { reason: "git_filters_refused", filters: ["Pretty", "lfs"] }]);
  });

  it("never runs the filter a committed nested repository's own config names: its dirt is not looked at, and its commit change still shows (#212)", async () => {
    const { client, root, sessionId } = await setUp();
    const nested = join(root, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q");
    write(nested, { "n.txt": "n\n" });
    git(nested, "add", ".");
    git(nested, "commit", "-qm", "nested first");
    const first = git(nested, "rev-parse", "HEAD").trim();
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    // A gitlink, no .gitmodules: git records the nested repository's commit.
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    write(nested, { ".gitattributes": "* filter=spy\n" });
    git(nested, "add", ".gitattributes");
    git(nested, "commit", "-qm", "nested second");
    const second = git(nested, "rev-parse", "HEAD").trim();
    // Planted after the nested commits, so only the diff could run them; the nested file is left dirty.
    const marker = join(tempDir("agent-harness-marker-"), "ran");
    git(nested, "config", "filter.spy.clean", `sh -c 'echo ran >> ${marker}; cat'`);
    git(nested, "config", "diff.external", `sh -c 'echo ran >> ${marker}'`);
    // The outer repository asks for the nested diff in full, which would run a diff, and its external diff, inside it.
    git(root, "config", "diff.submodule", "diff");
    write(nested, { "n.txt": "dirty\n" });

    const answer = await client.request("diffs.workingTree", { sessionId });

    expect(existsSync(marker)).toBe(false);
    expect(answer.diff).toContain(`-Subproject commit ${first}\n+Subproject commit ${second}\n`);
  });

  it("runs a filter the machine's own git config names, and gives git none of the environment's own variables", async () => {
    const secret = "AGENT_HARNESS_TEST_GIT_SECRET";
    process.env[secret] = "the environment's own";
    onCleanup(() => void delete process.env[secret]);
    const { client, root, sessionId } = await setUp();
    const marker = join(tempDir("agent-harness-marker-"), "seen");
    machineGitConfig({ "filter.spy.clean": `sh -c 'echo "[$${secret}]" >> ${marker}; cat'` });
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    write(root, { ".gitattributes": "* filter=spy\n", "a.txt": "b\n" });

    const answer = await client.request("diffs.workingTree", { sessionId });

    expect(answer.diff).toContain("-a\n+b\n");
    expect(readFileSync(marker, "utf8").trim().split("\n")).toContain("[]");
    expect(readFileSync(marker, "utf8")).not.toContain("the environment's own");
  });

  it("answers the diff methods conflict, reason git_unavailable, where there is no git, and files.list walks instead", async () => {
    const { client, root, sessionId } = await setUp();
    write(root, { "a.txt": "a\n" });
    const path = process.env["PATH"];
    process.env["PATH"] = tempDir("agent-harness-no-git-");
    onCleanup(() => void (process.env["PATH"] = path));

    const error = await refusedWith(client.request("diffs.workingTree", { sessionId }));
    expect([error.code, error.data["reason"]]).toEqual(["conflict", "git_unavailable"]);
    expect(await client.request("files.list", { sessionId })).toEqual({ files: ["a.txt"], truncated: false, source: "walk" });
  });
});

describe("runGit", () => {
  it("does not read a working directory that is gone as git missing from the PATH", async () => {
    const gone = join(tempDir("agent-harness-gone-"), "gone");
    const answer = await runGit(gone, ["--version"], { timeoutMs: 5_000, maxBytes: 1024 });
    expect(answer.ok).toBe(false);
    expect(answer.missing).toBe(false);
  });
});

describe("diffs.workingTree", () => {
  it("writes nothing into the repository's object store: only untracked files go into the scratch index", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "a.txt": "one\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    write(root, { "a.txt": "one\ntwo\n", "new.txt": "new\n" });
    // The object count: its size in kilobytes is the filesystem's block accounting, which moves on its own.
    const objects = () => git(root, "count-objects", "-v").split("\n").filter((line) => /^(count|in-pack):/.test(line));
    const before = objects();

    const answer = await client.request("diffs.workingTree", { sessionId });

    expect(answer.diff).toContain("+two\n");
    expect(answer.diff).toContain("+new\n");
    expect(objects()).toEqual(before);
  });

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

  it("answers conflict, reason git_failed, with git's own complaint, when git runs and fails, rather than an empty diff", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    write(root, { "a.txt": "a\n" });
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    // A failing required filter the machine's config names: the repository's own would be refused before git ran.
    machineGitConfig({ "filter.broken.clean": "false", "filter.broken.required": "true" });
    write(root, { ".gitattributes": "a.txt filter=broken\n", "a.txt": "b\n" });

    const error = await refusedWith(client.request("diffs.workingTree", { sessionId }));

    expect([error.code, error.data["reason"]]).toEqual(["conflict", "git_failed"]);
    expect(error.message).toMatch(/a\.txt/);
  });

  it("shows a tracked file rewritten at the same size in the second its index was written, which git's stat alone would call unchanged", async () => {
    const { client, root, sessionId } = await setUp();
    git(root, "init", "-q");
    // Racy git, pinned: the file and the index share one whole second, set rather than raced for; a ctime cannot be set back, so git is told not to weigh it.
    git(root, "config", "core.trustctime", "false");
    const second = Math.floor(Date.now() / 1000) - 60;
    write(root, { "a.txt": "a\n" });
    utimesSync(join(root, "a.txt"), second, second);
    git(root, "add", ".");
    git(root, "commit", "-qm", "first");
    write(root, { "a.txt": "b\n", "new.txt": "new\n" });
    utimesSync(join(root, "a.txt"), second, second);
    utimesSync(join(root, ".git", "index"), second, second);

    const answer = await client.request("diffs.workingTree", { sessionId });

    expect(answer.diff).toContain("-a\n+b\n");
    expect(answer.diff).toContain("+new\n");
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
  it("still answers when the workspace directory is gone, from the path the session recorded", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter });
    const client = await t.client();
    const root = join(tempDir("agent-harness-workspace-"), "project");
    mkdirSync(root);
    const sessionId = await sessionIn(client, root);
    adapter.nextScripts.push(editingScript([{ name: "Write", input: { file_path: join(root, "a.txt"), content: "a\n" } }]));
    await runToEnd(t, client, sessionId);
    rmSync(root, { recursive: true });

    expect((await client.request("diffs.session", { sessionId })).files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("names a file relative to the workspace whether the tool used the recorded path or the real one, and keeps a sibling named ..x outside", async () => {
    const adapter = fakeAdapter();
    const t = await start({ adapter });
    const client = await t.client();
    const base = tempDir("agent-harness-workspace-");
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "linked"));
    const sessionId = await sessionIn(client, join(base, "linked"));
    adapter.nextScripts.push(
      editingScript([
        { name: "Write", input: { file_path: join(base, "linked", "via-link.txt"), content: "a\n" } },
        { name: "Write", input: { file_path: join(base, "real", "via-real.txt"), content: "b\n" } },
        { name: "Write", input: { file_path: join(base, "linked", "..x", "odd.txt"), content: "c\n" } },
        { name: "Write", input: { file_path: "../elsewhere/up.txt", content: "d\n" } },
        { name: "Write", input: { file_path: "..y/in.txt", content: "e\n" } },
      ]),
    );
    await runToEnd(t, client, sessionId);

    const files = (await client.request("diffs.session", { sessionId })).files;
    expect(files.map((file) => file.path)).toEqual(["via-link.txt", "via-real.txt", "..x/odd.txt", "../elsewhere/up.txt", "..y/in.txt"]);
    // A relative name that climbs out of the workspace is outside it, as an absolute one is, so its header carries no a/ and b/; `..y` is a name inside.
    const headerOf = (index: number) => files[index]?.diff.split("\n").find((line) => line.startsWith("--- "));
    expect(headerOf(3)).toBe("--- ../elsewhere/up.txt");
    expect(headerOf(4)).toBe("--- a/..y/in.txt");
  });

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
