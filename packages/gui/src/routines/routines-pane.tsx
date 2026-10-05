import { SettingsCardGrid } from "../settings/part.js";
import { describeSchedule, type RoutineEntry } from "@agent-harness/contracts";
import type { RoutineRow } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { CalendarClock, ChevronDown, History, Pause, Pencil, Play, Plus, Trash2, X } from "lucide-react";
import { EnvironmentMark } from "../connections/environment-mark.js";
import { useSettings } from "../settings/settings-window.js";
import { reachWords } from "../settings/generic-editor.js";
import { useOpenInPane } from "../session/pane-line.js";
import { useObservable, useRuntime } from "../window-context.js";
import { RoutineAction, useRoutineCommand } from "./controls.js";
import { RoutineForm } from "./routine-form.js";

export const scheduleWords = (row: RoutineRow): string => describeSchedule({ schedule: row.definition.schedule, timezone: row.definition.timezone ?? "UTC" });
export const entryWords = (entry: RoutineEntry): string => entry.kind === "firing" ? entry.outcome ?? "Running" : entry.reason;
const stamp = (value: string): string => new Date(value).toLocaleString();

const RoutineHistory = ({ row }: { readonly row: RoutineRow }) => {
  const runtime = useRuntime();
  const history = useMemo(() => runtime.projections.routineHistory(row.environmentId, row.routineId), [runtime, row.environmentId, row.routineId]);
  const view = useObservable(history);
  const open = useOpenInPane();
  const settings = useSettings();
  return <div className="flex flex-col gap-2 border-t border-hairline pt-2 text-2xs text-ink-muted">
    {view.loading && <p role="status">Loading history…</p>}
    {view.error !== null && <p role="alert" className="text-signal">{view.error.message}</p>}
    {view.fetchedAt !== null && view.error === null && !view.loading && view.entries.length === 0 && <p>No runs yet.</p>}
    {view.entries.map((entry) => <div key={entry.id} className="rounded-md bg-wash p-2">
      <p>{stamp(entry.dueAt)} · {entryWords(entry)}</p>
      {entry.kind === "firing" ? <><p className="whitespace-pre-wrap">{entry.text}</p><RoutineAction label="Open session" icon={<Play aria-hidden="true" />} onClick={() => { open(row.environmentId, entry.sessionId); settings.close(); }} /></> : entry.detail !== null && <p>{entry.detail}</p>}
    </div>)}
    {!view.complete && <RoutineAction label="Load older runs" icon={<ChevronDown aria-hidden="true" />} disabled={view.loading} onClick={() => void history.more()} />}
  </div>;
};

const RoutineCard = ({ row, stale }: { readonly row: RoutineRow; readonly stale: boolean }) => {
  const runtime = useRuntime();
  const command = useRoutineCommand();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { definition, listed } = row;
  const busy = command.busy || row.pending;
  const target = { routineId: row.routineId };
  const last = listed?.state.lastOutcome;
  return <section aria-label={definition.name} data-routine-card className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
    <div className="flex items-center gap-2"><CalendarClock aria-hidden="true" className="size-4 text-ink-muted" /><h4 className="text-xs font-medium text-ink">{definition.name}</h4><span className="ml-auto text-2xs text-ink-faint">{listed?.state.liveFiring ? "Running" : definition.enabled ? "Scheduled" : "Paused"}</span></div>
    <p className="text-2xs text-ink-muted">{scheduleWords(row)}</p>
    <p className="text-2xs text-ink-faint">Next run: {listed?.nextDueAt ? stamp(listed.nextDueAt) : "None"} · Last result: {last ? (last.kind === "firing" ? last.outcome : last.reason) : "No runs yet"}</p>
    {(listed?.attention.length ?? 0) > 0 && <p className="text-2xs text-amber">Needs attention: {listed?.attention.join(", ")}</p>}
    {row.pending && <p role="status" className="text-2xs text-amber">Waiting for the environment…</p>}
    {command.line && <p role="alert" className="text-xs text-signal">{command.line}</p>}
    <div className="flex flex-wrap gap-1.5">
      <RoutineAction label="Run now" icon={<Play aria-hidden="true" />} environmentId={row.environmentId} method="routines.runNow" disabled={busy || stale || listed?.state.liveFiring !== null && listed?.state.liveFiring !== undefined} onClick={() => void command.send(() => runtime.commands.dispatch(row.environmentId, "routines.runNow", target))} />
      <RoutineAction label={definition.enabled ? "Pause" : "Resume"} icon={definition.enabled ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />} environmentId={row.environmentId} method={definition.enabled ? "routines.disable" : "routines.enable"} disabled={busy} onClick={() => void command.send(() => runtime.commands.dispatch(row.environmentId, definition.enabled ? "routines.disable" : "routines.enable", target))} />
      <RoutineAction label="Edit" icon={<Pencil aria-hidden="true" />} environmentId={row.environmentId} method="routines.update" disabled={busy} onClick={() => setEditing(!editing)} />
      <RoutineAction label="Delete" icon={<Trash2 aria-hidden="true" />} environmentId={row.environmentId} method="routines.delete" disabled={busy} onClick={() => setDeleting(true)} />
      <RoutineAction label={history ? "Hide history" : "History"} icon={<History aria-hidden="true" />} onClick={() => setHistory(!history)} />
    </div>
    {deleting && <div role="group" aria-label="Delete routine" className="flex flex-wrap items-center gap-2 text-xs"><p>Delete {definition.name}? Its history remains.</p><RoutineAction label="Confirm delete" danger icon={<Trash2 aria-hidden="true" />} disabled={busy} onClick={() => void command.send(() => runtime.commands.dispatch(row.environmentId, "routines.delete", target), () => setDeleting(false))} /><RoutineAction label="Cancel delete" icon={<X aria-hidden="true" />} onClick={() => setDeleting(false)} /></div>}
    {editing && <RoutineForm row={row} close={() => setEditing(false)} />}
    {history && <RoutineHistory row={row} />}
  </section>;
};

/** Everywhere scope: one list per enabled environment, including cached lists after a disconnect. */
export const RoutinesPane = () => {
  const runtime = useRuntime();
  const view = useObservable(runtime.projections.routines);
  const environments = useObservable(runtime.projections.environments);
  const [creating, setCreating] = useState(false);
  return <>
    <div className="flex items-start justify-between gap-3"><p className="text-2xs leading-relaxed text-ink-muted">Runs on a schedule, in the same sessions and history as a prompt you type. Each environment runs its routines even when this window is closed.</p><RoutineAction label="New routine" icon={<Plus aria-hidden="true" />} disabled={view.groups.length === 0} onClick={() => setCreating(true)} /></div>
    {creating && <RoutineForm close={() => setCreating(false)} />}
    {view.attention > 0 && <p className="text-xs text-amber">{view.attention} routines need attention.</p>}
    {view.groups.every((group) => group.fetchedAt !== null && !group.loading && group.error === null && group.routines.length === 0) && <p className="py-2 text-2xs leading-relaxed text-ink-faint">Nothing scheduled. A routine is a prompt with an appointment — a morning triage, a nightly digest — run under the account you pick.</p>}
    {view.groups.map((group) => {
      const environment = environments.find((held) => held.environmentId === group.environmentId);
      return <section key={group.environmentId} aria-label={group.name} className="flex flex-col gap-2">
        <header className="flex items-center gap-2 text-xs font-medium"><h3>{group.name}</h3>{environment && <EnvironmentMark view={environment} />}</header>
        {environment?.phase !== "ready" && environment && <p className="text-2xs text-amber">{reachWords(runtime, environment)}.</p>}
        {group.stale && <p className="text-2xs text-ink-faint">Cached: what this window last saw.</p>}
        {group.loading && <p role="status" className="text-2xs text-ink-faint">Loading routines…</p>}
        {group.error && <p role="alert" className="text-xs text-signal">{group.error.message}</p>}
        <SettingsCardGrid>{group.routines.map((row) => <RoutineCard key={row.routineId} row={row} stale={group.stale} />)}</SettingsCardGrid>
      </section>;
    })}
  </>;
};
