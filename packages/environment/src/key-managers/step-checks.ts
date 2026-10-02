import {
  keyManagerClis,
  type KeyManagerConnectionRecord,
  type KeyManagerStatusKind,
  type ManagedToolRow,
  type SetupAction,
  type SetupTarget,
  type StateCheckId,
} from "@agent-harness/contracts";
import { readableMinute } from "../forge/verification.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";
import { createPath } from "./openbao.js";

/**
 * The Key manager step's state checks (key-managers spec, "The Key manager
 * step"; setup spec, "Skipped"; ADR 0028, ADR 0031), answered from the
 * connections the environment holds. `key-manager.present` is the step's
 * skip check (#367): with no connection the step answers skipped and asks
 * nothing else, so it is never forced. The checks that read what a
 * verification finds (#383) await one of every connection, which they
 * share: a verification asked for while one runs for the same connection
 * joins it (`verifier.ts`). A failing line names each connection, as its
 * label at its address's host, and the action that fixes it.
 */

/** The Key manager step's state checks, by id. */
type KeyManagerStateCheckId = Extract<StateCheckId, `key-manager.${string}`>;

export interface KeyManagerStateChecksOptions {
  /** The connections the environment holds now (`KeyManagerConnections.list`). */
  readonly connections: () => readonly KeyManagerConnectionRecord[];
  /** Verifies every connection, joining one running, and answers the records after (`KeyManagerConnections.verify`). */
  readonly verify: () => Promise<readonly KeyManagerConnectionRecord[]>;
  /** The Managed tools rows, once any probe under way has ended (`ManagedTools.list`). */
  /** Connection ids preserved by Forge references, including records still to be repaired. */
  readonly requiredConnections?: () => readonly string[];
  readonly toolRows: () => Promise<readonly ManagedToolRow[]>;
}

/** A connection as a person reads it: its label at its address's host. */
const connectionLabel = (connection: KeyManagerConnectionRecord): string => `${connection.label} at ${connection.address.replace(/^https?:\/\//, "")}`;

/** The connection `action` applies to. */
const connectionTarget = (action: SetupAction, connection: KeyManagerConnectionRecord): SetupTarget => ({
  action,
  kind: "key-manager-connection",
  id: connection.id,
  label: connectionLabel(connection),
});

/** One connection's failure of a check: its line, and the connection or tool its action applies to. */
interface Finding {
  readonly line: string;
  readonly target: SetupTarget;
}

/** A check's answer from its findings: it holds with none, else one line naming each, with their targets. */
const answerOf = (findings: readonly Finding[]): StateCheckAnswer =>
  findings.length === 0 ? true : { reason: findings.map((finding) => finding.line).join(" "), targets: findings.map((finding) => finding.target) };

/** At least one connection is on the environment. */
const connectionPresent = (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
  connections.length > 0 || { reason: "No key-manager connection is on this environment." };

/** A line for each status a check names, saying what the action does for the connection standing in it. */
type StatusLines = { readonly [Kind in KeyManagerStatusKind]?: (connection: KeyManagerConnectionRecord) => string };

/** A check that names each connection standing in one of `lines`' statuses with its line and `action`, and holds with none. */
const noneStanding =
  (lines: StatusLines, action: SetupAction) =>
  (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
    answerOf(
      connections.flatMap((connection) => {
        const line = lines[connection.status.kind];
        return line === undefined ? [] : [{ line: line(connection), target: connectionTarget(action, connection) }];
      }),
    );

/** Every connection is signed in: none awaiting its sign-in, its credential rejected or its token expired (`sign-in-again`). */
const signedIn = noneStanding(
  {
    "awaiting-sign-in": (connection) => `${connectionLabel(connection)} has no credential on this environment: Sign in again to give it one.`,
    "credential-rejected": (connection) => `The key manager refused the credential of ${connectionLabel(connection)}: Sign in again to give it a new one.`,
    expired: (connection) => {
      const expiresAt = connection.tokenInformation?.expiresAt ?? null;
      return `The token of ${connectionLabel(connection)} ${expiresAt === null ? "has expired" : `expired at ${readableMinute(expiresAt)}`}: Sign in again with a new token.`;
    },
  },
  "sign-in-again",
);

/** Every connection's key manager answers: none unreachable, sealed or presenting a certificate that does not verify, the line naming which (`check-again`). */
const reachable = noneStanding(
  {
    unreachable: (connection) => `${connectionLabel(connection)} did not answer its verification: Check again once it is reachable.`,
    sealed: (connection) => `${connectionLabel(connection)} is sealed: Check again once it is unsealed.`,
    "certificate-rejected": (connection) =>
      `The certificate of ${connectionLabel(connection)} does not verify against ${connection.ca === null ? "the system's trusted CAs" : "the CA it pins"}: Check again once it does.`,
  },
  "check-again",
);

/**
 * Every injecting OpenBao connection's login can mint run tokens: each
 * signed in whose verification found it lacks `update` on the path its run
 * tokens are created at is named with that capability (`check-again`). A
 * connection not signed in is the other checks' to name, and one never
 * asked is tried at each mint, as the runs' own minting does.
 */
const runTokensMint = (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
  answerOf(
    connections
      .filter((connection) => connection.provider === "openbao" && connection.injects && connection.status.kind === "signed-in" && connection.canMint === false)
      .map((connection) => ({
        line: `The login of ${connectionLabel(connection)} lacks update on ${createPath(connection.tokenRole)}, which minting a run token needs: Check again once one of its policies grants it.`,
        target: connectionTarget("check-again", connection),
      })),
  );

/** A row whose tool is installed at its minimum or later: current, with a newer one known, or installed in a way that could not be told. */
const meetsMinimum = (row: ManagedToolRow): boolean => row.status !== "not-installed" && row.status !== "below-minimum";

/** The tool a row names, as the action it serves applies to it. */
const toolTarget = (action: SetupAction, row: ManagedToolRow): SetupTarget => ({ action, kind: "tool", id: row.tool, label: row.tool });

/** What was found of a provider's CLIs, none of which meets its minimum: each installed one's version, else that none is installed. */
const cliProblem = (rows: readonly ManagedToolRow[]): string => {
  const installed = rows.filter((row) => row.status !== "not-installed");
  const tools = rows.map((row) => row.tool);
  if (installed.length === 0) return tools.length === 1 ? `${tools.join("")} is not installed on this environment` : `Neither ${tools.join(" nor ")} is installed on this environment`;
  return installed
    .map((row) =>
      row.version === null ? `${row.tool} on this environment reports no version, so it may be older than ${row.minimum}` : `${row.tool} ${row.version} on this environment is older than ${row.minimum}`,
    )
    .join(" and ");
};

/**
 * Each injecting connection's CLI is installed at its minimum or later
 * (ADR 0026: a key-manager CLI is required while its connection injects),
 * any of its provider's satisfying it. One that is not names the
 * connection, what was found, and the provider's first CLI to Install or,
 * found below its minimum, to Update: `bao` for OpenBao, since `vault` is
 * never installed. The rows are read only when a connection injects.
 */
const cliInstalled = async (connections: readonly KeyManagerConnectionRecord[], toolRows: () => Promise<readonly ManagedToolRow[]>): Promise<StateCheckAnswer> => {
  const injecting = connections.filter((connection) => connection.injects);
  if (injecting.length === 0) return true;
  const rows = await toolRows();
  return answerOf(
    injecting.flatMap((connection) => {
      // The CLIs that serve its provider, in the table's order, any satisfying it (ADR 0026): bao then vault for OpenBao.
      const names = keyManagerClis(connection.provider);
      const own = rows.filter((row) => names.includes(row.tool));
      const [first] = own;
      if (first === undefined || own.some(meetsMinimum)) return [];
      const action = first.status === "below-minimum" ? "update" : "install";
      const remedy = action === "update" ? `Update ${first.tool}.` : `Install ${first.tool}${first.minimum === null ? "" : ` ${first.minimum} or later`}.`;
      return [{ line: `${cliProblem(own)} for ${connectionLabel(connection)}: ${remedy}`, target: toolTarget(action, first) }];
    }),
  );
};

export const keyManagerStateChecks = ({ connections, verify, toolRows, requiredConnections = () => [] }: KeyManagerStateChecksOptions): { readonly [Id in KeyManagerStateCheckId]: StateChecker } => ({
  "key-manager.present": () => requiredConnections().length > 0 || connectionPresent(connections()),
  "key-manager.signed-in": async () => {
    const held = await verify();
    const answer = signedIn(held);
    const missing = [...new Set(requiredConnections())].filter((id) => !held.some((connection) => connection.id === id));
    if (missing.length === 0) return answer;
    const reason = `Preserved Forge references need Key-manager connections ${missing.join(", ")}: add their connection records and sign in on this step.`;
    return answer === true ? { reason } : { reason: `${answer.reason} ${reason}`, targets: answer.targets ?? [] };
  },
  "key-manager.reachable": async () => reachable(await verify()),
  "key-manager.run-tokens": async () => runTokensMint(await verify()),
  "key-manager.cli": async () => cliInstalled(await verify(), toolRows),
});
