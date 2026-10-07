import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import { Plus } from "lucide-react";
import { ActionButton as Button, useInlineAdd } from "./action-button.js";
import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { afterReach, reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { AddConnection } from "./add-connection.js";
import { ConnectionCard } from "./connection-card.js";
import { InjectionSetting } from "./injection-setting.js";
import { MoveCard } from "./move-card.js";

/**
 * The Key managers row, `access.key-managers` (key-managers spec; ADR 0011,
 * ADR 0028; docs/specs/gui.md, "Settings"; #425), on the environment its
 * picker names: a card per connection from `keyManagers.list` in the request
 * cache, which every key-manager event and `tools.updated` refresh, each
 * connection with its CLI's Managed tools row as the list carries it (#375,
 * #776), and Add. Everything drawn is the runtime's; the
 * pane keeps nothing of the connections itself (ADR 0004), only what a
 * person has typed and the last line it said.
 *
 * Without the `keyManagers` flag the row holds its reason alone; without
 * `admin` it is read-only with the capability's line; while the environment
 * cannot be reached it shows the connections as this window last read them,
 * read-only, with since when.
 */
export const KeyManagersPane = () => {
  const picked = usePickedEnvironment();
  return picked === undefined ? null : <KeyManagersOn key={picked.environmentId} view={picked} />;
};

const KeyManagersOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const flagged = runtime.capability(environmentId, "keyManagers");
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.list", {}), [runtime, environmentId]));
  const { adding, setAdding, trigger } = useInlineAdd();
  const [line, say] = useState<string | undefined>(undefined);
  const hint = <p className="text-sm text-ink-muted">{settingsRow("access.key-managers").hint}</p>;

  if (flagged.status === "absent" && flagged.reason === "unsupported") {
    return (
      <>
        {hint}
        <p className="text-sm text-amber">{flagged.message}</p>
      </>
    );
  }
  const connections = listed.result?.connections ?? null;
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "keyManagers.connections.add");
  const writable = admin.status === "present";
  return (
    <div data-access-pane className="flex min-w-0 flex-col gap-3.5">
      {hint}
      {!ready && (
        <p className="text-sm text-amber">
          {afterReach(reachWords(runtime, view), connections === null ? "this window has read none of its key managers." : "its key managers as this window last read them, read-only.")}
        </p>
      )}
      {ready && admin.status === "absent" && <AccessUnavailable environmentId={view.environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      {!adding && (
        <div className="flex flex-wrap gap-2">
          <Button ref={trigger} icon={Plus} label="Add a key manager" variant="default" disabled={!writable} onClick={() => setAdding(true)}>
            Add a key manager
          </Button>
        </div>
      )}
      {adding && <AddConnection environmentId={environmentId} environmentName={nameOf(view)} close={() => setAdding(false)} say={say} />}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {connections === null
        ? ready && <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the key managers…" : `The key managers could not be read: ${listed.error.message}`}</p>
        : connections.length === 0
          ? <p className="text-sm text-ink-muted">No key manager is connected here.</p>
          : <SettingsCardGrid>{connections.map((connection) => <ConnectionCard key={connection.id} environmentId={environmentId} connection={connection} writable={writable} say={say} />)}</SettingsCardGrid>}
      {connections !== null && connections.length > 0 && <MoveCard environmentId={environmentId} connections={connections} writable={writable} />}
      <InjectionSetting view={view} />
    </div>
  );
};
