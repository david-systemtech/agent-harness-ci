import { z } from "zod";
import {
  AccountCatalogue,
  AccountId,
  AccountLabel,
  AccountRecord,
  AmbientProbe,
  CommandEntry,
  SignInStart,
} from "../accounts.js";
import { ProviderId } from "../adapter.js";
import { commandParams, defineMethod } from "../method.js";
import { Workspace } from "../sessions.js";

/**
 * The account methods (claude-adapter spec, "Wire methods" and "The account
 * store"; ADR 0018): the reads at `read` (the accounts, the machine's own
 * provider directory, a status read now, the models, the commands) and the
 * changes at `admin` (adopt, add, relabel, remove). An account the
 * environment does not hold, or no longer holds, is rejected `not_found`
 * (data `kind: account`). A label another account holds, ignoring case, is
 * rejected `conflict` (reason `label_taken`, naming the account). The
 * harness performs no login and holds no credential: adopting registers a
 * directory the provider's own CLI signed in, and adding hands a directory
 * of the environment's own to the sign-in (#135).
 */

const provider = ProviderId.optional().meta({ description: "The provider; the environment's first when absent." });

/** Every account the environment holds, in the order they were adopted or added. */
export const accountsList = defineMethod({
  name: "accounts.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ accounts: z.array(AccountRecord) }),
  errors: [],
});

/** Reads the machine's own provider directory now: whether it is there, signed in, as whom, and whether an account already adopts it. */
export const accountsProbe = defineMethod({
  name: "accounts.probe",
  scope: "read",
  kind: "query",
  params: z.object({ provider }),
  result: AmbientProbe,
  errors: [],
});

/**
 * Reads accounts' status now, one or every one, rather than waiting for the
 * fifteen-minute read: what the Account step and the Accounts pane call as
 * they open. A change is recorded (`account.status-changed`,
 * `account.identity-set`) and noticed (`account.updated`); the answer is the
 * accounts after it. Also re-reads their models.
 */
export const accountsRefresh = defineMethod({
  name: "accounts.refresh",
  scope: "read",
  kind: "query",
  params: z.object({ accountId: AccountId.optional().meta({ description: "The account to read; every account when absent." }) }),
  result: z.object({ accounts: z.array(AccountRecord) }),
  errors: [],
});

/**
 * Registers the machine's own provider directory in place as an account,
 * labelled `label`, else with the email it is signed in as. Nothing in the
 * directory is moved, linked or deleted, now or when the account is removed.
 * It uses the directory's latest read (startup, `accounts.probe` or the
 * fifteen-minute read): unless that read found it present and signed in the
 * command is rejected `conflict` (reason `ambient_unavailable`); an
 * account holding the directory already, or the identity it is signed in as,
 * is `conflict` (reason `already_added`, "already added as <label>").
 */
export const accountsAdopt = defineMethod({
  name: "accounts.adopt",
  scope: "admin",
  kind: "command",
  params: commandParams({
    provider,
    label: AccountLabel.optional().meta({ description: "The account's label; the email it is signed in as when absent." }),
  }),
  result: z.object({ account: AccountRecord }),
  errors: [],
});

/**
 * Adds an account with a directory of the environment's own under its data
 * directory, and hands it to the sign-in (#135). A sign-in that yields an
 * identity another account holds is refused, "already added as <label>":
 * the new account is removed and its directory deleted
 * (`account.removed`, reason `duplicate-identity`, then
 * `account.directory-deleted`), and an `account.updated` notice carries the
 * warning.
 */
export const accountsAdd = defineMethod({
  name: "accounts.add",
  scope: "admin",
  kind: "command",
  params: commandParams({ provider, label: AccountLabel }),
  result: z.object({ account: AccountRecord, signIn: SignInStart }),
  errors: [],
});

/** Changes an account's label, unique on the environment ignoring case; the label it has already changes nothing. */
export const accountsRelabel = defineMethod({
  name: "accounts.relabel",
  scope: "admin",
  kind: "command",
  params: commandParams({ accountId: AccountId, label: AccountLabel }),
  result: z.object({ account: AccountRecord }),
  errors: [],
});

/**
 * Removes an account. Its directory stays unless `deleteDirectory` is set,
 * the explicit second choice, which deletes an owned directory with the
 * sign-in and history it holds (`account.directory-deleted`); on an adopted
 * account it is rejected `conflict` (reason `adopted_directory`), since the
 * environment never deletes the machine's own provider directory.
 */
export const accountsRemove = defineMethod({
  name: "accounts.remove",
  scope: "admin",
  kind: "command",
  params: commandParams({
    accountId: AccountId,
    deleteDirectory: z.boolean().optional().meta({ description: "Also delete an owned account's directory, with its sign-in and history; refused on an adopted one. False when absent." }),
  }),
  result: z.object({
    accountId: AccountId,
    directoryDeleted: z.boolean().meta({ description: "Whether the account's directory was deleted." }),
  }),
  errors: [],
});

/**
 * The models accounts can use, each with its family, ordinal tier and
 * efforts, flagged `live` when the provider enumerated them and static
 * otherwise: one account's, or every account's.
 */
export const modelsList = defineMethod({
  name: "models.list",
  scope: "read",
  kind: "query",
  params: z.object({ accountId: AccountId.optional().meta({ description: "The account whose models to list; every account's when absent." }) }),
  result: z.object({ catalogues: z.array(AccountCatalogue) }),
  errors: [],
});

/**
 * The slash commands the provider offers an account in a workspace, listed
 * without spending tokens; needs the adapter's `commands` capability, else
 * `invalid_params` with `data.reason` `unsupported`.
 */
export const commandsList = defineMethod({
  name: "commands.list",
  scope: "read",
  kind: "query",
  params: z.object({
    accountId: AccountId.optional().meta({ description: "The account; the environment's default account when absent." }),
    workspace: Workspace,
  }),
  result: z.object({ accountId: AccountId, commands: z.array(CommandEntry) }),
  errors: [],
});
