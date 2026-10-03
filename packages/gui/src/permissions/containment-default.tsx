import { availabilityWords, describeKey, type EnvironmentView } from "@agent-harness/client-runtime";
import { CONTAINMENT_LEVELS, SETTINGS, type ContainmentLevel } from "@agent-harness/contracts";
import { Box, Shield, ShieldOff } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useSettingsValues } from "../settings/settings-values.js";
import { useObservable, useRuntime } from "../window-context.js";

const KEY = "permissions.containment.default";

/**
 * The containment default (permissions spec, "Containment"; ADR 0006): each
 * level with whether the environment can enforce it, from
 * `permissions.settings.get` in the request cache, one it cannot greyed
 * with the probe's reason. A greyed level can still be chosen, as the
 * status line's picker lets it be: the environment refuses it
 * (`containment_unavailable`), said in one line. Written through
 * `permissions.settings.set` (`useSettingsValues`).
 */
export const ContainmentDefault = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const settings = useSettingsValues(environmentId);
  const permissions = useObservable(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const [line, setLine] = useState<string | undefined>(undefined);
  const label = useId();
  const hint = useId();
  if (settings.values === null) return null;
  const chosen = settings.values[KEY];
  const report = permissions.result?.containment;

  const choose = (level: ContainmentLevel) => {
    setLine(undefined);
    void settings.save(KEY, level).then((saved) => !saved.ok && setLine(`Not saved: ${saved.line}`));
  };

  return (
    <div role="radiogroup" aria-labelledby={label} aria-describedby={hint} className="flex flex-col gap-1.5">
      <span id={label} className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <Box aria-hidden="true" className="size-4" />{SETTINGS[KEY].label}
      </span>
      <span className="break-all font-mono text-2xs text-ink-faint">{KEY}</span>
      <p id={hint} className="text-2xs text-ink-muted">
        {describeKey(KEY)}
      </p>
      <div className="flex flex-col gap-0.5 p-1.5">{CONTAINMENT_LEVELS.map((level) => {
        const availability = report?.levels.find((candidate) => candidate.level === level);
        const words = level === "workspace-no-network" ? "no network" : level;
        const note = report !== undefined ? availabilityWords(availability) : permissions.error !== null ? `not read: ${permissions.error.message}` : "not read yet";
        const Icon = level === "off" ? ShieldOff : level === "workspace" ? Box : Shield;
        return (
          <label key={level} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 text-xs ${chosen === level ? "bg-wash-strong" : "hover:bg-wash"} ${availability?.available === false ? "text-ink-muted" : "text-ink"} ${!writable ? "opacity-50" : ""}`}>
            <input type="radio" aria-label={`${words}: ${note}`} name={label} title={`${words} (Arrow keys to choose)`} className="mt-[3px] size-3.5 shrink-0 appearance-none rounded-full border border-line-strong checked:border-beam checked:bg-beam checked:shadow-[inset_0_0_0_3px_var(--panel)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-beam" checked={chosen === level} disabled={!writable} onChange={() => choose(level)} />
            <Icon aria-hidden="true" className="size-4 shrink-0" /><span className="min-w-0"><span className="font-medium">{words}: </span><span className="text-2xs">{note}</span></span>
          </label>
        );
      })}</div>
      {line !== undefined && <p className="text-xs text-signal">{line}</p>}
    </div>
  );
};
