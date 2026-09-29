import { ContractError } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { readSessionFacts } from "../runs/run-reads.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import type { OwnDirectory } from "./own-directory.js";
import { resolveSkillSet } from "./precedence.js";

/**
 * The skill set's methods (skills spec, "Wire summary"): `skills.get` at
 * `read`, which reads the own directory and resolves the set for a
 * session's account, or the default account's; `skills.own.create` and
 * `.remove` at `admin`, the own directory's prepared commands. Sources and
 * choices are none until their tickets add them, and the set holds the own
 * directory's layer alone until the source and repository layers join it.
 */

export interface SkillsMethodsOptions {
  readonly log: EventLog;
  readonly own: OwnDirectory;
  /** The environment's default account; null when it holds none. */
  readonly defaultAccountId: () => string | null;
}

export const skillsMethods = (options: SkillsMethodsOptions): MethodHandlers => {
  const { log, own } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** The account a session's set is resolved for: the one it was created with, else the default account. */
  const accountOf = (sessionId: string | undefined): string | null => {
    if (sessionId === undefined) return options.defaultAccountId();
    const session = readSessionFacts(log, reader, sessionId);
    if (session === null || session.deleted) {
      throw new ContractError({ code: "not_found", message: `No session ${sessionId} is on this environment.`, data: { kind: "session", sessionId } });
    }
    return session.account ?? options.defaultAccountId();
  };

  return {
    "skills.get": async ({ sessionId }) => {
      const accountId = accountOf(sessionId);
      const members = await own.read();
      return { ownDirectory: own.path, sources: [], choices: [], accountId, members: resolveSkillSet(members, { sourcePosition: () => 0 }) };
    },
    "skills.own.create": own.create,
    "skills.own.remove": own.remove,
  };
};
