import type { TranscriptRow } from "@agent-harness/client-runtime";
import { use } from "react";
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
      return <AssistantText text={row.entry.text} streaming={row.entry.streaming} arrived={arrived(row.entry.sequence)} />;
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
