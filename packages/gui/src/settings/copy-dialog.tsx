import type { CopyReport } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { DialogAction as Button } from "../ui/dialog-action.js";
import { Dialog, DialogContent } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

export interface CopyDialogProps<R> {
  /** The environment the copy is from. */
  readonly environmentId: string;
  readonly title: string;
  /** What each environment gets, and what it does not. */
  readonly description: string;
  readonly close: () => void;
  /** Copies to the environments ticked, answering a report for each. */
  readonly copy: (toEnvironmentIds: readonly string[]) => Promise<readonly CopyReport<R>[]>;
  /** What a report says, the environment named as this client names it. */
  readonly line: (report: CopyReport<R>, environmentName: string) => string;
}

/**
 * Copy to other environments (ADR 0020's bulk copy; #320, #425, #419): the
 * environments this client holds an `admin` connection to
 * (`projections.copyTargets`), ticked, and Copy, which copies to each at
 * once; each environment's report is one line.
 */
export const CopyDialog = <R,>({ environmentId, title, description, close, copy, line }: CopyDialogProps<R>) => {
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
  const send = () => {
    setSending(true);
    void copy([...ticked]).then((reports) => {
      setSending(false);
      setLines(reports.map((report) => line(report, nameOf(report.environmentId))));
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={title} description={description}>
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
            {lines.map((each) => (
              <li key={each}>{each}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{lines.length > 0 ? "Done" : "Cancel"}</Button>
          <Button icon={Copy} variant="default" disabled={ticked.size === 0 || sending} onClick={send}>
            Copy
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
