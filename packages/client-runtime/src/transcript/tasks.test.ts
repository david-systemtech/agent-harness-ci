import type { DelegatedWorkRow } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { SubagentEntry, TranscriptEntry } from "../projections/session.js";
import { sessionTasks } from "./tasks.js";

/**
 * A session's delegated work as a pure fold (docs/specs/gui.md, "The seven
 * panes and the grid": the Tasks pane, live on top and finished folded):
 * every run's ledger, newest first, each piece of work with the run that
 * holds it and the agent whose transcript `sessions.subagentTranscript` reads.
 */

const RUN = "0199a100-0000-4000-8000-000000000001";
const LATER_RUN = "0199a100-0000-4000-8000-000000000002";

const task = (taskId: string, status: DelegatedWorkRow["status"], startedAt: string, more: Partial<DelegatedWorkRow> = {}): DelegatedWorkRow => ({
  taskId,
  kind: "local_agent",
  description: `Work ${taskId}`,
  status,
  startedAt,
  endedAt: status === "pending" || status === "running" || status === "paused" ? null : "2026-09-29T10:30:00.000Z",
  subagentType: "Explore",
  toolCallId: `call-${taskId}`,
  error: null,
  ...more,
});

const ledger = (sequence: number, runId: string, tasks: readonly DelegatedWorkRow[]): TranscriptEntry => ({ kind: "tasks", sequence, runId, tasks: [...tasks] });

const ids = (rows: readonly { readonly task: DelegatedWorkRow }[]) => rows.map((row) => row.task.taskId);

describe("sessionTasks", () => {
  it("puts live work (pending, running, paused) apart from finished work, each newest first across the runs", () => {
    const items = [
      ledger(2, RUN, [task("a", "completed", "2026-09-29T10:00:00.000Z"), task("b", "running", "2026-09-29T10:01:00.000Z")]),
      ledger(9, LATER_RUN, [task("c", "paused", "2026-09-29T10:05:00.000Z"), task("d", "failed", "2026-09-29T10:06:00.000Z"), task("e", "pending", "2026-09-29T10:07:00.000Z")]),
    ];
    const { live, finished } = sessionTasks({ items });
    expect(ids(live)).toEqual(["e", "c", "b"]);
    expect(ids(finished)).toEqual(["d", "a"]);
    expect(live.map((row) => row.runId)).toEqual([LATER_RUN, LATER_RUN, RUN]);
    expect(sessionTasks({ items: [] })).toEqual({ live: [], finished: [] });
  });

  it("names the agent a subagent's transcript is read by: the id its calls go under, else the call that started it; none for work that is no agent", () => {
    const started = task("a", "running", "2026-09-29T10:00:00.000Z", { toolCallId: "call-agent" });
    const subagent: SubagentEntry = { kind: "subagent", sequence: 5, runId: RUN, agentId: "agent-7", parentToolCallId: "call-agent", calls: [], task: started, running: true };
    const quiet = task("b", "running", "2026-09-29T10:01:00.000Z", { toolCallId: "call-quiet" });
    const shell = task("c", "running", "2026-09-29T10:02:00.000Z", { kind: "local_bash", subagentType: null, toolCallId: "call-shell" });
    const { live } = sessionTasks({ items: [ledger(2, RUN, [started, quiet, shell]), subagent] });
    expect(live.map((row) => [row.task.taskId, row.agentId])).toEqual([
      ["c", null],
      ["b", "call-quiet"],
      ["a", "agent-7"],
    ]);
  });
});
