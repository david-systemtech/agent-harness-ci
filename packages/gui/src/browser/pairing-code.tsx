import { ttlWords, COUNTDOWN_TICK_MS } from "@agent-harness/client-runtime";
import { useEffect, useReducer, useState } from "react";
import { useClock, useRuntime } from "../window-context.js";

/** Mint on open and expiry, outside the request cache: an expired cached code cannot pair. */
export const BrowserPairingCode = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [generation, renew] = useReducer((n: number) => n + 1, 0);
  const [minted, setMinted] = useState<{ readonly code: string; readonly until: Date } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [tick, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let active = true;
    setMinted(null);
    setLine(null);
    void runtime.requests.call(environmentId, "browser.pairing.code", {}).then((answer) => {
      if (!active) return;
      if (!answer.ok) return setLine(`No pairing code: ${answer.error.message}`);
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
          <code className="font-mono select-all">{minted.code}</code>
          <p role="timer">{ttlWords(minted.until.getTime() - clock.now().getTime())} to pair.</p>
        </>
      )}
      {line !== null && <p role="alert">{line}</p>}
    </>
  );
};
