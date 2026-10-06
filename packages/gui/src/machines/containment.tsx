import { Shield, ShieldCheck, ShieldOff } from "lucide-react";
import { listWords, type EnvironmentView } from "@agent-harness/client-runtime";
import { CONTAINMENT_LEVELS, type ContainmentAvailability as LevelAvailability, type ContainmentLevel, type ContainmentReport } from "@agent-harness/contracts";
import { useMemo } from "react";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button } from "../ui/index.js";
import { useFollowed, useRuntime } from "../window-context.js";

const LABELS: Record<ContainmentLevel, string> = { off: "Off", workspace: "Workspace", "workspace-no-network": "No network" };
const ICONS: Record<ContainmentLevel, typeof Shield> = { off: ShieldOff, workspace: Shield, "workspace-no-network": ShieldCheck };

/** One line of the list: the levels it says, and their availability, undefined when the report lacks them. */
interface Line {
  readonly levels: [ContainmentLevel, ...ContainmentLevel[]];
  readonly availability: LevelAvailability | undefined;
}

const sameRefusal = (one: LevelAvailability | undefined, other: LevelAvailability): boolean =>
  one?.available === false && !other.available && one.reason === other.reason && one.cause === other.cause && one.detail === other.detail;

/** The report's levels as lines, in level order: levels refused for one reason share a line, so the reason is said once (#1756). */
const linesOf = (report: ContainmentReport): Line[] =>
  CONTAINMENT_LEVELS.reduce<Line[]>((lines, level) => {
    const availability = report.levels.find((candidate) => candidate.level === level);
    const shared = availability === undefined ? undefined : lines.find((line) => sameRefusal(line.availability, availability));
    if (shared === undefined) lines.push({ levels: [level], availability });
    else shared.levels.push(level);
    return lines;
  }, []);

/**
 * What the environment can enforce (ADR 0006, ADR 0025): each containment
 * level, available or not with the probe's reason, said once for the levels
 * that share it, and what the mechanism printed folded behind Details (#1756), from
 * `permissions.settings.get` in the request cache, so an unreachable
 * environment's is what this window last read; and a pointer to Permissions
 * on that environment, where its default level is set: in the full
 * checklist, its Permissions step with the picker switched to it (#576);
 * in Settings, its Permissions row.
 */
export const ContainmentAvailability = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { open, pick } = useSettings();
  const checklist = useChecklist();
  const openPermissions = () => {
    if (!checklist.shown) return open("access.permissions", view.environmentId);
    pick(view.environmentId);
    checklist.choose("permissions");
  };
  const permissions = useFollowed(useMemo(() => runtime.requests.cached(view.environmentId, "permissions.settings.get", {}), [runtime, view.environmentId]));
  const report = permissions?.result?.containment;
  return (
    <>
      {report === undefined ? (
        permissions?.error ? (
          <p className="text-sm text-signal">
            What {nameOf(view)} can enforce could not be read: {permissions.error.message}
          </p>
        ) : (
          view.phase === "ready" && <p className="text-sm text-ink-faint">Reading what {nameOf(view)} can enforce…</p>
        )
      ) : (
        <ul className="flex flex-col gap-0.5 text-sm">
          {linesOf(report).map(({ levels, availability }) => {
            const [first] = levels;
            const Icon = ICONS[first];
            const label = listWords(levels.map((level) => LABELS[level]));
            return (
              <li key={first} className={`flex items-start gap-2 text-xs ${availability?.available === false ? "text-ink-muted" : "text-ink"}`}>
                <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <div className="min-w-0">
                  <span>{label}: {availability === undefined ? "not reported" : availability.available ? "available" : `not available: ${availability.reason}`}</span>
                  {availability?.available === false && availability.detail !== undefined && (
                    <details>
                      <summary className="cursor-pointer">Details</summary>
                      <p className="whitespace-pre-wrap break-words font-mono text-2xs">{availability.detail}</p>
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button onClick={openPermissions} title="Open Permissions (Enter or Space)"><Shield aria-hidden="true" data-icon="inline-start" />Open Permissions</Button>
      </div>
    </>
  );
};
