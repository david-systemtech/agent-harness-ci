import { AccessUnavailable } from "../connections/limited-access.js";
import { adminCall, clientLocalImportValues, plainRefusal, uuidv7, type PlainRefusal } from "@agent-harness/client-runtime";
import type { StateImportReport } from "@agent-harness/contracts";
import { Download, ScanSearch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { TechnicalDetails } from "../setup/details.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { foundDetails, foundLine } from "./earlier-work-words.js";
import { StateImportFailures, StateImportResult, useEarlierWorkDetails } from "./state-import-report.js";

/** The earlier-work section (the state import) is offered when the environment serves it and finds a source folder or retains failed items (ADR 0036). */
export const StateImportSection = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  return runtime.capability(environmentId, "stateImport").status === "present"
    ? <DetectedStateImport key={environmentId} environmentId={environmentId} />
    : null;
};

/** The buttons' names, which a refusal's line asks the person to choose again (setup-copy.md §5.3). */
const PREVIEW = "Preview";
const BRING_IT_OVER = "Bring it over";

/**
 * setup-copy.md §5.3's earlier work: one line saying what was found, its
 * folders under Details, Preview and Bring it over, and the report, whose
 * failed items each say their own fix.
 */
const DetectedStateImport = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const found = useObservable(useMemo(() => runtime.requests.cached(environmentId, "stateImport.detect", {}), [runtime, environmentId]));
  const failures = useObservable(useMemo(() => runtime.projections.stateImportFailures(environmentId), [runtime, environmentId]));
  const clock = useClock();
  const detailsOf = useEarlierWorkDetails(environmentId);
  const [report, setReport] = useState<StateImportReport | undefined>(undefined);
  // A later import, including one in another window, replaces a real report's failed items.
  useEffect(() => {
    setReport((current) => current === undefined || current.dryRun ? current : { ...current, failed: [...failures] });
  }, [failures]);
  const [refusal, setRefusal] = useState<PlainRefusal | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [clientLocalApplied, setClientLocalApplied] = useState(false);
  const [, setMode] = usePresentation("lightOrDark");
  const [, setFontSize] = usePresentation("textSize");
  const [, setWidth] = usePresentation("readingWidth");
  const [, setThinking] = usePresentation("reasoningShown");
  const [, setSettingsRow] = usePresentation("settingsRow");
  const admin = runtime.capability(environmentId, "stateImport.run");
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setRefusal(undefined);
    const answer = await adminCall(() => runtime.requests.call(environmentId, "stateImport.run", { commandId: uuidv7(clock.now()), dryRun }));
    setBusy(false);
    if (!answer.ok) return setRefusal(plainRefusal(answer.refusal, dryRun ? PREVIEW : BRING_IT_OVER));
    setReport(answer.result);
    const values = clientLocalImportValues(runtime, environmentId, dryRun, answer.result);
    setClientLocalApplied(values !== null);
    if (values !== null) {
      if (values.mode !== undefined) setMode(values.mode);
      if (values.fontSize !== undefined) setFontSize(Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, values.fontSize)));
      if (values.conversationWidth !== undefined) setWidth(values.conversationWidth);
      if (values.showThinking !== undefined) setThinking(values.showThinking);
      if (values.settingsRow !== undefined) setSettingsRow(values.settingsRow);
    }
  };
  const detection = found.result;
  const sourceFound = detection !== null && (detection.dataFolder !== null || detection.terminalFolder !== null);
  if (!sourceFound && failures.length === 0) return null;
  const line = sourceFound ? foundLine(detection) : null;
  return (
    <section aria-label="Earlier work" data-earlier-work className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
      {line !== null && detection !== null && <>
        <p className="text-sm text-ink">{line}</p>
        <TechnicalDetails {...detailsOf(line, foundDetails(detection))} />
      </>}
      {admin.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={admin}><p className="text-sm text-amber">You can look but not change this. {admin.message}</p></AccessUnavailable>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" title={`${PREVIEW} · Tab, Enter or Space`} disabled={!sourceFound || busy || admin.status === "absent"} onClick={() => void run(true)}><ScanSearch aria-hidden="true" />{PREVIEW}</Button>
        <Button variant="default" title={`${BRING_IT_OVER} · Tab, Enter or Space`} disabled={!sourceFound || busy || admin.status === "absent"} onClick={() => void run(false)}><Download aria-hidden="true" />{BRING_IT_OVER}</Button>
      </div>
      {refusal !== undefined && <div className="flex flex-col gap-1">
        <p role="alert" className="text-sm text-signal"><span className="sr-only">Error: </span>{refusal.line}</p>
        <TechnicalDetails {...detailsOf(refusal.line, refusal.details)} />
      </div>}
      {(report === undefined || report.dryRun) && failures.length > 0 && <div className="flex flex-col gap-3 rounded-lg border border-hairline bg-inset p-3 text-xs text-ink">
        <h4 className="text-xs font-medium">Needs you</h4>
        <StateImportFailures environmentId={environmentId} failures={failures} />
      </div>}
      {report !== undefined && <StateImportResult environmentId={environmentId} report={report} clientLocalApplied={clientLocalApplied} />}
    </section>
  );
};
