import { ContractError, normaliseEnvironmentName, type KnownEnvironment, type ListedEnvironment } from "@agent-harness/contracts";
import type { ClientSessions } from "../auth/client-sessions.js";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import { formatActor } from "../event-log/envelope.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";

/**
 * The known environments (key-managers spec, "The orientation block"; ADR
 * 0011; #382): what each client session reports of its other connections
 * through `environment.knownEnvironments.report`, held in memory by client
 * session. A report is whole and replaces that client session's last; it is
 * dropped when the client session is revoked or expires. The union, this
 * environment left out, each name and address once and sorted by name, then
 * address, is what the orientation block's other environments section lists,
 * so it reads the same whichever client reported last; each change to it is
 * the notice `environment.known-environments-updated`. Nothing is written but
 * the notices: after a restart each client reports again after its `hello`.
 */

/** Who drops a report its client session can no longer make: a revocation or an expiry. */
export const KNOWN_ENVIRONMENTS_ACTOR = formatActor({ kind: "system", id: "known-environments" });

const NOTICE = "environment.known-environments-updated";

export interface KnownEnvironments {
  /** Takes the client session's report whole, in place of its last: its other connections but this environment, each name kept on one line. */
  report(clientSessionId: string, environments: readonly KnownEnvironment[]): void;
  /** The union of the reports held: each name and address once, sorted by name, then address. */
  union(): readonly ListedEnvironment[];
  /** Stops following revocations and cancels the expiries. */
  close(): void;
}

export interface KnownEnvironmentsOptions {
  /** Where each change to the union is noticed. */
  readonly log: Pick<EventLog, "append">;
  /** The environment's own stream. */
  readonly stream: StreamRef;
  /** This environment's id: a report's entry naming it is left out. */
  readonly environmentId: string;
  /** The clock a client session's expiry is waited for on: the environment's. */
  readonly clock: Clock;
  /** Each client session's expiry as it is now (a refresh moves it), and its revocation. */
  readonly clientSessions: Pick<ClientSessions, "expiresAt" | "onRevoked">;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each name and address once, sorted by name, then address. */
const unionOf = (reports: Iterable<readonly ListedEnvironment[]>): ListedEnvironment[] => {
  const listed = new Map<string, ListedEnvironment>();
  for (const report of reports) for (const environment of report) listed.set(JSON.stringify([environment.name, environment.address]), environment);
  return [...listed.values()].sort((a, b) => compare(a.name, b.name) || compare(a.address, b.address));
};

export const createKnownEnvironments = (options: KnownEnvironmentsOptions): KnownEnvironments => {
  const { log, stream, clock, clientSessions } = options;
  const here = options.environmentId.toLowerCase();
  const reports = new Map<string, readonly ListedEnvironment[]>();
  const expiries = new Map<string, Timer>();
  let union: readonly ListedEnvironment[] = [];

  /** The union again, after the reports changed: noticed when it differs from the last. */
  const settle = (actor: string): void => {
    const next = unionOf(reports.values());
    if (JSON.stringify(next) === JSON.stringify(union)) return;
    union = next;
    try {
      log.append(stream, [{ type: NOTICE, payload: { environments: next } }], { actor });
    } catch (error) {
      console.error("Noticing that the known environments changed failed:", error);
    }
  };

  const drop = (clientSessionId: string): void => {
    expiries.get(clientSessionId)?.cancel();
    expiries.delete(clientSessionId);
    if (!reports.delete(clientSessionId)) return;
    settle(KNOWN_ENVIRONMENTS_ACTOR);
  };

  /** Waits for the client session's expiry as it stands, and then again if a refresh has moved it. */
  const awaitExpiry = (clientSessionId: string): void => {
    const expiresAt = clientSessions.expiresAt(clientSessionId);
    if (expiresAt === undefined) return drop(clientSessionId);
    const timer = clock.setTimeout(
      () => {
        expiries.delete(clientSessionId);
        if ((clientSessions.expiresAt(clientSessionId) ?? 0) > clock.now().getTime()) awaitExpiry(clientSessionId);
        else drop(clientSessionId);
      },
      Math.max(0, expiresAt - clock.now().getTime()),
    );
    expiries.set(clientSessionId, timer);
  };

  const stopRevoked = clientSessions.onRevoked(drop);

  return {
    report(clientSessionId, environments) {
      reports.set(
        clientSessionId,
        environments.filter(({ id }) => id.toLowerCase() !== here).map(({ name, address }) => ({ name: normaliseEnvironmentName(name), address })),
      );
      if (!expiries.has(clientSessionId)) awaitExpiry(clientSessionId);
      settle(formatActor({ kind: "client_session", id: clientSessionId }));
    },
    union: () => union,
    close() {
      stopRevoked();
      for (const timer of expiries.values()) timer.cancel();
      expiries.clear();
    },
  };
};

/**
 * `environment.knownEnvironments.report`: a program client session is
 * refused, since what it reported would reach every run; any other's report
 * is taken.
 */
export const knownEnvironmentsMethods = (known: KnownEnvironments): MethodHandlers => ({
  "environment.knownEnvironments.report": ({ environments }, { clientSession }) => {
    if (clientSession.kind === "program") {
      throw new ContractError({
        code: "forbidden",
        message: "A program client session cannot report known environments: what it reports reaches every run.",
        data: { scope: "read", reason: "program" },
      });
    }
    known.report(clientSession.id, environments);
    return {};
  },
});
