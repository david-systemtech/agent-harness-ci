import { adminCall, isLive, isRegisteredStep, uuidv4, uuidv7, type CardAction } from "@agent-harness/client-runtime";
import type { PromptVariant, SetupTarget } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { SessionPane } from "../grid/session-pane.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import { sideColumnKey } from "../presentation.js";
import { NO_COLUMN, showPane } from "../side-column/column.js";
import { PaneLines } from "../session/pane-line.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";
import type { StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { useAuthoringRun } from "./authoring-run.js";
import { StepStatus } from "./step-status.js";
import { AuthoringPicker, useAuthoringPicker } from "./authoring-picker.js";

/** Where Write it myself opens the artefact. A folder is the checkout's path on the environment, not its authoring worktree. */
export type SetupArtefact = { readonly kind: "folder"; readonly path: string } | { readonly kind: "instructions" };

/** Shared authoring card, used by a step card for each subject it offers (#585, ADR 0019). */
export interface MintedSessionCardProps extends StepCardProps {
  readonly subject?: string;
  readonly artefact: SetupArtefact;
  /** The subject's own check outcome, where several subjects share a step. */
  readonly outcome?: "landed" | "landed and awaiting review";
  /** A session already attached by the caller, such as a reopened describe conversation. */
  readonly sessionId?: string;
  /** The step's first authoring action, before it has a session. */
  readonly startLabel?: string;
}

export const MintedSessionCard = ({ environmentId, step, subject, artefact, outcome, sessionId: attached, startLabel = "Start authoring" }: MintedSessionCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const run = useAuthoringRun();
  const picker = useAuthoringPicker(environmentId);
  const key = `${environmentId} ${step.id} ${subject ?? ""}`;
  const sessionId = run.sessions.get(key) ?? attached;
  const [line, say] = useState<string>();
  const open = useOpenInFocusedPane();
  const checklist = useChecklist();
  const [, setColumns] = usePresentation("sideColumns");
  const mint = async (variant: PromptVariant = "first", targetSubject: string | undefined = subject) => {
    const mintStep = step.id;
    if (!isRegisteredStep(mintStep)) return;
    say(undefined);
    const answer = await adminCall(() => runtime.requests.call(environmentId, "setup.mint", {
      commandId: uuidv7(clock.now()), step: mintStep, variant,
      ...(targetSubject !== undefined && { subject: targetSubject }),
      ...(picker.view.account.value !== null && { account: picker.view.account.value.id }),
      ...(picker.view.model.value !== null && { model: picker.view.model.value.id }),
      ...(picker.effort !== "" && { effort: picker.effort }),
    }));
    if (!answer.ok) say(answer.line);
    else if (answer.result !== undefined) run.attach(`${environmentId} ${step.id} ${targetSubject ?? ""}`, answer.result.sessionId);
  };
  const act = async (action: CardAction, targets: readonly SetupTarget[]) => {
    say(undefined);
    if (action === "start-over") return mint();
    if (action === "revise") return mint("revise", targets.find((target) => target.kind === "bank")?.id ?? subject);
    if (action === "write-it-myself") {
      if (artefact.kind === "instructions") return checklist.leave("knowledge.instructions", environmentId);
      const id = uuidv4();
      const answer = await runtime.commands.dispatch(environmentId, "sessions.create", { id, title: `Write ${step.label}`, workspace: { kind: "directory", path: artefact.path } });
      if (!answer.ok) return say(answer.error.message);
      const manual = { environmentId, sessionId: id };
      const columnKey = sideColumnKey(manual);
      setColumns((columns) => ({ ...columns, [columnKey]: showPane(columns[columnKey] ?? NO_COLUMN, "files") }));
      open(manual);
      checklist.leaveForMain();
      return;
    }
    if (action === "try-again") {
      const target = targets.find((target) => target.kind === "session")?.id ?? sessionId;
      if (target === undefined) return say("No authoring session is attached to this card.");
      const answer = await runtime.commands.dispatch(environmentId, "runs.send", { sessionId: target, text: "Continue where you stopped." });
      if (!answer.ok) say(answer.error.message);
      else run.attach(key, target);
    }
  };
  return <>
    <StepStatus environmentId={environmentId} step={step} cardAction={act} />
    <AuthoringPicker picker={picker} />
    {sessionId === undefined && !step.result?.actions.includes("start-over") && <Button onClick={() => void mint()}>{startLabel}</Button>}
    {line !== undefined && <p role="alert">{line}</p>}
    {sessionId !== undefined && <MintedConversation environmentId={environmentId} sessionId={sessionId} outcome={outcome ?? (step.result?.state === "done" ? "landed" : undefined)} />}
  </>;
};

const MintedConversation = ({ environmentId, sessionId, outcome }: { readonly environmentId: string; readonly sessionId: string; readonly outcome: "landed" | "landed and awaiting review" | undefined }) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const open = useOpenInFocusedPane();
  const checklist = useChecklist();
  const session = { environmentId, sessionId };
  return <PaneLines><SessionPane session={session} focused={true} marked={false} close={() => undefined} header={<header>
    <p role="status" aria-label="Authoring status">{projection.parkedPrompts.length > 0 ? "waiting for you" : isLive(runs.state) ? "running" : outcome ?? (projection.draft !== null ? "waiting for you" : "needs attention")}</p>
    <Button onClick={() => { open(session); checklist.leaveForMain(); }}>Open in the main window</Button>
  </header>} /></PaneLines>;
};
