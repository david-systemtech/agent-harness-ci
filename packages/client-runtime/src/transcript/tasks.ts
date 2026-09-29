import type { DelegatedWorkRow } from "@agent-harness/contracts";
import type { SessionProjection } from "../projections/session.js";

/**
 * A session's delegated work (docs/specs/gui.md, "The seven panes and the
 * grid": the Tasks pane; docs/specs/tui.md, `/tasks`): every run's ledger
 * (`tasks.changed`, the whole ledger each time) as the session's projection
 * holds it, the live work apart from the finished, each newest first, with
 * the run that holds it (what `runs.stopTask` names beside the task) and the
 * agent whose transcript `sessions.subagentTranscript` reads: the id its
 * calls go under when the transcript has seen one, else the call that
 * started it (for Claude the same id, the environment resolving either);
 * none for work that is no agent, a background shell. Pure.
 */

/** One piece of delegated work, with the run that holds it and the agent it is, if it is one. */
export interface SessionTask {
  readonly runId: string;
  readonly task: DelegatedWorkRow;
  /** The id `sessions.subagentTranscript` reads the agent's transcript by; null for work that is no agent. */
  readonly agentId: string | null;
}

/** Whether a piece of delegated work is still going: pending, running or paused. */
export const isLiveTask = (task: Pick<DelegatedWorkRow, "status">): boolean => task.status === "pending" || task.status === "running" || task.status === "paused";

/** The session's delegated work, live and finished, each newest first across its runs. */
export const sessionTasks = (view: Pick<SessionProjection, "items">): { readonly live: readonly SessionTask[]; readonly finished: readonly SessionTask[] } => {
  const agents = new Map<string, string>();
  for (const entry of view.items) if (entry.kind === "subagent" && entry.task !== null) agents.set(`${entry.runId} ${entry.task.taskId}`, entry.agentId);
  const every: SessionTask[] = [];
  for (const entry of view.items) {
    if (entry.kind !== "tasks") continue;
    for (const task of entry.tasks) {
      const agentId = agents.get(`${entry.runId} ${task.taskId}`) ?? (task.subagentType === null ? null : task.toolCallId);
      every.push({ runId: entry.runId, task, agentId });
    }
  }
  // Newest first; work started at the same moment keeps the later run's first.
  const newest = every.map((row, at) => ({ row, at })).sort((a, b) => (a.row.task.startedAt === b.row.task.startedAt ? b.at - a.at : a.row.task.startedAt < b.row.task.startedAt ? 1 : -1));
  const rows = newest.map(({ row }) => row);
  return { live: rows.filter((row) => isLiveTask(row.task)), finished: rows.filter((row) => !isLiveTask(row.task)) };
};
