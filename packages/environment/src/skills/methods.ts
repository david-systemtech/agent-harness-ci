import { ContractError, ENVIRONMENT_STREAM_KIND, type SkillChoice, type SkillsViewAccount } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { ListedAccount } from "../instructions/methods.js";
import { readSessionFacts } from "../runs/run-reads.js";
import type { CommandAnswer, CommandContext, MethodHandler, MethodHandlers, PreparedCommand } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { choicesFor, readSkillChoices, skillsStream } from "./choices.js";
import type { OwnDirectory } from "./own-directory.js";
import { resolveSkillSet } from "./precedence.js";
import type { SkillSources } from "./sources.js";
import type { SkillSync } from "./sync.js";

/**
 * The skill set's methods (skills spec, "Choices" and "Wire summary"):
 * `skills.get` at `read`, which reads the own directory and resolves the
 * set for a session's account, or the default account's, with the choices;
 * `skills.own.create` and `.remove` at `admin`, the own directory's
 * prepared commands; `skills.carryOver` at `admin`, Carry over's skills
 * half; `skills.probe` at `admin`, a repository URL's skill folders; and
 * `skills.setEnabled` and `skills.setAlwaysOn` at `admin`, each
 * appending its choice on the skills stream and `skills.updated` after it,
 * in the command's transaction; `skills.sources.add` and `.remove` at
 * `admin`, the skill sources' (`sources.ts`); and `skills.sources.pull` and
 * `.setFollow` at `admin`, the syncer's (`sync.ts`). The set holds the own
 * directory's layer and the sources' until the repository layer joins it.
 */

export interface SkillsMethodsOptions {
  readonly log: EventLog;
  /** The environment's id: the id of its skills stream and its own. */
  readonly environmentId: string;
  readonly own: OwnDirectory;
  /** The environment's default account; null when it holds none. */
  readonly defaultAccountId: () => string | null;
  /** The environment's accounts now, in the account list's order. */
  readonly accounts: () => readonly ListedAccount[];
  /** Carry over's skills half (`carry-over.ts`). */
  readonly carryOver: PreparedCommand<"skills.carryOver">;
  /** `skills.probe` (`probe.ts`). */
  readonly probe: MethodHandler<"skills.probe">;
  /** The skill sources (`sources.ts`). */
  readonly sources: Pick<SkillSources, "read" | "add" | "remove">;
  /** The syncer (`sync.ts`): Pull now, and pinning. */
  readonly sync: Pick<SkillSync, "pull" | "setFollow">;
}

/** The notice every committed choice is followed by. */
const UPDATED = { type: "skills.updated", payload: {} } as const;

/** An account as `skills.get` lists it: its adapter's channel and, with none, why no always-on skill reaches its runs. */
const viewAccount = ({ id, provider, descriptor }: ListedAccount): SkillsViewAccount => {
  if (descriptor === null) return { accountId: id, channel: "none", reason: `No adapter for ${provider} is on this environment, so no always-on skill reaches its runs.` };
  const { instructionChannel, displayName } = descriptor;
  const reason = instructionChannel.kind === "none" ? `Its adapter, ${displayName}, has no instruction channel, so no always-on skill reaches its runs.` : null;
  return { accountId: id, channel: instructionChannel.kind, reason };
};

/** A choice's switch: whether the name is on, or always-on. */
const switchOf = (choice: SkillChoice): boolean => (choice.kind === "enabled" ? choice.enabled : choice.on);

/** Whether `a` and `b` are one choice: the same kind, name, account and switch. */
const sameChoice = (a: SkillChoice, b: SkillChoice): boolean => a.kind === b.kind && a.name === b.name && a.accountId === b.accountId && switchOf(a) === switchOf(b);

export const skillsMethods = (options: SkillsMethodsOptions): MethodHandlers => {
  const { log, own } = options;
  const stream = skillsStream(options.environmentId);
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

  /**
   * Records `choice` on the skills stream, then the notice, as the
   * command's client session; a choice naming an account the environment
   * does not hold is refused, and one it already holds appends nothing.
   */
  const choose = (choice: SkillChoice, context: CommandContext): CommandAnswer<{ choice: SkillChoice }, "not_found"> => {
    const { accountId } = choice;
    if (accountId !== null && !options.accounts().some((account) => account.id === accountId)) {
      return { aggregate: stream, rejected: { code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } } };
    }
    if (!readSkillChoices(log).some((held) => sameChoice(held, choice))) {
      const attribution = { tx: context.tx, actor: context.actor, commandId: context.commandId };
      const { kind, ...payload } = choice;
      log.append(stream, [{ type: kind === "enabled" ? "skills.enabled-set" : "skills.always-on-set", payload }], attribution);
      log.append({ kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId }, [UPDATED], attribution);
    }
    return { aggregate: stream, result: { choice } };
  };

  return {
    "skills.get": async ({ sessionId }) => {
      const accountId = accountOf(sessionId);
      const [members, sources] = await Promise.all([own.read(), options.sources.read()]);
      const choices = readSkillChoices(log);
      const applied = choicesFor(choices, accountId);
      return {
        ownDirectory: own.path,
        sources: [...sources.sources],
        choices,
        accountId,
        accounts: options.accounts().map(viewAccount),
        members: resolveSkillSet([...members, ...sources.members], sources.sources).map((member) => ({
          ...member,
          enabled: member.name === null || applied.enabled(member.name),
          alwaysOn: member.name !== null && applied.alwaysOn(member.name),
          choices: choices.filter((choice) => choice.name === member.name),
        })),
      };
    },
    "skills.probe": options.probe,
    "skills.own.create": own.create,
    "skills.own.remove": own.remove,
    "skills.carryOver": options.carryOver,
    "skills.setEnabled": ({ name, accountId, enabled }, context) => choose({ kind: "enabled", name, accountId, enabled }, context),
    "skills.setAlwaysOn": ({ name, accountId, on }, context) => choose({ kind: "always-on", name, accountId, on }, context),
    "skills.sources.add": options.sources.add,
    "skills.sources.remove": options.sources.remove,
    "skills.sources.pull": options.sync.pull,
    "skills.sources.setFollow": options.sync.setFollow,
  };
};
