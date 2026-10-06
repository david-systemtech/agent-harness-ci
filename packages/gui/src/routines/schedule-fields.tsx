import { ROUTINE_DAYS, type RoutineDay, type RoutineSchedule } from "@agent-harness/contracts";
import { Calendar, CalendarClock, Clock, Code, Hash } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Input, Select, Tooltip } from "../ui/index.js";

export const RoutineField = ({ label, icon, children }: { readonly label: string; readonly icon: ReactNode; readonly children: ReactElement }) => <label className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted"><span className="flex items-center gap-1.5 [&_svg]:size-3">{icon}{label}</span><Tooltip content={label} keys="Tab to focus">{children}</Tooltip></label>;

const kinds = [["daily", "Daily"], ["weekdays", "Weekdays"], ["days", "Some days"], ["weekly", "Weekly"], ["monthly", "Monthly"], ["hourly", "Hourly"], ["cron", "Cron"], ["manual", "Manual"]] as const;
const initial = (kind: RoutineSchedule["kind"]): RoutineSchedule => {
  switch (kind) {
    case "daily": case "weekdays": return { kind, at: "09:00" };
    case "days": return { kind, at: "09:00", days: ["monday"] };
    case "weekly": return { kind, at: "09:00", day: "monday" };
    case "monthly": return { kind, at: "09:00", day: 1 };
    case "hourly": return { kind, minute: 0 };
    case "cron": return { kind, expression: "0 9 * * *" };
    case "manual": return { kind };
  }
};
export const ScheduleFields = ({ schedule, change }: { readonly schedule: RoutineSchedule; readonly change: (next: RoutineSchedule) => void }) => <div className="flex flex-wrap items-end gap-2">
  <RoutineField label="Schedule" icon={<CalendarClock aria-hidden="true" />}><Select aria-label="Schedule" className="w-32" value={schedule.kind} onChange={(event) => { const kind = kinds.find(([value]) => value === event.target.value)?.[0]; if (kind !== undefined) change(initial(kind)); }}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></RoutineField>
  {"at" in schedule && <RoutineField label="Time" icon={<Clock aria-hidden="true" />}><Input aria-label="Time" type="time" className="w-24" value={schedule.at} onChange={(event) => change({ ...schedule, at: event.target.value })} /></RoutineField>}
  {schedule.kind === "weekly" && <RoutineField label="Weekday" icon={<Calendar aria-hidden="true" />}><Select aria-label="Weekday" className="w-32" value={schedule.day} onChange={(event) => { const day = ROUTINE_DAYS.find((value) => value === event.target.value); if (day) change({ ...schedule, day }); }}>{ROUTINE_DAYS.map((day) => <option key={day} value={day}>{day}</option>)}</Select></RoutineField>}
  {schedule.kind === "monthly" && <RoutineField label="Day of month" icon={<Hash aria-hidden="true" />}><Input aria-label="Day of month" type="number" min={1} max={31} className="w-16" value={schedule.day} onChange={(event) => change({ ...schedule, day: Number(event.target.value) })} /></RoutineField>}
  {schedule.kind === "hourly" && <RoutineField label="Minute" icon={<Clock aria-hidden="true" />}><Input aria-label="Minute" type="number" min={0} max={59} className="w-16" value={schedule.minute} onChange={(event) => change({ ...schedule, minute: Number(event.target.value) })} /></RoutineField>}
  {schedule.kind === "cron" && <RoutineField label="Cron expression" icon={<Code aria-hidden="true" />}><Input aria-label="Cron expression" className="w-44 font-mono" value={schedule.expression} onChange={(event) => change({ ...schedule, expression: event.target.value })} /></RoutineField>}
  {schedule.kind === "days" && <div role="group" aria-label="Days" className="flex flex-wrap gap-1">{ROUTINE_DAYS.map((day: RoutineDay) => <label key={day} className="flex items-center gap-1 rounded-md border border-hairline p-1 text-2xs"><Tooltip content={day} keys="Space"><input type="checkbox" aria-label={day} checked={schedule.days.includes(day)} onChange={(event) => change({ ...schedule, days: event.target.checked ? [...schedule.days, day] : schedule.days.filter((held) => held !== day) })} /></Tooltip><Calendar aria-hidden="true" className="size-3" />{day.slice(0, 3)}</label>)}</div>}
</div>;
