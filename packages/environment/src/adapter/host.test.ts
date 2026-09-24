import { randomUUID } from "node:crypto";
import { ContractError, type AttachmentInput } from "@agent-harness/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manualClock } from "../../test/clock.js";
import { end, fakeAdapter, gate, say, type FakeAdapter } from "../../test/fake-adapter.js";
import { openEventLog, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import { permissionsProjector } from "../permissions/permissions-store.js";
import { decideStart, type StartCommand } from "../runs/run-decider.js";
import { runsProjector } from "../runs/runs-projector.js";
import { sessionListProjector } from "../sessions/session-list.js";
import type { AdapterEvent, TranscriptEvent } from "./contract.js";
import { createAdapterHost, type AdapterHost, type AdapterHostOptions } from "./host.js";
import { createScopedAppend } from "./scoped-append.js";
import { composeInstructions, presetPolicy } from "./seams.js";

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

const setup = async (adapter: FakeAdapter = fakeAdapter(), options: Partial<AdapterHostOptions> = {}): Promise<Setup> => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [sessionListProjector, runsProjector, permissionsProjector], clock: () => clock.now() });
  // No client session stands behind these runs (their actor names none), so no ceiling is read again.
  const host = createAdapterHost({ log, clock, adapters: [adapter], accounts: [{ id: "acct", provider: adapter.descriptor.provider }], ceilingOf: () => undefined, ...options });
  closers.push(() => log.close(), () => host.close("disposed"));
  await host.refresh();
  const sessionId = randomUUID();
  log.append({ kind: "session", id: sessionId }, [created], { actor: "system:test" });
  return { log, host, adapter, sessionId };
};

/** Starts a run as `runs.start` does, outside the wire: the facts, the decider, the append, then the launch. */
const startRun = (t: Setup, text = "Go", command: Partial<Omit<StartCommand, "message">> & { attachments?: AttachmentInput[] } = {}): string => {
  const facts = t.host.startFacts(t.sessionId, { kind: "client", ceiling: "bypassPermissions", clientSessionId: null });
  t.host.admit();
  const decision = decideStart(facts, { origin: "client", ...command, message: { messageId: randomUUID(), text, attachments: command.attachments ?? [] } });
  if (decision.rejected !== undefined) throw new Error(decision.rejected.message);
  t.log.append({ kind: "session", id: t.sessionId }, decision.events, { actor: "client_session:test", correlationId: decision.run.runId });
  t.host.launch(decision.run);
  return decision.run.runId;
};

/** The session's events after its creation. */
const eventsOf = (t: Setup): EventEnvelope[] => t.log.readStream({ kind: "session", id: t.sessionId }).filter((event) => event.type !== "session.created");

const endsOf = (t: Setup, runId: string): EventEnvelope[] => eventsOf(t).filter((event) => event.type === "run.ended" && event.payload["runId"] === runId);

/** Resolves once the run has its end on the stream. */
const untilEnded = (t: Setup, runId: string) => vi.waitFor(() => expect(endsOf(t, runId)).toHaveLength(1));

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
      "session.provider-linked",
      "assistant.delta",
      "assistant.text",
      "tool.started",
      "tool.updated",
      "tool.ended",
      "usage.reported",
      "run.ended",
    ]);
    for (const event of events) {
      expect(event.payload["runId"], event.type).toBe(runId);
      expect(event.correlationId, event.type).toBe(runId);
    }
    expect(events.slice(3, -1).map((event) => event.actor)).toEqual(Array(7).fill("adapter:fake"));
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
      instructions: composeInstructions({ orientationBlock: () => "You are on SYSTEM-SERVER.", sessionInstructions: () => "Be brief." }),
      // The policy seam, here one that clamps every run to acceptEdits, whatever the actor's ceiling.
      resolvePolicy: (request) => presetPolicy({ ...request, actor: { ...request.actor, ceiling: "acceptEdits" } }),
    });
    const runId = startRun(t, "Fix it", { model: "sonnet", effort: "high", mode: "bypassPermissions" });
    await untilEnded(t, runId);
    const { input } = t.adapter.lastRun();
    expect(input).toMatchObject({
      sessionId: t.sessionId,
      runId,
      account: { id: "acct", directory: null },
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
    expect(toolServers).toHaveBeenCalledWith({ sessionId: t.sessionId, runId, accountId: "acct", workspace: { kind: "directory", path: "/work" } });
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
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "assistant.text", "run.ended"]);
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
    expect(eventsOf(t).map((event) => event.type)).toEqual(["run.started", "run.policy.resolved", "message.sent", "assistant.text", "run.ended"]);
  });

  it("ends the run disposed when the host lets it go mid-run, disposes it, and drops what it yields after", async () => {
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
    const messageId = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: first, messageId, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider" } }], { actor: "client_session:test" });
    t.host.queue({ runId: first, heldBy: "provider", message: { messageId, text: "Also this", attachments: [] } });
    expect(eventsOf(t).at(-1)).toMatchObject({ type: "message.requeued", actor: "system:adapter-host", payload: { runId: first, messageId } });
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));
    const next = eventsOf(t).filter((event) => event.type === "run.started")[1];
    expect(next?.payload).toMatchObject({ origin: "client", promptMessageId: null, queuedMessageIds: [messageId] });
    expect(t.adapter.lastRun().input.prompt.map((message) => message.text)).toEqual(["Also this"]);
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
    expectUnsupported(await catching(() => t.host.stopTask(runId, "task-1")), "subagents");
    held.open();
  });
});

describe("the seams", () => {
  it("denies every prompt through the placeholder broker, until #130 replaces it", async () => {
    let decision: unknown;
    const t = await setup(
      fakeAdapter({
        script: async function* ({ context, input }) {
          decision = await context.broker.request({ sessionId: input.sessionId, runId: input.runId, kind: "permission", detail: { toolName: "Bash" } });
          yield end();
        },
      }),
    );
    await untilEnded(t, startRun(t));
    expect(decision).toMatchObject({ decision: "deny" });
  });

  it("validates the account, model and mode sessions.create is given against the accounts and their catalogues", async () => {
    const t = await setup();
    expect(t.host.validateSessionInput({ account: "acct", model: "opus", mode: "plan" })).toEqual([]);
    expect(t.host.validateSessionInput({ account: null, model: null, mode: null })).toEqual([]);
    expect(t.host.validateSessionInput({ account: "nobody", model: "gpt", mode: "yolo" }).map((issue) => issue.path)).toEqual([["account"], ["model"], ["mode"]]);
    expect(t.host.validateSessionInput({ account: null, model: "gpt", mode: null }).map((issue) => issue.path)).toEqual([["model"]]);
  });

  it("offers the purge a transcript delete only when an adapter declares it, synchronous and routed to the session's adapter", async () => {
    expect((await setup()).host.transcripts.deleteTranscript).toBeUndefined();
    const t = await setup(fakeAdapter({ deleteTranscript: true }));
    expect(t.host.transcripts.deleteTranscript?.(t.sessionId)).toBeUndefined();
    expect(t.host.transcripts.deleteTranscript?.(t.sessionId)).toBeUndefined();
    expect(t.adapter.deletedTranscripts).toEqual([t.sessionId, t.sessionId]);
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
    const messageId = randomUUID();
    t.log.append({ kind: "session", id: t.sessionId }, [{ type: "message.sent", payload: { runId: first, messageId, text: "Also this", attachments: [], delivery: "queued", heldBy: "provider" } }], { actor: "client_session:test" });
    t.host.queue({ runId: first, heldBy: "provider", message: { messageId, text: "Also this", attachments: [] } });
    held.open();
    await vi.waitFor(() => expect(eventsOf(t).filter((event) => event.type === "run.ended")).toHaveLength(2));

    const events = eventsOf(t);
    const adopted = events.find((event) => event.type === "run.started" && event.payload["origin"] === "provider");
    expect(adopted?.payload).toMatchObject({ accountId: "acct", promptMessageId: null, queuedMessageIds: [messageId] });
    const second = adopted?.payload["runId"] as string;
    expect(second).not.toBe(first);
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "run.policy.resolved",
      "message.sent",
      "message.sent",
      "assistant.text",
      "run.ended",
      "run.started",
      "run.policy.resolved",
      "message.delivered",
      "assistant.text",
      "run.ended",
    ]);
    expect(events[8]?.payload).toEqual({ runId: second, messageId, delivery: "prompt" });
    expect(t.adapter.runs.map((run) => run.adopted)).toEqual([false, true]);
  });
});
