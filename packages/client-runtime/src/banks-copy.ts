import { repositoryIdentityOf, type AccountRecord, type BankRecord, type KeyManagerReference } from "@agent-harness/contracts";
import { copyOutcome, type CopySource } from "./copies.js";
import { uuidv4, uuidv7 } from "./ids.js";
import { referenceCopies } from "./key-managers.js";
import type { Clock } from "./platform.js";
import { identityKey } from "./projections/accounts.js";
import type { RequestFailure, Requests } from "./requests.js";

export type BankCopyItemReport = {
  readonly kind: "bank";
  readonly id: string;
  /** Present after the target has joined, including when a later update or swap refuses. */
  readonly targetBankId?: string;
} & ({ readonly status: "copied" } | { readonly status: "refused"; readonly error: RequestFailure });

interface BankCopyHost {
  readonly clock: Clock;
  readonly call: Requests["call"];
  name(environmentId: string): string | null;
}

/** One explicit copy's source reads are shared; all writes are direct calls on each target. */
export const bankSelectionCopy = (host: BankCopyHost, from: CopySource | null, bankIds: readonly string[]) => {
  const load = async () => {
    if (from === null) return { ok: false, error: { code: "unreachable", message: "The source environment is unavailable." } } as const;
    const answer = await host.call(from.environmentId, "banks.list", {});
    if (!answer.ok) return answer;
    const banks = answer.result.banks.filter((bank) => bankIds.includes(bank.id));
    let accounts: readonly AccountRecord[] = [];
    if (banks.some((bank) => bank.accounts !== "all" || bank.defaultFor.length > 0)) {
      const listed = await host.call(from.environmentId, "accounts.list", {});
      if (!listed.ok) return listed;
      accounts = listed.result.accounts;
    }
    return { ok: true, banks, accounts } as const;
  };
  let loaded: ReturnType<typeof load> | undefined;
  const references = new Map<string, ReturnType<typeof referenceCopies>>();
  return async (environmentId: string): Promise<readonly BankCopyItemReport[]> => {
    if (bankIds.length === 0) return [];
    const source = await (loaded ??= load());
    const reports: BankCopyItemReport[] = [];
    for (const id of new Set(bankIds)) {
      const refused = (error: RequestFailure, targetBankId?: string) => reports.push({ kind: "bank", id, ...(targetBankId !== undefined && { targetBankId }), status: "refused", error });
      if (!source.ok) { refused(source.error); continue; }
      const bank = source.banks.find((bank) => bank.id === id);
      if (bank === undefined) { refused({ code: "not_found", message: "The source holds no bank with this id." }); continue; }
      if (bank.location.kind === "local") {
        refused({ code: "conflict", message: "Publish this local-only bank before copying its registry choice.", data: { reason: "local_only", bankId: id } });
        continue;
      }
      const accounts = await host.call(environmentId, "accounts.list", {});
      if (!accounts.ok) { refused(accounts.error); continue; }
      const there = new Map(accounts.result.accounts.flatMap((account) => account.identity === null ? [] : [[identityKey(account.identity), account.id] as const]));
      const mapped = new Map(source.accounts.flatMap((account) => {
        const targetId = account.identity === null ? undefined : there.get(identityKey(account.identity));
        return targetId === undefined ? [] : [[account.id, targetId] as const];
      }));
      const needed = [...(bank.accounts === "all" ? [] : bank.accounts), ...bank.defaultFor];
      const missing = needed.filter((accountId) => !mapped.has(accountId));
      if (missing.length > 0) {
        refused({ code: "account_absent", message: "The target has no matching identity for the selected bank accounts.", data: { accountIds: [...new Set(missing)] } });
        continue;
      }
      let repositories = bank.repositories;
      if (repositories !== "all") {
        const forges = await host.call(environmentId, "forge.accounts.list", {});
        if (!forges.ok) { refused(forges.error); continue; }
        const origins = forges.result.accounts.map((account) => ({ origin: account.origin, aliases: account.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin) }));
        repositories = [...new Set(repositories.map((identity) => repositoryIdentityOf(identity, origins) ?? identity))];
      }
      let reference: KeyManagerReference | undefined;
      if (bank.credential === "reference") {
        if (bank.credentialReference == null) { refused({ code: "credential_source_unavailable", message: "The source bank holds no credential reference." }); continue; }
        let copies = references.get(id);
        if (copies === undefined) {
          copies = referenceCopies(host, from!, bank.credentialReference);
          references.set(id, copies);
        }
        const copied = await (await copies)(environmentId);
        if (!copied.ok) { refused(copied.error); continue; }
        reference = copied.reference;
      }
      const scope = bank.accounts === "all" ? "all" : [...new Set(bank.accounts.map((id) => mapped.get(id)!))];
      const joined = copyOutcome(await host.call(environmentId, "banks.join", {
        commandId: uuidv7(host.clock.now()), bankId: uuidv4(),
        url: `${bank.location.origin}/${bank.location.repository}.git`,
        accounts: scope === "all" ? accounts.result.accounts.map((account) => account.id) : scope,
        repositories, copiedFrom: from!,
      }), (result) => result.bank);
      if (joined.status === "refused") { refused(joined.error); continue; }
      if (joined.result === null) { refused({ code: "malformed", message: "The join answered no target bank record." }); continue; }
      const targetBankId = joined.result.id;
      const updated = copyOutcome(await host.call(environmentId, "banks.registry.update", {
        commandId: uuidv7(host.clock.now()), bankId: targetBankId,
        role: bank.role, enabled: bank.enabled, accounts: scope, repositories,
        defaultFor: [...new Set(bank.defaultFor.map((id) => mapped.get(id)!))],
        pins: mappedPins(bank, joined.result.name),
        ...(bank.kind === "team" && { mergeOverride: bank.mergeOverride, privateCopy: bank.privateCopy }),
      }), (result) => result.bank);
      if (updated.status === "refused") { refused(updated.error, targetBankId); continue; }
      if (reference !== undefined) {
        const swapped = copyOutcome(await host.call(environmentId, "banks.credential.swap", {
          commandId: uuidv7(host.clock.now()), bankId: targetBankId, reference,
        }), () => true);
        if (swapped.status === "refused") { refused(swapped.error, targetBankId); continue; }
      }
      reports.push({ kind: "bank", id, targetBankId, status: "copied" });
    }
    return reports;
  };
};

const mappedPins = (bank: BankRecord, name: string): string[] => bank.pins.map((pin) => pin.startsWith(`${bank.name}:`) ? `${name}:${pin.slice(bank.name.length + 1)}` : pin);
