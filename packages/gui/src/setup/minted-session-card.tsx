import { adminCall, isLive, isRegisteredStep, plainRefusal, uuidv4, uuidv7, type CardAction, type PlainRefusal } from "@agent-harness/client-runtime";
import type { PromptVariant, SetupTarget } from "@agent-harness/contracts";
import { BookOpen, ExternalLink } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { EscapeBoundary } from "../keys/key-dispatch.js";
import { SessionPane } from "../grid/session-pane.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import { sideColumnKey } from "../presentation.js";
import { NO_COLUMN, showPane } from "../side-column/column.js";
import { keepShownOnArrival } from "../side-column/side-column.js";
import { StatusLine } from "../status/status-line.js";
import { PaneLines } from "../session/pane-line.js";
import { PromptFieldsProvider } from "../prompt-card/prompt-card.js";
import { Dialog, DialogContent, DialogTrigger } from "../ui/dialog.js";
import "./authoring-conversation.css";
import { Button } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import type { StepCardProps } from "./cards.js";
import { useChecklist } from "./checklist-window.js";
import { useAuthoringRun } from "./authoring-run.js";
import { StepStatus } from "./step-status.js";
import { AuthoringPicker, useAuthoringPicker } from "./authoring-picker.js";
import { BankRefusal } from "../banks/bank-controls.js";
import { bankRefusal } from "../banks/bank-words.js";

/** Where Write it myself opens the artefact. A folder is the checkout's path on the environment, not its authoring worktree. */
export type SetupArtefact = { readonly kind: "folder"; readonly path: string } | { readonly kind: "instructions" };

/** What a step calls its conversation: the button that starts it and the one that opens it again, and the state it is in. */
export interface AuthoringWords {
  readonly start: string;
  readonly open: string;
  readonly running: string;
  readonly waiting: string;
  readonly landed: string;
  readonly review: string;
  readonly stopped: string;
}

const AUTHORING_WORDS: AuthoringWords = {
  start: "Start authoring", open: "Continue authoring", running: "running", waiting: "waiting for you",
  landed: "landed", review: "landed and awaiting review", stopped: "needs attention",
};

/** Shared authoring card, used by a step card for each subject it offers (#585, ADR 0019). */
export interface MintedSessionCardProps extends StepCardProps {
  readonly subject?: string;
  readonly artefact: SetupArtefact;
  /** The subject's own check outcome, where several subjects share a step. */
  readonly outcome?: "landed" | "landed and awaiting review";
  /** A session already attached by the caller, such as a reopened describe conversation. */
  readonly sessionId?: string;
  /** The step's own words for its conversation (setup-copy.md §5.8's for a notebook's description). */
  readonly words?: Partial<AuthoringWords>;
  /** What the first action does, said beside it before the step has a session. */
  readonly startLine?: string;
}

export const MintedSessionCard = ({ environmentId, step, subject, artefact, outcome, sessionId: attached, words: named, startLine }: MintedSessionCardProps) => {
  const words = { ...AUTHORING_WORDS, ...named };
  const runtime = useRuntime();
  const clock = useClock();
  const run = useAuthoringRun();
  const picker = useAuthoringPicker(environmentId);
  const key = `${environmentId} ${step.id} ${subject ?? ""}`;
  const sessionId = run.sessions.get(key) ?? attached;
  const [expanded, setExpanded] = useState(attached !== undefined);
  const [line, say] = useState<PlainRefusal>();
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
    if (!answer.ok) say(bankRefusal(answer.refusal, words.start));
    else if (answer.result !== undefined) {
      run.attach(`${environmentId} ${step.id} ${targetSubject ?? ""}`, answer.result.sessionId);
      setExpanded(true);
    }
  };
  const act = async (action: CardAction, targets: readonly SetupTarget[]) => {
    say(undefined);
    if (action === "start-over") return mint();
    if (action === "revise") return mint("revise", targets.find((target) => target.kind === "bank")?.id ?? subject);
    if (action === "write-it-myself") {
      if (artefact.kind === "instructions") return checklist.leave("knowledge.instructions", environmentId);
      const id = uuidv4();
      const answer = await runtime.commands.dispatch(environmentId, "sessions.create", { id, title: `Write ${step.label}`, workspace: { kind: "directory", path: artefact.path } });
      if (!answer.ok) return say(plainRefusal(answer.error, "Write it myself"));
      const manual = { environmentId, sessionId: id };
      const columnKey = sideColumnKey(manual);
      setColumns((columns) => ({ ...columns, [columnKey]: showPane(columns[columnKey] ?? NO_COLUMN, "files") }));
      keepShownOnArrival(manual);
      open(manual);
      checklist.leaveForMain();
      return;
    }
    if (action === "try-again") {
      const target = targets.find((target) => target.kind === "session")?.id ?? sessionId;
      if (target === undefined) return say({ line: "There is no conversation to continue. Choose Start again.", details: [] });
      const answer = await runtime.commands.dispatch(environmentId, "runs.send", { sessionId: target, text: "Continue where you stopped." });
      if (!answer.ok) say(plainRefusal(answer.error, "Continue it"));
      else { run.attach(key, target); setExpanded(true); }
    }
  };
  return <>
    <StepStatus environmentId={environmentId} step={step} cardAction={act} />
    <AuthoringPicker picker={picker} />
    {sessionId === undefined && !step.result?.actions.includes("start-over") && <>
      {startLine !== undefined && <p className="text-sm text-ink">{startLine}</p>}
      <Button title={`${words.start} · Tab, Enter or Space`} className="self-start" onClick={() => void mint()}><BookOpen aria-hidden="true" />{words.start}</Button>
    </>}
    {line !== undefined && <BankRefusal refusal={line} />}
    {sessionId !== undefined && <MintedConversation key={sessionId} environmentId={environmentId} sessionId={sessionId} expanded={expanded} setExpanded={setExpanded} words={words} outcome={outcome ?? (step.result?.state === "done" ? "landed" : undefined)} />}
  </>;
};

const MintedConversation = ({ environmentId, sessionId, expanded, setExpanded, words, outcome }: { readonly environmentId: string; readonly sessionId: string; readonly expanded: boolean; setExpanded(expanded: boolean): void; readonly words: AuthoringWords; readonly outcome: "landed" | "landed and awaiting review" | undefined }) => {
  const web = useShell() === undefined;
  const [viewportHeight, setViewportHeight] = useState<number>();
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resized = () => setViewportHeight(viewport.height);
    resized();
    viewport.addEventListener("resize", resized);
    return () => viewport.removeEventListener("resize", resized);
  }, []);
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const open = useOpenInFocusedPane();
  const checklist = useChecklist();
  const session = { environmentId, sessionId };
  return <>
    <PromptFieldsProvider><Dialog open={expanded} onOpenChange={setExpanded}>
      <DialogTrigger asChild><Button variant="outline" className="self-start">{words.open}</Button></DialogTrigger>
      <EscapeBoundary>{onEscapeKeyDown => <DialogContent onEscapeKeyDown={onEscapeKeyDown} title="Authoring conversation" data-authoring-dialog className="authoring-dialog left-0 top-0 translate-x-0 translate-y-0 sm:left-1/2 sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2" style={viewportHeight === undefined ? undefined : { "--authoring-viewport-height": `${viewportHeight}px` } as CSSProperties}>
        <section aria-label="Authoring conversation" data-authoring-frame data-web-client={web ? "" : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-hairline bg-panel"><PaneLines><SessionPane authoring session={session} focused={true} marked={false} close={() => undefined} header={<header data-authoring-header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-hairline bg-raised/50 px-3 py-2">
    <h3 className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{projection.summary?.title ?? "Authoring conversation"}</h3>
    <p role="status" aria-label="Authoring status" className="sr-only text-2xs text-ink-muted sm:not-sr-only">{projection.parkedPrompts.length > 0 ? words.waiting : isLive(runs.state) ? words.running : outcome === "landed" ? words.landed : outcome === "landed and awaiting review" ? words.review : projection.draft !== null ? words.waiting : words.stopped}</p>
    <Button variant="outline" size="sm" aria-label="Open in the main window" title="Open in the main window · Tab, Enter or Space" onClick={() => { open(session); checklist.leaveForMain(); }}><ExternalLink aria-hidden="true" /><span className="hidden sm:inline">Open in the main window</span></Button>
    <StatusLine environmentId={environmentId} sessionId={sessionId} />
  </header>} /></PaneLines></section>
      </DialogContent>}</EscapeBoundary>
    </Dialog></PromptFieldsProvider>
  </>;
};
