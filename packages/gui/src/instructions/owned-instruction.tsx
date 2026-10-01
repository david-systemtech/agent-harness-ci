import { keyBetween, type OwnedInstructionRow } from "@agent-harness/contracts";
import { useState } from "react";
import { Part } from "../settings/part.js";
import { Button, Dialog, DialogContent, Switch } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { InstructionButton } from "./instruction-button.js";
import { useInstructionCommand } from "./use-instruction-command.js";
import { VersionDialog } from "./version-dialog.js";

export const OwnedInstructionCard = ({
  environmentId,
  row,
  rows,
  edit,
}: {
  readonly environmentId: string;
  readonly row: OwnedInstructionRow;
  readonly rows: readonly OwnedInstructionRow[];
  edit(): void;
}) => {
  const runtime = useRuntime();
  const { send, sending, line } = useInstructionCommand(environmentId);
  const [removing, remove] = useState(false);
  const [comparing, compare] = useState(false);
  const place = rows.findIndex((held) => held.id === row.id);
  const enabled = runtime.capability(environmentId, "instructions.setEnabled");
  const scope = runtime.capability(environmentId, "instructions.setScope");
  const scopeDisabled = sending || scope.status === "absent";
  const changeScope = (accountId: string, on: boolean) => {
    const current = row.scope === "all" ? row.accounts.map((account) => account.accountId) : row.scope;
    const next = on ? [...current, accountId] : current.filter((id) => id !== accountId);
    if (next.length > 0) void send("instructions.setScope", { instructionId: row.id, scope: next });
  };
  const move = (direction: -1 | 1) => {
    const before = direction === -1 ? (rows[place - 2]?.position ?? null) : (rows[place + 1]?.position ?? null);
    const after = direction === -1 ? (rows[place - 1]?.position ?? null) : (rows[place + 2]?.position ?? null);
    void send("instructions.move", { instructionId: row.id, position: keyBetween(before, after) });
  };
  const setAll = (all: boolean) => {
    const supported = row.accounts.filter((account) => account.channel.kind !== "none").map((account) => account.accountId);
    if (all || supported.length > 0) void send("instructions.setScope", { instructionId: row.id, scope: all ? "all" : supported });
  };
  return (
    <Part title={row.title}>
      <pre className="whitespace-pre-wrap break-words text-sm text-ink">{row.body}</pre>
      {row.origin !== null && (
        <p className="text-xs text-ink-muted">
          {row.origin.catalogueId}, version {row.origin.version}
        </p>
      )}
      {row.newerVersion !== null && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-amber">Newer version {row.newerVersion}</span>
          <InstructionButton environmentId={environmentId} method="instructions.diff" run={() => compare(true)}>
            See what changed
          </InstructionButton>
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-ink">
        <Switch
          aria-label="Enabled"
          checked={row.enabled}
          disabled={sending || enabled.status === "absent"}
          onCheckedChange={(on) => void send("instructions.setEnabled", { instructionId: row.id, enabled: on })}
        />
        Enabled
      </label>
      {enabled.status === "absent" && <p className="text-xs text-ink-faint">{enabled.message}</p>}
      <fieldset disabled={scopeDisabled} className="flex flex-col gap-2 text-sm text-ink">
        <legend>Accounts reached</legend>
        <label>
          <input
            type="checkbox"
            checked={row.scope === "all"}
            onChange={(event) => setAll(event.target.checked)}
            disabled={scopeDisabled || (row.scope === "all" && !row.accounts.some((account) => account.channel.kind !== "none"))}
          />{" "}
          All accounts, including future accounts
        </label>
        {row.accounts.map((account) => (
          <label key={account.accountId} className={account.channel.kind === "none" ? "text-ink-faint" : "text-ink"}>
            <input
              type="checkbox"
              checked={row.scope === "all" || row.scope.includes(account.accountId)}
              disabled={scopeDisabled || account.channel.kind === "none" || (row.scope !== "all" && row.scope.length === 1 && row.scope.includes(account.accountId))}
              onChange={(event) => changeScope(account.accountId, event.target.checked)}
            />{" "}
            {account.label}
            {account.reason !== null && <span className="block">{account.reason}</span>}
          </label>
        ))}
        <p className="text-xs text-ink-muted">Choose at least one account, or all accounts. Switch the instruction off to reach none.</p>
      </fieldset>
      {scope.status === "absent" && <p className="text-xs text-ink-faint">{scope.message}</p>}
      <div className="flex flex-wrap gap-2">
        <InstructionButton environmentId={environmentId} method="instructions.edit" busy={sending} run={edit}>
          Edit
        </InstructionButton>
        <InstructionButton environmentId={environmentId} method="instructions.move" busy={sending} {...(place === 0 && { reason: "Already first." })} run={() => move(-1)}>
          Move up
        </InstructionButton>
        <InstructionButton
          environmentId={environmentId}
          method="instructions.move"
          busy={sending}
          {...(place === rows.length - 1 && { reason: "Already last." })}
          run={() => move(1)}
        >
          Move down
        </InstructionButton>
        <InstructionButton environmentId={environmentId} method="instructions.remove" busy={sending} run={() => remove(true)}>
          Remove
        </InstructionButton>
      </div>
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
      {comparing && <VersionDialog environmentId={environmentId} row={row} close={() => compare(false)} />}
      {removing && (
        <Dialog open onOpenChange={(open) => !open && remove(false)}>
          <DialogContent
            title={`Remove ${row.title}?`}
            description={row.origin === null ? "This instruction will no longer be appended to runs." : "Removing the last copy dismisses its suggestion. Restore offers it again."}
          >
            <div className="flex justify-end gap-2">
              <Button onClick={() => remove(false)}>Cancel</Button>
              <InstructionButton
                environmentId={environmentId}
                method="instructions.remove"
                busy={sending}
                run={() => void send("instructions.remove", { instructionId: row.id }).then((ok) => ok && remove(false))}
              >
                Remove instruction
              </InstructionButton>
            </div>
            {line !== undefined && (
              <p role="status" className="text-sm text-signal">
                {line}
              </p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </Part>
  );
};
