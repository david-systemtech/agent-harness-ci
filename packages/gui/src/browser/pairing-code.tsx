import { ttlWords, LOCAL_PLACEHOLDER_ID, COUNTDOWN_TICK_MS } from "@agent-harness/client-runtime";
import { useEffect, useReducer, useState } from "react";
import { KeyRound } from "lucide-react";
import { CopyButton, Fold, Input } from "../ui/index.js";
import { useClock, useRuntime, useShell } from "../window-context.js";

/** Mint on open and expiry, outside the request cache: an expired cached code cannot pair. */
export const BrowserPairingCode = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const shell = useShell();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  const [generation, renew] = useReducer((n: number) => n + 1, 0);
  const [minted, setMinted] = useState<{ readonly code: string; readonly until: Date } | null>(null);
  const [failure, setFailure] = useState<{ readonly line: string; readonly code: string } | null>(null);
  const [tick, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let active = true;
    setMinted(null);
    setFailure(null);
    void runtime.requests.call(environmentId, "browser.pairing.code", {}).then((answer) => {
      if (!active) return;
      if (!answer.ok) return setFailure({ line: `No pairing code: ${answer.error.message}`, code: answer.error.code });
      const left = Date.parse(answer.result.expiresAt) - runtime.environmentNow(environmentId).getTime();
      setMinted({ code: answer.result.code, until: new Date(clock.now().getTime() + left) });
    });
    return () => {
      active = false;
    };
  }, [runtime, clock, environmentId, generation]);
  useEffect(() => {
    if (minted === null) return;
    const timer = clock.setTimeout(renew, Math.max(0, minted.until.getTime() - clock.now().getTime()));
    return () => timer.cancel();
  }, [clock, minted]);
  useEffect(() => {
    if (minted === null) return;
    const timer = clock.setTimeout(redraw, COUNTDOWN_TICK_MS);
    return () => timer.cancel();
  }, [clock, minted, tick]);
  return (
    <>
      {minted !== null && minted.until > clock.now() && (
        <>
          <div className="flex flex-col gap-1.5 text-xs"><span className="flex items-center gap-1.5"><KeyRound aria-hidden="true" className="size-4" />Pairing code</span>
            <span className="flex items-center gap-2"><Input aria-label="Pairing code" title="Pairing code (select and copy with Ctrl+C or ⌘C)" readOnly value={minted.code} className="w-48 max-w-full font-mono tracking-widest select-all" />
              {clipboard !== undefined && <CopyButton label="Copy pairing code (Enter or Space)" text={minted.code} copy={(text) => clipboard.writeText(text)} />}</span></div>
          <p role="timer" className="font-mono text-2xs text-ink-muted">{ttlWords(minted.until.getTime() - clock.now().getTime())} to pair.</p>
        </>
      )}
      {failure !== null && <BrowserProblem line={failure.line} code={failure.code} />}
    </>
  );
};

/** Keep the first line readable; technical diagnostics stay available on demand. */
export const BrowserProblem = ({ line, code }: { readonly line: string; readonly code?: string }) => {
  const [open, setOpen] = useState(false);
  const summary = line.split(/\r?\n/)[0] ?? line;
  return <div className="flex min-w-0 flex-col gap-1 text-xs">
    <p role="alert" className="text-signal">{summary}</p>
    {(code !== undefined || summary !== line) && <Fold summary="Technical detail" open={open} onOpenChange={setOpen}>
      <pre className="max-h-32 overflow-auto bg-inset p-2 font-mono text-2xs break-all whitespace-pre-wrap">{code === undefined ? line : `${code}: ${line.replace(/^No pairing code: /, "")}`}</pre>
    </Fold>}
  </div>;
};
