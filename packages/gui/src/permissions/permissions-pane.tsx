import { rowKeys, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useRuntime } from "../window-context.js";
import { ContainmentDefault } from "./containment-default.js";
import { DenylistPart } from "./denylist.js";
import { Part } from "../settings/part.js";
import { UnattendedReview } from "./unattended-review.js";

/** The permission keys the generic editor draws: every one but the containment default, which the pane draws with each level's availability. */
const PLAIN_KEYS = rowKeys("access.permissions").filter((key) => key !== "permissions.containment.default");

/**
 * The Permissions row, `access.permissions` (permissions spec; ADR 0006,
 * ADR 0027; docs/specs/gui.md, "Settings"; #415), on the environment its
 * picker names: the permission settings, written through
 * `permissions.settings.set` (the default ceiling, the unattended mode with
 * the bypass sentence and its acknowledgement, the acknowledgement's time
 * read-only and the parked-prompt TTL in the generic editor; the
 * containment default with each level's availability). Without `admin` it
 * is read-only with the capability's line, said once; while the environment
 * cannot be reached it shows what this window last read, read-only.
 */
export const PermissionsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <PermissionsOn key={picked.environmentId} view={picked} />;
};

const PermissionsOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { values } = useSettingsValues(environmentId);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "permissions.settings.set");
  const writable = ready && admin.status === "present";
  return (
    <>
      <p className="text-sm text-ink-muted">{settingsRow("access.permissions").hint}</p>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && admin.status === "absent" && <p className="text-sm text-amber">Read-only: {admin.message}</p>}
      <Part title="Permission settings">
        <GenericEditor view={view} keys={PLAIN_KEYS} saysWhyReadOnly={false} />
        <ContainmentDefault view={view} writable={writable} />
      </Part>
      <DenylistPart view={view} writable={writable} />
      <UnattendedReview view={view} />
    </>
  );
};
