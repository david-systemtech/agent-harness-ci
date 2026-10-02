import { sendMessage, type NewSessionChips } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { nameOf } from "../connections/words.js";
import { usePaneGrid } from "../grid/grid.js";
import { KeyContext, useKeyAction } from "../keys/key-dispatch.js";
import type { PaneNewSession } from "../presentation.js";
import { useOpenInPane } from "../session/pane-line.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { CHIPS } from "./chips.js";
import { useSurfaces } from "./surfaces.js";
import { refusalLine } from "./words.js";

/** What the surface says when no environment can start a session now. */
const NONE_USABLE = "No environment can start a session now: the environment chip says why for each.";

/**
 * The new-session surface (docs/specs/gui.md, "A new session"; story 13 and
 * ADR 0005: where first; #420): the chips from `projections.newSession`, for
 * what the surface was opened beside and what was chosen on it, above a
 * composer. What is typed stays in the pane, since there is no session to
 * hold a draft yet (`surfaces.tsx`), so a pane closed before its first send
 * leaves nothing behind. The first send runs `commands.startSession` under
 * the id the surface was minted with, then, once the create is accepted,
 * sends the text as the session's first message, and the pane shows the new
 * session; a first message the environment refuses comes back as the new
 * session's draft, its pane saying why. A refused start is one line on the
 * surface, which keeps its text.
 */
export const NewSessionSurface = ({ surface }: { readonly surface: PaneNewSession }) => {
  const runtime = useRuntime();
  const grid = usePaneGrid();
  const openInPane = useOpenInPane();
  const { typed, focusAsked, askFocus } = useSurfaces();
  const { id, focus, chips } = surface;
  const view = useObservable(useMemo(() => runtime.projections.newSession({ focus, chips }), [runtime, focus, chips]));
  const [text, setText] = useState(() => typed.get(id) ?? "");
  const [line, say] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusAsked?.id !== id) return;
    field.current?.focus();
    askFocus(null);
  }, [focusAsked, id, askFocus]);

  const put = (next: string) => {
    setText(next);
    typed.set(id, next);
  };
  const choose = (chosen: NewSessionChips) => grid.chooseChips(id, (held) => {
    const next = { ...held, ...chosen };
    if (chosen.environmentId !== undefined || chosen.account !== undefined) delete next.browser;
    return next;
  });

  const start = async () => {
    const message = text.trim();
    const environmentId = view.environment.value;
    const workspace = view.workspace.value;
    if (message.length === 0 || starting) return;
    if (environmentId === null || workspace === null) return say(NONE_USABLE);
    const environment = view.environment.options.find((option) => option.environment.environmentId === environmentId)?.environment;
    const account = view.account.value;
    const model = view.model.value;
    setStarting(true);
    say(undefined);
    const { answer } = await runtime.commands.startSession(environmentId, {
      id,
      workspace,
      browser: view.browser,
      ...(account !== null && { account: account.id }),
      ...(model !== null && { model: model.id }),
    });
    if (!answer.ok) {
      setStarting(false);
      const where = environment === undefined ? "the environment" : nameOf(environment);
      return say(refusalLine(answer.error, workspace, { where, environmentId, rows: runtime.projections.sessionList.read().rows }));
    }
    const sent = await sendMessage(runtime, environmentId, id, { text: message, attachments: [] }, false);
    if (!sent.ok) runtime.drafts.set(environmentId, id, message);
    openInPane(environmentId, id, sent.ok ? undefined : sent.line);
  };

  return (
    <section aria-label="New session" className="flex min-h-0 flex-1 flex-col justify-end">
      <div role="group" aria-label="Where it starts" className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
        {CHIPS.map((Chip, at) => (
          <Chip key={at} view={view} sessionId={id} choose={choose} say={say} />
        ))}
      </div>
      <KeyContext context="composer">
        <SendKey send={() => void start()} />
        <div className="flex shrink-0 flex-col gap-1.5 px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={field}
              aria-label="Message"
              placeholder="The first message starts the session"
              value={text}
              onChange={(event) => put(event.target.value)}
              rows={3}
              className="min-w-0 flex-1 resize-none rounded-md border border-line bg-inset px-3 py-2 text-sm text-ink outline-none focus-visible:border-beam"
            />
            <Button tone="primary" disabled={starting || text.trim().length === 0} onClick={() => void start()}>
              {starting ? "Starting…" : "Send"}
            </Button>
          </div>
          {line !== undefined && (
            <p role="status" className="text-xs text-ink-muted">
              {line}
            </p>
          )}
        </div>
      </KeyContext>
    </section>
  );
};

/** The composer's send key, wired in the surface's composer. */
const SendKey = ({ send }: { readonly send: () => void }) => {
  useKeyAction("composer.send", send);
  return null;
};
