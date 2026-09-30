import { randomUUID } from "node:crypto";
import { ContractError, EMPTY_RUN_SKILL_SET, type AttachmentInput, type Mode, type PromptAnsweredPayload, type PromptOpenedPayload, type RunSkillSet } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { storeAccounts } from "../../test/accounts.js";
import { FAKE_AMBIENT_DIRECTORY, ask, end, fakeAdapter, gate, say, toldText, type FakeAdapter, type Gate } from "../../test/fake-adapter.js";
import type { ConfiguredAccount, HostAccounts } from "../accounts/account-service.js";
import { accountsProjector } from "../accounts/account-store.js";
import { openEventLog, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import { permissionsProjector } from "../permissions/permissions-store.js";
import type { RunActor } from "../permissions/resolver.js";
import { decideSend, decideStart, type StartCommand } from "../runs/run-decider.js";
import { environmentQueue } from "../runs/run-reads.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { PromptClosed, type AdapterEvent, type ProviderTurn, type RunContext, type TranscriptEvent } from "./contract.js";
import { createAdapterHost, type AdapterHost, type AdapterHostOptions, type StagedAttachments } from "./host.js";
import { capability } from "./capabilities.js";
import { createScopedAppend } from "./scoped-append.js";
import { composeInstructions } from "../instructions/composer.js";
import { presetPolicy, type AutoAnswerRequest } from "./seams.js";

/**
 * The adapter host at its own seam (claude-adapter spec, "The adapter
 * contract"): an in-memory log with the session-list and runs projectors,
 * the scripted fake adapter, and runs started as `runs.start` starts them.
 * What is asserted is what lands on the session's stream and what the
 * contract's surface says: one end per run on every exit path, every event
 * in order, a stream consumed once, and a call the descriptor does not
 * cover refused.
 */

let closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.reverse()) close();
  closers = [];
});

const created = {
  type: "session.created",
  payload: { title: null, tags: [], groupId: null, workspace: { kind: "directory", path: "/work" }, repositoryIdentity: null, account: null, model: null, mode: null },
};

interface Setup {
  readonly log: EventLog;
  readonly host: AdapterHost;
  readonly adapter: FakeAdapter;
  readonly sessionId: string;
}

/** What a test sets up beside the host's own options: the accounts the store holds (preset: one, `acct`, in the fake's own directory). */
interface SetupOptions extends Partial<Omit<AdapterHostOptions, "accounts">> {
  readonly accounts?: readonly ConfiguredAccount[];
}

const setup = async (adapter: FakeAdapter = fakeAdapter(), options: SetupOptions = {}, wrap: (log: EventLog) => EventLog = (log) => log): Promise<Setup> => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector, accountsProjector], clock: () => clock.now() });
  const { accounts: configured = [{ id: "acct", provider: adapter.descriptor.provider }], ...hostOptions } = options;
  // The account store, holding the configured accounts as a first start carries them over, each read once.
  const accounts = await storeAccounts({ log, clock, adapters: [adapter], accounts: configured });
  // No client session stands behind these runs (their actor names none), so no ceiling is read again.
  const host = createAdapterHost({ log: wrap(log), clock, adapters: [adapter], accounts, ceilingOf: () => undefined, ...hostOptions });
  closers.push(() => log.close(), () => host.close("disposed"), () => accounts.close());
  const sessionId = randomUUID();
  log.append({ kind: "session", id: sessionId }, [created], { actor: "system:test" });
  return { log, host, adapter, sessionId };
};

/** Starts a run as `runs.start` does, outside the wire: the facts, the decider, the append, then the launch. */
/** A client with no client session behind it (so no ceiling is read again), under `ceiling`. */
const clientActor = (ceiling: Mode = "bypassPermissions"): RunActor => ({ kind: "client", ceiling, clientSessionId: null });

const startRun = (
  t: Setup,
  text = "Go",
  command: Partial<Omit<StartCommand, "message">> & { attachments?: AttachmentInput[]; ceiling?: Mode } = {},
): string => {
  const facts = t.host.startFacts(t.sessionId, clientActor(command.ceiling));
  t.host.admit();
  const decision = decideStart(facts, { origin: "client", ...command, message: { messageId: randomUUID(), text, attachments: command.attachments ?? [] } });
  if (decision.rejected !== undefined) throw new Error(decision.rejected.message);
  t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: decision.run.runId });
  t.host.launch(decision.run);
  return decision.run.runId;
};

/** Sends the session a message during its live run, as `runs.send` does; resolves with its id. */
const sendDuring = (t: Setup, text: string, ceiling: Mode = "bypassPermissions"): string => {
  const decision = decideSend(t.host.startFacts(t.sessionId, clientActor(ceiling)), { messageId: randomUUID(), text, attachments: [] });
  if (decision.rejected !== undefined || decision.queued === undefined) throw new Error("The message was not queued.");
  t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: decision.result.runId });
  t.host.queue(decision.queued);
  return decision.result.messageId;
};

/** The session's events after its creation. */
const eventsOf = (t: Setup): EventEnvelope[] => t.log.readStream({ kind: "session", id: t.sessionId }).filter((event) => event.type !== "session.created");

const endsOf = (t: Setup, runId: string): EventEnvelope[] => eventsOf(t).filter((event) => event.type === "run.ended" && event.payload["runId"] === runId);

/** The prompts the session's runs asked, as their `prompt.opened` recorded them. */
const openedOf = (t: Setup): PromptOpenedPayload[] => eventsOf(t).filter((event) => event.type === "prompt.opened").map((event) => event.payload as PromptOpenedPayload);

/** The prompts' answers, as their `prompt.answered` recorded them. */
const answeredOf = (t: Setup): PromptAnsweredPayload[] => eventsOf(t).filter((event) => event.type === "prompt.answered").map((event) => event.payload as PromptAnsweredPayload);

/** Resolves once the run has its end on the stream. */
const untilEnded = (t: Setup, runId: string) => vi.waitFor(() => expect(endsOf(t, runId)).toHaveLength(1));

/** Resolves once the adapter has been asked for `count` runs: a run's launch composes its instructions first (#493). */
const reached = (t: Setup, count: number) => vi.waitFor(() => expect(t.adapter.runs).toHaveLength(count));

/** Lets pending promise callbacks and a few timer turns run, so an event the host would wrongly append has had its chance. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a run's event stream", () => {
  it("is appended losslessly and in order, between run.started and one run.ended, each event stamped with the run's id", async () => {
    const replies: AdapterEvent[] = [
      { type: "session.provider-linked", payload: { providerSessionId: "provider-1" } },
      { type: "assistant.delta", payload: { itemId: "i-1", fragments: [{ kind: "text", text: "Hel" }] } },
      say("Hello.", "i-1"),
      { type: "tool.started", payload: { toolCallId: "t-1", name: "Bash", input: { command: "ls" }, title: null, agentId: null, parentToolCallId: null } },
      { type: "tool.updated", payload: { toolCallId: "t-1", update: { progress: "half" } } },
      { type: "tool.ended", payload: { toolCallId: "t-1", status: "ok", output: "file.txt", durationMs: 3 } },
      { type: "usage.reported", payload: { models: [{ model: "opus", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, contextWindow: null }] } },
      end("completed", { resultText: "Hello.", turnCount: 1 }),
    ];
    const t = await setup(fakeAdapter({ script: () => replies }));
    const runId = startRun(t);
    await untilEnded(t, runId);

    const events = eventsOf(t);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "message.sent",
      // The host's, once the run's instructions are composed and before its adapter is asked for it (#493).
      "run.instructions.composed",
      "session.provider-linked",
      "assistant.delta",
      "assistant.text",
      "tool.started",
      "tool.updated",
      "tool.ended",
      // The call nobody was asked about ended ok: the mode let it through, and the host says so beside its end (#131).
      "tool.decision",
      "usage.reported",
      "run.ended",
    ]);
    for (const event of events) {
      expect(event.payload["runId"], event.type).toBe(runId);
      expect(event.correlationId, event.type).toBe(runId);
    }
    expect(events[3]?.actor).toBe("system:adapter-host");
    const reported = events.slice(4, -1);
    expect(reported.filter((event) => event.type !== "tool.decision").map((event) => event.actor)).toEqual(Array(7).fill("adapter:fake"));
    expect(reported.find((event) => event.type === "tool.decision")).toMatchObject({ actor: "system:adapter-host", payload: { toolCallId: "t-1", decision: "allowed", decidedBy: "mode" } });
    expect(events.at(-1)).toMatchObject({ actor: "adapter:fake", payload: { reason: "completed", resultText: "Hello.", turnCount: 1, error: null } });
    expect(t.adapter.lastRun()).toMatchObject({ iterations: 1, released: true, disposed: false });
  });

  it("is consumed once: the host iterates it a single time", async () => {
    const t = await setup();
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(t.adapter.lastRun().iterations).toBe(1);
  });

  it("hands the run its resolved input: account, model, the mode and ceiling its policy resolved, composed instructions, tool servers and the prompt", async () => {
    const toolServers = vi.fn(() => [{ name: "memory", config: {} }]);
    const t = await setup(fakeAdapter(), {
      toolServers,
      instructions: composeInstructions({
        orientation: () => ({ text: "You are on SYSTEM-SERVER.", unreadRegistries: [] }),
        session: () => [{ id: "session", version: null, title: "Instructions for this session", text: "Be brief." }],
      }),
      // The policy seam, here one that clamps every run to acceptEdits, whatever the actor's ceiling.
      resolvePolicy: (request) => presetPolicy({ ...request, actor: { ...request.actor, ceiling: "acceptEdits" } }),
    });
    const runId = startRun(t, "Fix it", { model: "sonnet", effort: "high", mode: "bypassPermissions" });
    await untilEnded(t, runId);
    const { input } = t.adapter.lastRun();
    expect(input).toMatchObject({
      sessionId: t.sessionId,
      runId,
      account: { id: "acct", directory: FAKE_AMBIENT_DIRECTORY },
      model: "sonnet",
      effort: "high",
      mode: "acceptEdits",
      ceiling: "acceptEdits",
      instructions: "You are on SYSTEM-SERVER.\n\nBe brief.",
      target: { kind: "fresh" },
      toolServers: [{ name: "memory", config: {} }],
      trusted: false,
      prompt: [{ text: "Fix it", attachments: [] }],
    });
    // A run no completions request started declares no tools for a caller to run (#139).
    expect(toolServers).toHaveBeenCalledWith({ sessionId: t.sessionId, runId, accountId: "acct", workspace: { kind: "directory", path: "/work" }, clientTools: [] });
    expect(eventsOf(t)[0]?.payload).toMatchObject({ mode: { requested: "bypassPermissions", effective: "acceptEdits", clamped: true } });
    expect(eventsOf(t)[1]).toMatchObject({ type: "run.policy.resolved", payload: { runId, mode: { effective: "acceptEdits", ceiling: "acceptEdits", clampReason: "ceiling" } } });
  });

  it("resumes the provider's session a run linked, on the next run, when the adapter can resume", async () => {
    const t = await setup(fakeAdapter({ script: () => [{ type: "session.provider-linked", payload: { providerSessionId: "provider-1" } }, end()] }));
    await untilEnded(t, startRun(t));
    await untilEnded(t, startRun(t));
    expect(t.adapter.lastRun().input.target).toEqual({ kind: "resume", providerSessionId: "provider-1" });
  });
});

describe("the run's skill set (#495)", () => {
  /** A set under `fingerprint`: its generation, a linked `tdd`, a trusted repository's native `release`, and its native `triage` switched off. */
  const setOf = (fingerprint: string): RunSkillSet => ({
    generation: `/data/skills/generations/${fingerprint}`,
    fingerprint,
    members: [
      { name: "tdd", origin: null, invocation: "model+slash", native: false },
      { name: "release", origin: null, invocation: "slash-only", native: true },
    ],
    hiddenNativeNames: ["triage"],
  });
  const workspace = { kind: "directory", path: "/work" } as const;

  it("hands every run the set the seam resolves for its session, account, workspace and trust and its adapter's native roots, and the empty set while nothing resolves one", async () => {
    const skillSet = vi.fn(async () => setOf("3f9a"));
    const trusted = { key: { kind: "directory", value: "/work" }, decision: "trusted" } as const;
    const t = await setup(fakeAdapter({ capabilities: { nativeSkillRoots: [".agents/skills"] } }), { skillSet, trust: () => trusted });
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(t.adapter.lastRun().input).toMatchObject({ skillSet: setOf("3f9a"), trusted: true });
    expect(skillSet).toHaveBeenCalledWith({ sessionId: t.sessionId, accountId: "acct", workspace, trust: trusted, nativeRoots: [".agents/skills"] });

    const bare = await setup();
    await untilEnded(bare, startRun(bare));
    expect(bare.adapter.lastRun().input.skillSet).toEqual(EMPTY_RUN_SKILL_SET);
  });

  it("reaches the session's next run with a changed fingerprint on a fresh process, and serves an unchanged one on the kept process", async () => {
    const fingerprints = ["3f9a", "3f9a", "7c1e"];
    const t = await setup(fakeAdapter(), { skillSet: async () => setOf(fingerprints.shift() ?? "none") });
    for (let run = 0; run < 3; run += 1) await untilEnded(t, startRun(t));
    expect(t.adapter.runs.map((run) => run.input.skillSet.fingerprint)).toEqual(["3f9a", "3f9a", "7c1e"]);
    expect(t.adapter.processesOf(t.sessionId).map((process) => [process.fingerprint, process.runs])).toEqual([
      ["3f9a", 2],
      ["7c1e", 1],
    ]);
  });

  it("ends a run whose set cannot be resolved error, before its instructions are composed and with no provider process begun", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await setup(fakeAdapter(), { skillSet: async () => Promise.reject(new Error("the own directory is gone")) });
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(endsOf(t, runId)[0]?.payload).toMatchObject({ reason: "error", error: { message: "The run's skill set could not be resolved: the own directory is gone" } });
    expect(eventsOf(t).map((event) => event.type)).not.toContain("run.instructions.composed");
    expect(t.adapter.runs).toEqual([]);
    errors.mockRestore();
  });

  it("lists commands under the trust and the set it resolves for the account and workspace, and the fake answers from what it is handed", async () => {
    const skillSet = vi.fn(async () => setOf("3f9a"));
    const t = await setup(fakeAdapter({ commands: [{ name: "compact", description: "Compact the conversation." }] }), {
      skillSet,
      trust: (place) => ({ key: { kind: "directory", value: place.workspace.path }, decision: "trusted" }),
    });
    expect(await t.host.commands("acct", workspace)).toEqual([
      { name: "compact", description: "Compact the conversation." },
      { name: "agent-harness:tdd", description: "The skill set's tdd." },
      { name: "release", description: "The skill set's release." },
    ]);
    expect(t.adapter.commandListings).toEqual([{ account: expect.objectContaining({ id: "acct" }), workspace: "/work", scope: { trusted: true, skillSet: setOf("3f9a") } }]);
    // A listing has no session: the set is resolved for the account and workspace alone.
    expect(skillSet).toHaveBeenCalledWith({ sessionId: null, accountId: "acct", workspace, trust: { key: { kind: "directory", value: "/work" }, decision: "trusted" }, nativeRoots: [".claude/skills", ".claude/commands"] });

    const bare = await setup(fakeAdapter({ commands: [] }));
    await bare.host.commands("acct", workspace);
    expect(bare.adapter.commandListings.at(-1)?.scope).toEqual({ trusted: false, skillSet: EMPTY_RUN_SKILL_SET });
  });
});

describe("one end per run on every exit path", () => {
  const onlyEnd = async (t: Setup, runId: string) => {
    await untilEnded(t, runId);
    await settle();
    const ends = endsOf(t, runId);
    expect(ends).toHaveLength(1);
    return ends[0] as EventEnvelope;
  };

  it("records the adapter's own end once, and nothing it yields after", async () => {
    const t = await setup(fakeAdapter({ script: () => [say("One"), end(), say("After the end"), end("error")] }));
    const runId = startRun(t);
    expect((await onlyEnd(t, runId)).payload).toMatchObject({ reason: "completed" });
    expect(eventsOf(t).filter((event) => event.type === "assistant.text")).toHaveLength(1);
  });

  it("ends the run error when the adapter throws, keeping what it yielded before", async () => {
    const t = await setup(
      fakeAdapter({
        script: async function* () {
          yield say("Before");
          throw new Error("The provider went away.");
        },
      }),
    );
    const runId = startRun(t);
    const ended = await onlyEnd(t, runId);
    expect(ended).toMatchObject({ actor: "system:adapter-host", payload: { reason: "error", error: { message: "The provider went away.", code: null } } });
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "run.instructions.composed", "assistant.text", "run.ended"]);
  });

  it("ends the run error when its stream stops without an end", async () => {
    const t = await setup(fakeAdapter({ script: () => [say("Then nothing")] }));
    const runId = startRun(t);
    expect((await onlyEnd(t, runId)).payload).toMatchObject({ reason: "error", error: { code: "no_end" } });
  });

  it("ends the run error when the adapter cannot create it", async () => {
    const adapter = fakeAdapter();
    const t = await setup({
      ...adapter,
      createRun: () => {
        throw new Error("No process could be started.");
      },
    } as FakeAdapter);
    const runId = startRun(t);
    expect((await onlyEnd(t, runId)).payload).toMatchObject({ reason: "error", error: { message: "No process could be started." } });
    expect(t.host.activeRuns()).toEqual([]);
  });

  it("ends the run error when the adapter reports an event outside its schema, and appends nothing of it", async () => {
    const bad = { type: "tool.ended", payload: { toolCallId: "t-1", status: "exploded", output: null, durationMs: null } } as unknown as TranscriptEvent;
    const t = await setup(fakeAdapter({ script: () => [say("Fine"), bad, say("Never")] }));
    const runId = startRun(t);
    expect((await onlyEnd(t, runId)).payload).toMatchObject({ reason: "error" });
    // Its stream may still be open, so the provider's turn is stopped, never kept for the next.
    expect(t.adapter.lastRun()).toMatchObject({ disposed: true, released: false });
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "run.instructions.composed", "assistant.text", "run.ended"]);
  });

  it("ends the run drained when the environment closes while draining mid-run, disposes it, and drops what it yields after", async () => {
    const held = gate();
    const t = await setup(
      fakeAdapter({
        script: async function* () {
          yield say("Working");
          await held.opened;
          yield say("Too late");
          yield end();
        },
      }),
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    t.host.close("drained");
    held.open();
    const ended = await onlyEnd(t, runId);
    expect(ended).toMatchObject({ actor: "system:adapter-host", payload: { reason: "drained", cause: null } });
    expect(t.adapter.lastRun()).toMatchObject({ disposed: true });
    expect(eventsOf(t).filter((event) => event.type === "assistant.text")).toHaveLength(1);
  });

  it("ends a deleted session's live run disposed, in the deletion's wake", async () => {
    const held = gate();
    const t = await setup(fakeAdapter({ script: async function* () { await held.opened; yield end(); } }));
    const runId = startRun(t);
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "session.deleted", payload: { deletedAt: "2026-09-24T00:00:00.000Z", purgeAt: "2026-10-24T00:00:00.000Z", deleteProviderTranscript: false } }], { actor: "system:test" });
    expect(endsOf(t, runId).map((event) => event.payload["reason"])).toEqual(["disposed"]);
    held.open();
    await settle();
    expect(endsOf(t, runId)).toHaveLength(1);
  });

  it("records each run in the run registry the lifecycle reads: starting, running, ended", async () => {
    const held = gate();
    const t = await setup(fakeAdapter({ script: async function* () { yield say("Working"); await held.opened; yield end(); } }));
    const runId = startRun(t);
    expect([...t.host.runs.runs()]).toMatchObject([{ id: runId, state: "starting" }]);
    expect(t.host.activeRuns()).toEqual([{ runId, sessionId: t.sessionId }]);
    await vi.waitFor(() => expect([...t.host.runs.runs()]).toMatchObject([{ id: runId, state: "running" }]));
    held.open();
    await untilEnded(t, runId);
    expect([...t.host.runs.runs()]).toMatchObject([{ id: runId, state: "ended" }]);
    expect(t.host.activeRuns()).toEqual([]);
  });
});

describe("an adapter that fails the host", () => {
  const heldRun = (held: ReturnType<typeof gate>) =>
    fakeAdapter({
      script: async function* () {
        yield say("Working");
        await held.opened;
        yield end();
      },
    });

  it("ends the run interrupted itself, and disposes it, when the adapter's interrupt fails", async () => {
    const held = gate();
    const adapter = heldRun(held);
    const create = adapter.createRun;
    const t = await setup({
      ...adapter,
      createRun: (input, context) => ({
        ...create(input, context),
        interrupt: () => Promise.reject(new Error("The provider did not answer.")),
      }),
    } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    t.host.interrupt(runId);
    await untilEnded(t, runId);
    expect(endsOf(t, runId)[0]).toMatchObject({ actor: "system:adapter-host", payload: { reason: "interrupted", cause: "user", error: null } });
    expect(t.adapter.lastRun().disposed).toBe(true);
    expect(t.host.activeRuns()).toEqual([]);
    held.open();
    await settle();
    expect(endsOf(t, runId)).toHaveLength(1);
  });

  it("holds a message in the environment's queue when the provider refuses it, and the next run reads it", async () => {
    const held = gate();
    const adapter = heldRun(held);
    const create = adapter.createRun;
    let runs = 0;
    const t = await setup({
      ...adapter,
      createRun: (input, context) => {
        const run = create(input, context);
        runs += 1;
        return runs === 1
          ? {
              ...run,
              send: () => {
                throw new Error("The provider's queue is full.");
              },
            }
          : run;
      },
    } as FakeAdapter);
    const first = startRun(t, "First");
    // Sent once the run is with its provider.
    await reached(t, 1);
    const messageId = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: first, messageId, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "bypassPermissions" } }], { actor: "client_session:test" });
    t.host.queue({ runId: first, heldBy: "provider", message: { messageId, text: "Also this", attachments: [] } });
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId: first, messageId } });
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const next = eventsOf(t).filter((event) => event.type === "run.started")[1];
    expect(next?.payload).toMatchObject({ origin: "client", promptMessageId: null, queuedMessageIds: [messageId] });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Also this"]);
  });
});

describe("a provider's held messages when the host ends the run (ADR 0022: nothing is lost)", () => {
  /** A provider queue that does not steer, whose first run works until `held` opens, then does as `after` says. */
  const holding = (held: ReturnType<typeof gate>, after: "complete" | "throw" | "wait") =>
    fakeAdapter({
      capabilities: { steering: false },
      script: async function* ({ adopted }) {
        if (adopted) {
          yield end();
          return;
        }
        yield say("Working");
        await held.opened;
        if (after === "throw") throw new Error("The provider went away.");
        if (after === "wait") await new Promise(() => undefined);
        yield end();
      },
    });

  const queuedIds = (t: Setup) => environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId).map((queued) => queued.messageId);

  /** The requeue of `messageId` by the host, just before the run's end. */
  const expectRequeuedBeforeEnd = (t: Setup, runId: string, messageId: string) => {
    const events = eventsOf(t);
    const ended = events.findIndex((event) => event.type === "run.ended" && event.payload["runId"] === runId);
    expect(events[ended - 1]).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId, messageId } });
  };

  it("takes them back when the run ends error", async () => {
    const held = gate();
    const t = await setup(holding(held, "throw"));
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    const messageId = sendDuring(t, "Also this");
    held.open();
    await untilEnded(t, runId);
    expectRequeuedBeforeEnd(t, runId, messageId);
    // A run that failed is followed by a run of the environment's queue, which reads it.
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(2));
    expect(eventsOf(t).filter((event) => event.type === "run.started")[1]?.payload).toMatchObject({ queuedMessageIds: [messageId] });
  });

  it("takes them back when the run ends disposed", async () => {
    const held = gate();
    const t = await setup(holding(held, "wait"));
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    const messageId = sendDuring(t, "Also this");
    t.host.close("disposed");
    expect(endsOf(t, runId)[0]?.payload).toMatchObject({ reason: "disposed" });
    expectRequeuedBeforeEnd(t, runId, messageId);
    expect(queuedIds(t)).toEqual([messageId]);
  });

  it("takes back every message an interrupt reports its provider no longer holds, each under the run it was sent during", async () => {
    const held = gate();
    const adapter = fakeAdapter({ capabilities: { steering: false }, script: async function* () { yield say("Working"); await held.opened; yield end(); } });
    const create = adapter.createRun;
    let reported: string[] = [];
    const t = await setup({ ...adapter, createRun: (input, context) => ({ ...create(input, context), interrupt: async () => ({ stillQueued: reported }) }) } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("assistant.text"));
    // A message an earlier run of the session left with the provider (a let-go process hands its queue to the next).
    const earlier = randomUUID();
    const carried = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: earlier, messageId: carried, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "bypassPermissions" } }], { actor: "client_session:test" });
    const own = sendDuring(t, "And this");
    reported = [carried, own, randomUUID()];
    t.host.interrupt(runId);
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "message.requeued")).toHaveLength(2));
    expect(eventsOf(t).filter((event) => event.type === "message.requeued").map((event) => event.payload)).toEqual([
      { runId: earlier, messageId: carried },
      { runId, messageId: own },
    ]);
    expect(environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId).map((message) => message.messageId)).toEqual([carried, own]);
    held.open();
  });

  it("takes a message back once, under its one run, however often a receipt names it, and ignores ids the provider queued itself", async () => {
    const held = gate();
    const adapter = fakeAdapter({ capabilities: { steering: false }, script: async function* () { yield say("Working"); await held.opened; yield end(); } });
    const create = adapter.createRun;
    let reported: string[] = [];
    const t = await setup({ ...adapter, createRun: (input, context) => ({ ...create(input, context), interrupt: async () => ({ stillQueued: reported }) }) } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("assistant.text"));
    const own = sendDuring(t, "And this");
    reported = [own, randomUUID(), own];
    t.host.interrupt(runId);
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "message.requeued")).toHaveLength(1));
    await settle();
    expect(eventsOf(t).filter((event) => event.type === "message.requeued").map((event) => event.payload)).toEqual([{ runId, messageId: own }]);
    held.open();
  });

  it("takes back once what an interrupt reports after the run's end already took back its own, and the rest still", async () => {
    const ended = gate();
    const receipt = gate();
    const adapter = fakeAdapter({
      capabilities: { steering: false },
      script: async function* () {
        yield say("Working");
        await ended.opened;
        yield end("interrupted", { cause: "user" });
      },
    });
    const create = adapter.createRun;
    let reported: string[] = [];
    const t = await setup({ ...adapter, createRun: (input, context) => ({ ...create(input, context), interrupt: async () => (await receipt.opened, { stillQueued: reported }) }) } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).map((event) => event.type)).toContain("assistant.text"));
    const earlier = randomUUID();
    const carried = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: earlier, messageId: carried, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "bypassPermissions" } }], { actor: "client_session:test" });
    const own = sendDuring(t, "And this");
    reported = [own, carried];
    t.host.interrupt(runId);
    // The interrupted end arrives before the receipt: the end takes back the run's own message.
    ended.open();
    await untilEnded(t, runId);
    receipt.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "message.requeued")).toHaveLength(2));
    await settle();
    expect(eventsOf(t).filter((event) => event.type === "message.requeued").map((event) => event.payload)).toEqual([
      { runId, messageId: own },
      { runId: earlier, messageId: carried },
    ]);
  });

  it("takes them back when the adapter's interrupt fails and the host ends the run", async () => {
    const held = gate();
    const adapter = holding(held, "wait");
    const create = adapter.createRun;
    const t = await setup({
      ...adapter,
      createRun: (input, context) => ({ ...create(input, context), interrupt: () => Promise.reject(new Error("No answer.")) }),
    } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    const messageId = sendDuring(t, "Also this");
    t.host.interrupt(runId);
    await untilEnded(t, runId);
    expectRequeuedBeforeEnd(t, runId, messageId);
    expect(queuedIds(t)).toEqual([messageId]);
  });

  it("takes back what a turn the provider opened was to read when a drain refuses to adopt it", async () => {
    const held = gate();
    const t = await setup(holding(held, "complete"));
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    const messageId = sendDuring(t, "Also this");
    t.host.runs.refuseNewRuns();
    held.open();
    await untilEnded(t, runId);
    await vi.waitFor(() => expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId, messageId } }));
    expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(t.adapter.runs.map((run) => [run.adopted, run.disposed])).toEqual([[false, false], [true, true]]);
    expect(environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId).map((queued) => queued.messageId)).toEqual([messageId]);
  });

  it("leaves them with the provider when its turn completed, for the turn it opens to read", async () => {
    const held = gate();
    const t = await setup(holding(held, "complete"));
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    sendDuring(t, "Also this");
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(eventsOf(t).filter((event) => event.type === "message.requeued")).toEqual([]);
    expect(endsOf(t, runId)).toHaveLength(1);
  });
});

describe("the host's own bookkeeping", () => {
  it("leaves no live run behind when the drain refuses a launch", async () => {
    const t = await setup();
    const facts = t.host.startFacts(t.sessionId, clientActor());
    const decision = decideStart(facts, { origin: "client", message: { messageId: randomUUID(), text: "Go", attachments: [] } });
    if (decision.rejected !== undefined) throw new Error(decision.rejected.message);
    t.host.runs.refuseNewRuns();
    expect(() => t.host.launch(decision.run)).toThrow(ContractError);
    expect(t.host.live(t.sessionId)).toBeNull();
    expect(t.host.activeRuns()).toEqual([]);
  });

  it("tries the end's append once more when it fails, and records one end", async () => {
    let failures = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const t = await setup(fakeAdapter(), {}, (log) => ({
      ...log,
      append: (stream, events, options) => {
        if (failures < 1 && events.some((event) => event.type === "run.ended")) {
          failures += 1;
          throw new Error("The database is busy.");
        }
        return log.append(stream, events, options);
      },
    }));
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(endsOf(t, runId)).toHaveLength(1);
    expect(t.host.unrecorded(runId)).toBe(false);
    errors.mockRestore();
  });

  it("ends a run whose end cannot be appended twice here all the same, says it is unrecorded, and logs it loudly", async () => {
    let failEnds = false;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const held = gate();
    const t = await setup(
      fakeAdapter({ script: async function* () { yield say("Working"); await held.opened; yield end(); } }),
      {},
      (log) => ({
        ...log,
        append: (stream, events, options) => {
          if (failEnds && events.some((event) => event.type === "run.ended")) throw new Error("The disk is full.");
          return log.append(stream, events, options);
        },
      }),
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    failEnds = true;
    held.open();
    await vi.waitFor(() => expect(t.adapter.lastRun().released).toBe(true));
    // The log has no end for it; the host does not wait on it: not live, ended in the registry, unrecorded.
    expect(endsOf(t, runId)).toEqual([]);
    expect(t.host.live(t.sessionId)).toBeNull();
    expect(t.host.liveRun(runId)).toBeNull();
    expect(t.host.unrecorded(runId)).toBe(true);
    expect([...t.host.runs.runs()]).toMatchObject([{ id: runId, state: "ended" }]);
    expect(errors.mock.calls.some(([message]) => String(message).startsWith(`THE END OF RUN ${runId}`))).toBe(true);
    // A new start is taken.
    failEnds = false;
    const next = startRun(t, "Again");
    await untilEnded(t, next);
    errors.mockRestore();
  });

  it("takes back a message handed on after its run had ended, which the end could not take back", async () => {
    const held = gate();
    const t = await setup(fakeAdapter({ capabilities: { steering: false }, script: async function* () { yield say("Working"); await held.opened; yield end(); } }));
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    // Decided while the run was live, committed and handed on after it ended.
    const decision = decideSend(t.host.startFacts(t.sessionId, clientActor()), { messageId: randomUUID(), text: "Late", attachments: [] });
    if (decision.rejected !== undefined || decision.queued === undefined) throw new Error("The message was not queued.");
    held.open();
    await untilEnded(t, runId);
    t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: runId });
    t.host.queue(decision.queued);
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId, messageId: decision.result.messageId } });
    expect(environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId).map((queued) => queued.messageId)).toEqual([decision.result.messageId]);
  });

  it("does not adopt a turn the provider opens for a session deleted since, and takes back what it was to read", async () => {
    let captured: RunContext | undefined;
    const t = await setup(
      fakeAdapter({
        script: ({ context }) => {
          captured = context;
          return [end()];
        },
      }),
    );
    const runId = startRun(t);
    await untilEnded(t, runId);
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "session.deleted", payload: { deletedAt: "2026-09-24T00:00:00.000Z", purgeAt: "2026-10-24T00:00:00.000Z", deleteProviderTranscript: false } }], { actor: "system:test" });
    let disposed = false;
    const turn: ProviderTurn = {
      messageIds: [],
      events: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: end(), done: false }) }) },
      send: () => undefined,
      interrupt: async () => ({ stillQueued: [] }),
      dispose: () => {
        disposed = true;
      },
      release: () => undefined,
    };
    const before = t.log.head();
    captured?.adopt(turn);
    expect(disposed).toBe(true);
    expect(t.log.head()).toBe(before);
    expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("tells an adopted turn its run id once the run is registered, so an ask it makes then parks the run", async () => {
    let captured: RunContext | undefined;
    const t = await setup(
      fakeAdapter({
        script: ({ context }) => {
          captured = context;
          return [end()];
        },
      }),
    );
    await untilEnded(t, startRun(t));
    let adoptedAs: string | undefined;
    const turn: ProviderTurn = {
      messageIds: [],
      // A turn that has not ended: it waits on its prompt.
      events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<AdapterEvent>>(() => undefined) }) },
      send: () => undefined,
      interrupt: async () => ({ stillQueued: [] }),
      dispose: () => undefined,
      release: () => undefined,
      onAdopted: (runId) => {
        adoptedAs = runId;
        // Asked at once, as a subagent's prompt turn does once it has its run id.
        void captured?.broker.request({ sessionId: t.sessionId, runId, kind: "permission", detail: {} });
      },
    };
    captured?.adopt(turn);
    // Recorded as the ask reached the host, under the adopted run.
    expect(openedOf(t).map((prompt) => prompt.runId)).toEqual([adoptedAs]);
    expect([...t.host.runs.runs()].find((run) => run.id === adoptedAs)?.state).toBe("parked");
    expect(t.host.processes.list()[0]).toMatchObject({ state: "parked", runId: adoptedAs });
  });

  it("never tells a turn a run id when its start cannot be recorded", async () => {
    let captured: RunContext | undefined;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failStart = false;
    const t = await setup(
      fakeAdapter({
        script: ({ context }) => {
          captured = context;
          return [end()];
        },
      }),
      {},
      (log) => ({
        ...log,
        append: (stream, events, options) => {
          if (failStart && events.some((event) => event.type === "run.started")) throw new Error("The database is busy.");
          return log.append(stream, events, options);
        },
      }),
    );
    await untilEnded(t, startRun(t));
    failStart = true;
    let told = false;
    let disposed = false;
    captured?.adopt({
      messageIds: [],
      events: { [Symbol.asyncIterator]: () => ({ next: async () => ({ value: end(), done: false }) }) },
      send: () => undefined,
      interrupt: async () => ({ stillQueued: [] }),
      dispose: () => void (disposed = true),
      release: () => undefined,
      onAdopted: () => void (told = true),
    });
    errors.mockRestore();
    expect(disposed).toBe(true);
    expect(told).toBe(false);
    // Nothing is left parked, and the process the let-go turn left in no known state is stopped through the pool.
    expect([...t.host.runs.runs()].some((run) => run.state === "parked")).toBe(false);
    await vi.waitFor(() => expect(t.host.processes.list()[0]).toMatchObject({ state: "stopped", stopReason: "failed" }));
    expect(t.adapter.processesOf(t.sessionId)[0]?.stopped).toBe(true);
  });

  it("never leaves a rejection unhandled when handling a provider's refusal fails too", async () => {
    const held = gate();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled: unknown[] = [];
    const guard = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", guard);
    try {
      const adapter = fakeAdapter({ capabilities: { steering: false }, script: async function* () { yield say("Working"); await held.opened; yield end(); } });
      const create = adapter.createRun;
      let failRequeue = true;
      const t = await setup(
        { ...adapter, createRun: (input, context) => ({ ...create(input, context), send: () => Promise.reject(new Error("The provider's queue is closed.")) }) } as FakeAdapter,
        {},
        (log) => ({
          ...log,
          append: (stream, events, options) => {
            if (failRequeue && events.some((event) => event.type === "message.requeued")) {
              failRequeue = false;
              throw new Error("The database is busy.");
            }
            return log.append(stream, events, options);
          },
        }),
      );
      const runId = startRun(t);
      await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
      sendDuring(t, "Also this");
      await settle();
      expect(unhandled).toEqual([]);
      expect(errors.mock.calls.some(([message]) => String(message).startsWith("Handling a failure failed as well"))).toBe(true);
      held.open();
      await untilEnded(t, runId);
    } finally {
      process.off("unhandledRejection", guard);
      errors.mockRestore();
    }
  });

  it("lets go of a turn whose adoption cannot be appended, and takes back what it was to read", async () => {
    const held = gate();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failAdoption = true;
    const t = await setup(
      fakeAdapter({
        capabilities: { steering: false },
        script: async function* ({ adopted }) {
          if (!adopted) {
            yield say("Working");
            await held.opened;
          }
          yield end();
        },
      }),
      {},
      (log) => ({
        ...log,
        append: (stream, events, options) => {
          if (failAdoption && events.some((event) => event.type === "run.started" && event.payload["origin"] === "provider")) {
            failAdoption = false;
            throw new Error("The database is busy.");
          }
          return log.append(stream, events, options);
        },
      }),
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect(eventsOf(t).some((event) => event.type === "assistant.text")).toBe(true));
    const messageId = sendDuring(t, "Also this");
    held.open();
    await untilEnded(t, runId);
    await vi.waitFor(() => expect(t.adapter.runs.map((run) => [run.adopted, run.disposed])).toEqual([[false, false], [true, true]]));
    expect(eventsOf(t).filter((event) => event.type === "run.started")).toHaveLength(1);
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", payload: { runId, messageId } });
    expect(environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId).map((queued) => queued.messageId)).toEqual([messageId]);
    errors.mockRestore();
  });

  it("requires the method's name to refuse an adapter that declares a flag without it", () => {
    const { descriptor } = fakeAdapter();
    // @ts-expect-error The method's name is required: a default would render a sentence with no method in it.
    expect(() => capability(descriptor, "planUsage", undefined, "read plan usage")).toThrow(ContractError);
    expect(() => capability(descriptor, "planUsage", undefined, "read plan usage", "usage")).toThrow("it declares planUsage but has no usage.");
  });

  it("names the missing method when an adapter declares a flag without it", async () => {
    const adapter = fakeAdapter();
    const t = await setup({ ...adapter, usage: undefined } as unknown as FakeAdapter);
    let thrown: unknown;
    try {
      await t.host.usage("acct");
    } catch (error) {
      thrown = error;
    }
    expect((thrown as ContractError).message).toBe("The Fake adapter cannot read plan usage: it declares planUsage but has no usage.");
    expect((thrown as ContractError).data).toMatchObject({ reason: "unsupported", capability: "planUsage" });
  });

  it("names no cause for an interrupted end the host did not ask for", async () => {
    const t = await setup(fakeAdapter({ script: () => [end("interrupted")] }));
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(endsOf(t, runId)[0]?.payload).toMatchObject({ reason: "interrupted", cause: null });
  });

  it("clamps a run of the environment's queue to the ceiling of every sender, not only the last run's starter", async () => {
    const held = gate();
    const t = await setup(
      fakeAdapter({
        capabilities: { providerQueue: false, steering: false },
        script: async function* ({ input }) {
          if (input.prompt[0]?.text === "First") await held.opened;
          yield end();
        },
      }),
    );
    // The session's mode is auto, so the run of the queue asks for it too (#129: a run's own mode is that run's alone).
    const mode = { requested: "auto", effective: "auto", ceiling: "bypassPermissions", clamped: false, clampReason: null };
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "session.mode.set", payload: { mode, live: null } }], { actor: "system:test" });
    const first = startRun(t, "First", { ceiling: "bypassPermissions" });
    sendDuring(t, "From a planner", "plan");
    held.open();
    await untilEnded(t, first);
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const [, next] = eventsOf(t).filter((event) => event.type === "run.started");
    expect(next?.payload).toMatchObject({ mode: { requested: "auto", effective: "plan", clamped: true } });
  });

  it("keys a queued message by its session: an event of another session naming its id leaves it queued", async () => {
    const t = await setup();
    const other = randomUUID();
    t.log.append({ kind: "session", id: other }, [created], { actor: "system:test" });
    const messageId = randomUUID();
    const runId = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId, messageId, text: "Mine", attachments: [], delivery: "queued", heldBy: "environment", ceiling: "plan" } }], { actor: "system:test" });
    t.log.append({ kind: "session", id: other }, [{ type: "message.delivered", payload: { runId, messageId, delivery: "prompt" } }], { actor: "system:test" });
    expect(environmentQueue({ all: (sql, ...params) => t.log.read(sql, ...params) }, t.sessionId)).toEqual([{ messageId, text: "Mine", ceiling: "plan" }]);
  });

  it("keeps a queued message's bytes through the session's deletion, for a restore, and drops them when it is purged", async () => {
    const held = gate();
    const staged = new Map<string, StagedAttachments>();
    const t = await setup(
      fakeAdapter({ capabilities: { providerQueue: false, steering: false }, script: async function* () { await held.opened; yield end(); } }),
      { stagedAttachments: staged },
    );
    const runId = startRun(t, "First");
    const decision = decideSend(t.host.startFacts(t.sessionId, clientActor()), {
      messageId: randomUUID(),
      text: "With a picture",
      attachments: [{ kind: "image", name: "a.png", mediaType: "image/png", data: Buffer.from("pixels").toString("base64") }],
    });
    if (decision.rejected !== undefined || decision.queued === undefined) throw new Error("The message was not queued.");
    t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: runId });
    t.host.queue(decision.queued);
    expect([...staged.values()].map((entry) => entry.sessionId)).toEqual([t.sessionId]);

    const stream = { kind: "session", id: t.sessionId } as const;
    t.log.append(stream, [{ type: "session.deleted", payload: { deletedAt: "2026-09-24T00:00:00.000Z", purgeAt: "2026-10-24T00:00:00.000Z", deleteProviderTranscript: false } }], { actor: "system:test" });
    expect(staged.size).toBe(1);
    t.log.append(stream, [{ type: "session.purged", payload: { providerTranscript: { outcome: "kept" } } }], { actor: "system:test" });
    expect(staged.size).toBe(0);
    held.open();
  });

  it("refuses a transcript delete as unsupported when the session's provider is not known here", async () => {
    const t = await setup(fakeAdapter({ deleteTranscript: true }), { accounts: [] });
    let thrown: unknown;
    try {
      t.host.transcripts.deleteTranscript?.(t.sessionId);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError).data).toMatchObject({ reason: "unsupported" });
    expect(t.adapter.deletedTranscripts).toEqual([]);
  });
});

describe("the transcript delete across providers", () => {
  it("hands the session's adapter only the owned accounts of its own provider, never another provider's directory", async () => {
    const clock = manualClock();
    const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector, accountsProjector], clock: () => clock.now() });
    const first = fakeAdapter({ deleteTranscript: true });
    const second = fakeAdapter({ provider: "other", deleteTranscript: true });
    const service = await storeAccounts({ log, clock, adapters: [first, second], accounts: [{ id: "a", provider: "fake" }, { id: "b", provider: "other" }] });
    // Both carried over as adopted; read as owned here, so the delete is handed them.
    const accounts: HostAccounts = {
      facts: (id) => {
        const facts = service.facts(id);
        return facts === null ? null : { ...facts, adopted: false };
      },
      defaultId: () => service.defaultId(),
      defaults: () => service.defaults(),
      providerOf: (id) => service.providerOf(id),
      crossCheck: (accountId, identity, runId) => service.crossCheck(accountId, identity, runId),
      recheck: (accountId) => service.recheck(accountId),
    };
    const host = createAdapterHost({ log, clock, adapters: [first, second], accounts, ceilingOf: () => undefined });
    closers.push(() => log.close(), () => host.close("disposed"), () => service.close());
    const sessionId = randomUUID();
    log.append({ kind: "session", id: sessionId }, [created], { actor: "system:test" });
    const t: Setup = { log, host, adapter: first, sessionId };
    await untilEnded(t, startRun(t));
    // A later run of the session on the other provider's account, as a changed default would give it.
    const started = eventsOf(t).find((event) => event.type === "run.started");
    const runId = randomUUID();
    clock.advance(1000);
    log.append({ kind: "session", id: sessionId }, [{ type: "run.started", payload: { ...started?.payload, runId, accountId: "b" } }], { actor: "system:test", correlationId: runId });

    expect(host.transcripts.deleteTranscript?.(sessionId)).toBeUndefined();
    expect(first.deletedTranscripts).toEqual([]);
    expect(second.deletedTranscriptAccounts).toEqual([[{ id: "b", directory: expect.any(String) }]]);
  });
});

describe("a call the descriptor does not cover", () => {
  const expectUnsupported = (thrown: unknown, capability: string) => {
    expect(thrown).toBeInstanceOf(ContractError);
    expect((thrown as ContractError).toWire()).toMatchObject({ code: "invalid_params", data: { reason: "unsupported", capability, provider: "fake" } });
  };
  const catching = async (work: () => unknown): Promise<unknown> => {
    try {
      await work();
    } catch (error) {
      return error;
    }
    throw new Error("The call was not refused.");
  };

  it("is refused invalid_params with reason unsupported, naming the missing flag", async () => {
    const t = await setup(fakeAdapter({ capabilities: { planUsage: false, commands: false, imageInput: false } }));
    expectUnsupported(await catching(() => t.host.usage("acct")), "planUsage");
    expectUnsupported(await catching(() => t.host.commands("acct", { kind: "directory", path: "/work" })), "commands");
    const image = { kind: "image" as const, name: "a.png", mediaType: "image/png", data: "" };
    const refused = await catching(() => startRun(t, "Look", { attachments: [image] }));
    expectUnsupported(refused, "imageInput");
    expect((refused as ContractError).data["issues"]).toMatchObject([{ path: ["attachments", 0, "kind"] }]);
    expect(eventsOf(t)).toEqual([]);
  });

  it("is answered when the flag covers it: plan usage carries the account's identity", async () => {
    const t = await setup();
    expect(await t.host.usage("acct")).toMatchObject({ identity: { provider: "fake", email: "acct@example.com", organisation: null } });
  });

  it("stops delegated work only on an adapter that declares subagents", async () => {
    const held = gate();
    const script = async function* () {
      await held.opened;
      yield end();
    };
    const t = await setup(fakeAdapter({ capabilities: { subagents: false }, script }));
    const runId = startRun(t);
    await reached(t, 1);
    expectUnsupported(await catching(() => t.host.stopTask(runId, "task-1")), "subagents");
    held.open();
  });
});

describe("a run composing its instructions (#493)", () => {
  /** A composer whose every composition waits for `held`, counting those begun and those answered. */
  const stalling = (held: Gate) => {
    const begun = { count: 0, answered: 0 };
    const instructions = composeInstructions({
      orientation: async () => {
        begun.count += 1;
        await held.opened;
        begun.answered += 1;
        return { text: "You are on SYSTEM-SERVER.", unreadRegistries: [] };
      },
    });
    return { begun, instructions };
  };

  it("holds a message sent to it in the environment's queue, no provider yet holding anything, and the run after it reads the message", async () => {
    const held = gate();
    const { instructions } = stalling(held);
    const t = await setup(fakeAdapter(), { instructions });
    const first = startRun(t, "First");
    const messageId = sendDuring(t, "Also this");
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId: first, messageId } });
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(t.adapter.runs.map((run) => run.input.prompt.map((message) => message.text))).toEqual([["First"], ["Also this"]]);
    expect(t.adapter.runs[0]?.sent).toEqual([]);
  });

  it("hands its adapter the mode set on it while it composed", async () => {
    const held = gate();
    const { begun, instructions } = stalling(held);
    const t = await setup(fakeAdapter(), { instructions });
    const runId = startRun(t, "Go", { mode: "acceptEdits" });
    await vi.waitFor(() => expect(begun.count).toBe(1));
    t.host.setMode(runId, "plan");
    held.open();
    await untilEnded(t, runId);
    expect(t.adapter.lastRun().input.mode).toBe("plan");
  });

  it("ends on an admin's stop of its session's process, interrupted by them, and nothing starts once its composition answers", async () => {
    const held = gate();
    const { begun, instructions } = stalling(held);
    const t = await setup(fakeAdapter(), { instructions });
    const runId = startRun(t, "Go");
    await vi.waitFor(() => expect(begun.count).toBe(1));
    t.host.processes.stop(t.sessionId, { actor: "client_session:admin", commandId: randomUUID() });
    await untilEnded(t, runId);
    expect(endsOf(t, runId)[0]).toMatchObject({ actor: "client_session:admin", payload: { reason: "interrupted", cause: "user" } });
    held.open();
    await vi.waitFor(() => expect(begun.answered).toBe(1));
    expect(t.adapter.runs).toHaveLength(0);
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "message.requeued", "run.ended"]);
  });

  it("ends on a read-now, interrupted by it with no provider process begun, and the run of the queue reads what it was launched with", async () => {
    const held = gate();
    const { begun, instructions } = stalling(held);
    const t = await setup(fakeAdapter(), { instructions });
    const first = startRun(t, "First");
    await vi.waitFor(() => expect(begun.count).toBe(1));
    t.host.readNow(t.sessionId, clientActor());
    await untilEnded(t, first);
    expect(endsOf(t, first)[0]?.payload).toMatchObject({ reason: "interrupted", cause: "read-now" });
    expect(t.host.processes.list()).toEqual([]);
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    expect(t.adapter.runs.map((run) => run.input.prompt.map((message) => message.text))).toEqual([["First"]]);
    expect(eventsOf(t).filter((event) => event.type === "run.instructions.composed").map((event) => event.payload["runId"])).not.toContain(first);
  });
});

describe("the seams", () => {
  it("answers a prompt at once through the automatic answers' seam (#131), recorded in the transaction that opens it, parking nothing", async () => {
    let decision: unknown;
    const asked: AutoAnswerRequest[] = [];
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input }) {
          decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: { toolName: "Bash" } });
          yield end();
        },
      }),
      { autoAnswer: (request) => (asked.push(request), { auto: "unattended", decision: { decision: "deny", message: "Nobody is present." } }) },
    );
    const runId = startRun(t);
    await untilEnded(t, runId);
    expect(decision).toEqual({ decision: "deny", message: "Nobody is present." });
    expect(asked).toEqual([{ kind: "permission", attended: true, mode: "acceptEdits" }]);
    const [opened, answered] = eventsOf(t).filter((event) => event.type.startsWith("prompt."));
    expect(answered).toMatchObject({
      type: "prompt.answered",
      actor: "system:adapter-host",
      payload: { runId, promptId: "p-1", decision: "deny", message: "Nobody is present.", decidedBy: { auto: "unattended" }, delivery: "live" },
    });
    expect(answered?.sequence).toBe((opened?.sequence ?? 0) + 1);
    // Never parked: the run registry never saw it wait.
    expect(t.host.processes.list()[0]).toMatchObject({ parkedSince: null });
  });

  it("validates the account, model and mode sessions.create is given against the accounts and their catalogues", async () => {
    const t = await setup();
    expect(t.host.validateSessionInput({ account: "acct", model: "opus", mode: "plan" })).toEqual({ issues: [] });
    expect(t.host.validateSessionInput({ account: null, model: null, mode: null })).toEqual({ issues: [] });
    expect(t.host.validateSessionInput({ account: "nobody", model: "opus", mode: null })).toMatchObject({ unavailable: { accountId: "nobody" } });
    expect(t.host.validateSessionInput({ account: "acct", model: "gpt", mode: "yolo" }).issues?.map((issue) => issue.path)).toEqual([["model"], ["mode"]]);
    expect(t.host.validateSessionInput({ account: null, model: "gpt", mode: null }).issues?.map((issue) => issue.path)).toEqual([["model"]]);
  });

  it("offers the purge a transcript delete only when an adapter declares it, synchronous and routed to the session's adapter", async () => {
    expect((await setup()).host.transcripts.deleteTranscript).toBeUndefined();
    const t = await setup(fakeAdapter({ deleteTranscript: true }));
    expect(t.host.transcripts.deleteTranscript?.(t.sessionId)).toBeUndefined();
    expect(t.host.transcripts.deleteTranscript?.(t.sessionId)).toBeUndefined();
    expect(t.adapter.deletedTranscripts).toEqual([t.sessionId, t.sessionId]);
  });
});

describe("a run's prompts", () => {
  it("take a person's answer one way, deliverAnswer, which settles the request the run waits on and hands the adapter the answer (#224)", async () => {
    const t = await setup(fakeAdapter({ script: ask("permission", { toolName: "Bash" }, { promptId: "p-1" }) }));
    const runId = startRun(t);
    const state = () => [...t.host.runs.runs()].find((run) => run.id === runId)?.state;
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    expect(state()).toBe("parked");

    // The answer as permissions.prompts.answer records it in its transaction, then hands it to the run after the commit.
    const decision = { decision: "allow", message: "Go ahead" } as const;
    const answer: PromptAnsweredPayload = {
      runId,
      promptId: "p-1",
      decision: "allow",
      message: "Go ahead",
      answers: null,
      updatedInput: null,
      mode: null,
      remember: null,
      decidedBy: randomUUID(),
      delivery: "live",
    };
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "prompt.answered", payload: answer }], { actor: "client_session:test", correlationId: runId });
    expect(t.host.deliverAnswer(runId, "p-1", decision)).toBeUndefined();
    expect(state()).toBe("running");

    // The request the run asked resolves with the answer (the provider's canUseTool is never left waiting), and the adapter has it too.
    await untilEnded(t, runId);
    expect(eventsOf(t).filter((event) => event.type === "assistant.text").at(-1)?.payload["text"]).toBe(toldText(decision));
    expect(t.adapter.lastRun().answers).toEqual([{ promptId: "p-1", decision }]);
    // The command's answer is the prompt's one: the run's end found nothing open to close.
    expect(answeredOf(t)).toEqual([answer]);
    expect(endsOf(t, runId)[0]?.payload).toMatchObject({ reason: "completed" });
    // No other way in: an answer handed to the adapter alone would leave the request pending until the run ends.
    expect(t.host).not.toHaveProperty("answerPrompt");
  });

  it("park the run from the request until its answer, whether the provider cancels it or a person's answer reaches it through deliverAnswer", async () => {
    // The script reads the answers from the adapter's own table: deliverAnswer hands them there as well as settling the requests.
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input, nextAnswer }) {
          yield say("Asking");
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {} });
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "question", detail: {} });
          const first = await nextAnswer();
          const second = await nextAnswer();
          yield say(`Answered ${first.promptId} ${first.decision.decision}, then ${second.decision.decision}`);
          yield end();
        },
      }),
    );
    const runId = startRun(t);
    const state = () => [...t.host.runs.runs()].find((run) => run.id === runId)?.state;
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(2));
    // Every prompt is recorded under its id: the adapter's own, or one the host minted.
    const requests = openedOf(t);
    expect(requests.map((request) => request.promptId)).toEqual(["p-1", expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(state()).toBe("parked");
    expect(t.host.processes.list()[0]?.state).toBe("parked");

    t.host.deliverAnswer(runId, "p-1", { decision: "allow" });
    expect(state()).toBe("parked");
    t.host.deliverAnswer(runId, requests[1]?.promptId as string, { decision: "deny" });
    expect(state()).toBe("running");
    expect(t.host.processes.list()[0]?.state).toBe("busy");

    await untilEnded(t, runId);
    expect(eventsOf(t).filter((event) => event.type === "assistant.text").at(-1)?.payload["text"]).toBe("Answered p-1 allow, then deny");
    expect(t.host.processes.list()[0]?.state).toBe("idle");
  });

  it("count a cancelled prompt answered once, closed cancelled: a prompt raised since under the same id or another still parks the run", async () => {
    const cancel = new AbortController();
    const step = gate();
    let cancelled: unknown;
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input }) {
          yield say("Asking");
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {}, signal: cancel.signal }).then((d) => (cancelled = d));
          await step.opened;
          // The same id again once the first was cancelled, and another beside it.
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {} });
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-2", kind: "permission", detail: {} });
          await new Promise(() => undefined);
        },
      }),
    );
    const runId = startRun(t);
    const state = () => [...t.host.runs.runs()].find((run) => run.id === runId)?.state;
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    expect(state()).toBe("parked");
    cancel.abort();
    expect(state()).toBe("running");
    await vi.waitFor(() => expect(cancelled).toMatchObject({ decision: "deny" }));
    expect(answeredOf(t)).toEqual([expect.objectContaining({ promptId: "p-1", decidedBy: { auto: "cancelled" }, delivery: null })]);

    step.open();
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(3));
    expect(state()).toBe("parked");
    t.host.deliverAnswer(runId, "p-2", { decision: "allow" });
    expect(state()).toBe("parked");
    t.host.deliverAnswer(runId, "p-1", { decision: "allow" });
    expect(state()).toBe("running");
    // The one cancelling is the only automatic answer: the later prompts' answers are a person's, recorded by their command.
    expect(answeredOf(t)).toHaveLength(1);
  });

  it("do not park the run on a request the provider cancelled before it was made, nor record it", async () => {
    let decision: unknown;
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input }) {
          yield say("Asking");
          decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {}, signal: AbortSignal.abort() });
          yield say("Told");
          await new Promise(() => undefined);
        },
      }),
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect(decision).toMatchObject({ decision: "deny" }));
    expect(openedOf(t)).toEqual([]);
    expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("running");
    expect(t.host.processes.list()[0]?.state).toBe("busy");
  });

  it("refuses an answer prompt_not_open for a prompt its live run has not raised, whatever the adapter would say, and hands an ended run nothing", async () => {
    const held = gate();
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input }) {
          yield say("Asking");
          void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {} });
          await held.opened;
          yield end();
        },
      }),
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect(openedOf(t)).toHaveLength(1));
    expect(() => t.host.deliverAnswer(runId, "p-unknown", { decision: "allow" })).toThrow(expect.objectContaining({ code: "conflict", data: expect.objectContaining({ reason: "prompt_not_open" }) }));
    expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("parked");
    held.open();
    await untilEnded(t, runId);
    // The answer's command checked the run in its transaction and the log keeps the answer: the adapter is not asked.
    expect(t.host.deliverAnswer(runId, "p-1", { decision: "allow" })).toBeUndefined();
    expect(t.adapter.lastRun().answers).toEqual([]);
  });

  it("refuses an answer internal, logged, when the adapter fails at it for any other reason, at once or asynchronously", async () => {
    const held = gate();
    let fail: () => void | Promise<void> = () => Promise.reject(new Error("The control channel is gone."));
    const adapter = fakeAdapter({
      script: async function* ({ context, input }) {
        yield say("Working");
        void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {} });
        void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-2", kind: "permission", detail: {} });
        await held.opened;
        yield end();
      },
    });
    const create = adapter.createRun;
    const t = await setup({ ...adapter, createRun: (input, context) => ({ ...create(input, context), answerPrompt: () => fail() }) } as FakeAdapter);
    const runId = startRun(t);
    await vi.waitFor(() => expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("parked"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(t.host.deliverAnswer(runId, "p-1", { decision: "allow" })).rejects.toMatchObject({ code: "internal", message: expect.stringMatching(/control channel is gone/) });
    fail = () => {
      throw new Error("The adapter broke.");
    };
    expect(() => t.host.deliverAnswer(runId, "p-2", { decision: "allow" })).toThrow(expect.objectContaining({ code: "internal", message: expect.stringMatching(/adapter broke/) }));
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
    held.open();
  });

  it("refuses an answer conflict when an adapter that answers asynchronously says the prompt is closed", async () => {
    const held = gate();
    const adapter = fakeAdapter({
      script: async function* ({ context, input }) {
        yield say("Working");
        void context.broker.request({ sessionId: input.sessionId, runId: input.runId, promptId: "p-1", kind: "permission", detail: {} });
        await held.opened;
        yield end();
      },
    });
    const create = adapter.createRun;
    const t = await setup(
      {
        ...adapter,
        createRun: (input, context) => ({ ...create(input, context), answerPrompt: () => Promise.reject(new PromptClosed("The run has ended.", "run_ended")) }),
      } as FakeAdapter,
    );
    const runId = startRun(t);
    await vi.waitFor(() => expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("parked"));
    await expect(t.host.deliverAnswer(runId, "p-1", { decision: "allow" })).rejects.toMatchObject({ code: "conflict", data: { reason: "run_ended", runId, promptId: "p-1" } });
    held.open();
  });

  it("settle the request alone on an adapter that takes no answers, handing the adapter nothing", async () => {
    const t = await setup(fakeAdapter({ capabilities: { interactivePrompts: false }, script: ask("permission", {}, { promptId: "p-1" }) }));
    const runId = startRun(t);
    await vi.waitFor(() => expect([...t.host.runs.runs()].find((run) => run.id === runId)?.state).toBe("parked"));
    expect(t.host.deliverAnswer(runId, "p-1", { decision: "deny", message: "No" })).toBeUndefined();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "assistant.text").at(-1)?.payload["text"]).toBe(toldText({ decision: "deny", message: "No" })));
    expect(t.adapter.lastRun().answers).toEqual([]);
  });
});

describe("the scoped append", () => {
  it("appends to the session's stream, stamping the run's id, and takes nothing but the transcript types an adapter reports", async () => {
    const t = await setup();
    const runId = randomUUID();
    const append = createScopedAppend({ log: t.log, sessionId: t.sessionId, runId, actor: "adapter:fake" });
    const event = append(say("Hi", "i-9"));
    expect(event).toMatchObject({ streamKind: "session", streamId: t.sessionId, correlationId: runId, payload: { runId, itemId: "i-9", text: "Hi" } });
    const started = { type: "run.started", payload: {} } as unknown as TranscriptEvent;
    expect(() => append(started)).toThrow(/may not append run.started/);
    const renamed = { type: "session.title-set", payload: { title: "x", source: "user" } } as unknown as TranscriptEvent;
    expect(() => append(renamed)).toThrow(/may not append/);
  });
});

describe("the adoption hook", () => {
  it("registers a turn the provider opened on its own as the session's next run, once the run before it ended", async () => {
    const held = gate();
    const t = await setup(
      fakeAdapter({
        capabilities: { steering: false },
        script: async function* ({ adopted }) {
          if (adopted) {
            yield say("Read the queued message");
            yield end();
            return;
          }
          await held.opened;
          yield say("First turn done");
          yield end();
        },
      }),
    );
    const first = startRun(t, "First");
    // Sent once the run is with its provider.
    await reached(t, 1);
    const messageId = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: first, messageId, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider", ceiling: "bypassPermissions" } }], { actor: "client_session:test" });
    t.host.queue({ runId: first, heldBy: "provider", message: { messageId, text: "Also this", attachments: [] } });
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));

    const events = eventsOf(t);
    const adopted = events.find((event) => event.type === "run.started" && event.payload["origin"] === "provider");
    expect(adopted?.payload).toMatchObject({ accountId: "acct", promptMessageId: null, queuedMessageIds: [messageId] });
    const second = adopted?.payload["runId"] as string;
    expect(second).not.toBe(first);
    // The adopted turn is the provider's own, on the process its instructions were composed for: none are composed for it.
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "message.sent",
      "run.instructions.composed",
      "message.sent",
      "assistant.text",
      "run.ended",
      "run.started",
      "run.policy.resolved",
      "message.delivered",
      "assistant.text",
      "run.ended",
    ]);
    expect(events[9]?.payload).toEqual({ runId: second, messageId, delivery: "prompt" });
    expect(t.adapter.runs.map((run) => run.adopted)).toEqual([false, true]);
  });
});
