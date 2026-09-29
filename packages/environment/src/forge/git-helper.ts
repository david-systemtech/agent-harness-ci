import { matchForgeAccount, type ForgeAccountOrigins, type ForgeAccountRecord, type ForgeOrigin, type ForgeRemote } from "@agent-harness/contracts";

/**
 * git's side of the credential helper (forge spec, "Runs: the injection" and
 * "The helper and the credential route"; ADR 0020): which origins a forge
 * account is served on, how git's configuration names the helper, and the
 * process-only entries that reset the machine's helper chain for those
 * origins and nothing else.
 */

/** The verb of the `agent-harness` command git runs as its helper. */
export const HELPER_VERB = "git-credential";

/** The origins the credential route serves a forge account on: its canonical origin, then each alias whose identity was verified there. */
export const servedOrigins = (account: Pick<ForgeAccountRecord, "origin" | "aliases">): ForgeOrigin[] => [
  account.origin,
  ...account.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin),
];

/** What the repository identity rule reads of each forge account: its canonical origin and the aliases verified there (ADR 0020). */
export const verifiedOrigins = (accounts: readonly Pick<ForgeAccountRecord, "origin" | "aliases">[]): ForgeAccountOrigins[] =>
  accounts.map((account) => ({ origin: account.origin, aliases: servedOrigins(account).slice(1) }));

/** The forge account of `accounts` serving `remote`: on its canonical origin or a verified alias, by host for an ssh-derived remote; null for none. */
export const servingAccount = (remote: ForgeRemote, accounts: readonly ForgeAccountRecord[]): ForgeAccountRecord | null =>
  matchForgeAccount(
    remote,
    accounts.map((account) => ({ account, origin: account.origin, aliases: servedOrigins(account).slice(1) })),
  )?.account ?? null;

/** A word as POSIX `sh` reads it: as it is when it holds only characters the shell leaves alone, else single-quoted. */
const shellWord = (word: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/**
 * The value of `credential.<origin>.helper` that runs `agent-harness
 * git-credential <slug>`: a shell snippet (the leading `!`), since git runs a
 * helper through `sh` and appends its verb, so every word of the command is
 * quoted as `sh` needs, a path with a space included. Git for Windows runs it
 * through its own `sh`, which takes a Windows path with forward slashes.
 */
export const credentialHelper = (command: readonly string[], slug: string, platform: NodeJS.Platform = process.platform): string => {
  const words = platform === "win32" ? command.map((word) => word.replaceAll("\\", "/")) : command;
  return `!${[...words, HELPER_VERB, slug].map(shellWord).join(" ")}`;
};

/** One entry of git's process-only configuration: a key and its value. */
export type GitConfigEntry = readonly [key: string, value: string];

/**
 * The entries that give `origins` the helper `helper` and no other: for
 * each origin an empty `credential.<origin>.helper`, which clears every
 * helper the machine's configuration named for it (system, global or the
 * repository's) and for no other origin, then the helper; with none, the
 * chain is left empty, so git asks no one.
 */
export const helperChain = (origins: readonly ForgeOrigin[], helper: string | null): GitConfigEntry[] =>
  origins.flatMap((origin): GitConfigEntry[] => [[`credential.${origin}.helper`, ""], ...(helper === null ? [] : [[`credential.${origin}.helper`, helper] as const])]);

/** `entries` as git's process-only configuration variables: `GIT_CONFIG_COUNT`, then a `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>` each. */
export const gitConfigVariables = (entries: readonly GitConfigEntry[]): Record<string, string> => {
  const variables: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    variables[`GIT_CONFIG_KEY_${index}`] = key;
    variables[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return variables;
};
