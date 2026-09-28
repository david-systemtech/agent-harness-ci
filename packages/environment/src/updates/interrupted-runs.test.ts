import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DATABASE_FILE,
  OUTCOME_RECORD_FILE,
  SessionSnapshot,
  type MessageSentPayload,
  type OutcomeRecord,
  type PromptOpenedPayload,
  type RunPolicyResolvedPayload,
  type RunStartedPayload,
  type RunUpdateInterruptedPayload,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { serverArtefact } from "../../test/artefacts.js";
import { useCleanups } from "../../test/cleanups.js";
import { ask, fakeAdapter, say, signedInAs, type FakeAdapter, type Script } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher, type TestLauncherOptions } from "../../test/launcher.js";
import { create } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { EventEnvelope } from "../event-log/event-log.js";
import { DRAIN_CAP_MS } from "../serve/lifecycle.js";
import type { ActorRunRequest } from "../serve/start.js";

/**
 * The runs an update cut (launcher-update spec, "Interrupted runs and parked
 * prompts"; ADR 0007; #345) through the primary seam: the in-process
 * environment on one data directory started twice under the scripted
 * launcher channel, the first time as the version an update goes from, whose
 * drain cuts the runs, the second as the version the launcher starts after
 * the switch (or the same version, after a refused switch or a rollback),
 * whose settle marks each cut run and continues it where it can; the
 * scripted fake provider and the manual clock throughout. What is asserted
 * is what a client reads on the session's stream and what the fake provider
 * was handed.
 */

const { onCleanup, tempDir } = useCleanups();

/** The version the first start runs, and the one the update goes to. */
const RUNNING = "0.4.1";
const TARGET = "0.5.0";

/** The environment's name, which the continuation's message says. */
const NAME = "laptop";

/** The tail every continuation's message ends with. */
const CHECK = "while you were working and your turn was cut off. Check the current state before repeating anything that may already have finished, then continue.";

/** What the continuation of a run an update to TARGET cut reads first, once the update took. */
const CONTINUATION = `${NAME} was updated to ${TARGET} ${CHECK}`;

/** What it reads first when the update did not take, and the version it went from runs. */
const CONTINUATION_NOT_TAKEN = `${NAME} was restarted for an update to ${TARGET}, which did not take, ${CHECK}`;

/**
 * An environment on `dataDir` under a launcher, running RUNNING unless told
 * otherwise. A provider process idles two hours before it stops, so the
 * drain's cap, not the parked stop, ends a run parked on a prompt.
 */
const start = async (dataDir: string, options: TestEnvironmentOptions & { readonly launch?: TestLauncherOptions } = {}): Promise<TestEnvironment> => {
  const { launch, ...rest } = options;
  const t = await startTestEnvironment({
    dataDir,
    name: NAME,
    harnessVersion: RUNNING,
    launcher: testLauncher({ present: true, ...launch }),
    processIdleMinutes: () => 120,
    ...rest,
  });
  onCleanup(() => t.close());
  return t;
};

/** A run that links the provider session `providerSessionId` (none when null), says it is working, and works until it is stopped. */
const working =
  (providerSessionId: string | null = "provider-1"): Script =>
  async function* ({ signal }) {
    if (providerSessionId !== null) yield { type: "session.provider-linked", payload: { providerSessionId } };
    yield say("Working");
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  };

/** A run that links the provider session `providerSessionId`, then asks to run a command and parks until it is answered. */
const asking =
  (providerSessionId: string): Script =>
  async function* (controls) {
    yield { type: "session.provider-linked", payload: { providerSessionId } };
    yield* ask("permission", { toolName: "Bash", toolCallId: "toolu_1", input: { command: "rm -rf build" }, summary: "Claude wants to run rm -rf build" }, { promptId: "p-1" })(controls);
  };

const eventsOf = (t: TestEnvironment, sessionId: string): EventEnvelope[] => t.env.log.readStream({ kind: "session", id: sessionId });
const ofType = (t: TestEnvironment, sessionId: string, type: string): EventEnvelope[] => eventsOf(t, sessionId).filter((event) => event.type === type);

/** Starts a run on the session over the wire; resolves with its id. */
const startRun = async (client: WireClient, sessionId: string, text = "Fix the receipts"): Promise<string> => {
  const answer = await client.request("runs.start", { commandId: randomUUID(), sessionId, text });
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  return answer.result.runId;
};

/** Resolves once the run's provider has said it is working. */
const untilWorking = (t: TestEnvironment, sessionId: string) => vi.waitFor(() => expect(ofType(t, sessionId, "assistant.text").length).toBeGreaterThan(0));

/**
 * An environment on `dataDir` with a session (in `workspace` when given) and
 * a run on it that works, on the fake adapter playing `script` (preset:
 * provider-1 linked); with the client that started it.
 */
const withWorkingRun = async (
  dataDir: string,
  options: TestEnvironmentOptions & { readonly launch?: TestLauncherOptions; readonly script?: Script; readonly workspace?: string } = {},
) => {
  const { script, workspace, ...rest } = options;
  const t = await start(dataDir, { adapter: fakeAdapter({ script: script ?? working() }), ...rest });
  const client = await t.client();
  const { id } = await create(client, workspace === undefined ? {} : { workspace: { kind: "directory", path: workspace } });
  const cut = await startRun(client, id);
  await untilWorking(t, id);
  return { t, client, id, cut };
};

/**
 * Asks for an update to TARGET with Drain and update now, and lets the
 * drain's cap cut what still runs: resolves with the update id once the
 * environment has closed for the switch the launcher answered.
 */
const update = async (t: TestEnvironment, client: WireClient): Promise<string> => {
  const answer = await client.request("updates.apply", { commandId: randomUUID(), version: TARGET, artefactPath: serverArtefact(tempDir(), TARGET), when: "now" });
  const updateId = answer.result?.updateId;
  if (updateId === undefined) throw new Error(`updates.apply was not applied: ${JSON.stringify(answer.receipt)}`);
  t.clock.advance(DRAIN_CAP_MS);
  await t.env.drained;
  return updateId;
};

/** The `run.update-interrupted` events on the session's stream, with who appended each. */
const interruptions = (t: TestEnvironment, sessionId: string) =>
  ofType(t, sessionId, "run.update-interrupted").map((event) => ({ payload: event.payload as RunUpdateInterruptedPayload, actor: event.actor }));

/** What the marks on the session's stream say became of each run. */
const marksOf = (t: TestEnvironment, sessionId: string) =>
  interruptions(t, sessionId).map(({ payload: { outcome, reason, continuationRunId } }) => ({ outcome, reason, continuationRunId }));

/** The mark of a run that waits for the session's next message, for `reason`. */
const nextMessage = (reason: RunUpdateInterruptedPayload["reason"]) => ({ outcome: "next-message", reason, continuationRunId: null });

/** The run `runId`'s start, with who appended it. */
const startOf = (t: TestEnvironment, sessionId: string, runId: string) => {
  const event = ofType(t, sessionId, "run.started").find((candidate) => candidate.payload["runId"] === runId);
  return event && { payload: event.payload as RunStartedPayload, actor: event.actor };
};

const policyOf = (t: TestEnvironment, sessionId: string, runId: string): RunPolicyResolvedPayload | undefined =>
  ofType(t, sessionId, "run.policy.resolved")
    .map((event) => event.payload as RunPolicyResolvedPayload)
    .find((policy) => policy.runId === runId);

/** The continuation its mark names for the session's one cut run; throws when the run was not continued. */
const continuationOf = (t: TestEnvironment, sessionId: string): string => {
  const [mark] = interruptions(t, sessionId);
  if (mark?.payload.outcome !== "continued") throw new Error(`The cut run was not continued: ${JSON.stringify(mark)}`);
  return mark.payload.continuationRunId;
};

/** Resolves once the run `runId` has ended. */
const untilEnded = (t: TestEnvironment, sessionId: string, runId: string) =>
  vi.waitFor(() => expect(ofType(t, sessionId, "run.ended").some((event) => event.payload["runId"] === runId)).toBe(true));

describe("a run the update cut that its provider can resume", () => {
  it("is marked continued at the target's start, and one run as system:updates with the origin update resumes its provider session, reading the environment's message first", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir);
    const updateId = await update(t, client);

    const adapter: FakeAdapter = fakeAdapter();
    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter });
    expect(ofType(again, id, "run.ended")[0]?.payload).toMatchObject({ runId: cut, reason: "drained" });

    const continuation = continuationOf(again, id);
    expect(interruptions(again, id)).toEqual([
      { payload: { runId: cut, updateId, toVersion: TARGET, outcome: "continued", reason: null, continuationRunId: continuation }, actor: "system:updates" },
    ]);
    expect(startOf(again, id, continuation)).toMatchObject({ payload: { origin: "update", resumedFrom: "provider-1" }, actor: "system:updates" });
    // Under the cut run's policy and model.
    expect(policyOf(again, id, continuation)).toEqual({ ...policyOf(again, id, cut), runId: continuation });
    expect(startOf(again, id, continuation)?.payload.model).toBe(startOf(again, id, cut)?.payload.model);
    await untilEnded(again, id, continuation);
    // The message the environment sent, recorded as its, and the first the resumed provider session reads.
    const sent = ofType(again, id, "message.sent").find((event) => event.payload["runId"] === continuation);
    expect(sent && { text: (sent.payload as MessageSentPayload).text, actor: sent.actor }).toEqual({ text: CONTINUATION, actor: "system:updates" });
    expect(adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
    expect(adapter.lastRun().input.prompt.map((message) => message.text)).toEqual([CONTINUATION]);
    // Shown in the transcript a client opens: the continuation among the runs, its message among the items.
    const later = await again.client();
    const { subscription } = await later.subscribe("sessions.subscribeSession", { sessionId: id, afterSequence: again.env.log.head() + 1000 });
    const frame = await later.next((f) => f.type === "snapshot" && f.subscription === subscription);
    const snapshot = SessionSnapshot.parse(frame.type === "snapshot" && frame.payload);
    expect(snapshot.runs.map(({ runId, origin }) => ({ runId, origin }))).toEqual([
      { runId: cut, origin: "client" },
      { runId: continuation, origin: "update" },
    ]);
    expect(snapshot.items).toContainEqual(expect.objectContaining({ kind: "user-message", runId: continuation, text: CONTINUATION, delivery: "prompt" }));
  });

  it("is continued in the model and effort it ran in", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start(dataDir, { adapter: fakeAdapter({ script: working() }) });
    const client = await t.client();
    const { id } = await create(client);
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Fix the receipts", model: "sonnet", effort: "high" });
    await untilWorking(t, id);
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(startOf(again, id, continuationOf(again, id))?.payload).toMatchObject({ model: "sonnet", effort: "high" });
  });

  it("gets exactly one mark: a second start appends none and starts no second continuation", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id } = await withWorkingRun(dataDir);
    await update(t, client);
    const target = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });
    await untilEnded(target, id, continuationOf(target, id));
    await target.close();

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(marksOf(again, id)).toHaveLength(1);
    expect(ofType(again, id, "run.started")).toHaveLength(2);
    expect(again.adapter.runs).toEqual([]);
  });

  it("is the update's alone: a run a later drain cuts, after the next start, is not marked for it", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id } = await withWorkingRun(dataDir);
    await update(t, client);
    // The continuation works on until a person's drain cuts it in turn.
    const target = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter: fakeAdapter({ script: working() }) });
    const continuation = continuationOf(target, id);
    await untilWorking(target, id);
    const drained = target.env.drain("command");
    target.clock.advance(DRAIN_CAP_MS);
    await drained;

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(ofType(again, id, "run.ended").map((event) => event.payload["runId"])).toContain(continuation);
    expect(marksOf(again, id)).toHaveLength(1);
    expect(again.adapter.runs).toEqual([]);
  });

  it("is continued with the session's queued messages after the environment's message, as a run of the queue reads them", async () => {
    const dataDir = join(tempDir(), "data");
    // No provider queue: what the session is sent during the run waits in the environment's.
    const capabilities = { providerQueue: false, steering: false };
    const t = await start(dataDir, { adapter: fakeAdapter({ script: working(), capabilities }) });
    const client = await t.client();
    const { id } = await create(client);
    await startRun(client, id);
    await untilWorking(t, id);
    const queued: string[] = [];
    for (const text of ["Also the invoices", "And the ledger"]) {
      const sent = await client.request("runs.send", { commandId: randomUUID(), sessionId: id, text });
      expect(sent.result).toMatchObject({ delivery: "queued", heldBy: "environment" });
      queued.push(sent.result?.messageId as string);
    }
    await update(t, client);

    const adapter = fakeAdapter({ capabilities });
    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter });

    const continuation = continuationOf(again, id);
    expect(startOf(again, id, continuation)?.payload.queuedMessageIds).toEqual(queued);
    await untilEnded(again, id, continuation);
    expect(adapter.lastRun().input.prompt.map((message) => message.text)).toEqual([CONTINUATION, "Also the invoices", "And the ledger"]);
    expect(ofType(again, id, "message.delivered").map((event) => event.payload)).toEqual(queued.map((messageId) => ({ runId: continuation, messageId, delivery: "prompt" })));
  });

  it("of a routine's firing is continued like any other run, under the routine's unattended policy", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start(dataDir, { adapter: fakeAdapter({ script: working() }) });
    const client = await t.client();
    const { id } = await create(client);
    const routine: ActorRunRequest = {
      sessionId: id,
      text: "Reconcile the receipts",
      actor: { kind: "routine", name: "nightly-receipts", ceiling: "bypassPermissions", clientSessionId: null },
      actorId: "routine-nightly",
    };
    const { runId: cut } = t.env.startRun(routine);
    await untilWorking(t, id);
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    const continuation = continuationOf(again, id);
    expect(startOf(again, id, continuation)).toMatchObject({ payload: { origin: "update", resumedFrom: "provider-1" }, actor: "system:updates" });
    expect(policyOf(again, id, continuation)).toMatchObject({ actorKind: "routine", actorName: "nightly-receipts", attended: false, mode: { effective: policyOf(again, id, cut)?.mode.effective } });
    await untilEnded(again, id, continuation);
    // Unattended: the provider is handed the denylist to project, as every unattended run is.
    expect(again.adapter.lastRun().input.denylist).not.toBeNull();
  });
});

describe("a run the update cut while a prompt of its session was parked", () => {
  it("is marked waiting-on-prompt: no run starts, and the prompt is listed where it was", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir, { script: asking("provider-1") });
    await vi.waitFor(() => expect(ofType(t, id, "prompt.opened")).toHaveLength(1));
    const opened = ofType(t, id, "prompt.opened")[0] as EventEnvelope;
    const updateId = await update(t, client);

    const adapter = fakeAdapter();
    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter });

    expect(interruptions(again, id)).toEqual([
      { payload: { runId: cut, updateId, toVersion: TARGET, outcome: "waiting-on-prompt", reason: null, continuationRunId: null }, actor: "system:updates" },
    ]);
    expect(ofType(again, id, "run.started")).toHaveLength(1);
    expect(adapter.runs).toEqual([]);
    const later = await again.client();
    expect((await later.request("permissions.prompts.list", {})).prompts).toEqual([
      { sessionId: id, promptId: "p-1", sequence: opened.sequence, openedAt: opened.occurredAt, prompt: opened.payload as PromptOpenedPayload },
    ]);
  });

  it("resumes at once when a person answers that prompt, the answer the run's first message, as David decided on 2026-09-28", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir, { script: asking("provider-1") });
    await vi.waitFor(() => expect(ofType(t, id, "prompt.opened")).toHaveLength(1));
    await update(t, client);
    const adapter = fakeAdapter();
    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter });
    const later = await again.client();

    const answer = await later.request("permissions.prompts.answer", { commandId: randomUUID(), promptId: "p-1", decision: "allow" });

    expect(answer.result).toMatchObject({ delivery: "next-run" });
    await vi.waitFor(() => expect(ofType(again, id, "run.started")).toHaveLength(2));
    const resumed = ofType(again, id, "run.started")[1]?.payload as RunStartedPayload;
    // The session goes on as the run before it did, through the run of the queue after a restart (#131), reading the answer first.
    expect(resumed).toMatchObject({ resumedFrom: "provider-1", promptMessageId: null, queuedMessageIds: [] });
    expect(policyOf(again, id, resumed.runId)).toMatchObject({ actorKind: policyOf(again, id, cut)?.actorKind, mode: { effective: policyOf(again, id, cut)?.mode.effective } });
    await untilEnded(again, id, resumed.runId);
    const [told, ...rest] = adapter.lastRun().input.prompt;
    expect(rest).toEqual([]);
    expect(told?.text).toContain("rm -rf build");
  });
});

describe("a run the update cut that cannot go on by itself", () => {
  it("waits for the next message, no-resume, when its adapter cannot resume", async () => {
    const dataDir = join(tempDir(), "data");
    const capabilities = { resume: false };
    const { t, client, id } = await withWorkingRun(dataDir, { adapter: fakeAdapter({ script: working(), capabilities }) });
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter: fakeAdapter({ capabilities }) });

    expect(marksOf(again, id)).toEqual([nextMessage("no-resume")]);
    expect(ofType(again, id, "run.started")).toHaveLength(1);
  });

  it("waits for the next message, no-resume, when it linked no provider session", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id } = await withWorkingRun(dataDir, { script: working(null) });
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(marksOf(again, id)).toEqual([nextMessage("no-resume")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, account, when its account is signed out now", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id } = await withWorkingRun(dataDir);
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, adapter: fakeAdapter({ status: () => signedInAs(null) }) });

    expect(marksOf(again, id)).toEqual([nextMessage("account")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, account, when the session's account is another one now", async () => {
    const dataDir = join(tempDir(), "data");
    const accounts = [
      { id: "first", provider: "fake" },
      { id: "second", provider: "fake" },
    ];
    const { t, client, id } = await withWorkingRun(dataDir, { accounts });
    // The session names no account, so it runs on the default, which is another one from now on.
    await client.request("settings.update", { commandId: randomUUID(), values: { "accounts.defaultAccount": "second" } });
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET, accounts });

    expect(marksOf(again, id)).toEqual([nextMessage("account")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, mode, when the mode resolved now differs from the one it ran in", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir);
    await client.request("permissions.mode.set", { commandId: randomUUID(), sessionId: id, mode: "plan" });
    await update(t, client);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(policyOf(again, id, cut)?.mode.effective).toBe("acceptEdits");
    expect(marksOf(again, id)).toEqual([nextMessage("mode")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, workspace, when its workspace is gone", async () => {
    const dataDir = join(tempDir(), "data");
    const workspace = tempDir("agent-harness-workspace-");
    const { t, client, id } = await withWorkingRun(dataDir, { workspace });
    await update(t, client);
    rmSync(workspace, { recursive: true, force: true });

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(marksOf(again, id)).toEqual([nextMessage("workspace")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, deleted, when its session was deleted before a start could settle it, which a start whose settling fails leaves to the next", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id } = await withWorkingRun(dataDir);
    await update(t, client);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = await start(dataDir, {
      clock: t.clock,
      harnessVersion: TARGET,
      adapterSeams: {
        resolvePolicy: () => {
          throw new Error("The policy resolver is broken.");
        },
      },
    });
    expect(quiet.mock.calls.some(([line]) => /the next start settles it/.test(String(line)))).toBe(true);
    quiet.mockRestore();
    expect(marksOf(failing, id)).toEqual([]);
    const person = await failing.client();
    await person.request("sessions.delete", { commandId: randomUUID(), sessionId: id });
    await failing.close();

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(marksOf(again, id)).toEqual([nextMessage("deleted")]);
    expect(again.adapter.runs).toEqual([]);
  });

  it("waits for the next message, completions, and is never continued: its caller was answered 503 as the drain cut it", async () => {
    const dataDir = join(tempDir(), "data");
    const t = await start(dataDir, { adapter: fakeAdapter({ script: working() }) });
    const client = await t.client();
    const { token } = await t.pair({ kind: "program", scopes: ["read", "sessions:write", "runs:drive"], ceiling: "bypassPermissions", label: "hermes" });
    const answered = fetch(`http://${t.address.host}:${t.address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "claude-max/opus", messages: [{ role: "user", content: "File the receipt" }] }),
    });
    await vi.waitFor(() => expect(t.adapter.runs).toHaveLength(1));
    const id = t.adapter.lastRun().input.sessionId;
    await untilWorking(t, id);
    await update(t, client);
    // 503: the caller owns the retry. (The surface answers its open requests as the environment closes, before the run's end.)
    expect((await answered).status).toBe(503);

    const again = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });

    expect(marksOf(again, id)).toEqual([nextMessage("completions")]);
    expect(again.adapter.runs).toEqual([]);
  });
});

describe("the runs of an update that did not take", () => {
  it("are marked and continued at the next start of the same version after a refused switch, the message saying the update did not take", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir, { launch: { switch: () => ({ type: "refused", reason: "disk" }) } });
    const updateId = await update(t, client);

    const adapter = fakeAdapter();
    const again = await start(dataDir, { clock: t.clock, adapter });

    expect(interruptions(again, id).map((mark) => mark.payload)).toEqual([
      { runId: cut, updateId, toVersion: TARGET, outcome: "continued", reason: null, continuationRunId: continuationOf(again, id) },
    ]);
    await untilEnded(again, id, continuationOf(again, id));
    expect(adapter.lastRun().input.prompt.map((message) => message.text)).toEqual([CONTINUATION_NOT_TAKEN]);
  });

  it("are marked and continued again by the version a rollback past the commit restores, whose log never saw the first continuation", async () => {
    const dataDir = join(tempDir(), "data");
    const { t, client, id, cut } = await withWorkingRun(dataDir);
    const updateId = await update(t, client);
    // The launcher's snapshot of the database, taken once the version it went from has exited.
    const snapshot = tempDir("agent-harness-snapshot-");
    const databaseFiles = [DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`];
    const taken = databaseFiles.filter((file) => existsSync(join(dataDir, file)));
    for (const file of taken) copyFileSync(join(dataDir, file), join(snapshot, file));

    // The target commits and continues the run; then it crash-loops, and the launcher restores the snapshot.
    const target = await start(dataDir, { clock: t.clock, harnessVersion: TARGET });
    const first = continuationOf(target, id);
    await untilEnded(target, id, first);
    await target.close();
    for (const file of databaseFiles) rmSync(join(dataDir, file), { force: true });
    mkdirSync(dataDir, { recursive: true });
    for (const file of taken) copyFileSync(join(snapshot, file), join(dataDir, file));
    const record: OutcomeRecord = { updateId, fromVersion: RUNNING, toVersion: TARGET, stage: "crash-loop", reason: "exit" };
    writeFileSync(join(dataDir, OUTCOME_RECORD_FILE), `${JSON.stringify(record)}\n`);

    const adapter = fakeAdapter();
    const restored = await start(dataDir, { clock: t.clock, adapter });

    const again = continuationOf(restored, id);
    expect(again).not.toBe(first);
    expect(interruptions(restored, id).map((mark) => mark.payload)).toEqual([
      { runId: cut, updateId, toVersion: TARGET, outcome: "continued", reason: null, continuationRunId: again },
    ]);
    await untilEnded(restored, id, again);
    expect(adapter.lastRun().input.prompt.map((message) => message.text)).toEqual([CONTINUATION_NOT_TAKEN]);
  });
});
