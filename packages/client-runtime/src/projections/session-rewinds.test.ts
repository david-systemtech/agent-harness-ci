import { SessionSnapshot, type EventEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import { foldTranscript } from "../../../environment/src/runs/transcript.js";
import { recorded, sessionStreamEvent } from "../../test/transcript.js";
import { reduceSession, type SessionTranscript, type TranscriptEntry } from "./session.js";

/**
 * The environment's snapshot and the client runtime's reducer agree on a
 * rewound session (#260): a client that opened from the snapshot the
 * environment folds (`foldTranscript`, sent as `SessionSnapshot` on
 * `sessions.subscribeSession`) and heard the events after it reduces to the
 * same projection as one that heard every event: the same fold, the same
 * `rewound` and the same undo availability. Checked at every point the
 * snapshot could have been taken, over a rewound session, a stacked rewind,
 * an undone rewind, a rewind past its undo window, streamed replies, a
 * queued or withdrawn message inside a fold, a rewind to a message already
 * hidden and later events updating hidden entries; and at each point, the
 * environment's own split at a compaction: folding on from the fold of the
 * events before it, stored as JSON, gives the fold of every event.
 *
 * Not checked: a snapshot taken while an item streams (after its first
 * delta, before it settles). The snapshot holds settled items only, so a
 * client that opens from it places the item at its `assistant.text`, not at
 * its first delta; owed (the last test pins it).
 */

const [ONE, TWO, THREE, AGAIN] = ["9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f", "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b", "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c"];
const PROMPT = "8c0e2a4b-6d8f-4a1c-9e3b-5d7f9a1c3e5b";
const RUNS = ["3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b", "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", "6f8b0c2e-4a6c-4e8a-8c2e-4a6c8e0a2c4e", "4d6f8a0c-2e4a-4c6e-8a0c-2e4a6c8e0a2c"] as const;

type Entry = readonly [string, Record<string, unknown>];

/** One turn: its run's start, its message, the reply (a subagent's call on the second), and its end. */
const turn = (runId: string, messageId: string, text: string, index: number): Entry[] => [
  ["run.started", recorded("run.started", 0, { runId, promptMessageId: messageId, queuedMessageIds: [] })],
  ["message.sent", { runId, messageId, text, attachments: [], delivery: "prompt", heldBy: null }],
  ...(index === 1
    ? ([
        ["tool.started", { runId, toolCallId: `t-${index}`, name: "Task", input: {}, title: null, agentId: null, parentToolCallId: null }],
        ["tool.started", { runId, toolCallId: `t-${index}-a`, name: "Read", input: {}, title: null, agentId: "a-1", parentToolCallId: `t-${index}` }],
        ["tool.ended", { runId, toolCallId: `t-${index}-a`, status: "ok", output: "read", durationMs: 2 }],
      ] satisfies Entry[])
    : []),
  ["assistant.text", { runId, itemId: `i-${index}`, text: `Done: ${text}`, aborted: false }],
  ["run.ended", recorded("run.ended", 0, { runId })],
];

const history: Entry[] = [...turn(RUNS[0], ONE, "One", 0), ...turn(RUNS[1], TWO, "Two", 1), ...turn(RUNS[2], THREE, "Three", 2)];

/** The entries numbered from 1 on the fixtures' session stream. */
const stream = (entries: readonly Entry[]): EventEnvelope[] => entries.map(([type, payload], index) => sessionStreamEvent(index + 1, type, payload));

/** The sequence `history` and `rest` put the entry at `at` of `rest` at. */
const sequenceOf = (at: number): number => history.length + at + 1;

const rewound = (toMessageId: string, draft: string): Entry[] => [
  ["session.rewound", { toMessageId }],
  ["session.draft-set", { draft }],
];
const undone = (toMessageId: string, rewindSequence: number): Entry => ["session.rewind-undone", { toMessageId, rewindSequence }];

const NOTHING = { runs: [], items: [], parkedPrompts: [], rewinds: [] };

/** The events as the environment's log holds them: its actor is a string. */
const logged = (events: readonly EventEnvelope[]) => events.map((event) => ({ ...event, actor: "adapter:fake" }));

/** What JSON gives back: the wire's snapshot frame, or a compaction's stored fold. */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The snapshot the environment sends after `events`, as a client reads it off the wire: folded, sent as JSON, parsed. */
const snapshotAfter = (events: readonly EventEnvelope[]) => {
  const parts = foldTranscript(logged(events));
  const sent = asJson({ sequence: events.at(-1)?.sequence ?? 0, summary: freshSummary, ...parts });
  const { runs, items, parkedPrompts, rewinds } = SessionSnapshot.parse(sent);
  return { runs, items, parkedPrompts, rewinds };
};

/** The fragment kind and item id an assistant event opens or settles. */
const keysOf = (event: EventEnvelope): string[] => {
  const { itemId, fragments } = event.payload as { itemId?: string; fragments?: { kind: string }[] };
  if (event.type === "assistant.delta") return (fragments ?? []).map((fragment) => `${fragment.kind} ${String(itemId)}`);
  if (event.type === "assistant.text" || event.type === "assistant.thinking") return [`${event.type === "assistant.text" ? "text" : "thinking"} ${String(itemId)}`];
  return [];
};

/** Whether the split at `at` falls while an item streams: its first delta before it, its settle after. */
const streamingAt = (events: readonly EventEnvelope[], at: number): boolean => {
  const opened = new Set(events.slice(0, at).filter((event) => event.type === "assistant.delta").flatMap(keysOf));
  return events.slice(at).some((event) => event.type !== "assistant.delta" && keysOf(event).some((key) => opened.has(key)));
};

/**
 * What a client that heard every event reduces to, having checked at each
 * point (but one inside a streaming item, see above) that one opened from
 * the snapshot reduces the same, and that the environment's fold goes on
 * from a stored fold of the events before it as from every event.
 */
const agreeing = (events: readonly EventEnvelope[]): SessionTranscript => {
  const heard = reduceSession(NOTHING, events);
  const whole = foldTranscript(logged(events));
  for (let at = 0; at <= events.length; at += 1) {
    if (streamingAt(events, at)) continue;
    const [before, after] = [events.slice(0, at), events.slice(at)];
    expect(reduceSession(snapshotAfter(before), after), `opened from the snapshot after ${at} events`).toEqual(heard);
    expect(foldTranscript(logged(after), asJson(foldTranscript(logged(before)))), `folded on from a compaction after ${at} events`).toEqual(whole);
  }
  return heard;
};

/** The entries as text, a fold as its sequence, undoable flag and entries. */
const shape = (items: readonly TranscriptEntry[]): unknown[] =>
  items.map((item) => {
    if (item.kind === "rewound") return { rewound: item.sequence, undoable: item.undoable, items: shape(item.items) };
    if (item.kind === "user-message" || item.kind === "assistant-text") return item.text;
    return item.kind;
  });

const TURN_ONE = ["One", "Done: One"];
const TURN_TWO = ["Two", "tool-call", "subagent", "Done: Two"];
const TURN_THREE = ["Three", "Done: Three"];

describe("a session opened from the environment's snapshot and one that heard every event", () => {
  it("agree on a rewound session: the fold, the rewound state and the undo offered", () => {
    const rest = rewound(TWO, "Two");
    const heard = agreeing(stream([...history, ...rest]));
    expect(shape(heard.items)).toEqual([...TURN_ONE, { rewound: sequenceOf(0), undoable: true, items: [...TURN_TWO, ...TURN_THREE] }]);
    expect(heard.rewound).toEqual({ toMessageId: TWO, sequence: sequenceOf(0), text: "Two", undoable: true });
  });

  it("agree on a stacked rewind: the earlier nested in the later, both undoable", () => {
    const rest = [...rewound(THREE, "Three"), ...rewound(TWO, "Two")];
    const heard = agreeing(stream([...history, ...rest]));
    expect(shape(heard.items)).toEqual([
      ...TURN_ONE,
      { rewound: sequenceOf(2), undoable: true, items: [...TURN_TWO, { rewound: sequenceOf(0), undoable: true, items: TURN_THREE }] },
    ]);
    expect(heard.rewound).toEqual({ toMessageId: TWO, sequence: sequenceOf(2), text: "Two", undoable: true });
  });

  it("agree on an undone rewind: the later undone shows its branch again with the earlier's fold in it, and both undone show everything", () => {
    const once = [...rewound(THREE, "Three"), ...rewound(TWO, "Two"), undone(TWO, sequenceOf(2))];
    const heard = agreeing(stream([...history, ...once]));
    expect(shape(heard.items)).toEqual([...TURN_ONE, ...TURN_TWO, { rewound: sequenceOf(0), undoable: true, items: TURN_THREE }]);
    expect(heard.rewound).toEqual({ toMessageId: THREE, sequence: sequenceOf(0), text: "Three", undoable: true });

    const twice = agreeing(stream([...history, ...once, undone(THREE, sequenceOf(0))]));
    expect(shape(twice.items)).toEqual([...TURN_ONE, ...TURN_TWO, ...TURN_THREE]);
    expect(twice.rewound).toBeNull();
  });

  it("agree on a rewind past its undo window: kept where it cut, not undoable, the new branch after it, and a later rewind that cut it", () => {
    const continued = [...rewound(THREE, "Three"), ...turn(RUNS[3], AGAIN, "Three, again", 3)];
    const heard = agreeing(stream([...history, ...continued]));
    expect(shape(heard.items)).toEqual([...TURN_ONE, ...TURN_TWO, { rewound: sequenceOf(0), undoable: false, items: TURN_THREE }, "Three, again", "Done: Three, again"]);
    expect(heard.rewound).toEqual({ toMessageId: THREE, sequence: sequenceOf(0), text: "Three", undoable: false });

    // A rewind after the run cuts the earlier fold with the rest; its undo puts that fold back, still not undoable.
    const cut = agreeing(stream([...history, ...continued, ...rewound(TWO, "Two")]));
    const at = sequenceOf(continued.length);
    expect(shape(cut.items)).toEqual([
      ...TURN_ONE,
      { rewound: at, undoable: true, items: [...TURN_TWO, { rewound: sequenceOf(0), undoable: false, items: TURN_THREE }, "Three, again", "Done: Three, again"] },
    ]);
    const back = agreeing(stream([...history, ...continued, ...rewound(TWO, "Two"), undone(TWO, at)]));
    expect(shape(back.items)).toEqual(shape(heard.items));
    expect(back.rewound).toEqual(heard.rewound);
  });

  it("agree on streamed replies: an item sits at its first delta, not where it settled, so a message sent while it streamed is after it", () => {
    // Run one streams its reply; Two is sent, queued, while it does; the reply settles; run two reads Two; a rewind to Two.
    const events = stream([
      ["run.started", recorded("run.started", 0, { runId: RUNS[0], promptMessageId: ONE, queuedMessageIds: [] })],
      ["message.sent", { runId: RUNS[0], messageId: ONE, text: "One", attachments: [], delivery: "prompt", heldBy: null }],
      ["assistant.delta", { runId: RUNS[0], itemId: "i-0", fragments: [{ kind: "thinking", text: "Hm" }] }],
      ["assistant.delta", { runId: RUNS[0], itemId: "i-1", fragments: [{ kind: "text", text: "Do" }] }],
      ["message.sent", { runId: RUNS[0], messageId: TWO, text: "Two", attachments: [], delivery: "queued", heldBy: "environment" }],
      ["assistant.thinking", { runId: RUNS[0], itemId: "i-0", text: "Hm, one", aborted: false }],
      ["assistant.delta", { runId: RUNS[0], itemId: "i-1", fragments: [{ kind: "text", text: "ne" }] }],
      ["assistant.text", { runId: RUNS[0], itemId: "i-1", text: "Done: One", aborted: false }],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[0] })],
      ["run.started", recorded("run.started", 0, { runId: RUNS[1], promptMessageId: null, queuedMessageIds: [TWO] })],
      ["message.delivered", { runId: RUNS[1], messageId: TWO, delivery: "prompt" }],
      ["assistant.text", { runId: RUNS[1], itemId: "i-2", text: "Done: Two", aborted: false }],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[1] })],
      ...rewound(TWO, "Two"),
    ]);
    const heard = agreeing(events);
    expect(shape(heard.items)).toEqual(["One", "assistant-thinking", "Done: One", { rewound: 14, undoable: true, items: ["Two", "Done: Two"] }]);
    expect(heard.items.filter((item) => item.kind !== "rewound").map((item) => item.sequence)).toEqual([2, 3, 4]);
  });

  it("agree on a queued message inside a fold: still queued, and read by a later run from inside it", () => {
    const sent = [
      ["run.started", recorded("run.started", 0, { runId: RUNS[0], promptMessageId: ONE, queuedMessageIds: [] })],
      ["message.sent", { runId: RUNS[0], messageId: ONE, text: "One", attachments: [], delivery: "prompt", heldBy: null }],
      ["message.sent", { runId: RUNS[0], messageId: TWO, text: "Two", attachments: [], delivery: "queued", heldBy: "environment" }],
      ["assistant.text", { runId: RUNS[0], itemId: "i-0", text: "Done: One", aborted: false }],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[0] })],
      ...rewound(ONE, "One"),
    ] satisfies Entry[];
    const standing = agreeing(stream(sent));
    expect(shape(standing.items)).toEqual([{ rewound: 6, undoable: true, items: ["One", "Two", "Done: One"] }]);
    expect(standing.queued.map((message) => message.messageId)).toEqual([TWO]);

    const read = agreeing(
      stream([
        ...sent,
        ["run.started", recorded("run.started", 0, { runId: RUNS[1], promptMessageId: AGAIN, queuedMessageIds: [TWO] })],
        ["message.sent", { runId: RUNS[1], messageId: AGAIN, text: "One, again", attachments: [], delivery: "prompt", heldBy: null }],
        ["message.delivered", { runId: RUNS[1], messageId: TWO, delivery: "steered" }],
        ["run.ended", recorded("run.ended", 0, { runId: RUNS[1] })],
      ]),
    );
    expect(read.queued).toEqual([]);
    expect(shape(read.items)).toEqual([{ rewound: 6, undoable: false, items: ["One", "Two", "Done: One"] }, "One, again"]);
  });

  it("agree on a queued message withdrawn from inside a fold: it leaves the fold, and an undo does not bring it back", () => {
    const sent = [
      ["run.started", recorded("run.started", 0, { runId: RUNS[0], promptMessageId: ONE, queuedMessageIds: [] })],
      ["message.sent", { runId: RUNS[0], messageId: ONE, text: "One", attachments: [], delivery: "prompt", heldBy: null }],
      ["message.sent", { runId: RUNS[0], messageId: TWO, text: "Two", attachments: [], delivery: "queued", heldBy: "environment" }],
      ["assistant.text", { runId: RUNS[0], itemId: "i-0", text: "Done: One", aborted: false }],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[0] })],
      ...rewound(ONE, "One"),
      ["message.withdrawn", { runId: RUNS[0], messageId: TWO, heldBy: "environment" }],
    ] satisfies Entry[];
    const withdrawn = agreeing(stream(sent));
    expect(shape(withdrawn.items)).toEqual([{ rewound: 6, undoable: true, items: ["One", "Done: One"] }]);
    expect(withdrawn.queued).toEqual([]);
    const back = agreeing(stream([...sent, undone(ONE, 6)]));
    expect(shape(back.items)).toEqual(["One", "Done: One"]);
  });

  it("agree on a rewind to a message an earlier rewind hid: it hides nothing more, and the earlier stays the one to undo", () => {
    const rest = [...rewound(TWO, "Two"), ["command.ran", { runId: RUNS[2], name: "compact", args: "", output: null }], ...rewound(THREE, "Three")] satisfies Entry[];
    const heard = agreeing(stream([...history, ...rest]));
    expect(shape(heard.items)).toEqual([...TURN_ONE, { rewound: sequenceOf(0), undoable: true, items: [...TURN_TWO, ...TURN_THREE] }, "command"]);
    expect(heard.rewound).toEqual({ toMessageId: TWO, sequence: sequenceOf(0), text: "Two", undoable: true });
    const back = agreeing(stream([...history, ...rest, undone(TWO, sequenceOf(0))]));
    expect(shape(back.items)).toEqual([...TURN_ONE, ...TURN_TWO, ...TURN_THREE, "command"]);
  });

  it("agree on later events that update what a fold hides: a tool call's update and end, a prompt's answer, a run's ledger", () => {
    const events = stream([
      ["run.started", recorded("run.started", 0, { runId: RUNS[0], promptMessageId: ONE, queuedMessageIds: [] })],
      ["message.sent", { runId: RUNS[0], messageId: ONE, text: "One", attachments: [], delivery: "prompt", heldBy: null }],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[0] })],
      ["run.started", recorded("run.started", 0, { runId: RUNS[1], promptMessageId: TWO, queuedMessageIds: [] })],
      ["message.sent", { runId: RUNS[1], messageId: TWO, text: "Two", attachments: [], delivery: "prompt", heldBy: null }],
      ["tool.started", { runId: RUNS[1], toolCallId: "t-1", name: "Bash", input: {}, title: null, agentId: null, parentToolCallId: null }],
      ["tasks.changed", { runId: RUNS[1], tasks: [] }],
      ["prompt.opened", recorded("prompt.opened", 0, { runId: RUNS[1], promptId: PROMPT })],
      ["run.ended", recorded("run.ended", 0, { runId: RUNS[1] })],
      ...rewound(TWO, "Two"),
      ["tool.updated", { runId: RUNS[1], toolCallId: "t-1", update: { progress: "half" } }],
      ["tool.ended", { runId: RUNS[1], toolCallId: "t-1", status: "ok", output: "done", durationMs: 4 }],
      ["prompt.answered", recorded("prompt.answered", 0, { promptId: PROMPT })],
      ["tasks.changed", recorded("tasks.changed", 1, { runId: RUNS[1] })],
    ]);
    const heard = agreeing(events);
    expect(shape(heard.items)).toEqual(["One", { rewound: 10, undoable: true, items: ["Two", "tool-call", "tasks", "prompt"] }]);
    const hidden = heard.items.find((item) => item.kind === "rewound")?.items ?? [];
    expect(hidden.find((item) => item.kind === "tool-call")).toMatchObject({ status: "ok", update: { progress: "half" }, output: "done" });
    expect(hidden.find((item) => item.kind === "prompt")).toMatchObject({ state: "answered" });
    expect(hidden.find((item) => item.kind === "tasks")).toMatchObject({ tasks: recorded("tasks.changed", 1)["tasks"] });
    expect(heard.parkedPrompts).toEqual([]);
  });

  /** A reply that streams: the split after its first delta falls while it streams. */
  const streaming = stream([
    ["run.started", recorded("run.started", 0, { runId: RUNS[0], promptMessageId: ONE, queuedMessageIds: [] })],
    ["message.sent", { runId: RUNS[0], messageId: ONE, text: "One", attachments: [], delivery: "prompt", heldBy: null }],
    ["assistant.delta", { runId: RUNS[0], itemId: "i-1", fragments: [{ kind: "text", text: "Do" }] }],
    ["assistant.text", { runId: RUNS[0], itemId: "i-1", text: "Done: One", aborted: false }],
  ]);

  // The premise of the pin below, outside it: `it.fails` passes on any throw, so a premise that failed there would pass it.
  it("skip the split after an item's first delta and no other: only it falls while the item streams", () => {
    expect([0, 1, 2, 3, 4].map((at) => streamingAt(streaming, at))).toEqual([false, false, false, true, false]);
  });

  // Owed: the snapshot holds settled items only, so one taken while an item streams cannot place it at its first delta.
  it.fails("differ on a snapshot taken while an item streams: the client that opened from it places the item where it settled", () => {
    expect(reduceSession(snapshotAfter(streaming.slice(0, 3)), streaming.slice(3))).toEqual(reduceSession(NOTHING, streaming));
  });
});
