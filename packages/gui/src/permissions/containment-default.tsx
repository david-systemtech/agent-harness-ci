import { availabilityWords, containmentWords, describeKey, type EnvironmentView } from "@agent-harness/client-runtime";
import { CONTAINMENT_LEVELS, type ContainmentLevel } from "@agent-harness/contracts";
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
    <div role="radiogroup" aria-labelledby={label} aria-describedby={hint} className="flex flex-col gap-1.5 rounded-md border border-line p-3">
      <span id={label} className="font-mono text-sm text-ink">
        {KEY}
      </span>
      <p id={hint} className="text-xs text-ink-muted">
        {describeKey(KEY)}
      </p>
      {CONTAINMENT_LEVELS.map((level) => {
        const availability = report?.levels.find((candidate) => candidate.level === level);
        return (
          <label key={level} className={`flex items-center gap-2 text-sm ${availability?.available === false ? "text-ink-muted" : "text-ink"}`}>
            <input type="radio" name={label} className="accent-beam" checked={chosen === level} disabled={!writable} onChange={() => choose(level)} />
            {containmentWords(level, false)}: {report !== undefined ? availabilityWords(availability) : permissions.error !== null ? `not read: ${permissions.error.message}` : "not read yet"}
          </label>
        );
      })}
      {line !== undefined && <p className="text-xs text-signal">{line}</p>}
    </div>
  );
};
