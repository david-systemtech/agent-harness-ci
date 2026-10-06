import { CalendarClock } from "lucide-react";
import { useSettings } from "../settings/settings-window.js";
import { Button, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { scheduleWords } from "./routines-pane.js";

/** Compact appointments above the session rows, with the complete list one click away. */
export const ScheduledStrip = () => {
  const groups = useObservable(useRuntime().projections.routines).groups;
  const settings = useSettings();
  const rows = groups.flatMap((group) => group.routines.map((row) => ({ row, group })));
  if (rows.length === 0) return null;
  const open = () => settings.open("routines.routines");
  return <section aria-label="Scheduled" data-scheduled-strip className="mx-2 mb-2 shrink-0 border-b border-hairline pb-2">
    <h2 className="mb-1 flex items-center gap-1.5 text-2xs font-medium text-ink-muted"><CalendarClock aria-hidden="true" className="size-3" />Scheduled</h2>
    {rows.slice(0, 4).map(({ row, group }) => {
      const status = row.listed?.state.liveFiring ? "Running" : !row.definition.enabled ? "Paused" : row.listed?.nextDueAt ? new Date(row.listed.nextDueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : scheduleWords(row);
      return <Tooltip key={`${row.environmentId}:${row.routineId}`} content={`${row.definition.name} · ${group.name} · ${scheduleWords(row)}`} keys="Enter / Space"><Button onClick={open} className="h-auto w-full justify-start gap-1 rounded-md px-1 py-1 text-2xs [&_svg]:size-3">
        <CalendarClock aria-hidden="true" className="size-3" /><span className="min-w-0 truncate">{row.definition.name}</span><span className="ml-auto shrink-0 text-ink-faint">{status}{group.stale ? " · Cached" : ""}</span>
      </Button></Tooltip>;
    })}
    {rows.length > 4 && <Tooltip content="All routines" keys="Enter / Space"><Button className="h-6 px-1 text-2xs text-ink-faint [&_svg]:size-3" onClick={open}><CalendarClock aria-hidden="true" className="size-3" />and {rows.length - 4} more…</Button></Tooltip>}
  </section>;
};
