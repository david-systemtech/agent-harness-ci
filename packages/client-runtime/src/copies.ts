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

/** Copies to each environment named once, all at once, each answered on its own: one refused or unreachable leaves the others going. */
export const copyToEach = <R>(environmentIds: readonly string[], copy: (environmentId: string) => Promise<CopyOutcome<R>>): Promise<readonly CopyReport<R>[]> =>
  Promise.all([...new Set(environmentIds)].map(async (environmentId): Promise<CopyReport<R>> => ({ environmentId, ...(await copy(environmentId)) })));
