import { AccessUnavailable } from "../connections/limited-access.js";
import { rowKeys, type EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { GenericEditor, readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useRuntime } from "../window-context.js";
import { ModeChoices } from "./mode-choices.js";
import { ContainmentDefault } from "./containment-default.js";
import { DenylistPart } from "./denylist.js";
import { Part } from "../settings/part.js";
import { UnattendedReview } from "./unattended-review.js";
import { useDenylist, type DenylistValues } from "./use-denylist.js";

/** The TTL and recorded acknowledgement remain in the generic editor; modes and containment have described choices. */
const PLAIN_KEYS = rowKeys("access.permissions").filter((key) => key !== "permissions.containment.default" && key !== "permissions.defaultCeiling" && key !== "permissions.unattended.mode");

/**
 * The Permissions row, `access.permissions` (permissions spec; ADR 0006,
 * ADR 0027; docs/specs/gui.md, "Settings"; #415), on the environment its
 * picker names: the permission settings, written through
 * `permissions.settings.set` (described ceiling and unattended choices,
 * the bypass sentence and its acknowledgement, the recorded time and TTL
 * in the generic editor; the
 * containment default with each level's availability). Without `admin` it
 * is read-only with the capability's line, said once; while the environment
 * cannot be reached it shows what this window last read, read-only.
 */
export const PermissionsPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <PermissionsOn key={picked.environmentId} view={picked} />;
};

const PermissionsOn = ({ view }: { readonly view: EnvironmentView }) => {
  const denylist = useDenylist(view.environmentId);
  return (
    <>
      <p className="text-2xs text-ink-faint">{settingsRow("access.permissions").hint}</p>
      <PermissionsForm view={view} denylist={denylist} />
      <UnattendedReview view={view} />
    </>
  );
};

/**
 * The permissions spec's form, on the Permissions row and the Permissions
 * step's card (#415, #594): the permission settings and the denylist, over
 * the denylist its holder reads (`useDenylist`). Without `admin` it is
 * read-only with the capability's line, said once; while the environment
 * cannot be reached it shows what this window last read, read-only.
 */
export const PermissionsForm = ({ view, denylist }: { readonly view: EnvironmentView; readonly denylist: DenylistValues }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { values } = useSettingsValues(environmentId);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "permissions.settings.set");
  const writable = ready && admin.status === "present";
  return (
    <>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      <Part title="Permission settings">
        <ModeChoices view={view} name="permissions.defaultCeiling" writable={writable} />
        <ModeChoices view={view} name="permissions.unattended.mode" writable={writable} />
        <GenericEditor view={view} keys={PLAIN_KEYS} saysWhyReadOnly={false} />
        <ContainmentDefault view={view} writable={writable} />
      </Part>
      <DenylistPart view={view} values={denylist} writable={writable} />
    </>
  );
};
