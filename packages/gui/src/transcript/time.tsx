import { transcriptTime } from "@agent-harness/client-runtime";
import { useEffect, useReducer } from "react";
import { useClock } from "../window-context.js";

/** Visible metadata sits in the body, so enlarged text and phone spines keep their width. */
export const TranscriptTime = ({ time, previous }: { readonly time: string | undefined; readonly previous?: string | undefined }) => {
  const clock = useClock();
  const [day, redraw] = useReducer((value: number) => value + 1, 0);
  const words = transcriptTime(time, clock.now(), previous);
  useEffect(() => {
    if (time === undefined || !Number.isFinite(Date.parse(time))) return;
    const now = clock.now();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = clock.setTimeout(redraw, midnight.getTime() - now.getTime());
    return () => timer.cancel();
  }, [clock, time, day]);
  return words === undefined ? null : <time dateTime={time} title={time} className="self-end whitespace-nowrap text-right font-mono text-2xs text-ink-faint">{words}</time>;
};
