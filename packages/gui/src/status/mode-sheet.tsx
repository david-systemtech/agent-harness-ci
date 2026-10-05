import { MODE_BADGE_WORDS, aboveCeilingWords, sessionModeOf, setSessionMode } from "@agent-harness/client-runtime";
import { BYPASS_SENTENCE, type Mode } from "@agent-harness/contracts";
import { Check, Shield } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { usePaneLine } from "../session/pane-line.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import "./mode-sheet.css";

const descriptions: Readonly<Record<Mode, string>> = {
  plan: "Plan before making changes.",
  acceptEdits: "Accept file edits; ask before other actions.",
  auto: "Let the permission policy decide when to ask.",
  bypassPermissions: BYPASS_SENTENCE,
};

/** Mode-only phone projection; the runtime command and environment still own authority. */
export const ModeSheet = ({ environmentId, sessionId, close }: {
  readonly environmentId: string; readonly sessionId: string; readonly close: () => void;
}) => {
  const runtime = useRuntime();
  const picker = useObservable(useMemo(() => runtime.projections.modes(environmentId), [runtime, environmentId]));
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [, say] = usePaneLine();
  const own = sessionModeOf(projection.summary?.mode, picker.ceiling);
  const root = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { root.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true }); }, []);
  const select = async (mode: Mode) => {
    if (busy.current || !picker.modes.some(choice => choice.mode === mode && choice.allowed)) return;
    busy.current = true; setPending(true); setError(null);
    try {
      const answer = await setSessionMode(runtime, environmentId, sessionId, mode, projection.summary?.title ?? "this session");
      say(answer.line);
      if (answer.ok) close();
      else setError(answer.line);
    } catch {
      const line = "The mode was not set. Reconnect and choose again to retry.";
      say(line); setError(line);
    } finally { busy.current = false; setPending(false); }
  };
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault(); event.stopPropagation();
    const next = buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length];
    next?.focus({ preventScroll: true });
    const list = next?.closest<HTMLElement>(".mode-sheet-choices");
    if (list && next) {
      const row = next.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    }
  };
  return <div ref={root} data-mode-sheet onKeyDownCapture={trapTab}>
    <div className="mode-sheet-header"><span className="font-medium">Mode</span><Button onClick={close} aria-label="Close mode picker">Close</Button></div>
    <div className="mode-sheet-choices" aria-busy={pending}>
      {error !== null && <p role="alert" className="px-3 py-2 text-signal">{error} Choose again to retry.</p>}
      {picker.modes.map(({ mode, allowed }) => <button key={mode} type="button" className="mode-sheet-choice" aria-label={MODE_BADGE_WORDS[mode].replace(/^[⏸⏵]+\s*/, "")} aria-pressed={mode === own}
        disabled={!allowed} aria-disabled={!allowed || pending} onClick={() => void select(mode)}>
        <Shield aria-hidden="true" className="mt-1 size-4 shrink-0" />
        <span className="min-w-0 flex-1"><span className="block font-medium">{MODE_BADGE_WORDS[mode].replace(/^[⏸⏵]+\s*/, "")}</span>
          <span className="block text-ink-muted">{descriptions[mode]}</span>
          {mode === own && <span className="block text-ink-muted">Current selection</span>}
          {!allowed && <span className="block text-ink-muted">{aboveCeilingWords(picker.ceiling)}</span>}
        </span>
        {mode === own && <Check aria-hidden="true" className="mt-1 size-4 shrink-0" />}
      </button>)}
    </div>
  </div>;
};
