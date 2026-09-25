import { randomUUID } from "node:crypto";
import type { Adapter } from "../src/adapter/contract.js";
import { createAccountService, type AccountService, type AccountServiceOptions, type ConfiguredAccount } from "../src/accounts/account-service.js";
import type { EventLog } from "../src/event-log/event-log.js";
import type { Clock } from "../src/serve/clock.js";

/**
 * The account store for a lower-seam test (the adapter host driven outside
 * the wire): an account service over the test's log, which must have the
 * accounts projector registered, holding `accounts` as #119's configured
 * accounts carried over, each read once as startup reads them.
 */
export const storeAccounts = async (
  options: { readonly log: EventLog; readonly clock: Clock; readonly adapters: readonly Adapter[]; readonly accounts: readonly ConfiguredAccount[] } & Partial<AccountServiceOptions>,
): Promise<AccountService> => {
  const service = createAccountService({ environmentId: randomUUID(), ownedRoot: null, configured: options.accounts, ...options });
  await service.start();
  return service;
};
