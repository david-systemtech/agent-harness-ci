import type { EventLog } from "../event-log/event-log.js";
import { readSessionFacts } from "../runs/run-reads.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import type { AdapterHost } from "./host.js";

/**
 * The providers methods on the method table (claude-adapter spec, "Wire
 * methods"): `providers.list` (read), the adapters' descriptors;
 * `providers.processes.list` (admin), the pool's processes; and
 * `providers.processes.stop` (admin), a command on the session's stream that
 * appends nothing of its own: the stop happens once it has committed, and
 * the end of a run live on the process is the host's to append.
 */

export interface ProcessMethodsOptions {
  readonly log: EventLog;
  readonly host: AdapterHost;
}

export const processMethods = (options: ProcessMethodsOptions): MethodHandlers => {
  const { log, host } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  return {
    "providers.list": () => ({ providers: [...host.providers()] }),

    "providers.processes.list": () => ({ processes: host.processes.list() }),

    "providers.processes.stop": (params, context) => {
      const sessionId = params.sessionId.toLowerCase();
      const aggregate = sessionStream(sessionId);
      const session = readSessionFacts(log, reader, sessionId);
      if (session === null || session.deleted) {
        return {
          aggregate,
          rejected: { code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } },
        };
      }
      const ended = !host.processes.running(sessionId);
      if (!ended) context.tx.afterCommit(() => host.processes.stop(sessionId));
      return { aggregate, result: { sessionId, ended } };
    },
  };
};
