import { askDetail, bulkAsks, bulkQuestion, decidable, ttlWords, type ParkedAsk, type PromptTarget } from "@agent-harness/client-runtime";
import { CircleHelp, Check, X, ExternalLink } from "lucide-react";
import type { PromptKind } from "@agent-harness/contracts";
import { useState } from "react";
import { EnvironmentBadge } from "../connections/environment-badge.js";
import { useOpenInFocusedPane } from "../grid/open-session.js";
import { Answer } from "../prompt-card/answer-button.js";
import { useAnswers, type Answers } from "../prompt-card/answering.js";
import { Dialog, DialogContent, DialogTrigger, MenuItem, Tooltip } from "../ui/index.js";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogTrigger, DialogFooter } from "../ui/dialog.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * Parked asks (docs/specs/gui.md, "Parked asks, attention and notices";
 * story 10; #149): the header's button counts the parked prompts of every
 * enabled environment (`projections.runs`' parked asks) and opens one view
 * of them, oldest first. A row has its environment's badge, its session's
 * title, its kind, what it asks (`askDetail`) and its TTL on its
 * environment's clock (the runtime's countdown).
 *
 * A permission or denylist row is allowed once or denied in place, through
 * the same answers as the card (`useAnswers`), an Allow never pressed by a
 * bare Enter; a question or a plan is only opened, its answer being an
 * option or a mode. Every row opens its session in the focused pane, which
 * closes the view. Allow all and Deny all answer every permission row, never
 * a denylist row, and only with two or more (`bulkAsks`), after one
 * confirmation that names how many; they answer the rows the confirmation
 * named that are still waiting, never one that parked while it was asked. A
 * row answered from here leaves at once and comes back only when its answer
 * fails, with why.
 */

/** A prompt's kind, as a row names it. */
const KIND_WORDS: Readonly<Record<PromptKind, string>> = { permission: "Permission", denylist: "Denylist", question: "Question", plan: "Plan" };

/** Where an ask is parked, as the answers key it. */
const targetOf = (ask: ParkedAsk): PromptTarget => ({ environmentId: ask.environmentId, sessionId: ask.sessionId, promptId: ask.promptId });

/** The header's Parked asks button, with the count of parked prompts across every environment, which opens the view. */
export const ParkedAsksButton = ({ menu = false }: { readonly menu?: boolean }) => {
  const runtime = useRuntime();
  const { parkedAsks } = useObservable(runtime.projections.runs);
  // Held with the button, not the view, so a row answered from here stays off the view while it is closed and opened again.
  const answers = useAnswers(parkedAsks.map(targetOf));
  const [open, setOpen] = useState(false);
  const count = parkedAsks.length;

  const trigger = <DialogTrigger asChild>
    {menu ? <MenuItem aria-label={count === 0 ? "Parked asks" : `Parked asks, ${count} waiting`} onSelect={(event) => event.preventDefault()}><CircleHelp aria-hidden="true" />Parked asks{count > 0 && <span className="ml-auto text-amber">{count}</span>}</MenuItem> :
      <Button icon={CircleHelp} aria-label={`Parked asks, ${count} waiting`} size="xs" className="h-[22px] border border-amber/45 bg-amber/10 text-amber hover:bg-amber/20">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-amber" /><span>{count} waiting</span>
      </Button>}
  </DialogTrigger>;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {(menu || count > 0) && (menu ? <Tooltip content={`Parked asks · ${count} waiting`}>{trigger}</Tooltip> : trigger)}
      {open && <ParkedAsksView asks={parkedAsks} answers={answers} close={() => setOpen(false)} />}
    </Dialog>
  );
};

/** The view: every parked ask, less the ones answered from here, with Allow all and Deny all over them. */
const ParkedAsksView = ({ asks, answers, close }: { readonly asks: readonly ParkedAsk[]; readonly answers: Answers; readonly close: () => void }) => {
  const shown = asks.filter((ask) => !answers.isSent(targetOf(ask)));
  const bulk = bulkAsks(shown);
  return (
    <DialogContent title="Parked asks" className="max-w-[32rem] max-h-[calc(100dvh-4rem)] overflow-y-auto">
      {shown.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing is waiting on you.</p>
      ) : (
        <>
          {bulk.length > 0 && (
            <div className="flex gap-2">
              <BulkAnswer decision="allow" asks={bulk} shown={shown} answers={answers} />
              <BulkAnswer decision="deny" asks={bulk} shown={shown} answers={answers} />
            </div>
          )}
          <ul aria-label="Parked asks" className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {shown.map((ask) => (
              <AskRow key={`${ask.environmentId} ${ask.promptId}`} ask={ask} answers={answers} close={close} />
            ))}
          </ul>
        </>
      )}
    </DialogContent>
  );
};

/** Answers the ask, unless its connection cannot answer now, which its row then says. */
const useAnswer = (answers: Answers) => {
  const runtime = useRuntime();
  return (ask: ParkedAsk, decision: "allow" | "deny") => {
    const target = targetOf(ask);
    const offer = runtime.capability(ask.environmentId, "permissions.prompts.answer");
    if (offer.status === "absent") return answers.say(target, `Not answered: ${offer.message}`);
    answers.answer(target, { decision });
  };
};

/** One parked ask: where and what it is, how long it has, and what can be done about it from here. */
const AskRow = ({ ask, answers, close }: { readonly ask: ParkedAsk; readonly answers: Answers; readonly close: () => void }) => {
  const runtime = useRuntime();
  const views = useObservable(runtime.projections.environments);
  const openInPane = useOpenInFocusedPane();
  const answer = useAnswer(answers);
  const offer = runtime.capability(ask.environmentId, "permissions.prompts.answer");
  const dim = offer.status === "absent";
  const line = answers.lineOf(targetOf(ask));
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-hairline bg-inset/60 p-3 text-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <EnvironmentBadge view={views.find((view) => view.environmentId === ask.environmentId)} />
        <span className="min-w-0 truncate font-medium text-ink">{ask.title ?? "a session"}</span>
        <span className="text-xs text-ink-muted">{KIND_WORDS[ask.kind]}</span>
      </div>
      <p className="whitespace-pre-wrap break-words text-ink">{askDetail(ask)}</p>
      {ask.ttl !== null && <span className="text-xs text-ink-muted">{ttlWords(ask.ttl.remainingMs)}</span>}
      {line !== undefined && (
        <p role="status" className="text-xs text-signal">
          {line}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {decidable(ask.kind) && (
          <>
            <Answer dim={dim} approves onClick={() => answer(ask, "allow")}>
              Allow
            </Answer>
            <Answer dim={dim} onClick={() => answer(ask, "deny")}>
              Deny
            </Answer>
          </>
        )}
        <Button icon={ExternalLink}
          onClick={() => {
            close();
            openInPane({ environmentId: ask.environmentId, sessionId: ask.sessionId });
          }}
        >
          Open
        </Button>
      </div>
    </li>
  );
};

interface BulkAnswerProps {
  readonly decision: "allow" | "deny";
  /** The rows it answers: every permission row listed. */
  readonly asks: readonly ParkedAsk[];
  /** Every row listed, for the denylist rows it passes over. */
  readonly shown: readonly ParkedAsk[];
  readonly answers: Answers;
}

/** Allow all or Deny all, behind one confirmation naming how many it answers and the denylist rows it leaves. */
const BulkAnswer = ({ decision, asks, shown, answers }: BulkAnswerProps) => {
  const answer = useAnswer(answers);
  // The rows the confirmation names, held from when it was asked: a prompt parking meanwhile is never answered unseen.
  const [named, setNamed] = useState<readonly ParkedAsk[] | undefined>(undefined);
  const passed = shown.filter((ask) => ask.kind === "denylist").length;
  const verb = decision === "allow" ? "Allow" : "Deny";
  const confirm = () => {
    const still = new Set(shown.map((ask) => `${ask.environmentId} ${ask.promptId}`));
    for (const ask of named ?? []) if (still.has(`${ask.environmentId} ${ask.promptId}`)) answer(ask, decision);
    setNamed(undefined);
  };
  return (
    <AlertDialog open={named !== undefined} onOpenChange={(opened) => setNamed(opened ? asks : undefined)}>
      <AlertDialogTrigger asChild>
        <Button icon={decision === "allow" ? Check : X} variant="outline">{verb} all</Button>
      </AlertDialogTrigger>
      {named !== undefined && <AlertDialogContent title={bulkQuestion(decision, named.length)} description={passed === 0 ? "Only the permission prompts named in this confirmation are answered." : `${passed === 1 ? "The denylist prompt stays" : `The ${passed} denylist prompts stay`}: each is answered on its own.`}>
        <DialogFooter>
          <AlertDialogCancel asChild><Button icon={X} keys="Escape" onClick={() => setNamed(undefined)}>Cancel</Button></AlertDialogCancel>
          <Button icon={decision === "allow" ? Check : X} variant={decision === "allow" ? "default" : "destructive"} onKeyDown={(event) => { if (decision === "allow" && event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) event.preventDefault(); }} keys={decision === "allow" ? "Space" : "Enter / Space"} onClick={confirm}>{verb} {named.length}</Button>
        </DialogFooter>
      </AlertDialogContent>}
    </AlertDialog>
  );
};
