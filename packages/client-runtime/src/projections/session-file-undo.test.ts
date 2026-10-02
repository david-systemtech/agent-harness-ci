import { SessionSnapshot, type EventEnvelope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import { formatActor } from "../../../environment/src/event-log/envelope.js";
import { foldTranscript } from "../../../environment/src/runs/transcript.js";
import { sessionStreamEvent } from "../../test/transcript.js";
import { transcriptRows } from "../transcript/rows.js";
import { reduceSession } from "./session.js";

const EMPTY = { runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" };
const CHANGE = "0199aa00-0000-4000-8000-000000000002";
const logged = (events: readonly EventEnvelope[]) => events.map((event) => ({ ...event, actor: formatActor(event.actor) }));

describe("file undo completion rows", () => {
  it.each(["restored", "deleted"] as const)("keeps a %s row with no file contents in replay and snapshots", (action) => {
    const payload = { changeId: CHANGE, path: "src/app.ts", action };
    const event = sessionStreamEvent(1, "files.undo-finished", payload);
    const expected = { kind: "file-undo", sequence: 1, ...payload };
    const heard = reduceSession(EMPTY, [event]);
    expect(heard.items).toEqual([expected]);
    expect(transcriptRows(heard)).toEqual([{ kind: "file-undo", id: `file-undo:${CHANGE}`, runId: null, entry: expected }]);
    const parts = foldTranscript(logged([event]));
    expect(parts.items).toEqual([expected]);
    const snapshot = SessionSnapshot.parse({ sequence: 1, summary: freshSummary, ...parts });
    expect(reduceSession(snapshot, []).items).toEqual([expected]);
    expect(reduceSession(EMPTY, [event, event]).items).toEqual([expected]);
  });
});
