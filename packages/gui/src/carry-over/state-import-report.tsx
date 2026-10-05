import { STEP_LABELS, type StateImportCarried, type StateImportReport } from "@agent-harness/contracts";
import { ArrowRight } from "lucide-react";
import { CountGrid } from "./count-grid.js";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button } from "../ui/index.js";

const CARRIED_ROWS: readonly (readonly [keyof StateImportCarried, string])[] = [
  ["accounts", "Accounts"],
  ["archived", "Archived sessions"],
  ["pins", "Pins"],
  ["groups", "Groups"],
  ["forgeAccounts", "Forge accounts"],
  ["keyManagerConnections", "Key-manager connections"],
  ["banks", "Banks"],
  ["routines", "Routines"],
  ["instructions", "Instructions"],
  ["skillSources", "Skill sources"],
  ["alwaysOnSkills", "Always-on skills"],
  ["drafts", "Drafts"],
  ["devSites", "Dev sites"],
];

/** ADR 0036's four groups, including the steps where encrypted credentials must be entered again. */
export const StateImportResult = ({ report, clientLocalApplied }: { readonly report: StateImportReport; readonly clientLocalApplied: boolean }) => {
  const { choose } = useChecklist();
  const fontSize = report.clientLocal.fontSize;
  const appliedFontSize = fontSize === undefined ? undefined : Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, fontSize));
  return (
    <section aria-label="State import result" className="flex flex-col gap-3 rounded-lg border border-hairline bg-inset p-3 text-xs text-ink">
      <h4 className="text-xs font-medium">{report.dryRun ? "Dry run report" : "Import report"}</h4>
      {(report.sharedProjects ?? []).map((source) => <p key={source.sourceId}>{source.sourceId} shares a projects folder with {source.ownerSourceId}. Sessions and memory carry once, under the first source in source-id order.</p>)}
      <h5 className="text-xs font-medium">Carried</h5>
      {report.dryRun && <p className="text-ink-muted">These counts show what an import would carry. Nothing was written. A dry run does not test repository access or clear a failed import.</p>}
      <CountGrid label="Carried counts" rows={CARRIED_ROWS.map(([kind, label]) => [label, report.carried[kind]])} />
      <h5 className="text-xs font-medium">Re-enter</h5>
      {report.reEnter.length === 0 && <p>None.</p>}
      {report.reEnter.map((item, index) => (
        <Button variant="outline" title={`${STEP_LABELS[item.step]} · Tab, Enter or Space`} key={index} onClick={() => choose(item.step)}><ArrowRight aria-hidden="true" />{STEP_LABELS[item.step]}: {item.label}</Button>
      ))}
      <h5 className="text-xs font-medium">Arriving in milestone 2</h5>
      {report.later.length === 0 && <p>None.</p>}
      {report.later.map((item, index) => <p key={index}>{item.label} ({item.provider})</p>)}
      <h5 className="text-xs font-medium">Not carried</h5>
      {report.notCarried.length === 0 && <p>None.</p>}
      {report.notCarried.map((item, index) => (
        <div key={index}>
          <p>{item.label}: {item.count}</p>
          {item.step !== null && <Button variant="outline" title={`Open ${STEP_LABELS[item.step]} · Tab, Enter or Space`} onClick={() => item.step !== null && choose(item.step)}><ArrowRight aria-hidden="true" />Open {STEP_LABELS[item.step]}</Button>}
        </div>
      ))}
      {Object.keys(report.clientLocal).length > 0 && (
        <>
          <h5 className="text-xs font-medium">Client-local values {clientLocalApplied ? "applied" : "not applied"}</h5>
          {!clientLocalApplied && !report.dryRun && (
            <p className="text-ink-muted">These values belong to the environment's machine. Connect through its local grant to apply them on this client.</p>
          )}
          {report.clientLocal.mode !== undefined && <p>Theme mode: {report.clientLocal.mode}</p>}
          {fontSize !== undefined && (
            <p>Font size: {clientLocalApplied ? appliedFontSize : fontSize}{clientLocalApplied && appliedFontSize !== fontSize ? ` (source: ${fontSize})` : ""}</p>
          )}
          {report.clientLocal.conversationWidth !== undefined && <p>Conversation width: {report.clientLocal.conversationWidth}</p>}
          {report.clientLocal.showThinking !== undefined && <p>Show thinking: {report.clientLocal.showThinking ? "on" : "off"}</p>}
          {report.clientLocal.settingsRow !== undefined && <p>Last settings row: {report.clientLocal.settingsRow}</p>}
        </>
      )}
      {report.failed.map((item, index) => <p key={index} className="text-amber">{item.label}: {item.message}</p>)}
    </section>
  );
};
