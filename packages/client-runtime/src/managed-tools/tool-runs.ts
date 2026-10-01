import { ToolRunFinishedPayload, ToolRunStartedPayload, type EventEnvelope, type InstallableToolName } from "@agent-harness/contracts";
import { writable, type Observable, type Writable } from "../observable.js";

/**
 * The tool runs an environment's own stream tells of (key-managers spec,
 * "Managed tools"; #376, #426): the run under way, as `tool.run-started`
 * said it, and each tool's last run heard to finish, with how its command
 * ended and what the verify command after it found (`tool.run-finished`),
 * so a row shows the verification beside the probe the run caused, and a
 * window can draw the tool terminal of a run another window started.
 * Folded from the stream, history included, never asked; held in memory,
 * never stored.
 */

export interface ToolRunsView {
  /** The run under way on the environment; null when none is heard of. */
  readonly running: ToolRunStartedPayload | null;
  /** Each tool's last run heard to finish, by the tool it installed or updated. */
  readonly finished: Partial<Readonly<Record<InstallableToolName, ToolRunFinishedPayload>>>;
}

export interface ToolRuns {
  /** An event on the environment's own stream, news or history. */
  heard(environmentId: string, event: EventEnvelope): void;
  view(environmentId: string): Observable<ToolRunsView>;
  /** Lets go of an environment's runs: it was removed. */
  forget(environmentId: string): void;
}

const NONE: ToolRunsView = { running: null, finished: {} };

export const createToolRuns = (report: (error: unknown) => void): ToolRuns => {
  const views = new Map<string, Writable<ToolRunsView>>();
  const of = (environmentId: string): Writable<ToolRunsView> => {
    let view = views.get(environmentId);
    if (view === undefined) views.set(environmentId, (view = writable(NONE, report)));
    return view;
  };
  return {
    heard(environmentId, event) {
      if (event.type === "tool.run-started") {
        const started = ToolRunStartedPayload.safeParse(event.payload);
        if (started.success) of(environmentId).update((view) => ({ ...view, running: started.data }));
      } else if (event.type === "tool.run-finished") {
        const finished = ToolRunFinishedPayload.safeParse(event.payload);
        if (!finished.success) return;
        of(environmentId).update((view) => ({
          running: view.running?.terminalId === finished.data.terminalId ? null : view.running,
          finished: { ...view.finished, [finished.data.tool]: finished.data },
        }));
      }
    },
    view: of,
    forget(environmentId) {
      views.delete(environmentId);
    },
  };
};
