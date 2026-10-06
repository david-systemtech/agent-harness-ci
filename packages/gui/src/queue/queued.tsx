import { attachmentChip, type QueuedMessage } from "@agent-harness/client-runtime";
import { CircleStop, Hourglass, Pencil } from "lucide-react";
import { TranscriptLine } from "../transcript/rows.js";
import { Marked } from "../transcript/find.js";
import { VerbButton } from "../session/verb-button.js";
import { useSessionQueue } from "./session-queue.js";

/** What Read now does, in its tooltip: the whole queue, never one message (ADR 0022). */
const READ_NOW_DOES = "Reads the whole queue now, in the order it was sent: a live run stops, and the next run reads every queued message.";

/**
 * A queued message, drawn after its turn (docs/specs/gui.md, "A session
 * pane"): its text and its attachments' chips, by name and size as the
 * transcript draws a sent message's (#473), marked Queued while it waits
 * for the next run, or Steering while the provider holds it and its adapter
 * steers it into the running turn; with Read now, which reads the whole
 * queue, and Edit, which takes this message back into the composer.
 */
export const QueuedRow = ({ message }: { readonly message: QueuedMessage }) => {
  const queue = useSessionQueue();
  const steering = queue.steers && message.heldBy === "provider";
  return (
    <TranscriptLine right label={<Hourglass aria-hidden="true" className="ml-auto size-3 text-amber" />}><article
      aria-label={steering ? "Steering message" : "Queued message"}
      className="flex max-w-[80%] flex-col gap-1.5 self-end rounded-lg border border-dashed border-line-strong px-3 py-2 text-ink-muted"
    >
      {message.attachments.length > 0 && (
        <ul className="flex flex-wrap justify-end gap-1.5 text-[0.85em]">
          {message.attachments.map((attachment, index) => (
            <li key={index} className="rounded-md border border-hairline px-2 py-0.5 font-mono">
              <Marked text={attachmentChip(attachment)} />
            </li>
          ))}
        </ul>
      )}
      <p className="whitespace-pre-wrap break-words">
        <Marked text={message.text} />
      </p>
      <div data-queued-actions className="flex items-center justify-end gap-1 text-xs">
        <span className={steering ? "mr-auto text-cyan" : "mr-auto text-amber"}>{steering ? "Steering" : "Queued"}</span>
        <VerbButton does={READ_NOW_DOES} keys="Enter or Space" availability={queue.runs.verbs.readNow} run={queue.readNow}>
          <CircleStop aria-hidden="true" className="size-3" />Read now
        </VerbButton>
        <VerbButton does="Takes this message back into the composer to edit." keys="Enter or Space" availability={message.withdraw} run={() => queue.withdraw(message.messageId)}>
          <Pencil aria-hidden="true" className="size-3" />Edit
        </VerbButton>
      </div>
    </article></TranscriptLine>
  );
};

/**
 * The strip over the composer (docs/specs/gui.md, "A session pane"): how
 * many messages are queued, with Read now and Edit newest, which takes back
 * the newest message a withdraw can reach (the runtime's `withdrawTarget`,
 * the one ↑ in an empty composer takes). Not drawn while nothing is queued.
 */
export const QueueStrip = () => {
  const queue = useSessionQueue();
  const { queue: queued, verbs } = queue.runs;
  if (queued.length === 0) return null;
  return (
    <section aria-label="Queued messages" className="flex shrink-0 items-center gap-2 border-t border-hairline px-4 py-1 text-xs text-ink-muted">
      <span className="mr-auto">{`${queued.length} ${queued.length === 1 ? "message" : "messages"} queued`}</span>
      <VerbButton does={READ_NOW_DOES} keys="Enter or Space" availability={verbs.readNow} run={queue.readNow}>
        <CircleStop aria-hidden="true" className="size-3" />Read now
      </VerbButton>
      <VerbButton does="Takes the newest queued message back into the composer to edit." keys="Enter or Space" availability={verbs.withdraw} run={queue.withdrawNewest}>
        <Pencil aria-hidden="true" className="size-3" />Edit newest
      </VerbButton>
    </section>
  );
};
