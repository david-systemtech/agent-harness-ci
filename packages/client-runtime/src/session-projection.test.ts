import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { deltaShown, holdBackLastOf } from "../../environment/test/delta-hold-back.js";
import { end, gate, say, toldText, type Script } from "../../environment/test/fake-adapter.js";
import { workspace } from "../../environment/test/sessions.js";
import { until, useHarness } from "../test/harness.js";
import type { RunState } from "./projections/runs.js";
import type { SessionProjection } from "./projections/session.js";
import { fakeShell, inMemoryPlatform } from "./testing/in-memory-platform.js";

/**
 * `projections.session` and `projections.runs` end to end
 * (docs/specs/client-runtime.md, "Testing Decisions", the primary seam): a
 * real runtime paired with the in-process environment over a real
 * WebSocket, a run the scripted fake adapter plays (deltas, a tool call with
 * an update, a prompt a person answers through the outbox), and what the
 * projections show at each step.
 */

const harness = useHarness();

describe("a run the fake adapter plays", () => {
  it("reduces into the expected entries and run states on a real runtime", async () => {
    const streamed = gate();
    const script: Script = async function* ({ input, context }) {
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "Look" }] } };
      await streamed.opened;
      yield { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "ing" }] } };
      yield { type: "assistant.text", payload: { itemId: "i-1", text: "Looking.", aborted: false } };
      yield { type: "tool.started", payload: { toolCallId: "toolu_1", name: "Bash", input: { command: "ls" }, title: "ls", agentId: null, parentToolCallId: null } };
      yield { type: "tool.updated", payload: { toolCallId: "toolu_1", update: { progress: "half" } } };
      yield { type: "tool.ended", payload: { toolCallId: "toolu_1", status: "ok", output: "file.txt", durationMs: 3 } };
      const decision = await context.broker.request({
        sessionId: input.sessionId,
        runId: input.runId,
        kind: "permission",
        detail: { toolName: "Bash", toolCallId: "toolu_2", input: { command: "rm -rf build" }, summary: "Bash: rm -rf build" },
      });
      yield say(toldText(decision), "i-2");
      yield end();
    };
    const t = await harness.environment({ name: "desk" });
    holdBackLastOf(t, "Look");
    t.adapter.nextScripts.push(script);
    const shell = fakeShell();
    const runtime = harness.runtime(inMemoryPlatform({ shell }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const env = t.env.id;
    const sessionId = randomUUID();
    expect(await runtime.commands.dispatch(env, "sessions.create", { id: sessionId, workspace, title: "Receipts" })).toMatchObject({ ok: true });

    // What a transcript and a status line follow.
    const session = runtime.projections.session(env, sessionId);
    expect(runtime.projections.session(env, sessionId.toUpperCase())).toBe(session);
    // Read before anyone follows it: nothing held, nothing subscribed, and the same value each time.
    expect(session.read()).toMatchObject({ freshness: "empty", summary: null, items: [] });
    expect(session.read()).toBe(session.read());
    onTestFinished(session.subscribe(() => undefined));
    const states: RunState[] = [];
    const note = () => {
      const state = runtime.projections.runs.read().sessions.get(env)?.get(sessionId)?.state;
      if (state !== undefined && state !== states.at(-1)) states.push(state);
    };
    onTestFinished(runtime.projections.runs.subscribe(note));
    note();
    await until(() => session.read().freshness === "live", "the session to go live");
    expect(session.read()).toMatchObject({ summary: { title: "Receipts" }, items: [], runs: [], draft: null });

    const started = runtime.commands.dispatch(env, "runs.start", { sessionId, text: "Fix the receipts" });
    const view = (): SessionProjection => session.read();

    // The first delta is an open item, streaming.
    const reply = () => view().items.find((item) => item.kind === "assistant-text");
    await deltaShown(t, "Look", (prefix) => until(() => reply()?.text.startsWith(prefix) === true, `the first delta to show ${prefix}`));
    expect(await started).toMatchObject({ ok: true });
    expect(reply()).toMatchObject({ itemId: "i-1", text: "Look", streaming: true });
    expect(view().runs).toEqual([expect.objectContaining({ state: "running", reason: null })]);
    streamed.open();

    // Parked on the prompt: in the transcript where it was asked, in the session's parked prompts, and in the parked asks.
    await until(() => view().parkedPrompts.length === 1, "the prompt to park");
    await until(() => runtime.projections.runs.read().parkedAsks.length === 1, "the parked asks to list it");
    const [ask] = runtime.projections.runs.read().parkedAsks;
    expect(ask).toMatchObject({ environmentId: env, sessionId, title: "Receipts", kind: "permission", summary: "Bash: rm -rf build", ttl: { remainingMs: expect.any(Number) } });
    await until(() => states.at(-1) === "parked", "the run state to be parked");

    expect(await runtime.commands.dispatch(env, "permissions.prompts.answer", { promptId: ask!.promptId, decision: "allow" })).toMatchObject({ ok: true });
    await until(() => view().runs[0]?.state === "ended", "the run to end");
    await until(() => runtime.projections.runs.read().parkedAsks.length === 0, "the parked ask to leave");
    await until(() => states.at(-1) === "ended", "the run state to be ended");

    const { items, runs, parkedPrompts } = view();
    expect(items).toEqual([
      expect.objectContaining({ kind: "user-message", text: "Fix the receipts", delivery: "prompt" }),
      { kind: "assistant-text", sequence: expect.any(Number), runId: runs[0]!.runId, itemId: "i-1", text: "Looking.", aborted: false, streaming: false },
      expect.objectContaining({ kind: "tool-call", toolCallId: "toolu_1", name: "Bash", status: "ok", update: { progress: "half" }, output: "file.txt" }),
      expect.objectContaining({ kind: "prompt", promptId: ask!.promptId, state: "answered", answer: expect.objectContaining({ decision: "allow" }) }),
      expect.objectContaining({ kind: "assistant-text", itemId: "i-2", text: expect.stringContaining("Told"), streaming: false }),
    ]);
    // The prompt keeps the place it was asked at: after the tool call, before the answer's reply.
    expect(items[3]!.sequence).toBeGreaterThan(items[2]!.sequence);
    expect(runs).toEqual([expect.objectContaining({ state: "ended", reason: "completed", endedAt: expect.any(String) })]);
    expect(parkedPrompts).toEqual([]);
    expect(states).toEqual(["idle", "starting", "running", "parked", "running", "ended"]);
    // The runtime surfaced nothing through the shell on its own.
    expect(shell.calls).toEqual([]);
  });
});

describe("commands.rewind to a session's first message", () => {
  it("starts the new session in the same workspace through a session request, sharing its kind and path, with the message's text as its draft", async () => {
    const t = await harness.environment({ name: "desk" });
    const runtime = harness.runtime(inMemoryPlatform({ shell: fakeShell() }));
    await runtime.start();
    await runtime.connections.add({ link: (await t.createPairing()).link });
    const env = t.env.id;
    const sessionId = randomUUID();
    // A scratch workspace: sent back as a request it would be a scratch directory of the new session's own.
    expect(await runtime.commands.dispatch(env, "sessions.create", { id: sessionId, workspace: { kind: "scratch" }, title: "Receipts" })).toMatchObject({ ok: true });
    const session = runtime.projections.session(env, sessionId);
    onTestFinished(session.subscribe(() => undefined));
    expect(await runtime.commands.dispatch(env, "runs.start", { sessionId, text: "Fix the receipts" })).toMatchObject({ ok: true });
    await until(() => session.read().runs[0]?.state === "ended", "the run to end");
    const [first] = session.read().items;
    if (first?.kind !== "user-message") throw new Error("The session holds no user message.");

    const answer = await runtime.commands.rewind(env, sessionId, first.messageId);
    if (answer.kind !== "new-session") throw new Error(`The rewind answered ${JSON.stringify(answer)}.`);
    expect(answer.answer).toMatchObject({ ok: true });
    const [created] = t.env.log.readStream({ kind: "session", id: answer.sessionId });
    expect(created?.payload).toMatchObject({ workspace: { kind: "scratch", path: join(t.dataDir, "scratch", sessionId) }, repositoryIdentity: null });
    const row = () => runtime.projections.sessionList.read().rows.find((r) => r.summary.id === answer.sessionId);
    await until(() => row()?.summary.draft === "Fix the receipts", "the draft on the new session");
    expect(row()?.summary.workspace).toEqual({ kind: "scratch", path: join(t.dataDir, "scratch", sessionId) });
  });
});
