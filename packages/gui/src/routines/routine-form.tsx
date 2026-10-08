import { BYPASS_SENTENCE, MODES, RoutineDefinitionInput, type RoutineDefinition, type RoutineDefinitionInput as WrittenDefinition } from "@agent-harness/contracts";
import { effortName, modelDisplayName, modelName, uuidv4, type RoutineRow } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { Bot, CalendarClock, FileText, Folder, Gauge, Globe, Save, Shield, User, X } from "lucide-react";
import { Input, Select, Textarea } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { RoutineAction, useRoutineCommand } from "./controls.js";
import { RoutineField, ScheduleFields } from "./schedule-fields.js";

const freshDefinition = (): WrittenDefinition => ({ name: "", schedule: { kind: "daily", at: "09:00" }, instructions: "", workspace: { kind: "directory", path: "", repositoryIdentity: null }, account: null, model: null, effort: null, mode: null, containment: null, skills: [], preCheck: null, enabled: true });

/** Form forms are presentation; the projection stays the authority until a command is accepted. */
export const RoutineForm = ({ row, close }: { readonly row?: RoutineRow; readonly close: () => void }) => {
  const runtime = useRuntime();
  const groups = useObservable(runtime.projections.routines).groups;
  const [where, setWhere] = useState(row?.environmentId ?? groups[0]?.environmentId ?? "");
  return <div data-routine-form className="rounded-lg border border-hairline p-3">
    <RoutineEditor row={row} environmentId={where} choose={setWhere} close={close} />
  </div>;
};

const RoutineEditor = ({ row, environmentId, choose, close }: { readonly row?: RoutineRow | undefined; readonly environmentId: string; readonly choose: (id: string) => void; readonly close: () => void }) => {
  const runtime = useRuntime();
  const groups = useObservable(runtime.projections.routines).groups;
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId])).value ?? [];
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId])).value ?? [];
  const [form, setForm] = useState<WrittenDefinition>(() => row?.definition ?? freshDefinition());
  const [issues, setIssues] = useState<string>();
  const [routineId] = useState(() => row?.routineId ?? uuidv4());
  const command = useRoutineCommand();
  const account = form.account === null ? undefined : accounts.find((held) => JSON.stringify(held.identity) === JSON.stringify(form.account));
  const models = catalogues.filter((catalogue) => account === undefined || catalogue.accountId === account.id).flatMap((catalogue) => catalogue.models);
  const uniqueModels = [...new Map(models.map((model) => [model.id, model])).values()];
  const efforts = uniqueModels.find((model) => model.id === form.model)?.efforts ?? [...new Set(models.flatMap((model) => model.efforts))];
  const patch = (fields: Partial<WrittenDefinition>) => setForm((held) => ({ ...held, ...fields }));
  const method = row === undefined ? "routines.create" : "routines.update";
  const submit = () => {
    setIssues(undefined);
    if (row !== undefined && !form.timezone) { setIssues("Choose a time zone when editing a routine."); return; }
    const parsed = RoutineDefinitionInput.safeParse({ ...form, name: form.name.trim(), instructions: form.instructions.trim() });
    if (!parsed.success) { setIssues(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    if (parsed.data.workspace.kind === "directory" && parsed.data.workspace.path.trim() === "") { setIssues("Choose a workspace directory."); return; }
    if (row === undefined) {
      void command.send(() => runtime.commands.dispatch(environmentId, "routines.create", { routineId, definition: parsed.data }), close);
    } else {
      // Update only the fields this editor owns; keep pre-check, delivery, skills and containment intact.
      const fields: Partial<RoutineDefinition> = { name: parsed.data.name, schedule: parsed.data.schedule, instructions: parsed.data.instructions, workspace: parsed.data.workspace, account: parsed.data.account, model: parsed.data.model, effort: parsed.data.effort, mode: parsed.data.mode };
      if (parsed.data.timezone !== undefined) fields.timezone = parsed.data.timezone;
      void command.send(() => runtime.commands.dispatch(environmentId, "routines.update", { routineId, fields }), close);
    }
  };
  return <form aria-label={row ? "Edit routine" : "New routine"} className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
    <div className="grid grid-cols-2 gap-3">
      <RoutineField label="Name" icon={<CalendarClock aria-hidden="true" />}><Input aria-label="Name" value={form.name} maxLength={40} onChange={(event) => patch({ name: event.target.value })} /></RoutineField>
      <RoutineField label="Where" icon={<Globe aria-hidden="true" />}><Select aria-label="Where" disabled={row !== undefined} value={environmentId} onChange={(event) => { choose(event.target.value); patch({ account: null, model: null, effort: null }); }}>{groups.map((group) => <option key={group.environmentId} value={group.environmentId}>{group.name}</option>)}</Select></RoutineField>
      <RoutineField label="Account" icon={<User aria-hidden="true" />}><Select aria-label="Account" value={form.account === null ? "" : account?.id ?? "missing"} onChange={(event) => patch({ account: accounts.find((held) => held.id === event.target.value)?.identity ?? null, model: null, effort: null })}><option value="">Environment default</option>{form.account !== null && account === undefined && <option disabled value="missing">{form.account.email} (unavailable)</option>}{accounts.filter((held) => held.identity !== null).map((held) => <option key={held.id} value={held.id}>{held.label}</option>)}</Select></RoutineField>
      <RoutineField label="Model" icon={<Bot aria-hidden="true" />}><Select aria-label="Model" value={form.model ?? ""} onChange={(event) => patch({ model: event.target.value || null, effort: null })}><option value="">Environment default</option>{form.model && !uniqueModels.some((model) => model.id === form.model) && <option disabled value={form.model}>{modelDisplayName(form.model)} (unavailable)</option>}{uniqueModels.map((model) => <option key={model.id} value={model.id}>{modelName(model)}</option>)}</Select></RoutineField>
      <RoutineField label="Effort" icon={<Gauge aria-hidden="true" />}><Select aria-label="Effort" value={form.effort ?? ""} onChange={(event) => patch({ effort: event.target.value || null })}><option value="">Environment default</option>{form.effort && !efforts.includes(form.effort) && <option disabled value={form.effort}>{effortName(form.effort)} (unavailable)</option>}{efforts.map((effort) => <option key={effort} value={effort}>{effortName(effort)}</option>)}</Select></RoutineField>
      <RoutineField label="Permission" icon={<Shield aria-hidden="true" />}><Select aria-label="Permission" value={form.mode ?? ""} onChange={(event) => patch({ mode: MODES.find((mode) => mode === event.target.value) ?? null })}><option value="">Unattended default</option>{MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</Select></RoutineField>
    </div>
    {form.mode === "bypassPermissions" && <p className="text-xs text-amber">{BYPASS_SENTENCE}</p>}
    {form.workspace.kind === "directory" ? <RoutineField label="Workspace" icon={<Folder aria-hidden="true" />}><Input aria-label="Workspace" value={form.workspace.path} onChange={(event) => patch({ workspace: { kind: "directory", path: event.target.value, repositoryIdentity: null } })} /></RoutineField> : <p className="text-xs text-ink-muted">Workspace: {form.workspace.kind} (preserved)</p>}
    <ScheduleFields schedule={form.schedule} change={(schedule) => patch({ schedule })} />
    <RoutineField label="Time zone" icon={<Globe aria-hidden="true" />}><Input aria-label="Time zone" placeholder={row === undefined ? "Environment time zone" : "IANA time zone"} value={form.timezone ?? ""} onChange={(event) => patch({ timezone: event.target.value || undefined })} /></RoutineField>
    <RoutineField label="Instructions" icon={<FileText aria-hidden="true" />}><Textarea aria-label="Instructions" rows={4} value={form.instructions} onChange={(event) => patch({ instructions: event.target.value })} /></RoutineField>
    {(issues || command.line) && <p role="alert" className="text-xs text-signal">{issues ?? command.line}</p>}
    <div className="flex justify-end gap-2"><RoutineAction label="Cancel" icon={<X aria-hidden="true" />} disabled={command.busy} onClick={close} /><RoutineAction label={row ? "Save" : "Create"} icon={<Save aria-hidden="true" />} environmentId={environmentId} method={method} disabled={command.busy} onClick={submit} /></div>
  </form>;
};
