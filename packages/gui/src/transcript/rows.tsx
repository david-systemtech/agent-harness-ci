import {
  attachmentChip,
  checkStatus,
  endWords,
  environmentMessage,
  fileUndoWords,
  oneLine,
  promptsIn,
  turnFacts,
  updateInterruptedText,
  type AssistantEntry,
  type ChecksView,
  type PromptEntry,
  type SubagentEntry,
  type TranscriptRow,
  type UserMessageEntry,
} from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { memo, useState, type ReactNode } from "react";
import { Brain, Info, Terminal, TriangleAlert, Undo2 } from "lucide-react";
import { ForkedRow } from "../fork-rewind/forked.js";
import { MessageVerbs } from "../fork-rewind/message-verbs.js";
import { UndoOnFold } from "../fork-rewind/rewound.js";
import { classes } from "../ui/classes.js";
import { Fold } from "../ui/index.js";
import { usePresentation } from "../window-context.js";
import type { Revealed } from "../session/pane-documents.js";
import { CallCard, CallsRow, useOpenedFor } from "./calls.js";
import { DocumentTiles } from "./document-tiles.js";
import { Marked } from "./find.js";
import { Markdown } from "./markdown.js";
import { StreamingText } from "./streaming-text.js";

/**
 * What the transcript knows of its rows beyond the entries: what arrived while it watched, how long each running call has
 * been quiet, the workspace a call's document is placed under, the call it was last asked to show, and whether the rows
 * are the session's own to act on.
 */
export interface RowFacts {
  /** Whether the entry at `sequence` arrived while the transcript was watching, rather than being there when it opened. */
  arrived(sequence: number): boolean;
  /** How long a running call has said nothing, in milliseconds. */
  quietMs(toolCallId: string): number;
  /** The session's workspace, which the documents its calls wrote are placed under; null draws no document tiles. */
  readonly workspace: string | null;
  /** The call the transcript was last asked to show, whose fold opens for it; null for none. */
  readonly revealed: Revealed | null;
  /**
   * The rows are the session's own transcript (#403): each user message
   * offers Fork and Rewind. False where rows are only read: what a rewind
   * cut, a subagent's transcript.
   */
  readonly verbs: boolean;
  readonly checkOutput?: ChecksView["runningOutput"];
}

/** Shared label spine; messages reverse it, keeping the bubble against the right edge. */
export const TranscriptLine = ({ label, right = false, inset = right, time, children }: { readonly label: ReactNode; readonly right?: boolean; readonly inset?: boolean; readonly time?: string | undefined; readonly children: ReactNode }) => (
  <div className={classes("group/line flex min-w-0 gap-2 text-sm", right && "flex-row-reverse")}>
    <div data-measure="transcript-spine" className={classes("relative w-14 shrink-0 text-right text-2xs leading-4 text-ink-faint", inset && "pt-2")}>
      <span className={classes(time !== undefined && "group-hover/line:invisible")}>{label}</span>
      {time !== undefined && <time dateTime={time} title={time} className={classes("absolute right-0 hidden font-mono opacity-60 group-hover/line:block", inset ? "top-2" : "top-0")}>{new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</time>}
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-1">{children}</div>
  </div>
);

/** One row keeps its runtime identity for search and jump. */
export const TranscriptRowView = memo(({ row, facts }: { readonly row: TranscriptRow; readonly facts: RowFacts }) => {
  const user = row.kind === "user" && !environmentMessage(row.entry);
  const thinking = row.kind === "assistant" && row.entry.kind === "assistant-thinking";
  const label = user ? <span className="text-beam-text">you</span> : thinking ? <span className="text-sage">thinking</span> : row.kind === "turn" ? "end" : row.kind === "user" ? "environment" : "";
  return <div data-row-id={row.id}><TranscriptLine label={label} right={user} inset={row.kind === "user" || row.kind === "turn"} time={row.kind === "user" ? row.entry.sentAt : row.kind === "turn" ? row.run.endedAt ?? undefined : undefined}><RowBody row={row} facts={facts} /></TranscriptLine></div>;
}, (before, after) => {
  // The projection creates row wrappers on each delta. Settled speech and user messages
  // need no redraw when their entry fields and the facts they consume remain the same.
  const left = before.row, right = after.row;
  if (left.id !== right.id || left.kind !== right.kind) return false;
  if (left.kind === "assistant" && right.kind === "assistant") {
    return left.entry.text === right.entry.text && left.entry.streaming === right.entry.streaming && left.entry.kind === right.entry.kind
      && before.facts.arrived(left.entry.sequence) === after.facts.arrived(right.entry.sequence);
  }
  if (left.kind === "user" && right.kind === "user") return left.entry === right.entry && before.facts.verbs === after.facts.verbs;
  if (left.kind === "turn" && right.kind === "turn") return left.run === right.run;
  return false;
});

const RowBody = ({ row, facts }: { readonly row: TranscriptRow; readonly facts: RowFacts }) => {
  const { arrived } = facts;
  switch (row.kind) {
    case "user":
      return facts.verbs ? (
        <MessageVerbs entry={row.entry}>
          <UserMessage entry={row.entry} focusable />
        </MessageVerbs>
      ) : (
        <UserMessage entry={row.entry} />
      );
    case "assistant":
      return row.entry.kind === "assistant-thinking" ? (
        <Reasoning entry={row.entry} arrived={arrived(row.entry.sequence)} />
      ) : (
        <AssistantText text={row.entry.text} streaming={row.entry.streaming} arrived={arrived(row.entry.sequence)} />
      );
    case "calls":
      return <CallsRow calls={row.calls} facts={facts} />;
    case "subagent":
      return <Subagent entry={row.entry} facts={facts} />;
    case "prompt":
      return <Prompt entry={row.entry} />;
    case "check": {
      const entry = row.entry;
      const live = entry.state === "running" ? facts.checkOutput?.get(entry.terminalId) : undefined;
      const output = live?.output ?? entry.result?.output ?? "";
      const status = checkStatus(entry);
      return (
        <article aria-label="Workspace check" className="flex flex-col gap-1 text-[0.85em] text-ink-muted">
          <div className="flex items-start gap-2"><Terminal aria-hidden="true" className="size-3.5 shrink-0" /><pre className={classes("font-mono whitespace-pre-wrap break-words", entry.state === "running" ? "text-cyan" : status === "passed" ? "text-mint" : "text-signal")}><Marked text={`$ ${entry.command} · ${status}`} /></pre></div>
          {entry.result !== null && status !== `exit ${entry.result.exitCode}` && <p>exit {entry.result.exitCode ?? "none"}</p>}
          {(live?.truncated ?? entry.result?.truncated) && <span>Earlier output omitted</span>}
          {entry.result?.failure != null && <p className="text-amber">{entry.result.failure}</p>}
          {output !== "" && <pre className="max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words"><Marked text={output} /></pre>}
        </article>
      );
    }
    case "command":
      return (
        <article aria-label="Command" className="flex flex-col gap-1 text-[0.85em] text-ink-muted">
          <span className="flex items-center gap-2 font-mono">
            <Terminal aria-hidden="true" className="size-3.5 shrink-0" /><Marked text={`/${row.entry.name}${row.entry.args.length > 0 ? ` ${row.entry.args}` : ""}`} />
          </span>
          {row.entry.output !== null && row.entry.output.trim() !== "" && (
            <pre className="max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words">
              <Marked text={row.entry.output.trim()} />
            </pre>
          )}
        </article>
      );
    case "file-undo":
      return <Notice><Marked text={fileUndoWords(row.entry)} /></Notice>;
    case "turn":
      return <CostLine run={row.run} />;
    case "opaque":
      return (
        <Notice><Marked text={`${row.entry.type}: an event this version does not show`} /></Notice>
      );
    case "rewound":
      return <RewoundFold row={row} facts={facts} />;
    case "forked":
      return (
        <ForkedRow entry={row.entry}>
          <div role="group" aria-label="Copied fork history" className="flex flex-col gap-3 border-l border-hairline pl-3">
            {row.rows.map((inner) => <TranscriptRowView key={inner.id} row={inner} facts={{ ...facts, verbs: false }} />)}
          </div>
        </ForkedRow>
      );
    case "update-interrupted":
      return <Notice warning><Marked text={updateInterruptedText(row.entry)} /></Notice>;
    case "history-unreadable":
      // An imported session whose history the account's directory no longer gave (#579): one line saying so, and why.
      return (
        <Notice warning>The history could not be read: {row.entry.message}</Notice>
      );
  }
};

/**
 * What a rewind cut (docs/specs/gui.md, "The rewound fold"; ADR 0022; #403):
 * one fold at the rewind point, "Rewound: <prompt> · N prompts cut", shut
 * until opened. Open, a line saying files are not restored, then the cut
 * rows dim and only to read (a fold an earlier rewind made among them a fold
 * again). Beside it, on the session's own transcript, Undo rewind while it
 * is the latest rewind and no run has started since.
 */
const RewoundFold = ({ row, facts }: { readonly row: Extract<TranscriptRow, { kind: "rewound" }>; readonly facts: RowFacts }) => {
  const [open, setOpen] = useState(false);
  const cut = promptsIn(row.rows);
  const read: RowFacts = { ...facts, verbs: false };
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Fold
        className="flex-1 rounded-lg border border-hairline bg-wash px-3 py-2"
        open={open}
        onOpenChange={setOpen}
        summary={<><Undo2 aria-hidden="true" className="size-3 shrink-0" /><Marked text={`Rewound: ${oneLine(row.entry.text, 160)} · ${cut} ${cut === 1 ? "prompt" : "prompts"} cut`} /></>}
      >
        <div role="group" aria-label="What the rewind cut" className="flex flex-col gap-3 border-l border-hairline pl-3 opacity-60">
          <p className="text-[0.85em] text-ink-muted">Files are not restored: a rewind takes back the conversation, never what the agent changed.</p>
          {row.rows.map((inner) => (
            <TranscriptRowView key={inner.id} row={inner} facts={read} />
          ))}
        </div>
      </Fold>
      {facts.verbs && <UndoOnFold row={row} />}
    </div>
  );
};

/**
 * A message David sent, on the right: its text, and each attachment as its
 * chip, by name and size (the log records what was attached, never its bytes,
 * so a sent picture is named, not drawn: #473). Focusable where it has
 * actions to reveal.
 */
const UserMessage = ({ entry, focusable = false }: { readonly entry: UserMessageEntry; readonly focusable?: boolean }) => (
  <article
    aria-label={environmentMessage(entry) ? "Environment message" : "Your message"}
    tabIndex={focusable ? 0 : undefined}
    className={classes(
      "flex max-w-[80%] flex-col gap-1.5 rounded-lg px-3 py-2 text-sm leading-relaxed text-ink outline-none focus-visible:outline-2 focus-visible:outline-beam",
      environmentMessage(entry) ? "self-start border border-hairline" : "self-end bg-wash-user",
    )}
  >
    {environmentMessage(entry) && <span className="text-[0.85em] text-ink-muted">Environment</span>}
    {entry.attachments.length > 0 && (
      <ul className="flex flex-wrap justify-end gap-1.5 text-[0.85em] text-ink-muted">
        {entry.attachments.map((attachment, index) => (
          <li key={index} className="rounded-md border border-hairline px-2 py-0.5 font-mono">
            {attachmentChip(attachment)}
          </li>
        ))}
      </ul>
    )}
    <span className="whitespace-pre-wrap break-words">
      <Marked text={entry.text} />
    </span>
  </article>
);

/**
 * The cost line under a finished turn: its time, its tokens in and out, its
 * dollars when the provider said; a turn that did not complete says how it
 * ended first, amber, or red for an error, with the error's words.
 */
const CostLine = ({ run }: { readonly run: RunSummary }) => {
  const facts = turnFacts(run);
  const completed = run.reason === "completed";
  const line = (completed ? facts : [endWords(run), ...facts]).join(" · ");
  return (
    <article aria-label="Turn ended" className={classes("rounded-lg border px-3 py-2 text-2xs", completed ? "border-hairline bg-wash text-mint" : run.reason === "error" ? "border-signal/40 bg-signal/5 text-signal" : run.reason === "disposed" ? "border-hairline bg-wash text-ink-muted" : "border-hairline bg-wash text-amber")}>
      <p>
        <Marked text={line} />
      </p>
      {run.error !== null && (
        <p>
          <Marked text={oneLine(run.error.message, 300)} />
        </p>
      )}
    </article>
  );
};

/** The assistant's reply, as markdown: fading in word by word while it streams, a caret after it. */
const AssistantText = ({ text, streaming, arrived }: { readonly text: string; readonly streaming: boolean; readonly arrived: boolean }) => (
  <article aria-label="Reply" className="text-ink">
    {streaming ? (
      <div className="caret">
        <span role="status" aria-label="Reply streaming" />
        <StreamingText text={text} arrived={arrived} />
      </div>
    ) : (
      <Markdown text={text} />
    )}
  </article>
);

/** The marks a one-line preview of reasoning leaves out: markdown's headings, list markers, emphasis and code ticks. */
const PREVIEW_MARKS = /^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+|\*\*|__|~~|`/gm;

/**
 * A run's reasoning, behind a fold (docs/specs/gui.md, "A session pane"):
 * open or shut as the reasoning-shown preference says (`reasoningShown`,
 * presentation), and opened or shut by a click; the preference moving is an
 * instruction about every fold, so it shuts or opens this one again. Shut,
 * its first line says what is in it.
 */
const Reasoning = ({ entry, arrived }: { readonly entry: AssistantEntry; readonly arrived: boolean }) => {
  const [shown] = usePresentation("reasoningShown");
  const [open, setOpen] = useState(shown);
  const [wasShown, setWasShown] = useState(shown);
  if (wasShown !== shown) {
    setWasShown(shown);
    setOpen(shown);
  }
  const preview = oneLine(entry.text.replace(PREVIEW_MARKS, "").split("\n").find((line) => line.trim() !== "") ?? "", 80);
  return (
    <Fold
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="flex min-w-0 gap-1.5">
          <Brain aria-hidden="true" className={classes("size-3 shrink-0 text-sage", entry.streaming && "motion-safe:animate-pulse")} /><span className="sr-only">Thinking</span>
          {!open && preview !== "" && <span className="truncate">{preview}</span>}
        </span>
      }
    >
      <div className="border-l border-hairline pl-3 text-ink-muted">
        {entry.streaming ? (
          <StreamingText text={entry.text} arrived={arrived} />
        ) : (
          <Markdown text={entry.text} />
        )}
      </div>
    </Fold>
  );
};

/** A subagent's calls, in one row naming its agent and the work that started it; unfolded, each call; under it, the documents they wrote. */
const Subagent = ({ entry, facts }: { readonly entry: SubagentEntry; readonly facts: RowFacts }) => {
  const [open, setOpen] = useOpenedFor(entry.calls, facts.revealed);
  const who = entry.task?.subagentType ?? "Agent";
  const what = entry.task?.description ?? "";
  const calls = `${entry.calls.length} ${entry.calls.length === 1 ? "call" : "calls"}`;
  const summary = `${who}${what.length > 0 ? `: ${oneLine(what, 120)}` : ""} · ${calls} · ${entry.running ? "running" : "done"}`;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Fold open={open} onOpenChange={setOpen} summary={<Marked text={summary} />}>
        <div className="flex flex-col gap-1.5 border-l border-hairline pl-3">
          {entry.calls.map((call) => (
            <CallCard key={call.toolCallId} call={call} quietMs={call.status === "running" ? facts.quietMs(call.toolCallId) : 0} />
          ))}
        </div>
      </Fold>
      <DocumentTiles calls={entry.calls} workspace={facts.workspace} />
    </div>
  );
};

/**
 * A permission prompt, a question or a plan, where it was asked (the
 * sequence of its `prompt.opened`, permissions spec), once answered: what it
 * asked and how it was answered; a plan's text in place, as markdown. While
 * it is parked it is the card's under the transcript, which leaves it out.
 */
const Prompt = ({ entry }: { readonly entry: PromptEntry }) => {
  const { prompt, answer } = entry;
  if (answer === null) return null;
  if (entry.kind === "plan") {
    const verdict = answer.decision === "allow" ? `Approved${answer.mode ? `, continuing in ${answer.mode.effective}` : ""}` : "Kept planning";
    return (
      <article aria-label="Plan" className="flex flex-col gap-2 rounded-md border border-hairline px-3 py-2">
        <p className="text-[0.85em]">
          <span className="font-semibold text-ink">Plan</span> <span className="text-ink-muted">· {verdict}</span>
        </p>
        <Markdown text={prompt.plan ?? ""} />
      </article>
    );
  }
  if (entry.kind === "question") {
    const questions = prompt.questions ?? [];
    return (
      <article aria-label="Question" className="flex flex-col gap-1">
        {(questions.length > 0 ? questions.map((question) => question.question) : [prompt.summary]).map((question) => {
          const said = answer.answers?.[question] ?? (answer.decision === "deny" ? "skipped" : "answered");
          return (
            <p key={question}>
              <span className="font-medium text-ink">
                <Marked text={question} />
              </span>
              <span className="text-ink-muted">
                {" — "}
                <Marked text={said} />
              </span>
            </p>
          );
        })}
      </article>
    );
  }
  const verdict = `${answer.decision === "allow" ? "allowed" : "denied"}${answer.remember === "session" ? " for this session" : ""}${answer.message ? `: ${oneLine(answer.message, 120)}` : ""}`;
  return (
    <article aria-label="Permission" className="text-ink-muted">
      <Marked text={prompt.summary} />
      {" — "}
      <Marked text={verdict} />
    </article>
  );
};

/** A quiet transcript notice keeps its semantic tone beside its machine text. */
const Notice = ({ warning = false, children }: { readonly warning?: boolean; readonly children: ReactNode }) => {
  const Icon = warning ? TriangleAlert : Info;
  return <div className={classes("flex items-start gap-2 font-mono text-2xs", warning ? "text-amber" : "text-ink-muted")}><Icon aria-hidden="true" className="size-3.5 shrink-0" /><p>{children}</p></div>;
};
