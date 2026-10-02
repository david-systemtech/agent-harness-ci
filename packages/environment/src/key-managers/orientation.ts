import {
  compareToolVersions,
  keyManagerClis,
  type ContainmentLevel,
  type KeyManagerConnectionRecord,
  type KeyManagerPolicyWrites,
  type KeyManagerStatusKind,
  type ManagedToolName,
  type ManagedToolRow,
} from "@agent-harness/contracts";
import type { InjectionLevel } from "../adapter/process-environment.js";
import type { InstructionScope } from "../adapter/seams.js";
import { injectionDenier, utcMinute, type OrientationContent, type OrientationList, type OrientationSection } from "../instructions/orientation.js";
import { BWS_INVOCATION } from "./bitwarden-block.js";
import { PROVIDER_NAMES } from "./provider.js";

/**
 * The orientation block's key managers section and the standing rule
 * (key-managers spec, "The orientation block"; ADR 0011, ADR 0028; #381):
 * what every run is told of the key managers connected here, so a session
 * checks the key manager before saying it has no key.
 *
 * - **Each connection** is a line: its label, provider and address, whether
 *   its CA is pinned, the base path where the harness keeps its secrets,
 *   and whether this run is given it or the harness uses it for references
 *   alone.
 * - **What the run is given** follows, read from its instruction scope's
 *   injection answer, the one its process environment is built under
 *   (#380): denied, one line naming who denied it, as the forges section
 *   names them (`injectionDenier`); at `workspace-no-network`, that each
 *   injected key manager is unreachable from the run; otherwise, for each
 *   injecting connection, its status from when it last changed, why runs
 *   get no token from it when they get none, its variables by name (with,
 *   for Bitwarden, how bws is given its configuration file, #1123), the
 *   policies ticked for its run tokens and its CLI as the Managed tools
 *   registry last knew it, never whether a newer one exists.
 * - **The standing rule** ends the section (ADR 0011), in its read-only
 *   form when every policy ticked for what the run is given is known not
 *   to write; with no connection the section is the rule's one line.
 *
 * Every line renders from the connections' read model and the tools' rows,
 * never from a clock, so a verification or a probe that finds nothing new
 * leaves the text byte-identical, and a changed status, tick, injection
 * answer or CLI version changes it, and with it the session's next process.
 * Nothing in the text is a secret: the records hold none.
 */

export interface KeyManagersSectionOptions {
  /** The connections the environment holds, each as it stands now (`KeyManagerConnections.list`). */
  readonly connections: () => readonly KeyManagerConnectionRecord[];
  /** A managed tool's row as last known, at once (`ManagedTools.known`). */
  readonly tool: (name: ManagedToolName) => ManagedToolRow;
}

/** One connection's line: its label, provider and address, whether its CA is pinned, its base path, and whether the run is given it. */
const connectionLine = (record: KeyManagerConnectionRecord, injected: boolean): string => {
  const trust = record.ca === null ? "trusting the system's CAs" : "its CA pinned";
  const base = record.basePath === null ? "no base path is set for the harness's secrets yet" : `the harness keeps its secrets under ${record.basePath}`;
  const given = injected ? "injected into this run" : "used by the harness for references, not injected";
  return `${record.label}: ${PROVIDER_NAMES[record.provider]} at ${record.address}, ${trust}; ${base}; ${given}.`;
};

/** Every connection's line, those in `injected` said to be injected into the run. */
const connectionsList = (connections: readonly KeyManagerConnectionRecord[], injected: readonly KeyManagerConnectionRecord[]): OrientationList => ({
  heading: "Key managers connected here:",
  items: connections.map((record) => connectionLine(record, injected.includes(record))),
});

/** A run denied injection: it is given nothing of any key manager, and who denied it. */
const deniedLine = (level: InjectionLevel): string =>
  `This run is given no key-manager variables or token: credential injection is denied for it by ${injectionDenier(level)}.`;

/** `A`, `A and B`, `A, B and C`. */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * Each status as the injecting connection's line states it, from when it
 * last changed (key-managers spec, "The orientation block"): never when it
 * was last verified, so a verification that finds nothing new changes no
 * text. Every status but signed in gives runs no token.
 */
const STATUS_WORDS: Readonly<Record<KeyManagerStatusKind, (since: string) => string>> = {
  "provider-unavailable": (since) => `provider unavailable since ${since}; runs get no token from it until the SDK is available`,
  "signed-in": (since) => `signed in, verified every fifteen minutes; unchanged since ${since}`,
  "signing-in": (since) => `signing in since ${since}; a run spawned now gets no token from it unless the sign-in ends within five seconds`,
  "awaiting-sign-in": (since) => `awaiting its sign-in since ${since}; runs get no token from it until the user signs it in`,
  "credential-rejected": (since) => `its credential rejected since ${since}, sign in again; runs get no token from it until then`,
  expired: (since) => `expired since ${since}, sign in again; runs get no token from it until then`,
  unreachable: (since) => `unreachable since ${since}; runs get no token from it while it is`,
  sealed: (since) => `sealed since ${since}; runs get no token from it while it is`,
  "certificate-rejected": (since) => `its certificate failing to verify since ${since}; runs get no token from it until it does`,
};

/** The injecting connection's status, with when it last changed. */
const statusLine = ({ status }: KeyManagerConnectionRecord): string => STATUS_WORDS[status.kind](utcMinute(status.since));

/** How a policy's write flag reads beside its name. */
const WRITE_WORDS: Readonly<Record<KeyManagerPolicyWrites, string>> = { yes: "writes", no: "does not write", possibly: "may write" };

/** The policy every run token holds beside the ticked ones (key-managers spec, "Run tokens"): its own lookup, renewal and revocation need it. */
const DEFAULT_POLICY = "default";

/** A policy's name with whether it writes, where the login's policies say. */
const flaggedPolicy = (record: KeyManagerConnectionRecord, name: string): string => {
  const writes = record.policies?.find((policy) => policy.name === name)?.writes;
  return writes === undefined ? name : `${name} (${WRITE_WORDS[writes]})`;
};

/** The policies ticked for the connection's run tokens, each with whether it writes, and `default` beside them when it is not ticked; null for a connection with no ticks. */
const ticksLine = (record: KeyManagerConnectionRecord): string | null => {
  if (record.provider !== "openbao" || record.ticks === null) return null;
  const ticked = record.ticks.length === 0 ? "none" : listed(record.ticks.map((tick) => flaggedPolicy(record, tick)));
  const beside = record.ticks.includes(DEFAULT_POLICY) ? "" : `, beside ${flaggedPolicy(record, DEFAULT_POLICY)}, which every run token holds`;
  return `Policies ticked for its run tokens: ${ticked}${beside}.`;
};

/** One CLI's row as the line gives it: installed with its version against the minimum, or not installed; never whether a newer one exists. */
const toolWords = (row: ManagedToolRow): string => {
  if (row.path === null) return `${row.tool} is not installed`;
  if (row.minimum === null) return row.version === null ? `${row.tool}, its version unread` : `${row.tool} ${row.version}`;
  if (row.version === null) return `${row.tool}, its version unread, so not known to meet the minimum ${row.minimum}`;
  return compareToolVersions(row.version, row.minimum) >= 0 ? `${row.tool} ${row.version}, which meets the minimum ${row.minimum}` : `${row.tool} ${row.version}, below the minimum ${row.minimum}`;
};

/** The CLIs that serve the connection's provider (`bao` or `vault` for OpenBao), each as last known. */
const cliLine = (record: KeyManagerConnectionRecord, tool: KeyManagersSectionOptions["tool"]): string => {
  const serving = keyManagerClis(record.provider);
  const which = serving.length > 1 ? ` (${serving.join(" or ")})` : "";
  return `Its CLI${which}: ${serving.map((name) => toolWords(tool(name))).join("; ")}.`;
};

/**
 * Why runs get no token from a signed-in connection that cannot mint one:
 * the capability its login lacks, at the token role's path when it has one
 * (key-managers spec, "Run tokens"); null for one that can, or whose
 * capabilities no verification has read yet, which is tried.
 */
const mintLine = (record: KeyManagerConnectionRecord): string | null => {
  if (record.status.kind !== "signed-in" || record.canMint !== false) return null;
  const path = record.tokenRole === null ? "auth/token/create" : `auth/token/create/${record.tokenRole}`;
  const empty = listed(record.injectedVariables.filter((name) => name.endsWith("_TOKEN")));
  return `Runs get no token from it: its login cannot mint one, lacking update on ${path}, so ${empty} are empty.`;
};

/** The names of the variables the connection gives runs; for a provider whose block this version does not give yet (#377 to #379), that it gives none. */
const variablesLine = ({ injectedVariables }: KeyManagerConnectionRecord): string =>
  injectedVariables.length === 0 ? "This version gives runs none of its variables yet." : `Its variables, names only: ${injectedVariables.join(", ")}.`;

/**
 * How a run calls a CLI that takes the block's configuration as an option rather than from a variable: bws below 0.5.0 (#1123), with no server
 * URL, which through 2.1.0 bypasses the file's profile and from 1.0.0 keeps bws's state in the host's home (#1141); null for every other.
 */
const invocationLine = ({ provider }: KeyManagerConnectionRecord): string | null =>
  provider === "bitwarden"
    ? `Run bws as ${BWS_INVOCATION} <command>, never with --server-url: below 0.5.0 bws reads its configuration file from that option alone, else this host's ~/.bws/config, and that file's profile names the server and keeps bws's state in this run's own folder, where a server URL would keep it in this host's ~/.bws/state.`
    : null;

/** What the run is told of a connection it is given: its status, why it gives no token when it cannot mint, its variables by name and how to pass them where a variable is not read, its ticks and its CLI. */
const injectedParagraphs = (record: KeyManagerConnectionRecord, tool: KeyManagersSectionOptions["tool"]): string[] => [
  `${record.label}, injected into this run: ${statusLine(record)}.`,
  mintLine(record) ?? "",
  variablesLine(record),
  invocationLine(record) ?? "",
  ticksLine(record) ?? "",
  cliLine(record, tool),
];

/** A connection given to a run at `workspace-no-network`, in place of what it is given: its commands reach no host. */
const unreachableLine = (record: KeyManagerConnectionRecord): string =>
  `${record.label} is injected into this run but unreachable from it: this run's containment, workspace-no-network, lets its commands reach no host.`;

/** A run allowed injection while no connection injects. */
const NONE_INJECTED = "No key manager is injected into this run: it is given no key-manager variables or token.";

/** What the run is told of what it is given: each injected connection's paragraphs, or that none is. */
const givenParagraphs = (injected: readonly KeyManagerConnectionRecord[], tool: KeyManagersSectionOptions["tool"], containment: ContainmentLevel): string[] => {
  if (injected.length === 0) return [NONE_INJECTED];
  if (containment === "workspace-no-network") return injected.map(unreachableLine);
  return injected.flatMap((record) => injectedParagraphs(record, tool));
};

/** The standing rule (ADR 0011), verbatim, in its first form. */
const STANDING_RULE =
  "Before saying you have no key or token, check the key manager above. When you are given a key, save it into the key manager under this project's folder, never into a file. Never print a secret's value.";

/** The standing rule when every ticked policy of what the run is given is known not to write: the second sentence asks the user to save a key. */
const READ_ONLY_RULE =
  "Before saying you have no key or token, check the key manager above. When you are given a key, ask the user to save it into the key manager; your token here is read-only; never write it into a file. Never print a secret's value.";

/** The whole section with no connection, the standing rule's form for it. */
const NONE_CONNECTED = "No key manager is connected here; ask the user for a credential rather than searching files for one.";

/** Whether runs get a token from the connection: it is signed in, and no verification found that its login cannot mint. */
const givesToken = ({ status, canMint }: KeyManagerConnectionRecord): boolean => status.kind === "signed-in" && canMint !== false;

/**
 * Whether the token the connection gives runs is read-only: it gives one,
 * and every policy the token holds, the ticked ones and `default`, is known
 * not to write; false for a connection with no ticks, whose token is not
 * scoped by them.
 */
const readOnly = (record: KeyManagerConnectionRecord): boolean =>
  givesToken(record) &&
  record.ticks !== null &&
  [...record.ticks, DEFAULT_POLICY].every((name) => record.policies?.find((policy) => policy.name === name)?.writes === "no");

/**
 * The standing rule for a run given `injected`: read-only when each of them
 * gives it a read-only token, else its first form, which a run given no
 * token gets too, denied, given no connection or given one that gives none
 * (#728 asks David whether it should read otherwise).
 */
const standingRule = (injected: readonly KeyManagerConnectionRecord[]): string =>
  injected.length > 0 && injected.every(readOnly) ? READ_ONLY_RULE : STANDING_RULE;

/**
 * The section's paragraphs for the connections the environment holds, in
 * the order they were added, for a run under `injection`: each connection's
 * line, then what the run is given of each injecting connection, or on a
 * denied injection who denied it, and last the standing rule.
 */
const renderKeyManagers = (connections: readonly KeyManagerConnectionRecord[], tool: KeyManagersSectionOptions["tool"], { injection, containment }: InstructionScope): OrientationContent => {
  if (connections.length === 0) return [NONE_CONNECTED];
  const injected = injection.answer === "deny" ? [] : connections.filter((record) => record.injects);
  return [
    connectionsList(connections, injected),
    ...(injection.answer === "deny" ? [deniedLine(injection.level)] : givenParagraphs(injected, tool, containment)),
    standingRule(injected),
  ];
};

/** The key managers section's provider, over the connections as they stand now and the CLIs' rows as last known. */
export const keyManagersSection = (options: KeyManagersSectionOptions): OrientationSection => ({
  name: "key-managers",
  title: "Key managers",
  render: (scope) => renderKeyManagers(options.connections(), options.tool, scope),
});
