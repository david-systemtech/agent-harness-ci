import { elapsedClock } from "@agent-harness/client-runtime";
import { whenWords } from "@agent-harness/contracts";

/** Observation age, kept separate from any newer read of another pooled window. */
export const ReadingAge = ({ readAt, at, windowLabel }: { readonly readAt: string; readonly at: Date; readonly windowLabel?: string }) => {
  const age = Math.max(0, at.getTime() - Date.parse(readAt));
  const stale = age >= 360_000;
  if (windowLabel !== undefined && !stale) return null;
  return <p aria-label={windowLabel === undefined ? "Reading age" : `${windowLabel} reading age`} className={windowLabel === undefined ? "text-ink-faint" : "text-2xs text-ink-faint"}>
    {windowLabel !== undefined && `${windowLabel} · `}Read {elapsedClock(age)} ago{stale ? " · stale" : ""} · <time dateTime={readAt}>{whenWords(readAt, at)}</time>
  </p>;
};
