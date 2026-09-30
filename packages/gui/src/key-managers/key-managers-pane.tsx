import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useFollowed, useRuntime } from "../window-context.js";
import { AddConnection } from "./add-connection.js";
import { ConnectionCard } from "./connection-card.js";

/**
 * The Key managers row, `access.key-managers` (key-managers spec; ADR 0011,
 * ADR 0028; docs/specs/gui.md, "Settings"; #425), on the environment its
 * picker names: a card per connection from `keyManagers.list` in the request
 * cache, which every key-manager event refreshes, with each connection's
 * CLI row from `tools.list`, and Add. Everything drawn is the runtime's; the
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
  const listed = useFollowed(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.list", {}), [runtime, environmentId]));
  const toolsAnswer = runtime.capability(environmentId, "tools.list");
  const tooled = useFollowed(useMemo(() => (toolsAnswer.status === "present" ? runtime.requests.cached(environmentId, "tools.list", {}) : undefined), [runtime, environmentId, toolsAnswer.status]));
  const [adding, setAdding] = useState(false);
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
  const connections = listed?.result?.connections ?? null;
  const tools = toolsAnswer.status === "absent" ? toolsAnswer.message : (tooled?.result?.tools ?? []);
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "keyManagers.connections.add");
  const writable = admin.status === "present";
  return (
    <>
      {hint}
      {!ready && (
        <p className="text-sm text-amber">
          {reachWords(runtime, view)}: {connections === null ? "this window has read none of its key managers." : "its key managers as this window last read them, read-only."}
        </p>
      )}
      {ready && admin.status === "absent" && <p className="text-sm text-amber">Read-only: {admin.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={!writable} onClick={() => setAdding(true)}>
          Add a key manager
        </Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {connections === null
        ? ready && <p className="text-sm text-ink-faint">{listed?.error == null ? "Reading the key managers…" : `The key managers could not be read: ${listed.error.message}`}</p>
        : connections.length === 0
          ? <p className="text-sm text-ink-muted">No key manager is connected here.</p>
          : connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} tools={tools} />)}
      {adding && <AddConnection environmentId={environmentId} environmentName={nameOf(view)} close={() => setAdding(false)} say={say} />}
    </>
  );
};
