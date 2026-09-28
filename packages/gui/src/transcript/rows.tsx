import { oneLine, type AssistantEntry, type TranscriptRow } from "@agent-harness/client-runtime";
import { use, useState } from "react";
import { Fold } from "../ui/index.js";
import { usePresentation } from "../window-context.js";
import { FindQuery, Marked } from "./find.js";
import { Markdown } from "./markdown.js";
import { StreamingText } from "./streaming-text.js";

export interface RowProps {
  readonly row: TranscriptRow;
  /** Whether the entry at `sequence` arrived while the transcript was watching, rather than being there when it opened. */
  readonly arrived: (sequence: number) => boolean;
}

/** One row of the transcript, drawn by its kind. */
export const TranscriptRowView = ({ row, arrived }: RowProps) => {
  switch (row.kind) {
    case "user":
      return (
        <article aria-label="Your message" className="max-w-[85%] self-end rounded-lg bg-wash-user px-3 py-2 whitespace-pre-wrap text-ink">
          <Marked text={row.entry.text} />
        </article>
      );
    case "assistant":
      return row.entry.kind === "assistant-thinking" ? (
        <Reasoning entry={row.entry} arrived={arrived(row.entry.sequence)} />
      ) : (
        <AssistantText text={row.entry.text} streaming={row.entry.streaming} arrived={arrived(row.entry.sequence)} />
      );
    default:
      return null;
  }
};

/** The assistant's reply: fading in word by word while it streams, markdown once it has settled. */
const AssistantText = ({ text, streaming, arrived }: { readonly text: string; readonly streaming: boolean; readonly arrived: boolean }) => {
  const query = use(FindQuery);
  return (
    <article aria-label="Reply" className="text-ink">
      {streaming ? (
        <div className="whitespace-pre-wrap break-words">
          <StreamingText text={text} arrived={arrived} />
        </div>
      ) : (
        <Markdown text={text} query={query} />
      )}
    </article>
  );
};

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
          <ReasoningText text={entry.text} />
        )}
      </div>
    </Fold>
  );
};

const ReasoningText = ({ text }: { readonly text: string }) => <Markdown text={text} query={use(FindQuery)} />;
