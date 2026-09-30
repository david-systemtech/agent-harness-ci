import { homeEnvironment, noKeysLine, rowKeys, rowSteps, type EnvironmentView } from "@agent-harness/client-runtime";
import { FIRST_ROW, settingsRow, type SettingsRowId } from "@agent-harness/contracts";
import { useId, type ComponentType, type ReactNode } from "react";
import { AccountsPane } from "../accounts/accounts-pane.js";
import { DefaultModelPane } from "../accounts/default-model-pane.js";
import { UsagePane } from "../accounts/usage-pane.js";
import { APPEARANCE_PANES } from "../appearance/panes.js";
import { EnvironmentMark } from "../connections/environment-mark.js";
import { KeyManagersPane } from "../key-managers/key-managers-pane.js";
import { PermissionsPane } from "../permissions/permissions-pane.js";
import { THIS_MACHINE } from "../frame/sidebar-region.js";
import { YourMachines } from "../machines/your-machines.js";
import { SetupPane } from "../setup/setup-pane.js";
import { useCheckHomedSteps } from "../setup/use-setup.js";
import { useClientVersion, useObservable, useRuntime } from "../window-context.js";
import { EnvironmentPicker } from "./environment-picker.js";
import { GenericEditor, reachWords } from "./generic-editor.js";
import { dimReason } from "./rail.js";
import { usePickedEnvironment } from "./settings-window.js";
import { StepLinks } from "./step-links.js";

/** One environment's part of an `everywhere` row: its heading with its name, icon and colour, then what the row holds of it. */
const EnvironmentGroup = ({ view, children }: { readonly view: EnvironmentView; readonly children: ReactNode }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <header className="flex items-center gap-2">
        <h3 id={heading} className="text-sm font-semibold text-ink">
          {view.name ?? THIS_MACHINE}
        </h3>
        <EnvironmentMark view={view} />
      </header>
      {children}
    </section>
  );
};

/** Since when an environment has not been reached, where a row holds nothing else of it; nothing while it is ready. */
const Reach = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  return view.phase === "ready" ? null : <p className="text-sm text-amber">{reachWords(runtime, view)}.</p>;
};

/**
 * The keys a row holds, in the generic editor, on the environments its scope
 * names (ADR 0027): an `environment` row's on the environment picked; an
 * `everywhere` row's on every environment, each under its heading; a `client`
 * row's on the home environment.
 */
const RowKeys = ({ row }: { readonly row: SettingsRowId }) => {
  const { scope } = settingsRow(row);
  const keys = rowKeys(row);
  const environments = useObservable(useRuntime().projections.environments);
  const picked = usePickedEnvironment();
  if (scope === "everywhere") {
    return (
      <>
        {keys.length === 0 && <p className="text-sm text-ink-faint">{noKeysLine(row)}</p>}
        {environments.map((view) => (
          <EnvironmentGroup key={view.environmentId} view={view}>
            {keys.length === 0 ? <Reach view={view} /> : <GenericEditor view={view} keys={keys} />}
          </EnvironmentGroup>
        ))}
      </>
    );
  }
  if (keys.length === 0) return <p className="text-sm text-ink-faint">{noKeysLine(row)}</p>;
  const view = scope === "environment" ? picked : homeEnvironment(environments);
  return view === undefined ? null : <GenericEditor key={view.environmentId} view={view} keys={keys} />;
};

/**
 * What a row whose feature is not built shows (docs/specs/gui.md, "Settings:
 * the rail, the rows and the addresses"): its hint, a link to each step of
 * Set up it belongs to, which opens the full checklist on that step, and the
 * generic editor for its keys; a placeholder row, its hint and why it is dim.
 */
const UnbuiltRow = ({ row }: { readonly row: SettingsRowId }) => {
  const entry = settingsRow(row);
  const dim = dimReason(entry);
  return (
    <>
      <p className="text-sm text-ink-muted">{entry.hint}</p>
      {dim !== undefined ? (
        <p className="text-sm text-ink-faint">{dim}</p>
      ) : (
        <>
          <StepLinks steps={rowSteps(row)} />
          <RowKeys row={row} />
        </>
      )}
    </>
  );
};

/** The panes built, each keyed by the row it draws (docs/specs/gui.md: a pane is a GUI component keyed by row id); every other row is drawn unbuilt. */
const BUILT_PANES: Partial<Readonly<Record<SettingsRowId, ComponentType>>> = {
  [FIRST_ROW]: SetupPane,
  "accounts.accounts": AccountsPane,
  "accounts.default-model": DefaultModelPane,
  "accounts.usage": UsagePane,
  "environments.machines": YourMachines,
  "access.key-managers": KeyManagersPane,
  "access.permissions": PermissionsPane,
  ...APPEARANCE_PANES,
};

/**
 * A row's pane (ADR 0027): its heading, then in its header what its scope
 * gives it (an `environment` row's picker, none for `everywhere` and
 * `client` rows), About with this client's version pinned above its picker
 * as the one line that belongs to no environment, then what the row holds:
 * its built pane (Set up's checklist, the three Accounts rows, Your
 * machines' cards, Key managers, Permissions), the unbuilt row's hint, links and keys on
 * the others. Opening a step's home row checks that step.
 */
export const RowPane = ({ row }: { readonly row: SettingsRowId }) => {
  const entry = settingsRow(row);
  const version = useClientVersion();
  const heading = useId();
  const Built = BUILT_PANES[row];
  useCheckHomedSteps(row);
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-col gap-2">
        <h2 id={heading} className="text-lg font-semibold text-ink">
          {entry.label}
        </h2>
        {row === "about.about" && <p className="text-sm text-ink">This client: {version}</p>}
        {entry.scope === "environment" && <EnvironmentPicker />}
      </header>
      {Built === undefined ? <UnbuiltRow row={row} /> : <Built />}
    </section>
  );
};
