import type { BankEntry } from "@agent-harness/contracts";

/**
 * The registry's enabled account/repository scope, shared by memory tools and rendering. A caller with no account or
 * no repository (one outside the harness, #1044) reaches only the banks scoped to every account or every repository.
 */
export const bankInScope = (bank: BankEntry, scope: { readonly accountId: string | null; readonly repositoryIdentity: string | null }): boolean => bank.enabled
  && (bank.accounts === "all" || (scope.accountId !== null && bank.accounts.includes(scope.accountId)))
  && (bank.repositories === "all" || (scope.repositoryIdentity !== null && bank.repositories.includes(scope.repositoryIdentity)));
