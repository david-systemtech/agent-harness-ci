import { ContractError } from "@agent-harness/contracts";
import type { AdapterHost } from "../adapter/host.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { AccountService } from "./account-service.js";

/**
 * The account methods on the method table (claude-adapter spec, "Wire
 * methods"): `accounts.list`, `accounts.probe`, `accounts.refresh`,
 * `models.list` and `commands.list` at `read`; `accounts.adopt`,
 * `accounts.add`, `accounts.relabel` and `accounts.remove` at `admin`, each
 * a command on the account's stream. The rules are the account service's;
 * a command's own events are appended in its transaction, and what it sets
 * off (a notice, a sign-in, a directory deleted) runs once it has committed.
 * `providers.list` is #120's (`adapter/processes-methods.ts`).
 */

export interface AccountMethodsOptions {
  readonly accounts: AccountService;
  readonly host: AdapterHost;
}

export const accountMethods = (options: AccountMethodsOptions): MethodHandlers => {
  const { accounts, host } = options;

  return {
    "accounts.list": () => ({ accounts: accounts.list() }),

    "accounts.probe": (params) => accounts.probe(params.provider),

    "accounts.refresh": async (params) => ({ accounts: await accounts.refresh(params.accountId) }),

    "accounts.adopt": (params, context) => accounts.adopt(params, context),

    "accounts.add": (params, context) => accounts.add(params, context),

    "accounts.relabel": (params, context) => accounts.relabel(params, context),

    "accounts.remove": (params, context) => accounts.remove(params, context),

    "models.list": async (params) => ({ catalogues: await accounts.catalogues(params.accountId) }),

    "commands.list": async (params) => {
      const accountId = params.accountId ?? accounts.defaultId();
      if (accountId === null || accounts.facts(accountId) === null) {
        const message = accountId === null ? "No account is on this environment." : `No account ${accountId} is on this environment.`;
        throw new ContractError({ code: "not_found", message, data: { kind: "account", ...(accountId !== null && { accountId }) } });
      }
      // Through the host, which refuses an adapter without the commands capability `invalid_params`, reason unsupported.
      const commands = await host.commands(accountId, params.workspace);
      return { accountId, commands: commands.map((command) => ({ name: command.name, description: command.description })) };
    },
  };
};
