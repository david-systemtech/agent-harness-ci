import { AccessUnavailable } from "../connections/limited-access.js";
import { Server } from "lucide-react";
import { UPDATES_MANAGED_OUTSIDE, environmentStateWords, rowKeys, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useMemo } from "react";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { Part } from "../settings/part.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { ServiceVerbs } from "./service-verbs.js";

/** The keys the row holds: auto-settle after idle, auto-settle on merge and the transcript compaction window. */
const SESSION_KEYS = rowKeys("environments.service");

/**
 * The Service row, `environments.service` (env spec, "Lifecycle"; ADR 0007,
 * ADR 0027; docs/specs/gui.md, "Settings"; #417), on the environment its
 * picker names: its state from `environment.status` in the request cache
 * (read again when a drain begins), Drain and Rebuild projections, and the
 * three session keys in the generic editor, written through
 * `settings.update`. Without `admin` the state still shows and the rest is
 * read-only with the capability's line, said once; while the environment
 * cannot be reached it shows what this window last read, read-only.
 */
export const ServicePane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <ServiceOn key={picked.environmentId} view={picked} />;
};

const ServiceOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { values } = useSettingsValues(environmentId);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "environment.drain");
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("environments.service").hint}</p>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      <Part title="State">
        <State view={view} />
        <ServiceVerbs view={view} writable={ready && admin.status === "present"} />
      </Part>
      <Part title="Sessions">
        <GenericEditor view={view} keys={SESSION_KEYS} saysWhyReadOnly={false} />
      </Part>
    </>
  );
};

/** The environment's state as `environment.status` answers it, and whether its updates are managed outside it. */
const State = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "environment.status", {}), [runtime, environmentId]));
  if (status.result === null) {
    return view.phase === "ready" ? (
      <p className="text-sm text-ink-faint">{status.error === null ? "Reading its state…" : `Its state could not be read: ${status.error.message}`}</p>
    ) : null;
  }
  return (
    <div className="flex flex-col gap-0.5 text-sm text-ink">
      <p className="flex items-center gap-2 text-xs"><Server aria-hidden="true" className="size-4 shrink-0 text-cyan" />{environmentStateWords(status.result)}</p>
      {status.result.updatesManagedOutside && <p className="text-ink-muted">{UPDATES_MANAGED_OUTSIDE}</p>}
    </div>
  );
};
