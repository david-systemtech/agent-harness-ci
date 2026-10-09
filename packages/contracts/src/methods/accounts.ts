import { z } from "zod";
import {
  AccountCatalogue,
  AccountId,
  AccountLabel,
  AccountRecord,
  AmbientProbe,
  SignIn,
  SignInCode,
  SignInStart,
} from "../accounts.js";
import { ProviderId } from "../adapter.js";
import { commandParams, defineMethod } from "../method.js";
import { SessionId } from "../sessions.js";
import { CommandsListEntry } from "../skills.js";
import { AccountUsage, HandoffRecommendation } from "../usage.js";

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
 * of the environment's own to the sign-in director (#135), which runs the
 * provider's own CLI there: the harness never sees a credential.
 * Plan usage (#136): `accounts.usage` and `accounts.handoff.recommend` at
 * `read`.
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
 * accounts after it. Also re-reads their models. A query, not a command: what
 * it appends is the account store's own read, as `system:account-store` with no
 * receipt, and a repeat reads again (env spec, "Commands").
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
 * It uses the directory's latest read (at startup, or by `accounts.probe`,
 * which the Account step calls first; the fifteen-minute reads are of
 * accounts, never of it): unless that read found it present and signed in
 * the command is rejected `conflict` (reason `ambient_unavailable`); an
 * account holding the directory already, or the identity it is signed in as,
 * is `conflict` (reason `already_added`, "already added as <label>"); with no
 * `label` and no email to name it by, `conflict` (reason `no_email`).
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
 * directory, and starts its sign-in, as `accounts.signin.start` does, unless
 * another sign-in holds the environment or the provider cannot sign in from
 * the environment, which `signIn` then says. A sign-in that yields an
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
  params: commandParams({ provider, label: AccountLabel, nameByEmail: z.boolean().optional().meta({ description: "Set only for an automatically supplied name, to become the email after sign-in." }) }),
  result: z.object({ account: AccountRecord, signIn: SignInStart }),
  errors: [],
});

/** Changes an account's label, unique ignoring case. An explicit rename also ends email naming, even with the same label; an automatic rename changes nothing once a person chose a name. */
export const accountsRelabel = defineMethod({
  name: "accounts.relabel",
  scope: "admin",
  kind: "command",
  params: commandParams({ accountId: AccountId, label: AccountLabel, onlyIfNameByEmail: z.boolean().optional().meta({ description: "An automatic rename changes nothing after a person has chosen a name." }) }),
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
 * What a session's `/` menu lists beside a client's own commands (skills
 * spec, "Materialisation and the Claude mapping"; ADR 0009), listed without
 * spending tokens, under the trust and the skill set the session's next run
 * would have: a skill entry for every member of its set a person may
 * invoke, then a command entry for each command the provider offers of its
 * own, in the provider's order. The provider's listing of a member (Claude:
 * `agent-harness:<name>`, or a native member's `<name>`) is folded into the
 * member's skill entry, so no skill is listed twice. Needs the adapter's
 * `commands` capability, else `invalid_params` with `data.reason`
 * `unsupported`. A session the environment does not hold, or a deleted
 * one, is `not_found` (data `kind: session`); a session on no account when
 * the environment holds none, or on one it no longer holds, `not_found`
 * (data `kind: account`).
 */
export const commandsList = defineMethod({
  name: "commands.list",
  scope: "read",
  kind: "query",
  params: z.object({ sessionId: SessionId.meta({ description: "The session whose / menu to list: its account, its workspace and its trust." }) }),
  result: z.object({
    accountId: AccountId.meta({ description: "The account listed: the session's, else the environment's default account." }),
    entries: z.array(CommandsListEntry).meta({ description: "The skill entries, by name, then the command entries, in the provider's order." }),
  }),
  errors: [],
});

/**
 * The sign-in methods (claude-adapter spec, "Sign-in and status through the
 * bundled binary"; ADR 0018): one sign-in at a time per environment. Each
 * change of its state is a `signin.updated` notice on
 * `environment.subscribe`, carrying the sign-in; the command's own change is
 * appended with its receipt. An account the environment does not hold is
 * rejected `not_found` (data `kind: account`).
 */

const signInResult = z.object({ signIn: SignIn });

/**
 * Starts signing an account's directory in: the provider's CLI (Claude's
 * bundled binary, `auth login`) runs with the account's directory, and the
 * verification URL it prints is published (`awaiting-code`). Any account
 * the environment holds, adopted or owned, signed in or not. While another
 * sign-in runs, rejected `conflict` (reason `signin_running`, data
 * `accountId` naming the account that holds it); a provider that cannot
 * sign in from the environment is `conflict` (reason `signin_unavailable`),
 * whose message names the account's directory to sign in by hand.
 */
export const accountsSigninStart = defineMethod({
  name: "accounts.signin.start",
  scope: "admin",
  kind: "command",
  params: commandParams({ accountId: AccountId }),
  result: signInResult,
  errors: [],
});

/**
 * Writes the code a person copied from the provider's page to the running
 * sign-in: from any client, not only the one that started it. Accepted in
 * `awaiting-code`, which becomes `submitting`; otherwise, or for another
 * account's sign-in, or while it is completing (its CLI exited and its
 * status is being read), rejected `conflict` (reason `not_awaiting_code`).
 * The code is never recorded; it is refused with any white space, so a
 * client trims it.
 */
export const accountsSigninCode = defineMethod({
  name: "accounts.signin.code",
  scope: "admin",
  kind: "command",
  params: commandParams({ accountId: AccountId, code: SignInCode }),
  result: signInResult,
  errors: [],
});

/**
 * Cancels the account's running sign-in and stops the provider's CLI; the
 * state becomes `cancelled`. A sign-in of the account that has already ended
 * is answered as it ended, changing nothing; one that is completing (its
 * CLI exited 0 and its status is being read) is rejected `conflict` (reason
 * `signin_completing`), since it ends as that read says; when no sign-in of
 * the account is the environment's latest, `conflict` (reason `no_signin`).
 */
export const accountsSigninCancel = defineMethod({
  name: "accounts.signin.cancel",
  scope: "admin",
  kind: "command",
  params: commandParams({ accountId: AccountId }),
  result: signInResult,
  errors: [],
});

/** The environment's latest sign-in, running or ended, as the notices carried it; null when none has run since the environment started. */
export const accountsSigninGet = defineMethod({
  name: "accounts.signin.get",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ signIn: SignIn.nullable() }),
  errors: [],
});

/**
 * Plan usage per window, one account's or every account's, each reading
 * with its account's identity so a client pools one login's readings across
 * environments into one gauge. A reading is the environment's, kept for six
 * minutes from when the provider was read and read again after; concurrent
 * asks share one read, and a run's rate-limit verdicts (`plan.limit`) fold
 * into it. An account whose usage cannot be read (its adapter reports none,
 * it is not signed in, the read failed) answers a reading with no windows
 * and the reason, never an error. A change is noticed as `usage.updated`.
 */
export const accountsUsage = defineMethod({
  name: "accounts.usage",
  scope: "read",
  kind: "query",
  params: z.object({ accountId: AccountId.optional().meta({ description: "The account whose usage to read; every account's when absent." }) }),
  result: z.object({ readings: z.array(AccountUsage) }),
  errors: [],
});

/**
 * Which account to hand work to (the ported threshold, load and
 * recommendation functions), answered from the readings the environment
 * holds and never by reading the providers, so every client asking at once
 * shows the same offer. With `fromAccountId`, the account the work runs on:
 * the threshold it has met, if any, and the other account with the most
 * room; without it, the account with the most room of two or more. The live
 * runs on each account count against its room.
 */
export const accountsHandoffRecommend = defineMethod({
  name: "accounts.handoff.recommend",
  scope: "read",
  kind: "query",
  params: z.object({ fromAccountId: AccountId.optional().meta({ description: "The account the work runs on now; absent to ask only which account has the most room." }) }),
  result: HandoffRecommendation,
  errors: [],
});
