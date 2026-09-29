import { followDraft, isLive, liveRun, lockOf, sendMessage, type InStep } from "@agent-harness/client-runtime";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { KeyContext, useKeyAction } from "../keys/key-dispatch.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { typedCommand } from "./slash-commands.js";

export interface ComposerProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * The composer under a session's transcript (docs/specs/gui.md, "A session
 * pane"; #400).
 */
export const Composer = ({ environmentId, sessionId }: ComposerProps) => {
  const runtime = useRuntime();
  // The connections' phases: the lock is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const box = useBox();
  const [line, say] = useState<string | undefined>(undefined);
  const live = isLive(runs.state) || liveRun(projection) !== undefined;
  const lock = lockOf(runtime.capability(environmentId, "runs.send"));

  // The text is the session's draft (docs/specs/gui.md, "A session pane"), kept in step by the runtime's rule: saved a
  // second after the last key, taken when the session opens, and another client's taken only while nothing was typed
  // over what this composer held. A slash command being typed (one word after a `/`, the menu's text) or a command of the
  // window's with what follows it is sent nowhere as a message, so it is never saved.
  const inStep = useRef<InStep | undefined>(undefined);
  useEffect(() => {
    const text = box.current();
    const step = followDraft(inStep.current, {
      session: `${environmentId} ${sessionId}`,
      held: projection.summary === null ? undefined : (projection.draft ?? ""),
      text,
      saves: !/^\/\S*$/.test(text) && typedCommand(text) === undefined,
    });
    inStep.current = step.inStep;
    if (step.take !== undefined) box.put(step.take);
    if (step.save !== undefined) runtime.drafts.set(environmentId, sessionId, step.save.length > 0 ? step.save : null);
  });

  const submit = () => {
    const raw = box.current();
    const message = { text: raw.trim(), attachments: [] };
    if (message.text.length === 0) return;
    if (lock.locked) return say(`Not sent: ${lock.reason}`);
    box.put("");
    say(undefined);
    void sendMessage(runtime, environmentId, sessionId, message, live).then((outcome) => {
      if (outcome.ok) return;
      say(outcome.line);
      // What was not sent comes back into an empty box, so it is not lost.
      if (box.current().length === 0) box.put(raw);
    });
  };

  return (
    <KeyContext context="composer">
      <ComposerKeys submit={submit} newline={() => box.insert("\n")} />
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-hairline px-4 py-3">
        {lock.locked && <p className="text-xs text-amber">Locked: {lock.reason}</p>}
        <div className="flex items-end gap-2">
          <textarea
            ref={box.field}
            aria-label="Message"
            value={box.text}
            onChange={(event) => box.put(event.target.value, null)}
            rows={3}
            className="min-w-0 flex-1 resize-none rounded-md border border-line bg-inset px-3 py-2 text-sm text-ink outline-none focus-visible:border-beam"
          />
          <Button tone="primary" disabled={lock.locked || box.text.trim().length === 0} onClick={submit}>
            Send
          </Button>
        </div>
        {line !== undefined && (
          <p role="status" className="text-xs text-ink-muted">
            {line}
          </p>
        )}
      </div>
    </KeyContext>
  );
};

/** The composer's actions, wired in its region. */
const ComposerKeys = ({ submit, newline }: { readonly submit: () => void; readonly newline: () => void }) => {
  useKeyAction("composer.send", submit);
  useKeyAction("composer.newline", newline);
  return null;
};

/**
 * The box's text and where its caret goes: the text is the composer's until
 * it is sent, and a change made here (a newline, a draft taken, a path
 * chosen) puts the caret where the change says once it is drawn.
 */
const useBox = () => {
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const caret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caret.current === null || field.current === null) return;
    field.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  });
  /** The text as the box holds it now, a key typed since the last render included. */
  const current = () => field.current?.value ?? text;
  /** Replaces the text, the caret at `at` (its end unless said; null leaves it where the typing put it). */
  const put = (next: string, at: number | null = next.length) => {
    caret.current = at;
    setText(next);
  };
  /** Types `chars` over the selection. */
  const insert = (chars: string) => {
    const now = current();
    const start = field.current?.selectionStart ?? now.length;
    const end = field.current?.selectionEnd ?? start;
    put(now.slice(0, start) + chars + now.slice(end), start + chars.length);
  };
  return { field, text, current, put, insert };
};
