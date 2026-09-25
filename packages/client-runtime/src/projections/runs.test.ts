import { randomUUID } from "node:crypto";
import type { SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { scriptedEnvironments, listEvent, type ScriptedEnvironment } from "../../test/environments.js";
import { noticeEvent, summaryOf } from "../../test/events.js";
import { recorded } from "../../test/transcript.js";
import { flush } from "../testing/fake-wire.js";
import { MANUAL_CLOCK_START } from "../testing/in-memory-platform.js";
import { countdown, runStateOf } from "./runs.js";

/**
 * `projections.runs` (docs/specs/client-runtime.md, "Projections"): each
 * session's run state, and the parked asks of every enabled environment in
 * one list with a TTL countdown on each environment's own clock. The pure
 * rules first, then a runtime on two scripted environments.
 */

const at = (ms: number) => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();
const activity = (state: SessionSummary["activity"]["state"]) => ({ state, since: at(0) });

describe("a session's run state", () => {
  const summary = (fields: Partial<SessionSummary> = {}): SessionSummary => ({ ...summaryOf(randomUUID()), ...fields });

  it("follows the summary's activity, parked while a prompt waits", () => {
    expect(runStateOf({ summary: summary(), starting: false, live: undefined, lastEnd: undefined })).toEqual({ state: "idle", runId: null, since: null });
    expect(runStateOf({ summary: summary({ activity: activity("starting") }), starting: false, live: undefined, lastEnd: undefined })).toMatchObject({ state: "starting" });
    expect(runStateOf({ summary: summary({ activity: activity("running") }), starting: false, live: { runId: "r-1", at: at(1) }, lastEnd: undefined })).toEqual({
      state: "running",
      runId: "r-1",
      since: at(0),
    });
    expect(runStateOf({ summary: summary({ activity: activity("parked"), parkedPromptCount: 1 }), starting: false, live: { runId: "r-1", at: at(1) }, lastEnd: undefined })).toMatchObject({
      state: "parked",
      runId: "r-1",
    });
  });

  it("is starting while a run command waits for its receipt, and says how the last run ended once idle", () => {
    expect(runStateOf({ summary: summary(), starting: true, live: undefined, lastEnd: { runId: "r-1", reason: "completed", cause: null, at: at(5) } })).toMatchObject({
      state: "starting",
      runId: null,
    });
    expect(runStateOf({ summary: summary(), starting: false, live: undefined, lastEnd: { runId: "r-1", reason: "interrupted", cause: "user", at: at(5) } })).toEqual({
      state: "interrupted",
      runId: "r-1",
      since: at(5),
    });
    expect(runStateOf({ summary: summary(), starting: false, live: undefined, lastEnd: { runId: "r-1", reason: "error", cause: null, at: at(5) } })).toMatchObject({ state: "ended" });
    // A send during a live run is a queued message, not a start.
    expect(runStateOf({ summary: summary({ activity: activity("running") }), starting: true, live: undefined, lastEnd: undefined })).toMatchObject({ state: "running" });
  });
});

describe("a TTL countdown", () => {
  it("counts down to the expiry on the environment's clock, never below zero, and there is none without an expiry", () => {
    expect(countdown(at(300_000), new Date(at(0)))).toEqual({ expiresAt: at(300_000), remainingMs: 300_000 });
    expect(countdown(at(300_000), new Date(at(301_000)))).toEqual({ expiresAt: at(300_000), remainingMs: 0 });
    expect(countdown(null, new Date(at(0)))).toBeNull();
  });
});

// A runtime on two scripted environments.

/** A parked prompt as `permissions.prompts.list` lists it. */
const listed = (sessionId: string, promptId: string, ttlExpiresAt: string | null, sequence = 3) => ({
  sessionId,
  promptId,
  sequence,
  openedAt: at(0),
  prompt: recorded("prompt.opened", 0, { promptId, toolCallId: promptId, ttlExpiresAt, summary: `Bash: ${promptId}` }),
});

/** Two environments, the first `skewMs` ahead of this client's clock, each listing the parked prompts the test puts in `prompts`. */
const twoEnvironments = async (skewMs = 0) => {
  const prompts: { prompts: unknown[] }[] = [{ prompts: [] }, { prompts: [] }];
  const made = await scriptedEnvironments({ onCleanup: onTestFinished,
    environments: [
      { name: "desk", skewMs, title: "Invoices" },
      { name: "laptop", title: "Receipts" },
    ],
  });
  made.environments.forEach(({ wire }, index) => wire.answer("permissions.prompts.list", () => ({ result: prompts[index] as { prompts: unknown[] } })));
  return { ...made, prompts };
};

describe("the parked asks", () => {
  it("gather every environment's parked prompts into one list, each counting down on its own environment's clock", async () => {
    // The first environment's clock is ten minutes ahead: its prompt expires five minutes from its own now.
    const tenMinutes = 10 * 60_000;
    const { clock, runtime, environments, prompts } = await twoEnvironments(tenMinutes);
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    prompts[0]!.prompts = [listed(desk.sessionId, "toolu_1", at(tenMinutes + 5 * 60_000))];
    prompts[1]!.prompts = [listed(laptop.sessionId, "toolu_2", null)];

    const stop = runtime.projections.runs.subscribe(() => undefined);
    onTestFinished(stop);
    await flush();
    expect(runtime.projections.runs.read().parkedAsks).toEqual([
      expect.objectContaining({
        environmentId: desk.wire.environmentId,
        sessionId: desk.sessionId,
        title: "Invoices",
        promptId: "toolu_1",
        kind: "permission",
        summary: "Bash: toolu_1",
        ttl: { expiresAt: at(tenMinutes + 5 * 60_000), remainingMs: 5 * 60_000 },
      }),
      expect.objectContaining({ environmentId: laptop.wire.environmentId, sessionId: laptop.sessionId, title: "Receipts", promptId: "toolu_2", ttl: null }),
    ]);

    clock.advance(1000);
    expect(runtime.projections.runs.read().parkedAsks[0]?.ttl).toEqual({ expiresAt: at(tenMinutes + 5 * 60_000), remainingMs: 5 * 60_000 - 1000 });
  });

  it("take a prompt parked since the list was read at once, and let an entry go when its prompt.answered arrives", async () => {
    const { runtime, environments, prompts } = await twoEnvironments();
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    prompts[0]!.prompts = [listed(desk.sessionId, "toolu_1", null)];
    const stop = runtime.projections.runs.subscribe(() => undefined);
    onTestFinished(stop);
    await flush();
    expect(runtime.projections.runs.read().parkedAsks.map((ask) => ask.promptId)).toEqual(["toolu_1"]);

    // A prompt opens on the laptop, and its list carries the event before any list of prompts is read again.
    laptop.list.event(listEvent(2, laptop.sessionId, "prompt.opened", recorded("prompt.opened", 1, { promptId: "toolu_9" }), { parkedPromptCount: 1 }));
    await flush();
    expect(runtime.projections.runs.read().parkedAsks.map((ask) => [ask.environmentId, ask.promptId, ask.kind])).toEqual([
      [desk.wire.environmentId, "toolu_1", "permission"],
      [laptop.wire.environmentId, "toolu_9", "question"],
    ]);

    // The desk's prompt is answered: it leaves the list on its prompt.answered, while the list of prompts still holds it.
    desk.list.event(listEvent(2, desk.sessionId, "prompt.answered", recorded("prompt.answered", 0, { promptId: "toolu_1" }), { parkedPromptCount: 0 }));
    await flush();
    expect(runtime.projections.runs.read().parkedAsks.map((ask) => ask.promptId)).toEqual(["toolu_9"]);

    // The laptop's is resolved: its notice says so, and the entry leaves on it too.
    laptop.notices.event(
      noticeEvent(1, laptop.wire.environmentId, "prompt.resolved", { sessionId: laptop.sessionId, runId: recorded("prompt.opened")["runId"], promptId: "toolu_9", decision: "deny", decidedBy: { auto: "ttl" } }),
    );
    await flush();
    expect(runtime.projections.runs.read().parkedAsks).toEqual([]);
  });

  it("leave out a disabled environment's", async () => {
    const { runtime, environments, prompts } = await twoEnvironments();
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    prompts[0]!.prompts = [listed(desk.sessionId, "toolu_1", null)];
    prompts[1]!.prompts = [listed(laptop.sessionId, "toolu_2", null)];
    const stop = runtime.projections.runs.subscribe(() => undefined);
    onTestFinished(stop);
    await flush();
    await runtime.connections.setEnabled(laptop.wire.environmentId, false);
    expect(runtime.projections.runs.read().parkedAsks.map((ask) => ask.promptId)).toEqual(["toolu_1"]);
  });
});

describe("the run states", () => {
  it("move from idle through starting, running and parked to interrupted as the commands and the list's events go", async () => {
    const { runtime, environments } = await twoEnvironments();
    const [desk] = environments as [ScriptedEnvironment];
    const env = desk.wire.environmentId;
    const state = () => runtime.projections.runs.read().sessions.get(env)?.get(desk.sessionId)?.state;
    const stop = runtime.projections.runs.subscribe(() => undefined);
    onTestFinished(stop);
    expect(state()).toBe("idle");

    // runs.start is on its way: no receipt yet.
    const runId = recorded("run.started")["runId"] as string;
    let receipt!: () => void;
    const answered = new Promise<void>((resolve) => (receipt = resolve));
    desk.wire.answer("runs.start", async () => {
      await answered;
      return { result: { receipt: { status: "accepted", sequence: 2, changed: true }, result: { runId, messageId: recorded("message.sent")["messageId"] } } };
    });
    const dispatched = runtime.commands.dispatch(env, "runs.start", { sessionId: desk.sessionId, text: "Fix the receipts" });
    await flush();
    expect(state()).toBe("starting");

    desk.list.event(listEvent(2, desk.sessionId, "run.started", recorded("run.started"), { activity: { state: "running", since: at(2000) } }));
    receipt();
    expect(await dispatched).toMatchObject({ ok: true });
    await flush();
    expect(runtime.projections.runs.read().sessions.get(env)?.get(desk.sessionId)).toEqual({ environmentId: env, sessionId: desk.sessionId, state: "running", runId, since: at(2000) });

    desk.list.event(listEvent(3, desk.sessionId, "prompt.opened", recorded("prompt.opened"), { activity: { state: "parked", since: at(3000) }, parkedPromptCount: 1 }));
    await flush();
    expect(state()).toBe("parked");

    desk.list.event(listEvent(4, desk.sessionId, "prompt.answered", recorded("prompt.answered"), { activity: { state: "running", since: at(4000) }, parkedPromptCount: 0 }));
    desk.list.event(listEvent(5, desk.sessionId, "run.ended", recorded("run.ended", 0, { reason: "interrupted", cause: "user" }), { activity: { state: "idle", since: at(5000) } }));
    await flush();
    expect(runtime.projections.runs.read().sessions.get(env)?.get(desk.sessionId)).toEqual({ environmentId: env, sessionId: desk.sessionId, state: "interrupted", runId, since: at(5000) });
  });

  it("are the same value while only a countdown ticks", async () => {
    const { clock, runtime, environments, prompts } = await twoEnvironments();
    const [desk] = environments as [ScriptedEnvironment];
    prompts[0]!.prompts = [listed(desk.sessionId, "toolu_1", at(5 * 60_000))];
    onTestFinished(runtime.projections.runs.subscribe(() => undefined));
    await flush();
    const before = runtime.projections.runs.read();

    clock.advance(1000);
    const after = runtime.projections.runs.read();
    expect(after.parkedAsks[0]?.ttl?.remainingMs).toBe(5 * 60_000 - 1000);
    expect(after.sessions).toBe(before.sessions);
  });
});
