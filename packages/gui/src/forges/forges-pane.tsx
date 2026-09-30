import type { EnvironmentView } from "@agent-harness/client-runtime";
import { settingsRow } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { nameOf } from "../connections/words.js";
import { reachWords } from "../settings/generic-editor.js";
import { usePickedEnvironment } from "../settings/settings-window.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { AddForge } from "./add-forge.js";
import { ForgeCard } from "./forge-card.js";

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

const ForgesOn = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const flagged = runtime.capability(environmentId, "forge");
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.accounts.list", {}), [runtime, environmentId]));
  const [adding, setAdding] = useState(false);
  const [line, say] = useState<string | undefined>(undefined);
  const hint = <p className="text-sm text-ink-muted">{settingsRow("access.forges").hint}</p>;

  if (flagged.status === "absent" && flagged.reason === "unsupported") {
    return (
      <>
        {hint}
        <p className="text-sm text-amber">{flagged.message}</p>
      </>
    );
  }
  const accounts = listed.result?.accounts ?? null;
  const ready = view.phase === "ready";
  const admin = runtime.capability(environmentId, "forge.accounts.add");
  const writable = admin.status === "present";
  return (
    <>
      {hint}
      {!ready && (
        <p className="text-sm text-amber">
          {reachWords(runtime, view)}: {accounts === null ? "this window has read none of its forge accounts." : "its forge accounts as this window last read them, read-only."}
        </p>
      )}
      {ready && admin.status === "absent" && <p className="text-sm text-amber">Read-only: {admin.message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button tone="primary" disabled={!writable} onClick={() => setAdding(true)}>
          Add a forge
        </Button>
      </div>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {accounts === null
        ? ready && <p className="text-sm text-ink-faint">{listed.error === null ? "Reading the forge accounts…" : `The forge accounts could not be read: ${listed.error.message}`}</p>
        : accounts.length === 0
          ? <p className="text-sm text-ink-muted">No forge account is on this environment.</p>
          : accounts.map((account) => <ForgeCard key={account.id} environmentId={environmentId} account={account} writable={writable} say={say} />)}
      {adding && <AddForge environmentId={environmentId} environmentName={nameOf(view)} close={() => setAdding(false)} say={say} />}
    </>
  );
};
