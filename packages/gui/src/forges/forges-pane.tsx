import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import { Plus } from "lucide-react";
import { ActionButton as Button, useInlineAdd } from "../key-managers/action-button.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useMemo, useState, type ComponentType } from "react";
import { nameOf } from "../connections/words.js";
import { afterReach, reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { AddForge, type AddForgeGh } from "./add-forge.js";
import { ForgeCard, type ForgeCardProps } from "./forge-card.js";

/**
 * The Forges row, `access.forges` (forge spec, "The Forges step" and "Wire
 * methods"; ADR 0020, ADR 0032; docs/specs/gui.md, "Settings"; #419), on the
 * environment its picker names: a card per forge account from
 * `forge.accounts.list` in the request cache, which every `forge.account.*`
 * event refreshes, and Add, by a pasted token or this computer's `gh`.
 * Everything drawn is the runtime's; the pane keeps nothing of the forge
 * accounts itself (ADR 0004), only what a person has typed and the last line
 * it said.
 *
 * Without the `forge` flag the row holds its reason alone; without `admin`
 * it is read-only with the capability's line; while the environment cannot
 * be reached it shows the forge accounts as this window last read them,
 * read-only, with since when.
 */
export const ForgesPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <ForgesOn key={picked.environmentId} view={picked} />;
};

/** The row offers this computer's `gh` on every environment, and leaves the environment's own to the Forges step (#589). */
const ROW_GH: AddForgeGh = { computer: true, machine: false };

const ForgesOn = ({ view }: { readonly view: EnvironmentView }) => (
  <div data-access-pane className="flex min-w-0 flex-col gap-3.5">
    <p className="text-sm text-ink-muted">{settingsRow("access.forges").hint}</p>
    <ForgesList view={view} Account={ForgeCard} gh={ROW_GH} />
  </div>
);

export interface ForgesListProps {
  readonly view: EnvironmentView;
  /** How each forge account is drawn: the Forges row's card, or the Forges step's row (#589). */
  readonly Account: ComponentType<ForgeCardProps>;
  /** The `gh` paths Add a forge offers. */
  readonly gh: AddForgeGh;
}

/**
 * The forge accounts on an environment and Add a forge, as the Forges row
 * and the Forges step's card both draw them: `forge.accounts.list` from the
 * request cache, each drawn as `Account`, and the line the last command
 * said. Without the `forge` flag it holds the flag's line alone.
 */
export const ForgesList = ({ view, Account, gh }: ForgesListProps) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const flagged = runtime.capability(environmentId, "forge");
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.accounts.list", {}), [runtime, environmentId]));
  const { adding, setAdding, trigger } = useInlineAdd();
  const [line, say] = useState<string | undefined>(undefined);

  if (flagged.status === "absent" && flagged.reason === "unsupported") return <p className="text-sm text-amber">{flagged.message}</p>;
  const accounts = listed.result?.accounts ?? null;
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "forge.accounts.add");
  const writable = admin.status === "present";
  return (
    <>
      {!ready && (
        <p className="text-sm text-amber">
          {afterReach(reachWords(runtime, view), accounts === null ? "this window has read none of its forge accounts." : "its forge accounts as this window last read them, read-only.")}
        </p>
      )}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      {!adding && (
        <div className="flex flex-wrap gap-2">
          <Button ref={trigger} icon={Plus} label="Add a forge" variant="default" disabled={!writable} onClick={() => setAdding(true)}>
            Add a forge
          </Button>
        </div>
      )}
      {adding && <AddForge environmentId={environmentId} environmentName={nameOf(view)} close={() => setAdding(false)} say={say} gh={gh} />}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {accounts === null
        ? ready && <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the forge accounts…" : `The forge accounts could not be read: ${listed.error.message}`}</p>
        : accounts.length === 0
          ? <p className="text-sm text-ink-muted">No forge account is on this environment.</p>
          : <SettingsCardGrid>{accounts.map((account) => <Account key={account.id} environmentId={environmentId} account={account} writable={writable} say={say} />)}</SettingsCardGrid>}
    </>
  );
};
