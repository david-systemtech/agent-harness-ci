import { copyLine } from "@agent-harness/client-runtime";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

export interface CopyConnectionProps {
  readonly environmentId: string;
  readonly connection: KeyManagerConnectionRecord;
  readonly close: () => void;
}

/**
 * Copy to other environments (ADR 0028's "same on every environment"; the
 * key-managers spec, "Copies and the state import"; #384, #425): the
 * environments this client holds an `admin` connection to
 * (`projections.copyTargets`), ticked, and Copy sending
 * `runtime.keyManagers.copy`, which adds the connection on each without its
 * credential, so each asks for it once. Each environment's report is one
 * line.
 */
export const CopyConnection = ({ environmentId, connection, close }: CopyConnectionProps) => {
  const runtime = useRuntime();
  const targets = useObservable(useMemo(() => runtime.projections.copyTargets(environmentId), [runtime, environmentId]));
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [lines, setLines] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const nameOf = (id: string) => targets.find((target) => target.environmentId === id)?.name ?? id;

  const tick = (id: string, on: boolean) =>
    setTicked((now) => {
      const next = new Set(now);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const copy = () => {
    setSending(true);
    void runtime.keyManagers.copy(environmentId, connection, [...ticked]).then((reports) => {
      setSending(false);
      setLines(reports.map((report) => copyLine(report, nameOf(report.environmentId))));
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={`Copy ${connection.label} to other environments`}
        description="Each gets its address, CA, sign-in method, ticks and base path, without its credential: sign it in there once."
      >
        {targets.length === 0 ? (
          <p className="text-sm text-ink-muted">This client holds no admin connection to another environment.</p>
        ) : (
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="mb-1 text-ink-muted">Copy to</legend>
            {targets.map((target) => (
              <label key={target.environmentId} className="flex items-center gap-2 text-ink">
                <input type="checkbox" name={target.name} className="accent-beam" checked={ticked.has(target.environmentId)} onChange={(event) => tick(target.environmentId, event.target.checked)} />
                {target.name}
              </label>
            ))}
          </fieldset>
        )}
        {lines.length > 0 && (
          <ul aria-label="What the copy did" className="flex flex-col gap-1 text-sm text-ink">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{lines.length > 0 ? "Done" : "Cancel"}</Button>
          <Button tone="primary" disabled={ticked.size === 0 || sending} onClick={copy}>
            Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
