import type { BankEntry } from "@agent-harness/contracts";

/** The registry's enabled account/repository scope, shared by memory tools and rendering. */
export const bankInScope = (bank: BankEntry, scope: { readonly accountId: string; readonly repositoryIdentity: string | null }): boolean => bank.enabled
  && (bank.accounts === "all" || bank.accounts.includes(scope.accountId))
  && (bank.repositories === "all" || (scope.repositoryIdentity !== null && bank.repositories.includes(scope.repositoryIdentity)));
