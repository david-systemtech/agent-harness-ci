import type { InstructionAccount } from "@agent-harness/contracts";

export const InstructionAccounts = ({ accounts }: { readonly accounts: readonly InstructionAccount[] }) => (
  <div className="flex flex-wrap gap-2">
    {accounts.map((account) => (
      <span key={account.accountId} className={account.channel.kind === "none" ? "text-sm text-ink-faint" : "text-sm text-ink-muted"}>
        {account.label}
        {account.reason !== null && <span className="block">{account.reason}</span>}
      </span>
    ))}
  </div>
);
