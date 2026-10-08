import {
  keyManagerClis,
  type KeyManagerConnectionRecord,
  type KeyManagerStatusKind,
  type ManagedToolRow,
  type ReasonTime,
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
 * joins it (`verifier.ts`). A failing line is setup-copy.md §5.7's, naming
 * each connection by its label, with the action that fixes it; the
 * connection's address, id and what its status says go in details (#1852).
 */

/** The Key manager step's state checks, by id. */
type KeyManagerStateCheckId = Extract<StateCheckId, `key-manager.${string}`>;

export interface KeyManagerStateChecksOptions {
  /** The connections the environment holds now (`KeyManagerConnections.list`). */
  readonly connections: () => readonly KeyManagerConnectionRecord[];
  /** Verifies every connection, joining one running, and answers the records after (`KeyManagerConnections.verify`). */
  readonly verify: () => Promise<readonly KeyManagerConnectionRecord[]>;
  /** Connection ids preserved by Forge references, including records still to be repaired. */
  readonly requiredConnections?: () => readonly string[];
  /** The Managed tools rows, once any probe under way has ended (`ManagedTools.list`). */
  readonly toolRows: () => Promise<readonly ManagedToolRow[]>;
  /** This computer's name, which a line about a tool missing here names it by. */
  readonly computer: () => string;
}

/** A connection as an action's button names it: its label at its address's host, which tells two of one label apart. */
const connectionLabel = (connection: KeyManagerConnectionRecord): string => `${connection.label} at ${connection.address.replace(/^https?:\/\//, "")}`;

/** The connection `action` applies to. */
const connectionTarget = (action: SetupAction, connection: KeyManagerConnectionRecord): SetupTarget => ({
  action,
  kind: "key-manager-connection",
  id: connection.id,
  label: connectionLabel(connection),
});

/** A line of details naming `connection` as the environment holds it, its address and id, then `fact`. */
const detailOf = (connection: KeyManagerConnectionRecord, fact: string): string => `${connection.label} at ${connection.address} (${connection.id}): ${fact}`;

/** One connection's failure of a check: its line, its details, and the connection or tool its action applies to. */
interface Finding {
  readonly line: string;
  readonly details: readonly string[];
  readonly target: SetupTarget;
  readonly times?: readonly ReasonTime[];
}

/** A check's answer from its findings: it holds with none, else one line naming each, with their details, times, actions and targets. */
const answerOf = (findings: readonly Finding[]): StateCheckAnswer => {
  if (findings.length === 0) return true;
  const times = findings.flatMap((finding) => finding.times ?? []);
  return {
    reason: findings.map((finding) => finding.line).join(" "),
    details: findings.flatMap((finding) => finding.details),
    ...(times.length > 0 && { times }),
    actions: [...new Set(findings.map((finding) => finding.target.action))],
    targets: findings.map((finding) => finding.target),
  };
};

/** At least one connection is on the environment. */
const connectionPresent = (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
  connections.length > 0 || { reason: "No key manager connected. Optional." };

/** A connection's line in one status: its words, the action that fixes it, and the past time it names. */
interface StatusLine {
  readonly line: string;
  readonly action: SetupAction;
  readonly time?: ReasonTime;
}

/** The line for each status a check names, for the connection standing in it. */
type StatusLines = { readonly [Kind in KeyManagerStatusKind]?: (connection: KeyManagerConnectionRecord) => StatusLine };

/** A check that names each connection standing in one of `lines`' statuses with its line, its status's own words in details, and holds with none. */
const noneStanding =
  (lines: StatusLines) =>
  (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
    answerOf(
      connections.flatMap((connection) => {
        const status = lines[connection.status.kind]?.(connection);
        if (status === undefined) return [];
        const finding: Finding = { line: status.line, details: [detailOf(connection, connection.status.message)], target: connectionTarget(status.action, connection) };
        return [status.time === undefined ? finding : { ...finding, times: [status.time] }];
      }),
    );

/** A connection still signing in, or whose provider cannot load here: not ready yet, which a check again finds settled. */
const notReady = (connection: KeyManagerConnectionRecord): StatusLine => ({ line: `${connection.label} is not ready yet. Choose Check again.`, action: "check-again" });

/**
 * Every connection is signed in: none awaiting its sign-in, its credential
 * rejected or its token expired (`sign-in-again`), and none still signing
 * in or whose provider cannot load here (`check-again`), so the step is
 * not done while one cannot fetch keys (#1852).
 */
const signedIn = noneStanding({
  "awaiting-sign-in": (connection) => ({ line: `${connection.label} is not signed in yet.`, action: "sign-in-again" }),
  "credential-rejected": (connection) => ({ line: `${connection.label} did not accept the sign-in. Sign in again with a working token.`, action: "sign-in-again" }),
  expired: (connection) => {
    const expiresAt = connection.tokenInformation?.expiresAt ?? null;
    if (expiresAt === null) return { line: `${connection.label}'s token ran out. Sign in with a new token.`, action: "sign-in-again" };
    // The expiry as data, which a client words where it is; the line's own words for it stand for one that does not (#1742).
    const when = readableMinute(expiresAt);
    return { line: `${connection.label}'s token ran out ${when}. Sign in with a new token.`, action: "sign-in-again", time: { text: when, at: expiresAt } };
  },
  "signing-in": notReady,
  "provider-unavailable": notReady,
});

/** Every connection's key manager answers: none unreachable or sealed (`check-again`), nor presenting a certificate that does not verify (`check-certificate`). */
const reachable = noneStanding({
  unreachable: (connection) => ({ line: `${connection.label} did not answer. Check the address and the connection, then choose Check again.`, action: "check-again" }),
  sealed: (connection) => ({ line: `${connection.label} is locked (sealed). Unlock it, then choose Check again.`, action: "check-again" }),
  "certificate-rejected": (connection) => ({
    line: `agent-harness does not trust ${connection.label}'s security certificate. Choose Check certificate to review it.`,
    action: "check-certificate",
  }),
});

/**
 * Every injecting OpenBao connection's login can mint run tokens: each
 * signed in whose verification found it lacks `update` on the path its run
 * tokens are created at is named, that path and the policy line that grants
 * it in details (`check-again`). A connection not signed in is the other
 * checks' to name, and one never asked is tried at each mint, as the runs'
 * own minting does.
 */
const runTokensMint = (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
  answerOf(
    connections
      .filter((connection) => connection.provider === "openbao" && connection.injects && connection.status.kind === "signed-in" && connection.canMint === false)
      .map((connection) => {
        const path = createPath(connection.tokenRole);
        return {
          line: `${connection.label} lets agent-harness sign in but not make keys for agents. Ask whoever runs ${connection.label} to allow it.`,
          details: [detailOf(connection, `its login lacks update on ${path}, which making a run token needs.`), `Policy line: path "${path}" { capabilities = ["update"] }`],
          target: connectionTarget("check-again", connection),
        };
      }),
  );

/** A row whose tool is installed at its minimum or later: current, with a newer one known, or installed in a way that could not be told. */
const meetsMinimum = (row: ManagedToolRow): boolean => row.status !== "not-installed" && row.status !== "below-minimum";

/** The tool a row names, as the action it serves applies to it. */
const toolTarget = (action: SetupAction, row: ManagedToolRow): SetupTarget => ({ action, kind: "tool", id: row.tool, label: row.tool });

/** What was found of a provider's CLIs, none of which meets its minimum, for details: each installed one's version, else that none is installed and what is needed. */
const cliProblem = (rows: readonly ManagedToolRow[], first: ManagedToolRow): string => {
  const installed = rows.filter((row) => row.status !== "not-installed");
  const tools = rows.map((row) => row.tool);
  if (installed.length === 0) {
    const missing = tools.length === 1 ? `${tools.join("")} is not installed on this environment` : `neither ${tools.join(" nor ")} is installed on this environment`;
    return `${missing}; ${first.tool}${first.minimum === null ? " is" : ` ${first.minimum} or later is`} needed.`;
  }
  const found = installed.map((row) =>
    row.version === null ? `${row.tool} on this environment reports no version, so it may be older than ${row.minimum}` : `${row.tool} ${row.version} on this environment is older than ${row.minimum}`,
  );
  return `${found.join(" and ")}.`;
};

/**
 * Each injecting connection's CLI is installed at its minimum or later
 * (ADR 0026: a key-manager CLI is required while its connection injects),
 * any of its provider's satisfying it. One that is not names the
 * provider's first CLI, this computer and the connection, what was found in
 * details, and the CLI to Install or, found below its minimum, to Update:
 * `bao` for OpenBao, since `vault` is never installed. The rows are read
 * only when a connection injects.
 */
const cliInstalled = async (connections: readonly KeyManagerConnectionRecord[], toolRows: () => Promise<readonly ManagedToolRow[]>, computer: string): Promise<StateCheckAnswer> => {
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
      const line =
        action === "update"
          ? `The ${first.tool} tool on ${computer} is out of date. Update it so agents can use ${connection.label}.`
          : `The ${first.tool} tool is not installed on ${computer}. Install it so agents can use ${connection.label}.`;
      return [{ line, details: [detailOf(connection, cliProblem(own, first))], target: toolTarget(action, first) }];
    }),
  );
};

/** The line for Forge references to connections this computer does not hold, their ids in details; null for none. */
const referencesMissing = (held: readonly KeyManagerConnectionRecord[], required: readonly string[]): { readonly reason: string; readonly details: readonly string[] } | null => {
  const missing = [...new Set(required)].filter((id) => !held.some((connection) => connection.id === id));
  if (missing.length === 0) return null;
  return {
    reason: "Some forge tokens are kept in a key manager that is not connected here. Connect it.",
    details: [`Key-manager connections that forge accounts name and this computer does not hold: ${missing.join(", ")}`],
  };
};

export const keyManagerStateChecks = ({
  connections,
  verify,
  toolRows,
  computer,
  requiredConnections = () => [],
}: KeyManagerStateChecksOptions): { readonly [Id in KeyManagerStateCheckId]: StateChecker } => ({
  "key-manager.present": () => requiredConnections().length > 0 || connectionPresent(connections()),
  "key-manager.signed-in": async () => {
    const held = await verify();
    const answer = signedIn(held);
    const missing = referencesMissing(held, requiredConnections());
    if (missing === null) return answer;
    // Connect it: the sign-in, on Key managers, where a connection is added.
    if (answer === true || answer.holds === true) return { reason: missing.reason, details: missing.details, actions: ["sign-in-again"] };
    return { ...answer, reason: `${answer.reason} ${missing.reason}`, details: [...(answer.details ?? []), ...missing.details] };
  },
  "key-manager.reachable": async () => reachable(await verify()),
  "key-manager.run-tokens": async () => runTokensMint(await verify()),
  "key-manager.cli": async () => cliInstalled(await verify(), toolRows, computer()),
});
