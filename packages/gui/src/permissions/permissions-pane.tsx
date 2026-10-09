import { AccessUnavailable } from "../connections/limited-access.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import type { ComponentType, ReactNode } from "react";
import { readOnlyLine } from "../settings/generic-editor.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useRuntime } from "../window-context.js";
import { ModeChoices } from "./mode-choices.js";
import { ContainmentDefault } from "./containment-default.js";
import { DenylistPart } from "./denylist.js";
import { Part } from "../settings/part.js";
import { PromptTimeout } from "./prompt-timeout.js";
import { UnattendedReview } from "./unattended-review.js";
import { useDenylist, type DenylistValues } from "./use-denylist.js";

/** What the form's safety settings sit in: the step's More safety settings fold, or the Permissions row's part. */
export type SafetySettings = ComponentType<{ readonly children: ReactNode }>;

/** The Permissions row draws the safety settings open, as one part. */
const SafetyPart: SafetySettings = ({ children }) => <Part title="More safety settings">{children}</Part>;

/**
 * The Permissions row, `access.permissions` (permissions spec; ADR 0006,
 * ADR 0027; docs/specs/gui.md, "Settings"; #415), on the environment its
 * picker names: the permissions form, its safety settings open, then the
 * Unattended review. Without `admin` it is read-only with the capability's
 * line, said once; while the environment cannot be reached it shows what
 * this window last read, read-only.
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
      <PermissionsForm view={view} denylist={denylist} safety={SafetyPart} />
      <UnattendedReview view={view} />
    </>
  );
};

/**
 * The permissions form, on the Permissions row and the Permissions step's
 * card (setup-copy.md §5.12; #415, #594, #1858): how much agents may do
 * without asking, then the safety settings in what `safety` draws them in:
 * scheduled runs, the timeout of a question nobody answers, the sandbox and
 * the always-ask list over the list its holder reads (`useDenylist`). The
 * time bypass was first agreed to is the environment's bookkeeping and is
 * not shown. Without `admin` it is read-only with the capability's line,
 * said once; while the environment cannot be reached it shows what this
 * window last read, read-only.
 */
export const PermissionsForm = ({ view, denylist, safety: Safety }: { readonly view: EnvironmentView; readonly denylist: DenylistValues; readonly safety: SafetySettings }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const { values } = useSettingsValues(environmentId);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "permissions.settings.set");
  const writable = ready && admin.status === "present";
  return (
    <>
      {!ready && <p className="text-sm text-amber">{readOnlyLine(runtime, view, values !== null)}</p>}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">You can look but not change this. {admin.message}</p></AccessUnavailable>}
      <ModeChoices view={view} name="permissions.defaultCeiling" writable={writable} />
      <Safety>
        <ModeChoices view={view} name="permissions.unattended.mode" writable={writable} />
        <PromptTimeout view={view} writable={writable} />
        <ContainmentDefault view={view} writable={writable} />
        <DenylistPart view={view} values={denylist} writable={writable} />
      </Safety>
    </>
  );
};
