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
 * an undone rewind and a rewind past its undo window.
 */

const [ONE, TWO, THREE, AGAIN] = ["9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "2c4e6a8b-1d3f-4b5a-9c7e-0a2b4c6d8e0f", "6e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b", "7a9c1e3f-5b7d-4f9a-8c1e-3f5b7d9f1a3c"];
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

/** The snapshot the environment sends after `events`, as a client reads it off the wire: folded, sent as JSON, parsed. */
const snapshotAfter = (events: readonly EventEnvelope[]) => {
  const parts = foldTranscript(events.map((event) => ({ ...event, actor: "adapter:fake" })));
  const sent = JSON.parse(JSON.stringify({ sequence: events.at(-1)?.sequence ?? 0, summary: freshSummary, ...parts })) as unknown;
  const { runs, items, parkedPrompts, rewinds } = SessionSnapshot.parse(sent);
  return { runs, items, parkedPrompts, rewinds };
};

/** What a client that heard every event reduces to, having checked that one opened from the snapshot at each point reduces the same. */
const agreeing = (events: readonly EventEnvelope[]): SessionTranscript => {
  const heard = reduceSession(NOTHING, events);
  for (let at = 0; at <= events.length; at += 1) {
    expect(reduceSession(snapshotAfter(events.slice(0, at)), events.slice(at)), `opened from the snapshot after ${at} events`).toEqual(heard);
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
});
