import { SANDBOX_LEVEL_WORDS, describeKey, plainRefusal, sandboxReadiness, sandboxSetup, type EnvironmentView, type SandboxSetup } from "@agent-harness/client-runtime";
import { CONTAINMENT_LEVELS, SETTINGS, type ContainmentLevel, type ContainmentReport } from "@agent-harness/contracts";
import { Box, Shield, ShieldOff } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useSettingsValues } from "../settings/settings-values.js";
import { TechnicalDetails } from "../setup/details.js";
import { useDetails } from "../setup/use-details.js";
import { useObservable, useRuntime } from "../window-context.js";
import { FieldError } from "./field-error.js";
import { SandboxSetupFold } from "./sandbox-setup.js";

const KEY = "permissions.containment.default";

/** What a sandbox the computer refused says when chosen (setup-copy.md §5.12, the messages). */
const UNAVAILABLE = "This sandbox does not work on this computer yet. See How to set it up.";

/** How to set up the workspace levels, including ones the report omitted, one for each cause. */
const sandboxSetups = (report: ContainmentReport): readonly SandboxSetup[] => {
  const container = report.container.declared || report.container.detected;
  const seen = new Set<string>();
  return CONTAINMENT_LEVELS.filter((level) => level !== "off").flatMap((level) => {
    const availability = report.levels.find((entry) => entry.level === level);
    const cause = availability?.cause ?? "not_probed";
    if (availability?.available === true || seen.has(cause)) return [];
    seen.add(cause);
    return [sandboxSetup(availability, container, report.platform)];
  });
};

/**
 * The sandbox (setup-copy.md §5.12; permissions spec, "Containment"; ADR
 * 0006): Off, Project folder and Project folder, no internet, each said to
 * work here or to need setup, from `permissions.settings.get` in the request
 * cache, with How to set it up giving the OS's commands for the levels that
 * need it; the key and the probe's words in Details. A level that needs
 * setup can still be chosen, as the status line's picker lets it be: the
 * environment refuses it (`containment_unavailable`), said as an error.
 * Written through `permissions.settings.set` (`useSettingsValues`).
 */
export const ContainmentDefault = ({ view, writable }: { readonly view: EnvironmentView; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const settings = useSettingsValues(environmentId);
  const permissions = useObservable(useMemo(() => runtime.requests.cached(environmentId, "permissions.settings.get", {}), [runtime, environmentId]));
  const details = useDetails();
  const [refused, say] = useState<{ readonly line: string; readonly details: readonly string[] }>();
  const label = useId();
  const hint = useId();
  if (settings.values === null) return null;
  const chosen = settings.values[KEY] as ContainmentLevel;
  const report = permissions.result?.containment;

  const choose = (level: ContainmentLevel) => {
    say(undefined);
    void settings.save(KEY, level).then((saved) => {
      if (saved.ok) return;
      if (saved.refusal === undefined) return say({ line: saved.line, details: [] });
      const plain = plainRefusal(saved.refusal, SANDBOX_LEVEL_WORDS[level]);
      say(saved.refusal.code === "containment_unavailable" ? { line: UNAVAILABLE, details: plain.details } : plain);
    });
  };
  const setups = report === undefined ? [] : sandboxSetups(report);

  return (
    <div role="group" aria-labelledby={label} className="flex flex-col gap-1.5">
      <span id={label} className="flex items-center gap-1.5 text-xs font-medium text-ink">
        <Box aria-hidden="true" className="size-4" />{SETTINGS[KEY].label}
      </span>
      <p id={hint} className="text-2xs text-ink-muted">{describeKey(KEY)}</p>
      <div role="radiogroup" aria-labelledby={label} aria-describedby={hint} className="flex flex-col gap-0.5 p-1.5">{CONTAINMENT_LEVELS.map((level) => {
        const availability = report?.levels.find((candidate) => candidate.level === level);
        const words = SANDBOX_LEVEL_WORDS[level];
        const note = report === undefined ? "Not checked yet" : sandboxReadiness(availability);
        const Icon = level === "off" ? ShieldOff : level === "workspace" ? Box : Shield;
        return (
          <label key={level} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 text-xs ${chosen === level ? "bg-wash-strong" : "hover:bg-wash"} ${note === "Works here" ? "text-ink" : "text-ink-muted"} ${!writable ? "opacity-50" : ""}`}>
            <input type="radio" aria-label={words} aria-describedby={`${label}-${level}`} name={label} title={`${words} (Arrow keys to choose)`} className="mt-[3px] size-3.5 shrink-0 appearance-none rounded-full border border-line-strong checked:border-beam checked:bg-beam checked:shadow-[inset_0_0_0_3px_var(--panel)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-beam" checked={chosen === level} disabled={!writable} onChange={() => choose(level)} />
            <Icon aria-hidden="true" className="size-4 shrink-0" /><span className="flex min-w-0 flex-col"><span className="font-medium">{words}</span><span id={`${label}-${level}`} className="text-2xs">{note}</span></span>
          </label>
        );
      })}</div>
      {setups.length > 0 && <SandboxSetupFold summary="How to set it up" setups={setups} />}
      <TechnicalDetails
        {...details({
          line: `${SETTINGS[KEY].label}: ${SANDBOX_LEVEL_WORDS[chosen]}.`,
          details: [`${KEY}: ${chosen}`, ...(report?.levels.flatMap((availability) => (availability.available ? [] : [`${availability.level}: ${availability.reason}`])) ?? []), ...(permissions.error === null ? [] : [`permissions.settings.get: ${permissions.error.message}`])],
        })}
      />
      {refused !== undefined && <FieldError line={refused.line} details={refused.details} />}
    </div>
  );
};
