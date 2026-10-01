import { containmentWords, type EnvironmentView } from "@agent-harness/client-runtime";
import { CONTAINMENT_LEVELS } from "@agent-harness/contracts";
import { useMemo } from "react";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button } from "../ui/index.js";
import { useFollowed, useRuntime } from "../window-context.js";

/**
 * What the environment can enforce (ADR 0006, ADR 0025): each containment
 * level, available or not with the probe's reason, from
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
          {CONTAINMENT_LEVELS.map((level) => {
            const availability = report.levels.find((candidate) => candidate.level === level);
            return (
              <li key={level} className={availability?.available === false ? "text-ink-muted" : "text-ink"}>
                {containmentWords(level, false)}: {availability === undefined ? "not reported" : availability.available ? "available" : `not available: ${availability.reason}`}
              </li>
            );
          })}
        </ul>
      )}
      <div>
        <Button onClick={openPermissions}>Open Permissions</Button>
      </div>
    </>
  );
};
