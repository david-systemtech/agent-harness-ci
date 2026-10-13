import { adminCall, clientLocalImportValues, uuidv7, type AdminOutcome } from "@agent-harness/client-runtime";
import type { StateImportFailure, StateImportReport } from "@agent-harness/contracts";
import { useEffect, useMemo, useState } from "react";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";

/** The last report this window heard from `stateImport.run`, and whether its window preferences were applied here. */
interface Heard {
  readonly environmentId: string;
  readonly report: StateImportReport | undefined;
  readonly clientLocalApplied: boolean;
}

/** The Carry over card's earlier work: the report its section shows, and the run that every button bringing it over shares. */
export interface EarlierWork {
  /** What the last run in this window brought over, or a preview would, with the retained failures kept up to date; undefined before one answered. */
  readonly report: StateImportReport | undefined;
  /** Whether the last run applied its window preferences to this window. */
  readonly clientLocalApplied: boolean;
  /** A run from this window is under way. */
  readonly busy: boolean;
  /** Runs `stateImport.run`, keeps its report for the section and applies the window preferences it hands this app. */
  run(dryRun: boolean): Promise<AdminOutcome<"stateImport.run">>;
}

/**
 * The earlier work (`stateImport.run`, ADR 0036) for the Carry over card: one
 * report however it was asked for, so the section's Preview and Bring it over
 * and the card's own Bring them over and Continue bringing it over
 * (setup-copy.md §5.3) all show what came over (#2098). A real run applies the
 * window preferences it hands this app. Retained failures from the environment
 * stream replace a real report's, and a completion anywhere replaces a
 * preview's (#1935).
 */
export const useEarlierWork = (environmentId: string): EarlierWork => {
  const runtime = useRuntime();
  const clock = useClock();
  const failures = useObservable(useMemo(() => runtime.projections.stateImportFailures(environmentId), [runtime, environmentId]));
  const finished = useObservable(useMemo(() => runtime.projections.stateImportFinished(environmentId), [runtime, environmentId]));
  const [heard, setHeard] = useState<Heard | undefined>(undefined);
  const [running, setRunning] = useState(0);
  const [, setMode] = usePresentation("lightOrDark");
  const [, setFontSize] = usePresentation("textSize");
  const [, setWidth] = usePresentation("readingWidth");
  const [, setThinking] = usePresentation("reasoningShown");
  const [, setSettingsRow] = usePresentation("settingsRow");
  const withFailed = (failed: readonly StateImportFailure[], previews: boolean) =>
    setHeard((current) => current?.report === undefined || (current.report.dryRun && !previews) ? current : { ...current, report: { ...current.report, failed: [...failed] } });
  // Snapshots refresh retained results without discarding failures found only by Preview.
  useEffect(() => withFailed(failures, false), [failures]);
  // An actual completion, including one in another window, replaces Preview's failed items too.
  useEffect(() => {
    if (finished !== null) withFailed(finished.failed, true);
  }, [finished]);
  const run = async (dryRun: boolean): Promise<AdminOutcome<"stateImport.run">> => {
    setRunning((count) => count + 1);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "stateImport.run", { commandId: uuidv7(clock.now()), dryRun }));
      if (!answer.ok) return answer;
      const values = clientLocalImportValues(runtime, environmentId, dryRun, answer.result);
      setHeard({ environmentId, report: answer.result, clientLocalApplied: values !== null });
      if (values !== null) {
        if (values.mode !== undefined) setMode(values.mode);
        if (values.fontSize !== undefined) setFontSize(Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, values.fontSize)));
        if (values.conversationWidth !== undefined) setWidth(values.conversationWidth);
        if (values.showThinking !== undefined) setThinking(values.showThinking);
        if (values.settingsRow !== undefined) setSettingsRow(values.settingsRow);
      }
      return answer;
    } finally {
      setRunning((count) => count - 1);
    }
  };
  // A report is the environment's it came from: another environment's card starts with none.
  const own = heard?.environmentId === environmentId ? heard : undefined;
  return { report: own?.report, clientLocalApplied: own?.clientLocalApplied ?? false, busy: running > 0, run };
};
