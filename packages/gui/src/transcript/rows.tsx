import {
  endWords,
  oneLine,
  turnFacts,
  type AssistantEntry,
  type PromptEntry,
  type SubagentEntry,
  type TranscriptRow,
  type UserMessageEntry,
} from "@agent-harness/client-runtime";
import type { RunSummary } from "@agent-harness/contracts";
import { useState } from "react";
import { classes } from "../ui/classes.js";
import { Fold } from "../ui/index.js";
import { usePresentation } from "../window-context.js";
import { CallCard, CallsRow } from "./calls.js";
import { Marked } from "./find.js";
import { Markdown } from "./markdown.js";
import { StreamingText } from "./streaming-text.js";

/** What the transcript knows of its rows beyond the projection: what arrived while it watched, and how long each running call has been quiet. */
export interface RowFacts {
  /** Whether the entry at `sequence` arrived while the transcript was watching, rather than being there when it opened. */
  arrived(sequence: number): boolean;
  /** How long a running call has said nothing, in milliseconds. */
  quietMs(toolCallId: string): number;
}

/** One row of the transcript, drawn by its kind. */
export const TranscriptRowView = ({ row, facts }: { readonly row: TranscriptRow; readonly facts: RowFacts }) => {
  const { arrived } = facts;
  switch (row.kind) {
    case "user":
      return <UserMessage entry={row.entry} />;
    case "assistant":
      return row.entry.kind === "assistant-thinking" ? (
        <Reasoning entry={row.entry} arrived={arrived(row.entry.sequence)} />
      ) : (
        <AssistantText text={row.entry.text} streaming={row.entry.streaming} arrived={arrived(row.entry.sequence)} />
      );
    case "calls":
      return <CallsRow calls={row.calls} quietMs={facts.quietMs} />;
    case "subagent":
      return <Subagent entry={row.entry} quietMs={facts.quietMs} />;
    case "prompt":
      return <Prompt entry={row.entry} />;
    case "command":
      return (
        <article aria-label="Command" className="flex flex-col gap-1 text-[0.85em] text-ink-muted">
          <span className="font-mono">
            <Marked text={`/${row.entry.name}${row.entry.args.length > 0 ? ` ${row.entry.args}` : ""}`} />
          </span>
          {row.entry.output !== null && row.entry.output.trim() !== "" && (
            <pre className="max-h-48 overflow-auto font-mono whitespace-pre-wrap break-words">
              <Marked text={row.entry.output.trim()} />
            </pre>
          )}
        </article>
      );
    case "turn":
      return <CostLine run={row.run} />;
    case "opaque":
      return (
        <p className="text-[0.85em] text-ink-faint">
          <Marked text={`${row.entry.type}: an event this version does not show`} />
        </p>
      );
    case "rewound":
      // The fold at the rewind point is #403's to draw; what the rewind cut stays out of the transcript until then.
      return null;
  }
};

/**
 * A message David sent, on the right: its text, and each attachment by name
 * and size (the log records what was attached, never its bytes, so a sent
 * picture is named, not drawn).
 */
const UserMessage = ({ entry }: { readonly entry: UserMessageEntry }) => (
  <article aria-label="Your message" className="flex max-w-[85%] flex-col gap-1.5 self-end rounded-lg bg-wash-user px-3 py-2 text-ink">
    {entry.attachments.length > 0 && (
      <ul className="flex flex-wrap justify-end gap-1.5 text-[0.85em] text-ink-muted">
        {entry.attachments.map((attachment, index) => (
          <li key={index} className="rounded-md border border-hairline px-2 py-0.5 font-mono">
            {`${attachment.name} · ${Math.max(1, Math.round(attachment.size / 1024))} KB`}
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
    <div className={classes("text-[0.85em]", completed ? "text-ink-faint" : run.reason === "error" ? "text-signal" : "text-amber")}>
      <p>
        <Marked text={line} />
      </p>
      {run.error !== null && (
        <p>
          <Marked text={oneLine(run.error.message, 300)} />
        </p>
      )}
    </div>
  );
};

/** The assistant's reply: fading in word by word while it streams, markdown once it has settled. */
const AssistantText = ({ text, streaming, arrived }: { readonly text: string; readonly streaming: boolean; readonly arrived: boolean }) => (
  <article aria-label="Reply" className="text-ink">
    {streaming ? (
      <div className="whitespace-pre-wrap break-words">
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
          <span className="font-medium text-sage">Reasoning</span>
          {!open && preview !== "" && <span className="truncate">{preview}</span>}
        </span>
      }
    >
      <div className="border-l border-hairline pl-3 text-ink-muted">
        {entry.streaming ? (
          <div className="whitespace-pre-wrap break-words">
            <StreamingText text={entry.text} arrived={arrived} />
          </div>
        ) : (
          <Markdown text={entry.text} />
        )}
      </div>
    </Fold>
  );
};

/** A subagent's calls, in one row naming its agent and the work that started it; unfolded, each call. */
const Subagent = ({ entry, quietMs }: { readonly entry: SubagentEntry; readonly quietMs: (toolCallId: string) => number }) => {
  const [open, setOpen] = useState(false);
  const who = entry.task?.subagentType ?? "Agent";
  const what = entry.task?.description ?? "";
  const calls = `${entry.calls.length} ${entry.calls.length === 1 ? "call" : "calls"}`;
  const summary = `${who}${what.length > 0 ? `: ${oneLine(what, 120)}` : ""} · ${calls} · ${entry.running ? "running" : "done"}`;
  return (
    <Fold open={open} onOpenChange={setOpen} summary={<Marked text={summary} />}>
      <div className="flex flex-col gap-1.5 border-l border-hairline pl-3">
        {entry.calls.map((call) => (
          <CallCard key={call.toolCallId} call={call} quietMs={call.status === "running" ? quietMs(call.toolCallId) : 0} />
        ))}
      </div>
    </Fold>
  );
};

const WAITING = "waiting for an answer";

/**
 * A permission prompt, a question or a plan, where it was asked (the
 * sequence of its `prompt.opened`, permissions spec): what it asked and how
 * it was answered, or that it waits; a plan's text in place, as markdown.
 * Answering is the card's (#404).
 */
const Prompt = ({ entry }: { readonly entry: PromptEntry }) => {
  const { prompt, answer } = entry;
  if (entry.kind === "plan") {
    const verdict =
      answer === null ? "Waiting for an answer" : answer.decision === "allow" ? `Approved${answer.mode ? `, continuing in ${answer.mode.effective}` : ""}` : "Kept planning";
    return (
      <article aria-label="Plan" className="flex flex-col gap-2 rounded-md border border-hairline px-3 py-2">
        <p className="text-[0.85em]">
          <span className="font-semibold text-ink">Plan</span> <span className={answer === null ? "text-amber" : "text-ink-muted"}>· {verdict}</span>
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
          const given = answer?.answers?.[question];
          const said = answer === null ? WAITING : (given ?? (answer.decision === "deny" ? "skipped" : "answered"));
          return (
            <p key={question}>
              <span className="font-medium text-ink">
                <Marked text={question} />
              </span>
              <span className={answer === null ? "text-amber" : "text-ink-muted"}>
                {" — "}
                <Marked text={said} />
              </span>
            </p>
          );
        })}
      </article>
    );
  }
  const verdict =
    answer === null
      ? WAITING
      : `${answer.decision === "allow" ? "allowed" : "denied"}${answer.remember === "session" ? " for this session" : ""}${answer.message ? `: ${oneLine(answer.message, 120)}` : ""}`;
  return (
    <article aria-label="Permission" className={answer === null ? "text-amber" : "text-ink-muted"}>
      <Marked text={prompt.summary} />
      {" — "}
      <Marked text={verdict} />
    </article>
  );
};
