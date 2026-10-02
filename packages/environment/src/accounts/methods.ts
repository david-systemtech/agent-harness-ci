import type { AdapterHost } from "../adapter/host.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { AccountService } from "./account-service.js";

/**
 * The account methods on the method table (claude-adapter spec, "Wire
 * methods"): `accounts.list`, `accounts.probe`, `accounts.refresh`,
 * `models.list`, `commands.list` and `accounts.signin.get` at `read`;
 * `accounts.adopt`, `accounts.add`, `accounts.relabel` and `accounts.remove`
 * at `admin`, each a command on the account's stream, and the sign-in's
 * `accounts.signin.start`, `.code` and `.cancel`, commands on the
 * environment's stream that the sign-in director answers (#135). The rules are the account service's;
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

    "accounts.signin.get": () => ({ signIn: accounts.signIn.latest() }),

    "accounts.signin.start": (params, context) => accounts.signIn.begin(params, context),

    "accounts.signin.code": (params, context) => accounts.signIn.code(params, context),

    "accounts.signin.cancel": (params, context) => accounts.signIn.cancel(params, context),

    "models.list": async (params) => ({ catalogues: await accounts.catalogues(params.accountId) }),

    // Through the host, which reads the session and its account (`not_found` when either is not held) and refuses an adapter
    // without the commands capability `invalid_params`, reason unsupported (#503).
    "commands.list": async (params) => {
      const { accountId, entries } = await host.commands(params.sessionId);
      return { accountId, entries: [...entries] };
    },
  };
};
