import { KNOWN_ENVIRONMENTS_MAX, KnownEnvironment } from "@agent-harness/contracts";
import { LOCAL_PLACEHOLDER_ID, type ConnectionRecord } from "./connections/records.js";
import type { Observable } from "./observable.js";
import type { RuntimeClientKind } from "./platform.js";
import type { Requests } from "./requests.js";

/**
 * The known-environments report (key-managers spec, "The orientation block";
 * ADR 0011; #382): a desktop's or terminal UI's runtime tells each
 * environment it connects to of every other connection it holds, by the
 * environment's id, its name and the address this client uses, through
 * `environment.knownEnvironments.report`, so a run there can say where else
 * work can run. It tells a connection once it is ready after each `hello`
 * (the environment holds reports in memory, so one that restarted has
 * forgotten it), and again whenever what it would tell it changes: a
 * connection added, renamed, moved to another address or removed. A disabled
 * connection is still one it holds. A report is whole and needs no answer:
 * one that fails (an environment from before the method, a socket gone) is
 * sent again at the next `hello` or change. A browser tab's runtime reports
 * nothing (the spec names the desktop and the terminal UI); a program drives
 * the wire without a runtime, and the environment refuses its report.
 */

/** The clients whose runtime reports. */
const REPORTING_KINDS: ReadonlySet<RuntimeClientKind> = new Set<RuntimeClientKind>(["desktop", "tui"]);

export interface KnownEnvironmentsReportHost {
  /** The platform's client kind. */
  readonly kind: RuntimeClientKind;
  /** The connections, whose phases and records say when and what to tell. */
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly call: Requests["call"];
  /** Where a call that rejects, the runtime itself failing, is handed. */
  readonly report: (error: unknown) => void;
}

/**
 * What `environmentId` is told: every other connection but the first-launch
 * placeholder, in the connection list's order, each that the method takes
 * (a name or address it would refuse is left out, not the whole report), at
 * most the method's cap.
 */
export const otherConnections = (records: readonly ConnectionRecord[], environmentId: string): KnownEnvironment[] =>
  records
    .filter((record) => record.environmentId !== environmentId && record.environmentId !== LOCAL_PLACEHOLDER_ID)
    .map((record) => ({ id: record.environmentId, name: record.descriptor.name, address: record.address }))
    .filter((environment) => KnownEnvironment.safeParse(environment).success)
    .slice(0, KNOWN_ENVIRONMENTS_MAX);

/** Starts reporting, for a client that reports; answers how to stop. */
export const reportKnownEnvironments = (host: KnownEnvironmentsReportHost): (() => void) => {
  if (!REPORTING_KINDS.has(host.kind)) return () => undefined;
  /** What each ready connection was last told on its socket, as JSON; forgotten as it leaves ready, so the next ready tells it again. */
  const told = new Map<string, string>();
  return host.records.subscribe((records) => {
    for (const environmentId of told.keys()) {
      if (!records.some((record) => record.environmentId === environmentId && record.phase === "ready")) told.delete(environmentId);
    }
    for (const record of records) {
      if (record.phase !== "ready") continue;
      const environments = otherConnections(records, record.environmentId);
      const text = JSON.stringify(environments);
      if (told.get(record.environmentId) === text) continue;
      told.set(record.environmentId, text);
      host.call(record.environmentId, "environment.knownEnvironments.report", { environments }).catch(host.report);
    }
  });
};
