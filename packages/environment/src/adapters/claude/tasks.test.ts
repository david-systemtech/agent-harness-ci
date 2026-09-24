import { describe, expect, it } from "vitest";
import { manualClock } from "../../../test/clock.js";
import { SETTLED_LIMIT, TaskLedger } from "./tasks.js";

/**
 * The delegated-work ledger (Artemis's `taskLedger.ts`, ported to the
 * contracts' `DelegatedWorkRow`): five SDK messages merged into one row per
 * task, the whole ledger emitted after each change as `tasks.changed`.
 * Cases ported from Artemis's `taskLedger.test.ts`, the vocabulary renamed.
 */

const level = (...tasks: { task_id: string; task_type?: string; description?: string }[]) => ({ type: "system", subtype: "background_tasks_changed", tasks });
const started = (fields: Record<string, unknown>) => ({ type: "system", subtype: "task_started", ...fields });
const notified = (fields: Record<string, unknown>) => ({ type: "system", subtype: "task_notification", ...fields });
const updated = (task_id: string, patch: Record<string, unknown>) => ({ type: "system", subtype: "task_updated", task_id, patch });
const progress = (fields: Record<string, unknown>) => ({ type: "system", subtype: "task_progress", ...fields });

const ledger = () => {
  const clock = manualClock();
  return { clock, tasks: new TaskLedger(clock) };
};

describe("the task ledger", () => {
  it("builds a row from the level alone", () => {
    const { tasks } = ledger();
    expect(tasks.observe(level({ task_id: "t1", task_type: "local_agent", description: "Explore the parser" }))).toBe(true);
    expect(tasks.snapshot()).toEqual([
      {
        taskId: "t1",
        kind: "local_agent",
        description: "Explore the parser",
        status: "running",
        startedAt: "2026-09-24T00:00:00.000Z",
        endedAt: null,
        subagentType: null,
        toolCallId: null,
        error: null,
      },
    ]);
  });

  it("merges the detail the level does not carry, and takes an edge before the level without a second row", () => {
    const { tasks } = ledger();
    tasks.observe(started({ task_id: "t1", description: "Review", subagent_type: "Explore", tool_use_id: "toolu_1", task_type: "local_agent" }));
    tasks.observe(level({ task_id: "t1", task_type: "local_agent", description: "Review" }));
    expect(tasks.snapshot()).toEqual([expect.objectContaining({ taskId: "t1", subagentType: "Explore", toolCallId: "toolu_1", status: "running" })]);
  });

  it("settles a row the level has stopped naming, without waiting for its notification", () => {
    const { clock, tasks } = ledger();
    tasks.observe(level({ task_id: "t1", description: "Build" }));
    clock.advance(5_000);
    tasks.observe(level());
    expect(tasks.snapshot()).toEqual([expect.objectContaining({ taskId: "t1", status: "stopped", endedAt: "2026-09-24T00:00:05.000Z" })]);
  });

  it("leaves a foreground task alone, since the level never names one", () => {
    const { tasks } = ledger();
    tasks.observe(started({ task_id: "fg", description: "Inline agent" }));
    tasks.observe(level());
    expect(tasks.snapshot()).toEqual([expect.objectContaining({ taskId: "fg", status: "running" })]);
  });

  it("records how a task ended, and reads a stop and a kill as the same ending", () => {
    const { tasks } = ledger();
    tasks.observe(started({ task_id: "t1", description: "One" }));
    tasks.observe(notified({ task_id: "t1", status: "completed", summary: "Done", output_file: "/tmp/out" }));
    tasks.observe(started({ task_id: "t2", description: "Two" }));
    tasks.observe(updated("t2", { status: "killed" }));
    expect(tasks.snapshot().map(({ taskId, status }) => ({ taskId, status }))).toEqual([
      { taskId: "t1", status: "completed" },
      { taskId: "t2", status: "stopped" },
    ]);
  });

  it("merges a patch, including a pause, and carries a failure's error", () => {
    const { tasks } = ledger();
    tasks.observe(started({ task_id: "t1", description: "One" }));
    tasks.observe(updated("t1", { status: "paused" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "paused", endedAt: null });
    tasks.observe(updated("t1", { status: "failed", error: "exit 1" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "failed", error: "exit 1", endedAt: "2026-09-24T00:00:00.000Z" });
  });

  it("revives a settled row a patch sets live again, clearing its end as the level does, and keeps the first end when a settled row is settled again", () => {
    const { clock, tasks } = ledger();
    tasks.observe(level({ task_id: "t1" }));
    clock.advance(1_000);
    tasks.observe(updated("t1", { status: "completed" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "completed", endedAt: "2026-09-24T00:00:01.000Z" });
    clock.advance(1_000);
    tasks.observe(updated("t1", { status: "stopped" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "stopped", endedAt: "2026-09-24T00:00:01.000Z" });
    tasks.observe(updated("t1", { status: "running" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "running", endedAt: null });
    expect(tasks.liveCount).toBe(1);
  });

  it("does not revive a settled row on a late progress message, but does when the level names it again", () => {
    const { tasks } = ledger();
    tasks.observe(level({ task_id: "t1", description: "One" }));
    tasks.observe(notified({ task_id: "t1", status: "completed" }));
    tasks.observe(progress({ task_id: "t1", description: "One", usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 } }));
    expect(tasks.snapshot()[0]?.status).toBe("completed");
    tasks.observe(level({ task_id: "t1", description: "One" }));
    expect(tasks.snapshot()[0]).toMatchObject({ status: "running", endedAt: null });
  });

  it("keeps settled rows, but not for ever, and never evicts a live one", () => {
    const { tasks } = ledger();
    tasks.observe(started({ task_id: "live", description: "Live" }));
    for (let n = 0; n < SETTLED_LIMIT + 3; n += 1) {
      tasks.observe(started({ task_id: `s${n}`, description: `Settled ${n}` }));
      tasks.observe(notified({ task_id: `s${n}`, status: "completed" }));
    }
    const rows = tasks.snapshot();
    expect(rows.filter((row) => row.status === "completed")).toHaveLength(SETTLED_LIMIT);
    expect(rows.find((row) => row.taskId === "live")?.status).toBe("running");
    expect(rows.some((row) => row.taskId === "s0")).toBe(false);
  });

  it("reports whether anything changed, and clears its dirty flag when the snapshot is taken", () => {
    const { tasks } = ledger();
    expect(tasks.observe({ type: "system", subtype: "status" })).toBe(false);
    expect(tasks.dirty).toBe(false);
    tasks.observe(started({ task_id: "t1", description: "One" }));
    expect(tasks.dirty).toBe(true);
    expect(tasks.peek()).toHaveLength(1);
    expect(tasks.dirty).toBe(true);
    tasks.snapshot();
    expect(tasks.dirty).toBe(false);
  });

  it("counts the live rows", () => {
    const { tasks } = ledger();
    tasks.observe(level({ task_id: "t1" }, { task_id: "t2" }));
    tasks.observe(notified({ task_id: "t2", status: "failed" }));
    expect(tasks.liveCount).toBe(1);
  });

  it("survives a payload the SDK has reshaped, and names a task mentioned without a description", () => {
    const { tasks } = ledger();
    expect(tasks.observe({ type: "system", subtype: "background_tasks_changed", tasks: "nope" })).toBe(false);
    expect(tasks.observe(started({ description: "no id" }))).toBe(false);
    expect(tasks.observe(updated("unknown", { status: "failed" }))).toBe(false);
    tasks.observe(level({ task_id: "t1" }));
    expect(tasks.snapshot()[0]).toMatchObject({ kind: "task", description: "unnamed task" });
  });
});
