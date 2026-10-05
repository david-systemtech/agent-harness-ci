import { AccessUnavailable } from "../connections/limited-access.js";
import { adminCall, clientLocalImportValues, uuidv7 } from "@agent-harness/client-runtime";
import type { StateImportHoldings, StateImportReport } from "@agent-harness/contracts";
import { Download, ScanSearch } from "lucide-react";
import { CountGrid } from "./count-grid.js";
import { useMemo, useState } from "react";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import { StateImportResult } from "./state-import-report.js";

/** The state import is offered only when the environment serves it and finds a source folder (ADR 0036). */
export const StateImportSection = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  return runtime.capability(environmentId, "stateImport").status === "present"
    ? <DetectedStateImport key={environmentId} environmentId={environmentId} />
    : null;
};

const foundCount = (count: number | null) => count === null ? "unreadable" : count;
const Holdings = ({ holds }: { readonly holds: StateImportHoldings }) => (
  <CountGrid label="Source holdings" rows={[["Profiles", foundCount(holds.profiles)], ["Banks", foundCount(holds.banks)], ["Routines", foundCount(holds.routines)], ["Instructions", foundCount(holds.instructions)], ["Skill sources", foundCount(holds.skillSources)], ["Connections", foundCount(holds.connections)]]} />
);

const DetectedStateImport = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const found = useObservable(useMemo(() => runtime.requests.cached(environmentId, "stateImport.detect", {}), [runtime, environmentId]));
  const clock = useClock();
  const [report, setReport] = useState<StateImportReport | undefined>(undefined);
  const [line, say] = useState<string | undefined>(undefined);
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
    say(undefined);
    const answer = await adminCall(() => runtime.requests.call(environmentId, "stateImport.run", { commandId: uuidv7(clock.now()), dryRun }));
    setBusy(false);
    if (!answer.ok) return say(`Not imported: ${answer.line}`);
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
  if (detection === null || (detection.dataFolder === null && detection.terminalFolder === null)) return null;
  return (
    <section aria-label="State import" className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
      <h3 className="text-sm font-medium text-ink">State import</h3>
      {detection.dataFolder !== null && (
        <>
          <p className="text-sm text-ink-muted">Data folder: {detection.dataFolder.path}</p>
          <Holdings holds={detection.dataFolder.holds} />
        </>
      )}
      {detection.terminalFolder !== null && <p className="text-sm text-ink-muted">Terminal-client state folder: {detection.terminalFolder.path}</p>}
      {admin.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" title="Dry run · Tab, Enter or Space" disabled={busy || admin.status === "absent"} onClick={() => void run(true)}><ScanSearch aria-hidden="true" />Dry run</Button>
        <Button variant="default" title="Import · Tab, Enter or Space" disabled={busy || admin.status === "absent"} onClick={() => void run(false)}><Download aria-hidden="true" />Import</Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {report !== undefined && <StateImportResult report={report} clientLocalApplied={clientLocalApplied} />}
    </section>
  );
};
