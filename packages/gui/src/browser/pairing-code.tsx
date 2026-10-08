import { plainRefusal, LOCAL_PLACEHOLDER_ID, COUNTDOWN_TICK_MS } from "@agent-harness/client-runtime";
import { Check, Copy } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { nameOf } from "../connections/words.js";
import { useWindowFrame } from "../frame/window-controls.js";
import { TechnicalDetails, type TechnicalDetailsProps } from "../setup/details.js";
import { Button, Fold, Input } from "../ui/index.js";
import { useClientVersion, useClock, useObservable, useRuntime, useShell } from "../window-context.js";

/** This app's clipboard, when its shell has one. */
const useClipboard = () => {
  const runtime = useRuntime();
  const shell = useShell();
  return runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
};

/**
 * Details for a line about the computer `environmentId` (setup-copy.md §3):
 * this app's version and platform, the computer, the line and its raw words.
 */
export const useBrowserDetails = (environmentId: string): ((line: string, details: readonly string[]) => TechnicalDetailsProps) => {
  const runtime = useRuntime();
  const version = useClientVersion();
  const frame = useWindowFrame();
  const clipboard = useClipboard();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  return (line, details) => ({
    report: { app: { version, platform: frame?.platform ?? "unknown" }, ...(environment !== undefined && { computer: { name: nameOf(environment) } }), line, details },
    copy: (text) => clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : clipboard.writeText(text),
  });
};

/**
 * A Copy button with its words in view (setup-copy.md §1 rule 7): `label`
 * names what it copies for assistive technology, starting with the words
 * shown. Absent where this app has no clipboard; the text stays selectable.
 */
export const CopyText = ({ text, words = "Copy", label = words, copied }: { readonly text: string; readonly words?: string; readonly label?: string; readonly copied?: () => void }) => {
  const clipboard = useClipboard();
  const [state, setState] = useState<"ready" | "copied" | "refused">("ready");
  if (clipboard === undefined) return null;
  const copy = async () => {
    try {
      await clipboard.writeText(text);
      setState("copied");
      copied?.();
    } catch {
      setState("refused");
    }
  };
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
    <Button variant="outline" size="xs" aria-label={label} onClick={() => void copy()}>{state === "copied" ? <Check aria-hidden="true" className="text-mint" /> : <Copy aria-hidden="true" />}{words}</Button>
    <span role="status" className={state === "refused" ? "text-xs text-signal" : "sr-only"}>{state === "copied" ? "Copied." : state === "refused" ? "This app cannot copy here. Select the text and copy it instead." : ""}</span>
  </span>;
};

/** `{m} min left`: the minutes a code has, a part of one counted whole (setup-copy.md §5.11). */
export const minutesLeft = (ms: number): string => `${Math.max(1, Math.ceil(ms / 60_000))} min left`;

/**
 * Step 5's code (setup-copy.md §5.11): minted when it shows, which is once
 * Chrome found the extension, and again by itself when it runs out, outside
 * the request cache, since an expired cached code cannot pair. No Stop box.
 */
export const BrowserPairingCode = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const details = useBrowserDetails(environmentId);
  const [generation, renew] = useReducer((n: number) => n + 1, 0);
  const [minted, setMinted] = useState<{ readonly code: string; readonly until: Date } | null>(null);
  const [failure, setFailure] = useState<{ readonly line: string; readonly details: readonly string[] } | null>(null);
  const [tick, redraw] = useReducer((n: number) => n + 1, 0);
  // A connection that may not mint says so once on its card; asking would only repeat it.
  const mintable = runtime.capability(environmentId, "browser.pairing.code").status === "present";
  useEffect(() => {
    let active = true;
    setMinted(null);
    setFailure(null);
    if (!mintable) return;
    void runtime.requests.call(environmentId, "browser.pairing.code", {}).then((answer) => {
      if (!active) return;
      if (!answer.ok) return setFailure(plainRefusal(answer.error, "Pair another"));
      const left = Date.parse(answer.result.expiresAt) - runtime.environmentNow(environmentId).getTime();
      setMinted({ code: answer.result.code, until: new Date(clock.now().getTime() + left) });
    });
    return () => {
      active = false;
    };
  }, [runtime, clock, environmentId, generation, mintable]);
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
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Pairing code" readOnly value={minted.code} className="w-48 max-w-full font-mono tracking-widest select-all" />
          <CopyText text={minted.code} label="Copy pairing code" />
          <span role="timer" className="text-2xs text-ink-muted">{minutesLeft(minted.until.getTime() - clock.now().getTime())}</span>
        </div>
      )}
      {failure !== null && <BrowserProblem line={failure.line} details={details(failure.line, failure.details)} />}
    </>
  );
};

/**
 * A problem said plainly (setup-copy.md §1 rule 15): an alert in words and
 * colour, read with a hidden "Error:" first, its raw words under Details. A
 * caller with only a refusal's code (Settings' headless browser) keeps it
 * under Technical detail.
 */
export const BrowserProblem = ({ line, details, code }: { readonly line: string; readonly details?: TechnicalDetailsProps; readonly code?: string }) => {
  const [open, setOpen] = useState(false);
  return <div className="flex min-w-0 flex-col gap-1 text-xs">
    <p role="alert" className="text-signal"><span className="sr-only">Error:</span> {line}</p>
    {details !== undefined && <TechnicalDetails {...details} />}
    {details === undefined && code !== undefined && <Fold summary="Technical detail" open={open} onOpenChange={setOpen}>
      <pre className="max-h-32 overflow-auto bg-inset p-2 font-mono text-2xs break-all whitespace-pre-wrap">{`${code}: ${line}`}</pre>
    </Fold>}
  </div>;
};
