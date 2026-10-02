import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { editFile, end, fakeAdapter, fileTool, gate, say, type Script, type ScriptControls } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { deleteSession, purgeSession } from "../../test/sessions.js";
import { sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";
import type { AdapterEvent } from "../adapter/contract.js";

/**
 * File undo through the primary seam (switch-over spec, "Phase-D commands
 * and parity", File undo; #1183): a run's file tool, played by the scripted
 * adapter as Claude's hooks play it, captured before and after it writes; then
 * `files.undo` over the typed wire, asserted on the workspace's bytes and
 * modes and on the session's log.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment({ adapter: fakeAdapter(), ...options });
  onCleanup(() => t.close());
  return t;
};

/** A workspace of the test's own holding `files`, and a session in it. */
const setUp = async (files: Record<string, string> = {}, options: TestEnvironmentOptions = {}) => {
  const t = await start(options);
  const client = await t.client();
  const root = tempDir("agent-harness-undo-");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  const sessionId = await sessionIn(client, root);
  return { t, client, root, sessionId };
};

/** Starts a run on the session playing `script`, and resolves with its id once its `run.ended` is in the log. */
const runScript = async (t: TestEnvironment, client: WireClient, sessionId: string, script: Script): Promise<string> => {
  t.adapter.nextScripts.push(script);
  const ended = new Promise<string>((resolve) => {
    const unsubscribe = t.env.log.subscribe((event) => {
      if (event.type !== "run.ended" || event.streamId !== sessionId) return;
      unsubscribe();
      resolve(event.payload["runId"] as string);
    });
  });
  await client.apply("runs.start", { commandId: randomUUID(), sessionId, text: "Edit the files" });
  return ended;
};

/** A run that plays each of `steps`, then ends completed. */
const playing =
  (...steps: ((controls: ScriptControls) => AsyncIterable<AdapterEvent>)[]): Script =>
  async function* (controls) {
    for (const step of steps) yield* step(controls);
    yield end();
  };

/** The session's events of `type`, payloads only. */
const eventsOf = (t: TestEnvironment, sessionId: string, type: string) =>
  t.env.log.readStream({ kind: "session", id: sessionId }).flatMap((event) => (event.type === type ? [event.payload] : []));

const modeOf = (path: string): number => statSync(path).mode & 0o7777;

/** Asks files.undo with a fresh command id (unless one is given); resolves with the response. */
const undo = (client: WireClient, sessionId: string, commandId: string = randomUUID()) => client.request("files.undo", { commandId, sessionId });

/** Asks files.undo, which must be refused in its receipt; resolves with the rejection's code and data. */
const refusal = async (client: WireClient, sessionId: string): Promise<{ code: string; data: Record<string, unknown> }> => {
  const { receipt } = await undo(client, sessionId);
  if (receipt.status !== "rejected") throw new Error(`files.undo was accepted: ${JSON.stringify(receipt)}`);
  return { code: receipt.error.code, data: receipt.error.data };
};

/** A `Write` of `path`: a tool whose change is recorded, and not restored yet. */
const writeCall = (controls: ScriptControls, path: string, content: string) =>
  fileTool(controls, { tool: "Write", input: { file_path: path, content }, paths: [path], write: () => writeFileSync(path, content) });

describe("files.undo", () => {
  it("writes back the bytes and mode an Edit replaced, answers the change and records it, with no file contents", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "one\ntwo\n" });
    chmodSync(join(root, "a.txt"), 0o640);
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: join(root, "a.txt"), oldString: "two", newString: "2" })));
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\n2\n");

    const answer = await client.apply("files.undo", { commandId: randomUUID(), sessionId });

    expect(answer).toEqual({ changeId: expect.any(String), path: "a.txt", action: "restored" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("one\ntwo\n");
    expect(modeOf(join(root, "a.txt"))).toBe(0o640);
    expect(eventsOf(t, sessionId, "files.undo-finished")).toEqual([answer]);
  });

  it("leaves an undone change out of diffs.session, and keeps the session's other changes in it", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n", "b.txt": "b\n" });
    await runScript(
      t,
      client,
      sessionId,
      playing(
        (controls) => editFile(controls, { path: join(root, "a.txt"), oldString: "a", newString: "A", toolCallId: "toolu_a" }),
        (controls) => editFile(controls, { path: join(root, "b.txt"), oldString: "b", newString: "B", toolCallId: "toolu_b" }),
      ),
    );
    expect((await client.request("diffs.session", { sessionId })).files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);

    await client.apply("files.undo", { commandId: randomUUID(), sessionId });

    const { files } = await client.request("diffs.session", { sessionId });
    expect(files.map((file) => [file.path, file.changes.map((change) => change.toolCallId)])).toEqual([["a.txt", ["toolu_a"]]]);
    expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b\n");
    expect((await client.request("files.read", { sessionId, path: "b.txt" })).text).toBe("b\n");
  });

  it("walks back the session's changes newest first, one file at a time, and then has nothing to undo", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "b", newString: "c" })));

    expect((await client.apply("files.undo", { commandId: randomUUID(), sessionId })).path).toBe("a.txt");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\n");
    await client.apply("files.undo", { commandId: randomUUID(), sessionId });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");

    const head = t.env.log.head();
    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "nothing_to_undo", sessionId } });
    expect(t.env.log.head()).toBe(head);
  });

  it("has nothing to undo for a session with no change, a failed Edit's or a shell command's", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "nothing_to_undo", sessionId } });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "missing", newString: "x" })));
    writeFileSync(join(root, "a.txt"), "changed by a shell\n");
    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "nothing_to_undo", sessionId } });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("changed by a shell\n");
  });

  it("refuses file_changed when the file no longer holds what the Edit left, writing nothing and keeping the change", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    writeFileSync(join(root, "a.txt"), "b\nand more\n");

    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "file_changed", sessionId, changeId: expect.any(String), path: "a.txt" } });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\nand more\n");
    expect(eventsOf(t, sessionId, "files.undo-finished")).toEqual([]);

    // The change is still the newest: once the file holds what the Edit left again, it is undone.
    writeFileSync(join(root, "a.txt"), "b\n");
    await client.apply("files.undo", { commandId: randomUUID(), sessionId });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  it("refuses file_changed when only the file's mode has changed since the Edit, leaving the mode as it is", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    chmodSync(join(root, "a.txt"), 0o644);
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    chmodSync(join(root, "a.txt"), 0o755);

    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "file_changed", sessionId, changeId: expect.any(String), path: "a.txt" } });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\n");
    expect(modeOf(join(root, "a.txt"))).toBe(0o755);
  });

  it("never passes a newest change it cannot restore to undo an older one", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n", "b.txt": "b\n" });
    await runScript(
      t,
      client,
      sessionId,
      playing(
        (controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "A" }),
        (controls) => writeCall(controls, join(root, "b.txt"), "B\n"),
      ),
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await refusal(client, sessionId)).toEqual({
        code: "conflict",
        data: { reason: "snapshot_unavailable", sessionId, changeId: expect.any(String), path: "b.txt", unrestorable: "unknown" },
      });
    }
    expect([readFileSync(join(root, "a.txt"), "utf8"), readFileSync(join(root, "b.txt"), "utf8")]).toEqual(["A\n", "B\n"]);
  });

  it("cannot restore an Edit of a binary file, nor one past 2 MiB", async () => {
    const big = "x".repeat(2 * 1024 * 1024 - 1) + "\n";
    const { t, client, sessionId } = await setUp({ "bin.dat": "head\0tail", "big.txt": big });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "bin.dat", oldString: "tail", newString: "TAIL" })));
    expect((await refusal(client, sessionId)).data).toMatchObject({ reason: "snapshot_unavailable", path: "bin.dat", unrestorable: "binary" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "big.txt", oldString: "\n", newString: "xx\n" })));
    expect((await refusal(client, sessionId)).data).toMatchObject({ reason: "snapshot_unavailable", path: "big.txt", unrestorable: "oversized" });
  });

  it("keeps a session's newest 50 changes: past them, undo stops at an evicted one", async () => {
    const files = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`f${String(index).padStart(2, "0")}.txt`, "before\n"]));
    const { t, client, root, sessionId } = await setUp(files);
    const paths = Object.keys(files);
    await runScript(t, client, sessionId, playing(...paths.map((path) => (controls: ScriptControls) => editFile(controls, { path, oldString: "before", newString: "after" }))));

    for (const path of [...paths].reverse().slice(0, 50)) expect((await client.apply("files.undo", { commandId: randomUUID(), sessionId })).path).toBe(path);
    expect((await refusal(client, sessionId)).data).toMatchObject({ reason: "snapshot_unavailable", path: "f00.txt", unrestorable: "evicted" });
    expect(readFileSync(join(root, "f00.txt"), "utf8")).toBe("after\n");
    expect(readFileSync(join(root, "f01.txt"), "utf8")).toBe("before\n");
  });

  it("refuses run_active while a run of the session, or of another session in its workspace, is live", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    const other = await sessionIn(client, root);
    for (const live of [sessionId, other]) {
      const held = gate();
      t.adapter.nextScripts.push(async function* () {
        yield say("Working");
        await held.opened;
        yield end();
      });
      const ended = new Promise<void>((resolve) => {
        const unsubscribe = t.env.log.subscribe((event) => {
          if (event.type === "run.ended" && event.streamId === live) {
            unsubscribe();
            resolve();
          }
        });
      });
      const { runId } = await client.apply("runs.start", { commandId: randomUUID(), sessionId: live, text: "Keep working" });
      expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "run_active", sessionId: live, runId } });
      held.open();
      await ended;
    }
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\n");
    await client.apply("files.undo", { commandId: randomUUID(), sessionId });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  it("refuses workspace_missing once the workspace directory is gone", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    rmSync(root, { recursive: true, force: true });
    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "workspace_missing", sessionId, path: root } });
  });

  it("refuses unsafe_path for a file outside the workspace, and for one a symlink stands in for now, writing through neither", async () => {
    const { t, client, sessionId } = await setUp({ "a.txt": "a\n" });
    const outside = join(tempDir("agent-harness-outside-"), "secret.txt");
    writeFileSync(outside, "s\n");
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: outside, oldString: "s", newString: "S" })));
    expect(await refusal(client, sessionId)).toEqual({ code: "conflict", data: { reason: "unsafe_path", sessionId, changeId: expect.any(String), path: outside } });
    expect(readFileSync(outside, "utf8")).toBe("S\n");

    const { t: t2, client: client2, root: root2, sessionId: session2 } = await setUp({ "a.txt": "a\n" });
    await runScript(t2, client2, session2, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    // The file the Edit changed is replaced by a symlink to a file outside holding the very bytes the Edit left.
    const elsewhere = join(tempDir("agent-harness-outside-"), "b.txt");
    writeFileSync(elsewhere, "b\n");
    rmSync(join(root2, "a.txt"));
    symlinkSync(elsewhere, join(root2, "a.txt"));
    expect((await refusal(client2, session2)).data).toMatchObject({ reason: "unsafe_path", path: "a.txt" });
    expect(readFileSync(elsewhere, "utf8")).toBe("b\n");
  });

  it("restores a file an Edit reached through a symlink inside the workspace, at the file itself", async () => {
    const { t, client, root, sessionId } = await setUp();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "a.txt"), "a\n");
    symlinkSync(join(root, "real"), join(root, "linked"));
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "linked/a.txt", oldString: "a", newString: "b" })));
    expect(await client.apply("files.undo", { commandId: randomUUID(), sessionId })).toMatchObject({ path: "real/a.txt", action: "restored" });
    expect(readFileSync(join(root, "real", "a.txt"), "utf8")).toBe("a\n");
  });

  it("cannot restore a change an imported session's history made, older than every change a run made since", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n", "b.txt": "b\n" });
    const imported = randomUUID();
    const input = { file_path: join(root, "b.txt"), old_string: "x", new_string: "b" };
    t.env.log.append(
      { kind: "session", id: sessionId },
      [
        { type: "tool.started", payload: { runId: imported, toolCallId: "toolu_imported", name: "Edit", input, title: null, agentId: null, parentToolCallId: null } },
        { type: "tool.ended", payload: { runId: imported, toolCallId: "toolu_imported", status: "ok", output: "done", durationMs: 1 } },
        { type: "session.history-imported", payload: { runId: imported, providerSessionId: "provider-session-1", outcome: "appended", message: null } },
      ],
      { actor: "system:carry-over" },
    );
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "A" })));

    await client.apply("files.undo", { commandId: randomUUID(), sessionId });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(await refusal(client, sessionId)).toEqual({
      code: "conflict",
      data: { reason: "snapshot_unavailable", sessionId, unrestorable: "imported_history", toolCallId: "toolu_imported" },
    });
  });

  it("cannot restore yet an Edit that created its file, nor another recognised tool's change", async () => {
    const { t, client, root, sessionId } = await setUp();
    await runScript(
      t,
      client,
      sessionId,
      playing((controls) =>
        fileTool(controls, { input: { file_path: "new.txt", old_string: "", new_string: "n\n" }, paths: ["new.txt"], write: () => writeFileSync(join(root, "new.txt"), "n\n") }),
      ),
    );
    expect((await refusal(client, sessionId)).data).toMatchObject({ reason: "snapshot_unavailable", path: "new.txt", unrestorable: "unknown" });
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("n\n");
  });
});

describe("files.undo beside the rest of the session", () => {
  /** Runs git in `cwd` as a test user, with no global or system configuration. */
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });

  it("leaves the repository's index and stash as they were", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n", "b.txt": "b\n" });
    git(root, "init", "-q");
    git(root, "add", "a.txt", "b.txt");
    git(root, "commit", "-qm", "first");
    writeFileSync(join(root, "b.txt"), "stashed\n");
    git(root, "stash", "-q");
    writeFileSync(join(root, "b.txt"), "staged\n");
    git(root, "add", "b.txt");
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "A" })));
    const index = readFileSync(join(root, ".git", "index"));
    const stash = git(root, "stash", "list", "--format=%H");

    await client.apply("files.undo", { commandId: randomUUID(), sessionId });

    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(readFileSync(join(root, ".git", "index")).equals(index)).toBe(true);
    expect(git(root, "stash", "list", "--format=%H")).toBe(stash);
    expect(git(root, "diff", "--cached", "--name-only")).toBe("b.txt\n");
  });

  it("serialises two undos of one workspace, each restoring its own change", async () => {
    const { t, client, root, sessionId } = await setUp({ "a.txt": "a\n", "b.txt": "b\n" });
    await runScript(
      t,
      client,
      sessionId,
      playing(
        (controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "A" }),
        (controls) => editFile(controls, { path: "b.txt", oldString: "b", newString: "B" }),
      ),
    );
    const answers = await Promise.all([client.apply("files.undo", { commandId: randomUUID(), sessionId }), client.apply("files.undo", { commandId: randomUUID(), sessionId })]);
    expect(answers.map((answer) => answer.path)).toEqual(["b.txt", "a.txt"]);
    expect([readFileSync(join(root, "a.txt"), "utf8"), readFileSync(join(root, "b.txt"), "utf8")]).toEqual(["a\n", "b\n"]);
  });

  it("neither rewinds the conversation nor undoes a rewind: it appends files.undo-finished alone", async () => {
    const { t, client, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    const before = t.env.log.head();
    const summary = (await client.request("sessions.get", { sessionId })).summary;

    await client.apply("files.undo", { commandId: randomUUID(), sessionId });

    expect(t.env.log.readStream({ kind: "session", id: sessionId }, before).map((event) => event.type)).toEqual(["files.undo-finished"]);
    expect((await client.request("sessions.get", { sessionId })).summary).toEqual(summary);
  });

  it("is offered as the fileUndo flag", async () => {
    const { client } = await setUp();
    expect(client.hello.capabilities).toContain("fileUndo");
  });

  it("keeps no snapshot of a purged session", async () => {
    const { t, client, sessionId } = await setUp({ "a.txt": "a\n" });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    const kept = () => t.env.log.read<{ count: number }>("SELECT count(*) AS count FROM file_changes WHERE session_id = ?", sessionId)[0]?.count;
    expect(kept()).toBe(1);
    await deleteSession(client, sessionId);
    await purgeSession(client, sessionId);
    expect(kept()).toBe(0);
  });
});

describe("files.undo's receipts and its journal", () => {
  /** A held step of a restore: `reached` settles when the restore gets there; it then waits forever, as a process killed there would. */
  const stopHere = () => {
    let reach!: () => void;
    const reached = new Promise<void>((resolve) => (reach = resolve));
    return { reached, hook: () => { reach(); return new Promise<void>(() => undefined); } };
  };

  /** A workspace with one Edit of a.txt, "a" to "b", in a session, on a data directory of the test's own, with a client session's token. */
  const edited = async (options: TestEnvironmentOptions = {}) => {
    const dataDir = join(tempDir("agent-harness-undo-data-"), "data");
    const { t, root, sessionId } = await setUp({ "a.txt": "a\n" }, { dataDir, ...options });
    const { token } = await t.bootstrap();
    const client = await t.client({ token });
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "b" })));
    return { t, client, token, root, sessionId, dataDir };
  };

  it("answers a retry of the same command from its receipt, writing nothing again", async () => {
    const { t, client, root, sessionId } = await edited();
    const commandId = randomUUID();
    const first = await undo(client, sessionId, commandId);
    expect(first.receipt.status).toBe("accepted");
    await runScript(t, client, sessionId, playing((controls) => editFile(controls, { path: "a.txt", oldString: "a", newString: "c" })));

    const again = await undo(client, sessionId, commandId);
    expect(again).toEqual({ receipt: first.receipt });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("c\n");
    expect(eventsOf(t, sessionId, "files.undo-finished")).toHaveLength(1);
  });

  it("removes the scratch file and journal before reporting a failed rename, leaving the change for a retry", async () => {
    let target = "";
    let failOnce = true;
    const { t, client, root, sessionId } = await edited({
      fileUndoHooks: {
        beforeRename: async () => {
          if (!failOnce) return;
          failOnce = false;
          rmSync(target);
          mkdirSync(target);
        },
      },
    });
    target = join(root, "a.txt");
    const commandId = randomUUID();

    await expect(undo(client, sessionId, commandId)).rejects.toMatchObject({ code: "internal" });

    expect(readdirSync(root)).toEqual(["a.txt"]);
    expect(statSync(target).isDirectory()).toBe(true);
    expect(t.env.log.fileChanges.allJournaled()).toEqual([]);
    expect(t.env.log.fileChanges.newest(sessionId)).toMatchObject({ state: "completed" });
    expect(eventsOf(t, sessionId, "files.undo-finished")).toEqual([]);
    rmSync(target, { recursive: true });
    writeFileSync(target, "b\n");
    const again = await undo(client, sessionId, commandId);
    expect(again.result).toEqual({ changeId: expect.any(String), path: "a.txt", action: "restored" });
    expect(readFileSync(target, "utf8")).toBe("a\n");
  });

  it("records a restore an earlier attempt of the command applied once, without writing again", async () => {
    let failOnce = true;
    const { t, client, root, sessionId } = await edited({
      fileUndoHooks: {
        afterRename: async () => {
          if (!failOnce) return;
          failOnce = false;
          throw new Error("The commit did not happen.");
        },
      },
    });
    const commandId = randomUUID();
    await expect(undo(client, sessionId, commandId)).rejects.toMatchObject({ code: "internal" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(t.env.log.fileChanges.allJournaled()).toHaveLength(1);
    // The retry finds the file restored: it records the restore, where running afresh would find the file changed.
    const again = await undo(client, sessionId, commandId);
    expect(again).toEqual({ receipt: expect.objectContaining({ status: "accepted" }), result: { changeId: expect.any(String), path: "a.txt", action: "restored" } });
    expect(eventsOf(t, sessionId, "files.undo-finished")).toEqual([again.result]);
  });

  it("recognises on restart a restore a stop cut after its rename, records it once, and answers the retry from that receipt", async () => {
    const renamed = stopHere();
    const { t, client, token, root, sessionId, dataDir } = await edited({ fileUndoHooks: { afterRename: renamed.hook } });
    const commandId = randomUUID();
    void undo(client, sessionId, commandId).catch(() => undefined);
    await renamed.reached;
    await t.close();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");

    const later = await start({ dataDir, clock: t.clock });
    const events = eventsOf(later, sessionId, "files.undo-finished");
    expect(events).toEqual([{ changeId: expect.any(String), path: "a.txt", action: "restored" }]);
    const retried = await undo(await later.client({ token }), sessionId, commandId);
    expect(retried).toEqual({ receipt: expect.objectContaining({ status: "accepted" }) });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(eventsOf(later, sessionId, "files.undo-finished")).toEqual(events);
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  it("drops on restart a restore a stop cut before its rename, so the retry restores once", async () => {
    const renaming = stopHere();
    const { t, client, token, root, sessionId, dataDir } = await edited({ fileUndoHooks: { beforeRename: renaming.hook } });
    const commandId = randomUUID();
    void undo(client, sessionId, commandId).catch(() => undefined);
    await renaming.reached;
    await t.close();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("b\n");

    const later = await start({ dataDir, clock: t.clock });
    expect(eventsOf(later, sessionId, "files.undo-finished")).toEqual([]);
    expect(readdirSync(root)).toEqual(["a.txt"]);
    const retried = await undo(await later.client({ token }), sessionId, commandId);
    expect(retried.result).toEqual({ changeId: expect.any(String), path: "a.txt", action: "restored" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
  });

  it("refuses on restart a cut restore whose file was edited meanwhile, and leaves the file and the change as they are", async () => {
    const renamed = stopHere();
    const { t, client, token, root, sessionId, dataDir } = await edited({ fileUndoHooks: { afterRename: renamed.hook } });
    const commandId = randomUUID();
    void undo(client, sessionId, commandId).catch(() => undefined);
    await renamed.reached;
    await t.close();
    writeFileSync(join(root, "a.txt"), "edited while it was down\n");

    const later = await start({ dataDir, clock: t.clock });
    const laterClient = await later.client({ token });
    const retried = await undo(laterClient, sessionId, commandId);
    expect(retried.receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "file_changed", path: "a.txt" } } });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited while it was down\n");
    expect(eventsOf(later, sessionId, "files.undo-finished")).toEqual([]);
    expect((await refusal(laterClient, sessionId)).data).toMatchObject({ reason: "file_changed", path: "a.txt" });
  });
});

