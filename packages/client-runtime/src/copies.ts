import type { CommandReceipt } from "@agent-harness/contracts";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "./connections/records.js";
import type { RequestFailure } from "./requests.js";

/**
 * Copies to other environments (ADR 0020's bulk copy; #320, reused by the
 * key managers' and the skills' copies): David picks environments among
 * those this client holds an `admin` connection to, the runtime calls each
 * on its own, and answers a report per environment. No environment is told
 * of another beyond what the copy carries, and none changes another: the
 * copy is this client's one explicit act.
 */

/** An environment a copy may go to. */
export interface CopyTarget {
  readonly environmentId: string;
  readonly name: string;
}

/**
 * The environments a copy from `fromEnvironmentId` offers, in the
 * connection list's order: every enabled one but the source whose client
 * session holds `admin`, reachable now or not (one that cannot be reached
 * is refused at once, in its report). The first-launch placeholder is no
 * environment yet.
 */
export const copyTargetsOf = (records: readonly ConnectionRecord[], fromEnvironmentId: string): readonly CopyTarget[] =>
  records
    .filter(
      (record) =>
        record.environmentId !== fromEnvironmentId && record.environmentId !== LOCAL_PLACEHOLDER_ID && record.enabled && record.scopes.includes("admin"),
    )
    .map((record) => ({ environmentId: record.environmentId, name: record.descriptor.name }));

/** What became of a copy on one environment: copied, with what it answered, or refused, with why (the environment's error, or the connection's). */
export type CopyReport<R> =
  | { readonly environmentId: string; readonly status: "copied"; readonly result: R }
  | { readonly environmentId: string; readonly status: "refused"; readonly error: RequestFailure };

export type CopyOutcome<R> = { readonly status: "copied"; readonly result: R } | { readonly status: "refused"; readonly error: RequestFailure };

/** A command's answer to `requests.call`: its receipt beside its result (none when the receipt was stored), or why the call failed. */
export type CommandAnswer<T> = { readonly ok: true; readonly result: { readonly receipt: CommandReceipt; readonly result?: T } } | { readonly ok: false; readonly error: RequestFailure };

/**
 * What a copy's add answered, as its report says it: `copied` with what it
 * added, as `added` reads it from the result (null for an answer from its
 * stored receipt, which holds none), or `refused` with the environment's
 * error, by its receipt or its answer, or the connection's.
 */
export const copyOutcome = <T, R>(answer: CommandAnswer<T>, added: (result: Exclude<T, undefined>) => R): CopyOutcome<R | null> => {
  if (!answer.ok) return { status: "refused", error: answer.error };
  const { receipt, result } = answer.result;
  if (receipt.status === "rejected") return { status: "refused", error: { code: receipt.reason, message: receipt.error.message, data: receipt.error.data } };
  return { status: "copied", result: result === undefined ? null : added(result as Exclude<T, undefined>) };
};

/** The environment a copy was made from, as the copy carries it (`copiedFrom`): its id, and its name as this client has it. */
export interface CopySource {
  readonly environmentId: string;
  readonly environmentName: string;
}

/**
 * Copies from `from` to each environment named once, all at once, each
 * answered on its own: one refused or unreachable leaves the others going.
 * With no source (this client has no connection to the environment the copy
 * is from) each is refused `unreachable`, and nothing is sent.
 */
export const copyToEach = <R>(
  from: CopySource | null,
  environmentIds: readonly string[],
  copy: (environmentId: string, from: CopySource) => Promise<CopyOutcome<R>>,
): Promise<readonly CopyReport<R>[]> =>
  Promise.all(
    [...new Set(environmentIds)].map(
      async (environmentId): Promise<CopyReport<R>> => ({
        environmentId,
        ...(from === null ? { status: "refused", error: { code: "unreachable", message: "This client has no connection to the environment the copy is from." } } : await copy(environmentId, from)),
      }),
    ),
  );
