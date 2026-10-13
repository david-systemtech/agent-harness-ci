import type { TranscriptRow } from "./rows.js";

const pad = (value: number): string => String(value).padStart(2, "0");
const day = (date: Date): string => `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Shared local words for the recorded instant, never the time a client received it. */
export const transcriptTime = (time: string | undefined, now: Date, previous?: string): string | undefined => {
  if (time === undefined) return undefined;
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return undefined;
  const label = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const dateDay = day(date);
  const changed = previous !== undefined && Number.isFinite(Date.parse(previous)) && day(new Date(previous)) !== dateDay;
  return dateDay !== day(now) || changed ? `${dateDay} · ${label}` : label;
};

/** The existing message or turn boundary's recorded instant; old compacted items may lack it. */
export const transcriptRowTime = (row: TranscriptRow): string | undefined => {
  switch (row.kind) {
    case "user": return row.entry.sentAt;
    case "assistant": return row.entry.startedAt;
    case "calls": return row.calls[0]?.startedAt;
    case "turn": return row.run.endedAt ?? undefined;
    default: return undefined;
  }
};
