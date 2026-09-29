import type { UserMessageEntry } from "@agent-harness/client-runtime";
import { useState, type FocusEvent, type ReactNode } from "react";
import { useMessageLine } from "../session/pane-line.js";
import { VerbButton } from "../session/verb-button.js";
import { messageWords, useSessionForkRewind } from "./session-fork-rewind.js";

/** What each action does, in its tooltip. */
const FORK_DOES = "Forks a new session holding the conversation before this message, with the message as its draft.";
const FORK_ONTO_DOES = "Forks a new session on another account, holding the conversation before this message, with the message as its draft.";
const REWIND_DOES = "Rewinds the conversation to this message: what came after it is folded away, and its text comes back to the composer. Files are not restored.";
const STOP_AND_REWIND_DOES =
  "Stops the live run, then rewinds the conversation to this message once it has ended: what came after it is folded away, and its text comes back to the composer. Files are not restored.";

/**
 * A user message a run has read, with its actions (docs/specs/gui.md, "A
 * session pane"; ADR 0022; #403): Fork, Fork onto another account and
 * Rewind, revealed while the pointer rests on the message or the focus is in
 * it (the message takes the focus, so the keyboard reaches them), each drawn
 * from its verb's availability and dim with the runtime's reason when
 * absent, never hidden. While hidden they keep their room, so revealing them
 * moves nothing. Rewind reads "Stop and rewind here" while the live run can
 * be stopped for it. Under them, the pane's line while it is about this
 * message: a refusal, or the stop the rewind waits on.
 */
export const MessageVerbs = ({ entry, children }: { readonly entry: UserMessageEntry; readonly children: ReactNode }) => {
  const forkRewind = useSessionForkRewind();
  const line = useMessageLine(entry.messageId);
  const [pointer, setPointer] = useState(false);
  const [focused, setFocused] = useState(false);
  const shown = pointer || focused;
  const anchor = { messageId: entry.messageId, text: entry.text };
  const left = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  };
  return (
    <div className="flex flex-col items-end gap-0.5" onPointerEnter={() => setPointer(true)} onPointerLeave={() => setPointer(false)} onFocus={() => setFocused(true)} onBlur={left}>
      {children}
      <div role="toolbar" aria-label={`Fork or rewind: ${messageWords(entry.text)}`} className="flex gap-1" style={{ visibility: shown ? "visible" : "hidden" }}>
        <VerbButton does={FORK_DOES} availability={forkRewind.fork} run={() => forkRewind.forkAt(anchor)}>
          Fork
        </VerbButton>
        <VerbButton does={FORK_ONTO_DOES} availability={forkRewind.fork} run={() => forkRewind.forkOntoAccount(anchor)}>
          Fork onto another account
        </VerbButton>
        <VerbButton does={forkRewind.stops ? STOP_AND_REWIND_DOES : REWIND_DOES} availability={forkRewind.rewind} run={() => forkRewind.rewindTo(anchor)}>
          {forkRewind.stops ? "Stop and rewind here" : "Rewind"}
        </VerbButton>
      </div>
      {line !== undefined && (
        <p role="status" className="max-w-[85%] text-xs text-ink-muted">
          {line}
        </p>
      )}
    </div>
  );
};
