import {
  PRODUCT_NAME,
  type InjectionAnswer,
  type KeyManagerCertificate,
  type KeyManagerAuthMethod,
  type KeyManagerConnectionRecord,
  type KeyManagerPolicyWrites,
  type KeyManagerProvider,
  type KeyManagerStatus,
  type KeyManagerStatusKind,
  type KeyManagerTokenInformation,
  type ListedKeyManagerConnection,
  type ManagedToolRow,
  type ManagedToolStatus,
} from "@agent-harness/contracts";
import type { CopyReport } from "../copies.js";
import { whenWords } from "../transcript/format.js";

/**
 * A key-manager connection in words, as both renderers say it (key-managers
 * spec, "The connection record" and "Managed tools"; ADR 0028; #425): each
 * fact of `keyManagers.list`'s record a card or a line shows, what each
 * status asks David to do, the warning a ticked policy that writes carries,
 * and the CLI row a listed connection carries (#375). The environment's own
 * status line stands beside these; nothing here reads a secret, since the
 * record holds none.
 */

/** What each provider is called on a card and in a form. */
export const KEY_MANAGER_PROVIDER_WORDS: Readonly<Record<KeyManagerProvider, string>> = {
  openbao: "OpenBao or Vault",
  doppler: "Doppler",
  onepassword: "1Password",
  bitwarden: "Bitwarden Secrets Manager",
};

/** What each provider is called in a line or on a button: `Connect OpenBao`, `Doppler did not accept these details.` (setup-copy.md §5.7). */
export const KEY_MANAGER_PROVIDER_NAMES: Readonly<Record<KeyManagerProvider, string>> = {
  openbao: "OpenBao",
  doppler: "Doppler",
  onepassword: "1Password",
  bitwarden: "Bitwarden Secrets Manager",
};

/** What each way of signing in to OpenBao is called. */
export const KEY_MANAGER_METHOD_WORDS: Readonly<Record<KeyManagerAuthMethod, string>> = { approle: "AppRole", userpass: "userpass", token: "token" };

/** What each status is called, before its since-time. */
export const KEY_MANAGER_STATUS_WORDS: Readonly<Record<KeyManagerStatusKind, string>> = {
  "provider-unavailable": "Provider unavailable",
  "awaiting-sign-in": "Awaiting a sign-in",
  "signing-in": "Signing in",
  "signed-in": "Signed in",
  "credential-rejected": "Credential rejected",
  expired: "Expired",
  unreachable: "Unreachable",
  sealed: "Sealed",
  "certificate-rejected": "Certificate not trusted",
};

/**
 * What each status asks David to do, said after the environment's own line
 * (ADR 0028: an expired token, an unreachable address, a sealed OpenBao and
 * a changed certificate each show their own fix); null for a status that
 * asks nothing.
 */
export const KEY_MANAGER_STATUS_ADVICE: Readonly<Record<KeyManagerStatusKind, string | null>> = {
  "provider-unavailable": "Use an environment with a supported Bitwarden SDK, then Verify now.",
  "awaiting-sign-in": "Sign in to give this environment its credential.",
  "signing-in": null,
  "signed-in": null,
  "credential-rejected": "Sign in again with a credential the key manager takes.",
  expired: "Sign in again with a new token.",
  unreachable: "Check the address and that the key manager is up and reachable from this environment, then Verify now.",
  sealed: "Unseal it, then Verify now.",
  "certificate-rejected": "Check its certificate: trust it if it is your key manager's, and it signs in again.",
};

/** The one button a connection's health line offers (setup-copy.md §5.7): a sign-in, a sign-in again, a check now, or a look at its certificate. */
export type ConnectionFix = "sign-in" | "sign-in-again" | "check-again" | "check-certificate";

/** What each fix's button says. */
export const CONNECTION_FIX_WORDS: Readonly<Record<ConnectionFix, string>> = { "sign-in": "Sign in", "sign-in-again": "Sign in again", "check-again": "Check again", "check-certificate": "Check certificate" };

/** Each status as a connection's health line says it: its state word, the one thing to do, and the button that does it; none for a status that asks nothing. */
const HEALTH: Readonly<Record<KeyManagerStatusKind, { readonly state: string; readonly next: string | null; readonly fix: ConnectionFix | null }>> = {
  "signed-in": { state: "Connected", next: null, fix: null },
  "signing-in": { state: "Signing in", next: null, fix: null },
  "awaiting-sign-in": { state: "Not signed in", next: "Sign in to use it.", fix: "sign-in" },
  "credential-rejected": { state: "Not accepted", next: "Sign in again with a working token.", fix: "sign-in-again" },
  expired: { state: "Expired", next: "Sign in with a new token.", fix: "sign-in-again" },
  unreachable: { state: "Not answering", next: "Check the address and the connection, then choose Check again.", fix: "check-again" },
  sealed: { state: "Locked (sealed)", next: "Unlock it, then choose Check again.", fix: "check-again" },
  "certificate-rejected": { state: "Certificate not trusted", next: "Choose Check certificate to review it.", fix: "check-certificate" },
  "provider-unavailable": { state: "Not ready", next: "Choose Check again.", fix: "check-again" },
};

/**
 * A connection's health as the Key manager step says it (setup-copy.md
 * §5.7): one line, `{state} since {time}. {what to do}`, and the one button
 * that does it, null when it asks nothing. The environment's own words for
 * the status are the step's Details, never a second sentence here.
 */
export const connectionHealth = (status: KeyManagerStatus, now: Date): { readonly line: string; readonly fix: ConnectionFix | null } => {
  const { state, next, fix } = HEALTH[status.kind];
  return { line: `${state} since ${whenWords(status.since, now)}.${next === null ? "" : ` ${next}`}`, fix };
};

/**
 * What a Connect says of the connection it saved (setup-copy.md §5.7):
 * connected; saved but not reached, naming the address; saved and waiting
 * for its sign-in; or saved but not connected, with the one thing to do.
 * Never "Added" followed by what failed.
 */
export const savedWords = (connection: Pick<KeyManagerConnectionRecord, "label" | "address" | "status">): string => {
  const { label, address, status } = connection;
  switch (status.kind) {
    case "signed-in":
    case "signing-in":
      return `Connected to ${label}.`;
    case "unreachable":
      return `Saved, but ${PRODUCT_NAME} could not reach ${address}. Check the address, then choose Check again.`;
    case "awaiting-sign-in":
      return `Saved. ${label} is not signed in yet.`;
    default:
      return `Saved, but ${label} is not connected yet. ${HEALTH[status.kind].next ?? ""}`.trimEnd();
  }
};

/** A connection's status with its since-time, where the client is: `Signed in since 09:14`. */
export const statusWords = (status: KeyManagerStatus, now: Date): string => `${KEY_MANAGER_STATUS_WORDS[status.kind]} since ${whenWords(status.since, now)}`;

/** How an OpenBao connection signs in: its method at its mount, a userpass login's username; null for another provider. */
export const methodWords = (record: Pick<KeyManagerConnectionRecord, "method" | "mount" | "username">): string | null => {
  if (record.method === null) return null;
  const as = record.username === null ? "" : ` as ${record.username}`;
  return `${KEY_MANAGER_METHOD_WORDS[record.method]}${as}, at ${record.mount ?? record.method}`;
};

/** Whether an OpenBao connection pins a CA; null for another provider, which pins none. */
export const caWords = (record: Pick<KeyManagerConnectionRecord, "provider" | "ca">): string | null => {
  if (record.provider !== "openbao") return null;
  return record.ca === null ? "None pinned: the system's trusted CAs verify it." : "Pinned: requests to it trust this CA alone.";
};

/**
 * A certificate the preview read, as a person checks it before trusting it
 * (key-managers spec, "Providers"): its SHA-256 fingerprint, subject, names,
 * expiry and whether it signs itself, each by its name, in that order.
 */
export const certificateFacts = (certificate: KeyManagerCertificate, now: Date): readonly (readonly [string, string])[] => [
  ["SHA-256 fingerprint", certificate.sha256Fingerprint],
  ["Subject", certificate.subject],
  ["Names", certificate.names.length === 0 ? "None." : certificate.names.join(", ")],
  ["Expires", whenWords(certificate.expiresAt, now)],
  ["Signs itself", certificate.selfSigned ? "Yes: it is a root CA." : "No: another CA issued it."],
];

/** Names in a list: `a`, `a and b`, `a, b and c`. */
export const listWords = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;

/** What the login's lookup said of its token, never the token: its name, policies, whether it renews and when it ends; null while not signed in. */
export const tokenWords = (information: KeyManagerTokenInformation | null, now: Date): string | null => {
  if (information === null) return null;
  const policies = information.policies.length === 0 ? "no policies" : listWords(information.policies);
  const renews = information.renewable ? "renewable" : "not renewable";
  const ends = information.expiresAt === null ? "does not expire" : `expires at ${whenWords(information.expiresAt, now)}`;
  return `${information.displayName}: ${policies}; ${renews}; ${ends}`;
};

/** Whether the login can mint run tokens, and what runs get when it cannot. */
export const mintWords = (canMint: boolean | null): string => {
  if (canMint === null) return "Not known until it is verified.";
  return canMint ? "It can mint them." : "It cannot mint them: runs get its address with no token.";
};

/** Where Move keeps the harness's secrets on the connection, or the base path it suggests while none is set. */
export const basePathWords = (record: Pick<KeyManagerConnectionRecord, "basePath" | "suggestedBasePath">): string => {
  if (record.basePath !== null) return record.basePath;
  return record.suggestedBasePath === null ? "None set." : `None set; it suggests ${record.suggestedBasePath}.`;
};

/** Whether runs receive the connection's variables, by name, or it serves references only. */
export const injectsWords = (record: Pick<KeyManagerConnectionRecord, "injects" | "injectedVariables">): string => {
  if (!record.injects) return "They do not receive its variables: it serves the harness's references only.";
  return record.injectedVariables.length === 0 ? "They receive its variables." : `They receive its variables: ${record.injectedVariables.join(", ")}.`;
};

/** Where the connection came from, when it was not added here. */
export const originWords = (record: Pick<KeyManagerConnectionRecord, "copiedFrom" | "importedFrom">): string | null => {
  if (record.copiedFrom !== null) return `${record.copiedFrom.environmentName}, without its credential.`;
  return record.importedFrom === null ? null : "The state import, without its credential.";
};

/** What each managed tool's status says. */
const TOOL_STATUS_WORDS: Readonly<Record<ManagedToolStatus, string>> = {
  current: "current",
  "update-available": "a newer version is out",
  "below-minimum": "below the minimum: update it",
  "not-installed": "not installed: install it",
  "method-unknown": "installed, but not known how",
};

/** A CLI row in one line, as a listed connection's `cli` is said: its label, version against its minimum, and status. */
export const cliWords = (row: ManagedToolRow): string => {
  if (row.status === "not-installed") return `${row.label}: ${TOOL_STATUS_WORDS[row.status]}.`;
  const version = row.version ?? "an unread version";
  const minimum = row.minimum === null ? "" : `, at least ${row.minimum}`;
  return `${row.label} ${version}${minimum}: ${TOOL_STATUS_WORDS[row.status]}.`;
};

/**
 * What a connection's CLI asks of a person while runs receive its variables
 * (ADR 0028; key-managers spec, "The Key manager step", `key-manager.cli`):
 * not installed, or below its minimum, with what runs lose and what keeps
 * working without it, since the harness resolves its own references over
 * the key manager's API; null while it is at its minimum or later, or while
 * runs do not receive the connection's variables, when no run reads it.
 */
export const cliHealthWords = (connection: Pick<ListedKeyManagerConnection, "injects" | "cli">): string | null => {
  const { cli } = connection;
  if (!connection.injects) return null;
  const keeps = "The harness still resolves its own references over the key manager's API without it, so forge and bank credentials keep working.";
  if (cli.status === "not-installed") return `${cli.label} is not installed: runs receive this key manager's variables but cannot read it from their shell until it is installed. ${keeps}`;
  if (cli.status !== "below-minimum") return null;
  const version = cli.version === null ? "" : ` ${cli.version}`;
  const minimum = cli.minimum === null ? "" : `, ${cli.minimum}`;
  return `${cli.label}${version} is below its minimum${minimum}: runs may not read this key manager from their shell until it is updated. ${keeps}`;
};

/** A connection's switch on the Key manager card (setup-copy.md §5.7; ADR 0028): whether every run gets its keys. */
export const injectionSwitchWords = (label: string): string => `Let every run use ${label}'s keys`;

/** The line under a connection's switch, saying where one run's answer is changed. */
export const INJECTION_SWITCH_HINT = "You can turn this off for one account, routine or bot in Settings.";

/** What Move saved tokens asks (setup-copy.md §5.7): how many tokens agent-harness keeps itself, and whether to move them into `label`. */
export const moveOfferWords = (count: number, label: string): string =>
  count === 1 ? `${PRODUCT_NAME} keeps 1 token itself. Move it into ${label}?` : `${PRODUCT_NAME} keeps ${count} tokens itself. Move them into ${label}?`;

/** What a policy's write flag says beside its name. */
export const POLICY_WRITES_WORDS: Readonly<Record<KeyManagerPolicyWrites, string>> = { yes: "writes", no: "reads only", possibly: "may write" };

/**
 * ADR 0028's warning on a ticked policy that writes, or may: runs holding
 * it can change what the key manager holds; null for one that does not.
 */
export const policyWarning = (writes: KeyManagerPolicyWrites): string | null => {
  switch (writes) {
    case "yes":
      return "Runs given this policy can write to your key manager: untick it to keep them read-only.";
    case "possibly":
      return "This login cannot read this policy, so runs given it may be able to write: untick it to keep them read-only.";
    case "no":
      return null;
  }
};

/** What each injection answer says runs get (key-managers spec, "Injection"). */
export const INJECTION_WORDS: Readonly<Record<InjectionAnswer, string>> = { allow: "receive credentials", deny: "receive none" };

/**
 * `credentials.injectionByAccount` with the account's override set, or
 * dropped (`null`) so the account takes the environment's answer.
 */
export const overridesWith = (overrides: Readonly<Record<string, InjectionAnswer>>, accountId: string, answer: InjectionAnswer | null): Record<string, InjectionAnswer> => {
  const others = Object.fromEntries(Object.entries(overrides).filter(([id]) => id !== accountId));
  return answer === null ? others : { ...others, [accountId]: answer };
};

/** What a copy of a connection came to on one environment, named as this client names it: copied, awaiting its sign-in there, or refused and why. */
export const copyLine = (report: CopyReport<KeyManagerConnectionRecord | null>, environmentName: string): string =>
  report.status === "copied" ? `${environmentName}: copied, awaiting a sign-in there.` : `${environmentName}: not copied: ${report.error.message}`;
