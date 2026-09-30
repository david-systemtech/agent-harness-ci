import {
  MANAGED_TOOLS,
  type KeyManagerCertificate,
  type KeyManagerAuthMethod,
  type KeyManagerConnectionRecord,
  type KeyManagerPolicyWrites,
  type KeyManagerProvider,
  type KeyManagerStatus,
  type KeyManagerStatusKind,
  type KeyManagerTokenInformation,
  type ManagedToolRow,
  type ManagedToolStatus,
} from "@agent-harness/contracts";
import { whenWords } from "../transcript/format.js";

/**
 * A key-manager connection in words, as both renderers say it (key-managers
 * spec, "The connection record" and "Managed tools"; ADR 0028; #425): each
 * fact of `keyManagers.list`'s record a card or a line shows, what each
 * status asks David to do, the warning a ticked policy that writes carries,
 * and the connection's CLI row from `tools.list`. The environment's own
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

/** What each way of signing in to OpenBao is called. */
export const KEY_MANAGER_METHOD_WORDS: Readonly<Record<KeyManagerAuthMethod, string>> = { approle: "AppRole", userpass: "userpass", token: "token" };

/** What each status is called, before its since-time. */
export const KEY_MANAGER_STATUS_WORDS: Readonly<Record<KeyManagerStatusKind, string>> = {
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
  "awaiting-sign-in": "Sign in to give this environment its credential.",
  "signing-in": null,
  "signed-in": null,
  "credential-rejected": "Sign in again with a credential the key manager takes.",
  expired: "Sign in again with a new token.",
  unreachable: "Check the address and that the key manager is up and reachable from this environment, then Verify now.",
  sealed: "Unseal it, then Verify now.",
  "certificate-rejected": "Check its certificate: trust it if it is your key manager's, and it signs in again.",
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

/**
 * The connection's CLI row: the Managed tools row of the tools that serve
 * its provider (`bao` or `vault` for OpenBao), the first installed, else the
 * first; undefined when `tools.list` holds none of them.
 */
export const cliRowOf = (provider: KeyManagerProvider, rows: readonly ManagedToolRow[]): ManagedToolRow | undefined => {
  const serving = MANAGED_TOOLS.filter((tool) => tool.requiredFor.kind === "key-manager" && tool.requiredFor.provider === provider).map((tool) => tool.name);
  const held = rows.filter((row) => (serving as readonly string[]).includes(row.tool));
  return held.find((row) => row.status !== "not-installed") ?? held[0];
};

/** What each managed tool's status says. */
const TOOL_STATUS_WORDS: Readonly<Record<ManagedToolStatus, string>> = {
  current: "current",
  "update-available": "a newer version is out",
  "below-minimum": "below the minimum: update it",
  "not-installed": "not installed: install it",
  "method-unknown": "installed, but not known how",
};

/** A CLI row in one line: its label, version against its minimum, and status. */
export const cliWords = (row: ManagedToolRow): string => {
  if (row.status === "not-installed") return `${row.label}: ${TOOL_STATUS_WORDS[row.status]}.`;
  const version = row.version ?? "an unread version";
  const minimum = row.minimum === null ? "" : `, at least ${row.minimum}`;
  return `${row.label} ${version}${minimum}: ${TOOL_STATUS_WORDS[row.status]}.`;
};

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
