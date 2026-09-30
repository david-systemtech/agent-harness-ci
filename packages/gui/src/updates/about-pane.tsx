import { bundledClaudeCodeWords, type EnvironmentView } from "@agent-harness/client-runtime";
import type { MethodName } from "@agent-harness/contracts";
import { lackingLines, readOnlyLine } from "../settings/generic-editor.js";
import { Part } from "../settings/part.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useRuntime } from "../window-context.js";
import { UpdateControls } from "./update-controls.js";
import { useUpdatesStatus } from "./use-updates-status.js";

/** What About's controls send, each at `admin`: the update settings' writer and Update now. */
const SENT: readonly MethodName[] = ["updates.settings.set", "updates.apply"];

/**
 * About, `about.about` (launcher-update spec, "Settings, methods, notices
 * and flags"; ADR 0026, ADR 0027; #424), on the environment its picker
 * names, below this client's version, which the row's header pins: the
 * environment's update controls (its version, channel, auto-update, pending
 * update and Update now) and the Claude Code its version bundles, which
 * updates with it. Without `admin` the controls are read-only with the
 * capability's line, said once; while the environment cannot be reached
 * they show what this window last read, read-only.
 */
export const AboutPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <AboutOn key={picked.environmentId} view={picked} />;
};

const AboutOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const status = useUpdatesStatus(view.environmentId);
  const ready = view.phase === "ready";
  return (
    <>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, status.result !== null)}</p>}
      {ready &&
        lackingLines(runtime, view.environmentId, SENT).map((line) => (
          <p key={line} className="text-sm text-amber">
            Read-only: {line}
          </p>
        ))}
      <Part title="Updates">
        <UpdateControls view={view} />
        {status.result !== null && <p className="text-sm text-ink">{bundledClaudeCodeWords(status.result.bundledClaudeCodeVersion)}</p>}
      </Part>
    </>
  );
};
