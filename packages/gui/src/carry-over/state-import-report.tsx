import { LOCAL_PLACEHOLDER_ID } from "@agent-harness/client-runtime";
import { SETTINGS_ROWS, STEP_LABELS, type StateImportFailure, type StateImportReport, type StepId } from "@agent-harness/contracts";
import { ArrowRight } from "lucide-react";
import { useId, type ReactNode } from "react";
import { nameOf } from "../connections/words.js";
import { TEXT_SIZE_LEAST, TEXT_SIZE_MOST } from "../presentation.js";
import { useChecklist } from "../setup/checklist-window.js";
import { TechnicalDetails, type TechnicalDetailsProps } from "../setup/details.js";
import { Button } from "../ui/index.js";
import { useClientVersion, useObservable, useRuntime, useShell } from "../window-context.js";
import { carriedInWords, previewLine } from "./earlier-work-words.js";

/**
 * Details for the earlier-work section (setup-copy.md §3): this app, the
 * computer, the plain line and the facts behind it, with Copy details
 * through the shell's clipboard where it has one.
 */
export const useEarlierWorkDetails = (environmentId: string): ((line: string, details: readonly string[]) => TechnicalDetailsProps) => {
  const runtime = useRuntime();
  const shell = useShell();
  const version = useClientVersion();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (line, details) => ({
    report: { app: { version, platform: shell === undefined ? "web" : "desktop" }, ...(environment !== undefined && { computer: { name: nameOf(environment) } }), line, details },
    copy: async (text) => {
      if (clipboard === undefined) throw new Error("This app has no clipboard here.");
      await clipboard.writeText(text);
    },
  });
};

/** A cross-step fix inside Set up (setup-copy.md §3): Go to {step}, described by the line it fixes. */
const GoTo = ({ step, describedBy }: { readonly step: StepId; readonly describedBy: string }) => {
  const { choose } = useChecklist();
  return (
    <Button variant="outline" size="xs" title={`Go to ${STEP_LABELS[step]} · Tab, Enter or Space`} aria-describedby={describedBy} onClick={() => choose(step)}>
      <ArrowRight aria-hidden="true" />Go to {STEP_LABELS[step]}
    </Button>
  );
};

/** One line of the report with what it offers beside it. */
const Item = ({ line, step, children }: { readonly line: ReactNode; readonly step?: StepId | null | undefined; readonly children?: ReactNode }) => {
  const id = useId();
  return (
    <li className="flex min-w-0 flex-col items-start gap-1">
      <span id={id}>{line}</span>
      {step != null && <GoTo step={step} describedBy={id} />}
      {children}
    </li>
  );
};

/** A failed item: its plain line in words and colour, its own fix (Go to Forges, Go to Skills) or its facts under Details (setup-copy.md §5.3). */
const Failure = ({ environmentId, failure }: { readonly environmentId: string; readonly failure: StateImportFailure }) => {
  const detailsOf = useEarlierWorkDetails(environmentId);
  const line = `${failure.label}: ${failure.message}`;
  return (
    <Item line={<span className="text-amber"><span className="sr-only">Error: </span><span>{line}</span></span>} step={failure.step}>
      {failure.details !== undefined && failure.details.length > 0 && <TechnicalDetails {...detailsOf(line, failure.details)} />}
    </Item>
  );
};

/** Two source profiles sharing a projects folder, each by its label (#1726); their source ids wait under Details (#1800). */
const SharedProjects = ({ environmentId, source }: { readonly environmentId: string; readonly source: NonNullable<StateImportReport["sharedProjects"]>[number] }) => {
  const detailsOf = useEarlierWorkDetails(environmentId);
  const line = `${source.label} and ${source.ownerLabel} share one projects folder, so their chats and notes come over once, with ${source.ownerLabel}.`;
  return (
    <div className="flex flex-col gap-1">
      <p>{line}</p>
      <TechnicalDetails {...detailsOf(line, [`${source.label} source id: ${source.sourceId}`, `${source.ownerLabel} source id: ${source.ownerSourceId}`])} />
    </div>
  );
};

const List = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => <ul aria-label={label} className="flex flex-col gap-2">{children}</ul>;

const Group = ({ heading, children }: { readonly heading: string; readonly children: ReactNode }) => (
  <>
    <h4 className="text-xs font-medium">{heading}</h4>
    <List label={heading}>{children}</List>
  </>
);

const settingsRowLabel = (id: string): string => SETTINGS_ROWS.find((row) => row.id === id)?.label ?? id;

/**
 * What bringing the earlier work over did, or a preview would do
 * (setup-copy.md §5.3; ADR 0036's four groups): Brought over, Needs you
 * (what must be entered again, and each failed item with its own fix),
 * Not supported yet, Not brought over, and the window preferences.
 */
export const StateImportResult = ({ environmentId, report, clientLocalApplied }: { readonly environmentId: string; readonly report: StateImportReport; readonly clientLocalApplied: boolean }) => {
  const runtime = useRuntime();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const { clientLocal } = report;
  const appliedFontSize = clientLocal.fontSize === undefined ? undefined : Math.min(TEXT_SIZE_MOST, Math.max(TEXT_SIZE_LEAST, clientLocal.fontSize));
  const shownFontSize = clientLocalApplied ? appliedFontSize : clientLocal.fontSize;
  return (
    <section aria-label="Earlier work result" data-earlier-work-result className="flex flex-col gap-3 rounded-lg border border-hairline bg-inset p-3 text-xs text-ink">
      {report.dryRun
        ? <p>{previewLine(report.carried)}</p>
        : <>
            <h4 className="text-xs font-medium">Brought over</h4>
            <p>{carriedInWords(report.carried) ?? "Everything is already here."}</p>
          </>}
      {(report.sharedProjects ?? []).map((source) => <SharedProjects key={source.sourceId} environmentId={environmentId} source={source} />)}
      {(report.reEnter.length > 0 || report.failed.length > 0) && <h4 className="text-xs font-medium">Needs you</h4>}
      {report.reEnter.length > 0 && <List label="Needs you">{report.reEnter.map((item, index) => <Item key={index} line={item.label} step={item.step} />)}</List>}
      {report.failed.length > 0 && (
        <div role="alert">
          <List label="Did not come over">{report.failed.map((failure, index) => <Failure key={index} environmentId={environmentId} failure={failure} />)}</List>
        </div>
      )}
      {report.later.length > 0 && <Group heading="Not supported yet">{report.later.map((item, index) => <Item key={index} line={item.label} />)}</Group>}
      {report.notCarried.length > 0 && <Group heading="Not brought over">{report.notCarried.map((item, index) => <Item key={index} line={`${item.label}: ${item.count}`} step={item.step} />)}</Group>}
      {Object.keys(clientLocal).length > 0 && (
        <>
          <h4 className="text-xs font-medium">Window preferences</h4>
          {clientLocalApplied
            ? <p className="text-ink-muted">Applied to this window.</p>
            : !report.dryRun && <p className="text-ink-muted">These apply only on {environment === undefined ? "that computer" : `${nameOf(environment)}'s own computer`}.</p>}
          {clientLocal.mode !== undefined && <p>Theme: {clientLocal.mode}</p>}
          {shownFontSize !== undefined && <p>Text size: {shownFontSize}{shownFontSize !== clientLocal.fontSize ? ` (was ${clientLocal.fontSize})` : ""}</p>}
          {clientLocal.conversationWidth !== undefined && <p>Reading width: {clientLocal.conversationWidth}</p>}
          {clientLocal.showThinking !== undefined && <p>Show thinking: {clientLocal.showThinking ? "on" : "off"}</p>}
          {clientLocal.settingsRow !== undefined && <p>Last open in Settings: {settingsRowLabel(clientLocal.settingsRow)}</p>}
        </>
      )}
    </section>
  );
};
