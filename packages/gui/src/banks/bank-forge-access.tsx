import { derived } from "@agent-harness/client-runtime";
import { matchForgeAccount, normaliseRemote, type BankRecord, type ForgeAccountRecord } from "@agent-harness/contracts";
import { useMemo } from "react";
import { nameOf } from "../connections/words.js";
import { useObservable, useRuntime } from "../window-context.js";
import { BankRefusal, GoToForges } from "./bank-controls.js";
import { hostOf, unreachableLine } from "./bank-words.js";

/** HTTPS origins include their port; only verified aliases serve bank reads (ADR 0020). */
const accountFor = (origin: string, accounts: readonly ForgeAccountRecord[]) => {
  const remote = normaliseRemote(origin);
  return remote === null ? null : matchForgeAccount(remote, accounts.map((account) => ({
    account, origin: account.origin,
    aliases: account.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin),
  })))?.account ?? null;
};

/**
 * Why a notebook cannot be reached, in one plain line by its cause, never cut,
 * what the check saw in Details (setup-copy.md §5.8): when no forge account
 * here covers its forge, that it needs one here, or that another computer's
 * is connected there, not here, with Go to Forges. A bank's forge access
 * belongs to its own environment.
 */
export const BankForgeAccess = ({ environmentId, bank, accounts }: {
  readonly environmentId: string;
  readonly bank: BankRecord;
  readonly accounts: readonly ForgeAccountRecord[] | undefined;
}) => {
  const { name, location, status: { reachable } } = bank;
  if (reachable.state !== "unreachable") return null;
  const details = [`${name}: ${reachable.reason}`];
  return accounts !== undefined && location.kind === "remote" && accountFor(location.origin, accounts) === null
    ? <MissingBankForge environmentId={environmentId} name={name} origin={location.origin} details={details} />
    : <BankRefusal refusal={{ line: unreachableLine(bank), details }} />;
};

const MissingBankForge = ({ environmentId, name, origin, details }: { readonly environmentId: string; readonly name: string; readonly origin: string; readonly details: readonly string[] }) => {
  const runtime = useRuntime();
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
  return <>
    <BankRefusal refusal={{ line: sources.length > 0 ? `Your ${hostOf(origin)} account is connected on ${sources.map(nameOf).join(", ")}, not here. Connect it here too.` : `${name} needs a forge account for ${hostOf(origin)} on this computer.`, details }} />
    <GoToForges environmentId={environmentId} />
  </>;
};
