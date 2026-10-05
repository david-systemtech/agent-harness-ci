import { derived, oneLine } from "@agent-harness/client-runtime";
import { matchForgeAccount, normaliseRemote, type BankRecord, type ForgeAccountRecord } from "@agent-harness/contracts";
import { ArrowUpRight } from "lucide-react";
import { useMemo } from "react";
import { nameOf } from "../connections/words.js";
import { useSettings } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";
import { BankButton } from "./bank-controls.js";

/** HTTPS origins include their port; only verified aliases serve bank reads (ADR 0020). */
const accountFor = (origin: string, accounts: readonly ForgeAccountRecord[]) => {
  const remote = normaliseRemote(origin);
  return remote === null ? null : matchForgeAccount(remote, accounts.map((account) => ({
    account, origin: account.origin,
    aliases: account.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin),
  })))?.account ?? null;
};

/** A bank's forge access belongs to its own environment, even when another paired one has the account. */
export const BankForgeAccess = ({ environmentId, bank, accounts }: {
  readonly environmentId: string;
  readonly bank: BankRecord;
  readonly accounts: readonly ForgeAccountRecord[] | undefined;
}) => {
  const missing = accounts !== undefined && bank.location.kind === "remote" && bank.status.reachable.state === "unreachable" && accountFor(bank.location.origin, accounts) === null;
  return <>
    <p className="text-2xs text-ink-muted">Manifest: {bank.status.manifest.state}. {missing ? null : bank.status.reachable.state === "unreachable" ? oneLine(bank.status.reachable.reason) : "Reachable."}</p>
    {missing && bank.location.kind === "remote" && <MissingBankForge environmentId={environmentId} origin={bank.location.origin} reason={bank.status.reachable.state === "unreachable" ? bank.status.reachable.reason : ""} />}
  </>;
};

const MissingBankForge = ({ environmentId, origin, reason }: { readonly environmentId: string; readonly origin: string; readonly reason: string }) => {
  const runtime = useRuntime();
  const settings = useSettings();
  const environments = useObservable(runtime.projections.environments);
  const sources = useObservable(useMemo(() => {
    const others = environments.filter((view) => view.environmentId !== environmentId && view.enabled && view.phase === "ready" && runtime.capability(view.environmentId, "forge.accounts.list").status === "present");
    return derived(others.map((view) => runtime.requests.cached(view.environmentId, "forge.accounts.list", {})), (...reads) =>
      others.filter((_, index) => {
        const read = reads[index];
        const account = read?.error === null && read.result !== null ? accountFor(origin, read.result.accounts) : null;
        return account !== null && account.problem === null && account.identity !== null && account.capabilities.readRepository.state === "verified";
      }));
  }, [runtime, environments, environmentId, origin]));
  const owner = environments.find((view) => view.environmentId === environmentId);
  const ownerName = owner === undefined ? environmentId : nameOf(owner);
  return <>
    {sources.length === 0 ? <p className="text-2xs text-ink-muted">{oneLine(reason)}</p> : <p className="text-2xs text-ink-muted">A forge account for {origin} is connected on {sources.map(nameOf).join(", ")}, but this bank belongs to {ownerName}. Connect a forge account on {ownerName} to reach it.</p>}
    <BankButton label={`Connect forge on ${ownerName}`} icon={ArrowUpRight} onClick={() => settings.open("access.forges", environmentId)} />
  </>;
};
