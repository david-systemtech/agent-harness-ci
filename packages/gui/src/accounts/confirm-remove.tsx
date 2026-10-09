import { removalWords, removeAccount, uuidv7, type AccountOutcome } from "@agent-harness/client-runtime";
import type { AccountRecord } from "@agent-harness/contracts";
import { Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { Checkbox, Dialog, DialogClose, DialogContent, Tooltip } from "../ui/index.js";
import { AccountAction } from "./action.js";
import { useClock, useRuntime } from "../window-context.js";

export interface ConfirmRemoveProps {
  readonly environmentId: string;
  /** The computer as a line names it: "this computer", or its name. */
  readonly computer: string;
  readonly account: AccountRecord;
  readonly close: () => void;
  /** Says one line in the pane: what removing did, or why it did not. */
  readonly say: (outcome: AccountOutcome) => void;
}

/**
 * Remove, once confirmed (`accounts.remove`; claude-adapter spec, "The
 * account store"; ADR 0018; #414; setup-copy.md §5.1). The folder stays:
 * Claude Code's own is never touched, and one agent-harness made is deleted,
 * with the sign-in and history it holds, only when "Also delete its sign-in
 * and history" is ticked, the explicit second choice. What it did, or the
 * environment's refusal, is one line in the pane; no folder path is shown.
 */
export const ConfirmRemove = ({ environmentId, computer, account, close, say }: ConfirmRemoveProps) => {
  const deleteId = useId();
  const runtime = useRuntime();
  const clock = useClock();
  const [deleting, setDeleting] = useState(false);
  const [sending, setSending] = useState(false);
  const remove = () => {
    setSending(true);
    void removeAccount(runtime, environmentId, account, deleting, uuidv7(clock.now())).then((removed) => {
      close();
      say(removed);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent title={`Remove ${account.label}?`} description={removalWords(account, computer)}>
        {account.directory.kind === "owned" && (
          <label htmlFor={deleteId} className="flex items-center gap-2 text-sm text-ink">
            <Tooltip content="Also delete its sign-in and history" keys="Space"><Checkbox id={deleteId} checked={deleting} onCheckedChange={(checked) => setDeleting(checked === true)} /></Tooltip>
            Also delete its sign-in and history
          </label>
        )}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <AccountAction icon={X}>Cancel</AccountAction>
          </DialogClose>
          <AccountAction icon={Trash2} variant="destructive" disabled={sending} onClick={remove}>
            Remove
          </AccountAction>
        </div>
      </DialogContent>
    </Dialog>
  );
};
