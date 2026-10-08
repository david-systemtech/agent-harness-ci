import type { AdapterCapabilities, KnownCapabilityFlag, MethodName, SessionSummary } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { accountMethodFixtures } from "../../../contracts/test/account-fixtures.js";
import { capabilities } from "../../../contracts/test/run-fixtures.js";
import { listEvent, scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { accepted, rejected, summaryOf } from "../../test/events.js";
import { subscription, type Scripted } from "../../test/scripted.js";
import { recorded } from "../../test/transcript.js";
import { METHOD_FLAGS, type CapabilityAnswer } from "../capabilities.js";
import { flush, type FakeAnswer, type FakeWire } from "../testing/fake-wire.js";
import type { UserMessageEntry } from "./session.js";
import { sessionVerbs, stopFirstOffer, type VerbMethod, type VerbsInput } from "./verbs.js";

/**
 * The queue and the rewound state per session on `projections.runs`, each
 * verb's availability with its reason, the rewound fold on
 * `projections.session`, and `commands.rewind`'s new session on
 * `use_new_session` (ADR 0022; #230). The pure rules first, then a runtime
 * on a scripted environment whose session stream the test plays.
 */

const PRESENT: CapabilityAnswer = { status: "present" };

const message = (messageId: string, text: string, heldBy: "provider" | "environment", sequence: number): UserMessageEntry => ({
  kind: "user-message",
  sequence,
  runId: "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b",
  messageId,
  text,
  attachments: [],
  delivery: "queued",
  heldBy,
  sentAt: "2026-09-24T01:02:03.456Z",
});

const input = (fields: Partial<VerbsInput> = {}): VerbsInput => ({
  connection: () => PRESENT,
  adapter: capabilities as AdapterCapabilities,
  live: false,
  queued: [],
  rewound: null,
  rewindable: true,
  draft: null,
  gone: null,
  ...fields,
});

const reasons = (fields: Partial<VerbsInput>) => {
  const { verbs } = sessionVerbs(input(fields));
  return Object.fromEntries(Object.entries(verbs).map(([verb, answer]) => [verb, answer.status === "present" ? "present" : answer.reason]));
};

describe("each verb's availability", () => {
  it("offers fork and rewind on an idle session with history, and nothing that needs a queue or a rewind", () => {
    expect(reasons({})).toEqual({ readNow: "no_queue", withdraw: "no_queue", fork: "present", rewind: "present", undoRewind: "no_rewind" });
    expect(sessionVerbs(input()).verbs.readNow).toEqual({ status: "absent", reason: "no_queue", message: "Nothing is queued to read." });
  });

  it("offers read-now and withdraw while messages are queued, and refuses a rewind while a run is live or messages are held", () => {
    const queued = [message("m-1", "Also the tests", "provider", 3)];
    expect(reasons({ live: true, queued })).toEqual({ readNow: "present", withdraw: "present", fork: "present", rewind: "run_active", undoRewind: "run_active" });
    // After an interrupt the environment holds them: a rewind would reach the provider before them (`queued_messages`).
    expect(reasons({ queued: [message("m-1", "Also the tests", "environment", 3)] })).toMatchObject({ readNow: "present", rewind: "queued_messages" });
    // Held by the provider with no run live: a turn the provider opened reads them, so neither a read-now nor a withdraw reaches
    // them (the environment answers the withdraw not_found), and each message says why.
    expect(reasons({ queued })).toMatchObject({ readNow: "no_queue", withdraw: "no_queue" });
    expect(sessionVerbs(input({ queued })).queue[0]?.withdraw).toEqual({
      status: "absent",
      reason: "being_read",
      message: "The provider is opening a turn with this message: it can no longer be withdrawn.",
    });
    // The verb is the newest message a withdraw reaches, past one the provider is reading.
    const mixed = [message("m-0", "Held", "environment", 2), ...queued];
    expect(sessionVerbs(input({ queued: mixed })).verbs.withdraw).toEqual(PRESENT);
  });

  it("dims withdraw for the newest provider-held message when the adapter cannot take it back, until interrupt re-owns it", () => {
    const adapter = { ...capabilities, withdraw: false };
    const queued = [message("m-0", "Held", "environment", 2), message("m-1", "Also the tests", "provider", 3)];
    const before = sessionVerbs(input({ adapter, live: true, queued }));
    const absent = { status: "absent", reason: "adapter", message: "Claude cannot withdraw a message its provider holds." };
    expect(before.queue.map((entry) => entry.withdraw)).toEqual([PRESENT, absent]);
    expect(before.verbs.withdraw).toEqual(absent);
    expect(before.withdrawTarget).toBe("m-1");
    expect(before.verbs.readNow).toEqual(PRESENT);

    const after = sessionVerbs(input({ adapter, queued: queued.map((entry) => ({ ...entry, heldBy: "environment" })) }));
    expect(after.verbs.withdraw).toEqual(PRESENT);
    expect(after.withdrawTarget).toBe("m-1");
    expect(after.verbs.readNow).toEqual(PRESENT);
  });

  it.each(["unreachable", "scope", "not-ready"] as const)("puts %s before the adapter's withdraw flag", (reason) => {
    const refused: CapabilityAnswer = { status: "absent", reason, message: "The connection refuses this command." };
    const answer = sessionVerbs(input({
      adapter: { ...capabilities, withdraw: false },
      live: true,
      queued: [message("m-1", "Also the tests", "provider", 3)],
      connection: () => refused,
    }));
    expect(answer.queue[0]?.withdraw).toEqual(refused);
    expect(answer.verbs.withdraw).toEqual(refused);
  });

  it("leaves a provider-held withdraw to the environment while the adapter is unknown", () => {
    expect(sessionVerbs(input({ adapter: null, live: true, queued: [message("m-1", "Also the tests", "provider", 3)] })).verbs.withdraw).toEqual(PRESENT);
  });

  it("refuses rewind while an idle session has a provider-held message (#263)", () => {
    const queued = [message("m-1", "Also the tests", "provider", 3)];
    expect(sessionVerbs(input({ queued })).verbs.rewind).toEqual({
      status: "absent",
      reason: "queued_messages",
      message: "Messages are queued: withdraw them, or let a run read them, before rewinding.",
    });
    expect(reasons({ live: true, queued }).rewind).toBe("run_active");
    expect(reasons({ queued: [] }).rewind).toBe("present");
  });

  it("refuses a read now while the session's workspace is gone, whatever is queued, and leaves the rest to the session's state (#421)", () => {
    const queued = [message("m-1", "Also the tests", "environment", 3)];
    expect(sessionVerbs(input({ queued, gone: "/srv/old" })).verbs.readNow).toEqual({
      status: "absent",
      reason: "workspace_missing",
      message: "/srv/old is gone: choose a workspace for the session first.",
    });
    // A withdraw takes the message back to the draft, and a fork shares the workspace as recorded: the environment refuses neither.
    expect(reasons({ queued, gone: "/srv/old" })).toMatchObject({ withdraw: "present", fork: "present" });
  });

  it("names the message the withdraw takes back: the newest a withdraw reaches, whatever the connection says, and none when none is", () => {
    const queued = [message("m-0", "Held", "environment", 2), message("m-1", "Also the tests", "provider", 3)];
    expect(sessionVerbs(input({ live: true, queued })).withdrawTarget).toBe("m-1");
    // Past one the provider is opening a turn with, so both renderers take back the same message.
    expect(sessionVerbs(input({ queued })).withdrawTarget).toBe("m-0");
    expect(sessionVerbs(input({ queued: queued.slice(1) })).withdrawTarget).toBeNull();
    expect(sessionVerbs(input()).withdrawTarget).toBeNull();
    // The connection decides whether it can be taken back now, not which message it is.
    const unreachable = (): CapabilityAnswer => ({ status: "absent", reason: "unreachable", message: "desk cannot be reached." });
    expect(sessionVerbs(input({ connection: unreachable, live: true, queued })).withdrawTarget).toBe("m-1");
  });

  it("says what the adapter cannot do, by its flag and in its name", () => {
    const codex = { ...(capabilities as AdapterCapabilities), provider: "codex", displayName: "Codex", fork: false, rewind: false };
    const { verbs } = sessionVerbs(input({ adapter: codex }));
    expect(verbs.fork).toEqual({ status: "absent", reason: "adapter", message: "Codex cannot fork a session." });
    expect(verbs.rewind).toEqual({ status: "absent", reason: "adapter", message: "Codex cannot rewind a session." });
    // An adapter not known yet decides nothing: the environment is the one that refuses.
    expect(reasons({ adapter: null })).toMatchObject({ fork: "present", rewind: "present" });
  });

  it("puts the connection's answer first: its scope, or the environment unreachable, since a run command never queues", () => {
    const connection = (method: VerbMethod): CapabilityAnswer =>
      method === "sessions.fork" ? PRESENT : { status: "absent", reason: "unreachable", message: "desk cannot be reached." };
    const queued = [message("m-1", "Also the tests", "environment", 3)];
    expect(reasons({ connection, queued, rewound: { toMessageId: "m-0", sequence: 4, text: "x", undoable: true } })).toEqual({
      readNow: "unreachable",
      withdraw: "unreachable",
      fork: "present",
      rewind: "unreachable",
      undoRewind: "unreachable",
    });
    const { queue } = sessionVerbs(input({ connection, queued }));
    expect(queue[0]?.withdraw).toEqual({ status: "absent", reason: "unreachable", message: "desk cannot be reached." });
  });

  it("offers the undo from the rewind until a run starts, then says a run has started since", () => {
    const rewound = { toMessageId: "m-0", sequence: 4, text: "Fix the receipts", undoable: true };
    expect(reasons({ rewound })).toMatchObject({ undoRewind: "present" });
    expect(sessionVerbs(input({ rewound: { ...rewound, undoable: false } })).verbs.undoRewind).toEqual({
      status: "absent",
      reason: "run_started",
      message: "A run has started since the rewind, so it can no longer be undone.",
    });
    expect(reasons({ rewindable: false })).toMatchObject({ rewind: "no_message" });
  });

  it("lists the queue with each message's own withdraw, refused when the draft has no room for its text", () => {
    const queued = [message("m-1", "Also the tests", "provider", 3), message("m-2", "x".repeat(10), "environment", 4)];
    const { queue, verbs } = sessionVerbs(input({ live: true, queued, draft: "y".repeat(65_530) }));
    expect(queue.map((entry) => [entry.messageId, entry.text, entry.heldBy, entry.attachments, entry.withdraw.status])).toEqual([
      ["m-1", "Also the tests", "provider", [], "absent"],
      ["m-2", "xxxxxxxxxx", "environment", [], "absent"],
    ]);
    expect(queue[0]?.withdraw).toMatchObject({ reason: "draft_full" });
    // The verb is the newest message's: the terminal UI's ↑ takes the newest back.
    expect(verbs.withdraw).toMatchObject({ status: "absent", reason: "draft_full" });
    expect(sessionVerbs(input({ live: true, queued, draft: "short" })).verbs.withdraw).toEqual(PRESENT);
  });
});

describe("the stop-first rewind's offer (#390)", () => {
  const RUN_ID = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
  const offer = (fields: Partial<VerbsInput>, liveRunId: string | undefined) => stopFirstOffer(sessionVerbs(input(fields)), liveRunId);

  it("stops the live run for a rewind refused only because it is live, with nothing queued", () => {
    expect(offer({ live: true }, RUN_ID)).toEqual({ stops: RUN_ID, rewind: { status: "absent", reason: "run_active", message: expect.any(String) } });
  });

  it("offers no stop while messages are queued, which the rewind would be refused over: withdraw them first", () => {
    expect(offer({ live: true, queued: [message("m-1", "Also the tests", "provider", 3)] }, RUN_ID)).toEqual({
      stops: null,
      rewind: { status: "absent", reason: "queued_messages", message: "Messages are queued behind the live run: withdraw them first." },
    });
  });

  it("offers no stop while the run is only starting, with no id to interrupt", () => {
    expect(offer({ live: true }, undefined)).toEqual({
      stops: null,
      rewind: { status: "absent", reason: "run_active", message: "A run is starting on this session: once it is running, a rewind offers to stop it." },
    });
  });

  it("leaves the rewind as it stands when no run is live, or it is absent for another reason", () => {
    expect(offer({}, undefined)).toEqual({ stops: null, rewind: { status: "present" } });
    const codex = { ...(capabilities as AdapterCapabilities), displayName: "Codex", rewind: false };
    expect(offer({ live: true, adapter: codex }, RUN_ID)).toEqual({ stops: null, rewind: { status: "absent", reason: "adapter", message: "Codex cannot rewind a session." } });
  });
});

// A runtime on a scripted environment.

const answering = (receipt: ReturnType<typeof accepted> | ReturnType<typeof rejected>, result?: Record<string, unknown>): FakeAnswer => ({
  result: { receipt, ...(result && { result }) },
});

const RUN = "3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const NEXT_RUN = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";
const LAST_RUN = "6f8b0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e";
const [PROMPT, ALSO, DOCS, PUSH] = ["9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f", "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c", "5e7a9b1d-3f5b-4d7f-9b1d-3f5b7d9f1b3d"];

/** One environment with the session its list holds opened on `projections.runs.session`, its stream in the test's hands. */
const opened = async (
  options: {
    providers?: readonly AdapterCapabilities[];
    accountId?: string | null;
    scopes?: Parameters<typeof scriptedEnvironments>[0]["environments"][0]["scopes"];
    /** The items of the session's snapshot: what the environment folded before the client subscribed. */
    items?: readonly Record<string, unknown>[];
    /** The rewinds standing in that snapshot, with what each hid (#260). */
    rewinds?: readonly Record<string, unknown>[];
    /** The sequence the snapshot stands at; the events played go on after it. */
    at?: number;
  } = {},
) => {
  const made = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk", title: "Receipts", ...(options.scopes && { scopes: options.scopes }) }] });
  const [{ wire, sessionId, list }] = made.environments as [ScriptedEnvironment];
  const env = wire.environmentId;
  const owned = (accountMethodFixtures["accounts.list"]!.result.valid[1] as { accounts: unknown[] }).accounts[1] as Record<string, unknown>;
  wire.answer("providers.list", () => ({ result: { providers: options.providers ?? [capabilities] } }));
  wire.answer("accounts.list", () => ({ result: { accounts: [{ ...owned, id: "codex-1", provider: "codex" }, owned] } }));
  wire.answer("sessions.subscribeSession", () => undefined);
  const runs = made.runtime.projections.runs.session(env, sessionId);
  expect(made.runtime.projections.runs.session(env, sessionId.toUpperCase())).toBe(runs);
  onTestFinished(runs.subscribe(() => undefined));
  const stream: Scripted = await subscription(wire, "sessions.subscribeSession");
  const summary: SessionSummary = summaryOf(sessionId, { title: "Receipts", accountId: options.accountId ?? null });
  const at = options.at ?? 1;
  stream.snapshot(at, { sequence: at, summary, runs: [], items: options.items ?? [], parkedPrompts: [], rewinds: options.rewinds ?? [] });
  stream.synchronized(at);
  await flush();
  let sequence = at;
  let listSequence = 1;
  /**
   * Plays events on the session's stream, each at the next sequence, and
   * answers their sequences; a run's start and end go on the list too, as
   * the environment flags them.
   */
  const play = async (...events: readonly (readonly [string, Record<string, unknown>, Partial<SessionSummary>?])[]): Promise<number[]> => {
    const sequences: number[] = [];
    for (const [type, payload, fields] of events) {
      stream.event(listEvent(++sequence, sessionId, type, payload, fields));
      sequences.push(sequence);
      if (type === "run.started" || type === "run.ended") list.event(listEvent(++listSequence, sessionId, type, payload, fields ?? {}));
    }
    await flush();
    return sequences;
  };
  const session = made.runtime.projections.session(env, sessionId);
  const texts = () => session.read().items.map((item) => (item.kind === "user-message" ? item.text : item.kind === "rewound" ? `rewound: ${item.items.length}` : item.kind));
  return { ...made, wire, env, sessionId, summary, runs, session, play, texts, sequence: () => sequence };
};

const sent = (runId: string, messageId: string, text: string, heldBy: "provider" | "environment" | null, attachments: unknown[] = []) =>
  recorded("message.sent", heldBy === null ? 0 : 1, { runId, messageId, text, heldBy, attachments, ...(heldBy === null && { delivery: "prompt" }) });
const started = (runId: string, promptMessageId: string | null, queuedMessageIds: string[] = []) =>
  recorded("run.started", 0, { runId, promptMessageId, queuedMessageIds });
const ended = (runId: string, index = 0) => recorded("run.ended", index, { runId });
const said = (runId: string, itemId: string, text: string) => recorded("assistant.text", 0, { runId, itemId, text });
const attachment = { kind: "image", name: "screen.png", mediaType: "image/png", size: 2048 };

describe("a queue on projections.runs", () => {
  it("is steered, withdrawn, re-owned by an interrupt and read now, in turn, each change on every client's queue", async () => {
    const { runtime, wire, env, runs, play, session } = await opened();
    await play(
      ["run.started", started(RUN, PROMPT), { activity: { state: "running", since: "2026-09-24T01:02:03.456Z" } }],
      ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)],
      ["message.sent", sent(RUN, ALSO, "Also the tests", "provider", [attachment])],
      ["message.sent", sent(RUN, DOCS, "And the docs", "provider")],
      ["message.sent", sent(RUN, PUSH, "Then push", "provider")],
    );
    const queue = () => runs.read().queue.map((entry) => [entry.text, entry.heldBy, entry.attachments]);
    expect(runs.read()).toMatchObject({ environmentId: env, state: "running", rewound: null });
    expect(runs.read().queue[0]).toMatchObject({ messageId: ALSO, text: "Also the tests", attachments: [attachment], heldBy: "provider", runId: RUN });
    expect(queue()).toEqual([
      ["Also the tests", "provider", [attachment]],
      ["And the docs", "provider", []],
      ["Then push", "provider", []],
    ]);
    expect(runs.read().verbs).toMatchObject({ readNow: { status: "present" }, withdraw: { status: "present" }, rewind: { status: "absent", reason: "run_active" } });

    // Steered: the provider folded it into the running turn, and it is a row of the transcript now.
    await play(["message.delivered", recorded("message.delivered", 0, { runId: RUN, messageId: ALSO, delivery: "steered" })]);
    expect(queue()).toEqual([
      ["And the docs", "provider", []],
      ["Then push", "provider", []],
    ]);

    // Withdrawn through the outbox: the provider gives it back, the environment withdraws it and its text is the draft.
    wire.answer("runs.withdraw", (params) => answering(accepted(20), { messageId: params["messageId"], sessionId: runs.read().sessionId, heldBy: "provider" }));
    expect(await runtime.commands.dispatch(env, "runs.withdraw", { messageId: DOCS })).toMatchObject({ ok: true });
    await play(
      ["message.requeued", recorded("message.requeued", 0, { runId: RUN, messageId: DOCS })],
      ["message.withdrawn", recorded("message.withdrawn", 0, { runId: RUN, messageId: DOCS, heldBy: "provider" })],
      ["session.draft-set", { draft: "And the docs" }, { draft: "And the docs" }],
    );
    expect(queue()).toEqual([["Then push", "provider", []]]);
    expect(session.read().draft).toBe("And the docs");
    expect(session.read().items.some((item) => item.kind === "user-message" && item.messageId === DOCS)).toBe(false);

    // Interrupted: what the provider still held comes back to the environment's queue, in its place.
    await play(
      ["message.requeued", recorded("message.requeued", 0, { runId: RUN, messageId: PUSH })],
      ["run.ended", { ...ended(RUN, 1), cause: "user" }, { activity: { state: "idle", since: "2026-09-24T01:03:03.456Z" } }],
    );
    expect(queue()).toEqual([["Then push", "environment", []]]);
    expect(runs.read().state).toBe("interrupted");
    expect(runs.read().verbs).toMatchObject({ readNow: { status: "present" }, rewind: { status: "absent", reason: "queued_messages" } });

    // Read now: the run of the queue names it on its start, and the queue is empty.
    wire.answer("runs.readNow", () => answering(accepted(30), { sessionId: runs.read().sessionId, interruptedRunId: null, runId: NEXT_RUN }));
    expect(await runtime.commands.dispatch(env, "runs.readNow", { sessionId: runs.read().sessionId })).toMatchObject({ ok: true });
    await play(
      ["run.started", started(NEXT_RUN, null, [PUSH]), { activity: { state: "running", since: "2026-09-24T01:04:03.456Z" } }],
      ["message.delivered", recorded("message.delivered", 0, { runId: NEXT_RUN, messageId: PUSH, delivery: "prompt" })],
    );
    expect(queue()).toEqual([]);
    expect(runs.read().verbs).toMatchObject({ readNow: { reason: "no_queue" }, withdraw: { reason: "no_queue" } });
    expect(session.read().items.find((item) => item.kind === "user-message" && item.messageId === PUSH)).toMatchObject({ delivery: "prompt", runId: NEXT_RUN });
  });
});

describe("a rewind on projections.runs and projections.session", () => {
  const history = [
    ["run.started", started(RUN, PROMPT)],
    ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)],
    ["assistant.text", said(RUN, "i-1", "Fixed.")],
    ["run.ended", ended(RUN)],
    ["run.started", started(NEXT_RUN, ALSO)],
    ["message.sent", sent(NEXT_RUN, ALSO, "Then the tests", null)],
    ["assistant.text", said(NEXT_RUN, "i-2", "Tested.")],
    ["run.ended", ended(NEXT_RUN)],
  ] as const;

  it("is undone: the strip's state and the fold until the undo, then the items back in place", async () => {
    const { runtime, wire, env, sessionId, runs, play, texts, session } = await opened();
    await play(...history);
    expect(runs.read().verbs).toMatchObject({ rewind: { status: "present" }, undoRewind: { status: "absent", reason: "no_rewind" }, fork: { status: "present" } });

    wire.answer("sessions.rewind", () => answering(accepted(20), { sessionId, messageId: ALSO }));
    expect(await runtime.commands.rewind(env, sessionId, ALSO)).toMatchObject({ kind: "rewind", answer: { ok: true } });
    const [rewindSequence] = await play(["session.rewound", { toMessageId: ALSO }], ["session.draft-set", { draft: "Then the tests" }, { draft: "Then the tests" }]);
    expect(runs.read().rewound).toEqual({ toMessageId: ALSO, sequence: rewindSequence, text: "Then the tests", undoable: true });
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "rewound: 2"]);
    expect(session.read().items[2]).toMatchObject({ kind: "rewound", undoable: true, toMessageId: ALSO });
    expect(session.read().draft).toBe("Then the tests");
    expect(runs.read().verbs.undoRewind).toEqual({ status: "present" });

    wire.answer("sessions.undoRewind", () => answering(accepted(21), { sessionId, messageId: ALSO, rewindSequence }));
    expect(await runtime.commands.dispatch(env, "sessions.undoRewind", { sessionId })).toMatchObject({ ok: true });
    await play(["session.rewind-undone", { toMessageId: ALSO, rewindSequence }]);
    expect(runs.read().rewound).toBeNull();
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "Then the tests", "assistant-text"]);
    expect(runs.read().verbs.undoRewind).toMatchObject({ reason: "no_rewind" });
  });

  it("is continued from by a run: the fold stays where the branch was cut, no longer undoable, and the new branch goes on after it", async () => {
    const { runs, play, texts, session } = await opened();
    await play(...history, ["session.rewound", { toMessageId: ALSO }]);
    await play(
      ["run.started", started(LAST_RUN, PUSH), { activity: { state: "running", since: "2026-09-24T01:05:03.456Z" } }],
      ["message.sent", sent(LAST_RUN, PUSH, "Try again", null)],
    );
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "rewound: 2", "Try again"]);
    expect(session.read().items[2]).toMatchObject({ kind: "rewound", undoable: false });
    expect(runs.read().rewound).toMatchObject({ toMessageId: ALSO, undoable: false });
    expect(runs.read().verbs.undoRewind).toMatchObject({ reason: "run_active" });

    await play(["assistant.text", said(LAST_RUN, "i-3", "Again.")], ["run.ended", ended(LAST_RUN), { activity: { state: "idle", since: "2026-09-24T01:06:03.456Z" } }]);
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "rewound: 2", "Try again", "assistant-text"]);
    expect(runs.read().verbs.undoRewind).toMatchObject({ reason: "run_started" });
  });
});

describe("commands.rewind", () => {
  const firstRun: readonly (readonly [string, Record<string, unknown>])[] = [
    ["run.started", started(RUN, PROMPT)],
    ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)],
    ["run.ended", ended(RUN)],
  ];
  const requests = (wire: FakeWire, method: string) =>
    wire.server.received().flatMap((frame) => (frame.type === "request" && frame.method === method ? [frame.params] : []));

  it("on use_new_session starts a new session in the same workspace, a session request naming the rewound one, with the message's text as its draft, and answers its id", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    wire.answer("sessions.rewind", () => answering(rejected(20, "conflict", { reason: "use_new_session", sessionId, messageId: PROMPT })));
    wire.answer("sessions.create", () => answering(accepted(21)));
    wire.answer("sessions.setDraft", () => answering(accepted(22)));
    const answer = await runtime.commands.rewind(env, sessionId, PROMPT);
    expect(answer).toMatchObject({ kind: "new-session", sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/), answer: { ok: true } });
    const created = answer.kind === "new-session" ? answer.sessionId : "";
    await flush();
    expect(requests(wire, "sessions.create")).toEqual([expect.objectContaining({ id: created, workspace: { kind: "session", sessionId } })]);
    expect(requests(wire, "sessions.setDraft")).toEqual([expect.objectContaining({ sessionId: created, draft: "Fix the receipts" })]);
    // The refusal is the helper's to answer: no notice says the rewind was rejected.
    expect(runtime.projections.notices.read().filter((notice) => notice.kind === "command-rejected")).toEqual([]);
  });

  const useNewSession = (wire: FakeWire, sessionId: string, messageId: string) =>
    wire.answer("sessions.rewind", () => answering(rejected(20, "conflict", { reason: "use_new_session", sessionId, messageId })));
  const rejections = (runtime: { projections: { notices: { read(): readonly { kind: string; message: string }[] } } }) =>
    runtime.projections.notices.read().flatMap((notice) => (notice.kind === "command-rejected" ? [notice.message] : []));

  it("sends the draft only once the environment has created the session, and none when the create is refused, which leaves its own notice", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    useNewSession(wire, sessionId, PROMPT);
    wire.answer("sessions.create", () => answering(rejected(21, "conflict", { reason: "account_unavailable" })));
    wire.answer("sessions.setDraft", () => answering(accepted(22)));
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "new-session", answer: { ok: false, error: { code: "conflict" } } });
    await flush();
    expect(requests(wire, "sessions.setDraft")).toEqual([]);
    expect(rejections(runtime)).toEqual(["Create session on a new session was rejected: account unavailable."]);
  });

  it("leaves a draft the environment refuses its own notice, after the session is created", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    useNewSession(wire, sessionId, PROMPT);
    wire.answer("sessions.create", () => answering(accepted(21)));
    wire.answer("sessions.setDraft", () => answering(rejected(22, "not_found", { kind: "session" })));
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "new-session", answer: { ok: true } });
    await flush();
    expect(requests(wire, "sessions.setDraft")).toHaveLength(1);
    expect(rejections(runtime)).toEqual([expect.stringMatching(/^Save draft on .+ was rejected: it no longer exists\.$/)]);
  });

  it("sends no draft for a message with no text, and cuts one past the draft's limit to it", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    const LONG = "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c";
    await play(
      ["run.started", started(RUN, PROMPT)],
      ["message.sent", sent(RUN, PROMPT, "", null)],
      ["run.ended", ended(RUN)],
      ["run.started", started(NEXT_RUN, LONG)],
      ["message.sent", sent(NEXT_RUN, LONG, "x".repeat(70_000), null)],
      ["run.ended", ended(NEXT_RUN)],
    );
    wire.answer("sessions.rewind", (params) => answering(rejected(20, "conflict", { reason: "use_new_session", sessionId, messageId: params["messageId"] })));
    wire.answer("sessions.create", () => answering(accepted(21)));
    wire.answer("sessions.setDraft", () => answering(accepted(22)));
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "new-session", answer: { ok: true } });
    await flush();
    expect(requests(wire, "sessions.setDraft")).toEqual([]);
    expect(await runtime.commands.rewind(env, sessionId, LONG)).toMatchObject({ kind: "new-session", answer: { ok: true } });
    await flush();
    const drafts = requests(wire, "sessions.setDraft");
    expect(drafts).toHaveLength(1);
    expect((drafts[0]?.["draft"] as string).length).toBe(65_536);
    expect(requests(wire, "sessions.create")).toHaveLength(2);
    expect(rejections(runtime)).toEqual([]);
  });

  it("answers the refusal as the rewind's own, with its notice, when it holds nothing to start a session from", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    // A message this client does not hold: the refusal is the caller's.
    useNewSession(wire, sessionId, DOCS);
    expect(await runtime.commands.rewind(env, sessionId, DOCS)).toMatchObject({ kind: "rewind", answer: { ok: false, error: { data: { reason: "use_new_session" } } } });
    expect(requests(wire, "sessions.create")).toEqual([]);
    expect(rejections(runtime)).toEqual(["Rewind on Receipts was rejected: use new session."]);
  });

  it("answers the refusal as the rewind's own, with its notice, when the connection could not create the session", async () => {
    const { runtime, wire, env, sessionId, play } = await opened({ scopes: ["read", "runs:drive"] });
    await play(...firstRun);
    useNewSession(wire, sessionId, PROMPT);
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "rewind", answer: { ok: false, error: { code: "conflict", data: { reason: "use_new_session" } } } });
    expect(requests(wire, "sessions.create")).toEqual([]);
    expect(rejections(runtime)).toEqual(["Rewind on Receipts was rejected: use new session."]);
  });

  it("starts a new session only on a conflict naming use_new_session, not on another code carrying that reason", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    wire.answer("sessions.rewind", () => answering(rejected(20, "invalid_params", { reason: "use_new_session" })));
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "rewind", answer: { ok: false, error: { code: "invalid_params" } } });
    expect(requests(wire, "sessions.create")).toEqual([]);
    expect(rejections(runtime)).toHaveLength(1);
  });

  it("in its stop-first form is refused at once, dispatching nothing, while the run is only starting, with no id to interrupt (#390)", async () => {
    const { runtime, wire, env, sessionId, play, environments } = await opened();
    await play(...firstRun);
    // Another client's start: the list says starting before any run.started names the run.
    environments[0]?.list.event(listEvent(5, sessionId, "session.activity-changed", {}, { activity: { state: "starting", since: "2026-09-24T01:05:03.456Z" } }));
    await flush();
    expect(runtime.projections.runs.session(env, sessionId).read().state).toBe("starting");
    expect(await runtime.commands.rewind(env, sessionId, PROMPT, { stopFirst: true })).toEqual({
      kind: "refused",
      reason: "run_active",
      message: "A run is starting on this session: once it is running, a rewind offers to stop it.",
    });
    await flush();
    expect(requests(wire, "runs.interrupt")).toEqual([]);
    expect(requests(wire, "sessions.rewind")).toEqual([]);
  });

  it("answers any other refusal as the rewind's own, with its notice, and starts nothing", async () => {
    const { runtime, wire, env, sessionId, play } = await opened();
    await play(...firstRun);
    wire.answer("sessions.rewind", () => answering(rejected(20, "conflict", { reason: "run_active", sessionId, runId: RUN })));
    expect(await runtime.commands.rewind(env, sessionId, PROMPT)).toMatchObject({ kind: "rewind", answer: { ok: false, error: { code: "conflict", data: { reason: "run_active" } } } });
    expect(requests(wire, "sessions.create")).toEqual([]);
    expect(runtime.projections.notices.read().map((notice) => notice.message)).toEqual(["Rewind on Receipts was rejected: run active."]);
  });
});

describe("a queued message read as a turn's prompt", () => {
  it("leaves the queue on its message.delivered, with no run.started naming it", async () => {
    const { runs, play } = await opened();
    await play(
      ["run.started", started(RUN, PROMPT), { activity: { state: "running", since: "2026-09-24T01:02:03.456Z" } }],
      ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)],
      ["message.sent", sent(RUN, ALSO, "Also the tests", "provider")],
    );
    expect(runs.read().queue.map((entry) => entry.messageId)).toEqual([ALSO]);
    await play(["message.delivered", recorded("message.delivered", 1, { runId: RUN, messageId: ALSO })]);
    expect(runs.read().queue).toEqual([]);
  });
});

describe("a session opened from a snapshot taken after a rewind", () => {
  const kept = [
    { kind: "user-message", sequence: 3, runId: RUN, messageId: PROMPT, text: "Fix the receipts", attachments: [], delivery: "prompt", heldBy: null, sentAt: "2026-09-24T01:02:03.456Z" },
    { kind: "assistant-text", sequence: 4, runId: RUN, itemId: "i-1", text: "Fixed.", aborted: false },
  ];
  const hid = [
    { kind: "user-message", sequence: 7, runId: NEXT_RUN, messageId: ALSO, text: "Then the tests", attachments: [], delivery: "prompt", heldBy: null, sentAt: "2026-09-24T01:03:03.456Z" },
    { kind: "assistant-text", sequence: 8, runId: NEXT_RUN, itemId: "i-2", text: "Tested.", aborted: false },
  ];
  /** The rewind to ALSO at 10, as the environment's snapshot carries it (#260). */
  const standing = (undoable: boolean) => ({ sequence: 10, toMessageId: ALSO, text: "Then the tests", undoable, items: hid, rewinds: [] });

  it("shows the fold, the rewound state and the undo as a client that heard the rewind, and the undo puts the branch back without a fresh snapshot", async () => {
    const { runtime, wire, env, sessionId, runs, texts, session, play } = await opened({ items: kept, rewinds: [standing(true)], at: 11 });
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "rewound: 2"]);
    expect(session.read().items[2]).toMatchObject({ kind: "rewound", sequence: 10, toMessageId: ALSO, text: "Then the tests", undoable: true });
    expect(runs.read().rewound).toEqual({ toMessageId: ALSO, sequence: 10, text: "Then the tests", undoable: true });
    expect(runs.read().verbs.undoRewind).toEqual({ status: "present" });

    wire.answer("sessions.undoRewind", () => answering(accepted(21), { sessionId, messageId: ALSO, rewindSequence: 10 }));
    expect(await runtime.commands.dispatch(env, "sessions.undoRewind", { sessionId })).toMatchObject({ ok: true });
    await play(["session.rewind-undone", { toMessageId: ALSO, rewindSequence: 10 }]);
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "Then the tests", "assistant-text"]);
    expect(runs.read().rewound).toBeNull();
    expect(runs.read().verbs.undoRewind).toMatchObject({ status: "absent", reason: "no_rewind" });
    // The snapshot held what the rewind hid, so the undo needs no fresh one.
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method === "sessions.subscribeSession")).toHaveLength(1);
  });

  it("shows a rewind a run has continued from where it cut, not undoable, and the undo absent since a run has started", async () => {
    const { runs, texts, session } = await opened({ items: kept, rewinds: [standing(false)], at: 11 });
    expect(texts()).toEqual(["Fix the receipts", "assistant-text", "rewound: 2"]);
    expect(session.read().items[2]).toMatchObject({ kind: "rewound", undoable: false });
    expect(runs.read().rewound).toEqual({ toMessageId: ALSO, sequence: 10, text: "Then the tests", undoable: false });
    expect(runs.read().verbs.undoRewind).toMatchObject({ status: "absent", reason: "run_started" });
  });
});

describe("the verbs on a runtime", () => {
  it("read the session's adapter through its account, and the connection's scopes", async () => {
    const codex = { ...(capabilities as AdapterCapabilities), provider: "codex", displayName: "Codex", fork: false, rewind: false };
    const { runs } = await opened({ providers: [capabilities as AdapterCapabilities, codex], accountId: "codex-1", scopes: ["read", "sessions:write"] });
    expect(runs.read().verbs).toEqual({
      readNow: { status: "absent", reason: "scope", message: "This app has limited access to desk, so it cannot run agents. Pair again with full access to change this.", details: ["runs:drive"] },
      withdraw: { status: "absent", reason: "scope", message: "This app has limited access to desk, so it cannot run agents. Pair again with full access to change this.", details: ["runs:drive"] },
      fork: { status: "absent", reason: "adapter", message: "Codex cannot fork a session." },
      rewind: { status: "absent", reason: "scope", message: "This app has limited access to desk, so it cannot run agents. Pair again with full access to change this.", details: ["runs:drive"] },
      undoRewind: { status: "absent", reason: "scope", message: "This app has limited access to desk, so it cannot run agents. Pair again with full access to change this.", details: ["runs:drive"] },
    });
  });

  it("follow the run states alone: one session's verbs fetch no environment's parked prompts", async () => {
    const { wire, runs } = await opened();
    expect(runs.read().verbs.fork).toEqual({ status: "present" });
    await flush();
    expect(wire.server.received().filter((frame) => frame.type === "request" && frame.method === "permissions.prompts.list")).toEqual([]);
  });

  it("say not-ready while the connection is being made again, as the capability does", async () => {
    const { runs, wire, clock, play } = await opened();
    await play(["run.started", started(RUN, PROMPT)], ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)], ["run.ended", ended(RUN)]);
    wire.server.drop();
    await flush();
    clock.advance(1250);
    await flush();
    expect(runs.read().verbs).toMatchObject({ rewind: { status: "absent", reason: "not-ready", message: "Connecting to desk." }, fork: { status: "present" } });
  });

  it("check the flag a method needs for fork, as dispatch does, whatever the phase", async () => {
    // No method is gated by a flag yet: the test gates fork for its own length, as a workstream would in `METHOD_FLAGS`.
    const flags = METHOD_FLAGS as Partial<Record<MethodName, KnownCapabilityFlag>>;
    flags["sessions.fork"] = "containment:workspace";
    onTestFinished(() => void delete flags["sessions.fork"]);
    const { runs } = await opened();
    expect(runs.read().verbs.fork).toEqual({ status: "absent", reason: "unsupported", message: "desk runs an older agent-harness without this. Update desk to use it.", details: ["containment:workspace"] });
  });

  it("refuse every run verb at once while the environment is unreachable, and keep fork, which queues", async () => {
    const { runs, wire, play } = await opened();
    await play(["run.started", started(RUN, PROMPT)], ["message.sent", sent(RUN, PROMPT, "Fix the receipts", null)], ["run.ended", ended(RUN)]);
    expect(runs.read().verbs.rewind).toEqual({ status: "present" });
    wire.server.drop();
    await flush();
    expect(runs.read().verbs).toMatchObject({
      rewind: { status: "absent", reason: "unreachable" },
      readNow: { status: "absent", reason: "unreachable" },
      fork: { status: "present" },
    });
  });
});
