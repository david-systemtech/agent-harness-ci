import { useMemo } from "react";
import type { OwnedInstructionRow } from "@agent-harness/contracts";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { InstructionButton } from "./instruction-button.js";
import { useInstructionCommand } from "./use-instruction-command.js";

const Comparison = ({ title, before, after }: { readonly title: string; readonly before: string | null; readonly after: string }) => (
  <table aria-label={title} className="w-full table-fixed text-left text-sm">
    <caption className="text-left font-semibold text-ink">{title}</caption>
    <thead>
      <tr>
        <th scope="col">Before</th>
        <th scope="col">Current source</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td className="align-top">
          <pre className="whitespace-pre-wrap break-words text-ink-muted">{before ?? "This build does not hold the earlier text."}</pre>
        </td>
        <td className="align-top">
          <pre className="whitespace-pre-wrap break-words text-ink">{after}</pre>
        </td>
      </tr>
    </tbody>
  </table>
);

export const VersionDialog = ({ environmentId, row, close }: { readonly environmentId: string; readonly row: OwnedInstructionRow; close(): void }) => {
  const runtime = useRuntime();
  const diff = useObservable(useMemo(() => runtime.requests.cached(environmentId, "instructions.diff", { instructionId: row.id }), [runtime, environmentId, row.id]));
  const { send, sending, line } = useInstructionCommand(environmentId);
  const resolve = (choice: "replace" | "keep") => void send("instructions.resolveVersion", { instructionId: row.id, choice }).then((ok) => ok && close());
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Changes to ${row.title}`} description="Replace loses your edits. Keep mine keeps your text and clears this version badge.">
        {(runtime.capability(environmentId, "instructions.diff").status === "absent" || diff.error !== null) && (
          <p className="text-sm text-amber">Cached comparison, stale. {diff.error?.message}</p>
        )}
        {diff.result === null ? (
          <p className="text-sm text-ink-muted">{diff.error?.message ?? "Reading the changes…"}</p>
        ) : (
          <>
            <p className="text-sm text-ink-muted">
              Version {diff.result.fromVersion} → {diff.result.toVersion}
            </p>
            <Comparison title="Catalogue changes" before={diff.result.from} after={diff.result.to} />
            <Comparison title="Changes to your copy" before={diff.result.body} after={diff.result.to} />
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <InstructionButton environmentId={environmentId} method="instructions.resolveVersion" busy={sending || diff.result === null} run={() => resolve("keep")}>
            Keep mine
          </InstructionButton>
          <InstructionButton environmentId={environmentId} method="instructions.resolveVersion" busy={sending || diff.result === null} run={() => resolve("replace")}>
            Replace with new text
          </InstructionButton>
        </div>
        {line !== undefined && (
          <p role="status" className="text-sm text-signal">
            {line}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
};
