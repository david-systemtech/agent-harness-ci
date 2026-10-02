import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { editFile, end, fakeAdapter, type Script, type ScriptControls } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { sessionIn } from "../../test/terminals.js";
import type { WireClient } from "../../test/wire-client.js";

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
  (...steps: ((controls: ScriptControls) => AsyncIterable<never> | AsyncGenerator<unknown>)[]): Script =>
  async function* (controls) {
    for (const step of steps) yield* step(controls) as AsyncGenerator<never>;
    yield end();
  };

/** The session's events of `type`, payloads only. */
const eventsOf = (t: TestEnvironment, sessionId: string, type: string) =>
  t.env.log.readStream({ kind: "session", id: sessionId }).flatMap((event) => (event.type === type ? [event.payload] : []));

const modeOf = (path: string): number => statSync(path).mode & 0o7777;

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
});
