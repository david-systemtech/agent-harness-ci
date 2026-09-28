import type { SessionProjection, ToolCallEntry } from "../projections/session.js";

/**
 * How long each running tool call has said nothing (docs/specs/tui.md, "The
 * transcript", and docs/specs/gui.md, "A session pane": a tool quiet three
 * minutes turns amber). The projection carries no time for a call, so the
 * renderer measures the silence itself, on its own clock: a call is heard
 * when it first shows running and again each time its latest `tool.updated`
 * changes; the silence is the time since it was last heard. A call already
 * running when the renderer opened the session is heard from then (a chosen
 * default: a client cannot know what it did not see). Pure: the last state
 * and the projection go in, the next state comes out.
 */

/** How long a running call may say nothing before its row turns amber: a cue, not a verdict. */
export const TOOL_QUIET_MS = 3 * 60_000;

export interface Heard {
  /** What the call last said: its update, as JSON. */
  readonly said: string;
  /** When the renderer heard it, in milliseconds on its clock. */
  readonly at: number;
}

export type QuietCalls = ReadonlyMap<string, Heard>;

/** Every call the projection holds that is still running, the run's own and its subagents'. */
export const runningCalls = (view: Pick<SessionProjection, "items">): ToolCallEntry[] =>
  view.items.flatMap((entry) => (entry.kind === "tool-call" ? [entry] : entry.kind === "subagent" ? entry.calls : [])).filter((call) => call.status === "running");

/** The running calls and when each was last heard: a call whose update changed is heard now; a call no longer running is let go. */
export const hear = (previous: QuietCalls, calls: readonly ToolCallEntry[], now: number): QuietCalls => {
  const next = new Map<string, Heard>();
  for (const call of calls) {
    const said = JSON.stringify(call.update ?? null);
    const before = previous.get(call.toolCallId);
    next.set(call.toolCallId, before !== undefined && before.said === said ? before : { said, at: now });
  }
  // The same calls, heard at the same times: the same state, so nothing redraws for it.
  if (next.size === previous.size && [...next].every(([id, heard]) => previous.get(id) === heard)) return previous;
  return next;
};

/** How long the call has been quiet; zero for one not running. */
export const quietFor = (calls: QuietCalls, toolCallId: string, now: number): number => {
  const heard = calls.get(toolCallId);
  return heard === undefined ? 0 : Math.max(0, now - heard.at);
};

/**
 * When the transcript next has to be drawn for a silence: a call turning amber,
 * or an amber one's minute count moving on; undefined when no call is
 * running.
 */
export const nextQuietChange = (calls: QuietCalls, now: number): number | undefined => {
  let soonest: number | undefined;
  for (const { at } of calls.values()) {
    const quiet = now - at;
    const next = quiet < TOOL_QUIET_MS ? at + TOOL_QUIET_MS : at + (Math.floor(quiet / 60_000) + 1) * 60_000;
    if (soonest === undefined || next < soonest) soonest = next;
  }
  return soonest;
};
